import sqlite3
import pandas as pd
import numpy as np
import json
import os

DB_PATH = '../raw/kbl_realdata.db'
OUT_PATH = '../data/courtside_ovr.json'

def age_curve(age):
    """
    kleague38에서 착안한 나이 곡선 팩터. 농구는 25~30세가 최전성기, 33세 이후 완만한 하강으로 설정.

    2026-09-16 확인: 현재 compute_ovr()에서 이 함수를 호출하는 곳이 없다(죽은 코드) - players
    테이블에 생년월일이 없어서(pcode/name/ename/photo_url뿐) 애초에 age를 구할 방법이 없었다.
    공백-복귀 시즌 보정은 대신 시즌 공백 감지 방식(아래 return_trust)으로 구현했다. 나중에
    생년월일 데이터가 들어오면 이 함수를 실제로 연결해 나이 기반 보정으로 바꿀 수 있다.
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

    # 선수별로 시간순(과거 -> 최신)으로 정렬하여 EMA 계산
    global_df = global_df.sort_values(by=['pcode', 'season_name'])

    prior_ovr = pd.Series(index=global_df.index, dtype=float)
    prior_off = pd.Series(index=global_df.index, dtype=float)
    prior_def = pd.Series(index=global_df.index, dtype=float)

    for pcode, group in global_df.groupby('pcode'):
        # 리그 신인/첫 시즌은 평균(70.0)에서 시작
        ema_ovr = 70.0
        ema_off = 70.0
        ema_def = 70.0
        
        g_prior_ovr = []
        g_prior_off = []
        g_prior_def = []
        
        for idx, row in group.iterrows():
            g_prior_ovr.append(ema_ovr)
            g_prior_off.append(ema_off)
            g_prior_def.append(ema_def)
            
            conf = confidence(row['g'])
            season_perf_ovr = row['raw_ovr'] * conf + ema_ovr * (1 - conf)
            season_perf_off = row['raw_off_norm'] * conf + ema_off * (1 - conf)
            season_perf_def = row['raw_def_norm'] * conf + ema_def * (1 - conf)
            
            if len(g_prior_ovr) == 1:
                ema_ovr = season_perf_ovr
                ema_off = season_perf_off
                ema_def = season_perf_def
            else:
                ema_ovr = ema_ovr * 0.5 + season_perf_ovr * 0.5
                ema_off = ema_off * 0.5 + season_perf_off * 0.5
                ema_def = ema_def * 0.5 + season_perf_def * 0.5

        prior_ovr.loc[group.index] = g_prior_ovr
        prior_off.loc[group.index] = g_prior_off
        prior_def.loc[group.index] = g_prior_def

    global_df['prior_ovr'] = prior_ovr
    global_df['prior_off'] = prior_off
    global_df['prior_def'] = prior_def

    # 보정 로직 (경기수 곡선 회귀) - 리그 평균 대신 개별 EMA Prior 사용
    global_df['conf'] = global_df['g'].apply(confidence)
    global_df['ovr_adj'] = global_df['raw_ovr'] * global_df['conf'] + global_df['prior_ovr'] * (1 - global_df['conf'])
    global_df['off_adj'] = global_df['raw_off_norm'] * global_df['conf'] + global_df['prior_off'] * (1 - global_df['conf'])
    global_df['def_adj'] = global_df['raw_def_norm'] * global_df['conf'] + global_df['prior_def'] * (1 - global_df['conf'])

    # ── 공백(군 복무·부상 등) 복귀 시즌 보정 ────────────────────────────────────────
    # 제보: "80 -> 53 -> 81" 같은 복귀 시즌 급락이 실제 흐름과 안 맞음. 원인은
    # confidence(g)가 20경기에서 이미 1.0으로 포화돼서, 복귀 시즌에 그 정도만 뛰어도
    # (재적응기라 원래 기량보다 낮게 나오는 게 정상인데도) 위 EMA 보정을 사실상 건너뛰고
    # 그 시즌 raw 값을 그대로 반영해버리는 것 - 표본 크기와 "복귀 직후라 신뢰하면 안 됨"은
    # 서로 다른 문제인데 confidence() 하나로 뭉뚱그려져 있었다.
    #
    # kleague38/tools/apply_age_curve.py의 방식(선수 개인의 커리어 피크에 앵커링하고,
    # 신뢰도가 낮을수록 그 피크 쪽으로 세게 당김 - 리그 평균이나 하락하는 이동평균이 아니라
    # "이 선수라면 원래 이 정도"인 개인 기준)을 참고했다. 다만 그쪽은 생년월일 기반 나이
    # 곡선을 쓰는데 이 DB의 players 테이블엔 생년월일이 없다(pcode/name/ename/photo_url뿐,
    # 2026-09-16 확인) - 나이 대신 "시즌 문자열 공백"을 궤적의 근거로 쓴다: 공백 직전
    # 신뢰도 높은(conf>=0.7) 시즌들 중 최고 기록을 그 선수의 피크로 잡고, 공백 후 첫
    # 1~2시즌은 그 피크 쪽으로 당긴 뒤 3번째 시즌부터 기존 EMA 신뢰도로 되돌린다. 공백이
    # 길수록(2시즌 이상 = 병역 등) 더 세게 당긴다.
    def parse_start_year(season_name):
        try:
            return int(str(season_name).split('-')[0])
        except (ValueError, IndexError):
            return None

    def return_trust(seasons_since_gap, gap_len):
        """공백 이후 몇 시즌째인지에 따른 신뢰도. gap_len<=0(공백 없음)이면 항상 1.0 -
        기존 EMA 신뢰도(conf)를 그대로 쓴다는 뜻."""
        if gap_len <= 0:
            return 1.0
        base = 0.35 if gap_len >= 2 else 0.55
        return min(1.0, base + 0.3 * seasons_since_gap)

    corrected_ovr = global_df['ovr_adj'].copy()
    corrected_off = global_df['off_adj'].copy()
    corrected_def = global_df['def_adj'].copy()

    for pcode, group in global_df.groupby('pcode'):
        group = group.sort_values('season_name')
        prev_year = None
        last_gap_len = 0
        seasons_since_gap = 99  # 공백을 겪은 적 없으면 큰 값 -> return_trust가 1.0 반환
        peak_ovr = peak_off = peak_def = None
        for idx, row in group.iterrows():
            year = parse_start_year(row['season_name'])
            if prev_year is not None and year is not None:
                gap_len = max(0, year - prev_year - 1)
                if gap_len > 0:
                    last_gap_len = gap_len
                    seasons_since_gap = 0
                else:
                    seasons_since_gap = min(seasons_since_gap + 1, 99)
            if year is not None:
                prev_year = year

            trust = return_trust(seasons_since_gap, last_gap_len)
            if trust < 1.0 and peak_ovr is not None:
                corrected_ovr.loc[idx] = row['ovr_adj'] * trust + peak_ovr * (1 - trust)
                corrected_off.loc[idx] = row['off_adj'] * trust + peak_off * (1 - trust)
                corrected_def.loc[idx] = row['def_adj'] * trust + peak_def * (1 - trust)

            # 표본이 확실한(conf>=0.7) 시즌만 향후 피크 후보로 - 확정된(보정 반영된) 값을 씀.
            if row['conf'] >= 0.7:
                cand = corrected_ovr.loc[idx]
                if peak_ovr is None or cand > peak_ovr:
                    peak_ovr = cand
                    peak_off = corrected_off.loc[idx]
                    peak_def = corrected_def.loc[idx]

    global_df['ovr_adj'] = corrected_ovr
    global_df['off_adj'] = corrected_off
    global_df['def_adj'] = corrected_def

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
