"""
매일 실행되는 배치 (로드맵 06단계). 어제~오늘 날짜 범위에서 끝난 경기만 찾아 fetch_kbl_data.py와
동일한 방식으로 5개 엔드포인트 수집 + 라인업 스틴트 재구성까지 한 번에 처리한다. 이미 받은
경기/파일은 건너뛰므로 하루 여러 번 돌려도 안전.

**Windows 작업 스케줄러 `KBL_DailyBatch`에 등록 완료(2026-08-24)** - 매일 06:00 자동 실행.

**2026-08-24 추가**: 새 경기 수집이 끝나면(또는 새 경기가 없어도) `run_report()`가 항상 실행돼서
예정 경기 예측(`predict_upcoming_games.py`)과 일일 HTML 리포트(`generate_daily_report.py`)를
갱신한다 - 오프시즌엔 "예정된 경기 없음"으로 조용히 갱신되다가 시즌 다가오면 자동으로 채워짐.

**2026-09-02 추가 (Phase 0 - 라이브 대비)**: `run_supabase_sync()`가 뒤에 붙음 -
  (a) 새로 끝난 경기를 Supabase로 증분 이관(migrate_to_supabase.py --gmkeys ... +
      migrate_game_events_to_supabase.py --gmkeys ...) - 예전엔 수동으로만 하던 부분.
      새 경기가 없는 날엔 깨끗한 no-op.
  (b) 예정 경기 동기화(sync_upcoming_games.py) - KBL 스케줄의 아직 안 열린 경기를
      games(예정 상태) + pregame_features(경기 전 모델 승률)로 UPSERT. 매일 최신 폼으로 갱신.
DATABASE_URL은 tools/.env.supabase에서 자동 로드(작업 스케줄러 환경에 환경변수가 없어도 동작).

사용법:
  python daily_batch.py                 # 어제~오늘 수집 + Supabase 동기화 + 리포트 갱신
  python daily_batch.py --date 20261015 # 특정 날짜만 재처리하고 싶을 때
"""
import argparse
import datetime
import os
import subprocess
import sys

import fetch_kbl_data as fkd

CATEGORIES = {"R", "PO", "CU", "AS"}  # 시즌 개막 후엔 정규+플옵+컵+올스타까지 (D리그/오픈매치 제외)


def run(date=None):
    if date:
        from_date = to_date = date
    else:
        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        from_date = yesterday.strftime("%Y%m%d")
        to_date = today.strftime("%Y%m%d")

    print(f"[daily_batch] {from_date} ~ {to_date} 확인 중...", flush=True)
    games = fkd.load_target_games(seasons=None, categories=CATEGORIES,
                                   from_date=from_date, to_date=to_date, use_cache=False)
    if not games:
        print("[daily_batch] 새로 끝난 경기 없음.", flush=True)
        return []

    print(f"[daily_batch] 대상 {len(games)}경기", flush=True)
    for g in games:
        gmkey = g["gmkey"]
        result = fkd.fetch_one_game(gmkey)
        print(f"  {gmkey} {g['tnameH']} vs {g['tnameA']} -> {result}", flush=True)

    # 새로 받은 만큼 라인업 스틴트도 바로 갱신 (이미 처리된 경기는 build_lineup_stints.py가
    # 알아서 다시 계산하긴 하지만 - 전체 재계산 vs 증분 처리는 나중에 필요해지면 최적화)
    subprocess.run([sys.executable, "build_lineup_stints.py"], check=False)
    print("[daily_batch] 완료.", flush=True)
    return [g["gmkey"] for g in games]


def run_report():
    """예정 경기 예측 + 일일 HTML 리포트 (2026-08-24 추가). daily_batch.py 본작업(수집/스틴트)
    다음에 항상 실행 - 새 경기가 없어도(오프시즌) 리포트는 "예정 경기 없음"으로 계속 갱신됨."""
    subprocess.run([sys.executable, "predict_upcoming_games.py"], check=False)
    subprocess.run([sys.executable, "generate_daily_report.py"], check=False)


def run_supabase_sync(new_gmkeys):
    """Supabase 동기화 (2026-09-02 추가, Phase 0). 전부 UPSERT 기반이라 재실행 안전.

    (a) 완료 경기 증분 이관 - run()이 방금 받은 경기만 --gmkeys로 넘김(전체 15시즌 재이관
        아님). 새 경기가 없으면 이 단계는 통째로 건너뜀(깨끗한 no-op).
    (b) 예정 경기 동기화 - sync_upcoming_games.py. 스케줄이 아직 미공개인 날은 "예정 경기
        없음"으로 조용히 끝남.
    """
    env = dict(os.environ)
    if not env.get("DATABASE_URL"):
        # 작업 스케줄러 환경엔 DATABASE_URL이 없음 - tools/.env.supabase에서 로드해서
        # 자식 프로세스 셋 모두에 전달.
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.supabase")
        if os.path.exists(env_path):
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, _, value = line.partition("=")
                        env.setdefault(key.strip(), value.strip())
    if not env.get("DATABASE_URL"):
        print("[daily_batch] DATABASE_URL 없음(tools/.env.supabase 확인) - Supabase 동기화 건너뜀.",
              flush=True)
        return

    if new_gmkeys:
        gmkeys_arg = ",".join(new_gmkeys)
        print(f"[daily_batch] Supabase 완료경기 이관: {gmkeys_arg}", flush=True)
        subprocess.run([sys.executable, "migrate_to_supabase.py", "--gmkeys", gmkeys_arg],
                       check=False, env=env)
        subprocess.run([sys.executable, "migrate_game_events_to_supabase.py", "--gmkeys", gmkeys_arg],
                       check=False, env=env)
    else:
        print("[daily_batch] 새 완료 경기 없음 - Supabase 이관 건너뜀.", flush=True)

    subprocess.run([sys.executable, "sync_upcoming_games.py"], check=False, env=env)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="YYYYMMDD - 특정 날짜만 재처리 (생략 시 어제~오늘)")
    args = ap.parse_args()
    new_gmkeys = run(args.date)
    run_supabase_sync(new_gmkeys)
    run_report()
