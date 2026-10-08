# -*- coding: utf-8 -*-
"""record_book.py 단위 테스트 - DB·raw 없이 합성 경기로 돈다(마지막 실데이터 테스트만 RECORD_BOOK_SLOW=1일 때).

실행:  python test_record_book.py
       RECORD_BOOK_SLOW=1 python test_record_book.py   # raw/games 전체(1~2분)로 알려진 기록 단언
"""
import json
import os
import random
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import record_book as rb  # noqa: E402


# ---------------------------------------------------------------------------
# 합성 경기 - 홈 H(선수 p1 득점, p2 어시), 원정 A(선수 q1)
# ---------------------------------------------------------------------------

def ev(q, name, tc, a, n=1):
    return [{"q": q, "p": name, "t": tc, "a": a} for _ in range(n)]


def base_events():
    """H: 쿼터마다 p1이 2점슛 10개(20점), p2가 어시스트 q 번째 쿼터에 q개. A: 쿼터마다 q1이 2점슛 9개(18점)."""
    out = []
    for i, q in enumerate(rb.REG_PERIODS, 1):
        out += ev(q, "가드", "H", "201", 10) + ev(q, "도우미", "H", "211", i) + ev(q, "원정", "A", "201", 9)
    return out


def make_game(**over):
    g = {
        "gmkey": "S99G01N1", "date": "2026-10-08", "start": "19:00", "season": "2026-2027", "category": "정규시즌",
        "home": "H", "away": "A", "names": {"H": "홈팀", "A": "원정팀"},
        "quarters": {"H": {"q": [20, 20, 20, 20], "ot": []}, "A": {"q": [18, 18, 18, 18], "ot": []}},
        "has_ot": False,
        "players": [
            {"pcode": "p1", "pname": "가드", "tcode": "H", "rec": {"score": 80, "rb": 0, "ast": 0, "stl": 0, "bs": 0, "threep": 0, "to": 0}},
            {"pcode": "p2", "pname": "도우미", "tcode": "H", "rec": {"score": 0, "rb": 0, "ast": 10, "stl": 0, "bs": 0, "threep": 0, "to": 0}},
            {"pcode": "q1", "pname": "원정", "tcode": "A", "rec": {"score": 72, "rb": 0, "ast": 0, "stl": 0, "bs": 0, "threep": 0, "to": 0}},
        ],
        "teams": {
            "H": {"score": 80, "fgt": 40, "fgtA": 70, "threep": 0, "rb": 0, "ast": 10, "stl": 0, "bs": 0},
            "A": {"score": 72, "fgt": 36, "fgtA": 80, "threep": 0, "rb": 0, "ast": 0, "stl": 0, "bs": 0},
        },
        "events": base_events(),
    }
    g.update(over)
    return g


def by_board(rows, board, bucket=None):
    return [r for r in rows if r["board"] == board and (bucket is None or r["bucket"] == bucket)]


# ---------------------------------------------------------------------------
# parse_game / load_game
# ---------------------------------------------------------------------------

def _meta(category="정규시즌", ended=1, eq=None):
    return {"game": {"gmkey": "S99G01N2", "seasonCategoryName": category, "isEnded": ended, "gameDate": "20261008", "gameStart": "1900",
                     "tcodeH": "H", "tcodeA": "A", "tnameH": "홈팀", "tnameA": "원정팀", "seasonName": "2026-2027"},
            "teamrecords": {"home": {"scoreq1": 20, "scoreq2": 20, "scoreq3": 20, "scoreq4": 20, "scoreeq": eq or []},
                            "away": {"scoreq1": 18, "scoreq2": 18, "scoreq3": 18, "scoreq4": 18, "scoreeq": eq or []}}}


def test_parse_game_skips_ineligible():
    assert rb.parse_game(_meta("OPEN MATCH DAY"), [], [], []) is None
    assert rb.parse_game(_meta("올스타"), [], [], []) is None
    assert rb.parse_game(_meta(ended=0), [], [], []) is None
    g = rb.parse_game(_meta("플레이오프"), [], [], [])
    assert g["category"] == "플레이오프" and g["date"] == "2026-10-08" and g["start"] == "19:00" and g["season"] == "2026-2027"
    assert g["quarters"]["H"]["q"] == [20, 20, 20, 20] and g["has_ot"] is False


def test_parse_game_detects_ot():
    g = rb.parse_game(_meta(eq=[11, 14]), [], [], [])
    assert g["has_ot"] is True and g["quarters"]["H"]["ot"] == [11, 14]


def test_load_game_reads_four_files_and_tolerates_missing():
    with tempfile.TemporaryDirectory() as d:
        gd = os.path.join(d, "S99G01N2")
        os.makedirs(gd)
        files = {"meta.json": _meta(), "player-stat.json": [{"player": {"pcode": "p1", "pname": "가드", "tcode": "H"}, "records": {"score": 4}}],
                 "team-record.json": [{"tcode": "H", "records": {"score": 80}}], "text-cast.json": [{"n": 1, "q": "Q1", "p": "가드", "t": "H", "a": "201"}]}
        for name, body in files.items():
            with open(os.path.join(gd, name), "w", encoding="utf-8") as f:
                json.dump(body, f, ensure_ascii=False)
        g = rb.load_game("S99G01N2", d)
        assert g["players"][0]["pcode"] == "p1" and g["teams"]["H"]["score"] == 80 and len(g["events"]) == 1
        assert rb.load_game("NOPE", d) is None
        os.remove(os.path.join(gd, "text-cast.json"))
        assert rb.load_game("S99G01N2", d) is None


# ---------------------------------------------------------------------------
# 공식 보드
# ---------------------------------------------------------------------------

def test_official_candidates():
    rows = rb.official_candidates(make_game())
    pts = by_board(rows, "pg.pts.max")
    assert sorted((r["subject"], r["value"]) for r in pts) == [("p1", 80), ("q1", 72)]
    assert [r["value"] for r in by_board(rows, "pg.ast.max")] == [10]               # 0인 값은 최다 보드 후보가 아니다
    assert sorted(r["value"] for r in by_board(rows, "tg.pts.max")) == [72, 80] and sorted(r["value"] for r in by_board(rows, "tg.pts.min")) == [72, 80]
    assert sorted(r["value"] for r in by_board(rows, "tg.fgmiss.max")) == [30, 44]  # fgtA - fgt
    assert sorted(r["value"] for r in by_board(rows, "tg.fgm.max")) == [36, 40]
    q = by_board(rows, "tq.pts.max")
    assert len(q) == 8 and {r["bucket"] for r in q} == set(rb.REG_PERIODS)
    assert len(by_board(rows, "tq.pts.min")) == 8
    one = by_board(rows, "tq.pts.max", "Q1")[0]
    assert one["subject_name"] in ("홈팀", "원정팀") and one["opp_tcode"] in ("H", "A") and one["game_start"] == "19:00" and one["is_ot"] is False


def test_official_quarter_rows_skipped_when_sums_disagree():
    g = make_game(has_ot=True)
    g["quarters"]["H"]["ot"] = [6, 9, 13]                  # 80점 팀인데 쿼터 80 + 연장 28 = 108 != 80 -> 홈의 쿼터 보드만 빠진다
    rows = rb.official_candidates(g)
    assert not [r for r in rows if r["board"].startswith("tq.") and r["tcode"] == "H"]
    assert len([r for r in rows if r["board"] == "tq.pts.max" and r["tcode"] == "A"]) == 4
    assert by_board(rows, "tg.pts.max")                    # 경기 보드는 공식 최종 점수라 영향 없다


def test_official_ot_boards_have_no_min():
    g = make_game(has_ot=True)
    g["quarters"]["H"]["ot"] = [11, 0]
    g["quarters"]["A"]["ot"] = [9, 12]
    g["teams"]["H"]["score"], g["teams"]["A"]["score"] = 91, 93        # 쿼터 + 연장 합과 같아야 쿼터 보드가 만들어진다
    rows = rb.official_candidates(g)
    ot = by_board(rows, "tq.pts.max", "OT")
    assert sorted((r["tcode"], r["period"], r["value"]) for r in ot) == [("A", "X1", 9), ("A", "X2", 12), ("H", "X1", 11)]   # 0점 연장은 후보가 아니다
    assert not [r for r in rows if r["board"] == "tq.pts.min" and r["bucket"] == "OT"]
    assert all(r["is_ot"] for r in rows)


# ---------------------------------------------------------------------------
# 이벤트 보드 + 검증 게이트
# ---------------------------------------------------------------------------

def test_event_candidates_pass_gates():
    g = make_game()
    g["players"][1]["rec"]["ast"] = 10
    g["teams"]["H"]["ast"] = 10
    rows = rb.event_candidates(g)
    ast = sorted((r["bucket"], r["value"]) for r in by_board(rows, "pq.ast.max"))
    assert ast == [("Q1", 1), ("Q2", 2), ("Q3", 3), ("Q4", 4)] and all(r["subject"] == "p2" for r in by_board(rows, "pq.ast.max"))
    assert sorted(r["value"] for r in by_board(rows, "pq.pts.max") if r["subject"] == "p1") == [20, 20, 20, 20]
    assert sorted((r["bucket"], r["value"]) for r in by_board(rows, "tq.ast.max")) == [("Q1", 1), ("Q2", 2), ("Q3", 3), ("Q4", 4)]


def test_gate1_quarter_score_mismatch_drops_everything():
    g = make_game(events=base_events() + ev("Q2", "가드", "H", "201", 1))   # H의 2쿼터가 22점으로 공식(20)과 다르다
    assert rb.event_candidates(g) == []


def test_gate1_final_score_mismatch_drops_everything():
    g = make_game()
    g["teams"]["H"]["score"] = 81
    assert rb.event_candidates(g) == []


def test_gate2_item_total_mismatch_drops_only_that_item():
    g = make_game()
    g["players"][1]["rec"]["ast"] = 11       # 도우미 어시스트 이벤트 합 10 != 공식 11
    g["teams"]["H"]["ast"] = 10
    rows = rb.event_candidates(g)
    assert not by_board(rows, "pq.ast.max")
    assert by_board(rows, "pq.pts.max")      # 득점은 그대로
    assert by_board(rows, "tq.ast.max")      # 팀 어시스트는 팀 합계가 맞아 살아 있다


def test_team_events_count_only_player_attributed():
    g = make_game()
    g["players"][1]["rec"]["ast"] = 10
    g["teams"]["H"]["ast"] = 10
    g["events"] = g["events"] + [{"q": "Q1", "p": None, "t": "H", "a": "218"}, {"q": "Q1", "p": None, "t": "H", "a": "211"}]
    rows = rb.event_candidates(g)
    assert sorted(r["value"] for r in by_board(rows, "tq.ast.max")) == [1, 2, 3, 4]   # 선수 귀속이 아닌 이벤트는 세지 않는다


def test_ot_bucket_and_label_gate():
    g = make_game(has_ot=True)
    g["quarters"]["H"]["ot"] = [4]
    g["quarters"]["A"]["ot"] = [2]
    g["teams"]["H"]["score"], g["teams"]["A"]["score"] = 84, 74
    g["players"][0]["rec"]["score"], g["players"][2]["rec"]["score"] = 84, 74
    g["events"] = base_events() + ev("X1", "가드", "H", "201", 2) + ev("X1", "원정", "A", "201", 1)
    rows = rb.event_candidates(g)
    ot = [r for r in by_board(rows, "pq.pts.max", "OT")]
    assert sorted((r["subject"], r["period"], r["value"]) for r in ot) == [("p1", "X1", 4), ("q1", "X1", 2)]
    # 모르는 라벨(EQ1)이면 연장 후보만 사라지고 정규 쿼터는 그대로
    g["events"] = base_events() + ev("EQ1", "가드", "H", "201", 2) + ev("EQ1", "원정", "A", "201", 1)
    rows = rb.event_candidates(g)
    assert not by_board(rows, "pq.pts.max", "OT") and by_board(rows, "pq.pts.max", "Q1")


def test_duplicate_names_on_a_team_are_skipped():
    g = make_game()
    g["players"].append({"pcode": "p3", "pname": "가드", "tcode": "H", "rec": {"score": 0}})
    rows = rb.event_candidates(g)
    assert not [r for r in rows if r["board"].startswith("pq.") and r["tcode"] == "H" and r["subject_name"] == "가드"]


# ---------------------------------------------------------------------------
# 순위 / 보관 / 반영
# ---------------------------------------------------------------------------

def mk(board, bucket, value, gmkey="G", subject="s", period="", date="2026-01-01"):
    return {"board": board, "bucket": bucket, "gmkey": gmkey, "subject": subject, "period": period, "value": value, "game_date": date,
            "game_start": "", "season_name": "", "category": "정규시즌", "subject_name": subject, "tcode": "H", "opp_tcode": "A", "is_ot": False}


def test_rank_sorted_competition_ranking_max_and_min():
    rows = [mk("pq.ast.max", "Q1", v, gmkey=f"G{i}") for i, v in enumerate([7, 9, 8, 8, 8])]
    assert [(rank, r["value"]) for rank, r in rb.rank_sorted(rows)] == [(1, 9), (2, 8), (2, 8), (2, 8), (5, 7)]
    rows = [mk("tq.pts.min", "Q1", v, gmkey=f"G{i}") for i, v in enumerate([5, 2, 3, 2])]
    assert [(rank, r["value"]) for rank, r in rb.rank_sorted(rows)] == [(1, 2), (1, 2), (3, 3), (4, 5)]


def test_retain_keeps_ties_that_straddle_the_cutoff():
    rows = [mk("pq.pts.max", "Q1", 100 - i, gmkey=f"G{i}") for i in range(14)]              # 순위 1~14
    rows += [mk("pq.pts.max", "Q1", 50, gmkey=f"T{i}") for i in range(5)]                    # 순위 15(5건 동률)
    rows += [mk("pq.pts.max", "Q1", 49, gmkey="Z")]                                           # 순위 20 -> 잘린다
    kept = rb.retain(rows, keep=15)
    assert len(kept) == 19 and all(r["value"] >= 50 for r in kept)
    assert len(rb.retain([mk("pq.pts.max", "Q2", 1)], keep=15)) == 1


def test_all_quarters_excludes_ot():
    rows = [mk("pq.ast.max", b, 5) for b in ("Q1", "Q2", "Q3", "Q4", "OT")]
    assert sorted(r["bucket"] for r in rb.all_quarters(rows)) == ["Q1", "Q2", "Q3", "Q4"]


def test_collector_matches_one_shot_retain():
    random.seed(7)
    rows = [mk("pq.ast.max", f"Q{random.randint(1, 4)}", random.randint(1, 30), gmkey=f"G{i}") for i in range(3000)]
    col = rb.Collector(keep=15, prune_at=50)
    for i in range(0, len(rows), 40):
        col.add(rows[i:i + 40])
    assert sorted(rb.pk(r) for r in col.result()) == sorted(rb.pk(r) for r in rb.retain(rows, 15))


def test_apply_game_is_idempotent_and_prunes():
    store = rb.MemoryStore([mk("pq.ast.max", "Q1", 20 - i, gmkey=f"OLD{i}") for i in range(15)])      # 순위 1~15가 꽉 찬 보드
    cand = [mk("pq.ast.max", "Q1", 30, gmkey="NEW"), mk("pq.ast.max", "Q1", 1, gmkey="NEW", subject="weak")]
    res = rb.apply_game(store, "NEW", cand)
    rows = by_board(store.all_rows(), "pq.ast.max", "Q1")
    assert len(rows) == 15 and max(r["value"] for r in rows) == 30 and min(r["value"] for r in rows) == 7   # 20..7 + 30, 가장 낮은 두 개(6, 5...)는 밀려남
    assert res["pruned"] == 2 and not [r for r in rows if r["subject"] == "weak"]
    before = sorted(rb.pk(r) for r in store.all_rows())
    rb.apply_game(store, "NEW", cand)
    assert sorted(rb.pk(r) for r in store.all_rows()) == before


def test_apply_game_replaces_the_games_old_rows():
    store = rb.MemoryStore([mk("pq.ast.max", "Q1", 9, gmkey="G1", subject="old")])
    rb.apply_game(store, "G1", [mk("pq.ast.max", "Q1", 8, gmkey="G1", subject="new")])
    assert [(r["subject"], r["value"]) for r in store.all_rows()] == [("new", 8)]


def test_diff_rows():
    a = [mk("x.max", "Q1", 5, gmkey="G1"), mk("x.max", "Q1", 4, gmkey="G2")]
    b = [mk("x.max", "Q1", 6, gmkey="G1"), mk("x.max", "Q1", 3, gmkey="G3")]
    missing, extra, changed = rb.diff_rows(a, b)
    assert [k[2] for k in missing] == ["G2"] and [k[2] for k in extra] == ["G3"] and [k[2] for k in changed] == ["G1"]


def test_build_all_on_a_temp_archive():
    with tempfile.TemporaryDirectory() as d:
        g = make_game()
        gd = os.path.join(d, "S99G01N1")
        os.makedirs(gd)
        meta = {"game": {"gmkey": "S99G01N1", "seasonCategoryName": "정규시즌", "isEnded": 1, "gameDate": "20261008", "gameStart": "1900",
                         "tcodeH": "H", "tcodeA": "A", "tnameH": "홈팀", "tnameA": "원정팀", "seasonName": "2026-2027"},
                "teamrecords": {"home": {"scoreq1": 20, "scoreq2": 20, "scoreq3": 20, "scoreq4": 20, "scoreeq": []},
                                "away": {"scoreq1": 18, "scoreq2": 18, "scoreq3": 18, "scoreq4": 18, "scoreeq": []}}}
        ps = [{"player": {"pcode": p["pcode"], "pname": p["pname"], "tcode": p["tcode"]}, "records": p["rec"]} for p in g["players"]]
        tr = [{"tcode": tc, "records": rec} for tc, rec in g["teams"].items()]
        for name, body in (("meta.json", meta), ("player-stat.json", ps), ("team-record.json", tr), ("text-cast.json", g["events"])):
            with open(os.path.join(gd, name), "w", encoding="utf-8") as f:
                json.dump(body, f, ensure_ascii=False)
        rows, stats = rb.build_all(d)
        assert stats["games"] == 1 and rows and any(r["board"] == "pg.pts.max" for r in rows)


class _FakeCur:
    """PgStore가 만드는 SQL 모양만 확인하는 가짜 커서(DB 없이)."""

    def __init__(self, rows=()):
        import types
        self.connection = types.SimpleNamespace(encoding="UTF8")
        self.statements, self._rows = [], list(rows)

    def execute(self, sql, params=None):
        self.statements.append((sql.decode() if isinstance(sql, bytes) else sql, params))

    def mogrify(self, template, args):
        return ("(" + ",".join(repr(a) for a in args) + ")").encode()

    def fetchall(self):
        return self._rows


def test_pgstore_sql_shape():
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        print("    (건너뜀: psycopg2 없음)")
        return
    cur = _FakeCur()
    store = rb.PgStore(cur)
    store.upsert([mk("pq.ast.max", "Q1", 9, gmkey="G1"), mk("pq.ast.max", "Q1", 9, gmkey="G1")])      # 같은 키 두 번 -> 한 행
    sql = cur.statements[-1][0]
    assert sql.count("(") >= 1 and "insert into record_entries (board, bucket, gmkey, subject, period, value" in sql, sql
    assert "on conflict (board, bucket, gmkey, subject, period) do update set value = excluded.value" in sql, sql
    assert "board = excluded.board" not in sql and "gmkey = excluded.gmkey" not in sql, sql              # 키 열은 갱신하지 않는다
    assert sql.count("pq.ast.max") == 1, sql
    store.replace_all([])
    assert cur.statements[-1][0] == "delete from record_entries"
    store.lock()
    assert "pg_advisory_xact_lock" in cur.statements[-1][0] and cur.statements[-1][1] == (rb.LOCK_KEY,)
    cur2 = _FakeCur(rows=[("pq.ast.max", "Q1")])
    assert rb.PgStore(cur2).delete_game("G1") == {("pq.ast.max", "Q1")}
    assert "delete from record_entries where gmkey = %s returning board, bucket" in cur2.statements[-1][0]


# ---------------------------------------------------------------------------
# 실데이터 - RECORD_BOOK_SLOW=1
# ---------------------------------------------------------------------------

def test_known_records_on_real_data():
    if os.environ.get("RECORD_BOOK_SLOW") != "1" or not os.path.isdir(rb.RAW_GAMES):
        print("    (건너뜀: RECORD_BOOK_SLOW=1 이고 raw/games가 있을 때만)")
        return
    rows, stats = rb.build_all()
    assert stats["games"] > 5000, stats
    assert len(rows) < rb.MAX_ROWS, len(rows)

    def top(board, bucket=None, n=1):
        rs = [r for r in rows if r["board"] == board and (bucket is None or r["bucket"] == bucket)]
        if bucket is None and board.startswith(("pq.", "tq.")):
            rs = rb.all_quarters(rs)
        return [(rank, r) for rank, r in rb.rank_sorted(rs) if rank <= n]

    r1 = top("pq.ast.max")                                       # 쿼터 어시스트 전체 1위: 허훈 9개(2026-10-07)
    assert [(r["value"], r["gmkey"]) for _, r in r1] == [(9, "S49G01N9")], r1
    r2 = top("pq.ast.max", n=2)
    eights = [r for rank, r in r2 if rank == 2]
    assert len(eights) == 6 and {r["value"] for r in eights} == {8} and "S35G01N201" in {r["gmkey"] for r in eights}, eights
    assert "S11G01N263" not in {r["gmkey"] for r in rows if r["board"] == "pq.ast.max"}        # 김승현 11개(이벤트 중복)는 검증에서 걸러진다
    assert "S21G01N214" not in {r["gmkey"] for r in rows if r["board"] == "pq.ast.max" and r["value"] >= 9}
    q1 = top("tq.pts.max", "Q1")
    assert (q1[0][1]["value"], q1[0][1]["gmkey"]) == (41, "S43G01N58")
    q1min = [r for rank, r in top("tq.pts.min", "Q1")]
    assert q1min[0]["value"] == 2 and "S37G01N128" in {r["gmkey"] for r in q1min}
    tg = [(r["value"], r["gmkey"]) for _, r in top("tg.pts.max", n=3)]                       # 2009-01-21 3차 연장 135-132(원주동부-서울삼성)가 1·2위
    assert tg == [(135, "S13G01N167"), (132, "S13G01N167"), (121, "S31G01N245")], tg
    assert not [r for r in rows if r["gmkey"] == "S13G01N167" and r["board"] == "tq.pts.max"]   # 연장 점수 배열이 틀린 경기는 팀 쿼터 보드에서 빠진다
    pg = top("pg.ast.max")[0][1]
    assert (pg["value"], pg["gmkey"]) == (21, "S35G01N201")


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
