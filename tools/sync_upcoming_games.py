"""
예정 경기 Supabase 동기화 (Phase 0, 2026-09-02) - predict_upcoming_games.py는 예측을
raw/analysis/upcoming_predictions.json에만 쓰고 끝났는데, 코트사이드 웹이 "예정 경기"를
보여주려면 그 결과가 Supabase에 있어야 함. 이 스크립트는 predict_upcoming_games.py의
피처/예측 함수를 그대로 재사용해서(재작성 아님):

  1. KBL API 스케줄에서 아직 안 열린 경기(isEnded==0, R/PO/CU)를 가져와
  2. seasons -> games 순서로 UPSERT (스코어 NULL, is_ended=false = 상태규칙상 '예정'.
     상태 판정은 lib/gameStatus.ts가 home_score부터 보므로 is_ended 값 자체는 예정 경기에서
     의미가 없지만, "종료만 true" 규칙을 지키기 위해 false로 넣음)
  3. 경기 전 모델 승률 + 프리뷰 인사이트용 피처를 pregame_features에 UPSERT
     (home_win_prob 컬럼 - 종료 경기는 game_events의 event_order=0 행이 같은 역할이라
     이 컬럼은 예정 경기 전용)

games UPSERT는 "이미 스코어가 있거나 끝난 행은 절대 건드리지 않음"(WHERE 가드) - 경기가
끝나면 daily_batch의 migrate_to_supabase.py 경로가 스코어를 채우는데, 그 뒤에 이 스크립트가
다시 돌아도 예정 상태로 되돌리는 사고가 없도록.

시즌 이름 매핑: match/list 응답의 seasonName은 null이라 seasonCode에서 유도 -
KBL 시즌코드는 시즌마다 +2 (47="2025-2026" 확인됨, predict_upcoming_games.py의
current_season_code 계산과 같은 패턴).

전부 ON CONFLICT UPSERT라 하루 여러 번 돌려도 안전(멱등).

사용법:
  python sync_upcoming_games.py             # 오늘~120일 뒤까지의 예정 경기 동기화
  python sync_upcoming_games.py --days 14   # 조회 범위 조정
  python sync_upcoming_games.py --skip-predictions  # games 행만 넣고 모델 예측 생략
"""
import argparse
import datetime
import os
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))

CATEGORIES = {"R", "PO", "CP", "CU", "OM"}  # predict_upcoming_games.fetch_upcoming_schedule과 동일 스코프
# CP(챔피언결정전) 추가(2026-09-24) - 빠져 있어서 챔프전이 games 테이블에 미경기로 안 들어갔고,
# 그래서 라이브 폴링 대상도, 사이트 예정 경기도 되지 못했다(25-26 챔프전 5경기가 Supabase에 0건).
# OM(오픈매치) 추가(2026-09-24) - 2026-27 프리시즌 실측 확인, 같은 이유로 빠지면 오늘(9/24)
# 개막 프리시즌 경기가 라이브 대상이 못 됨.
DEFAULT_LOOKAHEAD_DAYS = 120

# 시즌코드 -> 시즌이름: 47 = "2025-2026", 시즌마다 +2 (seasons 테이블 실측으로 확인:
# 39=2021-2022, 41=2022-2023, 43=2023-2024, 45=2024-2025, 47=2025-2026).
def season_name_for_code(season_code):
    start_year = 2025 + (season_code - 47) // 2
    return f"{start_year}-{start_year + 1}"


def load_env_supabase():
    """tools/.env.supabase의 DATABASE_URL을 환경변수로 로드(이미 설정돼 있으면 그대로 둠) -
    Windows 작업 스케줄러처럼 환경변수가 없는 컨텍스트에서도 바로 돌게."""
    if os.environ.get("DATABASE_URL"):
        return
    env_path = os.path.join(BASE, ".env.supabase")
    if not os.path.exists(env_path):
        return
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def get_conn():
    try:
        import psycopg2
    except ImportError:
        print("psycopg2가 없음 - `pip install psycopg2-binary` 먼저 실행하세요.", file=sys.stderr)
        sys.exit(1)
    load_env_supabase()
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL 환경변수가 없음(tools/.env.supabase도 없음).", file=sys.stderr)
        sys.exit(1)
    # api_get과 같은 이유로 재시도한다 - 기상 직후엔 DNS가 아직 안 붙어
    # "could not translate host name ... pooler.supabase.com" 으로 죽는다(2026-09-22 관측).
    # live_collector는 10분 뒤 재기동으로 자가치유되지만 daily_batch는 24시간을 잃는다.
    last_err = None
    for attempt in range(6):
        try:
            return psycopg2.connect(url)
        except psycopg2.OperationalError as e:
            last_err = e
            if attempt < 5:
                time.sleep(min(30, 2 * 2 ** attempt))   # 2,4,8,16,30 = 총 60초
    raise last_err


def fetch_upcoming(days):
    import fetch_kbl_data as fkd
    today = datetime.date.today()
    future = today + datetime.timedelta(days=days)
    all_games = fkd.fetch_game_list(today.strftime("%Y%m%d"), future.strftime("%Y%m%d"))
    return [g for g in all_games
            if g.get("isEnded") == 0 and g.get("seasonCategory") in CATEGORIES]


def build_game_rows(schedule_games):
    """migrate_to_supabase.py의 load_games와 정확히 같은 컬럼 매핑(season_category=
    seasonCategoryName, game_start "HHMM"->"HH:MM:SS", stadium=stadiumname). 예정 경기라
    스코어/감독/관중은 아직 없음 -> NULL, is_ended=false."""
    rows = []
    for g in schedule_games:
        gd = g.get("gameDate")
        game_date = f"{gd[:4]}-{gd[4:6]}-{gd[6:8]}" if gd else None
        gs = g.get("gameStart")
        game_start = f"{gs[:2]}:{gs[2:]}:00" if gs and len(gs) == 4 else None
        if not game_date or not g.get("tcodeH") or not g.get("tcodeA"):
            continue
        rows.append((
            g["gmkey"], season_name_for_code(g["seasonCode"]), g.get("seasonCategoryName"),
            game_date, game_start, g["tcodeH"], g["tcodeA"],
            None, None,           # home/away coach - 예정 경기는 아직 미정
            None, None, False,    # home_score, away_score, is_ended
            g.get("stadiumname"), None,  # stadium, attendance
        ))
    return rows


def upsert_games(cur, schedule_games):
    from psycopg2.extras import execute_values
    rows = build_game_rows(schedule_games)
    if not rows:
        return 0

    # games.season_name FK - 새 시즌(예: 2026-2027=49)이면 seasons부터 채워야 함.
    season_rows = sorted({(r[1], None) for r in rows})
    season_codes = {season_name_for_code(g["seasonCode"]): g["seasonCode"] for g in schedule_games}
    execute_values(cur, """
        insert into seasons (season_name, season_code) values %s
        on conflict (season_name) do nothing
    """, [(name, season_codes.get(name)) for name, _ in season_rows])

    # 가드: 이미 스코어가 있거나 끝난 행은 절대 예정 상태로 되돌리지 않음. 아직 예정인
    # 행만 일정 변경(날짜/시각/구장)을 따라감.
    execute_values(cur, """
        insert into games (gmkey, season_name, season_category, game_date, game_start,
            home_tcode, away_tcode, home_coach_id, away_coach_id, home_score, away_score,
            is_ended, stadium, attendance) values %s
        on conflict (gmkey) do update set
            game_date = excluded.game_date,
            game_start = excluded.game_start,
            stadium = excluded.stadium
        where games.home_score is null and games.is_ended = false
    """, rows)
    return len(rows)


def compute_prediction_rows(ctx, model_bundle, schedule_games):
    """predict_upcoming_games.team_features_now를 그대로 재사용해 피처+승률을 계산 -
    DB 연결 없이 순수 계산만(migrate_game_events_to_supabase.py에서 실제로 겪은 함정:
    무거운 계산 동안 연결을 유휴로 열어두면 Supabase 풀러가 끊음 - 그래서 연결은 계산이
    다 끝난 뒤 main()에서 짧게 엶)."""
    import numpy as np
    import export_training_table as ett
    import predict_upcoming_games as pug
    from migrate_pregame_features_to_supabase import FIELDS

    model = model_bundle["model"]
    feature_keys = model_bundle["featureKeys"]
    game_level_keys = model_bundle["gameLevelKeys"]

    rows = []
    skipped = 0
    for g in schedule_games:
        home_feats = pug.team_features_now(g["tcodeH"], "home", ctx, g["gameDate"])
        away_feats = pug.team_features_now(g["tcodeA"], "away", ctx, g["gameDate"])
        if home_feats is None or away_feats is None:
            skipped += 1  # 시즌 극초반 표본 부족 - 예측 보류(predict_upcoming_games와 동일)
            continue
        home_feats["home_venueNetRtg"] = ett.venue_rating_before(
            ctx["venue_timelines"].get((g["tcodeH"], g.get("stadiumname")), []))
        away_feats["away_venueNetRtg"] = ett.venue_rating_before(
            ctx["venue_timelines"].get((g["tcodeA"], g.get("stadiumname")), []))

        feats = [home_feats.get(f"home_{k}") for k in feature_keys] + \
                [away_feats.get(f"away_{k}") for k in feature_keys]
        date_ctx = ett.date_context_features(g["gameDate"])
        ctx_vals = {"dayOfWeek": date_ctx["dayOfWeek"], "month": date_ctx["month"],
                    "refHomeWinRate": None}
        feats += [ctx_vals.get(k) for k in game_level_keys]
        X = np.array([[np.nan if v is None else v for v in feats]], dtype=float)
        prob_home = round(float(model.predict_proba(X)[0, 1]), 4)

        row = [g["gmkey"]]
        for _, src_key in FIELDS:
            row.append(home_feats.get(f"home_{src_key}"))
            row.append(away_feats.get(f"away_{src_key}"))
        row.append(prob_home)
        rows.append(tuple(row))
    return rows, skipped


def upsert_predictions(cur, rows):
    from migrate_pregame_features_to_supabase import FIELDS
    from psycopg2.extras import execute_values
    if not rows:
        return
    cols = ["gmkey"]
    for pg_key, _ in FIELDS:
        cols.append(f"home_{pg_key}")
        cols.append(f"away_{pg_key}")
    cols.append("home_win_prob")
    set_clause = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "gmkey")
    execute_values(cur, f"""
        insert into pregame_features ({", ".join(cols)}) values %s
        on conflict (gmkey) do update set {set_clause}
    """, rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=DEFAULT_LOOKAHEAD_DAYS,
                    help=f"오늘부터 며칠 뒤까지의 예정 경기를 동기화할지 (기본 {DEFAULT_LOOKAHEAD_DAYS})")
    ap.add_argument("--skip-predictions", action="store_true",
                    help="games 행만 UPSERT하고 모델 예측(pregame_features)은 생략")
    args = ap.parse_args()

    print(f"[sync_upcoming] KBL 스케줄 조회(오늘~{args.days}일)...", flush=True)
    schedule_games = fetch_upcoming(args.days)
    print(f"[sync_upcoming] 예정 경기({','.join(sorted(CATEGORIES))}) {len(schedule_games)}건", flush=True)
    if not schedule_games:
        print("[sync_upcoming] 동기화할 예정 경기 없음 - 종료.", flush=True)
        return

    # 1단계: DB 연결 없이 무거운 계산부터 전부 끝냄(피처 컨텍스트 구성이 수 분 걸리는데,
    # 그동안 연결을 유휴로 열어두면 Supabase 풀러가 끊어버림 - 실제로 겪음).
    pred_rows, n_skip = [], 0
    if not args.skip_predictions:
        import joblib
        import predict_upcoming_games as pug
        if not os.path.exists(pug.MODEL_PATH):
            print(f"[sync_upcoming] {pug.MODEL_PATH} 없음 - 예측 생략(games만 동기화됨)",
                  file=sys.stderr)
        else:
            model_bundle = joblib.load(pug.MODEL_PATH)
            print("[sync_upcoming] 피처 컨텍스트 구성 중(predict_upcoming_games 재사용)...", flush=True)
            ctx = pug.build_context()
            pred_rows, n_skip = compute_prediction_rows(ctx, model_bundle, schedule_games)

    # 2단계: 연결을 짧게 열어 UPSERT만 하고 바로 커밋.
    conn = get_conn()
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            n_games = upsert_games(cur, schedule_games)
            print(f"[sync_upcoming] games UPSERT {n_games}건", flush=True)
            upsert_predictions(cur, pred_rows)
            print(f"[sync_upcoming] pregame_features UPSERT {len(pred_rows)}건"
                  f"{f' (표본 부족 보류 {n_skip}건)' if n_skip else ''}", flush=True)
        conn.commit()
        print("[sync_upcoming] 커밋 완료.", flush=True)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
