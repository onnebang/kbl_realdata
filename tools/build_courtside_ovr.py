import sys
import re
import sqlite3
import pandas as pd
import numpy as np
import json
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ovr_curve_model import OvrCurveModel

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'raw', 'kbl_realdata.db')
KBL540_PLAYERS_PATH = '../../kbl540/kbl540_players_public.json'
OUT_PATH = '../data/courtside_ovr.json'

# 나이를 모르는 선수(kbl540 카드 풀에 없는 최근 신인 등)에게 줄 중립 나이 - 전성기
# 한복판이라 OvrCurveModel의 나이 보정 배율이 정확히 1.0(보너스도 페널티도 없음)이라서,
# 3시즌 가중평균만 적용되고 나이 곡선 자체는 사실상 안 걸리는 효과를 낸다.
NEUTRAL_AGE = 26

# 아직 경기 기록이 없는 다음 시즌 - courtside-web/lib/preseason.ts의 PRESEASON_SEASON과
# 같은 값이어야 한다(그쪽이 로스터/이적 화면 기준 시즌).
PROJECTION_SEASON = '2026-2027'

# DB엔 시즌 전체가 아니라 단 1경기만 적재된 고아 시즌(1998-99, 2004-05)이 있다 - 그대로 두면 그 1경기에
# 나온 선수(이상민·문경은·추승균 등)가 "커리어 첫 시즌 OVR 51" 같은 가짜 시즌을 갖고, 공백 보간이
# 그 뒤 2005-06까지 지어냈다. 개막 직후(5경기 미만)만 잠깐 빠지므로 진행 중 시즌엔 영향이 거의 없다.
MIN_SEASON_GAMES = 5
FULL_SEASON_SQL = (
    "g.season_name IN (SELECT season_name FROM games WHERE season_category = '정규시즌'"
    f" GROUP BY season_name HAVING COUNT(*) >= {MIN_SEASON_GAMES})"
)

# shot_log(raw/kbl_realdata.db)의 x,y로 미드레인지 슈팅을 뽑아내는 좌표 보정값 - shot_log의
# 자체 zone 컬럼('1'/'2')은 골밑/3점 같은 슛 종류가 아니라 그냥 "어느 쪽 골대에서 쐈나"였다
# (두 zone FG%가 46.5%/46.4%로 동일 - 2026-09-24 발견). 대신 골대 좌표를 양쪽 밀집구역
# 중심으로 잡고(코트 절반씩 x<150/x>575, y 150~250 구간 슛의 평균 좌표), 그 골대까지 거리로
# 페인트/미드레인지/3점을 나눴다. 반경은 실측 정답(pp_a=페인트 시도, threep_a=3점 시도)에
# 제일 가깝게 맞는 값을 그리드서치로 찾음(선수-경기당 평균 오차: 페인트 0.20개, 3점 0.12개
# - 둘 다 원 안에 들어오면 기존 스탯이랑 사실상 일치). 미드레인지(그 사이)는 기존
# player_game_stats에 아예 없던 신호 - 페인트 포인트(pp)와 3점(threep)은 이미 있었지만
# "그 사이의 롱2"는 이번에 처음 분리됨.
HOOP_L = (82.76, 202.58)
HOOP_R = (643.82, 203.94)
PAINT_RADIUS = 70
THREE_RADIUS = 145
LEAGUE_AVG_MIDRANGE_PCT = 0.373  # 실측 리그 평균(위 반경 기준), 2026-09-24

# 평판 가산 가중치(수상 id -> 1회당 OVR 가산). 회당 값은 예전 calculate_reputation_boost와 같고, 시즌 인지형으로
# 바뀌면서 dpoy·allstar_mvp만 새로 넣었다(둘 다 스탯에 다 안 잡히는 "그 해의 얼굴" 신호인데 빠져 있었음).
REPUTATION_WEIGHTS = {
    'regular_mvp': 1.5, 'po_mvp': 1.0, 'dpoy': 1.0, 'champ': 0.5, 'allstar_mvp': 0.5,
    'month_mvp': 0.2, 'round_mvp': 0.1, 'allstar': 0.1,
}
NATIONAL_TEAM_WEIGHT = 0.3  # nt_* 대회 1회당
REPUTATION_CAP = 5.0

# 박스스코어 + 공식 수상 실적(REPUTATION_WEIGHTS)으로는 못 잡는 신호(태업, 플레이 스타일
# 호오, 국제 위상, "이 정도면 유저가 납득한다" 같은 눈대중)를 사람이 확인한 뒤 얹는 표.
# 예전엔 이 용도로 애드혹 코드가 두 군데 따로 있었다(오누아쿠 전용 함수, 김보배 전용
# 프로젝션 부스트) - pcode 키 delta 하나로 통합. 나이 곡선/스무딩 파라미터를 손대는 시도는
# "어릴수록 보너스가 크다"는 구조 때문에 데뷔 시즌이 최근 시즌보다 높아지는 역전을 낳아
# 되돌렸다(2026-09-18) - 그래서 여기서 사람이 직접 얹는다. 사용자 확인 후에만 추가/제거할 것.
#   delta: OVR/OFF/DEF 및 모든 attribute에 균일하게 더할 값(음수 가능)
#   from_season: 이 시즌부터(포함) 확정 시즌에 적용. None이면 그 선수의 전체 커리어.
#     PROJECTION_SEASON을 주면 다음 시즌 예상치부터만(그 전 확정 이력은 안 건드림).
#     예상치는 별도 표 없이 이 표를 그대로 재사용한다(아래 프로젝션 블록).
# 2026-09-24 재조준: 나이 감쇠 보호막(ovr_curve_model.protection_*)이 들어가면서 노장
# 자연값이 내려갔다 - '지는 별' 수동 하향(김선형·김종규)은 모델이 스스로 하게 되어
# 삭제했고(김선형 84->78), 목표치를 명시한 항목들은 자연값 기준으로 delta를 다시
# 맞췄다. 모델을 고칠 때마다 이 표도 같이 재조준해야 한다 - delta는 절대값이 아니라
# '자연값과의 차이'라서, 모델이 움직이면 조준점도 같이 움직인다.
MANUAL_OVR_OVERRIDES = {
    '291261': {'delta': -5, 'from_season': '2023-2024',
               'reason': '오누아쿠 - 23-24시즌 이후 태업 및 비효율 극강(2026-09-20)'},
    '291752': {'delta': 1, 'from_season': PROJECTION_SEASON,
               'reason': '김보배 - 2026 국가대표 발탁, 박스스코어에 없는 외부 신호(2026-09-18)'},
    '291640': {'delta': -1, 'from_season': PROJECTION_SEASON,
               'reason': '유기상 - 3년 성장 추세 외삽이 과함, 86 정도로 타협(20년차 KBL 팬 피드백, 2026-09-23)'},
    '291576': {'delta': -1, 'from_season': PROJECTION_SEASON,
               'reason': '양준석 - 위와 동일 사유, 86 정도로 타협(20년차 KBL 팬 피드백, 2026-09-23)'},
    '291488': {'delta': 2, 'from_season': '2025-2026',
               'reason': '이정현(소노) - 25-26 소노를 챔피언결정전 준우승까지 이끈 국내 최고 선수 중 하나, 인기·위상이 정규 수상 실적보다 큼, 89~91 목표(20년차 KBL 팬 피드백, 2026-09-23)'},
    '291511': {'delta': 2, 'from_season': '2025-2026',
               'reason': '이선 알바노 - 이정현과 동급 슈퍼스타 취급(20년차 KBL 팬 피드백, 2026-09-23)'},
    '291785': {'delta': 5, 'from_season': None,
               'reason': '헨리 엘런슨 - 25-26 라운드 MVP급 활약 + 연장 계약, 90~94 목표(20년차 KBL 팬 피드백, 2026-09-23)'},
    '291368': {'delta': -4, 'from_season': '2025-2026',
               'reason': '오재현 - 수비형/슛난사 스타일이라 유저 공감대가 낮음, 79~82가 적당(20년차 KBL 팬 피드백, 2026-09-23)'},
    '291275': {'delta': -3, 'from_season': '2025-2026',
               'reason': '김경원 - 눈에 띄는 활약 없는 저분 백업, 82는 과함(20년차 KBL 팬 피드백, 2026-09-23 - 목표치 미확정, 추가 조정 가능)'},
    '291699': {'delta': 7, 'from_season': None,
               'reason': '칼 타마요 - 필리핀 국가대표급 실력 대비 저평가, 많은 상향 필요(20년차 KBL 팬 피드백, 2026-09-23)'},
    '290790': {'delta': 6, 'from_season': '2025-2026',
               'reason': '정효근 - 2+2 -> 6으로 상향(2026-09-24 DB 팬 피드백 2라운드): 커리어 피크 82로 '
                         'OvrCurveModel 2등급(85 미만) 판정이라 보호가 약해, 작년 팀 핵심이었는데도 '
                         '다음 시즌 예상이 훨씬 활용도 낮은 신인 김보배(82)/이유진(79)보다 낮게 나옴 - '
                         '검증된 베테랑이 무검증 신인 아래로 깔리는 걸 막을 만큼 상향. 등급표 임계값(85) '
                         '자체를 낮추는 건 전체 선수에 영향 주는 별도 검토 필요라 안 건드림.'},
    '291760': {'delta': -6, 'from_season': None,
               'reason': '이민서 - 보여준 게 없음, 69 정도가 적당(20년차 KBL 팬 피드백, 2026-09-24)'},
    '290904': {'delta': -6, 'from_season': None,
               'reason': '박봉진 - 커리어 대부분 분당 2분 안팎 저분 백업, 68은 과함(DB 팬 피드백, '
                         '2026-09-24 - 목표치 미확정, 추가 조정 가능)'},
    '290901': {'delta': 3, 'from_season': '2025-2026',
               'reason': '정성우 - 장기 선발급 콤보가드 실력 대비 저평가(DB 팬 피드백, 2026-09-24 - '
                         '목표치 미확정, 추가 조정 가능)'},
    '291784': {'delta': 5, 'from_season': None,
               'reason': '알빈 톨렌티노 - 38% 3점 효율 대비 저평가(DB 팬 피드백, 2026-09-24 - '
                         '목표치 미확정, 추가 조정 가능)'},
    # 2026-09-25 팬 피드백: 라건아/오브라이언트/칸터 3명 전부 "까다로운 스타일"(저점유율 빅맨 -
    # 페인트 수비·리바운드·스크린 등 박스스코어가 잘 안 잡는 영역이 강점) 저평가 제보. 실측
    # 확인 결과 셋 다 파이프라인 버그는 아니었음 - raw_ovr_mapped(WPA/승률/PIE 반영 후) 자체는
    # 84~89로 준수한데(2025-26 PIE 기준 라건아 리그 5위·칸터 1위), 그 다음 OvrCurveModel
    # 단계에서 순수 나이 문제로 깎임:
    #   - 라건아(36세): 나이 감쇠 보호막(protection_fade)이 최상위 등급이어도 7년 전성기
    #     경과분만큼 옅어져(TIERS 방어력이 0.70->0.3325로) 실측 그대로 하락기 복리 적용,
    #     게다가 play_style="athletic" 분류라 하락률 1.4배(2K식 "운동능력형은 노쇠 빠르다"
    #     로직) - 정작 라건아는 스피드가 아니라 포스트업 기술/포지셔닝형이라 실제 노쇠
    #     속도와 안 맞음.
    #   - 칸터(30세, KBL 데뷔 시즌): peak_hi(29)를 이미 넘겨 첫 시즌부터 하락기 취급 -
    #     raw_peak이 84.92로 최상위 등급 문턱(85.0)을 0.08 차이로 못 넘어 방어력 약한
    #     2등급으로 떨어짐. "증명한 적 없어서 보호막이 없다"는 논리 자체는 맞지만, 그
    #     증명이 하필 이번 시즌 리그 PIE 1위였다는 게 아이러니.
    #   - 오브라이언트(32세): 오히려 raw 성적이 최근 상승세(82.9->85.1->86.3)인데도
    #     하락기 감쇠가 상승분을 거의 다 상쇄해 OVR이 정체.
    # 셋 다 공유 나이 곡선(ovr_curve_model.py)의 특정 파라미터(protection_fade, athletic
    # 하락 배율, TIERS 85.0 문턱) 손질로 고칠 수도 있지만, 이 모델은 "노장 자동 하향"
    # 자체가 최근에(2026-09-24) 의도적으로 들어간 기능이고 전체 선수에 영향을 주는 변경은
    # 과거에 부작용으로 되돌린 전례가 있어(위 MANUAL_OVR_OVERRIDES 안내문 참고) 3명만을
    # 위해 다시 건드리지 않음 - 대신 여기서 개별 보정. 목표: 80대 초중반.
    '290524': {'delta': 4, 'from_season': '2025-2026',
               'reason': '라건아 - 36세지만 25-26 PIE 리그 5위(33.0)로 여전히 실질 지배력 있음, '
                         '나이 감쇠(athletic 분류+protection_fade)가 과함. 81->85, 79->83(예상)'},
    '291500': {'delta': 2, 'from_season': '2024-2025',
               'reason': '조니 오브라이언트 - 최근 2시즌 raw 성적 상승세(수비형 락다운 디펜더로 '
                         '전환 후 기여도 오히려 증가)인데 하락기 감쇠가 상쇄. 83->85, 82->84(예상)'},
    '291787': {'delta': 2, 'from_season': '2025-2026',
               'reason': '케렘 칸터 - KBL 데뷔 시즌인데 25-26 PIE 리그 1위(35.3), 나이(30세)만으로 '
                         '첫 시즌부터 하락기+약한 등급 보호를 받아 저평가. 83->85, 81->83(예상)'},
}


# KBL 기록이 전혀 없는 완전 신인(주로 신규 외국인/아시아쿼터 영입)은 원래 rookie_floor_for()의
# 바닥치(53~58)로만 간다 - "경기 기록이 없으니 그 이상을 줄 근거가 없다"는 원칙 그대로다. 다만
# tools/data/import_scouting_2026_2027.csv에 실제 근거(해외 리그 스탯, KBL 팀 상대 연습경기/EASL
# 실전 기록, 비교 선수)가 있는 선수는 예외 - "근거 없음"이 아니라 "근거가 있는데 안 쓴 것"이 되므로,
# 그 파일의 등급(tier)·비교 선수(comparable)를 사람이 번역해 OVR/6개 속성을 직접 채운다(2026-09-24,
# 사용자 제보 + CSV 발견). 델타가 아니라 전체 프로필을 통째로 지정하는 이유 - 이 선수들은 "계산된
# 값에 보정을 얹는" MANUAL_OVR_OVERRIDES와 달리 계산된 값 자체가 없다(바닥치 53은 6개 속성이
# 전부 같아서 편평하고, 신인 스카우팅은 포지션별로 강점이 다르므로 델타 하나로는 못 살린다).
# key: season_roster.pcode가 NULL이라 load_next_season_roster()가 만드는 "tbd_이름" 임시 키.
SCOUTED_ROOKIE_PROFILES = {
    'tbd_다리우스 베즐리': {
        'OVR': 90, 'OFF': 90, 'DEF': 88,
        'attributes': {'outside': 84, 'inside': 82, 'playmaking': 74, 'athletic': 93, 'defense': 86, 'rebounding': 85},
        'archetype': 'Slasher',
        'reason': 'NBA 5시즌 237경기(20-21 OKC 주전 13.7점 7.2리바) + 2026 푸에르토리코 대표팀 12.5점 '
                  '10.4리바 FG54% 3P41% + 9/2·9/5 일본 연습경기 13점/18점. 특급, "오마리 스펠맨(peak 89) '
                  '전성기 운동능력 상위 호환"',
    },
    'tbd_스코티 제임스': {
        'OVR': 91, 'OFF': 91, 'DEF': 87,
        'attributes': {'outside': 85, 'inside': 88, 'playmaking': 76, 'athletic': 84, 'defense': 86, 'rebounding': 90},
        'archetype': 'Stretch Big',
        'reason': '중국 CBA(KBL보다 상위리그) 톈진 4시즌 158경기 22.2점 11.9리바, 24-25 24.6점 14.0리바 '
                  '3P 41.3%, 일본 전훈 4일만에 17점 10리바. 특급, "자밀 워니급(peak 96) 1옵션 + 41% 외곽" '
                  '- CBA에서 워니 전담 수비 경험도 있음',
    },
    'tbd_존 무니': {
        'OVR': 85, 'OFF': 84, 'DEF': 84,
        'attributes': {'outside': 68, 'inside': 88, 'playmaking': 70, 'athletic': 78, 'defense': 82, 'rebounding': 90},
        'archetype': 'Paint Beast',
        'reason': '일본 B1 통산 213경기 14.9점 11.4리바(23-24 리바운드왕), EASL 실전으로 KBL과 직접 붙은 '
                  '기록 있음 - vs 정관장 22점 22리바 2연승, EASL 결승 vs SK 워니 상대 우승(72-69). 상급, '
                  '"아셈 마레이(peak 90)에 미드레인지를 더한 형태"',
    },
    '291882': {
        'OVR': 86, 'OFF': 89, 'DEF': 76,
        'attributes': {'outside': 76, 'inside': 85, 'playmaking': 76, 'athletic': 90, 'defense': 74, 'rebounding': 70},
        'archetype': 'Slasher',
        'reason': '대만 P.리그+ 25-26 득점왕(26.4점, 한 경기 51점) + EASL 25-26 득점왕·올-서드팀(29.3점) '
                  '+ EASL 실전으로 SK 원정 35점(워니·안영준·오재현 상대). NBA 1라운드 출신. 상급',
    },
    '291884': {
        'OVR': 83, 'OFF': 84, 'DEF': 78,
        'attributes': {'outside': 82, 'inside': 76, 'playmaking': 74, 'athletic': 80, 'defense': 76, 'rebounding': 74},
        'archetype': 'Scoring Threat',
        'reason': '푸에르토리코 BSN 25-26 43경기 15.8점 6.5리바 3.9어시 FG46% 3P41%(리그 올스타), G리그 '
                  '5시즌 183경기, 9/1 SK 연습경기 19점(워니·힉스·안영준·오재현 상대). 상급, "패리스 배스(peak '
                  '90)형 외곽 슬래셔"',
    },
    'tbd_트레이 포터': {
        'OVR': 81, 'OFF': 75, 'DEF': 87,
        'attributes': {'outside': 60, 'inside': 81, 'playmaking': 65, 'athletic': 83, 'defense': 91, 'rebounding': 87},
        'archetype': 'Glass Cleaner',
        'reason': '일본 B1 알티리 치바 25-26 58경기 11.7점 7.9리바 1.1블록 FG60%(2대2·풋백 위주), B2 시절 '
                  '블록왕. 역할(3단계 중 최하), 20분 내외 골밑 한정 역할 - "오누아쿠(2024-25 85) 수비 지향 버전". '
                  '2026-09-25 팬 피드백: 라건아/오브라이언트/칸터와 같은 "까다로운 스타일" 저평가 제보로 '
                  '+5(76->81) - 스카우팅 근거(일본 2부리그 20분 한정 백업)만 보면 원래 수치가 정직한 평가지만, '
                  'KBL 이적 후 실제로는 주전급 볼륨을 받을 가능성이 높아 최소 80대 초반은 보장.',
    },
    'tbd_제리 아바디아노': {
        'OVR': 70, 'OFF': 64, 'DEF': 76,
        'attributes': {'outside': 62, 'inside': 60, 'playmaking': 68, 'athletic': 76, 'defense': 80, 'rebounding': 62},
        'archetype': 'Lockdown Defender',
        'reason': '필리핀 MPBL 2026 16경기 9.6점 1.9리바 2.6어시(16.1분), 코칭스태프 평가 "압박수비·활동량 '
                  '스페셜리스트". 아쿼중급, "론제이 아바리엔토스(79)보다 수비 기반" - 득점력은 더 낮게 봄',
    },
}


def manual_override_delta(pcode, season):
    """MANUAL_OVR_OVERRIDES에서 이 (pcode, season)에 적용할 delta. 없거나 from_season보다
    이전 시즌이면 0."""
    ov = MANUAL_OVR_OVERRIDES.get(pcode)
    if not ov:
        return 0.0
    if ov['from_season'] is not None and str(season) < ov['from_season']:
        return 0.0
    return float(ov['delta'])


def load_birth_years():
    """kbl540 카드 풀(같은 kbl.or.kr pcode 체계)에서 pcode -> 출생연도 매핑을 만든다.
    courtside 쪽 원본 DB엔 생년월일이 없어서(players 테이블: pcode/name/ename/photo_url뿐)
    이 프로젝트 데이터로 보강한다."""
    path = os.path.join(os.path.dirname(__file__), KBL540_PLAYERS_PATH)
    if not os.path.exists(path):
        print(f"경고: kbl540 선수 데이터를 못 찾음({path}) - 나이 곡선 보정 없이 진행")
        return {}
    with open(path, encoding='utf-8') as f:
        cards = json.load(f)
    years = {}
    for c in cards:
        pcode = c.get('pcode')
        bd = c.get('birth_date')
        if not pcode or not bd or pcode in years:
            continue
        try:
            years[pcode] = int(str(bd).split('-')[0])
        except (ValueError, IndexError):
            continue
    return years


def load_nationalities():
    path = os.path.join(os.path.dirname(__file__), KBL540_PLAYERS_PATH)
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        cards = json.load(f)
    nats = {}
    for c in cards:
        pcode = c.get('pcode')
        nat = c.get('nationality')
        if pcode and nat:
            nats[pcode] = nat
    return nats



def load_draft_ranks():
    """kbl540 카드 풀의 draft_rank(예: "2024 1R 3순위")를 pcode -> 원문 문자열로 반환.
    커리어 기록이 전혀 없는 신인의 바닥치를 정할 때 쓴다(rookie_floor_for)."""
    path = os.path.join(os.path.dirname(__file__), KBL540_PLAYERS_PATH)
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        cards = json.load(f)
    ranks = {}
    for c in cards:
        pcode = c.get('pcode')
        dr = c.get('draft_rank')
        if pcode and dr and dr != '-':
            ranks[pcode] = dr
    return ranks


def rookie_floor_for(draft_rank):
    """커리어 기록이 전혀 없는 완전 신인의 바닥치 - 예전엔 전원 55로 고정해서(제보: "거의 안
    뛴 선수들이 전부 55라 뻔해 보인다") 드래프트 순위라는 실제 신호로 53~58 사이에서
    갈라준다. 이 구간은 실측 최약체 KBL 기여자들의 실제 분포(하위 5명 53~58)를 벗어나지
    않는다 - 경기 기록이 없으니 그 이상을 준다는 근거가 없다."""
    if not draft_rank or not isinstance(draft_rank, str):
        return 53  # 드래프트 외 지명(연습생 등)
    m_round = re.search(r'(\d)R', draft_rank)
    if not m_round:
        return 53
    if m_round.group(1) != '1':
        return 54  # 2라운드 지명
    m_pick = re.search(r'(\d+)순위', draft_rank)
    pick = int(m_pick.group(1)) if m_pick else 5
    return 58 - min(pick - 1, 4)  # 1라운드: 1순위 58 ~ 5순위 이후 54


def load_tcode_names():
    """Supabase teams의 tcode -> 팀 이름(현재 연고 표기). 사이트가 팀 색·약어를 이 이름으로 찾는다
    (OvrTrendChart teamByName = teams.name 기준)라서 여기서도 같은 이름을 써야 매칭된다. 접속이
    안 되면 빈 dict - load_season_teams가 경기 기록에 적힌 당시 팀명으로 대신한다."""
    try:
        import psycopg2
        from import_roster import load_database_url
        conn = psycopg2.connect(load_database_url())
        cur = conn.cursor()
        cur.execute("select tcode, name from teams")
        result = {tcode: name for tcode, name in cur.fetchall()}
        conn.close()
        return result
    except Exception as e:
        print(f"경고: teams 조회 실패({e}) - 시즌별 팀은 경기 기록의 당시 팀명으로 대체")
        return {}


def load_season_teams():
    """(pcode, season_name) -> 그 시즌에 가장 많이 뛴 팀 이름.

    예전엔 모든 시즌에 kbl540 카드의 team_name_current(= 그 선수의 "지금" 팀)를 그대로 찍었다.
    이적한 선수(예: 290407 김선형 - 2011~2025 서울 SK, 2025-26 수원 KT)는 옛 시즌까지 전부
    현재 팀으로 표시됐고, 그 때문에 차트의 이적 구간·팀 색이 한 번도 작동하지 않았다.
    한 시즌에 팀이 둘이면(시즌 중 트레이드) 출전 경기 수가 많은 쪽, 같으면 더 늦게 뛴 쪽.
    팀 이름은 teams.name(현재 연고 표기, 사이트와 같은 이름). teams에 없는 옛 구단(해체·개명 전
    코드)은 그 시즌 경기 기록에 적힌 당시 팀명을 쓴다."""
    conn = sqlite3.connect(DB_PATH)
    try:
        played = pd.read_sql_query(
            "SELECT gps.pcode, g.season_name, gps.tcode, COUNT(*) AS gp, MAX(g.game_date) AS last_date"
            " FROM player_game_stats gps JOIN games g ON gps.gmkey = g.gmkey"
            " WHERE g.season_category IN ('정규시즌', '플레이오프', '챔피언결정전')"
            "   AND g.season_name NOT LIKE '%D리그%'"
            " GROUP BY gps.pcode, g.season_name, gps.tcode",
            conn,
        )
        era_names = pd.read_sql_query(
            "SELECT season_name, home_tcode AS tcode, home_name AS name FROM games"
            " UNION SELECT season_name, away_tcode, away_name FROM games",
            conn,
        )
    finally:
        conn.close()
    tcode_names = load_tcode_names()
    era = {}
    for r in era_names.itertuples():
        era.setdefault((r.season_name, r.tcode), r.name)
    played = played.sort_values(['gp', 'last_date'], ascending=False).drop_duplicates(['pcode', 'season_name'])
    return {
        (r.pcode, r.season_name): tcode_names.get(r.tcode) or era.get((r.season_name, r.tcode))
        for r in played.itertuples()
    }


def load_teams_and_positions():
    path = os.path.join(os.path.dirname(__file__), KBL540_PLAYERS_PATH)
    if not os.path.exists(path):
        return {}, {}
    with open(path, encoding='utf-8') as f:
        cards = json.load(f)
    # kbl540 카드는 (선수, 시즌, 팀)당 한 장이라 한 pcode에 여러 장이 있다(3138장 /
    # 고유 pcode 825개, 498명이 2~14장). 예전엔 그냥 덮어써서 '파일에 마지막으로 나온
    # 카드'가 이겼는데, **파일 순서가 시간순이 아니다** - 라건아(290524)는 마지막 카드가
    # season_code 23(2013-14 현대모비스)이라 최신 팀인 한국가스공사(47)가 아니라 가장
    # 오래된 팀이 뽑혔다. position도 71명이 카드마다 엇갈리고(C vs FD 등), 그중 34명은
    # 어느 카드가 이기느냐로 is_big이 뒤집힌다 - is_big은 어떤 아키타입이 후보에
    # 들어가는지를 정해 raw_ovr까지 바꾸므로(찰스 로드·김주성·자밀 워니·함지훈·오세근 등)
    # 배열 순서에 성적이 달린 셈이었다. season_code(시즌마다 +2) 최대값으로 고른다.
    latest = {}
    for c in cards:
        pcode = c.get('pcode')
        if not pcode:
            continue
        sc = c.get('season_code')
        sc = sc if isinstance(sc, int) else -1
        if pcode not in latest or sc > latest[pcode][0]:
            latest[pcode] = (sc, c)
    teams = {}
    positions = {}
    for pcode, (_, c) in latest.items():
        if c.get('team_name_current'):
            teams[pcode] = c['team_name_current']
        if c.get('position'):
            positions[pcode] = c['position']
    return teams, positions

def load_next_season_roster(season):
    """season_roster(Supabase, import_roster.py가 적재)에서 이 시즌 확정 로스터의
    pcode -> {team, name}을 반환한다(name은 KBL 기록이 전혀 없는 완전 신인의 표시용 -
    global_df에는 그 pcode 행 자체가 없어 이름을 따로 들고 있어야 한다). 개막 전 스탯이
    0개인 시즌에 예상 OVR을 만들 대상을 정하는 데 쓴다. DB 접속이 안 되면(로컬/오프라인)
    빈 dict로 조용히 건너뛴다 - 예상 OVR은 있으면 좋은 부가 기능이지 본 파이프라인의
    필수 요건이 아니다.

    r.pcode가 NULL인 행(KBL 공식 pcode를 아직 못 받은 신규 영입/드래프트 - 2026-09-24
    확인 시점에 15명)도 그냥 버리지 않는다 - 예전엔 "and r.pcode is not null"로 걸러서
    이런 선수는 로스터에 있는데도 예상 OVR 자체가 안 생겼다(유저 제보). "tbd_이름" 형태의
    임시 키를 줘서 완전 신인 바닥치(rookie_floor_for)라도 받게 한다 - 진짜 KBL pcode가
    아니라서 선수 프로필 페이지(/players/[pcode])는 그 선수 photo_url 등을 찾는 Supabase
    조회가 비어 notFound()로 빠진다(그래프/명단엔 나오는데 프로필만 404) - 진짜 pcode가
    배정되면 이 임시 키는 자동으로 안 쓰인다(정상 경로로 흡수됨)."""
    try:
        import psycopg2
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from import_roster import load_database_url
        conn = psycopg2.connect(load_database_url())
        cur = conn.cursor()
        cur.execute(
            "select r.pcode, t.name, r.player_name from season_roster r join teams t using (tcode)"
            " where r.season_name = %s",
            (season,),
        )
        result = {}
        for pcode, team, name in cur.fetchall():
            key = pcode if pcode else f"tbd_{name}"
            result[key] = {"team": team, "name": name}
        conn.close()
        return result
    except Exception as e:
        print(f"경고: season_roster 조회 실패({e}) - {season} 예상 OVR 생성을 건너뜀")
        return {}


def load_awards():
    path = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_awards.json')
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def parse_start_year(season_name):
    """'2018-2019' / '2018-19' / '2018 Asian Games' / '1997' -> 시작연도(첫 4자리 숫자)."""
    m = re.match(r'\s*(\d{4})', str(season_name))
    return int(m.group(1)) if m else None


def compute_ovr(target_season='2024-2025'):
    if not os.path.exists(DB_PATH):
        print(f"Error: DB not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)

    # 1. 전체 시즌(역대 기록) 모든 선수의 스탯을 조회하여 "역사적 정규분포"를 구한다.
    # pname은 GROUP BY 키에 안 넣는다 - 예전엔 (pcode, pname, season)으로 묶어서, 귀화 등으로
    # 등록명이 바뀐 선수(예: 290524 라건아 - 미국 이름 Ricardo Ratliffe로 뛰다 국가대표 자격
    # 취득을 위해 귀화하며 개명)가 시즌마다 유령 중복 카드로 갈라졌다(같은 시즌인데 두 줄,
    # 값도 살짝 다름 - 실은 동점자 백분위 처리에서 갈린 것뿐이었다). pcode+season만으로 묶고,
    # 표시 이름은 아래에서 이 pcode의 "가장 최근 시즌에 쓰인 이름" 하나로 통일한다.
    # season_category는 DB에 '챔피언결정전'으로 들어있다 - 예전엔 '챔프전'으로 적어둬서
    # 이 IN 절이 0건 매칭했고, 챔프전 42경기가 OVR 집계에서 통째로 빠져 있었다
    # (2026-09-24 발견). 리그에서 제일 중요한 경기들이라 영향이 작지 않다.
    global_query = """
    SELECT
        gps.pcode, g.season_name,
        COUNT(gps.gmkey) as g,
        SUM(gps.play_min + gps.play_sec/60.0) as total_min,
        SUM((gps.play_min + gps.play_sec/60.0) * IFNULL(gps.pace, 70.0) / 40.0) as total_possessions,
        AVG(gps.score) as pts,
        SUM(gps.score) as total_pts,
        AVG(gps.ast) as ast,
        SUM(gps.ast) as total_ast,
        AVG(gps.rb) as reb,
        SUM(gps.rb) as total_reb,
        AVG(gps.stl) as stl,
        SUM(gps.stl) as total_stl,
        AVG(gps.bs) as blk,
        SUM(gps.bs) as total_blk,
        AVG(gps.to_) as tov,
        SUM(gps.to_) as total_tov,
        SUM(gps.per * (gps.play_min + gps.play_sec/60.0)) / SUM(gps.play_min + gps.play_sec/60.0) as per,
        SUM(gps.pie * (gps.play_min + gps.play_sec/60.0)) / SUM(gps.play_min + gps.play_sec/60.0) as pie,
        SUM(MAX(MIN(gps.netrtg, 50), -50) * (gps.play_min + gps.play_sec/60.0)) / SUM(gps.play_min + gps.play_sec/60.0) as net_rtg,
        SUM(gps.usg_rt * (gps.play_min + gps.play_sec/60.0)) / SUM(gps.play_min + gps.play_sec/60.0) as usage,
        SUM(gps.fg) as fgm, SUM(gps.fg_a) as fga,
        SUM(gps.threep) as tpm, SUM(gps.threep_a) as tpa,
        SUM(gps.ft) as ftm, SUM(gps.ft_a) as fta,
        AVG(gps.offr) as offr, AVG(gps.defr) as defr,
        SUM(gps.offr) as total_offr, SUM(gps.defr) as total_defr,
        SUM(gps.dk) as dkm, SUM(gps.dk_a) as dka,
        AVG(gps.fb) as fb_pts, AVG(gps.pp) as paint_pts,
        SUM(gps.fb) as total_fb_pts, SUM(gps.pp) as total_paint_pts,
        AVG(gps.sast) as sast, AVG(gps.dfl) as dfl,
        SUM(gps.sast) as total_sast, SUM(gps.dfl) as total_dfl,
        -- 이 다섯은 '비율' 스탯이라 경기당 단순평균을 내면 2분 뛴 경기가 35분 뛴 경기와
        -- 똑같은 표를 행사한다 - 바로 아래 def_rtg나 위쪽 per/pie/usage처럼 출전시간
        -- 가중평균이어야 맞다. 예전엔 AVG였고, 그래서 291210 김준형 2023-24(2경기
        -- 총 8.8분)가 oreb_rt 단순평균 222.20(가중평균은 16.90)으로 리바운드 능력치
        -- 83을 받았다. total_min<5 쓰레기값 차단선이 있지만 8.8분은 통과한다.
        SUM(gps.ast_rt * (gps.play_min + gps.play_sec/60.0)) / SUM((gps.play_min + gps.play_sec/60.0)) as ast_rt,
        SUM(gps.ast_to * (gps.play_min + gps.play_sec/60.0)) / SUM((gps.play_min + gps.play_sec/60.0)) as ast_to,
        SUM(gps.oreb_rt * (gps.play_min + gps.play_sec/60.0)) / SUM((gps.play_min + gps.play_sec/60.0)) as oreb_rt,
        SUM(gps.dreb_rt * (gps.play_min + gps.play_sec/60.0)) / SUM((gps.play_min + gps.play_sec/60.0)) as dreb_rt,
        SUM(gps.tov_rt * (gps.play_min + gps.play_sec/60.0)) / SUM((gps.play_min + gps.play_sec/60.0)) as tov_rt,
        SUM(gps.defrtg * (gps.play_min + gps.play_sec/60.0)) / SUM(gps.play_min + gps.play_sec/60.0) as def_rtg,
        AVG(CASE WHEN gps.tcode = g.home_tcode THEN g.home_score - g.away_score ELSE g.away_score - g.home_score END) as margin,
        AVG(CASE WHEN (CASE WHEN gps.tcode = g.home_tcode THEN g.home_score - g.away_score ELSE g.away_score - g.home_score END) > 0 THEN 1.0 ELSE 0.0 END) as win_pct
    FROM player_game_stats gps
    JOIN games g ON gps.gmkey = g.gmkey
    WHERE g.season_category IN ('정규시즌', '플레이오프', '챔피언결정전')
      AND g.season_name NOT LIKE '%D리그%'
      AND """ + FULL_SEASON_SQL + """
    GROUP BY gps.pcode, g.season_name
    """

    try:
        global_df = pd.read_sql_query(global_query, conn)
        name_df = pd.read_sql_query(
            "SELECT gps.pcode, gps.pname, g.season_name"
            " FROM player_game_stats gps JOIN games g ON gps.gmkey = g.gmkey",
            conn,
        )
        # WPA 리더보드는 pcode 없이 (등록명, 팀 tcode)만 갖고 있다 - 그 조합을 pcode로 잇는 다리.
        team_df = pd.read_sql_query(
            "SELECT gps.pcode, gps.pname, g.season_name, gps.tcode"
            " FROM player_game_stats gps JOIN games g ON gps.gmkey = g.gmkey"
            " GROUP BY gps.pcode, gps.pname, g.season_name, gps.tcode",
            conn,
        )
        shots_df = pd.read_sql_query(
            "SELECT s.pcode, g.season_name, s.x, s.y, s.made"
            " FROM shot_log s JOIN games g ON s.gmkey = g.gmkey"
            " WHERE g.season_category IN ('정규시즌', '플레이오프', '챔피언결정전')",
            conn,
        )
    except Exception as e:
        print(f"DB Query failed: {e}")
        conn.close()
        return

    conn.close()

    if global_df.empty:
        print("No historical data found in DB.")
        return

    # 이름 등록이 바뀐 선수는 가장 최근 시즌에 쓰인 이름으로 과거 시즌까지 통일해서 보여준다.
    name_df['start_year'] = name_df['season_name'].apply(parse_start_year)
    canonical_name = (
        name_df.sort_values('start_year').groupby('pcode')['pname'].last().to_dict()
    )
    global_df['name'] = global_df['pcode'].map(canonical_name)

    # TS% Calculation
    global_df['ts_pct'] = np.where((global_df['fga'] + 0.44 * global_df['fta']) > 0,
                            (global_df['pts'] * global_df['g']) / (2 * (global_df['fga'] + 0.44 * global_df['fta'])), 0)

    # 미드레인지 슈팅(shot_log 좌표 기반, HOOP_L/HOOP_R/PAINT_RADIUS/THREE_RADIUS 참고)
    dist_l = np.hypot(shots_df['x'] - HOOP_L[0], shots_df['y'] - HOOP_L[1])
    dist_r = np.hypot(shots_df['x'] - HOOP_R[0], shots_df['y'] - HOOP_R[1])
    shots_df['dist'] = np.minimum(dist_l, dist_r)
    mid_shots = shots_df[(shots_df['dist'] > PAINT_RADIUS) & (shots_df['dist'] <= THREE_RADIUS)]
    mid_agg = mid_shots.groupby(['pcode', 'season_name']).agg(
        mid_fgm=('made', 'sum'), mid_fga=('made', 'count')
    ).reset_index()
    global_df = global_df.merge(mid_agg, on=['pcode', 'season_name'], how='left')
    global_df['mid_fgm'] = global_df['mid_fgm'].fillna(0)
    global_df['mid_fga'] = global_df['mid_fga'].fillna(0)
    global_df['midrange_pct'] = np.where(
        global_df['mid_fga'] > 0, global_df['mid_fgm'] / global_df['mid_fga'], LEAGUE_AVG_MIDRANGE_PCT)


    # WPA 데이터 로드
    # 예전엔 (시즌, 표시 이름)으로 조인했다 - 같은 시즌에 동명이인이 둘이면(이정현 x2, 김주성 x2 등) 행이
    # 곱절로 불어나(133행 중복) 차트에 같은 시즌 점이 둘씩 찍혔고, WPA도 두 사람 값이 뒤섞였다. 팀까지 맞춰
    # pcode에 정확히 붙이고, 시즌 중 트레이드로 항목이 둘이면 경기 수 가중평균한다.
    global_df['wpaPerGame'] = 0.0
    wpa_path = os.path.join(os.path.dirname(__file__), '..', 'raw', 'analysis', 'wpa_season_leaderboard.json')
    if os.path.exists(wpa_path):
        with open(wpa_path, 'r', encoding='utf-8') as f:
            wpa_data = json.load(f)
        wpa_df = pd.DataFrame([
            {'season_name': season, 'pname': p['player'], 'tcode': str(p['team']),
             'games': p.get('games', 0), 'wpaPerGame': p.get('wpaPerGame', 0)}
            for season, players in wpa_data.get('bySeason', {}).items() for p in players
        ])
        if not wpa_df.empty:
            # WPA 리더보드엔 pcode가 없어 (시즌, 등록명, 팀)으로 붙일 수밖에 없다. 이 키는
            # 지금 데이터에선 딱 한 번 충돌한다 - 2010-11 '앤서니 존슨'(06) 두 명(290346,
            # 290431). WPA 데이터가 2011-12부터라 지금은 안 닿지만, 커버리지를 과거로
            # 넓히면 두 사람 WPA가 조용히 섞인다. 조용히 틀리느니 시끄럽게 죽게 한다.
            dup_keys = team_df[team_df.duplicated(['season_name', 'pname', 'tcode'], keep=False)]
            clash = dup_keys.merge(wpa_df, on=['season_name', 'pname', 'tcode'])
            if not clash.empty:
                raise SystemExit(
                    'WPA 조인 키 충돌: 같은 (시즌, 이름, 팀)에 pcode가 둘 이상인데 WPA 데이터가 있음 - '
                    '해당 선수 WPA가 섞임. 수동 확인 필요:\n'
                    + clash[['season_name', 'pname', 'tcode', 'pcode']].to_string())
            j = team_df.merge(wpa_df, on=['season_name', 'pname', 'tcode'])
            j['w'] = j['games'] * j['wpaPerGame']
            wpa_by_pcode = j.groupby(['pcode', 'season_name']).agg(w=('w', 'sum'), n=('games', 'sum'))
            wpa_by_pcode['wpaPerGame'] = wpa_by_pcode['w'] / wpa_by_pcode['n'].where(wpa_by_pcode['n'] > 0)
            global_df = global_df.drop(columns='wpaPerGame').merge(
                wpa_by_pcode[['wpaPerGame']].reset_index(), on=['pcode', 'season_name'], how='left')
            global_df['wpaPerGame'] = global_df['wpaPerGame'].fillna(0)

    # 포지션 데이터를 먼저 로드하여 병합 (가중치 계산용)
    teams, positions = load_teams_and_positions()
    global_df['position'] = global_df['pcode'].map(positions).fillna('Unknown')
    
    # ── 세부 카테고리 (NBA 2K 스타일) 원시 점수 계산 ──
    # 포제션 필터 (0 분모 방지)
    global_df['total_possessions'] = global_df['total_possessions'].replace(0, 1)
    
    # Per-75 스탯 환산
    global_df['pts_per75'] = (global_df['total_pts'] / global_df['total_possessions']) * 75
    global_df['ast_per75'] = (global_df['total_ast'] / global_df['total_possessions']) * 75
    global_df['reb_per75'] = (global_df['total_reb'] / global_df['total_possessions']) * 75
    global_df['stl_per75'] = (global_df['total_stl'] / global_df['total_possessions']) * 75
    global_df['blk_per75'] = (global_df['total_blk'] / global_df['total_possessions']) * 75
    # tov_per75 예전엔 AVG(경기당 평균)를 시즌 전체 포제션으로 나눠서(75 곱셈까지) 경기 수만큼
    # 한 번 더 나눈 효과가 나 턴오버 페널티가 사실상 꺼져 있었다(2026-09-22 커밋에서 발견, 검증 후
    # 2026-09-23 적용) - 다른 per75 스탯과 똑같이 SUM(total_tov)을 써야 맞다.
    global_df['tov_per75'] = (global_df['total_tov'] / global_df['total_possessions']) * 75
    
    global_df['tpm_per75'] = (global_df['tpm'] / global_df['total_possessions']) * 75
    global_df['ftm_per75'] = (global_df['ftm'] / global_df['total_possessions']) * 75
    global_df['paint_pts_per75'] = (global_df['total_paint_pts'] / global_df['total_possessions']) * 75
    global_df['dkm_per75'] = (global_df['dkm'] / global_df['total_possessions']) * 75
    global_df['fb_pts_per75'] = (global_df['total_fb_pts'] / global_df['total_possessions']) * 75
    global_df['sast_per75'] = (global_df['total_sast'] / global_df['total_possessions']) * 75
    global_df['dfl_per75'] = (global_df['total_dfl'] / global_df['total_possessions']) * 75
    global_df['offr_per75'] = (global_df['total_offr'] / global_df['total_possessions']) * 75
    global_df['defr_per75'] = (global_df['total_defr'] / global_df['total_possessions']) * 75
    global_df['midrange_per75'] = (global_df['mid_fga'] / global_df['total_possessions']) * 75

    # 효율성 지표
    global_df['threep_pct'] = np.where(global_df['tpa'] > 0, global_df['tpm'] / global_df['tpa'], 0)
    global_df['fg_pct'] = np.where(global_df['fga'] > 0, global_df['fgm'] / global_df['fga'], 0)
    global_df['ft_pct'] = np.where(global_df['fta'] > 0, global_df['ftm'] / global_df['fta'], 0)
    global_df['ft_rate'] = np.where(global_df['fga'] > 0, global_df['fta'] / global_df['fga'], 0)

    # 1. Outside Scoring
    # 볼륨(tpm_per75)에 효율(3P%)을 가중치로 부여. TS% 추가. 턴오버 치명적 페널티(Multiplier)
    # 미드레인지(shot_log 기반, 2026-09-24 추가)는 볼륨*효율로 3점과 같은 형태로 더한다 - 다만
    # 리그 평균 자체가 3점(0.33)보다 낮고(0.373) 한 개당 기대득점도 2점이라 가중치(1.5)는 3점의
    # 절반 이하로 낮게 잡았다 - 미드레인지 볼륨 자체를 보상하는 게 아니라, "같은 볼륨이면 잘 넣는
    # 사람이 못 넣는 사람보다 낫다"는 스킬 신호만 반영(선택 자체의 좋고 나쁨은 TS%가 이미 반영).
    tov_multiplier = np.maximum(0.3, 1.0 - (global_df['tov_per75'] / 8.0)) # 턴오버 4개면 50% 타격
    global_df['attr_outside'] = ((global_df['tpm_per75'] * 4.0 * (global_df['threep_pct'] / 0.33)) + (global_df['midrange_per75'] * 1.5 * (global_df['midrange_pct'] / LEAGUE_AVG_MIDRANGE_PCT)) + (global_df['ts_pct'] * 30.0) + (global_df['ftm_per75'] * 1.5 * global_df['ft_pct'])) * tov_multiplier
    
    # 2. Inside Scoring
    # 핵어샤크 방지 (자유투 기하급수 페널티 Multiplier) 및 턴오버 치명적 페널티 부여
    ft_penalty_multiplier = np.where(global_df['fta'] > 0, np.maximum(0.2, (global_df['ft_pct']**3) / 0.3), 1.0)
    global_df['attr_inside'] = ((global_df['paint_pts_per75'] * 2.0 * (global_df['fg_pct'] / 0.5)) + (global_df['dkm_per75'] * 5.0) + (global_df['ft_rate'] * 20.0)) * tov_multiplier * ft_penalty_multiplier
    
    # 3. Playmaking
    # 무리한 턴오버(tov_per75)를 강하게 페널티 부여
    global_df['attr_playmaking'] = (global_df['ast_per75'] * 3.0) + (global_df['sast_per75'] * 2.0) + (global_df['ast_to'] * 5.0) + (global_df['ast_rt'] * 0.2) - (global_df['tov_per75'] * 3.0)
    
    # 4. Athleticism
    # 출전시간 항은 예전엔 시즌 총 출전분을 '데이터셋 전체 최대 경기수'(64)라는 무관한
    # 상수로 나눴다 - 형제 항 셋은 전부 per-75인데 이것만 볼륨 스탯이라, 많이 뛴 것
    # 자체가 운동능력 백분위의 절반을 설명했다(라건아 2016-17: 이 항 하나가 원점수의
    # 50.5%). 자기 경기수로 나눠 '경기당 출전분'으로 바꾼다 - 지구력 신호는 남기되
    # 시즌 길이에 비례해 무한히 커지지 않는다.
    global_df['attr_athletic'] = (global_df['fb_pts_per75'] * 3.0) + (global_df['total_min'] / global_df['g'].clip(lower=1) * 0.5) + (global_df['blk_per75'] * 5.0) + (global_df['stl_per75'] * 5.0)
    
    # 5. Defense
    global_df['attr_defense'] = (global_df['stl_per75'] * 4.0) + (global_df['blk_per75'] * 4.0) + (global_df['dfl_per75'] * 3.0) - (global_df['def_rtg'] * 0.3)
    
    # 6. Rebounding
    global_df['attr_rebounding'] = (global_df['offr_per75'] * 3.0) + (global_df['defr_per75'] * 2.0) + (global_df['oreb_rt'] * 0.3) + (global_df['dreb_rt'] * 0.2)

    # ── 1. 1차 매핑: 백분위 기반으로 2K 스케일 (45~99) ──
    anchors = [(0.000, 60), (0.040, 69), (0.220, 74), (0.620, 79), (0.840, 84), (0.940, 89), (0.985, 94), (1.000, 99)]
    def map_percentile(p):
        for k in range(len(anchors) - 1):
            p0, v0 = anchors[k]
            p1, v1 = anchors[k + 1]
            if p0 <= p <= p1:
                if p1 == p0: return v1
                return v0 + ((p - p0) / (p1 - p0)) * (v1 - v0)
        return anchors[-1][1]

    # 각 속성 독립적으로 매핑
    global_df['attr_outside_mapped'] = global_df['attr_outside'].rank(method='average', pct=True).apply(map_percentile)
    global_df['attr_inside_mapped'] = global_df['attr_inside'].rank(method='average', pct=True).apply(map_percentile)
    global_df['attr_playmaking_mapped'] = global_df['attr_playmaking'].rank(method='average', pct=True).apply(map_percentile)
    global_df['attr_athletic_mapped'] = global_df['attr_athletic'].rank(method='average', pct=True).apply(map_percentile).fillna(45.0)
    global_df['attr_defense_mapped'] = global_df['attr_defense'].rank(method='average', pct=True).apply(map_percentile).fillna(45.0)
    global_df['attr_rebounding_mapped'] = global_df['attr_rebounding'].rank(method='average', pct=True).apply(map_percentile).fillna(45.0)

    # 가비지 플레이어(0~5분) 스탯 왜곡(NaN 또는 0값으로 인한 99 OVR 버그) 원천 차단
    garbage_mask = global_df['total_min'] < 5
    for col in ['attr_outside_mapped', 'attr_inside_mapped', 'attr_playmaking_mapped', 'attr_athletic_mapped', 'attr_defense_mapped', 'attr_rebounding_mapped']:
        global_df.loc[garbage_mask, col] = 45.0

    # ── 2. 모던 롤(Role) 판별 및 Multi-Role Max 가중치 적용 ──
    # NBA 2K 엔진 스타일: 모든 스페셜리스트 롤의 가중치를 전부 계산해보고, 가장 점수가 높게 나오는 롤을
    # 해당 선수의 "Best Fit Role"로 선정하여 원시 OVR(raw_ovr)로 삼는다.
    # 이를 통해 보이지 않는 곳에서 헌신하는 3&D나 락다운 디펜더 등 스페셜리스트들이 시스템 사각지대에서 깎이지 않도록 보호한다.
    
    ROLE_WEIGHTS = {
        'Point Center': (0.05, 0.25, 0.25, 0.05, 0.15, 0.25),
        'Stretch Big': (0.25, 0.20, 0.05, 0.05, 0.20, 0.25),
        'Paint Beast': (0.00, 0.35, 0.00, 0.10, 0.20, 0.35),
        'Playmaker': (0.25, 0.05, 0.35, 0.15, 0.15, 0.05),
        '3&D Wing': (0.30, 0.05, 0.05, 0.15, 0.35, 0.10),
        'Scoring Threat': (0.35, 0.25, 0.15, 0.15, 0.10, 0.00),
        'All-Around': (0.20, 0.20, 0.15, 0.15, 0.15, 0.15),
        'Sharpshooter': (0.45, 0.05, 0.15, 0.10, 0.15, 0.10),
        'Slasher': (0.05, 0.40, 0.10, 0.25, 0.10, 0.10),
        'Lockdown Defender': (0.10, 0.10, 0.10, 0.20, 0.40, 0.10),
        'Glass Cleaner': (0.00, 0.20, 0.05, 0.15, 0.20, 0.40),
    }

    def calc_best_role(row):
        role_scores = []
        
        pos = str(row['position']).upper()
        is_big = ('C' in pos) or ('F' in pos and row['reb'] >= 6.0)
        
        for role, weights in ROLE_WEIGHTS.items():
            # 빅맨 전용 롤 제한
            if not is_big and role in ['Point Center', 'Stretch Big', 'Paint Beast', 'Glass Cleaner']:
                continue
            # 가드/윙 전용 롤 제한
            if is_big and role in ['Playmaker', 'Sharpshooter']:
                continue
                
            w_out, w_in, w_pm, w_ath, w_def, w_reb = weights
            ovr = (
                row['attr_outside_mapped'] * w_out + 
                row['attr_inside_mapped'] * w_in + 
                row['attr_playmaking_mapped'] * w_pm + 
                row['attr_athletic_mapped'] * w_ath + 
                row['attr_defense_mapped'] * w_def + 
                row['attr_rebounding_mapped'] * w_reb
            )
            
            role_scores.append((role, ovr))
            
        # 점수 순으로 내림차순 정렬
        role_scores.sort(key=lambda x: x[1], reverse=True)
        
        # ── 하드 캡 (최소 자격 요건) 검사 ──
        best_role = 'All-Around'
        
        tpm = row['tpm'] / max(1, row['g'])
        pts = row['pts']
        ast = row['ast']
        stl = row['stl']
        reb = row['reb']
        
        for role_name, score in role_scores:
            if role_name == 'Sharpshooter':
                if row['attr_outside_mapped'] >= 80 or tpm >= 2.0:
                    best_role = role_name
                    break
            elif role_name == 'Lockdown Defender':
                if row['attr_defense_mapped'] >= 80 or stl >= 1.5:
                    best_role = role_name
                    break
            elif role_name == '3&D Wing':
                if row['attr_outside_mapped'] >= 75 and row['attr_defense_mapped'] >= 75:
                    best_role = role_name
                    break
            elif role_name == 'Playmaker':
                if row['attr_playmaking_mapped'] >= 80 or ast >= 5.0:
                    best_role = role_name
                    break
            elif role_name == 'Slasher':
                if row['attr_inside_mapped'] >= 80 or (row['attr_athletic_mapped'] >= 80 and row['attr_inside_mapped'] >= 75):
                    best_role = role_name
                    break
            elif role_name == 'Paint Beast':
                if row['attr_inside_mapped'] >= 80 and row['attr_rebounding_mapped'] >= 75:
                    best_role = role_name
                    break
            elif role_name == 'Glass Cleaner':
                if row['attr_rebounding_mapped'] >= 80 or reb >= 8.0:
                    best_role = role_name
                    break
            elif role_name == 'Stretch Big':
                if row['attr_outside_mapped'] >= 75 and tpm >= 1.0:
                    best_role = role_name
                    break
            elif role_name == 'Point Center':
                if row['attr_playmaking_mapped'] >= 75 or ast >= 3.5:
                    best_role = role_name
                    break
            elif role_name == 'Scoring Threat':
                if pts >= 14.0:
                    best_role = role_name
                    break
            elif role_name == 'All-Around':
                best_role = role_name
                break
        
        # 최종 OVR은 상위 3개 롤의 평균값 (원툴 선수 방지)
        top_3_avg = sum([score for r, score in role_scores[:3]]) / min(3, len(role_scores))
                
        return pd.Series([best_role, top_3_avg])

    global_df[['role', 'raw_ovr']] = global_df.apply(calc_best_role, axis=1)

    # ── 3. 고급 지표 및 보정치 가감 (OVR Buffs & Penalties) ──
    nats = load_nationalities()
    global_df['nationality'] = global_df['pcode'].map(nats)
    global_df['is_domestic'] = global_df['nationality'].fillna('대한민국').str.contains('대한민국|한국|국내|일본|필리핀|아시아쿼터')
    
    global_df['raw_ovr_mapped'] = global_df['raw_ovr']
    

    # 베테랑/궂은일 전용 보정(Unsung Hero)은 폐기함.
    # 기존에는 수비형 선수들이 All-Around로 묶여 손해를 봤기 때문에 강제 +2.0 보정을 주었으나,
    # 이제 11개 롤(Multi-Role Max) 시스템으로 수비/3&D 스페셜리스트들이 본인의 강점을 100% 반영받으므로
    # 추가 보정을 주면 오재현 같은 선수가 80점대 후반의 슈퍼스타로 이중 버프(Double-dip)를 받는 부작용이 발생함.
    
    # Winning Impact (승률, 마진, WPA, PIE 기반)
    wpa_boost = global_df['wpaPerGame'].fillna(0) * 2.0
    win_bonus = (global_df['win_pct'].fillna(0.5) - 0.5) * 5.0
    margin_bonus = global_df['margin'].fillna(0) * 0.2
    pie_bonus = (global_df['pie'].fillna(10.0) - 10.0) * 0.1 # PIE 평균 10 기준 오버/언더
    
    # 평판 가산(인기·당대의 파워): 스탯 밖의 신호(수상·올스타·국대·우승)를 OVR에 얹는다.
    # 시즌 인지형 - 그 시즌 시작연도 이하에 받은 것만 센다. 예전엔 커리어 전체 합계를 모든 시즌에 똑같이
    # 얹어서, 2018-19 MVP의 +1.5가 2010-11 신인 시즌에도 붙었다(성장 곡선이 실제보다 평평해지고 어린
    # 시즌이 부풀려짐). 대회·시상식은 그 시즌 시작연도로 잡는다(2018 아시안게임 = 2018-19 시즌 개막 직전).
    # 한번 쌓인 명성은 은퇴까지 유지하되, 하락기 감쇠는 어차피 OvrCurveModel이 처리한다.
    awards_data = load_awards()
    reputation_events = {}  # pcode -> [(시작연도, 가중치)]
    for pcode, p_awards in awards_data.items():
        events = []
        for a in p_awards:
            w = REPUTATION_WEIGHTS.get(a['id'], NATIONAL_TEAM_WEIGHT if a['id'].startswith('nt_') else 0.0)
            if not w:
                continue
            for y in a.get('years', []):
                start = parse_start_year(y)
                if start is not None:
                    events.append((start, w))
        if events:
            reputation_events[pcode] = events

    def reputation_boost(pcode, start_year):
        boost = sum(w for y, w in reputation_events.get(pcode, ()) if y <= start_year)
        return min(boost, REPUTATION_CAP)

    global_df['start_year'] = global_df['season_name'].apply(parse_start_year)
    global_df['rep_boost'] = [reputation_boost(p, y) for p, y in zip(global_df['pcode'], global_df['start_year'])]

    global_df['raw_ovr_mapped'] += (wpa_boost + win_bonus + margin_bonus + pie_bonus + global_df['rep_boost'])

    # ── 4. 가비지 타임 패널티 ──
    def apply_garbage_penalty(row):
        total_m = row['total_min']
        val = row['raw_ovr_mapped']
        if total_m < 200:
            val -= 8.0
        elif total_m < 500:
            val -= 4.0
        return val

    global_df['raw_ovr_mapped'] = global_df.apply(apply_garbage_penalty, axis=1)
    
    # Rookie Floor
    draft_ranks = load_draft_ranks()
    global_df['draft_rank_val'] = global_df['pcode'].map(draft_ranks)
    global_df['rookie_floor'] = global_df['draft_rank_val'].apply(rookie_floor_for)
    minutes_factor = np.clip(global_df['total_min'] / 400.0, 0.0, 1.0)
    global_df['raw_ovr_mapped'] = global_df['raw_ovr_mapped'] * minutes_factor + global_df['rookie_floor'] * (1.0 - minutes_factor)

    # 프로 몇 년차인지는 "DB에 처음 나온 시즌"으로 센다. 단 DB 자체가 2006-07에 시작(그 전은 1경기짜리 고아
    # 시즌뿐)해서, 그 시즌에 이미 뛰던 선수(양동근·김주성·서장훈·주희정 등)의 진짜 데뷔 연도는 알 수 없다 -
    # 예전엔 이들을 전부 "1년차"로 잡아 신인 캡(74→90)이 2006~2011년 시즌을 눌렀다(양동근 80→83→86→89→92
    # 로 매년 오르는 계단이 실은 캡이 풀리는 모양). 첫 시즌이 DB 시작 시즌인 선수는 데뷔 연도 미상 = 캡 대상 제외.
    first_start = global_df.groupby('pcode')['start_year'].min()
    debut_year_map = first_start[first_start > global_df['start_year'].min()].to_dict()
    global_df['pro_year'] = global_df['start_year'] - global_df['pcode'].map(debut_year_map) + 1

    # 전설적인 99 보정
    LEGEND_COUNT = 10
    LEGEND_TOP = 99
    LEGEND_BOTTOM = 91
    top_indices = global_df['raw_ovr_mapped'].nlargest(LEGEND_COUNT).index
    for rank, idx in enumerate(top_indices):
        t = rank / (LEGEND_COUNT - 1) if LEGEND_COUNT > 1 else 0
        global_df.loc[idx, 'raw_ovr_mapped'] = round(LEGEND_TOP - t * (LEGEND_TOP - LEGEND_BOTTOM))

    # OFF / DEF 분할
    def calc_off_def(row):
        role = row['role']
        if role == 'Point Center':
            off = (row['attr_outside_mapped']*0.1 + row['attr_inside_mapped']*0.4 + row['attr_playmaking_mapped']*0.5)
            dfn = (row['attr_athletic_mapped']*0.1 + row['attr_defense_mapped']*0.4 + row['attr_rebounding_mapped']*0.5)
        elif role == 'Stretch Big':
            off = (row['attr_outside_mapped']*0.4 + row['attr_inside_mapped']*0.4 + row['attr_playmaking_mapped']*0.2)
            dfn = (row['attr_athletic_mapped']*0.2 + row['attr_defense_mapped']*0.4 + row['attr_rebounding_mapped']*0.4)
        elif role == 'Paint Beast':
            off = (row['attr_inside_mapped']*0.7 + row['attr_playmaking_mapped']*0.1 + row['attr_rebounding_mapped']*0.2)
            dfn = (row['attr_athletic_mapped']*0.2 + row['attr_defense_mapped']*0.3 + row['attr_rebounding_mapped']*0.5)
        elif role == 'Playmaker':
            off = (row['attr_outside_mapped']*0.4 + row['attr_inside_mapped']*0.1 + row['attr_playmaking_mapped']*0.5)
            dfn = (row['attr_athletic_mapped']*0.2 + row['attr_defense_mapped']*0.6 + row['attr_rebounding_mapped']*0.2)
        elif role == '3&D Wing':
            off = (row['attr_outside_mapped']*0.7 + row['attr_inside_mapped']*0.2 + row['attr_playmaking_mapped']*0.1)
            dfn = (row['attr_athletic_mapped']*0.2 + row['attr_defense_mapped']*0.6 + row['attr_rebounding_mapped']*0.2)
        elif role == 'Scoring Threat':
            off = (row['attr_outside_mapped']*0.5 + row['attr_inside_mapped']*0.3 + row['attr_playmaking_mapped']*0.2)
            dfn = (row['attr_athletic_mapped']*0.3 + row['attr_defense_mapped']*0.5 + row['attr_rebounding_mapped']*0.2)
        elif role == 'Sharpshooter':
            off = (row['attr_outside_mapped']*0.7 + row['attr_inside_mapped']*0.1 + row['attr_playmaking_mapped']*0.2)
            dfn = (row['attr_athletic_mapped']*0.3 + row['attr_defense_mapped']*0.5 + row['attr_rebounding_mapped']*0.2)
        elif role == 'Slasher':
            off = (row['attr_outside_mapped']*0.1 + row['attr_inside_mapped']*0.7 + row['attr_athletic_mapped']*0.2)
            dfn = (row['attr_athletic_mapped']*0.3 + row['attr_defense_mapped']*0.5 + row['attr_rebounding_mapped']*0.2)
        elif role == 'Lockdown Defender':
            off = (row['attr_outside_mapped']*0.4 + row['attr_inside_mapped']*0.4 + row['attr_playmaking_mapped']*0.2)
            dfn = (row['attr_athletic_mapped']*0.2 + row['attr_defense_mapped']*0.7 + row['attr_rebounding_mapped']*0.1)
        elif role == 'Glass Cleaner':
            off = (row['attr_inside_mapped']*0.5 + row['attr_playmaking_mapped']*0.1 + row['attr_rebounding_mapped']*0.4)
            dfn = (row['attr_athletic_mapped']*0.1 + row['attr_defense_mapped']*0.2 + row['attr_rebounding_mapped']*0.7)
        else: # All-Around
            off = (row['attr_outside_mapped']*0.4 + row['attr_inside_mapped']*0.3 + row['attr_playmaking_mapped']*0.3)
            dfn = (row['attr_athletic_mapped']*0.3 + row['attr_defense_mapped']*0.4 + row['attr_rebounding_mapped']*0.3)
            
        mod = (row['raw_ovr_mapped'] - row['raw_ovr']) # OVR에 더해진 버프/패널티 마진
        return off + mod, dfn + mod

    global_df[['raw_off_mapped', 'raw_def_mapped']] = global_df.apply(calc_off_def, axis=1, result_type='expand')

    # ── 2. 시즌별 오버롤 스무딩 (OvrCurveModel) 적용 ──
    birth_years = load_birth_years()
    global_df['birth_year'] = global_df['pcode'].map(birth_years)
    global_df['age'] = np.where(
        global_df['birth_year'].notna() & global_df['start_year'].notna(),
        global_df['start_year'] - global_df['birth_year'],
        np.nan,
    )
    global_df['age_for_model'] = global_df['age'].fillna(NEUTRAL_AGE)

    model = OvrCurveModel()
    corrected_ovr = pd.Series(index=global_df.index, dtype=float)
    corrected_off = pd.Series(index=global_df.index, dtype=float)
    corrected_def = pd.Series(index=global_df.index, dtype=float)
    
    corrected_outside = pd.Series(index=global_df.index, dtype=float)
    corrected_inside = pd.Series(index=global_df.index, dtype=float)
    corrected_playmaking = pd.Series(index=global_df.index, dtype=float)
    corrected_athletic = pd.Series(index=global_df.index, dtype=float)
    corrected_defense = pd.Series(index=global_df.index, dtype=float)
    corrected_rebounding = pd.Series(index=global_df.index, dtype=float)

    for pcode, group in global_df.groupby('pcode'):
        group = group.sort_values('season_name')
        idxs = group.index.tolist()

        # Determine career play_style
        career_tpm = group['tpm'].sum() / max(1, group['g'].sum())
        career_pts = group['pts'].mean()
        career_ast = group['ast'].mean()
        career_reb = group['reb'].mean()
        career_blk = group['blk'].mean()
        
        play_style = "balanced"
        if career_tpm >= 2.0 or (career_tpm >= 1.5 and career_ast >= 4.0):
            play_style = "shooter"
        elif career_reb >= 8.0 or career_blk >= 1.0 or (career_pts >= 15.0 and career_tpm < 1.0):
            play_style = "athletic"
            
        for mapped_col, out_series in (
            ('raw_ovr_mapped', corrected_ovr), 
            ('raw_off_mapped', corrected_off), 
            ('raw_def_mapped', corrected_def),
            ('attr_outside_mapped', corrected_outside),
            ('attr_inside_mapped', corrected_inside),
            ('attr_playmaking_mapped', corrected_playmaking),
            ('attr_athletic_mapped', corrected_athletic),
            ('attr_defense_mapped', corrected_defense),
            ('attr_rebounding_mapped', corrected_rebounding)
        ):
            seasons = [
                {
                    "season": group.loc[i, 'season_name'],
                    "age": int(group.loc[i, 'age_for_model']),
                    "raw_performance": group.loc[i, mapped_col],
                    "play_style": play_style,
                    "games": int(group.loc[i, 'g']),
                }
                for i in idxs
            ]
            for i, r in zip(idxs, model.process_player(seasons)):
                out_series.loc[i] = r["calculated_ovr"]



    # 최종 결과 산출
    global_df['OVR'] = corrected_ovr.round().astype(int).clip(40, 99)
    global_df['OFF'] = corrected_off.round().astype(int).clip(40, 99)
    global_df['DEF'] = corrected_def.round().astype(int).clip(40, 99)
    
    global_df['ATTR_OUTSIDE'] = corrected_outside.round().astype(int).clip(40, 99)
    global_df['ATTR_INSIDE'] = corrected_inside.round().astype(int).clip(40, 99)
    global_df['ATTR_PLAYMAKING'] = corrected_playmaking.round().astype(int).clip(40, 99)
    global_df['ATTR_ATHLETIC'] = corrected_athletic.round().astype(int).clip(40, 99)
    global_df['ATTR_DEFENSE'] = corrected_defense.round().astype(int).clip(40, 99)
    global_df['ATTR_REBOUNDING'] = corrected_rebounding.round().astype(int).clip(40, 99)

    # ── Rookie Scale Cap (NBA 2K 기준 1~5년차 국내 선수 하드 상한선) ──
    # OvrCurveModel의 나이 보너스로 인해 상한선을 뚫고 올라온 선수들의 최종 수치를 깎습니다.
    def final_rookie_cap(row):
        val = row['OVR']
        if not row['is_domestic'] or pd.isna(row['pro_year']):
            return val
            
        pro_year = row['pro_year']
        if pro_year == 1:
            cap = 74.0
        elif pro_year == 2:
            cap = 78.0
        elif pro_year == 3:
            cap = 82.0
        elif pro_year == 4:
            cap = 86.0
        elif pro_year == 5:
            cap = 90.0
        else:
            return val
            
        minutes_bonus = min(2.0, row['total_min'] / 1000.0)
        final_cap = cap + minutes_bonus
        if val <= final_cap:
            return int(val)
        else:
            # 소프트 캡 (초과분의 30%만 인정)
            excess = val - final_cap
            return int(round(final_cap + excess * 0.3))

    # ── Role Player Cap (저점유율 스페셜리스트 하드 상한선) ──
    # 오재현과 같이 압도적인 수비/3점 지표를 가졌으나 공격 점유율(Usage)이 낮은 선수가
    # 리그 최상위권 85+ 오버롤을 받는 현상(과대평가)을 방지합니다.
    def final_role_player_cap(row):
        val = row['OVR']
        usg = row['usage']
        role = row['role']
        
        # 메인 볼핸들러(Playmaker), 빅맨(Paint Beast, Glass Cleaner, Point Center)은
        # 원래 점유율이 낮아도 영향력이 크므로 제외
        if usg > 18.0 or role in ['Playmaker', 'Paint Beast', 'Glass Cleaner', 'Point Center', 'All-Around'] or pd.isna(usg):
            return val
            
        # 수비형/3점 스페셜리스트 역할군이 점유율 18% 이하일 경우 하드캡 적용
        # 오재현(17.4%) 같은 롤 플레이어를 현실적인 81점 만점으로 제한
        cap = 81.0
        minutes_bonus = min(1.0, row['total_min'] / 1000.0)
        return int(min(val, cap + minutes_bonus))



    # 캡으로 깎인 만큼은 OFF/DEF/세부 능력치에도 똑같이 빼야 한다(예상치 행은 이미 그렇게 함). 예전엔 role
    # 캡 분만 전파해서 신인 캡에 걸린 선수는 OVR 78인데 OFF 88 같은 불일치가 났다.
    pre_cap_ovr = global_df['OVR']
    global_df['OVR'] = global_df.apply(final_rookie_cap, axis=1)
    global_df['OVR'] = global_df.apply(final_role_player_cap, axis=1)
    diff = global_df['OVR'] - pre_cap_ovr
    
    # ── 하드코딩 예외 처리 (밸런스 수동 보정, MANUAL_OVR_OVERRIDES) ──
    manual_diff = global_df.apply(
        lambda row: manual_override_delta(row['pcode'], row['season_name']), axis=1)
    global_df['OVR'] = (global_df['OVR'] + manual_diff).clip(40, 99)
    diff += manual_diff
    
    global_df['OFF'] = (global_df['OFF'] + diff).clip(40, 99)
    global_df['DEF'] = (global_df['DEF'] + diff).clip(40, 99)
    global_df['ATTR_OUTSIDE'] = (global_df['ATTR_OUTSIDE'] + diff).clip(40, 99)
    global_df['ATTR_INSIDE'] = (global_df['ATTR_INSIDE'] + diff).clip(40, 99)
    global_df['ATTR_PLAYMAKING'] = (global_df['ATTR_PLAYMAKING'] + diff).clip(40, 99)
    global_df['ATTR_ATHLETIC'] = (global_df['ATTR_ATHLETIC'] + diff).clip(40, 99)
    global_df['ATTR_DEFENSE'] = (global_df['ATTR_DEFENSE'] + diff).clip(40, 99)
    global_df['ATTR_REBOUNDING'] = (global_df['ATTR_REBOUNDING'] + diff).clip(40, 99)

    # ── 3차: 배지 및 빌드(Archetype) 산출 ────────────────────────────────
    ROLE_KOR_MAP = {
        'Point Center': '포인트 센터',
        'Stretch Big': '스트레치 빅',
        'Paint Beast': '페인트존 장인',
        'Glass Cleaner': '글래스 클리너',
        'Playmaker': '플레이메이커',
        'Sharpshooter': '샤프슈터',
        'Slasher': '슬래셔',
        '3&D Wing': '3&D 윙',
        'Lockdown Defender': '락다운 디펜더',
        'Scoring Threat': '스코어링 스렛',
        'All-Around': '올어라운드'
    }
    
    global_df['archetype'] = global_df['role'].map(ROLE_KOR_MAP)

    def calc_badge(val, bronze, silver, gold, hof):
        if val >= hof: return 4
        if val >= gold: return 3
        if val >= silver: return 2
        if val >= bronze: return 1
        return 0

    def determine_badges(row):
        pts = row['pts']
        tpm = row['tpm'] / max(1, row['g'])
        ast = row['ast']
        stl_blk = row['stl'] + row['blk']
        
        inside_pts = pts - (tpm * 3)
        
        finishing = calc_badge(inside_pts, 8, 12, 16, 20)
        shooting = calc_badge(tpm, 1.5, 2.0, 2.5, 3.0)
        playmaking = calc_badge(ast, 3.5, 5.0, 6.5, 8.0)
        defense = calc_badge(stl_blk, 1.5, 2.2, 3.0, 4.0)
        
        return {
            "finishing": finishing,
            "shooting": shooting,
            "playmaking": playmaking,
            "defense": defense
        }
        
    global_df['badges'] = global_df.apply(determine_badges, axis=1)

    # 3. 이제 모든 시즌/모든 선수 데이터를 JSON으로 출력
    # (특정 타겟 시즌 필터링 생략 - 전체 히스토리 덤프)
    out_data = []

    # 정렬: pcode(선수), season_name(시즌) 오름차순 (오래된 시즌부터)
    global_df = global_df.sort_values(by=['pcode', 'season_name'])

    # 팀과 포지션 정보 로드
    teams, positions = load_teams_and_positions()
    # 시즌별 팀 - 없으면(경기 기록에 팀이 없는 예외) 예전처럼 현재 팀으로 폴백한다.
    season_team = load_season_teams()
    global_df['team'] = [
        season_team.get((p, s)) or teams.get(p, "Unknown")
        for p, s in zip(global_df['pcode'], global_df['season_name'])
    ]
    print(f"시즌별 팀 매핑: {sum((p, s) in season_team and bool(season_team[(p, s)]) for p, s in zip(global_df['pcode'], global_df['season_name']))}/{len(global_df)}행")

    for _, row in global_df.iterrows():
        out_data.append({
            "pcode": row['pcode'],
            "name": row['name'],
            "season": row['season_name'],
            "team": row['team'],
            "position": positions.get(row['pcode'], "Unknown"),
            "role": row.get('role', 'Unknown'),
            "OVR": int(row['OVR']),
            "OFF": int(row['OFF']),
            "DEF": int(row['DEF']),
            "attributes": {
                "outside": int(row['ATTR_OUTSIDE']),
                "inside": int(row['ATTR_INSIDE']),
                "playmaking": int(row['ATTR_PLAYMAKING']),
                "athletic": int(row['ATTR_ATHLETIC']),
                "defense": int(row['ATTR_DEFENSE']),
                "rebounding": int(row['ATTR_REBOUNDING'])
            },
            "archetype": row['archetype'],
            "badges": row['badges'],
            "projected": False,
        })

    # ── 공백 시즌 보간(군 복무·부상 등으로 그 시즌 KBL 기록이 통째로 없는 경우) ──
    # 요청: "부상이나 군 문제로 빠진 선수들도 오버롤이 이어질 수 있게, 앞뒤를 보고 예측값으로
    # 오버롤 그래프가 좀더 다양해 보이게" - 지금까지는 공백 시즌엔 행 자체가 없어 그래프가
    # 공백 앞뒤를 그냥 직선으로 건너뛰었다. 나이 곡선을 다시 태우지는 않는다(그 기간 실제로
    # 안 뛰었으니 검증할 근거가 없다) - 대신 공백 앞뒤의 실측값을 선형보간해 매끄럽게 잇는다.
    GAP_FILL_MAX_SEASONS = 10  # 사용자의 요청에 따라 모든 공백(군대, 장기 부상 등)을 이어지게 하기 위해 크게 늘림
    gap_fill_rows = []
    for pcode, group in global_df.groupby('pcode'):
        recs = group.sort_values('season_name').to_dict('records')
        # 유효한 시작 연도가 있는 레코드만 필터링 (에러 방지)
        valid_recs = []
        valid_starts = []
        for r in recs:
            s = parse_start_year(r['season_name'])
            if s is not None:
                valid_recs.append(r)
                valid_starts.append(s)
        
        for i in range(len(valid_recs) - 1):
            gap = valid_starts[i + 1] - valid_starts[i]
            if 1 < gap <= GAP_FILL_MAX_SEASONS + 1:
                before, after = valid_recs[i], valid_recs[i + 1]
                for k in range(1, gap):
                    frac = k / gap
                    missing_start = valid_starts[i] + k
                    gap_fill_rows.append({
                        "pcode": pcode,
                        "name": after['name'],
                        "season": f"{missing_start}-{missing_start + 1}",
                        "team": before['team'],
                        "position": positions.get(pcode, "Unknown"),
                        "OVR": int(round(before['OVR'] + (after['OVR'] - before['OVR']) * frac)),
                        "OFF": int(round(before['OFF'] + (after['OFF'] - before['OFF']) * frac)),
                        "DEF": int(round(before['DEF'] + (after['DEF'] - before['DEF']) * frac)),
                        "attributes": {
                            "outside": int(round(before['ATTR_OUTSIDE'] + (after['ATTR_OUTSIDE'] - before['ATTR_OUTSIDE']) * frac)),
                            "inside": int(round(before['ATTR_INSIDE'] + (after['ATTR_INSIDE'] - before['ATTR_INSIDE']) * frac)),
                            "playmaking": int(round(before['ATTR_PLAYMAKING'] + (after['ATTR_PLAYMAKING'] - before['ATTR_PLAYMAKING']) * frac)),
                            "athletic": int(round(before['ATTR_ATHLETIC'] + (after['ATTR_ATHLETIC'] - before['ATTR_ATHLETIC']) * frac)),
                            "defense": int(round(before['ATTR_DEFENSE'] + (after['ATTR_DEFENSE'] - before['ATTR_DEFENSE']) * frac)),
                            "rebounding": int(round(before['ATTR_REBOUNDING'] + (after['ATTR_REBOUNDING'] - before['ATTR_REBOUNDING']) * frac))
                        },
                        "archetype": before['archetype'],
                        "badges": before['badges'],
                        "projected": True,
                    })
    out_data.extend(gap_fill_rows)

    # ── 다음 시즌 예상 OVR (개막 전이라 이번 시즌 경기 기록이 0개인 선수용) ──
    # 제보 1) "스탯이 적어서 오버롤이 없는 선수도 표시해달라" 2) "작년 기준 이번 시즌 새
    # 오버롤 표시" - 둘 다 같은 원인: 시즌 전엔 그 시즌 행 자체가 없어 프로필이 빈 카드가
    # 된다. 확정 로스터(season_roster)에 있고 과거 KBL 기록이 있는 선수는, 마지막 시즌의
    # calculated_ovr을 "새 정보 없음" raw_performance로 한 번 더 태워(나이만 한 살 더 먹임)
    # OvrCurveModel의 나이 곡선을 그대로 적용한 예상치를 만든다. 과거 기록이 아예 없는
    # 완전 신인은 예상할 근거가 없어 건너뛴다(그 선수는 지금처럼 "기록 없음"으로 남는다 -
    # 이건 데이터 부족이 아니라 사실이 그렇다).
    next_season_roster = load_next_season_roster(PROJECTION_SEASON)
    already_covered = set(global_df.loc[global_df['season_name'] == PROJECTION_SEASON, 'pcode'])
    to_project = set(next_season_roster) - already_covered

    # 커리어 기록이 전혀 없는 완전 신인용 최저치 - 실측 데이터에서 실제로 몇 경기 못 뛴
    # 선수들의 바닥권(하위 5명 53~58)을 참고해 잡았다. 처음엔 전원 55로 고정했는데(제보:
    # "거의 안 뛴 선수들이 전부 55라 뻔해 보인다") 그 범위 안에서 실제로 존재하는 신호
    # (드래프트 순위)로 갈라준다 - 여전히 경기 기록이 없으니 53~58을 벗어나는 근거는 없다.
    draft_ranks = load_draft_ranks()

    for pcode in to_project:
        hist = global_df[global_df['pcode'] == pcode].sort_values('season_name')
        if hist.empty:
            scouted = SCOUTED_ROOKIE_PROFILES.get(pcode)
            floor = rookie_floor_for(draft_ranks.get(pcode))
            out_data.append({
                "pcode": pcode,
                "name": next_season_roster.get(pcode, {}).get("name", "Unknown"),
                "season": PROJECTION_SEASON,
                "team": next_season_roster.get(pcode, {}).get("team", "Unknown"),
                "position": positions.get(pcode, "Unknown"),
                "OVR": scouted["OVR"] if scouted else floor,
                "OFF": scouted["OFF"] if scouted else floor,
                "DEF": scouted["DEF"] if scouted else floor,
                "attributes": dict(scouted["attributes"]) if scouted else {
                    "outside": floor, "inside": floor, "playmaking": floor,
                    "athletic": floor, "defense": floor, "rebounding": floor
                },
                "archetype": scouted["archetype"] if scouted else "롤 플레이어",
                "badges": {"finishing": 0, "shooting": 0, "playmaking": 0, "defense": 0},
                "projected": True,
            })
            continue
        last = hist.iloc[-1]

        career_tpm = hist['tpm'].sum() / max(1, hist['g'].sum())
        play_style = "balanced"
        if career_tpm >= 2.0 or (career_tpm >= 1.5 and hist['ast'].mean() >= 4.0):
            play_style = "shooter"
        elif hist['reb'].mean() >= 8.0 or hist['blk'].mean() >= 1.0 or (hist['pts'].mean() >= 15.0 and career_tpm < 1.0):
            play_style = "athletic"

        def project_one(mapped_col):
            seasons = [
                {"season": r['season_name'], "age": int(r['age_for_model']),
                 "raw_performance": r[mapped_col], "play_style": play_style,
                 "games": int(r['g'])}
                for _, r in hist.iterrows()
            ]
            return model.project_forward(seasons, extra_years=1)

        # 마지막 확정 시즌 이후~예상 시즌 개막 전에 새로 쌓인 평판(예: 2026 아시안게임 발탁)만 얹는다.
        rep_delta = (reputation_boost(pcode, parse_start_year(PROJECTION_SEASON))
                     - reputation_boost(pcode, last['start_year']))
        proj_ovr = round(project_one('raw_ovr_mapped') + rep_delta)
        proj_off = round(project_one('raw_off_mapped') + rep_delta)
        proj_def = round(project_one('raw_def_mapped') + rep_delta)
        proj_outside = round(project_one('attr_outside_mapped'))
        proj_inside = round(project_one('attr_inside_mapped'))
        proj_playmaking = round(project_one('attr_playmaking_mapped'))
        proj_athletic = round(project_one('attr_athletic_mapped'))
        proj_defense = round(project_one('attr_defense_mapped'))
        proj_rebounding = round(project_one('attr_rebounding_mapped'))

        manual_delta = manual_override_delta(pcode, PROJECTION_SEASON)
        if manual_delta:
            proj_ovr += manual_delta
            proj_off += manual_delta
            proj_def += manual_delta
            proj_outside += manual_delta
            proj_inside += manual_delta
            proj_playmaking += manual_delta
            proj_athletic += manual_delta
            proj_defense += manual_delta
            proj_rebounding += manual_delta

        # ── Rookie Scale Cap (for projected data) ──
        if last['is_domestic'] and pd.notna(last['start_year']):
            proj_start_year = parse_start_year(PROJECTION_SEASON)
            proj_pro_year = proj_start_year - debut_year_map.get(pcode, -10**6) + 1
            if 1 <= proj_pro_year <= 5:
                if proj_pro_year == 1:
                    cap = 74.0
                elif proj_pro_year == 2:
                    cap = 78.0
                elif proj_pro_year == 3:
                    cap = 82.0
                elif proj_pro_year == 4:
                    cap = 86.0
                else:  # proj_pro_year == 5
                    cap = 90.0
                
                minutes_bonus = min(2.0, last['total_min'] / 1000.0)
                final_cap = cap + minutes_bonus
                
                if proj_ovr > final_cap:
                    excess = proj_ovr - final_cap
                    soft_capped_ovr = int(round(final_cap + excess * 0.3))
                    diff = proj_ovr - soft_capped_ovr
                    proj_ovr = soft_capped_ovr
                    proj_off -= diff
                    proj_def -= diff
                    proj_outside -= diff
                    proj_inside -= diff
                    proj_playmaking -= diff
                    proj_athletic -= diff
                    proj_defense -= diff
                    proj_rebounding -= diff
                    
        # ── Role Player Cap (for projected data) ──
        proj_usg = last.get('usage', 20.0)
        proj_role = last.get('role', 'All-Around')
        if proj_usg <= 18.0 and proj_role not in ['Playmaker', 'Paint Beast', 'Glass Cleaner', 'Point Center', 'All-Around'] and not pd.isna(proj_usg):
            minutes_bonus = min(1.0, last['total_min'] / 1000.0)
            final_cap = 81.0 + minutes_bonus
            if proj_ovr > final_cap:
                diff = proj_ovr - final_cap
                proj_ovr = int(round(final_cap))
                proj_off -= diff
                proj_def -= diff
                proj_outside -= diff
                proj_inside -= diff
                proj_playmaking -= diff
                proj_athletic -= diff
                proj_defense -= diff
                proj_rebounding -= diff

        out_data.append({
            "pcode": pcode,
            "name": last['name'],
            "season": PROJECTION_SEASON,
            "team": next_season_roster.get(pcode, {}).get("team") or teams.get(pcode, "Unknown"),
            "position": positions.get(pcode, "Unknown"),
            "OVR": int(max(40, min(99, proj_ovr))),
            "OFF": int(max(40, min(99, proj_off))),
            "DEF": int(max(40, min(99, proj_def))),
            "attributes": {
                "outside": int(max(40, min(99, proj_outside))),
                "inside": int(max(40, min(99, proj_inside))),
                "playmaking": int(max(40, min(99, proj_playmaking))),
                "athletic": int(max(40, min(99, proj_athletic))),
                "defense": int(max(40, min(99, proj_defense))),
                "rebounding": int(max(40, min(99, proj_rebounding)))
            },
            "archetype": last['archetype'],
            "badges": last['badges'],
            "projected": True,
        })

    # 공백 시즌 보간/다음 시즌 예상 행이 뒤에 통째로 덧붙는 구조라, 그대로 두면 한 선수의
    # 시즌이 배열 순서상 뒤섞인다(예: 2016-17 보간 행이 2021-22 뒤에 옴) - lib/ovr.ts의
    # getPlayerOvrHistory()는 이 배열이 이미 오름차순 정렬돼 있다고 가정하므로(재정렬 안 함)
    # 여기서 최종적으로 한 번 더 정렬해 그 가정을 보장한다.
    out_data.sort(key=lambda r: (r['pcode'], r['season']))

    OUT_PATH = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_ovr_history.json')
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out_data, f, ensure_ascii=False, indent=2)

    # Windows에서 이모지 출력 시 cp949 인코딩 오류 방지
    print(f"[SUCCESS] Generated {len(out_data)} historical OVR records at {OUT_PATH}")


if __name__ == "__main__":
    compute_ovr()
