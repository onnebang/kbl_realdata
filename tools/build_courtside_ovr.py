import sqlite3
import pandas as pd
import numpy as np
import json
import os

DB_PATH = '../raw/kbl_realdata.db'
KBL540_PLAYERS_PATH = '../../kbl540/kbl540_players_public.json'
OUT_PATH = '../data/courtside_ovr.json'

# kleague38(SHRINK_GAMES=10 / 38경기 시즌 - build_kleague_cards.py)과 같은 비율(~26%)을
# KBL 정규시즌 54경기에 맞춘 값(2019-2020처럼 단축된 시즌도 있으나 다수 시즌은 54경기).
SHRINK_GAMES = 14


def age_curve(age):
    """
    kleague38/tools/apply_age_curve.py에서 착안한 나이 곡선 팩터. 농구는 25~30세가
    최전성기, 33세 이후 완만한 하강으로 설정.

    2026-09-17: kbl540_players_public.json의 birth_date를 pcode로 조인해서 실제 나이를
    구할 수 있게 됐다(courtside 쪽 원본 DB엔 생년월일이 없음 - kbl540과 kbl_realdata가
    같은 kbl.or.kr pcode를 공유한다는 걸 kbl540/tools/prepare_realdata_integration.py가
    이미 실측 확인해뒀다: 오마리 스펠맨이 두 데이터셋에 동일 pcode로 존재). 더 이상 죽은
    코드가 아니라 load_birth_years()로 채운 age 컬럼을 통해 실제로 호출된다.
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
    나이 곡선 보정 단계에서 쓰는 표본 신뢰도. 20경기 이상이면 그 시즌 실제 값을 거의
    그대로 존중한다 - kleague38/tools/apply_age_curve.py의 confidence()와 동일 취지
    (나이 곡선은 연 단위의 거친 기대치라, 표본이 확실한 시즌까지 억지로 끌어당기지 않는다).
    """
    return max(0.3, min(1.0, (g or 0) / 20.0))


def raw_shrink_weight(g):
    """
    raw 스탯 단계 표본 축소 가중치 - kleague38 build_kleague_cards.py의 shrink()와 같은
    g/(g+K) 쌍곡선(포화 없음). confidence()와 달리 100%에 도달하지 않아 풀시즌(54경기)도
    항상 약간(54/(54+14)=79%)은 전체 평균 쪽으로 당겨진다 - 표본이 많을수록 raw값을
    거의 그대로 쓰되, 몇 경기 안 뛴 시즌의 극단치를 완화하는 1차 방어선.
    """
    g = g or 0
    return g / (g + SHRINK_GAMES)


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

    # ── 1차: 표본 축소(raw 단계, 비포화) ────────────────────────────────────
    # kleague38과 같은 원칙 - 몇 경기 안 뛴 시즌의 raw per-game 평균 자체가 튀는 걸 전체
    # 평균 쪽으로 당겨서 완화한다. 나이/커리어와 무관하게 "표본이 작다"는 사실 하나만으로
    # 작동하는 1차 방어선(풀시즌도 21%는 항상 평균 쪽으로 당겨짐 - confidence()와 달리
    # 포화되지 않는다).
    global_df['w'] = global_df['g'].apply(raw_shrink_weight)
    ovr_mean = global_df['raw_ovr'].mean()
    off_mean = global_df['raw_off_norm'].mean()
    def_mean = global_df['raw_def_norm'].mean()
    global_df['ovr_shrunk'] = global_df['raw_ovr'] * global_df['w'] + ovr_mean * (1 - global_df['w'])
    global_df['off_shrunk'] = global_df['raw_off_norm'] * global_df['w'] + off_mean * (1 - global_df['w'])
    global_df['def_shrunk'] = global_df['raw_def_norm'] * global_df['w'] + def_mean * (1 - global_df['w'])

    # ── 2차: 나이 곡선 x 개인 피크 앵커 보정 ────────────────────────────────
    # kleague38/tools/apply_age_curve.py와 동일한 방식: 이 선수의 커리어 최고 기록(peak)에
    # 나이 곡선 비율을 곱해 "이 나이라면 대략 이 정도"인 기대치를 만들고, 표본이 적을수록
    # (confidence가 낮을수록) 그 기대치 쪽으로 당긴다. 기대치는 실제 peak를 절대 못 넘도록
    # 캡을 건다(전성기 곡선으로 역산해서 실제 최고 기록보다 부풀리는 걸 방지).
    #
    # 예전의 "공백 감지 -> 피크로 앵커링" 휴리스틱(parse_start_year 기반 return_trust)을
    # 대체한다 - 공백이든 부상이든 그냥 자연스러운 노쇠든, "이 나이의 이 선수에게
    # 기대되는 수준"이라는 하나의 기준으로 전부 같은 방식으로 흡수된다. 생년월일이 없는
    # 선수(kbl540 카드 풀에 없는 최근 신인 등)는 1차 축소 값을 그대로 쓴다.
    birth_years = load_birth_years()
    global_df['birth_year'] = global_df['pcode'].map(birth_years)
    global_df['start_year'] = global_df['season_name'].apply(parse_start_year)
    global_df['age'] = np.where(
        global_df['birth_year'].notna() & global_df['start_year'].notna(),
        global_df['start_year'] - global_df['birth_year'],
        np.nan,
    )
    global_df['conf'] = global_df['g'].apply(confidence)

    corrected_ovr = global_df['ovr_shrunk'].copy()
    corrected_off = global_df['off_shrunk'].copy()
    corrected_def = global_df['def_shrunk'].copy()

    matched_players = 0
    for pcode, group in global_df.groupby('pcode'):
        if len(group) < 2 or group['age'].isna().all():
            continue
        valid = group[group['age'].between(14, 46)]
        if len(valid) < 2:
            continue
        matched_players += 1

        peak_idx = valid['ovr_shrunk'].idxmax()
        peak_age = valid.loc[peak_idx, 'age']
        peak_curve = age_curve(peak_age) or 1.0
        peak_ovr = valid.loc[peak_idx, 'ovr_shrunk']
        peak_off = valid.loc[peak_idx, 'off_shrunk']
        peak_def = valid.loc[peak_idx, 'def_shrunk']

        for idx, row in valid.iterrows():
            curve = age_curve(row['age'])
            ratio = min(1.0, curve / peak_curve)
            conf = row['conf']
            corrected_ovr.loc[idx] = row['ovr_shrunk'] * conf + (peak_ovr * ratio) * (1 - conf)
            corrected_off.loc[idx] = row['off_shrunk'] * conf + (peak_off * ratio) * (1 - conf)
            corrected_def.loc[idx] = row['def_shrunk'] * conf + (peak_def * ratio) * (1 - conf)

    global_df['ovr_adj'] = corrected_ovr
    global_df['off_adj'] = corrected_off
    global_df['def_adj'] = corrected_def

    print(f"나이 곡선 보정 적용: {matched_players}명 (birth_date 매칭 {len(birth_years)}명 중)")

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
