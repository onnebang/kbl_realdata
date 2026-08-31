"""
raw/analysis/combo_{2,3,4,5}man.json + player_onoff.json(build_synergy_matchup.py가 이미
계산해둔 라인업 조합 통산 넷레이팅)을 Supabase lineup_combo / player_onoff 테이블로 이관.
courtside-web의 "라인업 조합 넷레이팅" 표시(lib/lineupNetRating.ts)가 쓸 원본 데이터.

실행 준비: tools/migrate_pregame_features_to_supabase.py와 동일(DATABASE_URL 환경변수 -
tools/.env.supabase, psycopg2-binary). lineup_combo/player_onoff 테이블은 Supabase MCP
apply_migration으로 이미 생성됨(add_lineup_combo_and_player_onoff, RLS + public-read 포함).

combo_key = 정렬된 pcode를 ','로 이어붙인 문자열 - build_synergy_matchup.py의
itertools.combinations(sorted(lineup), n)이 이미 정렬된 튜플을 만들어주므로 그대로 join만.

전부 ON CONFLICT DO UPDATE라 안전하게 재실행 가능.
"""
import argparse
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
BATCH_SIZE = 2000


def get_conn():
    try:
        import psycopg2
    except ImportError:
        print("psycopg2가 없음 - pip install psycopg2-binary 먼저", file=sys.stderr)
        sys.exit(1)
    # tools/migrate_pregame_features_to_supabase.py와 같은 방식 - DATABASE_URL은
    # tools/.env.supabase에 있음(python-dotenv로 로드, 없으면 os.environ 그대로 사용).
    try:
        from dotenv import load_dotenv
        load_dotenv(os.path.join(BASE, ".env.supabase"))
    except ImportError:
        pass
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL 환경변수가 없음(tools/.env.supabase 확인)", file=sys.stderr)
        sys.exit(1)
    return psycopg2.connect(url)


def batched(rows, size=BATCH_SIZE):
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


def migrate_combos(cur, conn, n):
    path = os.path.join(ANALYSIS_DIR, f"combo_{n}man.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    from psycopg2.extras import execute_values
    rows = []
    for entry in data:
        pcodes = entry["pcodes"]  # 이미 정렬됨(build_synergy_matchup.py의 combinations(sorted(...)))
        combo_key = ",".join(pcodes)
        rows.append((combo_key, pcodes, n, entry["seconds"], entry["minutes"], entry["stints"], entry["netRatingPer40"]))
    total = 0
    for chunk in batched(rows):
        execute_values(cur, """
            insert into lineup_combo (combo_key, pcodes, n, seconds, minutes, stints, net_rating_per40)
            values %s
            on conflict (combo_key) do update set
              seconds=excluded.seconds, minutes=excluded.minutes, stints=excluded.stints,
              net_rating_per40=excluded.net_rating_per40
        """, chunk)
        conn.commit()
        total += len(chunk)
    print(f"  combo_{n}man: {total}행 적재")


def migrate_player_onoff(cur, conn):
    path = os.path.join(ANALYSIS_DIR, "player_onoff.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    from psycopg2.extras import execute_values
    rows = [
        (e["pcode"], e["seconds"], e["minutes"], e["stints"], e["ptsFor"], e["ptsAgainst"], e["netRatingPer40"])
        for e in data
    ]
    for chunk in batched(rows):
        execute_values(cur, """
            insert into player_onoff (pcode, seconds, minutes, stints, pts_for, pts_against, net_rating_per40)
            values %s
            on conflict (pcode) do update set
              seconds=excluded.seconds, minutes=excluded.minutes, stints=excluded.stints,
              pts_for=excluded.pts_for, pts_against=excluded.pts_against, net_rating_per40=excluded.net_rating_per40
        """, chunk)
        conn.commit()
    print(f"  player_onoff: {len(rows)}행 적재")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["combos", "onoff"], default=None, help="테스트용 - 한쪽만 실행")
    args = ap.parse_args()

    conn = get_conn()
    try:
        cur = conn.cursor()
        if args.only != "onoff":
            for n in (2, 3, 4, 5):
                migrate_combos(cur, conn, n)
        if args.only != "combos":
            migrate_player_onoff(cur, conn)
        print("완료")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
