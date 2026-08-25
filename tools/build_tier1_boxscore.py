"""
Tier 01 라이브 스탯 - 박스스코어 기반 (2026-08-24, kbl_stats_roadmap.html 01단계).
이벤트 재생 없이 player-stat.json/team-record.json만으로 계산되는 것들.

- **Game Score(홀린저 지수)**: PER보다 단순한 한 줄 공식으로 "그 경기 한 선수의 활약"을 즉시
  수치화. offr/defr가 rb(총리바운드)로 정확히 합산되는 걸 확인해서(offr+defr=rb) 공격/수비
  리바운드 원시 카운트로 씀.
- **Four Factors**: eFG%/TOV%(turnover ratio)/ORB%/FT Rate를 승부 결정 4요소로 재포장 -
  새 계산 아니라 team-record.json에 이미 있는 필드를 그대로 뽑아서 팀-시즌 단위로 집계.
"""
import json
import os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
GAMESCORE_OUT = os.path.join(ANALYSIS_DIR, "game_scores.json")
FOURFACTORS_OUT = os.path.join(ANALYSIS_DIR, "four_factors_team_season.json")


def game_score(r):
    """홀린저 Game Score 공식. r: player-stat.json의 'records' 딕셔너리."""
    return (
        (r.get("score") or 0)
        + 0.4 * (r.get("fg") or 0)
        - 0.7 * (r.get("fgA") or 0)
        - 0.4 * ((r.get("ftA") or 0) - (r.get("ft") or 0))
        + 0.7 * (r.get("offr") or 0)
        + 0.3 * (r.get("defr") or 0)
        + (r.get("stl") or 0)
        + 0.7 * (r.get("ast") or 0)
        + 0.7 * (r.get("bs") or 0)
        - 0.4 * (r.get("foul") or 0)
        - (r.get("to") or 0)
    )


def build_game_scores():
    per_game = []
    career = defaultdict(lambda: {"totalGS": 0.0, "games": 0, "best": None})

    for gmkey in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        pstat_path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
        if not (os.path.exists(meta_path) and os.path.exists(pstat_path)):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        game_date = meta["game"].get("gameDate")
        with open(pstat_path, encoding="utf-8") as f:
            rows = json.load(f)
        for row in rows:
            p, r = row["player"], row["records"]
            minutes = (r.get("playMin") or 0) + (r.get("playSec") or 0) / 60
            if minutes <= 0:
                continue
            gs = round(game_score(r), 2)
            per_game.append({
                "gmkey": gmkey, "gameDate": game_date, "player": p["pname"], "tcode": p["tcode"],
                "gameScore": gs, "pts": r.get("score"), "reb": r.get("rb"), "ast": r.get("ast"),
            })
            key = (p["pname"], p["tcode"])
            c = career[key]
            c["totalGS"] += gs
            c["games"] += 1
            if c["best"] is None or gs > c["best"]["gameScore"]:
                c["best"] = {"gmkey": gmkey, "gameDate": game_date, "gameScore": gs}

    per_game.sort(key=lambda x: -x["gameScore"])
    career_list = [
        {"player": name, "tcode": tcode, "games": c["games"],
         "avgGameScore": round(c["totalGS"] / c["games"], 2), "bestGame": c["best"]}
        for (name, tcode), c in career.items() if c["games"] >= 20
    ]
    career_list.sort(key=lambda x: -x["avgGameScore"])
    return per_game, career_list


def build_four_factors():
    team_season = defaultdict(lambda: {"efgSum": 0.0, "tovSum": 0.0, "orebSum": 0.0, "ftRateSum": 0.0, "n": 0, "wins": 0})

    for gmkey in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        tr_path = os.path.join(GAMES_DIR, gmkey, "team-record.json")
        if not (os.path.exists(meta_path) and os.path.exists(tr_path)):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        season_code = meta["game"].get("seasonCode")
        season_name = meta["game"].get("seasonName")
        with open(tr_path, encoding="utf-8") as f:
            tr = json.load(f)
        by_tcode = {row["tcode"]: row["records"] for row in tr}
        if len(by_tcode) != 2:
            continue
        tcodes = list(by_tcode.keys())
        scores = {t: by_tcode[t].get("score", 0) for t in tcodes}
        winner = max(scores, key=scores.get) if scores[tcodes[0]] != scores[tcodes[1]] else None
        for tcode, r in by_tcode.items():
            fga = r.get("fgA") or 0
            ft_rate = (r.get("ftA") or 0) / fga if fga else None
            key = (tcode, season_code, season_name)
            a = team_season[key]
            if r.get("efgRt") is not None:
                a["efgSum"] += r["efgRt"]
            if r.get("toRatio") is not None:
                a["tovSum"] += r["toRatio"]
            elif r.get("tovRt") is not None:
                a["tovSum"] += r["tovRt"]
            if r.get("orebRt") is not None:
                a["orebSum"] += r["orebRt"]
            if ft_rate is not None:
                a["ftRateSum"] += ft_rate
            a["n"] += 1
            if winner == tcode:
                a["wins"] += 1

    out = []
    for (tcode, season_code, season_name), a in team_season.items():
        if a["n"] < 5:
            continue
        out.append({
            "tcode": tcode, "seasonCode": season_code, "seasonName": season_name, "games": a["n"],
            "winPct": round(a["wins"] / a["n"], 3),
            "efgPct": round(a["efgSum"] / a["n"], 2),
            "tovRatio": round(a["tovSum"] / a["n"], 2),
            "orebPct": round(a["orebSum"] / a["n"], 2),
            "ftRate": round(a["ftRateSum"] / a["n"], 3),
        })
    out.sort(key=lambda x: (x["seasonCode"], -x["winPct"]))
    return out


def main():
    print("Game Score 계산 중...", flush=True)
    per_game, career_list = build_game_scores()
    with open(GAMESCORE_OUT, "w", encoding="utf-8") as f:
        json.dump({"perGame": per_game[:1000], "career": career_list}, f, ensure_ascii=False, indent=1)
    print(f"  경기별 상위 1000건 + 커리어 {len(career_list)}명 -> {GAMESCORE_OUT}", flush=True)
    print("  역대 Game Score 상위 5:", flush=True)
    for r in per_game[:5]:
        print(f"    {r['player']} {r['gameDate']} {r['gameScore']} ({r['pts']}점 {r['reb']}리바 {r['ast']}어시)", flush=True)

    print("\nFour Factors 팀-시즌 집계 중...", flush=True)
    ff = build_four_factors()
    with open(FOURFACTORS_OUT, "w", encoding="utf-8") as f:
        json.dump(ff, f, ensure_ascii=False, indent=1)
    print(f"  {len(ff)}건 -> {FOURFACTORS_OUT}", flush=True)


if __name__ == "__main__":
    main()
