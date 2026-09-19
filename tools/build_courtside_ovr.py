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

# 박스스코어에는 없는 외부 신호(국가대표 발탁 등)를 다음 시즌 예상치에만 명시적으로
# 가산한다 - roster_departure(은퇴/미계약처럼 경기 기록만으로는 알 수 없는 사실을 사람이
# 확인해 적재하는 테이블)와 같은 패턴. 나이 곡선/스무딩 파라미터를 손대는 시도는 "어릴수록
# 보너스가 크다"는 구조 때문에 데뷔 시즌이 최근 시즌보다 높아지는 역전을 낳아 되돌렸다
# (2026-09-18) - 대신 확정된 과거 시즌은 그대로 두고, 아직 경기가 없는 예상치에만 사람이
# 사유를 남기고 가산하는 이 방식으로 대체한다. 사용자 확인 후에만 추가/제거할 것.
PROJECTION_REPUTATION_BOOST = {
    '291752': {'boost': 1, 'reason': '2026 국가대표 발탁(김보배) - 박스스코어에 없는 외부 신호, 2026-09-18 사용자 확인'},
}


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
            " WHERE g.season_category IN ('정규시즌', '플레이오프', '챔프전')"
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
    teams = {}
    positions = {}
    for c in cards:
        pcode = c.get('pcode')
        team = c.get('team_name_current')
        pos = c.get('position')
        if pcode:
            if team: teams[pcode] = team
            if pos: positions[pcode] = pos
    return teams, positions

def load_next_season_roster(season):
    """season_roster(Supabase, import_roster.py가 적재)에서 이 시즌 확정 로스터의
    pcode -> {team, name}을 반환한다(name은 KBL 기록이 전혀 없는 완전 신인의 표시용 -
    global_df에는 그 pcode 행 자체가 없어 이름을 따로 들고 있어야 한다). 개막 전 스탯이
    0개인 시즌에 예상 OVR을 만들 대상을 정하는 데 쓴다. DB 접속이 안 되면(로컬/오프라인)
    빈 dict로 조용히 건너뛴다 - 예상 OVR은 있으면 좋은 부가 기능이지 본 파이프라인의
    필수 요건이 아니다."""
    try:
        import psycopg2
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from import_roster import load_database_url
        conn = psycopg2.connect(load_database_url())
        cur = conn.cursor()
        cur.execute(
            "select r.pcode, t.name, r.player_name from season_roster r join teams t using (tcode)"
            " where r.season_name = %s and r.pcode is not null",
            (season,),
        )
        result = {pcode: {"team": team, "name": name} for pcode, team, name in cur.fetchall()}
        conn.close()
        return result
    except Exception as e:
        print(f"경고: season_roster 조회 실패({e}) - {season} 예상 OVR 생성을 건너뜀")
        return {}


def parse_start_year(season_name):
    try:
        return int(str(season_name).split('-')[0])
    except (ValueError, IndexError):
        return None


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
    global_query = """
    SELECT
        gps.pcode, g.season_name,
        COUNT(gps.gmkey) as g,
        SUM(gps.play_min + gps.play_sec/60.0) as total_min,
        AVG(gps.score) as pts,
        AVG(gps.ast) as ast,
        AVG(gps.rb) as reb,
        AVG(gps.stl) as stl,
        AVG(gps.bs) as blk,
        AVG(gps.to_) as tov,
        SUM(gps.per * (gps.play_min + gps.play_sec/60.0)) / SUM(gps.play_min + gps.play_sec/60.0) as per,
        SUM(MAX(MIN(gps.netrtg, 50), -50) * (gps.play_min + gps.play_sec/60.0)) / SUM(gps.play_min + gps.play_sec/60.0) as net_rtg,
        SUM(gps.usg_rt * (gps.play_min + gps.play_sec/60.0)) / SUM(gps.play_min + gps.play_sec/60.0) as usage,
        SUM(gps.fg) as fgm, SUM(gps.fg_a) as fga,
        SUM(gps.threep) as tpm, SUM(gps.threep_a) as tpa,
        SUM(gps.ft) as ftm, SUM(gps.ft_a) as fta,
        AVG(gps.offr) as offr, AVG(gps.defr) as defr,
        SUM(gps.dk) as dkm, SUM(gps.dk_a) as dka,
        AVG(gps.fb) as fb_pts, AVG(gps.pp) as paint_pts,
        AVG(gps.sast) as sast, AVG(gps.dfl) as dfl,
        AVG(gps.ast_rt) as ast_rt, AVG(gps.ast_to) as ast_to,
        AVG(gps.oreb_rt) as oreb_rt, AVG(gps.dreb_rt) as dreb_rt, AVG(gps.tov_rt) as tov_rt,
        SUM(gps.defrtg * (gps.play_min + gps.play_sec/60.0)) / SUM(gps.play_min + gps.play_sec/60.0) as def_rtg
    FROM player_game_stats gps
    JOIN games g ON gps.gmkey = g.gmkey
    WHERE g.season_category IN ('정규시즌', '플레이오프', '챔프전')
      AND g.season_name NOT LIKE '%D리그%'
    GROUP BY gps.pcode, g.season_name
    """

    try:
        global_df = pd.read_sql_query(global_query, conn)
        name_df = pd.read_sql_query(
            "SELECT gps.pcode, gps.pname, g.season_name"
            " FROM player_game_stats gps JOIN games g ON gps.gmkey = g.gmkey",
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

    # Raw Scores
    global_df['raw_off'] = (global_df['pts'] * 2.5) + (global_df['ast'] * 1.5) + (global_df['ts_pct'] * (global_df['pts'] / 20.0)) + (global_df['per'] * 1.2)
    # net_rtg 가중치 0.5 -> 0.2: 팀 전체 성적(동료 효과)이 개인 수비 기여로 그대로 새는
    # 폭이 커서, 개인 수비 지표(리바운드/스틸/블록)가 약해도 팀이 잘 막으면 DEF가 확 뜬다
    # (실측: 케렘 칸터 - 블록 0.28/약함에도 팀 net_rtg에 얹혀 DEF 88~89까지 상승, 반면
    # kbl540 자체 스카우팅 def_rating은 66). 완전히 빼면 팀 방어 기여 자체가 사라지므로
    # 남겨두되 비중만 줄인다.
    global_df['raw_def'] = (global_df['reb'] * 1.8) + (global_df['stl'] * 3.0) + (global_df['blk'] * 3.5) + (global_df['net_rtg'] * 0.2)

    # ── 세부 카테고리 (NBA 2K 스타일) 원시 점수 계산 ──
    # 1. Outside Scoring
    # 3점, 미드레인지(추정), 자유투, TS% 종합
    global_df['attr_outside'] = (global_df['tpm'] * 4.0) + (global_df['ts_pct'] * 30.0) + (global_df['ftm'] * 1.5)

    # 2. Inside Scoring
    # 페인트존 득점, 덩크, 2점 시도 대비 자유투 획득(FTr) 종합
    global_df['attr_inside'] = (global_df['paint_pts'] * 2.0) + (global_df['dkm'] * 5.0) + (np.where(global_df['fga'] > 0, global_df['fta'] / global_df['fga'], 0) * 20.0)

    # 3. Playmaking
    # 어시스트, 세컨더리 어시스트, 어시/턴오버 비율, Usage 종합
    global_df['attr_playmaking'] = (global_df['ast'] * 3.0) + (global_df['sast'] * 2.0) + (global_df['ast_to'] * 5.0) + (global_df['ast_rt'] * 0.2)

    # 4. Athleticism
    # 속공 득점, 출전 시간, 블록/스틸(민첩/점프) 종합
    global_df['attr_athletic'] = (global_df['fb_pts'] * 3.0) + (global_df['total_min'] / max(1, global_df['g'].max()) * 0.5) + (global_df['blk'] * 5.0) + (global_df['stl'] * 5.0)

    # 5. Defense
    # 디펜시브 레이팅(역수 적용), 스틸, 블록, 디플렉션 종합
    global_df['attr_defense'] = (global_df['stl'] * 4.0) + (global_df['blk'] * 4.0) + (global_df['dfl'] * 3.0) - (global_df['def_rtg'] * 0.3)

    # 6. Rebounding
    # 공/수 리바운드 볼륨 및 마진율 종합
    global_df['attr_rebounding'] = (global_df['offr'] * 3.0) + (global_df['defr'] * 2.0) + (global_df['oreb_rt'] * 0.3) + (global_df['dreb_rt'] * 0.2)


    # ── 1. 1차 매핑: 백분위 기반으로 2K 스케일 (45~99) 부여 ──
    # 원본 스탯(raw_ovr)을 구한 뒤, 국내 선수에게 버프를 주고 전체 줄을 세워 스케일링합니다.
    global_df['raw_ovr'] = (global_df['raw_off'] * 0.55) + (global_df['raw_def'] * 0.45)
    
    # 국내 선수 보정 (Domestic Buff)
    # 라건아(귀화 후에도 이 파일에서 nationality='외국'로 유지됨 - 로스터 쿼터상으로는
    # 국내지만 스탯상 전형적 외국인 빅맨이라 이 버프 대상에서 계속 제외한다)는 여기서
    # 자동으로 빠진다: 사용자 제보(귀화로 국내 취급돼 국내 선수들이 상대적으로 낮아 보인다는
    # 우려) 확인 결과 이미 정상 - 실측 원인은 버프 오적용이 아니라 아래 두 가지였다.
    nats = load_nationalities()
    global_df['nationality'] = global_df['pcode'].map(nats)
    # 국적이 대한민국이거나 아시아쿼터(필리핀, 일본), 또는 널(신인 등)이면 가중치
    is_domestic = global_df['nationality'].fillna('대한민국').str.contains('대한민국|한국|필리핀|일본')
    # 국내 상위권(이정현 등)이 외국인 빅맨들 밑 88점대에 눌려 있다는 제보 확인 - 리그 역대
    # 단신/윙 포지션 다수가 국내라 외국인 빅맨 위주 스탯 볼륨과 원천적으로 경쟁이 안 되던
    # 구간이었다. 처음엔 국내 전원에게 같은 배율(15%->55%)을 곱하는 식으로 풀었는데, 이러면
    # 벤치급 국내 선수까지 실력과 무관하게 통째로 떠밀려 올라가는 부작용이 있다.
    # 아시아쿼터(이선 알바노 등)도 대상에 포함하여 국내 최고선수(이정현)와 균형을 맞춥니다.
    percentile = global_df['raw_ovr'].rank(method='average', pct=True)
    TOP_BUFF = 0.55
    domestic_buff = TOP_BUFF * (percentile ** 1.5)
    global_df.loc[is_domestic, 'raw_ovr'] *= (1 + domestic_buff[is_domestic])

    # MVP/올-KBL 최고 수준 가드(알바노) 어드밴티지 (어시스트 마진이 높은 선수 추가 버프)
    # 알바노가 이정현과 동급 혹은 소폭 위로 자리잡도록 Playmaking 특화 선수 스케일링 상향
    playmaker_buff = np.where(global_df['ast_to'] > 2.0, 0.05 * (percentile ** 2), 0)
    global_df['raw_ovr'] *= (1 + playmaker_buff)

    # 언성 히어로 베테랑 보정 (정창영, 정희재 등)
    # 경기당 20분 이상 꾸준히 뛰면서 USG%가 16% 이하인 롤 플레이어(수비/궂은일)에게 OVR 보너스
    min_per_game = global_df['total_min'] / np.maximum(1, global_df['g'])
    unsung_hero_mask = (min_per_game >= 20.0) & (global_df['usage'] <= 16.0) & (global_df['total_min'] >= 600)
    global_df.loc[unsung_hero_mask, 'raw_ovr'] *= 1.08  # 약 8% 부스팅 (+2~3 OVR 효과)

    # 신인/1년차 할인
    global_df = global_df.sort_values(['pcode', 'season_name'])
    global_df['season_idx'] = global_df.groupby('pcode').cumcount() + 1
    global_df['experience_factor'] = np.minimum(1.0, 0.75 + 0.0625 * (global_df['season_idx'] - 1))
    global_df['raw_ovr'] *= global_df['experience_factor']

    # 가비지 타임 인플레이션 강력 철퇴 (민기남, 김건하 등)
    # 기존 SHRINK_MINUTES를 500분으로 상향하여, 출전 시간이 적은 선수의 raw 점수를 대폭 삭감
    SHRINK_MINUTES = 500
    global_df['w'] = global_df['total_min'] / (global_df['total_min'] + SHRINK_MINUTES)
    
    # 200분 미만 초저출전 선수는 추가 패널티 부여 (아무리 효율이 좋아도 로스터 끝자락)
    super_garbage_penalty = np.where(global_df['total_min'] < 200, 0.7, 1.0)
    global_df['raw_ovr'] *= (global_df['w'] * super_garbage_penalty)

    global_df = global_df.sort_values(by='raw_ovr')
    n = len(global_df)

    # 2K26 정규분포 비율을 정확히 반영한 앵커
    anchors = [
        (0.000, 60),
        (0.040, 69),
        (0.220, 74),
        (0.620, 79),
        (0.840, 84),
        (0.940, 89),
        (0.985, 94),
        (1.000, 99)
    ]

    def map_percentile(p):
        for k in range(len(anchors) - 1):
            p0, v0 = anchors[k]
            p1, v1 = anchors[k + 1]
            if p0 <= p <= p1:
                if p1 == p0: return v1
                return v0 + ((p - p0) / (p1 - p0)) * (v1 - v0)
        return anchors[-1][1]

    # Pandas의 rank(pct=True)를 이용해 인덱스 꼬임 없이 깔끔하게 백분위를 구하고 2K 스케일로 변환합니다.
    global_df['raw_ovr_mapped'] = global_df['raw_ovr'].rank(method='average', pct=True).apply(map_percentile)

    # 출전 시간이 극도로 적은 선수(가비지 타임 전용)는 백분위상 70점이 나오더라도
    # 신인 바닥치(53~58)로 강하게 끌어내립니다. (예: 이윤수 선수처럼 시즌 10~30분 뛴 경우)
    draft_ranks = load_draft_ranks()
    global_df['draft_rank_val'] = global_df['pcode'].map(draft_ranks)
    global_df['rookie_floor'] = global_df['draft_rank_val'].apply(rookie_floor_for)

    # 400분 미만일수록 rookie_floor 비중이 커짐. 400분 이상이면 100% 자기 실력(raw_ovr_mapped)
    # 0분이면 100% rookie_floor
    minutes_factor = np.clip(global_df['total_min'] / 400.0, 0.0, 1.0)
    global_df['raw_ovr_mapped'] = global_df['raw_ovr_mapped'] * minutes_factor + global_df['rookie_floor'] * (1.0 - minutes_factor)

    # 전설적인 99 보정 (역대 최상위 10명만 91~99로 강제 펼침) - 스무딩 전에 적용!
    LEGEND_COUNT = 10
    LEGEND_TOP = 99
    LEGEND_BOTTOM = 91
    # raw_ovr 순으로 상위 10명 추출 (동점자 처리 포함 안전하게 nlargest 사용)
    top_indices = global_df['raw_ovr'].nlargest(LEGEND_COUNT).index
    for rank, idx in enumerate(top_indices):
        t = rank / (LEGEND_COUNT - 1) if LEGEND_COUNT > 1 else 0
        global_df.loc[idx, 'raw_ovr_mapped'] = round(LEGEND_TOP - t * (LEGEND_TOP - LEGEND_BOTTOM))

    # OFF / DEF 세부 레이팅은 각각 독립적으로 백분위를 구해 2K 스케일(40~99)로 변환한 뒤,
    # 이 둘의 가중평균이 최종 OVR(raw_ovr_mapped)에 완벽히 수렴하도록 보정합니다.
    global_df['off_base'] = global_df['raw_off'].rank(method='average', pct=True).apply(map_percentile)
    global_df['def_base'] = global_df['raw_def'].rank(method='average', pct=True).apply(map_percentile)

    # 세부 속성 매핑
    global_df['outside_base'] = global_df['attr_outside'].rank(method='average', pct=True).apply(map_percentile)
    global_df['inside_base'] = global_df['attr_inside'].rank(method='average', pct=True).apply(map_percentile)
    global_df['playmaking_base'] = global_df['attr_playmaking'].rank(method='average', pct=True).apply(map_percentile)
    global_df['athletic_base'] = global_df['attr_athletic'].rank(method='average', pct=True).apply(map_percentile)
    global_df['defense_base'] = global_df['attr_defense'].rank(method='average', pct=True).apply(map_percentile)
    global_df['rebounding_base'] = global_df['attr_rebounding'].rank(method='average', pct=True).apply(map_percentile)

    global_df['ovr_base'] = (global_df['off_base'] * 0.55) + (global_df['def_base'] * 0.45)
    
    global_df['raw_off_mapped'] = global_df['off_base'] * (global_df['raw_ovr_mapped'] / global_df['ovr_base'])
    global_df['raw_def_mapped'] = global_df['def_base'] * (global_df['raw_ovr_mapped'] / global_df['ovr_base'])

    # 세부 속성도 똑같이 OVR에 맞춰 보정
    global_df['attr_outside_mapped'] = global_df['outside_base'] * (global_df['raw_ovr_mapped'] / global_df['ovr_base'])
    global_df['attr_inside_mapped'] = global_df['inside_base'] * (global_df['raw_ovr_mapped'] / global_df['ovr_base'])
    global_df['attr_playmaking_mapped'] = global_df['playmaking_base'] * (global_df['raw_ovr_mapped'] / global_df['ovr_base'])
    global_df['attr_athletic_mapped'] = global_df['athletic_base'] * (global_df['raw_ovr_mapped'] / global_df['ovr_base'])
    global_df['attr_defense_mapped'] = global_df['defense_base'] * (global_df['raw_ovr_mapped'] / global_df['ovr_base'])
    global_df['attr_rebounding_mapped'] = global_df['rebounding_base'] * (global_df['raw_ovr_mapped'] / global_df['ovr_base'])


    # ── 2. 시즌별 오버롤 스무딩 (OvrCurveModel) 적용 ──
    # 스무딩을 거치면 이제 등수가 밀려도 2K 스케일 값(45~99) 위에서 직접 방어된다.
    birth_years = load_birth_years()
    global_df['birth_year'] = global_df['pcode'].map(birth_years)
    global_df['start_year'] = global_df['season_name'].apply(parse_start_year)
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

    # ── 3차: 배지 및 빌드(Archetype) 산출 ────────────────────────────────
    def determine_archetype(row):
        pts = row['pts']
        reb = row['reb']
        ast = row['ast']
        stl = row['stl']
        blk = row['blk']
        tpm = row['tpm'] / max(1, row['g'])
        
        if pts >= 18 and ast >= 5: return "오펜시브 엔진"
        if ast >= 6: return "퓨어 플레이메이커"
        if reb >= 10 and tpm >= 1.5: return "스트레치 빅"
        if reb >= 10 and blk >= 1.5: return "림 프로텍터"
        if reb >= 9: return "글래스 클리너"
        if tpm >= 2.0 and (stl >= 1.2 or blk >= 0.8): return "3&D 윙"
        if tpm >= 2.5: return "샤프슈터"
        if pts >= 15 and tpm < 1.0: return "슬래셔"
        if row['DEF'] >= 85: return "락다운 디펜더"
        if pts >= 12: return "샷 크리에이터"
        if row['OVR'] >= 85: return "올어라운드 스렛"
        
        return "롤 플레이어"

    global_df['archetype'] = global_df.apply(determine_archetype, axis=1)

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
            floor = rookie_floor_for(draft_ranks.get(pcode))
            out_data.append({
                "pcode": pcode,
                "name": next_season_roster.get(pcode, {}).get("name", "Unknown"),
                "season": PROJECTION_SEASON,
                "team": next_season_roster.get(pcode, {}).get("team", "Unknown"),
                "position": positions.get(pcode, "Unknown"),
                "OVR": floor,
                "OFF": floor,
                "DEF": floor,
                "attributes": {
                    "outside": floor, "inside": floor, "playmaking": floor,
                    "athletic": floor, "defense": floor, "rebounding": floor
                },
                "archetype": "롤 플레이어",
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
                 "raw_performance": r[mapped_col], "play_style": play_style}
                for _, r in hist.iterrows()
            ]
            return model.project_forward(seasons, extra_years=1)

        proj_ovr = round(project_one('raw_ovr_mapped'))
        proj_off = round(project_one('raw_off_mapped'))
        proj_def = round(project_one('raw_def_mapped'))
        proj_outside = round(project_one('attr_outside_mapped'))
        proj_inside = round(project_one('attr_inside_mapped'))
        proj_playmaking = round(project_one('attr_playmaking_mapped'))
        proj_athletic = round(project_one('attr_athletic_mapped'))
        proj_defense = round(project_one('attr_defense_mapped'))
        proj_rebounding = round(project_one('attr_rebounding_mapped'))

        boost = PROJECTION_REPUTATION_BOOST.get(pcode)
        if boost:
            proj_ovr += boost['boost']
            proj_off += boost['boost']
            proj_def += boost['boost']
            proj_outside += boost['boost']
            proj_inside += boost['boost']
            proj_playmaking += boost['boost']
            proj_athletic += boost['boost']
            proj_defense += boost['boost']
            proj_rebounding += boost['boost']

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
