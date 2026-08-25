"""
선수별 "그 경기 이전까지 누적된" 온/오프코트 net rating 스냅샷을 경기마다 만든다.

build_synergy_matchup.py의 player_onoff.json은 5시즌 전체를 한꺼번에 집계한 "사후 평가"용이라
승률 예측 피처로 그대로 쓰면 데이터 누수(그 선수의 미래 경기 결과가 이미 반영된 값으로 과거
경기를 "예측"하는 꼴)가 생긴다. 이 스크립트는 경기를 날짜순으로 재생하면서, 각 경기 시작 "전"
시점까지 그 선수가 뛴 스틴트만으로 net rating을 계산해 그 경기에 스냅샷으로 붙인다.

처음 출전하는 선수(직전 누적 스틴트 없음)는 None으로 표시 - 팀 피처 집계할 때 그냥 빠짐
(신인 효과를 이 피처로 못 잡는다는 뜻이지만, 그건 애초에 온/오프코트 자체가 "출전 이력"에서
나오는 지표라 어쩔 수 없는 한계임).
"""
import json
import os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
STINTS_DIR = os.path.join(BASE, "..", "raw", "stints")
OUT_PATH = os.path.join(BASE, "..", "raw", "analysis", "player_onoff_timeline.json")

MIN_SEC_FOR_RATING = 120  # 이보다 적게 뛴 상태면 스냅샷을 아직 신뢰 못 함 -> None


def load_game_dates():
    dates = {}
    for gmkey in os.listdir(GAMES_DIR):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        dates[gmkey] = meta["game"].get("gameDate")
    return dates


def per40(pts_for, pts_against, seconds):
    if seconds <= 0:
        return None
    return (pts_for - pts_against) * 40 / (seconds / 60)


def main():
    from build_synergy_matchup import stint_duration  # 쿼터 경과시간 계산 재사용

    dates = load_game_dates()
    stint_files = [fn[:-5] for fn in os.listdir(STINTS_DIR) if fn.endswith(".json") and not fn.startswith("_")]
    # 날짜순 정렬 (같은 날짜 내 순서는 gmkey 문자열 순 - 완벽친 않지만 게임 수 대비 영향 미미)
    ordered = sorted(stint_files, key=lambda g: (dates.get(g, "99999999"), g))

    accum = defaultdict(lambda: {"for": 0, "against": 0, "sec": 0})
    snapshots = {}  # gmkey -> {pcode: {netRatingPer40, secondsSoFar}}

    for gmkey in ordered:
        with open(os.path.join(STINTS_DIR, f"{gmkey}.json"), encoding="utf-8") as f:
            game = json.load(f)

        # 1) 이 경기 시작 "전" 누적 상태로 스냅샷을 먼저 찍는다
        players_in_game = set()
        for s in game["stints"]:
            if not s.get("lineupValid"):
                continue
            players_in_game.update(s["homeLineup"])
            players_in_game.update(s["awayLineup"])

        snap = {}
        for pcode in players_in_game:
            a = accum[pcode]
            if a["sec"] >= MIN_SEC_FOR_RATING:
                snap[pcode] = {"netRatingPer40": round(per40(a["for"], a["against"], a["sec"]), 2),
                               "secondsSoFar": a["sec"]}
            else:
                snap[pcode] = None
        snapshots[gmkey] = snap

        # 2) 그 다음에야 이 경기의 스틴트를 누적치에 반영 (미래 경기용)
        for s in game["stints"]:
            if not s.get("lineupValid"):
                continue
            dur = stint_duration(s)
            if dur <= 0:
                continue
            for side, opp in (("home", "away"), ("away", "home")):
                pts_for, pts_against = s[f"{side}Pts"], s[f"{opp}Pts"]
                for pcode in s[f"{side}Lineup"]:
                    a = accum[pcode]
                    a["for"] += pts_for
                    a["against"] += pts_against
                    a["sec"] += dur

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(snapshots, f, ensure_ascii=False)
    total_snaps = sum(len(v) for v in snapshots.values())
    with_rating = sum(1 for v in snapshots.values() for x in v.values() if x is not None)
    print(f"{len(ordered)}경기 처리, 스냅샷 {total_snaps}건 (그중 표본충분 {with_rating}건) -> {OUT_PATH}", flush=True)


if __name__ == "__main__":
    main()
