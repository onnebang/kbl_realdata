"""
Tier 01 라이브 스탯 - 이벤트 재생 기반 (2026-08-24, kbl_stats_roadmap.html 01단계).
문자중계를 한 번씩만 훑으면서 4개를 동시에 계산(경기당 4207번씩 파일을 따로 열지 않으려고
build_wpa.py와 같은 방식으로 한 패스에 묶음).

- **Lead Change / Tie**: scoreDiff 부호가 바뀌는 지점, 0을 지나는 지점 카운트.
- **Biggest Comeback**: 경기 승자가 도중에 최대 몇 점까지 뒤져봤었는지 - 역대 최대 역전승 리더보드.
- **Scoring Drought**: 팀별 "마지막 득점 이후 무득점 경과시간"의 경기 내 최댓값.
- **Deflection / Good Defense**: 액션코드 227(디플렉션)/221(굿디펜스) - 이미 수집돼있는데
  안 쓰고 있던 코드라 그냥 카운트만 하면 됨.
"""
import json
import os
from collections import defaultdict

from build_synergy_matchup import cumulative_elapsed
from build_live_winprob_data import SCORE_CODES

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")

LEADCHANGE_OUT = os.path.join(ANALYSIS_DIR, "lead_changes.json")
COMEBACK_OUT = os.path.join(ANALYSIS_DIR, "biggest_comebacks.json")
DROUGHT_OUT = os.path.join(ANALYSIS_DIR, "scoring_droughts.json")
HUSTLE_OUT = os.path.join(ANALYSIS_DIR, "hustle_leaderboard.json")

HUSTLE_CODES = {"227": "deflection", "221": "goodDefense"}


def process_game(gmkey, home_tcode, away_tcode, hustle_agg):
    path = os.path.join(GAMES_DIR, gmkey, "text-cast.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        events = json.load(f)
    if not events:
        return None

    home_score, away_score = 0, 0
    lead_changes, ties = 0, 0
    prev_sign = 0  # -1/0/+1
    max_deficit_home, max_deficit_away = 0, 0  # 각 팀이 겪은 최대 열세(양수)

    last_score_elapsed = {home_tcode: None, away_tcode: None}
    max_drought = {home_tcode: 0, away_tcode: 0}
    max_drought_at = {home_tcode: None, away_tcode: None}

    for evt in events:
        code = evt.get("a")
        elapsed = cumulative_elapsed(evt["q"], evt["m"], evt["s"])

        if code in HUSTLE_CODES and evt.get("p"):
            hustle_agg[(evt["p"], evt.get("t"))][HUSTLE_CODES[code]] += 1

        if code in SCORE_CODES:
            team = evt.get("t")
            if team == home_tcode:
                home_score += SCORE_CODES[code]
            elif team == away_tcode:
                away_score += SCORE_CODES[code]
            else:
                continue

            # 득점한 팀의 가뭄 종료, 상대팀 가뭄은 계속 진행중이므로 여기서 갱신 안 함
            if last_score_elapsed[team] is not None:
                pass
            last_score_elapsed[team] = elapsed

            diff = home_score - away_score
            sign = (diff > 0) - (diff < 0)
            if prev_sign != 0 and sign != 0 and sign != prev_sign:
                lead_changes += 1
            if diff == 0 and prev_sign != 0:
                ties += 1
            if sign != 0:
                prev_sign = sign

            max_deficit_home = max(max_deficit_home, -diff)
            max_deficit_away = max(max_deficit_away, diff)

    # 가뭄(무득점 시간)은 "그 팀 마지막 득점 이후 상대가 득점하기까지"가 아니라 실제 경과시간
    # 기준으로 재계산 - 득점 이벤트 시퀀스만으로 한 번 더 훑어서 팀별 연속 무득점 구간 추적
    last_elapsed = {home_tcode: 0, away_tcode: 0}
    for evt in events:
        code = evt.get("a")
        if code not in SCORE_CODES:
            continue
        team = evt.get("t")
        if team not in (home_tcode, away_tcode):
            continue
        elapsed = cumulative_elapsed(evt["q"], evt["m"], evt["s"])
        gap = elapsed - last_elapsed[team]
        if gap > max_drought[team]:
            max_drought[team] = gap
            max_drought_at[team] = {"q": evt["q"], "m": evt["m"], "s": evt["s"]}
        last_elapsed[team] = elapsed

    final_diff = home_score - away_score
    if final_diff == 0:
        return None  # 무승부 없음(연장 처리됨) - 방어적으로만
    winner = home_tcode if final_diff > 0 else away_tcode
    winner_max_deficit = max_deficit_home if winner == home_tcode else max_deficit_away

    return {
        "gmkey": gmkey, "leadChanges": lead_changes, "ties": ties,
        "finalHome": home_score, "finalAway": away_score, "winnerTcode": winner,
        "winnerMaxDeficit": winner_max_deficit,
        "maxDroughtHome": max_drought[home_tcode], "maxDroughtAway": max_drought[away_tcode],
        "maxDroughtHomeAt": max_drought_at[home_tcode], "maxDroughtAwayAt": max_drought_at[away_tcode],
    }


def main():
    hustle_agg = defaultdict(lambda: {"deflection": 0, "goodDefense": 0, "games": set()})
    lead_change_rows = []
    comeback_rows = []
    drought_rows = []

    n = 0
    for gmkey in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        home_tcode, away_tcode = meta["game"].get("tcodeH"), meta["game"].get("tcodeA")
        if not home_tcode or not away_tcode:
            continue

        result = process_game(gmkey, home_tcode, away_tcode, hustle_agg)
        if result is None:
            continue
        n += 1

        for pcode_name, tcode in list(hustle_agg.keys()):
            pass  # games 집합은 아래서 별도 처리(중복 순회 방지 위해 여기선 스킵)

        lead_change_rows.append({"gmkey": gmkey, "leadChanges": result["leadChanges"], "ties": result["ties"]})
        comeback_rows.append({
            "gmkey": gmkey, "gameDate": meta["game"].get("gameDate"),
            "homeTname": meta["game"].get("tnameH"), "awayTname": meta["game"].get("tnameA"),
            "finalHome": result["finalHome"], "finalAway": result["finalAway"],
            "winnerTcode": result["winnerTcode"], "winnerMaxDeficit": result["winnerMaxDeficit"],
        })
        drought_rows.append({
            "gmkey": gmkey, "gameDate": meta["game"].get("gameDate"),
            "homeTname": meta["game"].get("tnameH"), "awayTname": meta["game"].get("tnameA"),
            "maxDroughtHomeSec": result["maxDroughtHome"], "maxDroughtHomeAt": result["maxDroughtHomeAt"],
            "maxDroughtAwaySec": result["maxDroughtAway"], "maxDroughtAwayAt": result["maxDroughtAwayAt"],
        })

        if n % 500 == 0:
            print(f"  {n}경기 처리...", flush=True)

    print(f"\n총 {n}경기 처리 완료", flush=True)

    # 허슬 리더보드 (게임 카운트는 hustle_agg 키에 경기가 안 남아있어서 별도로 안 셈 - 총 이벤트 수만)
    hustle_list = [
        {"player": name, "tcode": tcode, "deflections": v["deflection"], "goodDefense": v["goodDefense"]}
        for (name, tcode), v in hustle_agg.items()
    ]
    hustle_list.sort(key=lambda x: -(x["deflections"] + x["goodDefense"]))

    with open(LEADCHANGE_OUT, "w", encoding="utf-8") as f:
        json.dump(lead_change_rows, f, ensure_ascii=False, indent=1)
    comeback_rows.sort(key=lambda x: -x["winnerMaxDeficit"])
    with open(COMEBACK_OUT, "w", encoding="utf-8") as f:
        json.dump(comeback_rows[:200], f, ensure_ascii=False, indent=1)
    with open(DROUGHT_OUT, "w", encoding="utf-8") as f:
        json.dump(drought_rows, f, ensure_ascii=False, indent=1)
    with open(HUSTLE_OUT, "w", encoding="utf-8") as f:
        json.dump(hustle_list, f, ensure_ascii=False, indent=1)

    print(f"리드체인지/타이 {len(lead_change_rows)}경기 -> {LEADCHANGE_OUT}", flush=True)
    print(f"역대 최대 역전승 상위 200 -> {COMEBACK_OUT}", flush=True)
    for r in comeback_rows[:5]:
        print(f"  {r['gameDate']} {r['homeTname']} vs {r['awayTname']} - 최대 {r['winnerMaxDeficit']}점차 뒤집음", flush=True)
    print(f"무득점 가뭄 {len(drought_rows)}경기 -> {DROUGHT_OUT}", flush=True)
    print(f"허슬(디플렉션/굿디펜스) {len(hustle_list)}명 -> {HUSTLE_OUT}", flush=True)
    for r in hustle_list[:5]:
        print(f"  {r['player']} 디플렉션{r['deflections']} 굿디펜스{r['goodDefense']}", flush=True)


if __name__ == "__main__":
    main()
