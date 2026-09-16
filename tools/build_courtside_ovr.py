import sqlite3
import pandas as pd
import numpy as np
import json
import os

DB_PATH = '../raw/kbl_realdata.db'
OUT_PATH = '../data/courtside_ovr.json'

def age_curve(age):
    """
    kleague38에서 착안한 나이 곡선 팩터.
    농구는 25~30세가 최전성기, 33세 이후 완만한 하강으로 설정.
    """
    if pd.isna(age) or age is None:
        return 1.0
    
    ramp_start = 19
    peak_lo, peak_hi = 25, 30
    
    if age <= ramp_start: return 0.80
    if age < peak_lo: return 0.80 + (1.0 - 0.80) * (age - ramp_start) / (peak_lo - ramp_start)
    if age <= peak_hi: return 1.0
    return max(0.65, 1.0 - 0.05 * (age - peak_hi))

def confidence(g):
    """
    표본(경기 수)에 따른 신뢰도 가중치. 
    20경기 이상이면 실제 스탯을 100% 신뢰.
    """
    return max(0.3, min(1.0, g / 20.0))

def compute_ovr(target_season='2024-2025'):
    if not os.path.exists(DB_PATH):
        print(f"Error: DB not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    
    # 1. 전체 시즌(역대 기록) 모든 선수의 스탯을 조회하여 "역사적 정규분포"를 구한다.
    global_query = """
    SELECT 
        p.pcode, p.pname as name, g.season_name,
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
    JOIN (SELECT DISTINCT pcode, pname FROM player_game_stats) p ON gps.pcode = p.pcode
    WHERE g.season_category = '정규시즌'
    GROUP BY p.pcode, p.pname, g.season_name
    HAVING total_min > 50
    """
    
    try:
        global_df = pd.read_sql_query(global_query, conn)
    except Exception as e:
        print(f"DB Query failed: {e}")
        conn.close()
        return
        
    conn.close()

    if global_df.empty:
        print("No historical data found in DB.")
        return

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

    # 보정 로직 (경기수 곡선 회귀)
    league_avg = 70.0
    global_df['conf'] = global_df['g'].apply(confidence)
    global_df['ovr_adj'] = global_df['raw_ovr'] * global_df['conf'] + league_avg * (1 - global_df['conf'])
    global_df['off_adj'] = global_df['raw_off_norm'] * global_df['conf'] + league_avg * (1 - global_df['conf'])
    global_df['def_adj'] = global_df['raw_def_norm'] * global_df['conf'] + league_avg * (1 - global_df['conf'])

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
            "DEF": int(row['DEF'])
        })

    OUT_PATH = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_ovr_history.json')
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out_data, f, ensure_ascii=False, indent=2)

    # Windows에서 이모지 출력 시 cp949 인코딩 오류 방지
    print(f"[SUCCESS] Generated {len(out_data)} historical OVR records at {OUT_PATH}")

if __name__ == "__main__":
    compute_ovr()
