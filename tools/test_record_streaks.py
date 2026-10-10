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
