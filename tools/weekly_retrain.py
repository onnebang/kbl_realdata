"""
주간 모델 재학습 오케스트레이션 (2026-10-06, 사용자 요청) - 매주 월요일 새벽 06:20 KST,
KBL_DailyBatch(06:00)가 끝난 뒤 실행되도록 Windows 작업 스케줄러 "KBL_WeeklyTrain"에
등록해서 쓴다(다른 KBL_* 태스크와 같은 패턴 - Register-ScheduledTask로 직접 등록, 별도
스크립트 파일 없음. README.md 운영 런북 참고).

왜 필요한가:
1. 신규 용병/신인 OVR이 지금 추정치(프로젝션)로만 잡혀있음 - 실제 경기가 쌓이면
   compute_ovr()이 그 선수의 진짜 스탯 기반 OVR로 자연히 대체함(코드 변경 불필요,
   SQLite에 최신 경기만 들어가면 됨).
2. 이번 시즌(seasonCode 49)부터 2쿼터/3쿼터 외국선수 2인 동시출전이 과거 15시즌에
   전례가 없는 새 규정이라, save_pregame_model.py가 표본이 SAMPLE_THRESHOLD(150행, 사용자
   지정 2026-10-06)를 넘기 전까진 이 시즌 경기를 재학습에서 제외한다. 이 판단과 전환은
   save_pregame_model.py 안에서 매번 자동으로 이뤄진다(기준을 넘는 주부터 자동 포함) -
   이 오케스트레이터는 그 스크립트를 그대로 호출만 하고, 결과(포함/제외 여부)는 그 스크립트의
   stdout이 로그에 그대로 남는다.

파이프라인: load_sqlite(SQLite 재적재) -> build_courtside_ovr(OVR 재계산) ->
export_training_table(학습 테이블 재생성) -> save_pregame_model(배포용 모델 재학습) ->
build_alltime_leaders(올타임 리더스 "현역" 배지 재계산) ->
git commit+push(courtside_ovr_history.json / play_styles.json / alltime_leaders.json /
pregame_model.joblib).

라이브(경기중) 승률 모델(train_live_winprob_model.py)은 포함하지 않음 - 그 모델은 15시즌
전체 스틴트 스냅샷(676MB)을 다시 뽑아야 해서 매주 돌리기엔 너무 무겁고, 과거 규정 기반
학습이라 이번 시즌 누적과 무관함. 필요해지면 별도 주기(월 1회 등)로 분리할 것.
"""
import datetime
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.join(BASE, "..")
LOG_PATH = os.path.join(BASE, "..", "raw", "weekly_retrain.log")

# git에 커밋할 생성물만 명시 - git add -A 금지(의도치 않은 작업중 파일 섞임 방지)
TRACKED_OUTPUTS = [
    "courtside-web/lib/courtside_ovr_history.json",
    "courtside-web/lib/play_styles.json",
    "courtside-web/lib/alltime_leaders.json",
    "raw/analysis/pregame_model.joblib",
]

STEPS = [
    ("load_sqlite.py", "SQLite 재적재 (raw/games, raw/stints -> raw/kbl_realdata.db)"),
    ("build_courtside_ovr.py", "OVR 재계산 (courtside_ovr_history.json)"),
    ("export_training_table.py", "학습 테이블 재생성 (pregame_training_table.json)"),
    ("save_pregame_model.py", "배포용 경기전 승률 모델 재학습 (pregame_model.joblib)"),
    # 올타임 리더스(/rankings/legends)의 "현역" 배지가 이 주의 최신 로스터를 반영하도록
    # (2026-10-06, 사용자 요청) - SQLite가 방금 최신화됐으니 같은 묶음에서 재생성.
    ("build_alltime_leaders.py", "올타임 리더스 재계산 (alltime_leaders.json)"),
]


def log(f, msg):
    line = f"[{datetime.datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(line, flush=True)
    f.write(line + "\n")
    f.flush()


def run_step(f, script, desc):
    log(f, f"--- {desc} ---")
    result = subprocess.run([sys.executable, script], cwd=BASE, capture_output=True, text=True)
    f.write(result.stdout)
    f.write(result.stderr)
    f.flush()
    if result.returncode != 0:
        log(f, f"[FAIL] {script} 종료코드 {result.returncode}")
        return False
    log(f, f"[OK] {script}")
    return True


def git(args):
    return subprocess.run(["git", "-C", REPO_ROOT] + args, capture_output=True, text=True)


def commit_and_push(f):
    status = git(["status", "--porcelain"])
    changed = [line[3:] for line in status.stdout.splitlines() if line.strip()]
    unexpected = [p for p in changed if p not in TRACKED_OUTPUTS]
    if unexpected:
        log(f, f"[SKIP] 예상 못한 변경 파일 발견({unexpected}) - 자동 커밋 안 함, 수동 확인 필요")
        return
    touched = [p for p in TRACKED_OUTPUTS if p in changed]
    if not touched:
        log(f, "[SKIP] 생성물에 변경 없음 (이미 최신 상태) - 커밋 스킵")
        return
    git(["add"] + touched)
    today = datetime.date.today().isoformat()
    msg = f"chore(model): weekly retrain {today} - OVR/pregame model refresh with latest season games"
    commit = git(["commit", "-m", msg])
    log(f, commit.stdout + commit.stderr)
    push = git(["push", "origin", "main"])
    log(f, push.stdout + push.stderr)
    if push.returncode != 0:
        log(f, "[FAIL] git push 실패 - 수동 확인 필요")
    else:
        log(f, "[OK] 커밋+푸시 완료 - Vercel이 재배포하면 반영됨")


def main():
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        log(f, "===== 주간 재학습 시작 =====")
        for script, desc in STEPS:
            if not run_step(f, script, desc):
                log(f, "[ABORT] 파이프라인 중단 - 이후 단계 건너뜀")
                return
        commit_and_push(f)
        log(f, "===== 주간 재학습 종료 =====\n")


if __name__ == "__main__":
    main()
