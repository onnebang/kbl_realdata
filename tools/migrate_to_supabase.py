"""
로컬 raw/ 데이터 + raw/kbl_realdata.db(SQLite, lineup_stints 계산이 이미 끝나있음)를
tools/schema_supabase.sql로 만든 Postgres(Supabase) 테이블로 옮김.

이번 스크립트 범위 안:
  teams, coaches, seasons, players, games, game_team_stats, game_player_stats,
  shot_log, lineup_stints

이번 스크립트 범위 밖(README 28차/이번 커밋 메시지 참고):
  - game_events(플레이바이플레이 + 승률 타임라인) - 4207경기 전체에 승률모델
    (live_winprob_model.joblib)을 다시 돌려야 하는 별개의(훨씬 무거운, 모델 추론이 필요한)
    작업이라 단순 데이터 이관과 성격이 다름. 별도 스크립트로 나중에.
  - raw/schedule의 "아직 안 치른 예정 경기" - games 테이블 설계상 담을 수 있지만
    이번엔 raw/games(완료 경기)만 이관. 예정 경기는 박스스코어가 없어서 훨씬 간단한
    별도 스크립트로 추가 가능.
  - 팀 로고 / 선수 사진 Supabase Storage 업로드 - SQL INSERT가 아니라 Storage API
    호출이라 이 스크립트(psycopg2로 DB에만 씀)와 성격이 다름.

실행 준비:
  1. `pip install psycopg2-binary` (.venv에 없으면 새로 설치 - 이 스크립트만 필요)
  2. tools/schema_supabase.sql을 Supabase SQL Editor에서 먼저 실행(테이블 생성)
  3. Supabase 프로젝트 설정 > Database > Connection string(URI, "Session pooler" 권장 -
     배치 스크립트처럼 짧고 굵게 여러 연결을 여는 게 아니라 하나로 오래 쓰는 경우엔
     Session/Direct 쪽이 Transaction pooler보다 안정적)을 DATABASE_URL 환경변수로 설정
  4. `python tools/migrate_to_supabase.py --limit 20` 으로 소량 먼저 검증 후
     `python tools/migrate_to_supabase.py` 전체 실행

전부 ON CONFLICT DO NOTHING/DO UPDATE라 안전하게 재실행 가능 - 중간에 연결이 끊겨도
그냥 다시 돌리면 이미 들어간 행은 건너뛰고 이어감.
"""
import argparse
import json
import os
import sqlite3
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
SQLITE_PATH = os.path.join(BASE, "..", "raw", "kbl_realdata.db")

BATCH_SIZE = 2000

# build_live_replay_demo.py / build_scoring_distribution.py 등과 동일한 팀 메타(실제
# 구단컬러, 2026-08-25 재확인됨) - 이 프로젝트 전체에서 반복되는 값이라 그대로 재사용.
TEAM_META = {
    "06": {"abbr": "KT", "color": "#1A1A1A", "name": "수원 KT"},
    "10": {"abbr": "MOB", "color": "#A6192E", "name": "울산 현대모비스"},
    "16": {"abbr": "DB", "color": "#1C8A43", "name": "원주 DB"},
    "30": {"abbr": "GOY", "color": "#1E2749", "name": "고양 오리온스"},
    "35": {"abbr": "SAM", "color": "#1428A0", "name": "서울 삼성"},
    "55": {"abbr": "SK", "color": "#E4002B", "name": "서울 SK"},
    "60": {"abbr": "KCC", "color": "#0C2340", "name": "전주 KCC"},
    "64": {"abbr": "GAS", "color": "#0072CE", "name": "대구 한국가스공사"},
    "65": {"abbr": "EL", "color": "#0060AF", "name": "인천 전자랜드"},
    "66": {"abbr": "SONO", "color": "#3FA9F5", "name": "고양 소노"},
    "70": {"abbr": "KGC", "color": "#C8102E", "name": "안양 정관장"},
    "50": {"abbr": "LG", "color": "#8E1B3D", "name": "창원 LG"},
    "73": {"abbr": "CRT", "color": "#FF6B00", "name": "고양 캐롯"},
}


def get_conn():
    try:
        import psycopg2
    except ImportError:
        print("psycopg2가 없음 - 이 스크립트를 실행할 파이썬 환경에 "
              "`pip install psycopg2-binary` 먼저 실행하세요.", file=sys.stderr)
        sys.exit(1)
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL 환경변수가 없음 - Supabase 프로젝트 설정 > Database > "
              "Connection string(URI)을 복사해서 설정한 뒤 다시 실행하세요.", file=sys.stderr)
        sys.exit(1)
    return psycopg2.connect(url)


def batched(rows, size=BATCH_SIZE):
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


# ---------------------------------------------------------------------------
# raw/games 단일 스캔 - meta.json/team-record.json/player-stat.json/match-chart.json을
# 여러 함수가 각자 다시 열지 않도록 한 번만 읽고 필요한 걸 전부 이 자리에서 뽑음
# (build_team_timelines_for_trend() 등에서 이미 쓰던 "한 번 스캔, 여러 결과" 패턴).
# ---------------------------------------------------------------------------

def scan_all(limit=None):
    gmkeys = sorted(os.listdir(GAMES_DIR))
    if limit:
        gmkeys = gmkeys[:limit]

    coach_names = set()
    seasons = {}                     # season_name -> season_code
    players = {}                     # pcode -> (name, ename)
    games_rows = []                  # (gmkey, season_name, season_category, game_date,
                                      #  game_start, home_tcode, away_tcode, home_coach,
                                      #  away_coach, home_score, away_score, is_ended,
                                      #  stadium, attendance)
    team_stats_rows = []              # game_team_stats
    player_stats_rows = []            # game_player_stats
    shot_rows = []                    # shot_log

    print(f"{len(gmkeys)}경기 스캔 시작...", flush=True)
    for i, gk in enumerate(gmkeys, 1):
        d = os.path.join(GAMES_DIR, gk)
        meta_path = os.path.join(d, "meta.json")
        tr_path = os.path.join(d, "team-record.json")
        pstat_path = os.path.join(d, "player-stat.json")
        chart_path = os.path.join(d, "match-chart.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        g = meta["game"]
        season_name, season_code = g.get("seasonName"), g.get("seasonCode")
        home_tcode, away_tcode = g.get("tcodeH"), g.get("tcodeA")
        if not season_name or not home_tcode or not away_tcode:
            continue
        seasons[season_name] = season_code

        home_coach = meta.get("teams", {}).get("home", {}).get("staffs", {}).get("manager", {}).get("name")
        away_coach = meta.get("teams", {}).get("away", {}).get("staffs", {}).get("manager", {}).get("name")
        if home_coach:
            coach_names.add(home_coach)
        if away_coach:
            coach_names.add(away_coach)

        game_date = f"{g['gameDate'][:4]}-{g['gameDate'][4:6]}-{g['gameDate'][6:8]}" if g.get("gameDate") else None
        game_start = None
        gs = g.get("gameStart")
        if gs and len(gs) == 4:
            game_start = f"{gs[:2]}:{gs[2:]}:00"

        # meta.json엔 스코어 필드가 없음(확인함 - gameDate/tcodeH/tcodeA 등은 있는데
        # scoreH/scoreA는 없음) - 최종 스코어는 team-record.json의 팀별 records.score에서
        # 가져와야 해서, games 행을 만들기 전에 team-record.json부터 읽음.
        home_score = away_score = None
        if os.path.exists(tr_path):
            with open(tr_path, encoding="utf-8") as f:
                tr = json.load(f)
            for row in tr:
                tcode, r = row.get("tcode"), row.get("records", {})
                if not tcode:
                    continue
                if tcode == home_tcode:
                    home_score = r.get("score")
                elif tcode == away_tcode:
                    away_score = r.get("score")
                team_stats_rows.append((
                    gk, tcode, r.get("score"), r.get("rb"), r.get("ast"), r.get("stl"), r.get("bs"),
                    r.get("to"), r.get("foul"),
                    r.get("fg"), r.get("fgA"), r.get("threep"), r.get("threepA"), r.get("ft"), r.get("ftA"),
                    r.get("offrtg"), r.get("defrtg"), r.get("netrtg"), r.get("pace"), r.get("poss"),
                    r.get("efgRt"), r.get("tsRt"), r.get("astRt"), r.get("orebRt"), r.get("drebRt"), r.get("tovRt"),
                ))

        games_rows.append((
            gk, season_name, g.get("seasonCategoryName"), game_date, game_start,
            home_tcode, away_tcode, home_coach, away_coach,
            home_score, away_score, bool(g.get("isEnded")),
            g.get("stadiumname"), g.get("crowds"),
        ))

        if os.path.exists(pstat_path):
            with open(pstat_path, encoding="utf-8") as f:
                pstat = json.load(f)
            for row in pstat:
                p, r = row["player"], row.get("records", {})
                pcode = p.get("pcode")
                if not pcode:
                    continue
                players[pcode] = (p.get("pname"), p.get("ename"))
                min_played = round((r.get("playMin", 0) or 0) + (r.get("playSec", 0) or 0) / 60, 2)
                player_stats_rows.append((
                    gk, pcode, p.get("tcode"), p.get("backNum"), p.get("pos"),
                    bool(row.get("startFlag")), min_played,
                    r.get("score"), r.get("rb"), r.get("ast"), r.get("stl"), r.get("bs"),
                    r.get("to"), r.get("foul"),
                    r.get("fg"), r.get("fgA"), r.get("threep"), r.get("threepA"), r.get("ft"), r.get("ftA"),
                    r.get("per"), r.get("offrtg"), r.get("defrtg"), r.get("netrtg"), r.get("usgRt"), r.get("pie"),
                ))

        if os.path.exists(chart_path):
            with open(chart_path, encoding="utf-8") as f:
                chart = json.load(f)
            for player in chart.get("shootLog", []):
                pcode, tcode = player.get("pcode"), player.get("tcode")
                if not pcode or not tcode:
                    continue
                for order, log in enumerate(player.get("logs", [])):
                    shot_rows.append((
                        gk, pcode, tcode, log.get("q"), order,
                        log.get("x"), log.get("y"), log.get("d"), log.get("o") == "O",
                    ))

        if i % 500 == 0:
            print(f"  스캔 {i}/{len(gmkeys)}...", flush=True)

    print(f"스캔 완료 - 경기 {len(games_rows)}, 팀박스 {len(team_stats_rows)}, "
          f"선수박스 {len(player_stats_rows)}, 슛 {len(shot_rows)}, 선수 {len(players)}명, "
          f"감독 {len(coach_names)}명", flush=True)
    return {
        "coach_names": coach_names, "seasons": seasons, "players": players,
        "games_rows": games_rows, "team_stats_rows": team_stats_rows,
        "player_stats_rows": player_stats_rows, "shot_rows": shot_rows,
    }


# ---------------------------------------------------------------------------
# Postgres 적재 - FK 순서대로: teams -> coaches -> seasons -> players -> games ->
# game_team_stats -> game_player_stats -> shot_log -> lineup_stints(SQLite에서)
# ---------------------------------------------------------------------------

def load_teams(cur):
    from psycopg2.extras import execute_values
    rows = [(tc, m["name"], m["abbr"], m["color"]) for tc, m in TEAM_META.items()]
    execute_values(cur, """
        insert into teams (tcode, name, abbr, color) values %s
        on conflict (tcode) do update set name=excluded.name, abbr=excluded.abbr, color=excluded.color
    """, rows)
    print(f"teams: {len(rows)}행 적재")


def load_coaches(cur, coach_names):
    from psycopg2.extras import execute_values
    rows = [(n,) for n in sorted(coach_names)]
    for chunk in batched(rows):
        execute_values(cur, "insert into coaches (name) values %s on conflict (name) do nothing", chunk)
    cur.execute("select name, coach_id from coaches")
    name_to_id = dict(cur.fetchall())
    print(f"coaches: {len(rows)}명 적재")
    return name_to_id


def load_seasons(cur, seasons):
    from psycopg2.extras import execute_values
    rows = [(name, code) for name, code in seasons.items()]
    execute_values(cur, """
        insert into seasons (season_name, season_code) values %s
        on conflict (season_name) do update set season_code=excluded.season_code
    """, rows)
    print(f"seasons: {len(rows)}개 적재")


def load_players(cur, players):
    from psycopg2.extras import execute_values
    rows = [(pcode, name, ename) for pcode, (name, ename) in players.items()]
    for chunk in batched(rows):
        execute_values(cur, """
            insert into players (pcode, name, ename) values %s
            on conflict (pcode) do update set name=excluded.name, ename=excluded.ename
        """, chunk)
    print(f"players: {len(rows)}명 적재")


def load_games(cur, games_rows, coach_name_to_id):
    from psycopg2.extras import execute_values
    rows = []
    for (gk, season_name, season_category, game_date, game_start, home_tcode, away_tcode,
         home_coach, away_coach, home_score, away_score, is_ended, stadium, attendance) in games_rows:
        rows.append((
            gk, season_name, season_category, game_date, game_start, home_tcode, away_tcode,
            coach_name_to_id.get(home_coach), coach_name_to_id.get(away_coach),
            home_score, away_score, is_ended, stadium, attendance,
        ))
    for chunk in batched(rows):
        execute_values(cur, """
            insert into games (gmkey, season_name, season_category, game_date, game_start,
                home_tcode, away_tcode, home_coach_id, away_coach_id, home_score, away_score,
                is_ended, stadium, attendance) values %s
            on conflict (gmkey) do nothing
        """, chunk)
    print(f"games: {len(rows)}경기 적재")


def load_team_stats(cur, rows):
    from psycopg2.extras import execute_values
    for chunk in batched(rows):
        execute_values(cur, """
            insert into game_team_stats (gmkey, tcode, score, reb, ast, stl, blk, turnovers, fouls,
                fgm, fga, tpm, tpa, ftm, fta, off_rtg, def_rtg, net_rtg, pace, poss,
                efg_pct, ts_pct, ast_pct, oreb_pct, dreb_pct, tov_pct) values %s
            on conflict (gmkey, tcode) do nothing
        """, chunk)
    print(f"game_team_stats: {len(rows)}행 적재")


def load_player_stats(cur, rows):
    from psycopg2.extras import execute_values
    for chunk in batched(rows):
        execute_values(cur, """
            insert into game_player_stats (gmkey, pcode, tcode, back_num, pos, is_starter, min_played,
                pts, reb, ast, stl, blk, turnovers, fouls,
                fgm, fga, tpm, tpa, ftm, fta, per, off_rtg, def_rtg, net_rtg, usage_rtg, pie) values %s
            on conflict (gmkey, pcode) do nothing
        """, chunk)
    print(f"game_player_stats: {len(rows)}행 적재")


def load_shots(cur, rows):
    from psycopg2.extras import execute_values
    for chunk in batched(rows):
        execute_values(cur, """
            insert into shot_log (gmkey, pcode, tcode, quarter, shot_order, x, y, d, made) values %s
            on conflict (gmkey, pcode, shot_order) do nothing
        """, chunk)
    print(f"shot_log: {len(rows)}행 적재")


def load_lineup_stints(cur, limit_gmkeys=None):
    """이미 계산 끝난 raw/kbl_realdata.db(SQLite)의 lineup_stints를 그대로 가져옴 - 스틴트
    세그멘테이션 로직을 다시 짤 필요 없음. 콤마 문자열(SQLite엔 배열 타입이 없어서) ->
    Postgres 배열로 변환."""
    from psycopg2.extras import execute_values
    if not os.path.exists(SQLITE_PATH):
        print("raw/kbl_realdata.db 없음 - lineup_stints는 건너뜀", file=sys.stderr)
        return
    con = sqlite3.connect(SQLITE_PATH)
    cur_sq = con.cursor()
    query = "select gmkey, home_lineup, away_lineup, quarters, start_sec, end_sec, duration_sec, home_pts, away_pts from lineup_stints"
    params = ()
    if limit_gmkeys:
        placeholders = ",".join("?" * len(limit_gmkeys))
        query += f" where gmkey in ({placeholders})"
        params = tuple(limit_gmkeys)
    cur_sq.execute(query, params)
    rows = []
    for gmkey, home_lineup, away_lineup, quarters, start_sec, end_sec, duration_sec, home_pts, away_pts in cur_sq.fetchall():
        rows.append((
            gmkey, home_lineup.split(","), away_lineup.split(","), quarters.split(","),
            start_sec, end_sec, duration_sec, home_pts, away_pts,
        ))
    con.close()
    for chunk in batched(rows):
        execute_values(cur, """
            insert into lineup_stints (gmkey, home_lineup, away_lineup, quarters,
                start_sec, end_sec, duration_sec, home_pts, away_pts) values %s
            on conflict (gmkey, start_sec, end_sec, home_lineup, away_lineup) do nothing
        """, chunk)
    print(f"lineup_stints: {len(rows)}행 적재")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="테스트용 - 앞에서부터 N경기만 이관")
    ap.add_argument("--skip-lineups", action="store_true", help="lineup_stints 단계 건너뛰기(가장 큰 테이블 - 110K행)")
    args = ap.parse_args()

    data = scan_all(limit=args.limit)

    conn = get_conn()
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            load_teams(cur)
            coach_map = load_coaches(cur, data["coach_names"])
            load_seasons(cur, data["seasons"])
            load_players(cur, data["players"])
            load_games(cur, data["games_rows"], coach_map)
            load_team_stats(cur, data["team_stats_rows"])
            load_player_stats(cur, data["player_stats_rows"])
            load_shots(cur, data["shot_rows"])
            if not args.skip_lineups:
                limit_gmkeys = [r[0] for r in data["games_rows"]] if args.limit else None
                load_lineup_stints(cur, limit_gmkeys=limit_gmkeys)
        conn.commit()
        print("전체 커밋 완료.")
    except Exception:
        conn.rollback()
        print("에러 발생 - 롤백함. 위 트레이스백 확인 후 다시 실행하면 이미 커밋된(이전 실행)"
              " 행은 ON CONFLICT로 건너뛰고 이어감.", file=sys.stderr)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
