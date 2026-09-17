import sys
import sqlite3
import pandas as pd
import numpy as np
import json
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ovr_curve_model import OvrCurveModel

DB_PATH = '../raw/kbl_realdata.db'
KBL540_PLAYERS_PATH = '../../kbl540/kbl540_players_public.json'
OUT_PATH = '../data/courtside_ovr.json'

# 나이를 모르는 선수(kbl540 카드 풀에 없는 최근 신인 등)에게 줄 중립 나이 - 전성기
# 한복판이라 OvrCurveModel의 나이 보정 배율이 정확히 1.0(보너스도 페널티도 없음)이라서,
# 3시즌 가중평균만 적용되고 나이 곡선 자체는 사실상 안 걸리는 효과를 낸다.
NEUTRAL_AGE = 26


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
        SUM(gps.ft) as ftm, SUM(gps.ft_a) as fta
    FROM player_game_stats gps
    JOIN games g ON gps.gmkey = g.gmkey
    WHERE g.season_category IN ('정규시즌', '플레이오프', '챔프전')
    GROUP BY gps.pcode, g.season_name
    HAVING total_min > 50
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
    global_df['raw_def'] = (global_df['reb'] * 1.8) + (global_df['stl'] * 3.0) + (global_df['blk'] * 3.5) + (global_df['net_rtg'] * 0.5)

    # ── 1. 1차 매핑: 백분위 기반으로 2K 스케일 (45~99) 부여 ──
    # 원본 스탯(raw_ovr)을 구한 뒤, 국내 선수에게 버프를 주고 전체 줄을 세워 스케일링합니다.
    global_df['raw_ovr'] = (global_df['raw_off'] * 0.55) + (global_df['raw_def'] * 0.45)
    
    # 국내 선수 보정 (Domestic Buff)
    nats = load_nationalities()
    global_df['nationality'] = global_df['pcode'].map(nats)
    # 국적이 대한민국이거나 널(신인 등 못 불러왔지만 보통 국내)이면 15% 가중치
    is_domestic = global_df['nationality'].fillna('대한민국').str.contains('대한민국|한국')
    global_df.loc[is_domestic, 'raw_ovr'] *= 1.15

    SHRINK_MINUTES = 300
    global_df['w'] = global_df['total_min'] / (global_df['total_min'] + SHRINK_MINUTES)
    global_df['raw_ovr'] *= global_df['w']

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

    global_df['ovr_base'] = (global_df['off_base'] * 0.55) + (global_df['def_base'] * 0.45)
    
    global_df['raw_off_mapped'] = global_df['off_base'] * (global_df['raw_ovr_mapped'] / global_df['ovr_base'])
    global_df['raw_def_mapped'] = global_df['def_base'] * (global_df['raw_ovr_mapped'] / global_df['ovr_base'])

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
            ('raw_def_mapped', corrected_def)
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

    for _, row in global_df.iterrows():
        out_data.append({
            "pcode": row['pcode'],
            "name": row['name'],
            "season": row['season_name'],
            "team": teams.get(row['pcode'], "Unknown"),
            "position": positions.get(row['pcode'], "Unknown"),
            "OVR": int(row['OVR']),
            "OFF": int(row['OFF']),
            "DEF": int(row['DEF']),
            "archetype": row['archetype'],
            "badges": row['badges']
        })

    OUT_PATH = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_ovr_history.json')
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out_data, f, ensure_ascii=False, indent=2)

    # Windows에서 이모지 출력 시 cp949 인코딩 오류 방지
    print(f"[SUCCESS] Generated {len(out_data)} historical OVR records at {OUT_PATH}")


if __name__ == "__main__":
    compute_ovr()
