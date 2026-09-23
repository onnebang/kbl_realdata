# -*- coding: utf-8 -*-
"""절전 기상 직후 네트워크 미준비 상황 재현 - 재시도가 실제로 돌고, 붙으면 멈추는지 확인.

daily_batch가 06:00에 통째로 날아간 사고(2026-08-31/09-02/09-05)의 회귀 방지.
원인은 "재시도가 없어서"가 아니라 "백오프 총 9초가 기상 창(30~60초)보다 짧아서"였다.
실행: python tools/check_network_retry.py   (DB/네트워크 접속 안 함 - 전부 monkeypatch)
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("DATABASE_URL", "postgresql://fake/fake")

import psycopg2
import sync_upcoming_games as sug
import fetch_kbl_data as fkd

slept = []
time.sleep = lambda s: slept.append(s)          # 실제로 기다리지 않게
sug.time.sleep = lambda s: slept.append(s)
fkd.time.sleep = lambda s: slept.append(s)
sug.load_env_supabase = lambda: None

# ── 1. 계속 실패하면: 5회 시도 후 마지막 에러를 올려보낸다 ──
calls = []


def always_fail(url):
    calls.append(url)
    raise psycopg2.OperationalError("could not translate host name")


psycopg2.connect = always_fail
slept.clear()
try:
    sug.get_conn()
    raise AssertionError("예외가 나왔어야 함")
except psycopg2.OperationalError as e:
    assert "translate host name" in str(e), e
assert len(calls) == 6, "시도 횟수 %d (6이어야 함)" % len(calls)
assert slept == [2, 4, 8, 16, 30], "백오프 %r" % slept
assert sum(slept) >= 55, sum(slept)
print("  [ok] 계속 실패: 6회 시도, 총 대기 %d초, 원인 예외 보존" % sum(slept))

# ── 2. 3번째에 네트워크가 붙으면: 거기서 멈추고 커넥션을 돌려준다 ──
calls.clear()
slept.clear()
SENTINEL = object()


def fail_twice(url):
    calls.append(url)
    if len(calls) < 3:
        raise psycopg2.OperationalError("could not translate host name")
    return SENTINEL


psycopg2.connect = fail_twice
assert sug.get_conn() is SENTINEL
assert len(calls) == 3, len(calls)
assert slept == [2, 4], slept
print("  [ok] 3번째 성공: 더 안 기다리고 즉시 반환")

# ── 3. api_get 백오프도 기상 시간을 덮는지 ──
attempts = []


def boom(req, timeout=None):
    attempts.append(1)
    raise OSError("[Errno 11001] getaddrinfo failed")


fkd.urllib.request.urlopen = boom
slept.clear()
try:
    fkd.api_get("/match/list")
    raise AssertionError("예외가 나왔어야 함")
except OSError:
    pass
assert len(attempts) == 6, len(attempts)
assert sum(slept) >= 55, "총 대기 %ds - 기상(30~60초)을 못 덮음" % sum(slept)
print("  [ok] api_get: 6회 시도, 총 대기 %d초 (기상 창 커버)" % sum(slept))

print("전부 통과.")
