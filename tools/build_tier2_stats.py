"""
Tier 02 라이브 스탯 - 이벤트 시퀀스 스캔 기반 (2026-08-24, kbl_stats_roadmap.html 02단계).

정확한 액션코드는 kbl_action_codes.json 참고. 구현 전에 실제 데이터로 검증한 것들:
- 슛 성공/실패 쌍: (201성공/202실패)=2점, (205/206)=3점, (207/208)=덩크. FT는 (203성공/204실패).
- **And-1 판정**: "215(파울자유투)가 직전 득점이벤트와 정확히 같은 시각(q,m,s)에 찍힌다"는
  가정은 300경기 샘플에서 딱 1건만 맞아서 기각(로그 지연 때문에 초 단위가 안 맞음). 대신
  "같은 선수·같은 팀의 마지막 득점 이후 이벤트 인덱스로 3개 이내 + 그 사이에 상대팀 득점이
  없음"으로 재정의 - 이벤트 인덱스 갭 히스토그램에서 1~3에 뚜렷한 봉우리가 있는 걸 확인함
  (300경기 샘플, gap<=3 조건으로 273건 - 경기당 약 0.9회, 실제 NBA/KBL and-1 빈도와 부합).
- **Triple/Double-Double Watch**: 로드맵 카드 설명의 "8+ 도달시 알림"은 확정된 더블더블(달성
  기준 10)이 아니라 "곧 나올 것 같다"는 사전 경고 트리거로 해석 - watchTriggeredAt(8+ 두번째
  스탯 도달 시점)과 confirmedAt(10+ 두번째 스탯 도달 시점, 실제 더블더블 성립 시점)을 둘 다 기록.
- **Bench vs Starter**: player-stat.json 각 행에 이미 startFlag(0/1)가 있어서 이벤트 재생 불필요 -
  박스스코어만으로 팀-시즌 집계.
"""
import json
import os
from collections import defaultdict

from build_synergy_matchup import cumulative_elapsed
from build_live_winprob_data import SCORE_CODES

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")

RUNS_OUT = os.path.join(ANALYSIS_DIR, "scoring_runs.json")
HEATCHECK_OUT = os.path.join(ANALYSIS_DIR, "heat_check_streaks.json")
QUARTER_SPLIT_OUT = os.path.join(ANALYSIS_DIR, "quarter_split.json")
DOUBLEDOUBLE_OUT = os.path.join(ANALYSIS_DIR, "double_triple_doubles.json")
AND1_OUT = os.path.join(ANALYSIS_DIR, "and1_plays.json")
BENCH_STARTER_OUT = os.path.join(ANALYSIS_DIR, "bench_vs_starter.json")

MAKE_CODES = {"201", "205", "207"}
MISS_CODES = {"202", "206", "208"}
REB_CODES = {"209", "210"}
AST_CODE = "211"
STL_CODE = "212"
BLK_CODE = "213"
AND1_MAX_GAP = 3


def process_game_events(gmkey, home_tcode, away_tcode, meta):
    path = os.path.join(GAMES_DIR, gmkey, "text-cast.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        events = json.load(f)
    if not events:
        return None

    game_date = meta["game"].get("gameDate")
    home_tname, away_tname = meta["game"].get("tnameH"), meta["game"].get("tnameA")

    # --- Dynamic Scoring Run ---
    run_pts = {home_tcode: 0, away_tcode: 0}
    best_run = {home_tcode: {"pts": 0}, away_tcode: {"pts": 0}}

    # --- Heat Check (선수별 연속 성공/실패) ---
    streak = defaultdict(lambda: {"type": None, "len": 0})  # (player,team) -> streak
    best_make_streak = defaultdict(int)  # (player,team) -> 이 경기 내 최대 연속성공
    best_miss_streak = defaultdict(int)

    # --- Quarter-by-Quarter Split ---
    quarter_pts = defaultdict(lambda: defaultdict(int))  # (player,team) -> {quarter: pts}

    # --- Triple/Double-Double Watch ---
    stat5 = defaultdict(lambda: {"pts": 0, "reb": 0, "ast": 0, "stl": 0, "blk": 0})
    watch_triggered_at = {}   # (player,team) -> clock dict, 2개 항목 8+ 최초 도달
    confirmed_dd_at = {}      # 2개 항목 10+ 최초 도달 (더블더블 성립)
    confirmed_td_at = {}      # 3개 항목 10+ 최초 도달 (트리플더블 성립)

    # --- And-1 ---
    last_make_idx = {}  # team -> (index, player)
    and1_plays = []

    game_results = []

    for i, evt in enumerate(events):
        code = evt.get("a")
        team = evt.get("t")
        player = evt.get("p")
        clock = {"q": evt["q"], "m": evt["m"], "s": evt["s"]}

        if code in SCORE_CODES and team in (home_tcode, away_tcode):
            pts = SCORE_CODES[code]
            other = away_tcode if team == home_tcode else home_tcode
            run_pts[team] += pts
            run_pts[other] = 0
            if run_pts[team] > best_run[team]["pts"]:
                best_run[team] = {"pts": run_pts[team], "endAt": clock}

        if code in MAKE_CODES and player:
            key = (player, team)
            quarter_pts[key][evt["q"]] += SCORE_CODES.get(code, 0)
            last_make_idx[team] = (i, player)
            st = streak[key]
            st["len"] = st["len"] + 1 if st["type"] == "make" else 1
            st["type"] = "make"
            best_make_streak[key] = max(best_make_streak[key], st["len"])
        elif code in MISS_CODES and player:
            key = (player, team)
            st = streak[key]
            st["len"] = st["len"] + 1 if st["type"] == "miss" else 1
            st["type"] = "miss"
            best_miss_streak[key] = max(best_miss_streak[key], st["len"])

        if player and team in (home_tcode, away_tcode):
            key = (player, team)
            s5 = stat5[key]
            if code in SCORE_CODES:
                s5["pts"] += SCORE_CODES[code]
            elif code in REB_CODES:
                s5["reb"] += 1
            elif code == AST_CODE:
                s5["ast"] += 1
            elif code == STL_CODE:
                s5["stl"] += 1
            elif code == BLK_CODE:
                s5["blk"] += 1
            else:
                pass

            if code in SCORE_CODES or code in REB_CODES or code in (AST_CODE, STL_CODE, BLK_CODE):
                cats_at_8 = sum(1 for v in s5.values() if v >= 8)
                cats_at_10 = sum(1 for v in s5.values() if v >= 10)
                if key not in watch_triggered_at and cats_at_8 >= 2:
                    watch_triggered_at[key] = dict(clock)
                if key not in confirmed_dd_at and cats_at_10 >= 2:
                    confirmed_dd_at[key] = dict(clock)
                if key not in confirmed_td_at and cats_at_10 >= 3:
                    confirmed_td_at[key] = dict(clock)

        if code == "215" and player and team in last_make_idx:
            idx, mk_player = last_make_idx[team]
            if mk_player == player and (i - idx) <= AND1_MAX_GAP:
                opp = away_tcode if team == home_tcode else home_tcode
                opp_scored = any(
                    events[j].get("a") in SCORE_CODES and events[j].get("t") == opp
                    for j in range(idx + 1, i)
                )
                if not opp_scored:
                    and1_plays.append({
                        "gmkey": gmkey, "gameDate": game_date, "player": player, "tcode": team,
                        "at": clock,
                    })

    for team in (home_tcode, away_tcode):
        if best_run[team]["pts"] > 0:
            opp_tname = away_tname if team == home_tcode else home_tname
            game_results.append(("run", {
                "gmkey": gmkey, "gameDate": game_date, "player": None, "tcode": team,
                "runPts": best_run[team]["pts"], "opponentTname": opp_tname, "endAt": best_run[team]["endAt"],
            }))

    for key, ln in best_make_streak.items():
        if ln >= 4:
            game_results.append(("heat_make", {
                "gmkey": gmkey, "gameDate": game_date, "player": key[0], "tcode": key[1], "streak": ln,
            }))
    for key, ln in best_miss_streak.items():
        if ln >= 6:
            game_results.append(("heat_miss", {
                "gmkey": gmkey, "gameDate": game_date, "player": key[0], "tcode": key[1], "streak": ln,
            }))

    for key, qpts in quarter_pts.items():
        total = sum(qpts.values())
        if total < 12:
            continue
        best_q, best_pts = max(qpts.items(), key=lambda kv: kv[1])
        game_results.append(("quarter_split", {
            "gmkey": gmkey, "gameDate": game_date, "player": key[0], "tcode": key[1],
            "totalPts": total, "bestQuarter": best_q, "bestQuarterPts": best_pts,
            "concentration": round(best_pts / total, 3),
        }))

    for key in confirmed_dd_at:
        s5 = stat5[key]
        is_td = key in confirmed_td_at
        game_results.append(("double_double", {
            "gmkey": gmkey, "gameDate": game_date, "player": key[0], "tcode": key[1],
            "pts": s5["pts"], "reb": s5["reb"], "ast": s5["ast"], "stl": s5["stl"], "blk": s5["blk"],
            "isTripleDouble": is_td,
            "watchTriggeredAt": watch_triggered_at.get(key),
            "confirmedAt": confirmed_dd_at[key],
            "tripleDoubleConfirmedAt": confirmed_td_at.get(key),
        }))

    for row in and1_plays:
        game_results.append(("and1", row))

    return game_results


def build_bench_vs_starter():
    team_season = defaultdict(lambda: {
        "starterPts": 0, "benchPts": 0, "starterGames": 0, "benchGames": 0,
        "starterReb": 0, "benchReb": 0, "starterAst": 0, "benchAst": 0, "n": 0,
    })
    for gmkey in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        pstat_path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
        if not (os.path.exists(meta_path) and os.path.exists(pstat_path)):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        season_code = meta["game"].get("seasonCode")
        season_name = meta["game"].get("seasonName")
        with open(pstat_path, encoding="utf-8") as f:
            rows = json.load(f)
        by_team = defaultdict(list)
        for row in rows:
            by_team[row["player"]["tcode"]].append(row)
        for tcode, prows in by_team.items():
            key = (tcode, season_code, season_name)
            a = team_season[key]
            a["n"] += 1
            for row in prows:
                r = row["records"]
                bucket = "starter" if row.get("startFlag") == 1 else "bench"
                a[f"{bucket}Pts"] += r.get("score") or 0
                a[f"{bucket}Reb"] += r.get("rb") or 0
                a[f"{bucket}Ast"] += r.get("ast") or 0

    out = []
    for (tcode, season_code, season_name), a in team_season.items():
        if a["n"] < 5:
            continue
        out.append({
            "tcode": tcode, "seasonCode": season_code, "seasonName": season_name, "games": a["n"],
            "starterPtsPerGame": round(a["starterPts"] / a["n"], 1),
            "benchPtsPerGame": round(a["benchPts"] / a["n"], 1),
            "starterRebPerGame": round(a["starterReb"] / a["n"], 1),
            "benchRebPerGame": round(a["benchReb"] / a["n"], 1),
            "starterAstPerGame": round(a["starterAst"] / a["n"], 1),
            "benchAstPerGame": round(a["benchAst"] / a["n"], 1),
            "benchPtsShare": round(a["benchPts"] / max(a["starterPts"] + a["benchPts"], 1), 3),
        })
    out.sort(key=lambda x: (x["seasonCode"], -x["benchPtsShare"]))
    return out


def main():
    runs, heat_make, heat_miss, quarter_splits, doubledoubles, and1s = [], [], [], [], [], []

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

        results = process_game_events(gmkey, home_tcode, away_tcode, meta)
        if results is None:
            continue
        n += 1
        for kind, row in results:
            if kind == "run":
                runs.append(row)
            elif kind == "heat_make":
                heat_make.append(row)
            elif kind == "heat_miss":
                heat_miss.append(row)
            elif kind == "quarter_split":
                quarter_splits.append(row)
            elif kind == "double_double":
                doubledoubles.append(row)
            elif kind == "and1":
                and1s.append(row)

        if n % 500 == 0:
            print(f"  {n}경기 처리...", flush=True)

    print(f"\n총 {n}경기 이벤트 처리 완료", flush=True)

    runs.sort(key=lambda x: -x["runPts"])
    heat_make.sort(key=lambda x: -x["streak"])
    heat_miss.sort(key=lambda x: -x["streak"])
    quarter_splits.sort(key=lambda x: -x["concentration"])
    doubledoubles.sort(key=lambda x: (-x["isTripleDouble"], -(x["pts"] + x["reb"] + x["ast"] + x["stl"] + x["blk"])))

    and1_agg = defaultdict(int)
    for r in and1s:
        and1_agg[(r["player"], r["tcode"])] += 1
    and1_leaderboard = [
        {"player": p, "tcode": t, "and1Count": c} for (p, t), c in and1_agg.items()
    ]
    and1_leaderboard.sort(key=lambda x: -x["and1Count"])

    os.makedirs(ANALYSIS_DIR, exist_ok=True)
    with open(RUNS_OUT, "w", encoding="utf-8") as f:
        json.dump(runs[:300], f, ensure_ascii=False, indent=1)
    with open(HEATCHECK_OUT, "w", encoding="utf-8") as f:
        json.dump({"bestMakeStreaks": heat_make[:300], "worstMissStreaks": heat_miss[:300]}, f, ensure_ascii=False, indent=1)
    with open(QUARTER_SPLIT_OUT, "w", encoding="utf-8") as f:
        json.dump(quarter_splits[:300], f, ensure_ascii=False, indent=1)
    with open(DOUBLEDOUBLE_OUT, "w", encoding="utf-8") as f:
        json.dump(doubledoubles, f, ensure_ascii=False, indent=1)
    with open(AND1_OUT, "w", encoding="utf-8") as f:
        json.dump({"leaderboard": and1_leaderboard[:300], "plays": and1s[:1000]}, f, ensure_ascii=False, indent=1)

    print(f"Dynamic Scoring Run 상위 300 -> {RUNS_OUT}", flush=True)
    for r in runs[:5]:
        print(f"  {r['gameDate']} tcode{r['tcode']} {r['runPts']}-0 run vs {r['opponentTname']}", flush=True)

    print(f"Heat Check (연속성공/실패) -> {HEATCHECK_OUT}", flush=True)
    for r in heat_make[:5]:
        print(f"  {r['player']} {r['gameDate']} 연속 {r['streak']}개 성공", flush=True)

    print(f"Quarter Split 집중도 상위 300 -> {QUARTER_SPLIT_OUT}", flush=True)
    for r in quarter_splits[:5]:
        print(f"  {r['player']} {r['gameDate']} {r['bestQuarter']}에 {r['bestQuarterPts']}/{r['totalPts']}점 ({r['concentration']*100:.0f}%)", flush=True)

    n_dd = sum(1 for r in doubledoubles if not r["isTripleDouble"])
    n_td = sum(1 for r in doubledoubles if r["isTripleDouble"])
    print(f"더블더블 {n_dd}건 + 트리플더블 {n_td}건 -> {DOUBLEDOUBLE_OUT}", flush=True)
    for r in [r for r in doubledoubles if r["isTripleDouble"]][:5]:
        print(f"  [TD] {r['player']} {r['gameDate']} {r['pts']}/{r['reb']}/{r['ast']}/{r['stl']}/{r['blk']}", flush=True)

    print(f"And-1 리더보드 -> {AND1_OUT} (총 {len(and1s)}건)", flush=True)
    for r in and1_leaderboard[:5]:
        print(f"  {r['player']} And-1 {r['and1Count']}회", flush=True)

    print("\nBench vs Starter 팀-시즌 집계 중...", flush=True)
    bvs = build_bench_vs_starter()
    with open(BENCH_STARTER_OUT, "w", encoding="utf-8") as f:
        json.dump(bvs, f, ensure_ascii=False, indent=1)
    print(f"  {len(bvs)}건 -> {BENCH_STARTER_OUT}", flush=True)


if __name__ == "__main__":
    main()
