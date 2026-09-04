"""확정 결장 선수의 팀별 몫 집계 -> departure_impact_team / departure_impact_player (2026-09-05).

## 왜 미리 굽는가
courtside-web/lib/departureImpact.ts 가 처음엔 이 계산을 페이지에서 직접 했다. 그런데 분모가
"직전 시즌 팀 합계"라 game_player_stats 6,480행을 매 요청마다 끌어와야 했고, 개막 리포트
서버 렌더가 1초에서 9초로 늘었다(실측 2026-09-05). 값 자체는 끝난 시즌 + 사람이 확인한 명단이라
절대 변하지 않으니, 여기서 한 번 접어 두고 웹은 팀 10행 + 선수 13행만 읽는다.

## 무엇을 세는가 / 세지 않는가
세는 것: 나눗셈뿐이다. "이 선수들이 직전 시즌 그 팀 합계에서 차지하던 몫."
세지 않는 것: 전력 예측. 15시즌 137개 팀-시즌 전환 실측에서 이탈 출전시간 비중으로 다음 시즌
득실차 변화를 설명한 R²가 0.001이었다(PER 기반 손실가치로도 0.071). 그래서 이 표에는 승수로
환산될 수 있는 컬럼을 의도적으로 두지 않는다.

## 함정 세 가지(전부 아래 코드가 처리)
1. game_player_stats에 결장 행(min_played=0)이 섞여 있다. 경기 수를 행 수로 세면 문가온이
   20경기 출전으로 찍힌다(실제 5경기). gp와 gp_played를 나눠 센다.
2. 직전 시즌 출전이 0인 이탈자가 있다(두경민 - 24-25가 마지막). 몫이 0.0%가 되는데 이건
   "잃은 게 없다"가 아니라 "이 방식으로는 잴 수 없다"이다. zero_kind로 구분한다.
3. 외국인·아시아쿼터는 pos가 비어 있어 포지션 분모에 안 들어간다. 그래서 포지션 몫은
   "같은 분류(국내 GD/FD/C) 안에서"라고 화면이 밝혀야 한다.

## 사용
    python build_departure_impact.py --season 2026-2027
    python build_departure_impact.py --season 2026-2027 --dry-run
"""
import argparse
import os
import sys
from collections import defaultdict

import psycopg2
from psycopg2.extras import execute_values

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_roster import load_database_url  # noqa: E402

SEASON_CATEGORY = "정규시즌"
# "로스터가 얇다"를 인원수가 아니라 이 문턱으로 센다 - 인원수만 보면 이탈 0인 팀이 더 얇아 보인다.
PROVEN_MINUTES = 500
STAT_KEYS = ("minutes", "pts", "reb", "ast", "stl", "blk", "fga", "tpa")

DDL = """
create table if not exists departure_impact_team (
  season_name  text not null,
  tcode        text not null,
  lost_minutes numeric not null, lost_pts numeric not null, lost_reb numeric not null,
  lost_ast     numeric not null, lost_stl numeric not null, lost_blk numeric not null,
  lost_fga     numeric not null, lost_tpa numeric not null,
  tot_minutes  numeric not null, tot_pts numeric not null, tot_reb numeric not null,
  tot_ast      numeric not null, tot_stl numeric not null, tot_blk numeric not null,
  tot_fga      numeric not null, tot_tpa numeric not null,
  starts       int not null,
  start_slots  int not null,
  top_pos      text,
  top_pos_lost_minutes numeric,
  top_pos_minutes      numeric,
  top_pos_lost_pts     numeric,
  top_pos_pts          numeric,
  zero_kind    text,
  roster_n     int not null,
  proven_n     int not null,
  primary key (season_name, tcode)
);

create table if not exists departure_impact_player (
  season_name  text not null,
  pcode        text not null,
  player_name  text not null,
  tcode        text not null,
  reason       text not null,
  detail       text,
  played       boolean not null,
  gp           int not null,
  gp_played    int not null,
  starts       int not null,
  minutes      numeric not null,
  pts          numeric not null,
  reb          numeric not null,
  ast          numeric not null,
  pos          text,
  minutes_rank int,
  team_players int not null,
  primary key (season_name, pcode)
);
"""


def ensure_policy(cur, table):
    cur.execute("alter table %s enable row level security" % table)
    cur.execute("select 1 from pg_policies where tablename = %s and policyname = %s",
                (table, "public read " + table))
    if not cur.fetchone():
        cur.execute('create policy "public read %s" on %s for select using (true)' % (table, table))


def prev_season(season):
    a = int(season.split("-")[0])
    return "%d-%d" % (a - 1, a)


def zeros():
    return {k: 0.0 for k in STAT_KEYS}


def add(dst, src):
    for k in STAT_KEYS:
        dst[k] += src[k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default="2026-2027")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    season = args.season
    prev = prev_season(season)

    conn = psycopg2.connect(load_database_url())
    cur = conn.cursor()

    cur.execute("select pcode, player_name, tcode, reason, detail from roster_departure where season_name = %s",
                (season,))
    deps = {r[0]: {"name": r[1], "tcode": r[2], "reason": r[3], "detail": r[4]} for r in cur.fetchall()}
    if not deps:
        sys.exit("roster_departure에 %s 행이 없다 - load_departures.py 먼저" % season)

    # 분모는 직전 시즌 정규시즌뿐이다. 플레이오프는 팀마다 경기 수가 달라 "팀 합계 대비 몫"의
    # 분모가 팀마다 다른 뜻이 된다.
    cur.execute("select gmkey, home_tcode, away_tcode from games "
                "where season_name = %s and season_category = %s and is_ended = true",
                (prev, SEASON_CATEGORY))
    games = cur.fetchall()
    if not games:
        sys.exit("%s %s 경기가 없다" % (prev, SEASON_CATEGORY))
    gmkeys = [g[0] for g in games]
    team_games = defaultdict(int)
    for _, h, a in games:
        team_games[h] += 1
        team_games[a] += 1

    cur.execute("""select pcode, tcode, pos, is_starter, min_played, pts, reb, ast, stl, blk, fga, tpa
                     from game_player_stats where gmkey = any(%s)""", (gmkeys,))
    rows = cur.fetchall()
    print("%s %s: %d경기 · 선수 행 %d" % (prev, SEASON_CATEGORY, len(games), len(rows)))

    team_tot = defaultdict(zeros)
    pos_tot = defaultdict(zeros)                       # (tcode, pos)
    per = {}                                           # pcode -> agg
    for pcode, tcode, pos, starter, mn, pts, reb, ast, stl, blk, fga, tpa in rows:
        one = {
            "minutes": float(mn or 0), "pts": float(pts or 0), "reb": float(reb or 0),
            "ast": float(ast or 0), "stl": float(stl or 0), "blk": float(blk or 0),
            # 이 DB의 fga는 2점 전용이라 총 야투시도는 둘의 합이다
            "fga": float(fga or 0) + float(tpa or 0), "tpa": float(tpa or 0),
        }
        add(team_tot[tcode], one)
        pos = (pos or "").strip() or None
        if pos:
            add(pos_tot[(tcode, pos)], one)
        a = per.get(pcode)
        if a is None:
            a = per[pcode] = {"tcode": tcode, "pos": pos, "gp": 0, "gp_played": 0, "starts": 0, "s": zeros()}
        a["gp"] += 1
        if one["minutes"] > 0:
            a["gp_played"] += 1
        if starter:
            a["starts"] += 1
        if not a["pos"] and pos:
            a["pos"] = pos
        add(a["s"], one)

    # 팀 내 출전시간 순위(이탈자가 그 팀에서 몇 번째로 많이 뛴 선수였나)
    rank_of, size_of = {}, {}
    by_team = defaultdict(list)
    for pcode, a in per.items():
        by_team[a["tcode"]].append(pcode)
    for tcode, members in by_team.items():
        members.sort(key=lambda p: -per[p]["s"]["minutes"])
        for i, p in enumerate(members):
            rank_of[p] = i + 1
            size_of[p] = len(members)

    # 이탈 제외 후 등록 인원 + 직전 시즌 검증된(500분+) 인원
    cur.execute("select tcode, pcode from season_roster where season_name = %s", (season,))
    roster_n, proven_n = defaultdict(int), defaultdict(int)
    for tcode, pcode in cur.fetchall():
        if pcode and pcode in deps:
            continue  # 명부에 남아 있다고 전력이 아니다
        roster_n[tcode] += 1
        if pcode and per.get(pcode, {}).get("s", {}).get("minutes", 0) >= PROVEN_MINUTES:
            proven_n[tcode] += 1

    player_rows, lost_team, lost_pos, starts_team = [], defaultdict(zeros), defaultdict(zeros), defaultdict(int)
    for pcode, d in sorted(deps.items()):
        a = per.get(pcode)
        s = a["s"] if a else zeros()
        player_rows.append((
            season, pcode, d["name"], d["tcode"], d["reason"], d["detail"],
            bool(a and a["gp_played"] > 0), a["gp"] if a else 0, a["gp_played"] if a else 0,
            a["starts"] if a else 0, round(s["minutes"], 2), round(s["pts"], 1),
            round(s["reb"], 1), round(s["ast"], 1), a["pos"] if a else None,
            rank_of.get(pcode), size_of.get(pcode, 0),
        ))
        if not a:
            continue
        # 몫은 "그 선수가 실제로 뛴 팀" 기준으로 쌓는다(시즌 중 이적자 대비).
        add(lost_team[a["tcode"]], s)
        starts_team[a["tcode"]] += a["starts"]
        if a["pos"]:
            add(lost_pos[(a["tcode"], a["pos"])], s)

    team_rows = []
    for tcode, tot in sorted(team_tot.items()):
        lost = lost_team.get(tcode, zeros())
        mine = [p for p in deps.values() if p["tcode"] == tcode]
        # 같은 분류 안에서 가장 크게 빈 포지션 - 총량이 아니라 여기가 "메울 사람이 있나"를 말한다.
        top = None
        for (tc, pos), lp in lost_pos.items():
            if tc != tcode:
                continue
            pt = pos_tot.get((tc, pos))
            if not pt or pt["minutes"] <= 0:
                continue
            share = lp["minutes"] / pt["minutes"]
            if top is None or share > top[0]:
                top = (share, pos, lp["minutes"], pt["minutes"], lp["pts"], pt["pts"])
        zero_kind = None if lost["minutes"] > 0 else ("none" if not mine else "notPlayed")
        team_rows.append((
            season, tcode,
            *[round(lost[k], 2) for k in STAT_KEYS],
            *[round(tot[k], 2) for k in STAT_KEYS],
            starts_team.get(tcode, 0), team_games.get(tcode, 0) * 5,
            top[1] if top else None,
            round(top[2], 2) if top else None, round(top[3], 2) if top else None,
            round(top[4], 1) if top else None, round(top[5], 1) if top else None,
            zero_kind, roster_n.get(tcode, 0), proven_n.get(tcode, 0),
        ))

    order = sorted(team_rows, key=lambda r: -(r[2] / r[10] if r[10] else 0))
    for r in order:
        share = r[2] / r[10] if r[10] else 0
        print("  %-4s 출전시간 %5.1f%% · 득점 %5.1f%% · 선발 %5.1f%% · 자리 %s" % (
            r[1], share * 100, (r[3] / r[11] * 100) if r[11] else 0,
            (r[18] / r[19] * 100) if r[19] else 0,
            ("%s %.1f%%" % (r[20], r[21] / r[22] * 100)) if r[20] else "-"))
    print("선수 %d행 · 팀 %d행" % (len(player_rows), len(team_rows)))

    if args.dry_run:
        conn.close()
        return

    cur.execute(DDL)
    ensure_policy(cur, "departure_impact_team")
    ensure_policy(cur, "departure_impact_player")
    cur.execute("delete from departure_impact_team where season_name = %s", (season,))
    cur.execute("delete from departure_impact_player where season_name = %s", (season,))
    execute_values(cur, """insert into departure_impact_team
        (season_name, tcode, lost_minutes, lost_pts, lost_reb, lost_ast, lost_stl, lost_blk,
         lost_fga, lost_tpa, tot_minutes, tot_pts, tot_reb, tot_ast, tot_stl, tot_blk, tot_fga,
         tot_tpa, starts, start_slots, top_pos, top_pos_lost_minutes, top_pos_minutes,
         top_pos_lost_pts, top_pos_pts, zero_kind, roster_n, proven_n) values %s""", team_rows)
    execute_values(cur, """insert into departure_impact_player
        (season_name, pcode, player_name, tcode, reason, detail, played, gp, gp_played, starts,
         minutes, pts, reb, ast, pos, minutes_rank, team_players) values %s""", player_rows)
    conn.commit()
    print("저장 완료")
    conn.close()


if __name__ == "__main__":
    main()
