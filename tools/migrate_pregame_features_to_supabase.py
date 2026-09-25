"""
raw/analysis/pregame_training_table.json(export_training_table.py가 만든 리크프리 팀
지표, 4182행)을 Supabase pregame_features 테이블로 이관 - courtside-web의 프리뷰 인사이트
(lib/pregameInsights.ts)가 쓸 원본 데이터. courtside_template.html의
load_pregame_detail()이 이미 이 JSON에서 뽑아 쓰던 필드 중, courtside_template.html의
pregameInsightItems()가 실제로 읽는 필드만(전부가 아니라) 스코프를 좁혀서 옮김 - 안 쓰는
필드까지 옮기면 낭비.

실행 준비: tools/migrate_to_supabase.py와 동일(DATABASE_URL 환경변수, psycopg2-binary).
pregame_features 테이블은 Supabase MCP apply_migration으로 이미 생성됨(add_pregame_features).

전부 ON CONFLICT DO UPDATE라 안전하게 재실행 가능.
"""
import argparse
import json
import os
import sys

from cache_invalidate import revalidate

BASE = os.path.dirname(os.path.abspath(__file__))
SRC_PATH = os.path.join(BASE, "..", "raw", "analysis", "pregame_training_table.json")

BATCH_SIZE = 2000

# (Postgres 컬럼 접미사, JSON의 home_/away_ 뒤에 붙는 camelCase 키) - 값이 없는 필드는
# .get()이 None을 반환해서 NULL로 안전하게 들어감.
FIELDS = [
    ("reb_rt", "rebRt"),
    ("tov_rt", "tovRt"),
    ("ts_rt", "tsRt"),
    ("pace", "pace"),
    ("last3_netrtg", "last3_netrtg"),
    ("last10_netrtg", "last10_netrtg"),
    ("venue_netrtg", "venueNetRtg"),
    ("netrtg", "netrtg"),
    # 2026-09-02 Phase 1 추가 - 라이브 승률 모델(live_winprob_model.joblib)의 5개 피처 중
    # synergyDiff의 원천. 원래 이 목록은 "프리뷰 UI가 읽는 필드만" 스코프였는데, 라이브
    # 수집기(live_collector.py)가 경기 중 매 이벤트마다 이 값을 필요로 함 - DB에 없으면
    # 0으로 추론하게 되고 실측상 승률이 11~13%p 어긋남(경기 종료 후 배치 재계산 시 승률이
    # 툭 튀어 보임). FIELDS 한 줄이 migrate/sync 양쪽 컬럼 목록을 동시에 결정하므로
    # sync_upcoming_games.py(예정 경기)도 이 줄만으로 같이 채워짐.
    ("synergy_onoff_rating", "synergyOnOffRating"),
    ("roster_continuity", "rosterContinuity"),
    ("run_vuln_big_runs", "runVulnBigRuns"),
    ("foreign_concentration", "foreignConcentration"),
    ("foreign_player_count", "foreignPlayerCount"),
    ("avg_height_cm", "avgHeightCm"),
    ("avg_vertical_jump_cm", "avgVerticalJumpCm"),
    ("vertical_jump_coverage", "verticalJumpCoverage"),
]


def get_conn():
    try:
        import psycopg2
    except ImportError:
        print("psycopg2가 없음 - .venv에 pip install psycopg2-binary 먼저", file=sys.stderr)
        sys.exit(1)
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL 환경변수가 없음", file=sys.stderr)
        sys.exit(1)
    return psycopg2.connect(url)


def batched(rows, size=BATCH_SIZE):
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


def build_rows(data, limit=None):
    rows = []
    for entry in data[:limit] if limit else data:
        gmkey = entry["gmkey"]
        home, away = entry.get("home") or {}, entry.get("away") or {}
        row = [gmkey]
        for _, src_key in FIELDS:
            row.append(home.get(f"home_{src_key}"))
            row.append(away.get(f"away_{src_key}"))
        rows.append(tuple(row))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="테스트용 - 앞에서부터 N경기만 이관")
    args = ap.parse_args()

    with open(SRC_PATH, encoding="utf-8") as f:
        data = json.load(f)
    rows = build_rows(data, args.limit)
    print(f"{len(rows)}경기 이관 준비 완료")

    conn = get_conn()
    try:
        cur = conn.cursor()
        from psycopg2.extras import execute_values
        cols = ["gmkey"]
        for pg_key, _ in FIELDS:
            cols.append(f"home_{pg_key}")
            cols.append(f"away_{pg_key}")
        update_cols = [c for c in cols if c != "gmkey"]
        set_clause = ", ".join(f"{c}=excluded.{c}" for c in update_cols)
        for chunk in batched(rows):
            execute_values(cur, f"""
                insert into pregame_features ({", ".join(cols)}) values %s
                on conflict (gmkey) do update set {set_clause}
            """, chunk)
            conn.commit()
        print(f"완료 - pregame_features {len(rows)}행 적재")
        revalidate(["manual:build", "batch:daily"])
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
