"""
폼 지수(Form Index) - 2026-08-25, 사용자 제안: "선수별 최근 5경기 xPts 대비 실제 득점".

build_xpts_shot_quality.py가 이미 만든 리그 전체 존별 기대득점 테이블(xpts_zone_table.json)과
좌표 분류 로직(classify)을 그대로 재사용 - 다른 점은 "통산 전체"가 아니라 "이 시즌 마지막
5경기"로 창을 좁히는 것. 실제 득점(성공한 슛 x 가치의 합) - 기대득점(시도한 슛마다 그 존의
기대득점 합)이 크게 양수면 "슛 난이도 대비 잘 들어가는 중"(핫), 크게 음수면 "쉬운 찬스도
놓치는 중"(콜드).

2025-2026 시즌 마지막 5경기로 범위를 좁힌 이유 - "폼(현재 상태)"이라는 개념 자체가 최근성을
전제하기 때문에, 옛날 시즌 마지막 5경기를 보여주면 "지금 폼"이라는 말과 안 맞음.
"""
import json
import math
import os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
OUT_PATH = os.path.join(ANALYSIS_DIR, "form_index_2025-2026.json")

TARGET_SEASON = "2025-2026"
ROLLING_WINDOW = 5
MIN_ATTEMPTS = 15  # 5경기 표본이 너무 적은 벤치 선수 노이즈 제거

HOOP_LEFT = (69, 205)
HOOP_RIGHT = (681, 205)
SCALE_M_PER_UNIT = 0.0413
THREE_PT_M = 6.75
ZONE_BOUNDS = [
    ("rim", 0.0, 1.2), ("close", 1.2, 3.0), ("midShort", 3.0, 5.0),
    ("midLong", 5.0, THREE_PT_M), ("three", THREE_PT_M, 999.0),
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


def main():
    with open(os.path.join(ANALYSIS_DIR, "xpts_zone_table.json"), encoding="utf-8") as f:
        zone_table = json.load(f)

    print(f"{TARGET_SEASON} 시즌 경기 목록(날짜순) 구성 중...", flush=True)
    games = []
    for gk in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gk, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        if meta["game"].get("seasonName") == TARGET_SEASON:
            games.append((meta["game"].get("gameDate"), gk))
    games.sort()
    print(f"  {len(games)}경기", flush=True)

    # 선수별 [(gameDate, gmkey, [슛...])] 날짜순 - 슛 하나 = (zone, value, made)
    player_games = defaultdict(list)
    player_meta = {}
    print("경기별 슛차트 수집 중...", flush=True)
    for i, (gameDate, gk) in enumerate(games, 1):
        path = os.path.join(GAMES_DIR, gk, "match-chart.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            chart = json.load(f)
        for player in chart.get("shootLog", []):
            pcode, pname, tcode = player["pcode"], player["pname"], player["tcode"]
            shots = [classify(log["x"], log["y"], log["d"]) + (log["o"] == "O",) for log in player["logs"]]
            if not shots:
                continue
            player_games[pcode].append((gameDate, gk, shots))
            player_meta[pcode] = {"name": pname, "tcode": tcode}
        if i % 50 == 0:
            print(f"  {i}/{len(games)}...", flush=True)

    print("선수별 최근 5경기 폼 지수 계산 중...", flush=True)
    leaderboard = []
    for pcode, glist in player_games.items():
        glist.sort(key=lambda x: x[0])
        recent = glist[-ROLLING_WINDOW:]
        if len(recent) < 3:  # 최근 5경기 데이터 자체가 3경기 미만이면 스킵(부상 복귀 직후 등)
            continue
        attempts, actual_pts, expected_pts = 0, 0.0, 0.0
        for _, _, shots in recent:
            for zone, value, made in shots:
                attempts += 1
                if made:
                    actual_pts += value
                expected_pts += zone_table[zone]["expectedPtsPerShot"]
        if attempts < MIN_ATTEMPTS:
            continue
        delta = actual_pts - expected_pts
        meta = player_meta[pcode]
        leaderboard.append({
            "pcode": pcode, "player": meta["name"], "tcode": meta["tcode"],
            "games": len(recent), "attempts": attempts,
            "actualPts": round(actual_pts, 1), "expectedPts": round(expected_pts, 1),
            "delta": round(delta, 1), "deltaPerGame": round(delta / len(recent), 2),
            "lastGameDate": recent[-1][0],
        })
    leaderboard.sort(key=lambda r: -r["delta"])

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"season": TARGET_SEASON, "rollingWindow": ROLLING_WINDOW, "leaderboard": leaderboard}, f,
                   ensure_ascii=False, indent=1)
    print(f"완료 - {len(leaderboard)}명 -> {OUT_PATH}", flush=True)
    print("\n=== 최근 5경기 가장 핫한 선수 top 5 ===", flush=True)
    for r in leaderboard[:5]:
        print(f"  {r['player']:<10} +{r['delta']} (실제 {r['actualPts']} vs 기대 {r['expectedPts']}, {r['games']}경기 {r['attempts']}회)", flush=True)
    print("=== 가장 콜드한 선수 bottom 5 ===", flush=True)
    for r in leaderboard[-5:]:
        print(f"  {r['player']:<10} {r['delta']} (실제 {r['actualPts']} vs 기대 {r['expectedPts']}, {r['games']}경기 {r['attempts']}회)", flush=True)


if __name__ == "__main__":
    main()
