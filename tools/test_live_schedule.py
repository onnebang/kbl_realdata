"""live_collector 무인 실행 일정 규칙 회귀 검사(DB·API 없이). python test_live_schedule.py"""
import datetime

import live_collector as lc

KST = lc.KST
D = datetime.date(2026, 10, 3)  # 개막일: 14:00, 14:00, 16:30


def at(hhmm):
    h, m = map(int, hhmm.split(":"))
    return datetime.datetime.combine(D, datetime.time(h, m), tzinfo=KST).timestamp()


tip = {"A": lc.tipoff_epoch(D, datetime.time(14, 0)), "C": lc.tipoff_epoch(D, datetime.time(16, 30))}
assert tip["A"] == at("14:00") and lc.tipoff_epoch(D, None) == 0.0

# 경기 30분 전부터만 폴링
assert lc.due_games({"A", "C"}, tip, at("13:29")) == set()
assert lc.due_games({"A", "C"}, tip, at("13:30")) == {"A"}
assert lc.due_games({"A", "C"}, tip, at("16:00")) == {"A", "C"}

# 13:30에 떠도 16:30 경기가 시작 전에 떨어지지 않는다(예전 버그: 15:30에 떨어짐)
progress = {gk: (tip[gk], 0) for gk in tip}
summaries = [{"gmkey": "A", "events": 120}]
assert lc.drop_stalled({"A", "C"}, progress, summaries, at("15:31"), 2 * 3600) == set()

# 16:30 경기가 연기돼 이벤트가 끝내 0건이면 예정 시각 2시간 뒤에 떨어진다
assert lc.drop_stalled({"C"}, progress, [{"gmkey": "C", "events": 0}], at("18:29"), 2 * 3600) == set()
assert lc.drop_stalled({"C"}, progress, [{"gmkey": "C", "events": 0}], at("18:30"), 2 * 3600) == {"C"}

# 진행 중 경기는 이벤트가 늘면 시계가 갱신된다
assert lc.drop_stalled({"A"}, progress, [{"gmkey": "A", "events": 130}], at("17:00"), 2 * 3600) == set()
assert progress["A"] == (at("17:00"), 130)

print("ok")
