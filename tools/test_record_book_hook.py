# -*- coding: utf-8 -*-
"""역대 기록 정산 훅 회귀 테스트 - DB·네트워크 없이 subprocess를 가짜로 바꿔 실행 순서와
"기록 반영이 실패해도 정산 결과(ok)는 그대로"인지 확인한다.

설계: docs/superpowers/specs/2026-10-08-record-book-design.md §7
실행:  python test_record_book_hook.py
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import daily_batch as db  # noqa: E402
import live_collector as lc  # noqa: E402


class _Done:
    def __init__(self, returncode):
        self.returncode = returncode


def _reconcile(codes=None, timeout_on=None):
    """reconcile_finished_game을 가짜 subprocess로 실행 -> (결과 dict, 실행한 스크립트 이름 목록)."""
    calls = []
    saved = {k: getattr(lc, k) for k in ("official_box_ready", "load_env_supabase", "resolve_python")}
    saved_run, saved_fetch = subprocess.run, lc.fkd.fetch_one_game
    lc.official_box_ready = lambda gmkey: (True, "1-0")
    lc.load_env_supabase = lambda: None
    lc.resolve_python = lambda: "python"
    lc.fkd.fetch_one_game = lambda gmkey, force=False: "ok"

    def fake_run(argv, **kwargs):
        calls.append(os.path.basename(argv[1]))
        if timeout_on and argv[1] == timeout_on:
            raise subprocess.TimeoutExpired(argv, 1)
        return _Done((codes or {}).get(argv[1], 0))

    subprocess.run = fake_run
    try:
        return lc.reconcile_finished_game("S99G01N1"), calls
    finally:
        subprocess.run = saved_run
        lc.fkd.fetch_one_game = saved_fetch
        for k, v in saved.items():
            setattr(lc, k, v)


def test_settlement_runs_record_book_last():
    result, calls = _reconcile()
    assert calls == ["migrate_to_supabase.py", "migrate_game_events_to_supabase.py", "record_book.py"], calls
    assert result["ok"] is True and result["record_book"] == 0, result


def test_record_book_failure_does_not_fail_the_settlement():
    result, calls = _reconcile(codes={"record_book.py": 1})
    assert result["ok"] is True and result["record_book"] == 1, result
    assert calls[-1] == "record_book.py"


def test_record_book_timeout_does_not_fail_the_settlement():
    result, _ = _reconcile(timeout_on="record_book.py")
    assert result["ok"] is True and result["record_book"] == "error: TimeoutExpired", result


def test_record_book_is_skipped_when_settlement_failed():
    for failing in ("migrate_to_supabase.py", "migrate_game_events_to_supabase.py"):
        result, calls = _reconcile(codes={failing: 2})
        assert result["ok"] is False and "record_book" not in result, (failing, result)
        assert "record_book.py" not in calls, (failing, calls)


def test_daily_batch_recovers_record_book_without_counting_its_failure():
    steps = []
    saved = (db.step, db.child_env, db.resolve_python)
    db.child_env = lambda: {"DATABASE_URL": "postgres://example"}
    db.resolve_python = lambda: "python"

    def fake_step(argv, label, failures, env=None):
        steps.append(label)
        if label == "record_book.py":
            failures.append("record_book.py exit 1")      # 실패를 흉내 - 넘겨받은 리스트에만 쌓인다
        return 0

    db.step = fake_step
    try:
        failures = db.run_supabase_sync(["S99G01N1", "S99G01N2"], [])
    finally:
        db.step, db.child_env, db.resolve_python = saved
    assert steps.index("record_book.py") > steps.index("migrate_game_events_to_supabase.py"), steps
    assert failures == [], failures                         # 기록 반영 실패는 배치 실패로 세지 않는다


def test_daily_batch_skips_record_book_without_new_games():
    steps = []
    saved = (db.step, db.child_env, db.resolve_python)
    db.child_env = lambda: {"DATABASE_URL": "postgres://example"}
    db.resolve_python = lambda: "python"
    db.step = lambda argv, label, failures, env=None: steps.append(label) or 0
    try:
        db.run_supabase_sync([], [])
    finally:
        db.step, db.child_env, db.resolve_python = saved
    assert "record_book.py" not in steps, steps


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
    print("실패 없음." if not failed else f"{failed}건 실패.")
    sys.exit(1 if failed else 0)
