"""
매일 실행되는 배치 (로드맵 06단계). 어제~오늘 날짜 범위에서 끝난 경기만 찾아 fetch_kbl_data.py와
동일한 방식으로 5개 엔드포인트 수집 + 라인업 스틴트 재구성까지 한 번에 처리한다. 이미 받은
경기/파일은 건너뛰므로 하루 여러 번 돌려도 안전.

**Windows 작업 스케줄러 `KBL_DailyBatch`에 등록 완료(2026-08-24)** - 매일 06:00 자동 실행.

**2026-08-24 추가**: 새 경기 수집이 끝나면(또는 새 경기가 없어도) `run_report()`가 항상 실행돼서
예정 경기 예측(`predict_upcoming_games.py`)과 일일 HTML 리포트(`generate_daily_report.py`)를
갱신한다 - 오프시즌엔 "예정된 경기 없음"으로 조용히 갱신되다가 시즌 다가오면 자동으로 채워짐.

사용법:
  python daily_batch.py                 # 어제~오늘 수집 + 리포트 갱신 (기본, 매일 새벽 크론용)
  python daily_batch.py --date 20261015 # 특정 날짜만 재처리하고 싶을 때
"""
import argparse
import datetime
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
        return

    print(f"[daily_batch] 대상 {len(games)}경기", flush=True)
    for g in games:
        gmkey = g["gmkey"]
        result = fkd.fetch_one_game(gmkey)
        print(f"  {gmkey} {g['tnameH']} vs {g['tnameA']} -> {result}", flush=True)

    # 새로 받은 만큼 라인업 스틴트도 바로 갱신 (이미 처리된 경기는 build_lineup_stints.py가
    # 알아서 다시 계산하긴 하지만 - 전체 재계산 vs 증분 처리는 나중에 필요해지면 최적화)
    subprocess.run([sys.executable, "build_lineup_stints.py"], check=False)
    print("[daily_batch] 완료.", flush=True)


def run_report():
    """예정 경기 예측 + 일일 HTML 리포트 (2026-08-24 추가). daily_batch.py 본작업(수집/스틴트)
    다음에 항상 실행 - 새 경기가 없어도(오프시즌) 리포트는 "예정 경기 없음"으로 계속 갱신됨."""
    subprocess.run([sys.executable, "predict_upcoming_games.py"], check=False)
    subprocess.run([sys.executable, "generate_daily_report.py"], check=False)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="YYYYMMDD - 특정 날짜만 재처리 (생략 시 어제~오늘)")
    args = ap.parse_args()
    run(args.date)
    run_report()
