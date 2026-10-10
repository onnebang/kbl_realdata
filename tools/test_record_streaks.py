# -*- coding: utf-8 -*-
"""record_streaks.py + record_book.py 연속 기록(3단계) 단위 테스트 - 합성 경기로 DB·raw 없이 돈다(마지막 실데이터 테스트만 RECORD_BOOK_SLOW=1일 때).

실행:  python test_record_streaks.py
       RECORD_BOOK_SLOW=1 python test_record_streaks.py   # raw/games 전체(1~2분)로 알려진 연속 기록 단언
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import record_book as rb  # noqa: E402

CODE = {"2+": "201", "2-": "202", "3+": "205", "3-": "206", "f+": "203", "f-": "204"}


def game_of(gmkey, date, home, away, specs, start="19:00", season="2026-2027"):
    """specs: [(pcode, tcode, tokens)] - tokens가 None이면 결장(박스에 안 나옴), ""이면 출전했지만 슛 없음.
    슛 토큰('2+','2-','3+','3-','f+','f-')은 공식 박스(rec)와 이벤트(text-cast)에 같이 반영돼 게이트를 통과한다."""
    players, events, n = [], [], 0
    for pcode, tc, tokens in specs:
        if tokens is None:
            continue
        rec = {"playMin": 10, "playSec": 0, "fgt": 0, "fgtA": 0, "threep": 0, "threepA": 0, "ft": 0, "ftA": 0, "score": 0}
        for t in tokens.split():
            n += 1
            events.append({"n": n, "q": "Q1", "m": 9, "s": 59 - (n % 50), "p": f"선수{pcode}", "t": tc, "a": CODE[t]})
            if t in ("2+", "3+"):
                rec["fgt"] += 1
            if t[0] in "23":
                rec["fgtA"] += 1
            if t == "3+":
                rec["threep"] += 1
            if t in ("3+", "3-"):
                rec["threepA"] += 1
            if t == "f+":
                rec["ft"] += 1
            if t in ("f+", "f-"):
                rec["ftA"] += 1
        players.append({"pcode": pcode, "pname": f"선수{pcode}", "tcode": tc, "rec": rec, "starter": 1})
    return {
        "gmkey": gmkey, "date": date, "start": start, "season": season, "category": "정규시즌", "home": home, "away": away,
        "names": {home: "홈", away: "원정"}, "has_ot": False,
        "quarters": {home: {"q": [0, 0, 0, 0], "ot": []}, away: {"q": [0, 0, 0, 0], "ot": []}},
        "players": players, "teams": {home: {"score": 0}, away: {"score": 0}}, "events": events,
    }


# ---------------------------------------------------------------------------
# 한 경기 안 연속 슛(record_book)
# ---------------------------------------------------------------------------

def test_shot_sequences_follow_event_order_and_pass_the_official_gate():
    g = game_of("S49G01N1", "2026-10-05", "H", "A", [("p1", "H", "2+ 3+ 2- f+ f- f-")])
    ok, bad = rb.shot_sequences(g)
    assert ok["p1"] == {"fg": [True, True, False], "tp": [True], "ft": [True, False, False]} and bad == {}


def test_gate_failure_is_per_kind():
    g = game_of("S49G01N1", "2026-10-05", "H", "A", [("p1", "H", "2+ 3+ 2- f+ f- f-")])
    g["players"][0]["rec"]["ftA"] = 2                      # 자유투 시도 수가 공식과 다르다
    ok, bad = rb.shot_sequences(g)
    assert set(ok["p1"]) == {"fg", "tp"} and bad == {"p1": {"ft"}}


def test_same_name_players_fail_every_kind():
    g = game_of("S49G01N1", "2026-10-05", "H", "A", [("p1", "H", "2+ 2+")])
    g["players"].append({"pcode": "p2", "pname": "선수p1", "tcode": "H", "rec": {"playMin": 5, "fgt": 0, "fgtA": 0}, "starter": 0})
    ok, bad = rb.shot_sequences(g)
    assert ok == {} and set(bad) == {"p1", "p2"} and bad["p1"] == {"fg", "tp", "ft"}


def test_single_game_boards_need_five_in_a_row():
    toks = " ".join(["2+"] * 6 + ["2-"] * 5 + ["2+"] * 2)
    rows = rb.single_shot_candidates(game_of("S49G01N1", "2026-10-05", "H", "A", [("p1", "H", toks)]))
    assert sorted((r["board"], r["subject"], r["value"], r["bucket"], r["period"]) for r in rows) == [
        ("pg.sfg_made.max", "p1", 6, "G", ""), ("pg.sfg_miss.max", "p1", 5, "G", "")
    ]
    short = " ".join(["2+"] * 4 + ["2-"] * 4)
    assert rb.single_shot_candidates(game_of("S49G01N1", "2026-10-05", "H", "A", [("p1", "H", short)])) == []


def test_single_game_boards_are_per_kind_and_part_of_the_game_candidates():
    toks = " ".join(["3+"] * 5 + ["f-"] * 5)
    g = game_of("S49G01N1", "2026-10-05", "H", "A", [("p1", "H", toks)])
    got = sorted((r["board"], r["value"]) for r in rb.single_shot_candidates(g))
    assert got == [("pg.sfg_made.max", 5), ("pg.sft_miss.max", 5), ("pg.stp_made.max", 5)]
    assert {"pg.sfg_made.max", "pg.stp_made.max"} <= {r["board"] for r in rb.moment_candidates(g)}


# ---------------------------------------------------------------------------
# 상태기계 record_streaks (연속 출장 + 경기 간 연속 슛)
# ---------------------------------------------------------------------------

import functools  # noqa: E402
import json  # noqa: E402
import tempfile  # noqa: E402

import record_streaks as rs  # noqa: E402


def small_min(fn):
    """테스트에서는 행 후보 최소 길이를 2로 낮춘다(짧은 합성 연속도 행이 되게)."""
    @functools.wraps(fn)
    def run():
        old = rs.MIN_ROW
        rs.MIN_ROW = 2
        try:
            return fn()
        finally:
            rs.MIN_ROW = old
    return run


def log_of(log, pcode, kind):
    return [(r["gmkey"], r["before_len"], r["after_len"], r["alive"]) for r in log if r["pcode"] == pcode and r["kind"] == kind]


def rows_of(rows, board):
    return sorted((r["subject"], r["value"], r["period"], r["gmkey"]) for r in rows if r["board"] == board)


@small_min
def test_gp_same_team_streak_breaks_on_a_missed_team_game():
    games = [
        game_of("S49G01N1", "2026-10-01", "H", "A", [("p1", "H", ""), ("q1", "A", "")]),
        game_of("S49G01N2", "2026-10-02", "H", "A", [("p1", "H", ""), ("q1", "A", "")]),
        game_of("S49G01N3", "2026-10-03", "H", "A", [("p1", "H", ""), ("q1", "A", "")]),
        game_of("S49G01N4", "2026-10-04", "H", "A", [("p1", "H", None), ("q1", "A", "")]),   # p1 결장
        game_of("S49G01N5", "2026-10-05", "H", "A", [("p1", "H", ""), ("q1", "A", "")]),
    ]
    rows, log = rs.compute(games)
    assert log_of(log, "p1", "gp") == [("S49G01N1", 0, 1, False), ("S49G01N2", 1, 2, False), ("S49G01N3", 2, 3, False), ("S49G01N5", 0, 1, True)]
    assert rows_of(rows, "pg.streak_gp.max") == [("p1", 3, "E:S49G01N1", "S49G01N3"), ("q1", 5, "A:S49G01N1", "S49G01N5")]   # p1 끝난 3경기, q1 진행 중 5경기
    assert log_of(log, "q1", "gp")[-1] == ("S49G01N5", 4, 5, True)


@small_min
def test_gp_continues_across_an_offseason_transfer_only_if_he_plays_the_new_teams_first_game():
    old = [game_of("S47G01N1", "2025-10-01", "X", "Z", [("p1", "X", ""), ("z", "Z", "")]), game_of("S47G01N2", "2025-10-02", "X", "Z", [("p1", "X", ""), ("z", "Z", "")])]
    new_ok = [game_of("S49G01N1", "2026-10-01", "Y", "Z", [("p1", "Y", ""), ("z", "Z", "")]), game_of("S49G01N2", "2026-10-02", "Y", "Z", [("p1", "Y", ""), ("z", "Z", "")])]
    _, log = rs.compute(old + new_ok, keep_days=None)                                                    # 시즌이 달라 로그 120일 창 밖이 생기므로 전체 로그로
    assert log_of(log, "p1", "gp") == [("S47G01N1", 0, 1, False), ("S47G01N2", 1, 2, False), ("S49G01N1", 2, 3, False), ("S49G01N2", 3, 4, True)]
    new_late = [game_of("S49G01N1", "2026-10-01", "Y", "Z", [("p1", "Y", None), ("z", "Z", "")]), game_of("S49G01N2", "2026-10-02", "Y", "Z", [("p1", "Y", ""), ("z", "Z", "")])]
    _, log2 = rs.compute(old + new_late, keep_days=None)
    assert log_of(log2, "p1", "gp")[-1] == ("S49G01N2", 0, 1, True)                       # 새 팀 첫 경기를 건너뛰면 끊긴다


@small_min
def test_gp_in_season_transfer_needs_the_first_new_team_game_after_his_last_one():
    g1 = game_of("S49G01N1", "2026-10-01", "X", "Z", [("p1", "X", ""), ("z", "Z", "")])
    g2 = game_of("S49G01N2", "2026-10-02", "Y", "Z", [("p1", "Y", ""), ("z", "Z", "")])          # 이적 직후 첫 경기에 출전 -> 이어짐
    _, log = rs.compute([g1, g2])
    assert log_of(log, "p1", "gp") == [("S49G01N1", 0, 1, False), ("S49G01N2", 1, 2, True)]
    g2b = game_of("S49G01N2", "2026-10-02", "Y", "Z", [("p1", "Y", None), ("z", "Z", "")])       # Y가 먼저 치른 경기를 건너뛰고
    g3 = game_of("S49G01N3", "2026-10-03", "Y", "Z", [("p1", "Y", ""), ("z", "Z", "")])          # 다음 경기에 출전 -> 끊김
    _, log2 = rs.compute([g1, g2b, g3])
    assert log_of(log2, "p1", "gp")[-1] == ("S49G01N3", 0, 1, True)


@small_min
def test_gp_alive_only_when_he_played_his_teams_latest_game():
    games = [
        game_of("S49G01N1", "2026-10-01", "H", "A", [("p1", "H", ""), ("p2", "H", ""), ("q1", "A", "")]),
        game_of("S49G01N2", "2026-10-02", "H", "A", [("p1", "H", ""), ("p2", "H", None), ("q1", "A", "")]),
    ]
    _, log = rs.compute(games)
    assert log_of(log, "p1", "gp")[-1][3] is True and log_of(log, "p1", "gp")[0][3] is False         # 최신 행만 alive
    assert all(r["alive"] is False for r in log if r["pcode"] == "p2")                                  # 팀의 마지막 경기에 안 나왔다


@small_min
def test_shot_runs_carry_across_games_and_show_in_log_and_rows():
    games = [
        game_of("S49G01N1", "2026-10-01", "H", "A", [("p1", "H", "2+ 2+ 2- 2+")]),
        game_of("S49G01N2", "2026-10-02", "H", "A", [("p1", "H", "2+ 2+ 2+")]),
        game_of("S49G01N3", "2026-10-03", "H", "A", [("p1", "H", "2-")]),
    ]
    rows, log = rs.compute(games)
    assert log_of(log, "p1", "xfg_made") == [("S49G01N1", 0, 1, False), ("S49G01N2", 1, 4, False), ("S49G01N3", 4, 0, False)]
    assert log_of(log, "p1", "xfg_miss") == [("S49G01N3", 0, 1, True)]
    made = rows_of(rows, "pg.xfg_made.max")
    assert made == [("p1", 2, "E:S49G01N1", "S49G01N1"), ("p1", 4, "E:S49G01N1", "S49G01N2")]          # 첫 경기 앞의 2연속(끝남), 1->4 경기 간 연속(끝남)
    assert rows_of(rows, "pg.xfg_miss.max") == []                                                       # 실패 연속 1은 최소 길이 미만


@small_min
def test_shot_gate_failure_resets_only_that_kind():
    g1 = game_of("S49G01N1", "2026-10-01", "H", "A", [("p1", "H", "2+ 2+ 2+ f+ f+")])
    g2 = game_of("S49G01N2", "2026-10-02", "H", "A", [("p1", "H", "2+ f+")])
    g2["players"][0]["rec"]["fgtA"] = 5                                                                 # 야투만 공식과 어긋난 경기
    rows, log = rs.compute([g1, g2])
    assert log_of(log, "p1", "xfg_made") == [("S49G01N1", 0, 3, False), ("S49G01N2", 3, 0, False)]     # 끊김(모르는 구간은 이어 붙이지 않는다)
    assert log_of(log, "p1", "xft_made") == [("S49G01N1", 0, 2, False), ("S49G01N2", 2, 3, True)]      # 자유투는 계속 이어짐
    assert ("p1", 3, "E:S49G01N1", "S49G01N1") in rows_of(rows, "pg.xfg_made.max")


@small_min
def test_players_without_a_known_identity_never_get_streaks():
    g = game_of("S49G01N1", "2026-10-01", "H", "A", [("p1", "H", "2+ 2+ 2+")])
    g["players"].append({"pcode": "p2", "pname": "선수p1", "tcode": "H", "rec": {"playMin": 3, "fgt": 0, "fgtA": 0}, "starter": 0})     # 동명이인
    rows, log = rs.compute([g])
    assert not [r for r in log if r["kind"].startswith("x")]


@small_min
def test_log_keeps_only_the_recent_window_and_refresh_is_idempotent():
    games = [game_of(f"S49G01N{i}", d, "H", "A", [("p1", "H", "2+ 2+")]) for i, d in enumerate(["2026-02-01", "2026-09-30", "2026-10-01"], 1)]
    rows, log = rs.compute(games)
    assert {r["gmkey"] for r in log} == {"S49G01N2", "S49G01N3"}                                         # 120일 밖(2026-02-01)은 로그에서 빠진다
    other = {"board": "pq.ast.max", "bucket": "Q1", "gmkey": "S1G01N1", "subject": "x", "period": "Q1", "value": 9, "game_date": "2020-01-01", "game_start": "",
             "season_name": "s", "category": "정규시즌", "subject_name": "x", "tcode": "H", "opp_tcode": "A", "is_ot": False}
    store = rb.MemoryStore([other])
    a = rs.refresh(store, games=games)
    first_rows, first_log = store.all_rows(), store.all_log()
    b = rs.refresh(store, games=games)
    assert a == b and sorted(map(str, store.all_rows())) == sorted(map(str, first_rows)) and sorted(map(str, store.all_log())) == sorted(map(str, first_log))
    assert any(r["board"] == "pq.ast.max" for r in store.all_rows())                                     # 연속 보드가 아닌 행은 그대로
    assert any(r["board"] == "pg.xfg_made.max" for r in store.all_rows())


def test_per_game_apply_never_touches_streak_rows():
    streak_row = {"board": "pg.streak_gp.max", "bucket": "G", "gmkey": "S49G01N3", "subject": "p1", "period": "A:S49G01N1", "value": 9, "game_date": "2026-10-03",
                  "game_start": "19:00", "season_name": "s", "category": "정규시즌", "subject_name": "p1", "tcode": "H", "opp_tcode": "A", "is_ot": False}
    store = rb.MemoryStore([streak_row])
    rb.apply_game(store, "S49G01N3", [])                                                                 # 같은 gmkey를 다시 정산해도
    assert [r["board"] for r in store.all_rows()] == ["pg.streak_gp.max"]                                # 연속 보드 행은 그대로(통째 재계산 몫)
    assert tuple(rs.BOARD.values()) == rb.STREAK_BOARDS == rs.STREAK_BOARDS


@small_min
def test_build_collapses_duplicate_primary_keys():
    toks = " ".join(["2+"] * 3 + ["2-"] + ["2+"] * 3 + ["2-"] + ["2+"] * 4)                              # 한 경기 안에서 시작·끝난 3연속이 두 번(같은 PK) + 열려 있는 4연속
    rows, _ = rs.build(games=[game_of("S49G01N1", "2026-10-01", "H", "A", [("p1", "H", toks)])])
    made = sorted((r["period"], r["value"]) for r in rows if r["board"] == "pg.xfg_made.max")
    assert made == [("A:S49G01N1", 4), ("E:S49G01N1", 3)]


def test_pgstore_streak_sql_shape():
    class Cur:
        def __init__(self):
            self.statements = []

        def execute(self, sql, params=None):
            self.statements.append((sql, params))
    cur = Cur()
    store = rb.PgStore(cur)
    store.replace_board_rows(rs.STREAK_BOARDS, [])
    assert cur.statements[-1] == ("delete from record_entries where board = any(%s)", (list(rs.STREAK_BOARDS),))
    store.replace_log([])
    assert cur.statements[-1][0] == "delete from record_streak_log"


def test_diff_log_compares_primary_keys_and_values():
    a = [{"gmkey": "G1", "pcode": "p", "kind": "gp", "before_len": 1, "after_len": 2, "alive": True, "start_gmkey": "G0"}]
    assert rb.diff_log(a, [dict(a[0])]) == ([], [], [])
    changed = dict(a[0], after_len=3)
    assert rb.diff_log(a, [changed]) == ([], [], [("G1", "p", "gp")])
    assert rb.diff_log(a, []) == ([("G1", "p", "gp")], [], [])
    assert rb.diff_log([], a) == ([], [("G1", "p", "gp")], [])


def test_have_history_needs_enough_raw_games():
    with tempfile.TemporaryDirectory() as d:
        for i in range(3):
            os.makedirs(os.path.join(d, f"S49G01N{i}"))
        assert rs.have_history(d) is False
        old = rs.RAW_HISTORY_MIN
        rs.RAW_HISTORY_MIN = 3
        try:
            assert rs.have_history(d) is True
        finally:
            rs.RAW_HISTORY_MIN = old
        assert rs.have_history(os.path.join(d, "nope")) is False


def test_raw_order_sorts_by_date_then_start_and_skips_ineligible():
    with tempfile.TemporaryDirectory() as d:
        def put(gm, date, start, cat="정규시즌", ended=1):
            os.makedirs(os.path.join(d, gm))
            with open(os.path.join(d, gm, "meta.json"), "w", encoding="utf-8") as f:
                json.dump({"game": {"gmkey": gm, "seasonCategoryName": cat, "isEnded": ended, "gameDate": date, "gameStart": start}}, f)
        put("S49G01N2", "20261002", "1900")
        put("S49G01N1", "20261002", "1400")
        put("S49G01N0", "20261001", "1900")
        put("S49G01N9", "20261003", "1900", cat="OPEN MATCH DAY")
        put("S49G01N8", "20261004", "1900", ended=0)
        assert rs.raw_order(d) == ["S49G01N0", "S49G01N1", "S49G01N2"]


def test_schema_sql_matches_log_columns():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema_record_streak_log.sql")
    body = open(path, encoding="utf-8").read()
    for col in rs.LOG_COLUMNS:
        assert f"{col} " in body or f"{col}\t" in body, col
    assert "enable row level security" in body and "revoke all on record_streak_log from anon, authenticated" in body and "create policy" not in body


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
