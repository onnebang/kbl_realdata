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

파이프라인: load_sqlite(SQLite 재적재) -> 신선도 확인(Supabase 종료 경기 수와 비교) ->
build_courtside_ovr(OVR 재계산) -> ovr_guard(HEAD 대비 이상 검사) ->
export_training_table(학습 테이블 재생성) -> save_pregame_model(배포용 모델 재학습, 승격 게이트 포함) ->
build_alltime_leaders(올타임 리더스 "현역" 배지 재계산) ->
git commit+push(courtside_ovr_history.json / play_styles.json / alltime_leaders.json /
career_marks.json / pregame_model.joblib).

안전장치(2026-10-07 - 개막 직후 전원 OVR 폭락 사고 대응, 에러 없이 끝난 틀린 결과가 검증 없이 나간 것):
- 시작 시 산출물 파일에 미커밋 변경이 있으면 중단(사람의 작업 위에 덮어쓰지 않는다).
- OVR 가드(ovr_guard.py)가 실패하면 OVR 산출물을 HEAD로 되돌리고 학습·커밋 없이 중단한다.
- 커밋·푸시는 작업트리와 무관하게 깨끗한 임시 worktree(origin/main 기준)에서 한다 - 사람이 작업 중이어도
  (미커밋 파일/스테이징/뒤처진 HEAD) 막히거나 섞이지 않는다.
- --dry-run: 전 단계를 돌리고 가드까지 확인한 뒤 커밋·푸시 없이 산출물을 HEAD로 되돌린다(첫 실행 전 점검용).

라이브(경기중) 승률 모델(train_live_winprob_model.py)은 포함하지 않음 - 그 모델은 15시즌
전체 스틴트 스냅샷(676MB)을 다시 뽑아야 해서 매주 돌리기엔 너무 무겁고, 과거 규정 기반
학습이라 이번 시즌 누적과 무관함. 필요해지면 별도 주기(월 1회 등)로 분리할 것.
"""
import datetime
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

BASE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(BASE, ".."))
LOG_PATH = os.path.join(BASE, "..", "raw", "weekly_retrain.log")
DB_PATH = os.path.join(BASE, "..", "raw", "kbl_realdata.db")

# git에 커밋할 생성물만 명시 - git add -A 금지(의도치 않은 작업중 파일 섞임 방지)
TRACKED_OUTPUTS = [
    "courtside-web/lib/courtside_ovr_history.json",
    "courtside-web/lib/play_styles.json",
    "courtside-web/lib/alltime_leaders.json",
    "courtside-web/lib/career_marks.json",
    "raw/analysis/pregame_model.joblib",
]
OVR_OUTPUTS = TRACKED_OUTPUTS[:2]
OVR_JSON = TRACKED_OUTPUTS[0]

STEPS = [
    ("load_sqlite.py", "SQLite 재적재 (raw/games, raw/stints -> raw/kbl_realdata.db)"),
    ("build_courtside_ovr.py", "OVR 재계산 (courtside_ovr_history.json)"),
    ("export_training_table.py", "학습 테이블 재생성 (pregame_training_table.json)"),
    ("save_pregame_model.py", "배포용 경기전 승률 모델 재학습 (pregame_model.joblib)"),
    # 올타임 리더스(/rankings/legends)의 "현역" 배지가 이 주의 최신 로스터를 반영하도록
    # (2026-10-06, 사용자 요청) - SQLite가 방금 최신화됐으니 같은 묶음에서 재생성.
    ("build_alltime_leaders.py", "올타임 리더스 + 라이브 기록 워치용 통산 스냅샷 재계산 (alltime_leaders.json, career_marks.json)"),
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


def git(args, cwd=None):
    return subprocess.run(["git", "-C", cwd or REPO_ROOT] + args, capture_output=True, text=True)


def dirty_outputs(paths=TRACKED_OUTPUTS):
    status = git(["status", "--porcelain", "--"] + paths)
    return [line[3:] for line in status.stdout.splitlines() if line.strip()]


def restore_outputs(f, paths):
    """생성물을 HEAD 상태로 되돌린다 - 시작 시점에 깨끗했던 파일만 대상이라 사람의 작업을 지우지 않는다."""
    r = git(["checkout", "--"] + paths)
    log(f, f"[RESTORE] {paths} -> HEAD" + ("" if r.returncode == 0 else f" (실패: {r.stderr.strip()})"))


def check_fresh(f):
    """로컬 SQLite가 Supabase의 종료 경기보다 뒤처졌으면(수집 누락) 낡은 데이터로 발행하지 않는다.
    Supabase에 접속이 안 되면 확인 불가라 경고만 하고 넘어간다(이어지는 OVR 가드가 결과 이상을 잡는다)."""
    try:
        local = sqlite3.connect(DB_PATH).execute(
            "SELECT season_name, COUNT(*) FROM games WHERE season_category = '정규시즌' GROUP BY 1 ORDER BY 1 DESC LIMIT 1"
        ).fetchone()
        sys.path.insert(0, BASE)
        import psycopg2
        from import_roster import load_database_url
        conn = psycopg2.connect(load_database_url())
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM games WHERE season_name = %s AND season_category = '정규시즌' AND is_ended", (local[0],))
        remote = cur.fetchone()[0]
        conn.close()
    except Exception as e:
        log(f, f"[WARN] 신선도 확인 불가({e}) - 계속 진행")
        return True
    log(f, f"신선도: {local[0]} 정규시즌 종료 경기 로컬 {local[1]} / Supabase {remote}")
    if local[1] < remote:
        log(f, f"[FAIL] 로컬 SQLite가 Supabase보다 {remote - local[1]}경기 뒤처짐 - raw/games 수집 누락 확인 필요(낡은 데이터로 발행하지 않음)")
        return False
    return True


def run_guard(f):
    sys.path.insert(0, BASE)
    import ovr_guard
    with open(os.path.join(REPO_ROOT, OVR_JSON), encoding="utf-8") as fh:
        new_rows = json.load(fh)
    problems, warnings = ovr_guard.check(
        ovr_guard.head_rows(REPO_ROOT, OVR_JSON), new_rows, allow_settle=os.environ.get("OVR_GUARD_ALLOW_SETTLE") == "1")
    for w in warnings:
        log(f, f"[GUARD-WARN] {w}")
    for p in problems:
        log(f, f"[GUARD-FAIL] {p}")
    if problems:
        restore_outputs(f, OVR_OUTPUTS)
        return False
    log(f, "[OK] ovr_guard 통과")
    return True


AFTER_STEP = {"load_sqlite.py": check_fresh, "build_courtside_ovr.py": run_guard}


def commit_and_push(f):
    touched = dirty_outputs()
    if not touched:
        log(f, "[SKIP] 생성물에 변경 없음 (이미 최신 상태) - 커밋 스킵")
        return
    fetch = git(["fetch", "origin", "main"])
    if fetch.returncode != 0:
        log(f, f"[FAIL] git fetch 실패({fetch.stderr.strip()}) - 커밋 안 함, 수동 확인 필요")
        return
    today = datetime.date.today().isoformat()
    msg = f"chore(model): weekly retrain {today} - OVR/pregame model refresh with latest season games"
    wt = os.path.join(tempfile.mkdtemp(prefix="weekly_retrain_wt_"), "wt")
    try:
        # 깨끗한 임시 worktree(origin/main 기준)에 생성물만 복사해 커밋 - 작업트리의 미커밋 파일·스테이징·뒤처진 HEAD와 무관.
        add = git(["worktree", "add", "--detach", wt, "origin/main"])
        if add.returncode != 0:
            log(f, f"[FAIL] worktree 생성 실패({add.stderr.strip()}) - 커밋 안 함")
            return
        for rel in touched:
            shutil.copyfile(os.path.join(REPO_ROOT, rel), os.path.join(wt, rel))
        git(["add", "--"] + touched, cwd=wt)
        commit = git(["commit", "-m", msg], cwd=wt)
        log(f, commit.stdout + commit.stderr)
        if commit.returncode != 0:
            log(f, "[FAIL] git commit 실패 - 수동 확인 필요")
            return
        push = git(["push", "origin", "HEAD:main"], cwd=wt)
        log(f, push.stdout + push.stderr)
        if push.returncode != 0:
            log(f, "[FAIL] git push 실패 - 수동 확인 필요(생성물은 작업트리에 그대로 있음)")
            return
        log(f, "[OK] 커밋+푸시 완료 - Vercel이 재배포하면 반영됨")
    finally:
        git(["worktree", "remove", "--force", wt])
        shutil.rmtree(os.path.dirname(wt), ignore_errors=True)
    # 작업트리 동기화(최선 노력) - 생성물이 방금 푸시한 내용과 같으니 HEAD 상태로 되돌린 뒤 fast-forward해서,
    # 나중에 사람이 pull할 때 "로컬 변경이 덮어써진다" 충돌이 안 나게 한다. 실패해도 푸시 결과엔 영향 없음.
    git(["checkout", "--"] + touched)
    ff = git(["merge", "--ff-only", "origin/main"])
    if ff.returncode != 0:
        log(f, f"[WARN] 작업트리 fast-forward 실패({ff.stderr.strip() or ff.stdout.strip()}) - 수동 pull 필요(생성물은 HEAD 상태)")


def main():
    dry_run = "--dry-run" in sys.argv
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        log(f, "===== 주간 재학습 시작" + (" (dry-run)" if dry_run else "") + " =====")
        pre = dirty_outputs()
        if pre:
            log(f, f"[ABORT] 산출물 파일에 미커밋 변경이 있음({pre}) - 덮어쓰지 않으려고 중단. 커밋하거나 되돌린 뒤 다시 실행")
            return 1
        for script, desc in STEPS:
            if not run_step(f, script, desc):
                log(f, "[ABORT] 파이프라인 중단 - 이후 단계 건너뜀")
                return 1
            hook = AFTER_STEP.get(script)
            if hook and not hook(f):
                log(f, "[ABORT] 안전장치에 걸려 중단 - 이후 단계 건너뜀(커밋·푸시 없음)")
                return 1
        if dry_run:
            log(f, "dry-run: 가드까지 통과 - 커밋·푸시 없이 산출물을 HEAD로 되돌림")
            restore_outputs(f, TRACKED_OUTPUTS)
        else:
            commit_and_push(f)
        log(f, "===== 주간 재학습 종료 =====\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
