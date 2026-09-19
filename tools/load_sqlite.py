"""
raw/games, raw/stints -> schema_kbl_realdata.sql 기반 SQLite DB로 적재 (로드맵 04단계).
전체 재적재 방식(기존 DB 파일 삭제 후 새로 생성) - 데이터가 아직 몇 GB 안 되고 매번
처음부터 다시 만드는 게 증분 upsert 로직 짜는 것보다 지금 단계에선 훨씬 간단하고 안전함.

백투백/휴식일수는 팀별로 실제 출전 경기 날짜를 정렬해서 직전 경기와의 날짜 차이로 계산.
"""
import datetime
import json
import os
import sqlite3

from build_synergy_matchup import cumulative_elapsed

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
STINTS_DIR = os.path.join(BASE, "..", "raw", "stints")
SCHEMA_PATH = os.path.join(BASE, "schema_kbl_realdata.sql")
DB_PATH = os.path.join(BASE, "..", "raw", "kbl_realdata.db")


def load_games_meta():
    rows = []
    for gmkey in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        g = meta["game"]
        tr = meta["teamrecords"]
        home_score = sum(tr["home"].get(f"scoreq{i}", 0) or 0 for i in (1, 2, 3, 4)) + sum(tr["home"].get("scoreeq") or [])
        away_score = sum(tr["away"].get(f"scoreq{i}", 0) or 0 for i in (1, 2, 3, 4)) + sum(tr["away"].get("scoreeq") or [])
        rows.append({
            "gmkey": gmkey,
            "season_code": g.get("seasonCode"),
            "season_name": g.get("seasonName"),
            "season_category": g.get("seasonCategoryName"),
            "game_date": g.get("gameDate"),
            "home_tcode": g.get("tcodeH"),
            "away_tcode": g.get("tcodeA"),
            "home_name": g.get("tnameH"),
            "away_name": g.get("tnameA"),
            "home_score": home_score,
            "away_score": away_score,
            "stadium": g.get("stadiumname"),
            "attendance": g.get("crowds"),
        })
    return rows


def compute_rest_days(games):
    """팀코드 -> [game_date 정렬] 로 직전 경기와의 휴식일수 계산."""
    by_team = {}
    for g in games:
        for side in ("home_tcode", "away_tcode"):
            by_team.setdefault(g[side], []).append(g["game_date"])
    for t in by_team:
        by_team[t] = sorted(set(by_team[t]))

    def rest_for(tcode, date_str):
        dates = by_team[tcode]
        idx = dates.index(date_str)
        if idx == 0:
            return None
        d0 = datetime.datetime.strptime(dates[idx - 1], "%Y%m%d")
        d1 = datetime.datetime.strptime(date_str, "%Y%m%d")
        return (d1 - d0).days - 1

    for g in games:
        g["home_rest_days"] = rest_for(g["home_tcode"], g["game_date"])
        g["away_rest_days"] = rest_for(g["away_tcode"], g["game_date"])
    return games


def load_validation_flags():
    flags = {}
    for fn in os.listdir(STINTS_DIR):
        if not fn.endswith(".json") or fn.startswith("_"):
            continue
        with open(os.path.join(STINTS_DIR, fn), encoding="utf-8") as f:
            d = json.load(f)
        v = d.get("validation", {})
        flags[d["gmkey"]] = 1 if v.get("homeMatch") and v.get("awayMatch") else 0
    return flags


def main():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        schema_sql = f.read()

    conn = sqlite3.connect(DB_PATH)
    conn.executescript(schema_sql)

    print("경기 메타 로딩...", flush=True)
    games = load_games_meta()
    games = compute_rest_days(games)
    val_flags = load_validation_flags()
    conn.executemany(
        """INSERT INTO games (gmkey, season_code, season_name, season_category, game_date,
           home_tcode, away_tcode, home_name, away_name, home_score, away_score, stadium,
           attendance, home_rest_days, away_rest_days, score_validated)
           VALUES (:gmkey,:season_code,:season_name,:season_category,:game_date,:home_tcode,
           :away_tcode,:home_name,:away_name,:home_score,:away_score,:stadium,:attendance,
           :home_rest_days,:away_rest_days,:score_validated)""",
        [{**g, "score_validated": val_flags.get(g["gmkey"], 0)} for g in games],
    )
    print(f"  {len(games)}경기", flush=True)

    print("선수 경기 기록 로딩...", flush=True)
    pgs_count = 0
    for gmkey in [g["gmkey"] for g in games]:
        path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            rows = json.load(f)
        for row in rows:
            p = row["player"]
            r = row["records"]
            conn.execute(
                """INSERT OR REPLACE INTO player_game_stats
                   (gmkey,pcode,pname,tcode,home_away,start_flag,play_min,play_sec,
                    score,rb,ast,stl,bs,to_,fg,fg_a,threep,threep_a,ft,ft_a,foul,
                    offr,defr,dk,dk_a,fb,pp,pp_a,sast,dfl,
                    per,offrtg,defrtg,netrtg,efg_rt,ts_rt,usg_rt,pace,pie,
                    ast_rt,ast_to,oreb_rt,dreb_rt,tov_rt)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (gmkey, p["pcode"], p["pname"], p["tcode"], row.get("homeAway"), row.get("startFlag"),
                 r.get("playMin"), r.get("playSec"), r.get("score"), r.get("rb"), r.get("ast"),
                 r.get("stl"), r.get("bs"), r.get("to"), r.get("fg"), r.get("fgA"), r.get("threep"),
                 r.get("threepA"), r.get("ft"), r.get("ftA"), r.get("foul"), 
                 r.get("offr"), r.get("defr"), r.get("dk"), r.get("dkA"), r.get("fb"), r.get("pp"), r.get("ppA"), r.get("sast"), r.get("dfl"),
                 r.get("per"), r.get("offrtg"), r.get("defrtg"), r.get("netrtg"), r.get("efgRt"), r.get("tsRt"),
                 r.get("usgRt"), r.get("pace"), r.get("pie"),
                 r.get("astRt"), r.get("astTo"), r.get("orebRt"), r.get("drebRt"), r.get("tovRt")),
            )
            pgs_count += 1
    print(f"  {pgs_count}건", flush=True)

    print("슛차트 로딩...", flush=True)
    shot_count = 0
    for gmkey in [g["gmkey"] for g in games]:
        path = os.path.join(GAMES_DIR, gmkey, "match-chart.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            chart = json.load(f)
        for player_log in chart.get("shootLog", []):
            pcode, tcode = player_log["pcode"], player_log["tcode"]
            for log in player_log.get("logs", []):
                conn.execute(
                    "INSERT INTO shot_log (gmkey,pcode,tcode,quarter,x,y,made,zone) VALUES (?,?,?,?,?,?,?,?)",
                    (gmkey, pcode, tcode, log.get("q"), log.get("x"), log.get("y"),
                     1 if log.get("o") == "O" else 0, log.get("d")),
                )
                shot_count += 1
    print(f"  {shot_count}건", flush=True)

    print("라인업 스틴트 로딩...", flush=True)
    stint_count = 0
    for fn in os.listdir(STINTS_DIR):
        if not fn.endswith(".json") or fn.startswith("_"):
            continue
        with open(os.path.join(STINTS_DIR, fn), encoding="utf-8") as f:
            game = json.load(f)
        for s in game["stints"]:
            if not s.get("lineupValid"):
                continue
            start_sec = cumulative_elapsed(*s["startClock"])
            end_sec = cumulative_elapsed(*s["endClock"])
            duration = end_sec - start_sec
            if duration <= 0:
                continue
            conn.execute(
                """INSERT INTO lineup_stints (gmkey,home_lineup,away_lineup,quarters,
                   start_sec,end_sec,duration_sec,home_pts,away_pts) VALUES (?,?,?,?,?,?,?,?,?)""",
                (game["gmkey"], ",".join(s["homeLineup"]), ",".join(s["awayLineup"]),
                 ",".join(s["quarters"]), start_sec, end_sec, duration, s["homePts"], s["awayPts"]),
            )
            stint_count += 1
    print(f"  {stint_count}건", flush=True)

    conn.commit()
    conn.close()
    print(f"완료 -> {DB_PATH}", flush=True)


if __name__ == "__main__":
    main()
