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

**2026-09-02 수정 (Phase 1 검증 지적사항)** - 이 배치는 라이브 정산이 실패했을 때의 **유일한
복구 경로**인데, 그 역할을 못 하고 있었다. 세 가지를 고침:
  (1) `migrate_game_events_to_supabase.py`에 `--replace`를 붙임. 없으면 load_events가
      ON CONFLICT DO NOTHING으로 떨어져서, 라이브 수집기가 넣어둔 **잠정 이벤트가 그대로
      남는다**(규정시간 기준 remainingSec 추정 + 문자중계로 복원한 라인업이 '공식' 데이터로 고착).
  (2) `fetch_one_game(..., force=True)`. 라이브 정산이 "isEnded가 막 뜬 순간"에 이미 한 번
      받아가서 raw/games/<gmkey>/에 **반쪽짜리 캐시**를 남겼을 수 있는데, 캐시가 있으면
      건너뛰는 기본 동작으로는 그게 영원히 정본 행세를 한다.
  (3) **모든** 서브프로세스의 인터프리터를 tools/python_runtime.py로 명시 해석하고
      **종료코드를 확인**함(Supabase 이관 3단계 + build_lineup_stints + predict_upcoming_games
      + generate_daily_report). 예전엔 전부 `sys.executable` + `check=False`라, 이 배치를
      Anaconda(3.8/sklearn 1.3) 쉘에서 돌리면 승률 모델 언피클이
      `ModuleNotFoundError: numpy._core`로 죽는데도 로그 한 줄 없이 "완료"로 끝났다
      (migrate_game_events_to_supabase.py와 predict_upcoming_games.py 둘 다 해당). 등록된
      작업 스케줄러 KBL_DailyBatch는 3.11로 돌고 있어 실제 운영 경로는 무사했지만, 조용한
      실패 자체가 위험하다. 실패가 하나라도 있으면 프로세스가 exit 1로 끝나서 작업
      스케줄러의 "마지막 실행 결과"에 그대로 뜬다.

사용법:
  python daily_batch.py                 # 어제~오늘 수집 + Supabase 동기화 + 리포트 갱신
  python daily_batch.py --date 20261015 # 특정 날짜만 재처리하고 싶을 때
  python daily_batch.py --only-supabase-sync --gmkeys S49G01N1
                                        # 수집/리포트 없이 그 경기만 재이관(라이브 정산이
                                        # 끝내 실패했을 때의 수동 복구 경로)
"""
import argparse
import datetime
import os
import subprocess
import sys

import fetch_kbl_data as fkd
from python_runtime import resolve_python

CATEGORIES = {"R", "PO", "CP", "CU", "AS"}  # 시즌 개막 후엔 정규+플옵+챔프전+컵+올스타까지 (D리그/오픈매치 제외)

BASE = os.path.dirname(os.path.abspath(__file__))


def child_env():
    """자식 프로세스에 물려줄 환경 - 작업 스케줄러 환경엔 DATABASE_URL이 없으므로
    tools/.env.supabase에서 로드해서 넣어준다(Supabase를 쓰는 단계가 여럿)."""
    env = dict(os.environ)
    if not env.get("DATABASE_URL"):
        env_path = os.path.join(BASE, ".env.supabase")
        if os.path.exists(env_path):
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, _, value = line.partition("=")
                        env.setdefault(key.strip(), value.strip())
    return env


def step(argv, label, failures, env=None):
    """자식 프로세스 실행 + **종료코드 확인**(2026-09-02).

    예전엔 전부 `subprocess.run(..., check=False)`로 던져놓고 결과를 아무도 안 봐서, 단계가
    통째로 실패해도 로그 한 줄 없이 '완료'로 끝났다. 이 배치는 라이브 정산이 실패했을 때의
    **유일한 복구 경로**라 조용한 실패가 곧 잠정 데이터의 영구 고착이다. 실행한 명령줄도
    그대로 남긴다 - 나중에 "그날 배치가 --replace를 정말 붙였나"를 로그만 보고 확인할 수
    있어야 하므로."""
    print(f"[daily_batch] $ {' '.join(argv)}", flush=True)
    p = subprocess.run(argv, check=False, env=env or child_env(), cwd=BASE)
    if p.returncode != 0:
        failures.append(f"{label} exit {p.returncode}")
        print(f"[daily_batch] !!! 실패 !!! {label} -> exit {p.returncode}", flush=True)
    return p.returncode


def run(date=None, failures=None):
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
        # force=True (2026-09-02) - 라이브 수집기의 종료 정산(live_collector.
        # reconcile_finished_game)이 "isEnded가 막 뜬 순간"에 fetch_one_game(force=True)를
        # 이미 한 번 돌린다. 그때 공식 박스스코어가 아직 안 올라와 있었으면 raw/games/<gmkey>/에
        # **반쪽짜리 캐시**가 남는다. 캐시가 있으면 건너뛰는 기본 동작으로는 그 반쪽 캐시가
        # 영원히 정본 행세를 하므로, 이 배치(= 유일한 복구 경로)는 대상 날짜의 경기를 반드시
        # 다시 받는다. 대상은 어제~오늘 한두 경기뿐이라 비용도 무시할 만하다.
        result = fkd.fetch_one_game(gmkey, force=True)
        print(f"  {gmkey} {g['tnameH']} vs {g['tnameA']} -> {result}", flush=True)

    # 새로 받은 만큼 라인업 스틴트도 바로 갱신 (이미 처리된 경기는 build_lineup_stints.py가
    # 알아서 다시 계산하긴 하지만 - 전체 재계산 vs 증분 처리는 나중에 필요해지면 최적화)
    step([resolve_python(), "build_lineup_stints.py"], "build_lineup_stints.py",
         failures if failures is not None else [])
    print("[daily_batch] 완료.", flush=True)
    return [g["gmkey"] for g in games]


def run_report(failures=None):
    """예정 경기 예측 + 일일 HTML 리포트 (2026-08-24 추가). daily_batch.py 본작업(수집/스틴트)
    다음에 항상 실행 - 새 경기가 없어도(오프시즌) 리포트는 "예정 경기 없음"으로 계속 갱신됨.

    2026-09-02 - 여기도 sys.executable + check=False였다. predict_upcoming_games.py는
    경기 전 승률 모델(joblib)을 로드하므로 Anaconda로 띄우면 통째로 죽는데, 그러면 예정
    경기의 pregame_features.home_win_prob이 조용히 낡은 채로 굳는다. 인터프리터를
    python_runtime으로 고정하고 종료코드를 확인한다."""
    f = failures if failures is not None else []
    exe = resolve_python()
    step([exe, "predict_upcoming_games.py"], "predict_upcoming_games.py", f)
    step([exe, "generate_daily_report.py"], "generate_daily_report.py", f)
    return f


def run_supabase_sync(new_gmkeys, failures=None):
    """Supabase 동기화 (2026-09-02 추가, Phase 0). 전부 UPSERT 기반이라 재실행 안전.

    (a) 완료 경기 증분 이관 - run()이 방금 받은 경기만 --gmkeys로 넘김(전체 15시즌 재이관
        아님). 새 경기가 없으면 이 단계는 통째로 건너뜀(깨끗한 no-op).
    (b) 예정 경기 동기화 - sync_upcoming_games.py. 스케줄이 아직 미공개인 날은 "예정 경기
        없음"으로 조용히 끝남.
    """
    failures = failures if failures is not None else []
    env = child_env()
    if not env.get("DATABASE_URL"):
        print("[daily_batch] DATABASE_URL 없음(tools/.env.supabase 확인) - Supabase 동기화 건너뜀.",
              flush=True)
        failures.append("DATABASE_URL 없음 - Supabase 동기화 전체 건너뜀")
        return failures

    # 인터프리터 명시 지정(2026-09-02) - sys.executable을 그대로 쓰면, 이 배치를 Anaconda
    # 쉘에서 돌리는 순간 migrate_game_events_to_supabase.py가 승률 모델 언피클에서
    # `ModuleNotFoundError: No module named 'numpy._core'`로 죽는다(3.8/sklearn 1.3 vs
    # sklearn 1.9로 피클된 모델). tools/python_runtime.py가 "모델을 실제로 로드해보고"
    # 통과한 인터프리터를 고른다. 자세한 배경은 그 파일 docstring 참고.
    exe = resolve_python()

    if new_gmkeys:
        gmkeys_arg = ",".join(new_gmkeys)
        print(f"[daily_batch] Supabase 완료경기 이관: {gmkeys_arg} (인터프리터: {exe})", flush=True)
        step([exe, "migrate_to_supabase.py", "--gmkeys", gmkeys_arg],
             "migrate_to_supabase.py", failures, env)
        # --replace (2026-09-02) - 라이브 수집기가 경기 도중 넣어둔 game_events는 '잠정치'다
        # (진행중엔 최종 경기 길이를 몰라 remainingSec을 규정시간으로 추정하고, 라인업/pcode도
        # 문자중계에서 복원한 값). --replace가 없으면 load_events가 ON CONFLICT DO NOTHING으로
        # 떨어져서 그 잠정 행이 **그대로 남는다** - 즉 이 배치가 라이브 정산 실패를 복구하지
        # 못한다. 정산 경로(live_collector.reconcile_finished_game)와 같은 플래그를 쓴다.
        step([exe, "migrate_game_events_to_supabase.py", "--gmkeys", gmkeys_arg, "--replace"],
             "migrate_game_events_to_supabase.py", failures, env)
    else:
        print("[daily_batch] 새 완료 경기 없음 - Supabase 이관 건너뜀.", flush=True)

    step([exe, "sync_upcoming_games.py"], "sync_upcoming_games.py", failures, env)
    return failures


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="YYYYMMDD - 특정 날짜만 재처리 (생략 시 어제~오늘)")
    ap.add_argument("--only-supabase-sync", action="store_true",
                    help="수집/리포트를 건너뛰고 Supabase 동기화 단계만 실행(검증/수동 복구용). "
                         "--gmkeys와 함께 쓰면 그 경기만 재이관한다.")
    ap.add_argument("--gmkeys", help="--only-supabase-sync와 함께 - 재이관할 gmkey 목록(콤마 구분)")
    args = ap.parse_args()
    failures = []
    if args.only_supabase_sync:
        gmkeys = [g.strip() for g in (args.gmkeys or "").split(",") if g.strip()]
        run_supabase_sync(gmkeys, failures)
    else:
        new_gmkeys = run(args.date, failures)
        run_supabase_sync(new_gmkeys, failures)
        run_report(failures)
    # 종료코드로도 실패를 드러낸다 - 작업 스케줄러의 "마지막 실행 결과"에 그대로 뜬다
    # (raw/daily_batch.log를 사람이 매일 읽지는 않으므로).
    if failures:
        print(f"[daily_batch] 실패 단계 {len(failures)}건: {failures}", flush=True)
        sys.exit(1)
