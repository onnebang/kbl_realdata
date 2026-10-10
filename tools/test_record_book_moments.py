# -*- coding: utf-8 -*-
"""record_book.py 2단계(순간 기록 14개 보드) 단위 테스트 - 합성 경기로 DB·raw 없이 돈다(마지막 실데이터 테스트만 RECORD_BOOK_SLOW=1일 때).

실행:  python test_record_book_moments.py
       RECORD_BOOK_SLOW=1 python test_record_book_moments.py   # raw/games 전체(1~2분)로 알려진 기록 단언
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import record_book as rb  # noqa: E402


def e(n, q, m, s, name, tc, a):
    return {"n": n, "q": q, "m": m, "s": s, "p": name, "t": tc, "a": a}


def player(pcode, name, tc, starter=1, **rec):
    base = {"score": 0, "rb": 0, "ast": 0, "stl": 0, "bs": 0, "foul": 0, "playMin": 0, "playSec": 0}
    base.update(rec)
    return {"pcode": pcode, "pname": name, "tcode": tc, "rec": base, "starter": starter}


def game(events, players, hq, aq, gmkey="S49G01N1"):
    return {
        "gmkey": gmkey, "date": "2026-10-08", "start": "19:00", "season": "2026-2027", "category": "정규시즌",
        "home": "H", "away": "A", "names": {"H": "홈팀", "A": "원정팀"},
        "quarters": {"H": {"q": hq, "ot": []}, "A": {"q": aq, "ot": []}}, "has_ot": False,
        "players": players, "teams": {"H": {"score": sum(hq)}, "A": {"score": sum(aq)}}, "events": events,
    }


def boards(rows, board):
    return sorted((r["subject"], r["value"]) for r in rows if r["board"] == board)


# ---------------------------------------------------------------------------
# 게이트 추출 / 보조 함수
# ---------------------------------------------------------------------------

def test_quarters_match_official():
    ev = [e(1, "Q1", 9, 0, "가드", "H", "201") for _ in range(5)]
    assert rb.quarters_match_official(game(ev, [], [10, 0, 0, 0], [0, 0, 0, 0]))
    assert not rb.quarters_match_official(game(ev, [], [8, 0, 0, 0], [0, 0, 0, 0]))
    bad_final = game(ev, [], [10, 0, 0, 0], [0, 0, 0, 0])
    bad_final["teams"]["H"]["score"] = 12
    assert not rb.quarters_match_official(bad_final)


def test_season_number_and_event_time():
    assert rb.season_number("S49G01N9") == 49 and rb.season_number("S13G01N167") == 13 and rb.season_number("X") == 0
    assert rb.event_time({"q": "Q1", "m": 10, "s": 0}) == 0
    assert rb.event_time({"q": "Q2", "m": 5, "s": 0}) == 900
    assert rb.event_time({"q": "X1", "m": 4, "s": 30}) == 2400 + 300 - 270
    assert rb.event_time({"q": "Q1"}) is None and rb.event_time({"q": "PRE", "m": 1, "s": 1}) is None


def test_parse_game_carries_starter_flag():
    meta = {"game": {"gmkey": "S99G01N2", "seasonCategoryName": "정규시즌", "isEnded": 1, "gameDate": "20261008", "gameStart": "1900",
                     "tcodeH": "H", "tcodeA": "A", "tnameH": "홈팀", "tnameA": "원정팀", "seasonName": "2026-2027"}, "teamrecords": {}}
    ps = [{"player": {"pcode": "p1", "pname": "가드", "tcode": "H"}, "records": {}, "startFlag": 1},
          {"player": {"pcode": "p2", "pname": "벤치", "tcode": "H"}, "records": {}, "startFlag": 0}]
    g = rb.parse_game(meta, ps, [], [])
    assert [p["starter"] for p in g["players"]] == [1, 0]


# ---------------------------------------------------------------------------
# 공식 박스 보드
# ---------------------------------------------------------------------------

def test_margin_row_only_for_the_winner():
    g = game([], [], [20, 20, 20, 20], [18, 18, 18, 18])
    rows = rb.official_moment_candidates(g)
    assert [(r["board"], r["bucket"], r["subject"], r["period"], r["value"], r["subject_name"], r["opp_tcode"]) for r in rows] == [
        ("tg.margin.max", "G", "H", "", 8, "홈팀", "A")
    ]
    away_wins = game([], [], [10, 10, 10, 10], [20, 20, 20, 20])
    assert boards(rb.official_moment_candidates(away_wins), "tg.margin.max") == [("A", 40)]
    assert rb.official_moment_candidates(game([], [], [20, 20, 20, 20], [20, 20, 20, 20])) == []


def test_bench_nopts_and_clubs():
    ps = [
        player("b1", "벤치", "H", starter=0, score=31, rb=2, ast=1, playMin=20),
        player("s1", "선발", "H", starter=1, score=31, rb=2, ast=1, playMin=30),
        player("u1", "미상", "H", starter=None, score=20, rb=1, playMin=10),
        player("z1", "무득점", "H", starter=1, score=0, rb=13, ast=4, playMin=25),
        player("t1", "트리플", "A", starter=1, score=12, rb=11, ast=10, stl=1, playMin=35),
        player("q1", "쿼드", "A", starter=1, score=10, rb=10, ast=10, stl=10, bs=2, playMin=35),
        player("x1", "오오", "A", starter=1, score=5, rb=5, ast=5, stl=5, bs=5, playMin=35),
        player("d1", "결장", "A", starter=0, score=0, rb=0, ast=0, playMin=0),
    ]
    rows = [r for r in rb.official_moment_candidates(game([], ps, [20] * 4, [18] * 4)) if r["board"] != "tg.margin.max"]
    got = sorted((r["board"], r["subject"], r["value"]) for r in rows)
    assert got == sorted([
        ("pg.benchpts.max", "b1", 31),
        ("pg.nopts_reb.max", "z1", 13), ("pg.nopts_ast.max", "z1", 4),
        ("pg.club_td.max", "t1", 1),
        ("pg.club_td.max", "q1", 1), ("pg.club_qd.max", "q1", 1),
        ("pg.club_x5.max", "x1", 1),
    ])
    assert all(r["bucket"] == "G" and r["period"] == "" for r in rows)


def test_game_candidates_include_moment_rows():
    g = game([], [], [20] * 4, [18] * 4)
    assert "tg.margin.max" in {r["board"] for r in rb.game_candidates(g)}


def test_clubs_keep_every_achievement_after_retention():
    rows = [rb._row(game([], [], [1] * 4, [0] * 4, gmkey=f"S40G01N{i}"), "pg.club_td.max", "G", f"p{i}", "", 1, "x", "H") for i in range(40)]
    assert len(rb.retain(rows)) == 40                       # 값이 전부 1이라 순위 1 동률 - 순위 <= 15 규칙이 모두 남긴다


# ---------------------------------------------------------------------------
# 최단 시간 더블더블 / 트리플더블 / 5반칙 퇴장
# ---------------------------------------------------------------------------

def time_game(ast=0, fouls=0, play_min=10, rb_official=10, foul_official=None, gmkey="S49G01N1", hq=None):
    """H의 '가드'가 Q1 10:00에 투입 -> 득점 10점(2점슛 5개, t=60~100초) -> 리바운드 10개(t=125~170) -> 어시스트(t=185~) -> 파울(t=250~) -> Q1 0:00 퇴장."""
    ev, n = [], 0

    def add(m, s, a, q="Q1"):
        nonlocal n
        n += 1
        ev.append(e(n, q, m, s, "가드", "H", a))

    add(10, 0, "101")
    for m, s in [(9, 0), (8, 50), (8, 40), (8, 30), (8, 20)]:
        add(m, s, "201")
    for i in range(10):
        add(7, 55 - 5 * i, "210")
    for i in range(ast):
        add(6, 55 - 5 * i, "211")
    for i in range(fouls):
        add(5, 50 - 10 * i, "215" if i % 2 == 0 else "216")
    add(0, 0, "102")
    p = player("g1", "가드", "H", score=10, rb=rb_official, ast=ast, foul=fouls if foul_official is None else foul_official, playMin=play_min)
    return game(ev, [p], hq or [10, 0, 0, 0], [0, 0, 0, 0], gmkey=gmkey)


def time_rows(g):
    return sorted((r["board"], r["subject"], r["value"]) for r in rb.moment_candidates(g) if r["board"].endswith("_time.min"))


def test_fastest_double_double_uses_on_court_seconds():
    # 10번째 리바운드가 t=170초(Q1 7:10) - 그때까지 코트에 있었으므로 출전 170초
    assert time_rows(time_game()) == [("pg.dd_time.min", "g1", 170)]


def test_fastest_triple_double_and_five_fouls():
    rows = time_rows(time_game(ast=10, fouls=5))
    assert rows == [("pg.dd_time.min", "g1", 170), ("pg.foul5_time.min", "g1", 290), ("pg.td_time.min", "g1", 230)]
    assert time_rows(time_game(fouls=4)) == [("pg.dd_time.min", "g1", 170)]            # 4반칙은 퇴장이 아니다


def test_time_rows_need_matching_minutes_and_totals():
    assert time_rows(time_game(play_min=9)) == []                                      # 공식 출전 540초 vs 재구성 600초 - 게이트 탈락
    assert time_rows(time_game(rb_official=9)) == []                                   # 이벤트 리바운드 10 != 공식 9 - 그 선수 탈락
    assert time_rows(time_game(hq=[11, 0, 0, 0])) == []                                # 게이트 1(이벤트 쿼터 득점 = 공식) 탈락
    only_dd = time_rows(time_game(fouls=5, foul_official=4))                           # 파울 합계만 다르면 5반칙만 빠진다
    assert only_dd == [("pg.dd_time.min", "g1", 170)]


def test_time_rows_work_for_old_seasons_too():
    assert time_rows(time_game(gmkey="S21G01N1")) == [("pg.dd_time.min", "g1", 170)]   # 분 단위 보드는 시즌 컷이 없다


def test_same_name_players_are_skipped():
    g = time_game()
    g["players"].append(player("g2", "가드", "H", score=0, playMin=0))                  # 같은 팀 동명이인 - 이름으로 구분할 수 없다
    assert time_rows(g) == []


# ---------------------------------------------------------------------------
# N초 득점(창) / 팀 연속 득점 런
# ---------------------------------------------------------------------------

def burst_game(gmkey="S49G01N1", official=10, extra=None):
    """Q2 5:00 3점, 4:50 3점, 4:40 2점, 1:00 2점 -> 10초 창 최고 6, 35초·60초 창 최고 8."""
    ev = [e(1, "Q2", 5, 0, "가드", "H", "205"), e(2, "Q2", 4, 50, "가드", "H", "205"), e(3, "Q2", 4, 40, "가드", "H", "201"), e(4, "Q2", 1, 0, "가드", "H", "201")]
    ev += extra or []
    return game(ev, [player("g1", "가드", "H", score=official)], [0, 10, 0, 0], [0, 0, 0, 0], gmkey=gmkey)


def burst_rows(g):
    return sorted((r["board"], r["subject"], r["value"]) for r in rb.moment_candidates(g) if ".burst" in r["board"])


def test_burst_windows_best_points_in_same_quarter():
    assert burst_rows(burst_game()) == [("pg.burst10.max", "g1", 6), ("pg.burst35.max", "g1", 8), ("pg.burst60.max", "g1", 8)]


def test_burst_rows_need_modern_season_matching_total_and_ordered_clock():
    assert burst_rows(burst_game(gmkey="S25G01N1")) == []                              # S31 이전은 시각을 믿을 수 없다
    assert burst_rows(burst_game(official=11)) == []                                   # 득점 합계가 공식과 다르면 제외
    # 시계가 거꾸로 가는 득점 이벤트(Q2 5:05가 4:40 뒤에 나옴) - 그 선수는 통째로 제외(이벤트 쿼터 득점은 맞춰 둔다)
    back = burst_game(extra=[e(5, "Q2", 5, 5, "가드", "H", "201")], official=12)
    back["quarters"]["H"]["q"] = [0, 12, 0, 0]
    back["teams"]["H"]["score"] = 12
    assert burst_rows(back) == []


def test_burst_window_edges_are_inclusive():
    ev = [e(1, "Q1", 9, 0, "가드", "H", "201"), e(2, "Q1", 8, 50, "가드", "H", "201"), e(3, "Q1", 8, 49, "가드", "H", "201")]
    g = game(ev, [player("g1", "가드", "H", score=6)], [6, 0, 0, 0], [0, 0, 0, 0])
    got = {r["board"]: r["value"] for r in rb.moment_candidates(g) if ".burst" in r["board"]}
    assert got["pg.burst10.max"] == 4 and got["pg.burst35.max"] == 6                   # 정확히 10초 차이는 창 안, 11초는 밖


def run_game(order, gmkey="S49G01N1", back=False):
    """order: [(팀, 점수코드)] 순서의 Q3 득점 이벤트(시각은 9:00부터 5초씩)."""
    ev, h, a = [], 0, 0
    for i, (tc, code) in enumerate(order):
        pts = rb.PTS_BY_CODE[code]
        h += pts if tc == "H" else 0
        a += pts if tc == "A" else 0
        t = 540 - 5 * i
        ev.append(e(i + 1, "Q3", t // 60, t % 60, "가드" if tc == "H" else "원정", tc, code))
    if back:
        ev.append(e(len(ev) + 1, "Q3", 9, 59, "가드", "H", "201"))                        # 시계가 거꾸로 - 게이트 탈락
        h += 2
    ps = [player("g1", "가드", "H", score=h), player("a1", "원정", "A", score=a)]
    return game(ev, ps, [0, 0, h, 0], [0, 0, a, 0], gmkey=gmkey)


def run_rows(g):
    return sorted((r["subject"], r["value"]) for r in rb.moment_candidates(g) if r["board"] == "tg.run.max")


def test_team_run_is_unanswered_points_across_events():
    g = run_game([("H", "201"), ("H", "201"), ("H", "205"), ("A", "201"), ("H", "201"), ("H", "203"), ("A", "205")])
    assert run_rows(g) == [("A", 3), ("H", 7)]                                         # H 2+2+3=7 -> A 2 -> H 2+1=3 -> A 3


def test_team_run_needs_modern_season_and_ordered_clock():
    order = [("H", "201"), ("H", "201"), ("A", "201")]
    assert run_rows(run_game(order, gmkey="S25G01N1")) == []
    assert run_rows(run_game(order, back=True)) == []


def test_moment_candidates_are_in_the_game_candidates_and_cover_all_boards():
    g = time_game(ast=10, fouls=5)
    boards_made = {r["board"] for r in rb.game_candidates(g)}
    assert {"pg.dd_time.min", "pg.td_time.min", "pg.foul5_time.min", "pg.club_td.max"} <= boards_made


# ---------------------------------------------------------------------------
# 실데이터 - RECORD_BOOK_SLOW=1
# ---------------------------------------------------------------------------

def test_known_records_on_real_data():
    if os.environ.get("RECORD_BOOK_SLOW") != "1" or not os.path.isdir(rb.RAW_GAMES):
        print("    (건너뜀: RECORD_BOOK_SLOW=1 이고 raw/games가 있을 때만)")
        return
    rows, stats = rb.build_all()
    assert len(rows) < rb.MAX_ROWS, len(rows)

    def top(board, n=1):
        return [r for rank, r in rb.rank_sorted([r for r in rows if r["board"] == board]) if rank <= n]

    m = top("tg.margin.max")[0]
    assert (m["value"], m["gmkey"]) == (56, "S41G03N11"), m                            # 안양 KGC 99-43 고양 캐롯(2023-04-13 PO)
    assert {(r["value"], r["gmkey"]) for r in top("pg.benchpts.max")} == {(47, "S43G01N236"), (47, "S33G01N9")}
    assert [(r["value"], r["gmkey"]) for r in top("pg.nopts_reb.max")] == [(22, "S45G01N220")]
    assert [(r["value"], r["gmkey"]) for r in top("pg.nopts_ast.max")] == [(16, "S47G01N269")]
    assert [r["gmkey"] for r in top("pg.club_x5.max")] == ["S29G01N233"]                  # 제임스 메이스 2017-03-05
    assert not [r for r in rows if r["board"] == "pg.club_qd.max"]                         # 쿼드러플더블은 KBL 역사에 없다
    assert len([r for r in rows if r["board"] == "pg.club_td.max"]) == 78                 # 트리플더블 전부 남는다
    dd = top("pg.dd_time.min")[0]
    assert (dd["value"], dd["gmkey"]) == (465, "S43G01N218"), dd                          # 알리제 드숀 존슨 7분 45초
    td = top("pg.td_time.min")[0]
    assert (td["value"], td["gmkey"]) == (1168, "S35G01N162"), td                         # 애런 헤인즈 19분 28초
    assert max(r["value"] for r in rows if r["board"] == "pg.burst35.max") == 8
    assert max(r["value"] for r in rows if r["board"] == "pg.burst10.max") <= 8
    assert max(r["value"] for r in rows if r["board"] == "pg.burst60.max") == 10
    assert min(rb.season_number(r["gmkey"]) for r in rows if ".burst" in r["board"] or r["board"] == "tg.run.max") >= rb.CLOCK_TRUSTED_FROM
    runs = [r for r in rows if r["board"] == "tg.run.max"]
    assert max(r["value"] for r in runs) == 24 and {"S37G01N269", "S31G01N108"} & {r["gmkey"] for r in runs if r["value"] == 24}


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
