"""
Shot Quality vs Actual (xPTS) - 로드맵 03단계 마지막 항목, "미니 모델링 프로젝트"로 분류된 것
(2026-08-24). 슛차트(match-chart.json의 shootLog) x/y 좌표로 존별 기대성공률 테이블을 만들고,
"이 선수가 실제로 넣은 점수가 그 난이도의 슛들이면 평균적으로 몇 점 나와야 하는지"보다 얼마나
높은/낮은지(xPTS 델타)를 계산한다.

## 좌표계 보정 (직접 역산, 공식 문서 없음)
문자중계와 달리 슛차트엔 코트 절반이 아니라 **풀코트** 좌표가 그대로 들어있음(x 30~720,
y 27~384 - 가로세로 비율 690:357 ≈ 1.93, FIBA 코트 28m:15m ≈ 1.87와 거의 일치). `d` 필드는
2점/3점 구분이 아니라 **어느 골대 쪽인지**(전반/후반 코트 스위치로 팀마다 절반씩 갈림, 표본
50만개 기준 "1"/"2"가 정확히 절반씩 나뉨) - 처음엔 슛타입 플래그로 오해할 뻔했다가 값 분포 보고
정정함.

골대 위치는 FIBA 규정(베이스라인에서 1.575m 안쪽, 코트 폭 중앙)으로 역산: 오른쪽 골대
(x≈681, y≈205), 왼쪽 골대(x≈69, y≈205). 스케일은 690유닛=28m, 357유닛=15m 평균으로
0.0413m/유닛.

**검증**: 이 골대좌표+스케일로 골대까지 거리 6.75m(FIBA 3점슛 라인, 코너 보정은 안 함 - 단순화)
이상인 슛을 3점으로 분류해서 세어보니, 500경기 샘플에서 **기하학적 분류 3점시도 합계 17,753개
vs 박스스코어 실제 3점시도 합계 17,402개 (오차 +2.0%)**, 전체 슛 개수도 박스스코어 FGA 대비
-0.6% - 좌표계/골대위치/스케일 추정이 실제로 맞다는 강한 증거.

## 존 정의 (거리만 사용, 각도는 안 씀 - "미니" 프로젝트 스코프 유지)
골대까지 거리(m) 기준 5구간: 림(0~1.2), 근거리(1.2~3), 중거리-단(3~5), 중거리-장(5~6.75), 3점(6.75+).
코너3/탑3 구분처럼 각도 기반 세분화는 안 함 - 실제 성공률이 위치별로 더 갈릴 수 있지만, 그건
다음 단계 확장 여지로 남겨둠(docstring에 명시).

## xPTS 계산
리그 전체(15시즌) 존별 성공률 테이블을 한 번 만들고(리그 평균 성공률 x 그 존의 슛가치(2/3점)
= 그 존에서 슛 하나당 "기대 득점"), 선수별로 실제 득점(성공한 슛 x 가치 합) vs 기대 득점(시도한
슛마다 그 존의 기대득점 합)을 비교. **이건 예측 피처가 아니라 사후 서술 통계**라 그 경기
이전/이후 가리는 leak-free 원칙이 적용 안 됨(전체 15시즌 평균 존 테이블을 그대로 다 씀 -
연봉/스카우팅 리포트에서 쓰는 "이 선수가 슛 난이도 대비 얼마나 잘 넣었나" 지표와 같은 용도).
"""
import json
import math
import os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
ZONE_TABLE_OUT = os.path.join(ANALYSIS_DIR, "xpts_zone_table.json")
LEADERBOARD_OUT = os.path.join(ANALYSIS_DIR, "xpts_leaderboard.json")

HOOP_LEFT = (69, 205)
HOOP_RIGHT = (681, 205)
SCALE_M_PER_UNIT = 0.0413
THREE_PT_M = 6.75

ZONE_BOUNDS = [
    ("rim", 0.0, 1.2),
    ("close", 1.2, 3.0),
    ("midShort", 3.0, 5.0),
    ("midLong", 5.0, THREE_PT_M),
    ("three", THREE_PT_M, 999.0),
]


def shot_distance_m(x, y, d):
    hx, hy = HOOP_RIGHT if d == "1" else HOOP_LEFT
    return math.hypot(x - hx, y - hy) * SCALE_M_PER_UNIT


def classify(x, y, d):
    dist = shot_distance_m(x, y, d)
    value = 3 if dist >= THREE_PT_M else 2
    for name, lo, hi in ZONE_BOUNDS:
        if lo <= dist < hi:
            return name, value
    return "three", value


def iter_shots():
    for gmkey in sorted(os.listdir(GAMES_DIR)):
        path = os.path.join(GAMES_DIR, gmkey, "match-chart.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            chart = json.load(f)
        sl = chart.get("shootLog", [])
        if not sl:
            continue
        for player in sl:
            pcode, pname, tcode = player["pcode"], player["pname"], player["tcode"]
            for log in player["logs"]:
                zone, value = classify(log["x"], log["y"], log["d"])
                made = log["o"] == "O"
                yield gmkey, pcode, pname, tcode, zone, value, made


def main():
    zone_stats = defaultdict(lambda: {"attempts": 0, "makes": 0, "value": None})
    n_shots = 0

    print("1차 패스: 리그 전체 존별 성공률 테이블 계산 중...", flush=True)
    all_shots = []
    for gmkey, pcode, pname, tcode, zone, value, made in iter_shots():
        zs = zone_stats[zone]
        zs["attempts"] += 1
        zs["value"] = value
        if made:
            zs["makes"] += 1
        all_shots.append((pcode, pname, tcode, zone, value, made))
        n_shots += 1
        if n_shots % 200000 == 0:
            print(f"  {n_shots}개 슛 처리...", flush=True)

    zone_table = {}
    for zone, zs in zone_stats.items():
        fg_pct = zs["makes"] / zs["attempts"] if zs["attempts"] else 0.0
        zone_table[zone] = {
            "attempts": zs["attempts"], "makes": zs["makes"], "fgPct": round(fg_pct, 4),
            "shotValue": zs["value"], "expectedPtsPerShot": round(fg_pct * zs["value"], 4),
        }

    zone_order = [z[0] for z in ZONE_BOUNDS]
    print(f"\n총 {n_shots}개 슛, 존별 성공률(리그 전체 15시즌):", flush=True)
    for zone in zone_order:
        zt = zone_table.get(zone)
        if zt:
            print(f"  {zone:<10} FG% {zt['fgPct']*100:5.1f}%  (시도 {zt['attempts']}, {zt['shotValue']}점슛)", flush=True)

    os.makedirs(ANALYSIS_DIR, exist_ok=True)
    with open(ZONE_TABLE_OUT, "w", encoding="utf-8") as f:
        json.dump(zone_table, f, ensure_ascii=False, indent=1)
    print(f"-> {ZONE_TABLE_OUT}", flush=True)

    print("\n2차 패스: 선수별 실제득점 vs 기대득점(xPTS) 집계 중...", flush=True)
    player_agg = defaultdict(lambda: {"attempts": 0, "actualPts": 0.0, "expectedPts": 0.0})
    for pcode, pname, tcode, zone, value, made in all_shots:
        key = (pcode, pname, tcode)
        a = player_agg[key]
        a["attempts"] += 1
        if made:
            a["actualPts"] += value
        a["expectedPts"] += zone_table[zone]["expectedPtsPerShot"]

    leaderboard = []
    for (pcode, pname, tcode), a in player_agg.items():
        if a["attempts"] < 200:
            continue
        delta = a["actualPts"] - a["expectedPts"]
        leaderboard.append({
            "pcode": pcode, "player": pname, "tcode": tcode, "attempts": a["attempts"],
            "actualPts": round(a["actualPts"], 1), "expectedPts": round(a["expectedPts"], 1),
            "xptsDelta": round(delta, 1),
            "xptsDeltaPer100Shots": round(delta / a["attempts"] * 100, 2),
        })
    leaderboard.sort(key=lambda x: -x["xptsDeltaPer100Shots"])

    with open(LEADERBOARD_OUT, "w", encoding="utf-8") as f:
        json.dump(leaderboard, f, ensure_ascii=False, indent=1)
    print(f"xPTS 리더보드(통산 200회 이상 시도) {len(leaderboard)}명 -> {LEADERBOARD_OUT}", flush=True)
    print("  슛 난이도 대비 가장 잘 넣은 선수 top 5 (100회당 xPTS델타):", flush=True)
    for r in leaderboard[:5]:
        print(f"    {r['player']} +{r['xptsDeltaPer100Shots']} (실제 {r['actualPts']} vs 기대 {r['expectedPts']}, {r['attempts']}회)", flush=True)
    print("  가장 저조한 선수 bottom 5:", flush=True)
    for r in leaderboard[-5:]:
        print(f"    {r['player']} {r['xptsDeltaPer100Shots']} (실제 {r['actualPts']} vs 기대 {r['expectedPts']}, {r['attempts']}회)", flush=True)


if __name__ == "__main__":
    main()
