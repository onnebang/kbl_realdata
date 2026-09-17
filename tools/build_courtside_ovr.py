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
        AVG(gps.per) as per,
        AVG(gps.netrtg) as net_rtg,
        AVG(gps.usg_rt) as usage,
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
    global_df['raw_off'] = (global_df['pts'] * 2.5) + (global_df['ast'] * 1.5) + (global_df['ts_pct'] * 10) + (global_df['per'] * 1.2)
    global_df['raw_def'] = (global_df['reb'] * 1.8) + (global_df['stl'] * 3.0) + (global_df['blk'] * 3.5) + (global_df['net_rtg'] * 0.5)

    # 정규화 (Min-Max Scaling based on GLOBAL min/max)
    off_min, off_max = global_df['raw_off'].min(), global_df['raw_off'].max()
    def_min, def_max = global_df['raw_def'].min(), global_df['raw_def'].max()

    global_df['raw_off_norm'] = 40 + ((global_df['raw_off'] - off_min) / (off_max - off_min)) * 59
    global_df['raw_def_norm'] = 40 + ((global_df['raw_def'] - def_min) / (def_max - def_min)) * 59
    global_df['raw_ovr'] = (global_df['raw_off_norm'] * 0.55) + (global_df['raw_def_norm'] * 0.45)

    # ── 시즌별 오버롤 스무딩: 최근 3시즌 가중평균 + 나이 곡선 + 슈퍼스타 방어 ──────────
    # tools/ovr_curve_model.py의 OvrCurveModel(2K/FC류 게임 오버롤 곡선 설계, 사용자 요청으로
    # 설계) 그대로 재사용한다. 예전의 "raw 표본 축소 + 나이 곡선 피크 앵커" 두 겹을 이
    # 모델 하나로 대체한다 - 3시즌 가중평균이 표본 축소 역할을, 슈퍼스타 방어(한 번이라도
    # 90 이상을 찍으면 이후 하락 저항력 부여)가 피크 앵커 역할을 대신한다.
    birth_years = load_birth_years()
    global_df['birth_year'] = global_df['pcode'].map(birth_years)
    global_df['start_year'] = global_df['season_name'].apply(parse_start_year)
    global_df['age'] = np.where(
        global_df['birth_year'].notna() & global_df['start_year'].notna(),
        global_df['start_year'] - global_df['birth_year'],
        np.nan,
    )
    # 나이를 모르는 선수는 NEUTRAL_AGE(전성기 한복판)로 채운다 - 나이 보정 없이 3시즌
    # 가중평균만 적용되게 하기 위함(생년월일 없다고 스무딩 자체를 건너뛰지 않는다).
    global_df['age_for_model'] = global_df['age'].fillna(NEUTRAL_AGE)

    model = OvrCurveModel()
    corrected_ovr = pd.Series(index=global_df.index, dtype=float)
    corrected_off = pd.Series(index=global_df.index, dtype=float)
    corrected_def = pd.Series(index=global_df.index, dtype=float)

    for pcode, group in global_df.groupby('pcode'):
        group = group.sort_values('season_name')
        idxs = group.index.tolist()
        for raw_col, out_series in (
            ('raw_ovr', corrected_ovr), ('raw_off_norm', corrected_off), ('raw_def_norm', corrected_def)
        ):
            seasons = [
                {
                    "season": group.loc[i, 'season_name'],
                    "age": int(group.loc[i, 'age_for_model']),
                    "raw_performance": group.loc[i, raw_col],
                }
                for i in idxs
            ]
            for i, r in zip(idxs, model.process_player(seasons)):
                out_series.loc[i] = r["calculated_ovr"]

    global_df['ovr_adj'] = corrected_ovr
    global_df['off_adj'] = corrected_off
    global_df['def_adj'] = corrected_def

    total_players = global_df['pcode'].nunique()
    age_known_players = global_df.loc[global_df['age'].notna(), 'pcode'].nunique()
    print(f"오버롤 스무딩 적용: 전체 {total_players}명 (나이 곡선까지 반영된 선수 {age_known_players}명, birth_date 매칭 {len(birth_years)}명 중)")

    # 2. kbl540의 앵커 매핑 방식 (Piecewise-linear based on historical quantiles)
    # 전체 역사적 분포에서 등수를 구함
    global_df = global_df.sort_values(by='ovr_adj')
    n = len(global_df)

    anchors = [
        (0.000, 45), (0.010, 50), (0.010, 51), (0.350, 64), (0.350, 65),
        (0.800, 74), (0.800, 75), (0.950, 82), (0.950, 83), (0.990, 88),
        (0.990, 89), (1.000, 91)
    ]

    def map_percentile(p):
        for k in range(len(anchors) - 1):
            p0, v0 = anchors[k]
            p1, v1 = anchors[k + 1]
            if p0 <= p <= p1:
                if p1 == p0: return v1
                return v0 + ((p - p0) / (p1 - p0)) * (v1 - v0)
        return anchors[-1][1]

    # Thresholds for TypeScript
    print("\n--- OVR Thresholds for TypeScript ---")
    for p, _ in anchors:
        if p == 0: continue
        val = global_df['ovr_adj'].quantile(p)
        print(f"p={p:.3f} -> raw={val:.3f}")
    print("-------------------------------------\n")

    # 글로벌 전체 선수에 대해 새 레이팅 부여
    new_ratings = [None] * n
    for rank, idx in enumerate(global_df.index):
        p = (rank + 0.5) / n
        new_ratings[idx] = map_percentile(p)

    global_df['OVR'] = pd.Series(new_ratings, index=global_df.index)

    # 전설적인 99 보정 (역대 최상위 10명만 91~99로 강제 펼침)
    LEGEND_COUNT = 10
    LEGEND_TOP = 99
    LEGEND_BOTTOM = 91
    top_indices = global_df.index[-LEGEND_COUNT:]
    for rank, idx in enumerate(reversed(top_indices)):
        t = rank / (LEGEND_COUNT - 1) if LEGEND_COUNT > 1 else 0
        global_df.loc[idx, 'OVR'] = round(LEGEND_TOP - t * (LEGEND_TOP - LEGEND_BOTTOM))

    # OFF / DEF 세부 레이팅은 OVR 스케일링 비율에 맞춰 동일하게 곱함
    global_df['OVR'] = global_df['OVR'].round().astype(int)
    global_df['scale_ratio'] = np.where(global_df['ovr_adj'] > 0, global_df['OVR'] / global_df['ovr_adj'], 1.0)

    global_df['OFF'] = (global_df['off_adj'] * global_df['scale_ratio']).round().astype(int)
    global_df['DEF'] = (global_df['def_adj'] * global_df['scale_ratio']).round().astype(int)

    # OVR 상한/하한
    global_df['OVR'] = global_df['OVR'].clip(40, 99)
    global_df['OFF'] = global_df['OFF'].clip(40, 99)
    global_df['DEF'] = global_df['DEF'].clip(40, 99)

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

    for _, row in global_df.iterrows():
        out_data.append({
            "pcode": row['pcode'],
            "name": row['name'],
            "season": row['season_name'],
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
