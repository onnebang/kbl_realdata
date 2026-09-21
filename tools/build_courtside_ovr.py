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

# 평판 가산 가중치(수상 id -> 1회당 OVR 가산). 회당 값은 예전 calculate_reputation_boost와 같고, 시즌 인지형으로
# 바뀌면서 dpoy·allstar_mvp만 새로 넣었다(둘 다 스탯에 다 안 잡히는 "그 해의 얼굴" 신호인데 빠져 있었음).
REPUTATION_WEIGHTS = {
    'regular_mvp': 1.5, 'po_mvp': 1.0, 'dpoy': 1.0, 'champ': 0.5, 'allstar_mvp': 0.5,
    'month_mvp': 0.2, 'round_mvp': 0.1, 'allstar': 0.1,
}
NATIONAL_TEAM_WEIGHT = 0.3  # nt_* 대회 1회당
REPUTATION_CAP = 5.0

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
        AVG(gps.ast_rt) as ast_rt, AVG(gps.ast_to) as ast_to,
        AVG(gps.oreb_rt) as oreb_rt, AVG(gps.dreb_rt) as dreb_rt, AVG(gps.tov_rt) as tov_rt,
        SUM(gps.defrtg * (gps.play_min + gps.play_sec/60.0)) / SUM(gps.play_min + gps.play_sec/60.0) as def_rtg,
        AVG(CASE WHEN gps.tcode = g.home_tcode THEN g.home_score - g.away_score ELSE g.away_score - g.home_score END) as margin,
        AVG(CASE WHEN (CASE WHEN gps.tcode = g.home_tcode THEN g.home_score - g.away_score ELSE g.away_score - g.home_score END) > 0 THEN 1.0 ELSE 0.0 END) as win_pct
    FROM player_game_stats gps
    JOIN games g ON gps.gmkey = g.gmkey
    WHERE g.season_category IN ('정규시즌', '플레이오프', '챔프전')
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
    global_df['tov_per75'] = (global_df['tov'] / global_df['total_possessions']) * 75
    
    global_df['tpm_per75'] = (global_df['tpm'] / global_df['total_possessions']) * 75
    global_df['ftm_per75'] = (global_df['ftm'] / global_df['total_possessions']) * 75
    global_df['paint_pts_per75'] = (global_df['total_paint_pts'] / global_df['total_possessions']) * 75
    global_df['dkm_per75'] = (global_df['dkm'] / global_df['total_possessions']) * 75
    global_df['fb_pts_per75'] = (global_df['total_fb_pts'] / global_df['total_possessions']) * 75
    global_df['sast_per75'] = (global_df['total_sast'] / global_df['total_possessions']) * 75
    global_df['dfl_per75'] = (global_df['total_dfl'] / global_df['total_possessions']) * 75
    global_df['offr_per75'] = (global_df['total_offr'] / global_df['total_possessions']) * 75
    global_df['defr_per75'] = (global_df['total_defr'] / global_df['total_possessions']) * 75

    # 효율성 지표
    global_df['threep_pct'] = np.where(global_df['tpa'] > 0, global_df['tpm'] / global_df['tpa'], 0)
    global_df['fg_pct'] = np.where(global_df['fga'] > 0, global_df['fgm'] / global_df['fga'], 0)
    global_df['ft_pct'] = np.where(global_df['fta'] > 0, global_df['ftm'] / global_df['fta'], 0)
    global_df['ft_rate'] = np.where(global_df['fga'] > 0, global_df['fta'] / global_df['fga'], 0)

    # 1. Outside Scoring
    # 볼륨(tpm_per75)에 효율(3P%)을 가중치로 부여. TS% 추가. 턴오버 치명적 페널티(Multiplier)
    tov_multiplier = np.maximum(0.3, 1.0 - (global_df['tov_per75'] / 8.0)) # 턴오버 4개면 50% 타격
    global_df['attr_outside'] = ((global_df['tpm_per75'] * 4.0 * (global_df['threep_pct'] / 0.33)) + (global_df['ts_pct'] * 30.0) + (global_df['ftm_per75'] * 1.5 * global_df['ft_pct'])) * tov_multiplier
    
    # 2. Inside Scoring
    # 핵어샤크 방지 (자유투 기하급수 페널티 Multiplier) 및 턴오버 치명적 페널티 부여
    ft_penalty_multiplier = np.where(global_df['fta'] > 0, np.maximum(0.2, (global_df['ft_pct']**3) / 0.3), 1.0)
    global_df['attr_inside'] = ((global_df['paint_pts_per75'] * 2.0 * (global_df['fg_pct'] / 0.5)) + (global_df['dkm_per75'] * 5.0) + (global_df['ft_rate'] * 20.0)) * tov_multiplier * ft_penalty_multiplier
    
    # 3. Playmaking
    # 무리한 턴오버(tov_per75)를 강하게 페널티 부여
    global_df['attr_playmaking'] = (global_df['ast_per75'] * 3.0) + (global_df['sast_per75'] * 2.0) + (global_df['ast_to'] * 5.0) + (global_df['ast_rt'] * 0.2) - (global_df['tov_per75'] * 3.0)
    
    # 4. Athleticism
    global_df['attr_athletic'] = (global_df['fb_pts_per75'] * 3.0) + (global_df['total_min'] / max(1, global_df['g'].max()) * 0.5) + (global_df['blk_per75'] * 5.0) + (global_df['stl_per75'] * 5.0)
    
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
    
    # ── 하드코딩 예외 처리 (특정 선수의 태업/비효율 극강 보정) ──
    # 오누아쿠: 23-24시즌 이후 태업 및 비효율 극강으로 인한 강제 페널티 부여
    def apply_onuaku_final_penalty(row):
        val = row['OVR']
        if '오누아쿠' in str(row['name']) and str(row['season_name']) >= '2023-2024':
            val -= 5.0 # 강제 -5 페널티
        return val

    onuaku_capped = global_df.apply(apply_onuaku_final_penalty, axis=1)
    diff += (onuaku_capped - global_df['OVR'])
    global_df['OVR'] = onuaku_capped
    
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
