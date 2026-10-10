# 역대 기록 2단계(순간 기록 A + 통산 평균 순위 B) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KBL 역대 기록집에 순간 기록 14개 보드(점수차·벤치 득점·무득점 리바/어시·트리플더블/쿼드러플더블/5x5 클럽·최단 더블더블/트리플더블/5반칙 퇴장·10/35/60초 득점·팀 연속 득점 런)와 통산 평균 순위 진입(득점·리바운드·어시스트·스틸·블록)을 더해, 라이브 토스트·패널·경기 후 리포트에 알린다.

**Architecture:** 파이썬 `tools/record_book.py`가 새 후보 행을 만들어 같은 `record_entries` 테이블(DDL 변경 없음)에 쌓고(게이트·보관 규칙은 1단계와 같다), 웹은 새 순수 모듈 `lib/recordsMoments.ts`가 이벤트를 한 번 훑어 순간 기록을 뽑는다(`buildAllRecordMoments`가 1단계 `buildRecordTimeline`과 합친다). B는 `lib/milestones.ts`·`lib/careerMarks.ts`의 목표 종류에 `avg`를 더한다.

**Tech Stack:** Python 3.11(venv, 테스트는 평범한 스크립트), TypeScript/Next.js 16 + vitest, Supabase Postgres(`record_entries`).

**Spec:** `docs/superpowers/specs/2026-10-10-record-book-phase2-design.md` (1단계: `docs/superpowers/specs/2026-10-08-record-book-design.md`)

## Global Constraints

- 파이썬은 **반드시** `D:\영상작업\축구\개발\.venv\Scripts\python.exe`(Anaconda 금지). 테스트 실행은 `PYTHONIOENCODING=utf-8`.
- 이 저장소의 메인 작업트리에서 수집기가 돈다: `tools/live_collector.py`·`tools/daily_batch.py`는 **건드리지 않는다**(이 계획은 `record_book.py`와 웹만 고친다). 브랜치 전환 금지.
- DB 쓰기(`--rebuild`)와 `git push`는 각각 실행 직전에 사용자 확인을 받는다(Task 10·11). 로컬 커밋은 계획대로 한다. 커밋은 항상 명시한 경로만 `git add`(전체 add 금지).
- 옛 iOS Safari 대상 웹 코드: `.at()`, `.replaceAll()`, `aspect-ratio` 등을 쓰지 않는다.
- 새 서버 데이터 코드는 `supabaseServer`를 쓴다(이 계획의 웹 변경은 순수 함수뿐이라 해당 없음).
- 시간(초) 기반 보드: 초 단위 보드(N초 득점·팀 런)는 시즌 번호 ≥ 31(2017-18)만, 분 단위 보드는 출전 시간 일치 게이트. 모든 이벤트 보드는 1단계 게이트 1(이벤트 쿼터 득점 = 공식 쿼터 점수) 통과가 전제.
- 사용자에게는 한국어로 보고한다.

---

### Task 1: 파이썬 — 게이트 추출 + 공식 박스 보드(점수차·벤치·무득점·클럽)

**Files:**
- Modify: `tools/record_book.py`
- Create: `tools/test_record_book_moments.py`

**Interfaces:**
- Produces: `record_book.quarters_match_official(g, team_pts=None) -> bool`, `quarter_points(g)`, `season_number(gmkey) -> int`, `event_time(e) -> int|None`, `ordered_events(g)`, `played_seconds(rec)`, `official_moment_candidates(g) -> list[row]`, `moment_candidates(g)`; 선수 dict에 `"starter"`(공식 `startFlag`) 키; 새 보드 키(아래 14개 중 이 태스크분): `tg.margin.max`, `pg.benchpts.max`, `pg.nopts_reb.max`, `pg.nopts_ast.max`, `pg.club_td.max`, `pg.club_qd.max`, `pg.club_x5.max` (bucket `G`, period `""`).

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- create: tools/test_record_book_moments.py -->
~~~python
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
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py`

Expected: 모든 테스트가 `AttributeError: module 'record_book' has no attribute ...`(또는 starter KeyError)로 FAIL.

- [ ] **Step 3: `record_book.py` 구현**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
설계: docs/superpowers/specs/2026-10-08-record-book-design.md

- 공식 자료
~~~
<!-- new -->
~~~python
설계: docs/superpowers/specs/2026-10-08-record-book-design.md
2단계(2026-10-10): docs/superpowers/specs/2026-10-10-record-book-phase2-design.md - 순간 기록 14개 보드(`moment_candidates`)

- 공식 자료
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
        "players": [{"pcode": r["player"]["pcode"], "pname": r["player"]["pname"], "tcode": r["player"]["tcode"], "rec": r.get("records") or {}}
                    for r in player_stat],
~~~
<!-- new -->
~~~python
        "players": [{"pcode": r["player"]["pcode"], "pname": r["player"]["pname"], "tcode": r["player"]["tcode"], "rec": r.get("records") or {},
                     "starter": r.get("startFlag")}
                    for r in player_stat],
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
def event_candidates(g):
    """선수 쿼터 전 종목 + 팀 쿼터 리바·어시·스틸·블락. 게이트를 통과한 값만."""
~~~
<!-- new -->
~~~python
def quarter_points(g):
    """(tcode, 쿼터) -> 선수 귀속 이벤트 득점."""
    out = collections.defaultdict(int)
    for e in g["events"]:
        a, q, tc, name = e.get("a"), e.get("q"), e.get("t"), e.get("p")
        if a in PTS_BY_CODE and q and tc and name:
            out[(tc, q)] += PTS_BY_CODE[a]
    return out


def quarters_match_official(g, team_pts=None):
    """게이트 1 - Q1~Q4 이벤트 득점이 공식 쿼터 점수와 같고, 쿼터 합 + 연장 합이 팀 최종 점수와 같다."""
    team_pts = quarter_points(g) if team_pts is None else team_pts
    for tc in (g["home"], g["away"]):
        q = g["quarters"][tc]
        if any(not isinstance(v, int) for v in q["q"]):
            return False
        if any(team_pts.get((tc, f"Q{i}"), 0) != want for i, want in enumerate(q["q"], 1)):
            return False
        final = (g["teams"].get(tc) or {}).get("score")
        if isinstance(final, int) and sum(q["q"]) + sum(v for v in q["ot"] if isinstance(v, int)) != final:
            return False
    return True


def event_candidates(g):
    """선수 쿼터 전 종목 + 팀 쿼터 리바·어시·스틸·블락. 게이트를 통과한 값만."""
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
    # 게이트 1 - 경기: Q1~Q4 이벤트 득점이 공식 쿼터 점수와 같고, 쿼터 합 + 연장 합이 팀 최종 점수와 같다.
    for tc in teams:
        q = g["quarters"][tc]
        if any(not isinstance(v, int) for v in q["q"]):
            return []
        if any(team_pts.get((tc, f"Q{i}"), 0) != want for i, want in enumerate(q["q"], 1)):
            return []
        final = (g["teams"].get(tc) or {}).get("score")
        if isinstance(final, int) and sum(q["q"]) + sum(v for v in q["ot"] if isinstance(v, int)) != final:
            return []
~~~
<!-- new -->
~~~python
    # 게이트 1 - 경기: Q1~Q4 이벤트 득점이 공식 쿼터 점수와 같고, 쿼터 합 + 연장 합이 팀 최종 점수와 같다.
    if not quarters_match_official(g, team_pts):
        return []
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
def game_candidates(g):
    return official_candidates(g) + event_candidates(g)
~~~
<!-- new -->
~~~python
def game_candidates(g):
    return official_candidates(g) + event_candidates(g) + moment_candidates(g)


# ---------------------------------------------------------------------------
# 2단계 후보 - 순간 기록 14개 보드 (설계 2026-10-10-record-book-phase2-design.md §3-§4)
# ---------------------------------------------------------------------------

PERIOD_LEN = {"Q1": 600, "Q2": 600, "Q3": 600, "Q4": 600, "X1": 300, "X2": 300, "X3": 300, "X4": 300}
PERIOD_START = {"Q1": 0, "Q2": 600, "Q3": 1200, "Q4": 1800, "X1": 2400, "X2": 2700, "X3": 3000, "X4": 3300}
CLOCK_TRUSTED_FROM = 31          # S31(2017-18)부터 중계 시각이 믿을 만하다 - 초 단위 보드(N초 득점·팀 런)는 이 시즌 이후만
BURST_WINDOWS = (10, 35, 60)     # N초 득점 창(초)
MINUTES_TOLERANCE = 3            # 재구성한 코트 시간과 공식 출전 시간의 허용 오차(초)
SUB_IN, SUB_OUT = "101", "102"
FOUL_CODES = ("215", "216")      # 개인 파울 - 합이 공식 foul과 96% 일치(2026-10-10 실측)
CAT_ORDER = ("pts", "reb", "ast", "stl", "blk")
CAT_CODES = {"reb": ("209", "210"), "ast": ("211",), "stl": ("212",), "blk": ("213",)}
CAT_OFFICIAL = {"pts": "score", "reb": "rb", "ast": "ast", "stl": "stl", "blk": "bs"}


def season_number(gmkey):
    """'S49G01N9' -> 49(시즌 번호). 못 읽으면 0."""
    head = gmkey.split("G", 1)[0]
    return int(head[1:]) if head[1:].isdigit() else 0


def event_time(e):
    """이벤트의 경기 시작 후 초(쿼터 시작 오프셋 + 쿼터 안 경과). 쿼터나 시각을 모르면 None."""
    q, m, s = e.get("q"), e.get("m"), e.get("s")
    if q not in PERIOD_LEN or not isinstance(m, int) or not isinstance(s, int):
        return None
    return PERIOD_START[q] + PERIOD_LEN[q] - (m * 60 + s)


def ordered_events(g):
    """이벤트를 n 순서로(없으면 입력 순서 그대로 - 안정 정렬)."""
    return sorted(g["events"], key=lambda e: e.get("n", 0))


def played_seconds(rec):
    return (rec.get("playMin") or 0) * 60 + (rec.get("playSec") or 0)


def official_moment_candidates(g):
    """점수차·벤치 득점·무득점 리바/어시·클럽(트리플더블·쿼드러플더블·5x5). 공식 기록만 쓰므로 이벤트 게이트가 없다."""
    rows = []
    h, a = g["home"], g["away"]
    hs, as_ = (g["teams"].get(h) or {}).get("score"), (g["teams"].get(a) or {}).get("score")
    if isinstance(hs, int) and isinstance(as_, int) and hs != as_:
        win = h if hs > as_ else a
        rows.append(_row(g, "tg.margin.max", "G", win, "", abs(hs - as_), g["names"][win], win))
    for p in g["players"]:
        rec = p["rec"]
        cats = [rec.get(CAT_OFFICIAL[c]) for c in CAT_ORDER]
        if played_seconds(rec) <= 0 or not all(isinstance(v, int) for v in cats):
            continue
        score, reb, ast = cats[0], cats[1], cats[2]
        found = []
        if p.get("starter") == 0 and score > 0:
            found.append(("pg.benchpts.max", score))
        if score == 0 and reb > 0:
            found.append(("pg.nopts_reb.max", reb))
        if score == 0 and ast > 0:
            found.append(("pg.nopts_ast.max", ast))
        n10 = sum(1 for v in cats if v >= 10)
        if n10 >= 3:
            found.append(("pg.club_td.max", 1))
        if n10 >= 4:
            found.append(("pg.club_qd.max", 1))
        if all(v >= 5 for v in cats):
            found.append(("pg.club_x5.max", 1))
        rows += [_row(g, board, "G", p["pcode"], "", v, p["pname"], p["tcode"]) for board, v in found]
    return rows


def moment_candidates(g):
    """2단계 보드 전부 - 공식 보드는 늘, 이벤트 보드는 게이트 1을 통과한 경기만."""
    return official_moment_candidates(g)
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
        official, events = official_candidates(g), event_candidates(g)
        stats["games"] += 1
        stats["event_games"] += 1 if events else 0
        stats["candidates"] += len(official) + len(events)
        col.add(official)
        col.add(events)
~~~
<!-- new -->
~~~python
        official, events, moments = official_candidates(g), event_candidates(g), moment_candidates(g)
        stats["games"] += 1
        stats["event_games"] += 1 if events else 0
        stats["candidates"] += len(official) + len(events) + len(moments)
        col.add(official)
        col.add(events)
        col.add(moments)
~~~

- [ ] **Step 4: 통과 확인**

Run:

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_hook.py
```

Expected: 새 테스트 7개와 기존 24개 + 훅 6개 모두 통과, `실패 없음.`

- [ ] **Step 5: 커밋**

```bash
git add tools/record_book.py tools/test_record_book_moments.py
git commit -m "$(cat <<'EOF'
feat(records): official-box boards for phase 2 (win margin, bench points, no-point rebounds/assists, triple/quadruple-double and 5x5 clubs)

Extracts the quarter-score gate into quarters_match_official so the event-based phase 2 boards
can share it, carries the official starter flag, and adds seven boards that need no event gate.
Club rows all have value 1, so the rank <= 15 rule keeps every achievement (counts come for free).

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 파이썬 — 최단 시간 더블더블·트리플더블·5반칙 퇴장

**Files:**
- Modify: `tools/record_book.py`, `tools/test_record_book_moments.py`

**Interfaces:**
- Consumes: Task 1의 `quarters_match_official`, `event_time`, `ordered_events`, `played_seconds`, `player_index`, `_row`
- Produces: `player_timelines(g)`, `minutes_match_official(g, acc)`, `time_candidates(g)`; 보드 `pg.dd_time.min`, `pg.td_time.min`, `pg.foul5_time.min`(값 = 코트 출전 초, 방향 min).

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- edit: tools/test_record_book_moments.py -->
<!-- old -->
~~~python
if __name__ == "__main__":
    failed = 0
~~~
<!-- new -->
~~~python
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


if __name__ == "__main__":
    failed = 0
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py`

Expected: 새 시간 테스트 5개가 FAIL(`moment_candidates`가 시간 행을 안 만든다).

- [ ] **Step 3: 구현**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
def moment_candidates(g):
    """2단계 보드 전부 - 공식 보드는 늘, 이벤트 보드는 게이트 1을 통과한 경기만."""
    return official_moment_candidates(g)
~~~
<!-- new -->
~~~python
def player_timelines(g):
    """선수((이름, tcode)) -> [(경기 시작 후 초, 그때까지 코트 출전 초, 코드, 쿼터)] 와 코트 출전 초 합계. 101(투입)~102(퇴장)을 합산한다."""
    on, acc = {}, collections.defaultdict(int)
    line = collections.defaultdict(list)
    for e in ordered_events(g):
        q, name, tc, a = e.get("q"), e.get("p"), e.get("t"), e.get("a")
        t = event_time(e)
        if not (q and name and tc and a) or t is None:
            continue
        k = (name, tc)
        if a == SUB_IN:
            on[k] = t
        elif a == SUB_OUT:
            if k in on:
                acc[k] += max(0, t - on.pop(k))
        else:
            line[k].append((t, acc[k] + (t - on[k] if k in on else 0), a, q))
    return line, acc


def minutes_match_official(g, acc):
    """재구성한 코트 출전 초가 모든 선수에서 공식 출전 시간과 ±MINUTES_TOLERANCE 안이다(동명이인은 시간이 섞이므로 비교에서 뺀다)."""
    idx = player_index(g)
    for p in g["players"]:
        k = (p["pname"], p["tcode"])
        if idx.get(k) is None:
            continue
        if abs(played_seconds(p["rec"]) - acc.get(k, 0)) > MINUTES_TOLERANCE:
            return False
    return True


def _count(tot, a):
    """코드 a 한 건을 누적(득점·리바·어시·스틸·블록·개인 파울)."""
    if a in PTS_BY_CODE:
        tot["pts"] += PTS_BY_CODE[a]
    elif a in FOUL_CODES:
        tot["foul"] += 1
    else:
        for c, codes in CAT_CODES.items():
            if a in codes:
                tot[c] += 1


def _new_tally():
    tot = dict.fromkeys(CAT_ORDER, 0)
    tot["foul"] = 0
    return tot


def time_candidates(g):
    """최단 시간 더블더블·트리플더블·5반칙 퇴장(코트 출전 초). 게이트 1은 호출자가 확인한다(설계 §4-2)."""
    line, acc = player_timelines(g)
    if not minutes_match_official(g, acc):
        return []
    idx = player_index(g)
    by_pcode = {p["pcode"]: p for p in g["players"]}
    rows = []
    for k, evs in line.items():
        pcode = idx.get(k)
        if not pcode:
            continue
        p = by_pcode[pcode]
        tot = _new_tally()
        for _, _, a, _ in evs:
            _count(tot, a)
        if any(tot[c] != p["rec"].get(CAT_OFFICIAL[c]) for c in CAT_ORDER):
            continue                                    # 이 선수의 이벤트 합계가 공식과 다르면 제외
        foul_ok = tot["foul"] == p["rec"].get("foul")
        run, got = _new_tally(), {}
        for _, cur, a, _ in evs:
            _count(run, a)
            if cur <= 0:
                continue
            n10 = sum(1 for c in CAT_ORDER if run[c] >= 10)
            if n10 >= 2:
                got.setdefault("dd", cur)
            if n10 >= 3:
                got.setdefault("td", cur)
            if run["foul"] >= 5 and foul_ok:
                got.setdefault("foul5", cur)
        for kind, board in (("dd", "pg.dd_time.min"), ("td", "pg.td_time.min"), ("foul5", "pg.foul5_time.min")):
            if kind in got:
                rows.append(_row(g, board, "G", pcode, "", got[kind], p["pname"], p["tcode"]))
    return rows


def moment_candidates(g):
    """2단계 보드 전부 - 공식 보드는 늘, 이벤트 보드는 게이트 1을 통과한 경기만."""
    rows = official_moment_candidates(g)
    if quarters_match_official(g):
        rows += time_candidates(g)
    return rows
~~~

- [ ] **Step 4: 통과 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py && PYTHONIOENCODING=utf-8 "$PY" test_record_book.py`

Expected: 모두 통과(`실패 없음.`).

- [ ] **Step 5: 커밋**

```bash
git add tools/record_book.py tools/test_record_book_moments.py
git commit -m "$(cat <<'EOF'
feat(records): fastest double-double / triple-double / five-foul boards from on-court seconds

On-court time is rebuilt from the 101/102 substitution events and must match every player's
official minutes (+-3 s) before any row is made; a player's event totals must equal the official
box, and the foul board additionally needs the event foul count (215+216) to equal the official one.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 파이썬 — N초 득점 · 팀 연속 득점 런 · 실데이터 단언

**Files:**
- Modify: `tools/record_book.py`, `tools/test_record_book_moments.py`

**Interfaces:**
- Produces: `burst_candidates(g)`, `run_candidates(g)`; 보드 `pg.burst10.max`, `pg.burst35.max`, `pg.burst60.max`(선수), `tg.run.max`(팀). 두 함수 모두 S31 이후 경기에서만 행을 만든다.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- edit: tools/test_record_book_moments.py -->
<!-- old -->
~~~python
if __name__ == "__main__":
    failed = 0
~~~
<!-- new -->
~~~python
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
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py`

Expected: 새 창·런 테스트 5개 FAIL.

- [ ] **Step 3: 구현**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
def moment_candidates(g):
    """2단계 보드 전부 - 공식 보드는 늘, 이벤트 보드는 게이트 1을 통과한 경기만."""
    rows = official_moment_candidates(g)
    if quarters_match_official(g):
        rows += time_candidates(g)
    return rows
~~~
<!-- new -->
~~~python
def burst_candidates(g):
    """같은 쿼터 안 W초 창에서 선수가 낸 최다 득점(10·35·60초). S31 이후 경기만, 그 선수의 득점 합계가 공식과 같고
    그 선수의 득점 이벤트가 모든 쿼터에서 시계 순서(비감소)일 때만 - 어긋나면 그 선수는 통째로 제외한다."""
    if season_number(g["gmkey"]) < CLOCK_TRUSTED_FROM:
        return []
    idx = player_index(g)
    by_pcode = {p["pcode"]: p for p in g["players"]}
    scores = collections.defaultdict(list)                        # (이름, tcode) -> [(쿼터, 초, 점수)]
    for e in ordered_events(g):
        a, q, tc, name = e.get("a"), e.get("q"), e.get("t"), e.get("p")
        t = event_time(e)
        if a in PTS_BY_CODE and q and tc and name:
            scores[(name, tc)].append((q, t, PTS_BY_CODE[a]))
    rows = []
    for k, evs in scores.items():
        pcode = idx.get(k)
        if not pcode or any(t is None for _, t, _ in evs):
            continue
        p = by_pcode[pcode]
        if sum(pts for _, _, pts in evs) != p["rec"].get("score"):
            continue
        by_period = collections.defaultdict(list)
        for q, t, pts in evs:
            by_period[q].append((t, pts))
        if any(ps[i + 1][0] < ps[i][0] for ps in by_period.values() for i in range(len(ps) - 1)):
            continue
        best = dict.fromkeys(BURST_WINDOWS, 0)
        for ps in by_period.values():
            for w in BURST_WINDOWS:
                lo, s = 0, 0
                for hi in range(len(ps)):
                    s += ps[hi][1]
                    while ps[hi][0] - ps[lo][0] > w:
                        s -= ps[lo][1]
                        lo += 1
                    best[w] = max(best[w], s)
        for w in BURST_WINDOWS:
            if best[w] > 0:
                rows.append(_row(g, f"pg.burst{w}.max", "G", pcode, "", best[w], p["pname"], p["tcode"]))
    return rows


def run_candidates(g):
    """팀 연속 득점(상대 무득점) 최대 길이 - 쿼터를 넘겨도 이어진다. S31 이후 경기만, 두 팀 득점 이벤트가 쿼터마다 시계 순서일 때만."""
    if season_number(g["gmkey"]) < CLOCK_TRUSTED_FROM:
        return []
    seq, last_t = [], {}
    for e in ordered_events(g):
        a, q, tc, name = e.get("a"), e.get("q"), e.get("t"), e.get("p")
        if a not in PTS_BY_CODE or not (q and tc and name):
            continue
        t = event_time(e)
        if t is None or t < last_t.get(q, 0):
            return []
        last_t[q] = t
        seq.append((tc, PTS_BY_CODE[a]))
    best, cur_t, cur = {}, None, 0
    for tc, pts in seq:
        cur = cur + pts if tc == cur_t else pts
        cur_t = tc
        best[tc] = max(best.get(tc, 0), cur)
    return [_row(g, "tg.run.max", "G", tc, "", v, g["names"][tc], tc) for tc, v in best.items() if tc in g["names"] and v > 0]


def moment_candidates(g):
    """2단계 보드 전부 - 공식 보드는 늘, 이벤트 보드는 게이트 1을 통과한 경기만."""
    rows = official_moment_candidates(g)
    if quarters_match_official(g):
        rows += time_candidates(g) + burst_candidates(g) + run_candidates(g)
    return rows
~~~

- [ ] **Step 4: 통과 확인(합성 + 실데이터)**

Run:

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_hook.py
RECORD_BOOK_SLOW=1 PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild --dry-run
```

Expected: 합성 테스트 전부 통과, 슬로우 실데이터 단언 통과(걸리면 §2 조사 값과 어긋난 보드를 확인 - 실제 값이 맞으면 단언을 실제 값으로 고치고 이유를 주석으로 남긴다). `--rebuild --dry-run`은 `경기 5685개 ... 보관 행 N개 / 보드·구간 M개`를 찍고(1단계 2,773행·80 → 약 3,200행·94 근처), 90초 안에 끝난다.

- [ ] **Step 5: 커밋**

```bash
git add tools/record_book.py tools/test_record_book_moments.py
git commit -m "$(cat <<'EOF'
feat(records): N-second scoring bursts and team unanswered-point runs (2017-18 onward only)

Second-resolution boards need trustworthy clocks: older seasons stamp several scores at the same
second (a 2007 '14 points in 10 s'). Players whose own scoring events run backwards in a quarter,
and games whose scoring events do, are skipped entirely - a missed record is acceptable, a wrong one is not.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 웹 — `records.ts` 일반화(문구 도우미 export, 타입 확장, 클럽 토스트)

**Files:**
- Modify: `courtside-web/lib/records.ts`, `courtside-web/lib/records.test.ts`

**Interfaces:**
- Produces: `export type ValueFmt = (v: number) => string`, `verdictText(info, fmt, who?, scope?)`, `holdersLine(s, info, fmt)`, `clockOf(e)`; `RecordEvent`에 선택 필드 `home_score`, `away_score`; `RecordTimelineOptions`에 선택 필드 `home`, `away`; `RecordMoment`에 선택 필드 `club?: string`; `recordToast`는 `club`이 있으면 `🏅 {club} 달성!`.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- edit: courtside-web/lib/records.test.ts -->
<!-- old -->
~~~typescript
  recordLine,
  recordToast,
  type BoardSummary,
~~~
<!-- new -->
~~~typescript
  holdersLine,
  recordLine,
  recordToast,
  verdictText,
  type BoardSummary,
~~~

<!-- edit: courtside-web/lib/records.test.ts -->
<!-- old -->
~~~typescript
describe("recordToast", () => {
~~~
<!-- new -->
~~~typescript
describe("verdictText / holdersLine - 단위를 바꿔 쓸 수 있는 문구 도우미", () => {
  const info = (o: Partial<ReturnType<typeof rankInfo> & object>) => ({ rank: 1, tie: false, breaks: false, best: 8, n1: 1, ...o });
  const sec = (v: number) => `${Math.floor(v / 60)}분 ${v % 60}초`;
  it("기본(KBL 역대)은 1단계 문구와 같고, 범위·주체를 바꿀 수 있다", () => {
    const pts = (v: number) => `${v}점`;
    expect(verdictText(info({ breaks: true, best: 41 }), pts)).toBe("KBL 신기록(종전 41점)");
    expect(verdictText(info({ tie: true }), pts)).toBe("KBL 타이 기록(공동 1위)");
    expect(verdictText(info({ rank: 6, tie: true }), pts)).toBe("KBL 역대 공동 6위");
    expect(verdictText(info({ rank: 6, tie: true }), pts, "KBL", "2017-18 이후")).toBe("KBL 2017-18 이후 공동 6위");
    expect(verdictText(info({ breaks: true, best: 600 }), sec, "불명예")).toBe("불명예 신기록(종전 10분 0초)");
    expect(verdictText(info({ tie: true }), pts, "KBL", "2017-18 이후")).toBe("KBL 2017-18 이후 타이 기록(공동 1위)");
  });
  it("보유자 줄: 1위·신기록이면 '보유', 그 밖이면 '역대 1위 값: 이름'", () => {
    const s: BoardSummary = { tops: [465, 480], holders: [{ v: 465, who: "알리제 드숀 존슨", d: "2024-03-02" }] };
    expect(holdersLine(s, info({ rank: 3, best: 465 }), sec)).toBe("역대 1위 7분 45초: 알리제 드숀 존슨");
    expect(holdersLine(s, info({ breaks: true, best: 465 }), sec)).toBe("알리제 드숀 존슨 보유");
    expect(holdersLine({ tops: [], holders: [] }, info({}), sec)).toBe("");
  });
});

describe("recordToast - 클럽", () => {
  it("클럽 알림은 순위 문구 없이 '🏅 트리플더블 달성!'", () => {
    const m = { board: "pg.club_td.max", club: "트리플더블", provisional: true, name: "마레이", text: "트리플더블 달성 — KBL 역대 79번째", rank: 1, breaks: false } as never;
    expect(recordToast(m)).toEqual({ icon: "🏅", title: "트리플더블 달성!", msg: "(잠정) 마레이 트리플더블 달성 — KBL 역대 79번째" });
  });
});

describe("recordToast", () => {
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/records.test.ts`

Expected: FAIL — `holdersLine`/`verdictText`가 export되지 않았다.

- [ ] **Step 3: `records.ts` 편집**

<!-- edit: courtside-web/lib/records.ts -->
<!-- old -->
~~~typescript
export type RecordEvent = {
  pcode: string | null;
  tcode: string | null;
  action_code: string | null;
  quarter: string;
  clock_min?: number | null;
  clock_sec?: number | null;
};
~~~
<!-- new -->
~~~typescript
export type RecordEvent = {
  pcode: string | null;
  tcode: string | null;
  action_code: string | null;
  quarter: string;
  clock_min?: number | null;
  clock_sec?: number | null;
  /** 이 이벤트까지의 점수(있으면 2단계 점수차 보드가 쓴다). */
  home_score?: number | null;
  away_score?: number | null;
};
~~~

<!-- edit: courtside-web/lib/records.ts -->
<!-- old -->
~~~typescript
  provisional: boolean;
  /** 정렬용 - 낮을수록 중요(신기록 0, 아니면 순위). */
  sig: number;
};
~~~
<!-- new -->
~~~typescript
  provisional: boolean;
  /** 정렬용 - 낮을수록 중요(신기록 0, 아니면 순위). */
  sig: number;
  /** 클럽(트리플더블·쿼드러플더블·5x5) 알림이면 클럽 이름 - 순위가 없어 토스트 제목이 다르다. */
  club?: string;
};
~~~

<!-- edit: courtside-web/lib/records.ts -->
<!-- old -->
~~~typescript
function clockOf(e: RecordEvent): string {
~~~
<!-- new -->
~~~typescript
export function clockOf(e: RecordEvent): string {
~~~

<!-- edit: courtside-web/lib/records.ts -->
<!-- old -->
~~~typescript
function verdict(info: RankInfo, m: RecordMetric): string {
  const unit = METRIC_TEXT[m].unit;
  if (info.breaks) return `${who(m)} 신기록(종전 ${info.best}${unit})`;
  if (info.rank === 1) return `${who(m)} 타이 기록(공동 1위)`;
  return `${who(m)} 역대 ${info.tie ? "공동 " : ""}${info.rank}위`;
}
~~~
<!-- new -->
~~~typescript
/** 값 한 개를 문구로(단위 포함) - 점수·개수·초 등 보드마다 다르다. */
export type ValueFmt = (v: number) => string;

/**
 * 판정 문구. 기본은 1단계 그대로("KBL 신기록(종전 41점)" / "KBL 타이 기록(공동 1위)" / "KBL 역대 공동 6위").
 * scope를 주면 "역대" 자리에 들어간다("KBL 2017-18 이후 공동 6위", 신기록·타이도 "KBL 2017-18 이후 신기록(종전 …)").
 */
export function verdictText(info: RankInfo, fmt: ValueFmt, who = "KBL", scope = "역대"): string {
  const head = scope === "역대" ? who : `${who} ${scope}`;
  if (info.breaks) return `${head} 신기록(종전 ${fmt(info.best)})`;
  if (info.rank === 1) return `${head} 타이 기록(공동 1위)`;
  return `${head} ${scope === "역대" ? "역대 " : ""}${info.tie ? "공동 " : ""}${info.rank}위`;
}
const verdict = (info: RankInfo, m: RecordMetric) => verdictText(info, (v) => `${v}${METRIC_TEXT[m].unit}`, who(m));
~~~

<!-- edit: courtside-web/lib/records.ts -->
<!-- old -->
~~~typescript
function holdersText(s: BoardSummary, info: RankInfo, m: RecordMetric): string {
  const unit = METRIC_TEXT[m].unit;
  const names = [...new Set(s.holders.filter((h) => h.v === info.best).map((h) => h.who))];
  if (names.length === 0) return "";
  const shown = names.slice(0, 3).join("·");
  const more = info.n1 > 3 ? ` 외 ${info.n1 - 3}건` : "";
  // 신기록·타이면 본문이 이미 "(종전 N개)"·"(공동 1위)"로 값을 말하므로 값을 되풀이하지 않고 보유자만 적는다.
  return info.breaks || info.rank === 1 ? `${shown}${more} 보유` : `역대 1위 ${info.best}${unit}: ${shown}${more}`;
}
~~~
<!-- new -->
~~~typescript
/** 보유자 줄 - 신기록·타이면 본문이 이미 "(종전 N개)"·"(공동 1위)"로 값을 말하므로 값을 되풀이하지 않고 보유자만 적는다. */
export function holdersLine(s: BoardSummary, info: RankInfo, fmt: ValueFmt): string {
  const names = [...new Set(s.holders.filter((h) => h.v === info.best).map((h) => h.who))];
  if (names.length === 0) return "";
  const shown = names.slice(0, 3).join("·");
  const more = info.n1 > 3 ? ` 외 ${info.n1 - 3}건` : "";
  return info.breaks || info.rank === 1 ? `${shown}${more} 보유` : `역대 1위 ${fmt(info.best)}: ${shown}${more}`;
}
const holdersText = (s: BoardSummary, info: RankInfo, m: RecordMetric) => holdersLine(s, info, (v) => `${v}${METRIC_TEXT[m].unit}`);
~~~

<!-- edit: courtside-web/lib/records.ts -->
<!-- old -->
~~~typescript
export type RecordTimelineOptions = { names: RecordNames; /** 종료된 경기면 true - 마지막 쿼터·경기 끝 판정(최소 보드)까지 한다. */ final: boolean };
~~~
<!-- new -->
~~~typescript
export type RecordTimelineOptions = {
  names: RecordNames;
  /** 종료된 경기면 true - 마지막 쿼터·경기 끝 판정(최소 보드)까지 한다. */
  final: boolean;
  /** 2단계 점수차 보드용 - 홈/원정 tcode(이벤트의 home_score/away_score와 짝). 없으면 점수차는 건너뛴다. */
  home?: string;
  away?: string;
};
~~~

<!-- edit: courtside-web/lib/records.ts -->
<!-- old -->
~~~typescript
export function recordToast(m: RecordMoment): { icon: string; title: string; msg: string } {
~~~
<!-- new -->
~~~typescript
export function recordToast(m: RecordMoment): { icon: string; title: string; msg: string } {
  if (m.club) return { icon: "🏅", title: `${m.club} 달성!`, msg: `${m.provisional ? "(잠정) " : ""}${m.name} ${m.text}` };
~~~

- [ ] **Step 4: 통과 확인**

Run: `cd courtside-web && npx vitest run lib/records.test.ts lib/records.replay.test.ts lib/records.parity.test.ts lib/postgameReport.test.ts && npx tsc --noEmit`

Expected: 전부 통과(기존 출력 문구는 그대로), `tsc` 출력 없음.

- [ ] **Step 5: 커밋**

```bash
git add courtside-web/lib/records.ts courtside-web/lib/records.test.ts
git commit -m "$(cat <<'EOF'
refactor(web): record wording helpers take a value formatter (seconds, scores, runs) and clubs get their own toast

verdictText/holdersLine are the old verdict/holdersText with the unit passed in, so the phase 2
boards (mm:ss times, 'N-0' runs) reuse one set of sentences. RecordEvent may carry the running
score, RecordMoment may name a club, and the timeline options may name the home/away teams.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 웹 — 순간 기록 엔진 `lib/recordsMoments.ts`

**Files:**
- Create: `courtside-web/lib/recordsMoments.ts`, `courtside-web/lib/recordsMoments.test.ts`

**Interfaces:**
- Consumes: Task 4의 `verdictText`, `holdersLine`, `clockOf`, `RecordTimelineOptions.home/away`, `RecordMoment.club`; 1단계 `rankInfo`, `nextTarget`, `TOP_RANKS`, `validatedKey`, `buildRecordTimeline`
- Produces: `buildMomentTimeline(ctx, events, opts, finals?) -> RecordMoment[]`(`finals`는 파이썬 대조용 `${board}|G|${subject}|` -> 값 맵), `buildAllRecordMoments(ctx, events, opts) -> RecordMoment[]`(1단계 + 2단계, 종료 경기는 `ctx.validated` 거름), `BURST_WINDOWS`.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- create: courtside-web/lib/recordsMoments.test.ts -->
~~~typescript
import { describe, expect, it } from "vitest";
import { buildAllRecordMoments, buildMomentTimeline } from "./recordsMoments";
import { recordToast, type BoardSummary, type RecordContext, type RecordEvent } from "./records";

const names = { player: (p: string) => `선수${p}`, team: (t: string) => `팀${t}` };
const WHO = ["문태종", "박지현", "허훈", "이정현", "마레이", "박지훈"];
const OPTS = { names, final: false, home: "H", away: "A" };

function board(tops: number[]): BoardSummary {
  const holders: BoardSummary["holders"] = [];
  let rank = 0;
  let last: number | null = null;
  tops.forEach((v, i) => {
    if (v !== last) {
      rank = i + 1;
      last = v;
    }
    if (rank <= 3 && holders.length < 6) holders.push({ v, who: WHO[i % WHO.length], d: "2020-02-09" });
  });
  return { tops, holders };
}
const ctxOf = (boards: Record<string, number[]>, validated?: string[]): RecordContext => ({
  asOf: "2026-10-09",
  boards: Object.fromEntries(Object.entries(boards).map(([k, t]) => [k, board(t)])),
  ...(validated ? { validated } : {}),
});

const ev = (pcode: string | null, tcode: string | null, code: string, quarter: string, min: number, sec: number, extra: Partial<RecordEvent> = {}): RecordEvent => ({
  pcode, tcode, action_code: code, quarter, clock_min: min, clock_sec: sec, ...extra,
});
/** 그 선수가 Q1 10:00에 투입돼 Q1 끝까지 뛰는 경기: 득점 5회(60~100초) -> 리바운드 10개(125~170초) -> 어시스트 n개(185~) -> 파울 f개(250~). */
function guard(opts: { ast?: number; fouls?: number } = {}): RecordEvent[] {
  const out = [ev("g1", "H", "101", "Q1", 10, 0)];
  for (const [m, s] of [[9, 0], [8, 50], [8, 40], [8, 30], [8, 20]]) out.push(ev("g1", "H", "201", "Q1", m, s));
  for (let i = 0; i < 10; i++) out.push(ev("g1", "H", "210", "Q1", 7, 55 - 5 * i));
  for (let i = 0; i < (opts.ast ?? 0); i++) out.push(ev("g1", "H", "211", "Q1", 6, 55 - 5 * i));
  for (let i = 0; i < (opts.fouls ?? 0); i++) out.push(ev("g1", "H", i % 2 ? "216" : "215", "Q1", 5, 50 - 10 * i));
  out.push(ev("g1", "H", "102", "Q1", 0, 0));
  return out;
}
const dones = (ms: ReturnType<typeof buildMomentTimeline>, board?: string) => ms.filter((m) => m.phase === "done" && (!board || m.board === board));

describe("최단 시간 더블더블 / 트리플더블 / 5반칙 퇴장(코트 출전 시간)", () => {
  const boards = {
    "pg.dd_time.min|G": [465, 500, 560, 600, 700, 800, 900, 1000, 1100, 1200],
    "pg.td_time.min|G": [1168, 1225, 1310, 1400, 1500, 1600, 1700, 1800, 1900, 2000],
    "pg.foul5_time.min|G": [600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500],
  };
  it("10번째 리바운드(출전 170초)로 더블더블 신기록, 10번째 어시스트(230초)로 트리플더블 신기록, 5번째 파울(290초)로 불명예 신기록", () => {
    const m = dones(buildMomentTimeline(ctxOf(boards), guard({ ast: 10, fouls: 5 }), OPTS));
    const byBoard = Object.fromEntries(m.map((x) => [x.board, x]));
    expect(byBoard["pg.dd_time.min"]).toMatchObject({ value: 170, rank: 1, breaks: true, subject: "g1", name: "선수g1", bucket: "G", period: "", provisional: true });
    expect(byBoard["pg.dd_time.min"].text).toBe("출전 2분 50초 만에 더블더블 KBL 신기록(종전 7분 45초)");
    expect(byBoard["pg.dd_time.min"].detail).toBe("문태종 보유");
    expect(byBoard["pg.td_time.min"].text).toBe("출전 3분 50초 만에 트리플더블 KBL 신기록(종전 19분 28초)");
    expect(byBoard["pg.foul5_time.min"].text).toBe("출전 4분 50초 만에 5반칙 퇴장 불명예 신기록(종전 10분 0초)");
    expect(m.every((x) => x.idx >= 0)).toBe(true);
  });
  it("TOP10 밖이거나 보드가 없으면 만들지 않고, 4반칙은 퇴장이 아니다", () => {
    const slow = { "pg.dd_time.min|G": [100, 110, 120, 130, 140, 150, 160, 165, 166, 168] };      // 170초는 11위
    expect(dones(buildMomentTimeline(ctxOf(slow), guard(), OPTS))).toEqual([]);
    expect(dones(buildMomentTimeline(ctxOf({}), guard({ ast: 10, fouls: 5 }), OPTS)).filter((x) => x.board.endsWith("_time.min"))).toEqual([]);   // 클럽은 보드가 없어도(역대 1번째) 알린다
    expect(dones(buildMomentTimeline(ctxOf(boards), guard({ fouls: 4 }), OPTS), "pg.foul5_time.min")).toEqual([]);
  });
  it("코트에 있었다는 기록(101)이 없으면 시간을 모르므로 알리지 않는다", () => {
    const noSub = guard().filter((e) => e.action_code !== "101" && e.action_code !== "102");
    expect(dones(buildMomentTimeline(ctxOf(boards), noSub, OPTS), "pg.dd_time.min")).toEqual([]);
  });
});

describe("클럽 - 트리플더블 / 쿼드러플더블 / 5x5", () => {
  it("트리플더블: 그 경기 이전 달성 수 + 1번째, 같은 경기에서 둘이 달성하면 다음 번호", () => {
    const tops = Array<number>(77).fill(1);
    const second = guard({ ast: 10 }).map((e) => ({ ...e, pcode: e.pcode === "g1" ? "g2" : e.pcode }));
    const m = dones(buildMomentTimeline(ctxOf({ "pg.club_td.max|G": tops }), [...guard({ ast: 10 }), ...second], OPTS), "pg.club_td.max");
    expect(m.map((x) => [x.subject, x.text])).toEqual([["g1", "트리플더블 달성 — KBL 역대 78번째"], ["g2", "트리플더블 달성 — KBL 역대 79번째"]]);
    expect(m[0]).toMatchObject({ club: "트리플더블", rank: 1, breaks: false, tie: false, detail: "" });
    expect(recordToast(m[0])).toEqual({ icon: "🏅", title: "트리플더블 달성!", msg: "(잠정) 선수g1 트리플더블 달성 — KBL 역대 78번째" });
  });
  it("보드가 없으면 역대 1번째, 앞선 달성자가 3명 이하면 설명에 이름·날짜", () => {
    const five = (code: string, n: number) => Array.from({ length: n }, (_, i) => ev("x1", "A", code, "Q2", 9, 55 - i));
    const x5 = [...five("201", 3), ...five("210", 5), ...five("211", 5), ...five("212", 5), ...five("213", 5)];
    const first = dones(buildMomentTimeline(ctxOf({}), x5, OPTS), "pg.club_x5.max");
    expect(first.map((x) => x.text)).toEqual(["5x5 달성 — KBL 역대 1번째"]);
    const withPrior = dones(buildMomentTimeline(ctxOf({ "pg.club_x5.max|G": [1] }), x5, OPTS), "pg.club_x5.max");
    expect(withPrior[0].text).toBe("5x5 달성 — KBL 역대 2번째");
    expect(withPrior[0].detail).toBe("앞선 기록: 문태종(2020-02-09)");
  });
  it("트리플더블 임박: 두 부문 10 이상이고 나머지 중 가장 높은 것이 8 이상이면 패널용 near", () => {
    const m = buildMomentTimeline(ctxOf({}), guard({ ast: 8 }), OPTS).filter((x) => x.phase === "near" && x.board === "pg.club_td.max");
    expect(m.length).toBeGreaterThan(0);
    expect(m[m.length - 1]).toMatchObject({ remaining: 2, text: "어시스트 8개 · 2개 더하면 트리플더블" });
  });
});

describe("벤치 득점 · 점수차 · 무득점", () => {
  const starters = ["s1", "s2", "s3", "s4", "s5"].map((p) => ev(p, "H", "101", "Q1", 10, 0));
  it("선발 5명이 아닌 선수의 득점이 TOP10이면 알린다(선발은 같은 득점이어도 아님)", () => {
    const bench = Array.from({ length: 14 }, (_, i) => ev("b1", "H", "205", "Q2", 9, 50 - i)); // 3점슛 14개 = 42점
    const starter = Array.from({ length: 14 }, (_, i) => ev("s1", "H", "205", "Q2", 8, 50 - i));
    const tops = [47, 47, 43, 43, 43, 42, 42, 41, 41, 41];
    const m = dones(buildMomentTimeline(ctxOf({ "pg.benchpts.max|G": tops }), [...starters, ...bench, ...starter], OPTS), "pg.benchpts.max");
    expect(m.map((x) => [x.subject, x.value, x.text])).toEqual([["b1", 42, "벤치 득점 42점 KBL 역대 공동 6위"]]);
  });
  it("점수차: 라이브는 갱신될 때마다, 종료 경기는 마지막 값 하나만(중간에 더 컸어도)", () => {
    const tops = [56, 54, 45, 45, 43, 43, 43, 42, 41, 41];
    const scores = [[40, 0], [41, 0], [43, 0], [44, 8]];
    const events = scores.map(([h, a]) => ev(null, null, "x", "Q4", 5, 0, { home_score: h, away_score: a }));
    const live = dones(buildMomentTimeline(ctxOf({ "tg.margin.max|G": tops }), events, OPTS), "tg.margin.max");
    expect(live.map((x) => [x.value, x.text])).toEqual([[41, "점수차 41점 KBL 역대 공동 9위"], [43, "점수차 43점 KBL 역대 공동 5위"]]);
    expect(live[0]).toMatchObject({ subject: "H", name: "팀H", scope: "t", tcode: "H", bucket: "G", period: "" });
    const fin = dones(buildMomentTimeline(ctxOf({ "tg.margin.max|G": tops }), events, { ...OPTS, final: true }), "tg.margin.max");
    expect(fin).toEqual([]);                                                                   // 마지막 점수차는 36 - TOP10 밖
  });
  it("무득점 리바/어시: 종료 경기에서만(득점이 나중에 생길 수 있다)", () => {
    const rebs = Array.from({ length: 13 }, (_, i) => ev("z1", "H", "210", "Q1", 9, 50 - i));
    const ctx = ctxOf({ "pg.nopts_reb.max|G": [22, 17, 13, 12, 12, 11, 10, 9, 8, 7] });
    expect(dones(buildMomentTimeline(ctx, rebs, OPTS), "pg.nopts_reb.max")).toEqual([]);
    const fin = dones(buildMomentTimeline(ctx, rebs, { ...OPTS, final: true }), "pg.nopts_reb.max");
    expect(fin.map((x) => x.text)).toEqual(["무득점 리바운드 13개 KBL 역대 공동 3위"]);
    const scored = [...rebs, ev("z1", "H", "201", "Q1", 1, 0)];
    expect(dones(buildMomentTimeline(ctx, scored, { ...OPTS, final: true }), "pg.nopts_reb.max")).toEqual([]);
  });
});

describe("N초 득점 · 팀 연속 득점 런", () => {
  it("35초 창 8점: 6점은 TOP10 밖이고 8점은 타이 기록, 10초 보드가 없으면 그 창은 없다", () => {
    const events = [ev("g1", "H", "205", "Q2", 5, 0), ev("g1", "H", "205", "Q2", 4, 50), ev("g1", "H", "201", "Q2", 4, 40)];
    const ctx = ctxOf({ "pg.burst35.max|G": [8, 8, 8, 8, 8, 8, 7, 7, 7, 7] });
    const m = dones(buildMomentTimeline(ctx, events, OPTS));
    expect(m.map((x) => [x.board, x.value, x.text])).toEqual([["pg.burst35.max", 8, "35초 동안 8득점 KBL 2017-18 이후 타이 기록(공동 1위)"]]);
  });
  it("시계가 거꾸로 간 선수의 창은 알리지 않는다", () => {
    const events = [ev("g1", "H", "205", "Q2", 5, 0), ev("g1", "H", "205", "Q2", 5, 5), ev("g1", "H", "201", "Q2", 4, 40), ev("g1", "H", "201", "Q2", 4, 30)];
    const ctx = ctxOf({ "pg.burst35.max|G": [8, 8, 8, 8, 8, 8, 7, 7, 7, 7] });
    expect(dones(buildMomentTimeline(ctx, events, OPTS))).toEqual([]);
  });
  it("팀 런: 상대가 득점하면 끊기고, 20-0 / 22-0 / 24-0이 차례로 알림", () => {
    const events = Array.from({ length: 12 }, (_, i) => ev(`p${i % 3}`, "H", "201", "Q3", 9, 59 - i * 2));
    const tops = [24, 24, 23, 23, 22, 22, 21, 21, 20, 20];
    const m = dones(buildMomentTimeline(ctxOf({ "tg.run.max|G": tops }), events, OPTS), "tg.run.max");
    expect(m.map((x) => [x.value, x.rank, x.text])).toEqual([
      [20, 9, "20-0 런 KBL 2017-18 이후 공동 9위"],
      [22, 5, "22-0 런 KBL 2017-18 이후 공동 5위"],
      [24, 1, "24-0 런 KBL 2017-18 이후 타이 기록(공동 1위)"],
    ]);
    const broken = [...events.slice(0, 6), ev("a1", "A", "201", "Q3", 9, 40), ...events.slice(6)];
    expect(dones(buildMomentTimeline(ctxOf({ "tg.run.max|G": tops }), broken, OPTS), "tg.run.max")).toEqual([]);   // 12-0과 12-0으로 끊김
  });
  it("임박: 팀 런이 다음 기록 선 4점 안이면 near, 상대 득점으로 끊기면 닫힌다", () => {
    const events = [...Array.from({ length: 10 }, (_, i) => ev("p1", "H", "201", "Q3", 9, 59 - i * 2)), ev("a1", "A", "201", "Q3", 9, 30)];
    const m = buildMomentTimeline(ctxOf({ "tg.run.max|G": [24, 24, 23, 23, 22, 22, 21, 21, 20, 20] }), events, OPTS).filter((x) => x.phase === "near" && x.board === "tg.run.max");
    expect(m.length).toBeGreaterThan(0);
    const last = m[m.length - 1];
    expect(last.until).toBe(10);                                                               // 10번째(idx 10) 상대 득점에서 닫힘
  });
});

describe("검증·합치기·finals", () => {
  it("종료 경기(validated)는 테이블에 있는 항목만, 1단계 순간과 시간순으로 합쳐진다", () => {
    const boards = { "pg.club_td.max|G": Array<number>(77).fill(1), "pq.ast.max|Q1": [8, 8, 8, 8, 8, 8, 7, 7, 7, 7], "pq.ast.max|ALL": [8, 8, 8, 8, 8, 8, 7, 7, 7, 7] };
    const events = guard({ ast: 10 });
    const live = buildAllRecordMoments(ctxOf(boards), events, OPTS);
    expect(live.some((x) => x.board === "pq.ast.max") && live.some((x) => x.board === "pg.club_td.max")).toBe(true);
    expect(live.map((x) => x.idx)).toEqual([...live.map((x) => x.idx)].sort((a, b) => a - b));
    const fin = buildAllRecordMoments(ctxOf(boards, ["pg.club_td.max|G|g1|"]), events, { ...OPTS, final: true }).filter((x) => x.phase === "done");
    expect(fin.map((x) => x.board)).toEqual(["pg.club_td.max"]);
    expect(fin[0].provisional).toBe(false);
    expect(buildAllRecordMoments(ctxOf(boards, []), events, { ...OPTS, final: true })).toEqual([]);
  });
  it("finals: 파이썬 후보 행과 맞출 값(보드|G|대상|) - 시간·클럽·벤치·창·런·점수차", () => {
    const finals = new Map<string, number>();
    // 선발 5명 = s1~s4 + g1(guard의 101). b1은 벤치에서 Q2에 득점 10.
    const starters = ["s1", "s2", "s3", "s4"].map((p) => ev(p, "H", "101", "Q1", 10, 0));
    const bench = Array.from({ length: 5 }, (_, i) => ev("b1", "H", "201", "Q2", 9, 50 - i));
    const events = [...starters, ...guard({ ast: 10, fouls: 5 }), ...bench, ev(null, null, "x", "Q4", 0, 0, { home_score: 20, away_score: 12 })];
    buildMomentTimeline(ctxOf({}), events, { ...OPTS, final: true }, finals);
    expect(Object.fromEntries(finals)).toMatchObject({
      "pg.dd_time.min|G|g1|": 170, "pg.td_time.min|G|g1|": 230, "pg.foul5_time.min|G|g1|": 290,
      "pg.club_td.max|G|g1|": 1, "pg.benchpts.max|G|b1|": 10, "pg.burst60.max|G|g1|": 10, "tg.margin.max|G|H|": 8, "tg.run.max|G|H|": 20,
    });
    expect(finals.has("pg.benchpts.max|G|g1|")).toBe(false);                                    // g1은 선발이라 벤치 득점이 아니다
  });
});
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/recordsMoments.test.ts`

Expected: FAIL — `Failed to resolve import "./recordsMoments"`.

- [ ] **Step 3: 엔진 구현**

<!-- create: courtside-web/lib/recordsMoments.ts -->
~~~typescript
import {
  buildRecordTimeline,
  clockOf,
  holdersLine,
  nextTarget,
  rankInfo,
  TOP_RANKS,
  validatedKey,
  verdictText,
  type RankInfo,
  type RecordContext,
  type RecordEvent,
  type RecordMoment,
  type RecordTimelineOptions,
  type ValueFmt,
} from "./records";

// 역대 기록 2단계 라이브 엔진(순간 기록 14개 보드) - 설계: docs/superpowers/specs/2026-10-10-record-book-phase2-design.md §3·§5
//
// 이벤트를 한 번 훑으며 코트 출전 초(101 투입 / 102 퇴장), 선수별 누적(득점·리바·어시·스틸·블락·파울), 득점 창, 팀 런, 점수차, 선발 5명을 쌓고
// 그 값이 서버가 내려준 "이 경기 이전" 보드 요약(RecordContext)의 TOP10에 닿는 순간을 RecordMoment로 뽑는다. 파이썬 정의(tools/record_book.py)와 같은
// 값을 내는지는 records.moments.parity.test.ts가 실제 경기로 고정한다. 순수 함수 - 클라이언트 번들에 들어가도 가볍다.

export const BURST_WINDOWS = [10, 35, 60] as const;
const CLOCK_SCOPE = "2017-18 이후";

const PERIOD_LEN: Record<string, number> = { Q1: 600, Q2: 600, Q3: 600, Q4: 600, X1: 300, X2: 300, X3: 300, X4: 300 };
const PERIOD_START: Record<string, number> = { Q1: 0, Q2: 600, Q3: 1200, Q4: 1800, X1: 2400, X2: 2700, X3: 3000, X4: 3300 };
const CATS = ["pts", "reb", "ast", "stl", "blk"] as const;
type Cat = (typeof CATS)[number];
const CAT_NAME: Record<Cat, { name: string; unit: string }> = {
  pts: { name: "득점", unit: "점" },
  reb: { name: "리바운드", unit: "개" },
  ast: { name: "어시스트", unit: "개" },
  stl: { name: "스틸", unit: "개" },
  blk: { name: "블락", unit: "개" },
};
const POINTS: Record<string, number> = { "201": 2, "207": 2, "205": 3, "203": 1 };
const CAT_OF_CODE: Record<string, Cat> = { "209": "reb", "210": "reb", "211": "ast", "212": "stl", "213": "blk" };
const FOUL_CODES = new Set(["215", "216"]);

const mmss = (v: number) => (v >= 60 ? `${Math.floor(v / 60)}분 ${v % 60}초` : `${v}초`);
const fmtPts: ValueFmt = (v) => `${v}점`;
const fmtCnt: ValueFmt = (v) => `${v}개`;

type BoardDef = { label: (v: number) => string; fmt: ValueFmt; unit: string; who?: string; scope?: string };
const BOARDS: Record<string, BoardDef> = {
  "tg.margin.max": { label: (v) => `점수차 ${v}점`, fmt: fmtPts, unit: "점" },
  "pg.benchpts.max": { label: (v) => `벤치 득점 ${v}점`, fmt: fmtPts, unit: "점" },
  "pg.nopts_reb.max": { label: (v) => `무득점 리바운드 ${v}개`, fmt: fmtCnt, unit: "개" },
  "pg.nopts_ast.max": { label: (v) => `무득점 어시스트 ${v}개`, fmt: fmtCnt, unit: "개" },
  "pg.dd_time.min": { label: (v) => `출전 ${mmss(v)} 만에 더블더블`, fmt: mmss, unit: "초" },
  "pg.td_time.min": { label: (v) => `출전 ${mmss(v)} 만에 트리플더블`, fmt: mmss, unit: "초" },
  "pg.foul5_time.min": { label: (v) => `출전 ${mmss(v)} 만에 5반칙 퇴장`, fmt: mmss, unit: "초", who: "불명예" },
  "pg.burst10.max": { label: (v) => `10초 동안 ${v}득점`, fmt: fmtPts, unit: "점", scope: CLOCK_SCOPE },
  "pg.burst35.max": { label: (v) => `35초 동안 ${v}득점`, fmt: fmtPts, unit: "점", scope: CLOCK_SCOPE },
  "pg.burst60.max": { label: (v) => `60초 동안 ${v}득점`, fmt: fmtPts, unit: "점", scope: CLOCK_SCOPE },
  "tg.run.max": { label: (v) => `${v}-0 런`, fmt: (v) => `${v}-0`, unit: "점", scope: CLOCK_SCOPE },
};
/** 임박(near) 기준 - 다음 기록 선과의 차가 이 값 이하일 때만 패널에 올린다(초 단위 창과 시간 보드는 임박이 없다). */
const NEAR_GAP2: Record<string, number> = { "tg.margin.max": 6, "pg.benchpts.max": 5, "tg.run.max": 4 };
const CLUBS = {
  td: { board: "pg.club_td.max", label: "트리플더블", sig: 2 },
  qd: { board: "pg.club_qd.max", label: "쿼드러플더블", sig: 0 },
  x5: { board: "pg.club_x5.max", label: "5x5", sig: 0 },
} as const;
type ClubKind = keyof typeof CLUBS;

const levelOf = (i: RankInfo) => (i.breaks ? 0 : i.rank);

function timeOf(e: RecordEvent): number | null {
  const len = PERIOD_LEN[e.quarter];
  if (len == null || e.clock_min == null || e.clock_sec == null) return null;
  return PERIOD_START[e.quarter] + len - (e.clock_min * 60 + e.clock_sec);
}

type PlayerState = {
  tcode: string;
  tot: Record<Cat, number>;
  foul: number;
  onSince: number | null;
  acc: number;
  done: Set<string>;
  win: { t: number; q: string; pts: number }[];
  lo: number[];
  sum: number[];
  best: number[];
  bad: boolean;
  lastQ: string | null;
  lastT: number;
};
const freshPlayer = (tcode: string): PlayerState => ({
  tcode, tot: { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 }, foul: 0, onSince: null, acc: 0, done: new Set(),
  win: [], lo: BURST_WINDOWS.map(() => 0), sum: BURST_WINDOWS.map(() => 0), best: BURST_WINDOWS.map(() => 0), bad: false, lastQ: null, lastT: 0,
});

/**
 * 순간 기록(2단계)만 뽑는다. finals를 주면 파이썬 후보 행과 맞출 값(`${board}|G|${대상}|` -> 값)도 채운다(대조 테스트용).
 * 종료 경기(opts.final)는 점수차와 무득점 보드를 마지막 값 하나로만 판정한다(중간에 더 컸어도 최종이 아니면 기록이 아니다).
 */
export function buildMomentTimeline(ctx: RecordContext, events: RecordEvent[], opts: RecordTimelineOptions, finals?: Map<string, number>): RecordMoment[] {
  const out: RecordMoment[] = [];
  const provisional = ctx.validated === undefined;
  const players = new Map<string, PlayerState>();
  const starters = new Map<string, Set<string>>();
  const lastEmit = new Map<string, { level: number; value: number }>();
  const openNear = new Map<string, RecordMoment>();
  const clubCount: Record<ClubKind, number> = { td: 0, qd: 0, x5: 0 };
  const lastScoreT = new Map<string, number>();
  const bestRun = new Map<string, number>();
  let run: { tcode: string | null; pts: number } = { tcode: null, pts: 0 };
  let runBad = false;
  let scoreH: number | null = null;
  let scoreA: number | null = null;
  let lastLead = -1;
  let lastIdx = -1;

  const closeNear = (key: string, at: number) => {
    const open = openNear.get(key);
    if (open) {
      open.until = at;
      openNear.delete(key);
    }
  };

  type Subject = { board: string; scope: "p" | "t"; subject: string; name: string; tcode: string | null; value: number; idx: number; clock: string };

  /** 순위 보드 판정 - 상위 10위 안이고 순위가 좋아질 때(신기록 이후엔 값이 좋아질 때마다)만 알린다. */
  const emitBoard = (a: Subject & { dir: "max" | "min"; sig?: number }) => {
    const s = ctx.boards[`${a.board}|G`];
    const info = s ? rankInfo(s.tops, a.value, a.dir) : null;
    if (!s || !info || info.rank > TOP_RANKS) return;
    const level = levelOf(info);
    const key = `${a.board}|${a.subject}`;
    const prev = lastEmit.get(key);
    if (prev && !(level < prev.level || (level === 0 && (a.dir === "max" ? a.value > prev.value : a.value < prev.value)))) return;
    lastEmit.set(key, { level, value: a.value });
    closeNear(key, a.idx);
    const def = BOARDS[a.board];
    out.push({
      id: `${key}|${level}|${a.value}|done`, idx: a.idx, until: Infinity, clock: a.clock, phase: "done",
      board: a.board, bucket: "G", subject: a.subject, period: "", scope: a.scope, name: a.name, tcode: a.tcode, value: a.value,
      rank: info.rank, tie: info.tie, breaks: info.breaks, remaining: 0,
      text: `${def.label(a.value)} ${verdictText(info, def.fmt, def.who, def.scope)}`,
      detail: holdersLine(s, info, def.fmt),
      provisional, sig: a.sig ?? level,
    });
  };

  /** 최다 보드의 임박 - 현재 값이 다음 기록 선(상위 3위 값·신기록)과 gap 이내이면 패널용 near를 새로 연다. */
  const trackNear = (a: Subject) => {
    const key = `${a.board}|${a.subject}`;
    closeNear(key, a.idx);
    const s = ctx.boards[`${a.board}|G`];
    if (!s || s.tops.length === 0) return;
    const target = nextTarget(s.tops, a.value);
    if (target == null) return;
    const gap = target - a.value;
    if (gap > (NEAR_GAP2[a.board] ?? 0)) return;
    const tInfo = rankInfo(s.tops, target, "max");
    if (!tInfo) return;
    const def = BOARDS[a.board];
    const m: RecordMoment = {
      id: `${key}|${target}|near|${a.value}`, idx: a.idx, until: Infinity, clock: a.clock, phase: "near",
      board: a.board, bucket: "G", subject: a.subject, period: "", scope: a.scope, name: a.name, tcode: a.tcode, value: a.value,
      rank: tInfo.rank, tie: tInfo.tie, breaks: tInfo.breaks, remaining: gap,
      text: `${def.label(a.value)} · ${gap}${def.unit} 더하면 ${verdictText(tInfo, def.fmt, def.who, def.scope)}`,
      detail: holdersLine(s, tInfo, def.fmt),
      provisional, sig: levelOf(tInfo),
    };
    openNear.set(key, m);
    out.push(m);
  };

  const emitClub = (kind: ClubKind, pcode: string, st: PlayerState, idx: number, clock: string) => {
    const def = CLUBS[kind];
    const s = ctx.boards[`${def.board}|G`];
    clubCount[kind] += 1;
    const n = (s ? s.tops.length : 0) + clubCount[kind];
    const prior = s && s.tops.length <= 3 ? s.holders.map((h) => `${h.who}(${h.d})`) : [];
    closeNear(`${def.board}|${pcode}`, idx);
    out.push({
      id: `${def.board}|${pcode}|club`, idx, until: Infinity, clock, phase: "done",
      board: def.board, bucket: "G", subject: pcode, period: "", scope: "p", name: opts.names.player(pcode), tcode: st.tcode, value: 1,
      rank: 1, tie: false, breaks: false, remaining: 0,
      text: `${def.label} 달성 — KBL 역대 ${n}번째`,
      detail: prior.length ? `앞선 기록: ${prior.join(" · ")}` : "",
      provisional, sig: def.sig, club: def.label,
    });
  };

  /** 클럽 임박(패널 전용): 트리플더블 = 두 부문 10 이상 + 나머지 중 가장 높은 것 8 이상, 5x5 = 네 부문 5 이상 + 나머지 3 이상. */
  const nearClub = (pcode: string, st: PlayerState, idx: number, clock: string) => {
    const open = (kind: ClubKind, cat: Cat, goal: number, label: string) => {
      const key = `${CLUBS[kind].board}|${pcode}`;
      const v = st.tot[cat];
      const id = `${key}|near|${cat}|${v}`;
      if (openNear.get(key)?.id === id) return; // 같은 상태면 새로 열지 않는다(이벤트마다 호출된다)
      closeNear(key, idx);
      const m: RecordMoment = {
        id, idx, until: Infinity, clock, phase: "near",
        board: CLUBS[kind].board, bucket: "G", subject: pcode, period: "", scope: "p", name: opts.names.player(pcode), tcode: st.tcode, value: v,
        rank: 1, tie: false, breaks: false, remaining: goal - v,
        text: `${CAT_NAME[cat].name} ${v}${CAT_NAME[cat].unit} · ${goal - v}${CAT_NAME[cat].unit} 더하면 ${label}`,
        detail: "", provisional, sig: 3, club: CLUBS[kind].label,
      };
      openNear.set(key, m);
      out.push(m);
    };
    const rest = (min: number) => CATS.filter((c) => st.tot[c] < min).sort((x, y) => st.tot[y] - st.tot[x])[0];
    if (!st.done.has("td") && CATS.filter((c) => st.tot[c] >= 10).length === 2) {
      const c = rest(10);
      if (c && st.tot[c] >= 8) open("td", c, 10, "트리플더블");
    }
    if (!st.done.has("x5") && CATS.filter((c) => st.tot[c] >= 5).length === 4) {
      const c = rest(5);
      if (c && st.tot[c] >= 3) open("x5", c, 5, "5x5");
    }
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    lastIdx = idx;
    const clock = clockOf(e);

    // 점수차 - 라이브는 점수가 바뀔 때마다(종료 경기는 아래에서 마지막 값 하나로)
    if (typeof e.home_score === "number" && typeof e.away_score === "number") {
      scoreH = e.home_score;
      scoreA = e.away_score;
      if (!opts.final && opts.home && opts.away && scoreH !== scoreA) {
        const leader = scoreH > scoreA ? opts.home : opts.away;
        const lead = Math.abs(scoreH - scoreA);
        if (lead !== lastLead) {
          lastLead = lead;
          const base = { board: "tg.margin.max", scope: "t" as const, subject: leader, name: opts.names.team(leader), tcode: leader, value: lead, idx, clock };
          emitBoard({ ...base, dir: "max" });
          trackNear(base);
        }
      }
    }

    const q = e.quarter;
    if (!q || q === "PRE" || !e.pcode || !e.tcode || !e.action_code) continue;
    const pcode = e.pcode;
    const tcode = e.tcode;
    const code = e.action_code;
    const t = timeOf(e);
    const st = players.get(pcode) ?? freshPlayer(tcode);
    if (!players.has(pcode)) players.set(pcode, st);

    if (code === "101") {
      if (t != null) st.onSince = t;
      if (q === "Q1" && t === 0) starters.set(tcode, (starters.get(tcode) ?? new Set<string>()).add(pcode));
      continue;
    }
    if (code === "102") {
      if (st.onSince != null && t != null) st.acc += Math.max(0, t - st.onSince);
      st.onSince = null;
      continue;
    }

    const cur = st.acc + (st.onSince != null && t != null ? t - st.onSince : 0);
    const pts = POINTS[code] ?? 0;
    const name = opts.names.player(pcode);
    if (pts) st.tot.pts += pts;
    else if (CAT_OF_CODE[code]) st.tot[CAT_OF_CODE[code]] += 1;
    else if (FOUL_CODES.has(code)) st.foul += 1;

    // 최단 시간 더블더블 / 트리플더블 / 5반칙(출전 초 - 코트에 있었다는 기록이 없어 0이면 시간을 모르므로 건너뛴다)
    const doubles = CATS.filter((c) => st.tot[c] >= 10).length;
    if (cur > 0) {
      const timed = (key: string, board: string, value: number) => {
        if (st.done.has(key)) return;
        st.done.add(key);
        finals?.set(`${board}|G|${pcode}|`, value);
        emitBoard({ board, scope: "p", subject: pcode, name, tcode, value, dir: "min", idx, clock });
      };
      if (doubles >= 2) timed("time_dd", "pg.dd_time.min", cur);
      if (doubles >= 3) timed("time_td", "pg.td_time.min", cur);
      if (st.foul >= 5) timed("time_foul5", "pg.foul5_time.min", cur);
    }

    // 클럽(시간 보드와 done 키가 겹치지 않게 time_ 접두사를 따로 쓴다)
    const clubs: [ClubKind, boolean][] = [["td", doubles >= 3], ["qd", doubles >= 4], ["x5", CATS.every((c) => st.tot[c] >= 5)]];
    for (const [kind, ok] of clubs) {
      if (!ok || st.done.has(kind)) continue;
      st.done.add(kind);
      finals?.set(`${CLUBS[kind].board}|G|${pcode}|`, 1);
      emitClub(kind, pcode, st, idx, clock);
    }
    nearClub(pcode, st, idx, clock);

    if (!pts) continue;

    // 벤치 득점 - 그 팀 선발 5명이 확인된 경기에서 선발이 아닌 선수
    const five = starters.get(tcode);
    if (five && five.size === 5 && !five.has(pcode)) {
      const base = { board: "pg.benchpts.max", scope: "p" as const, subject: pcode, name, tcode, value: st.tot.pts, idx, clock };
      emitBoard({ ...base, dir: "max" });
      trackNear(base);
    }

    // N초 득점 - 한 선수의 득점 시각이 쿼터 안에서 거꾸로 가면 그 선수는 이후 알리지 않는다(파이썬은 선수 전체 제외)
    if (!st.bad) {
      if (t == null || (st.lastQ === q && t < st.lastT)) st.bad = true;
      else {
        st.lastQ = q;
        st.lastT = t;
        st.win.push({ t, q, pts });
        BURST_WINDOWS.forEach((w, i) => {
          st.sum[i] += pts;
          while (st.win[st.lo[i]].q !== q || t - st.win[st.lo[i]].t > w) {
            st.sum[i] -= st.win[st.lo[i]].pts;
            st.lo[i] += 1;
          }
          if (st.sum[i] > st.best[i]) {
            st.best[i] = st.sum[i];
            emitBoard({ board: `pg.burst${w}.max`, scope: "p", subject: pcode, name, tcode, value: st.sum[i], dir: "max", idx, clock });
          }
        });
      }
    }

    // 팀 런 - 두 팀 득점 이벤트가 쿼터마다 시계 순서일 때만(어긋나면 이후 런은 알리지 않는다)
    if (!runBad) {
      if (t == null || t < (lastScoreT.get(q) ?? 0)) runBad = true;
      else lastScoreT.set(q, t);
    }
    if (run.tcode === tcode) run.pts += pts;
    else {
      if (run.tcode) closeNear(`tg.run.max|${run.tcode}`, idx);
      run = { tcode, pts };
    }
    if (!runBad) {
      bestRun.set(tcode, Math.max(bestRun.get(tcode) ?? 0, run.pts));
      const base = { board: "tg.run.max", scope: "t" as const, subject: tcode, name: opts.names.team(tcode), tcode, value: run.pts, idx, clock };
      emitBoard({ ...base, dir: "max" });
      trackNear(base);
    }
  }

  // 경기 끝 판정 + finals
  const lastClock = lastIdx >= 0 ? clockOf(events[lastIdx]) : "";
  if (scoreH != null && scoreA != null && scoreH !== scoreA && opts.home && opts.away) {
    const leader = scoreH > scoreA ? opts.home : opts.away;
    const lead = Math.abs(scoreH - scoreA);
    finals?.set(`tg.margin.max|G|${leader}|`, lead);
    if (opts.final) emitBoard({ board: "tg.margin.max", scope: "t", subject: leader, name: opts.names.team(leader), tcode: leader, value: lead, dir: "max", idx: lastIdx, clock: lastClock });
  }
  for (const [pcode, st] of players) {
    if (st.tot.pts === 0) {
      for (const [cat, board] of [["reb", "pg.nopts_reb.max"], ["ast", "pg.nopts_ast.max"]] as const) {
        const v = st.tot[cat];
        if (v <= 0) continue;
        finals?.set(`${board}|G|${pcode}|`, v);
        if (opts.final) emitBoard({ board, scope: "p", subject: pcode, name: opts.names.player(pcode), tcode: st.tcode, value: v, dir: "max", idx: lastIdx, clock: lastClock });
      }
    }
    const five = starters.get(st.tcode);
    if (five && five.size === 5 && !five.has(pcode) && st.tot.pts > 0) finals?.set(`pg.benchpts.max|G|${pcode}|`, st.tot.pts);
    if (!st.bad) {
      BURST_WINDOWS.forEach((w, i) => {
        if (st.best[i] > 0) finals?.set(`pg.burst${w}.max|G|${pcode}|`, st.best[i]);
      });
    }
  }
  if (!runBad) for (const [tcode, v] of bestRun) finals?.set(`tg.run.max|G|${tcode}|`, v);
  for (const key of [...openNear.keys()]) closeNear(key, events.length);
  return out;
}

/** 1단계(쿼터·경기 최다/최소)와 2단계(순간 기록)를 합쳐 시간순으로. 종료 경기는 2단계도 테이블에 있는(validated) 항목만 남긴다. */
export function buildAllRecordMoments(ctx: RecordContext, events: RecordEvent[], opts: RecordTimelineOptions): RecordMoment[] {
  const base = buildRecordTimeline(ctx, events, opts);
  const extra = buildMomentTimeline(ctx, events, opts);
  const validated = ctx.validated ? new Set(ctx.validated) : null;
  const kept = validated ? extra.filter((m) => validated.has(validatedKey(m))) : extra;
  return [...base, ...kept].sort((a, b) => a.idx - b.idx);
}
~~~

- [ ] **Step 4: 통과 확인**

Run: `cd courtside-web && npx vitest run lib/recordsMoments.test.ts && npx tsc --noEmit && npx eslint lib/recordsMoments.ts lib/recordsMoments.test.ts`

Expected: 테스트 통과, `tsc`·`eslint` 출력 없음. 실패하는 단언은 **구현이 아니라 기대값이 틀렸는지** 먼저 손으로 계산해 확인한다(특히 near의 `until`, 점수차 라이브 순번, 팀 런 값).

- [ ] **Step 5: 커밋**

```bash
git add courtside-web/lib/recordsMoments.ts courtside-web/lib/recordsMoments.test.ts
git commit -m "$(cat <<'EOF'
feat(web): phase 2 record engine - clubs, fastest double/triple-double and five fouls, bench points, win margin, N-second bursts, team runs

One pass over the events tracks on-court seconds (101/102), per-player totals, scoring windows,
team runs, the running margin and the five starters, and emits TOP10 moments against the
as-of board summaries. Finished games judge the margin and the no-point boards once at the end;
buildAllRecordMoments merges phase 1 and phase 2 and keeps only validated rows for finished games.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 웹 — 소비처 연결(GameReplay 라이브·리포트 섹션)

**Files:**
- Modify: `courtside-web/components/GameReplay.tsx`, `courtside-web/lib/postgameReport.ts`, `courtside-web/lib/postgameReport.test.ts`

**Interfaces:**
- Consumes: Task 5의 `buildAllRecordMoments`
- Produces: `recordBookSection(ctx, events, tags, names, sides?)` — `sides = { home, away }` tcode.

- [ ] **Step 1: 리포트 테스트 추가(실패)**

<!-- edit: courtside-web/lib/postgameReport.test.ts -->
<!-- old -->
~~~typescript
  it("종료 경기에서 테이블에 없는 항목(validated 밖)은 쓰지 않고, 아무것도 없으면 null", () => {
~~~
<!-- new -->
~~~typescript
  it("2단계 순간 기록(클럽)도 같은 섹션에 나온다 - 테이블에 있는 이 경기 행만", () => {
    const evs = attachDerivedFields([
      ev({ event_order: 0, quarter: "PRE", home_score: 0, away_score: 0, home_win_prob: 0.5 }),
      ...Array.from({ length: 10 }, (_, i) => ev({ event_order: i + 1, quarter: "Q1", clock_min: 9, clock_sec: 59 - i, home_score: 0, away_score: 0, action_code: "211", pcode: "p1", player_name: "허훈", tcode: "H", home_win_prob: 0.5 })),
      ...Array.from({ length: 10 }, (_, i) => ev({ event_order: i + 11, quarter: "Q1", clock_min: 8, clock_sec: 59 - i, home_score: 0, away_score: 0, action_code: "210", pcode: "p1", player_name: "허훈", tcode: "H", home_win_prob: 0.5 })),
      ...Array.from({ length: 5 }, (_, i) => ev({ event_order: i + 21, quarter: "Q1", clock_min: 7, clock_sec: 59 - i, home_score: i * 2 + 2, away_score: 0, action_code: "201", pcode: "p1", player_name: "허훈", tcode: "H", home_win_prob: 0.5 })),
    ]);
    const c: RecordContext = { asOf: "x", boards: { "pg.club_td.max|G": { tops: Array(77).fill(1), holders: [] } }, validated: ["pg.club_td.max|G|p1|"] };
    const html = htmlOf(recordBookSection(c, evs, tags, names, { home: "H", away: "A" })!);
    expect(html).toContain("트리플더블 달성 — KBL 역대 78번째");
    expect(recordBookSection({ ...c, validated: [] }, evs, tags, names, { home: "H", away: "A" })).toBeNull();
  });

  it("종료 경기에서 테이블에 없는 항목(validated 밖)은 쓰지 않고, 아무것도 없으면 null", () => {
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/postgameReport.test.ts`

Expected: FAIL — 새 테스트(`recordBookSection`이 5번째 인자를 받지 않고 2단계를 만들지 않는다).

- [ ] **Step 3: 연결**

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~typescript
import { buildRecordTimeline, recordLine, type RecordContext, type RecordMoment, type RecordNames } from "./records";
~~~
<!-- new -->
~~~typescript
import { recordLine, type RecordContext, type RecordMoment, type RecordNames } from "./records";
import { buildAllRecordMoments } from "./recordsMoments";
~~~

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~typescript
export function recordBookSection(ctx: RecordContext, events: GameEvent[], tags: ReportTags, names: RecordNames): ReportSection | null {
  const last = new Map<string, RecordMoment>();
  for (const m of buildRecordTimeline(ctx, events, { names, final: true })) if (m.phase === "done") last.set(`${m.board}|${m.subject}|${m.period}`, m);
~~~
<!-- new -->
~~~typescript
export function recordBookSection(ctx: RecordContext, events: GameEvent[], tags: ReportTags, names: RecordNames, sides?: { home: string; away: string }): ReportSection | null {
  const last = new Map<string, RecordMoment>();
  for (const m of buildAllRecordMoments(ctx, events, { names, final: true, ...(sides ?? {}) })) if (m.phase === "done") last.set(`${m.board}|${m.subject}|${m.period}`, m);
~~~

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~typescript
    const book = recordBookSection(input.records, events, tags, {
      player: (pcode) => boxByPcode.get(pcode)?.name ?? pcode,
      team: (tcode) => (tcode === homeTcode ? homeTname : tcode === awayTcode ? awayTname : tcode),
    });
~~~
<!-- new -->
~~~typescript
    const book = recordBookSection(
      input.records,
      events,
      tags,
      {
        player: (pcode) => boxByPcode.get(pcode)?.name ?? pcode,
        team: (tcode) => (tcode === homeTcode ? homeTname : tcode === awayTcode ? awayTname : tcode),
      },
      { home: homeTcode, away: awayTcode }
    );
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~typescript
import { buildRecordTimeline, recordToast, type RecordContext, type RecordMoment } from "@/lib/records";
~~~
<!-- new -->
~~~typescript
import { recordToast, type RecordContext, type RecordMoment } from "@/lib/records";
import { buildAllRecordMoments } from "@/lib/recordsMoments";
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~typescript
        ? buildRecordTimeline(records, events, {
            names: {
              player: (pcode) => nameByPcode.get(pcode) ?? liveNames?.[pcode] ?? liveCtx.lateNames[pcode] ?? pcode,
              team: (tcode) => (tcode === homeTeam.tcode ? homeTeam.name : tcode === awayTeam.tcode ? awayTeam.name : tcode),
            },
            final: !live,
          })
~~~
<!-- new -->
~~~typescript
        ? buildAllRecordMoments(records, events, {
            names: {
              player: (pcode) => nameByPcode.get(pcode) ?? liveNames?.[pcode] ?? liveCtx.lateNames[pcode] ?? pcode,
              team: (tcode) => (tcode === homeTeam.tcode ? homeTeam.name : tcode === awayTeam.tcode ? awayTeam.name : tcode),
            },
            final: !live,
            home: homeTeam.tcode,
            away: awayTeam.tcode,
          })
~~~

- [ ] **Step 4: 통과 확인**

Run: `cd courtside-web && npx vitest run lib/postgameReport.test.ts components/MilestoneWatch.test.tsx lib/records.test.ts lib/recordsMoments.test.ts && npx tsc --noEmit && npx eslint components/GameReplay.tsx lib/postgameReport.ts`

Expected: 통과, `tsc`·`eslint` 출력 없음(`homeTcode`/`awayTcode`는 `buildPostgameReport` 안에 이미 있는 변수 - 없으면 `input.homeTeam.tcode`/`input.awayTeam.tcode`로 바꾼다).

- [ ] **Step 5: 커밋**

```bash
git add courtside-web/components/GameReplay.tsx courtside-web/lib/postgameReport.ts courtside-web/lib/postgameReport.test.ts
git commit -m "$(cat <<'EOF'
feat(web): live record watch and the post-game report use the phase 2 record moments

GameReplay and recordBookSection call buildAllRecordMoments with the home/away team codes so the
win-margin board can name the leader; finished games keep only rows present in the table.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 대조 픽스처·재생·빈도 도구와 테스트

**Files:**
- Modify: `tools/dump_record_fixtures.py`, `courtside-web/lib/records.frequency.test.ts`
- Create: `courtside-web/lib/__fixtures__/momentParity/*.json`(도구가 생성), `courtside-web/lib/records.moments.parity.test.ts`, `courtside-web/lib/records.moments.replay.test.ts`

**Interfaces:**
- Produces: 픽스처 형식 `{"gmkey","home","away","events":[[pcode,tcode,code,quarter,min,sec,homeScore,awayScore]...],"rows":[[board,bucket,subject,period,value]...]}`; 도구 `--moments OUTDIR --gmkeys ...`; `--freq` 출력에 `home`/`away`와 8값 이벤트.

- [ ] **Step 1: 도구 확장**

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
def parity_ok(g, official_rows, event_rows):
~~~
<!-- new -->
~~~python
MOMENT_CODES = RELEVANT | {"101", "102", "215", "216"}      # 2단계가 보는 코드(코트 투입·퇴장, 개인 파울 추가)


def to_moment_events(g):
    """text-cast -> [pcode, tcode, code, quarter, min, sec, homeScore, awayScore] (n 순서, 득점 이벤트로 쌓은 점수 - 웹 점수차 계산용)."""
    pidx = rb.player_index(g)
    h = a = 0
    out = []
    for e in rb.ordered_events(g):
        code, q = e.get("a"), e.get("q")
        if code not in MOMENT_CODES or not q:
            continue
        pts = rb.PTS_BY_CODE.get(code, 0)
        if pts and e.get("t") and e.get("p"):
            if e["t"] == g["home"]:
                h += pts
            elif e["t"] == g["away"]:
                a += pts
        pcode = pidx.get((e.get("p"), e.get("t"))) if e.get("p") else None
        out.append([pcode, e.get("t"), code, q, e.get("m"), e.get("s"), h, a])
    return out


def dump_moments(outdir, gmkeys):
    os.makedirs(outdir, exist_ok=True)
    written = 0
    for gmkey in gmkeys:
        g = rb.load_game(gmkey)
        if g is None or any(v is None for v in rb.player_index(g).values()) or not rb.quarters_match_official(g):
            print(f"  건너뜀(없음/동명이인/게이트 1 탈락): {gmkey}")
            continue
        rows = rb.moment_candidates(g)
        if not rows:
            print(f"  건너뜀(2단계 행 없음): {gmkey}")
            continue
        body = {"gmkey": gmkey, "home": g["home"], "away": g["away"], "events": to_moment_events(g),
                "rows": [[r["board"], r["bucket"], r["subject"], r["period"], r["value"]] for r in rows]}
        with open(os.path.join(outdir, f"{gmkey}.json"), "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, separators=(",", ":"))
        kinds = sorted({r["board"] for r in rows})
        print(f"  {gmkey}: 행 {len(rows)}개 ({len(kinds)}개 보드)")
        written += 1
    print(f"moment fixtures: {written}개 -> {outdir}")


def parity_ok(g, official_rows, event_rows):
~~~

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
            json.dump({"gmkey": gmkey, "date": g["date"], "start": g["start"], "names": {p["pcode"]: p["pname"] for p in g["players"]}, "teams": g["names"], "events": to_events(g)},
                      f, ensure_ascii=False, separators=(",", ":"))
~~~
<!-- new -->
~~~python
            json.dump({"gmkey": gmkey, "date": g["date"], "start": g["start"], "home": g["home"], "away": g["away"],
                       "names": {p["pcode"]: p["pname"] for p in g["players"]}, "teams": g["names"], "events": to_moment_events(g)},
                      f, ensure_ascii=False, separators=(",", ":"))
~~~

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
    ap.add_argument("--freq", help="빈도 실측용 이벤트를 쓸 폴더")
~~~
<!-- new -->
~~~python
    ap.add_argument("--moments", help="2단계(순간 기록) 대조 픽스처를 쓸 폴더 - --gmkeys 필요")
    ap.add_argument("--freq", help="빈도 실측용 이벤트를 쓸 폴더")
~~~

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
    if not (args.parity or args.freq):
        ap.error("--parity 또는 --freq가 필요하다")
~~~
<!-- new -->
~~~python
    if not (args.parity or args.freq or args.moments):
        ap.error("--parity, --moments, --freq 중 하나가 필요하다")
    if args.moments:
        dump_moments(args.moments, [x.strip() for x in (args.gmkeys or "").split(",") if x.strip()])
~~~

- [ ] **Step 2: 픽스처 생성**

Run (저장소 루트에서):

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" dump_record_fixtures.py --moments ../courtside-web/lib/__fixtures__/momentParity --gmkeys S45G01N231,S29G01N233,S41G03N11,S43G01N236,S45G01N220,S47G01N269,S37G01N269,S43G01N218,S45G01N22,S33G01N50,S35G01N162,S31G01N108
cd ..
```

Expected(2026-10-10 리허설 실측): 12경기 모두 기록돼 `moment fixtures: 12개 -> ...`, 경기당 행 12~84개, 파일 합계 약 300KB. 건너뛴 경기(게이트·동명이인)는 로그에 나온다 — **S45G01N231(마레이 트리플더블)·S37G01N269(24-0 런)이 빠지면** 같은 시즌의 다른 해당 경기로 바꿔 다시 만든다(재생 테스트가 이 둘을 쓴다).

- [ ] **Step 3: 대조·재생 테스트 작성**

<!-- create: courtside-web/lib/records.moments.parity.test.ts -->
~~~typescript
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMomentTimeline } from "./recordsMoments";
import type { RecordEvent } from "./records";

// 파이썬(tools/record_book.py moment_candidates)이 실제 경기에서 만든 2단계 후보 행과 웹 엔진(recordsMoments)의 최종 값이 같은지 대조한다.
// 픽스처는 tools/dump_record_fixtures.py --moments 로 만든다(이벤트 쿼터 득점 = 공식 쿼터 점수인 경기만).

const DIR = process.env.RECORD_MOMENT_PARITY_DIR ?? join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "momentParity");
type Fixture = {
  gmkey: string; home: string; away: string;
  events: [string | null, string | null, string, string, number | null, number | null, number, number][];
  rows: [string, string, string, string, number][];
};

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => join(DIR, f)) : [];

describe("파이썬 2단계 후보 행 vs 웹 순간 기록 최종 값", () => {
  it("픽스처가 있다", () => {
    expect(files.length).toBeGreaterThan(5);
  });
  for (const file of files) {
    it(file.split(/[\\/]/).slice(-1)[0], () => {
      const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
      const events: RecordEvent[] = fx.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score]) => ({
        pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score,
      }));
      const finals = new Map<string, number>();
      buildMomentTimeline({ asOf: "x", boards: {} }, events, { names: { player: (p) => p, team: (t) => t }, final: true, home: fx.home, away: fx.away }, finals);
      const bad = fx.rows.filter(([board, bucket, subject, period, value]) => finals.get(`${board}|${bucket}|${subject}|${period}`) !== value);
      expect(bad.slice(0, 5).map((r) => ({ row: r, got: finals.get(`${r[0]}|${r[1]}|${r[2]}|${r[3]}`) }))).toEqual([]);
      expect(fx.rows.length).toBeGreaterThan(0);
    });
  }
  it("보드 종류가 고루 덮인다(점수차·벤치·클럽·시간·창·런 중 대부분)", () => {
    const seen = new Set<string>();
    for (const file of files) for (const r of (JSON.parse(readFileSync(file, "utf8")) as Fixture).rows) seen.add(r[0]);
    for (const b of ["tg.margin.max", "pg.benchpts.max", "pg.club_td.max", "pg.dd_time.min", "pg.td_time.min", "pg.burst35.max", "tg.run.max"]) expect(seen.has(b)).toBe(true);
  });
});
~~~

<!-- create: courtside-web/lib/records.moments.replay.test.ts -->
~~~typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAllRecordMoments } from "./recordsMoments";
import type { BoardSummary, RecordContext, RecordEvent } from "./records";

// 실전 재현: 실제 경기 이벤트를 "그 경기 이전" 가상 기록판으로 재생해 문구와 시점을 고정한다.
//  - S45G01N231 2025-03-20 아셈 마레이 트리플더블(출전 20:25 = 1225초)
//  - S37G01N269 2021-04-06 24-0 런(2017-18 이후 최대 타이)

const DIR = join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "momentParity");
type Fixture = { home: string; away: string; events: [string | null, string | null, string, string, number | null, number | null, number, number][]; rows: [string, string, string, string, number][] };
const load = (gmkey: string) => JSON.parse(readFileSync(join(DIR, `${gmkey}.json`), "utf8")) as Fixture;
const toEvents = (fx: Fixture): RecordEvent[] =>
  fx.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score]) => ({ pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score }));
const board = (tops: number[], who: string[]): BoardSummary => ({ tops, holders: tops.slice(0, 3).map((v, i) => ({ v, who: who[i % who.length], d: "2020-01-12" })) });
const names = { player: (p: string) => p, team: (t: string) => t };

describe("실전 재생 - 마레이 트리플더블(S45G01N231)", () => {
  const fx = load("S45G01N231");
  const marey = fx.rows.find(([b]) => b === "pg.td_time.min")!;
  const ctx = (validated?: string[]): RecordContext => ({
    asOf: "2025-03-19",
    boards: {
      "pg.td_time.min|G": board([1168, 1310, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100], ["애런 헤인즈"]),
      "pg.club_td.max|G": { tops: Array<number>(76).fill(1), holders: [] },
    },
    ...(validated ? { validated } : {}),
  });
  it("라이브(잠정): 3번째 부문이 10에 닿는 순간 '출전 N분 만에 트리플더블 KBL 역대 2위'와 클럽 77번째", () => {
    expect(marey[4]).toBe(1225);
    const ms = buildAllRecordMoments(ctx(), toEvents(fx), { names, final: false, home: fx.home, away: fx.away }).filter((m) => m.subject === marey[2]);
    const td = ms.find((m) => m.board === "pg.td_time.min")!;
    expect(td.text).toBe("출전 20분 25초 만에 트리플더블 KBL 역대 2위");
    expect(td.detail).toBe("역대 1위 19분 28초: 애런 헤인즈");
    expect(td.provisional).toBe(true);
    const club = ms.find((m) => m.phase === "done" && m.board === "pg.club_td.max")!;
    expect(club.text).toBe("트리플더블 달성 — KBL 역대 77번째");
    expect(club.idx).toBe(td.idx);
  });
  it("종료 경기: 테이블에 이 경기 행이 있으면 같은 알림이 '잠정' 없이 남고, 없으면 사라진다", () => {
    const keys = [`pg.td_time.min|G|${marey[2]}|`, `pg.club_td.max|G|${marey[2]}|`];
    const fin = buildAllRecordMoments(ctx(keys), toEvents(fx), { names, final: true, home: fx.home, away: fx.away }).filter((m) => m.subject === marey[2]);
    expect(fin.filter((m) => m.phase === "done").map((m) => m.board).sort()).toEqual(["pg.club_td.max", "pg.td_time.min"]);
    expect(fin.every((m) => m.provisional === false)).toBe(true);
    expect(buildAllRecordMoments(ctx([]), toEvents(fx), { names, final: true, home: fx.home, away: fx.away }).filter((m) => m.board.startsWith("pg.td_time"))).toEqual([]);
  });
});

describe("실전 재생 - 24-0 런(S37G01N269)", () => {
  const fx = load("S37G01N269");
  it("21-0(공동 7위)·23-0(공동 3위)은 순위 알림, 24-0은 타이 기록(공동 1위) - 3점슛·자유투가 섞여 값이 홀수로도 뛴다", () => {
    const tops = [24, 24, 23, 23, 22, 22, 21, 21, 20, 20];
    const ctx: RecordContext = { asOf: "2021-04-05", boards: { "tg.run.max|G": board(tops, ["안양 정관장"]) } };
    const runs = buildAllRecordMoments(ctx, toEvents(fx), { names, final: false, home: fx.home, away: fx.away }).filter((m) => m.phase === "done" && m.board === "tg.run.max");
    expect(runs.map((m) => [m.value, m.rank])).toEqual([[21, 7], [23, 3], [24, 1]]);
    expect(runs[runs.length - 1].text).toBe("24-0 런 KBL 2017-18 이후 타이 기록(공동 1위)");
  });
});
~~~

- [ ] **Step 4: 빈도 테스트를 2단계 포함으로 갱신**

<!-- edit: courtside-web/lib/records.frequency.test.ts -->
<!-- old -->
~~~typescript
import { buildRecordTimeline, type RecordMoment } from "./records";
~~~
<!-- new -->
~~~typescript
import type { RecordMoment } from "./records";
import { buildAllRecordMoments } from "./recordsMoments";
~~~

<!-- edit: courtside-web/lib/records.frequency.test.ts -->
<!-- old -->
~~~typescript
type Game = { gmkey: string; date: string; start: string; names: Record<string, string>; teams: Record<string, string>; events: [string | null, string | null, string, string, number | null, number | null][] };
~~~
<!-- new -->
~~~typescript
type Game = {
  gmkey: string; date: string; start: string; home: string; away: string; names: Record<string, string>; teams: Record<string, string>;
  events: [string | null, string | null, string, string, number | null, number | null, number, number][];
};
~~~

<!-- edit: courtside-web/lib/records.frequency.test.ts -->
<!-- old -->
~~~typescript
      const events = g.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec]) => ({ pcode, tcode, action_code, quarter, clock_min, clock_sec }));
      const done = ctx ? buildRecordTimeline(ctx, events, { names: { player: (p) => g.names[p] ?? p, team: (t) => g.teams[t] ?? t }, final: true }).filter((m) => m.phase === "done") : [];
~~~
<!-- new -->
~~~typescript
      const events = g.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score]) => ({ pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score }));
      const names = { player: (p: string) => g.names[p] ?? p, team: (t: string) => g.teams[t] ?? t };
      const done = ctx ? buildAllRecordMoments(ctx, events, { names, final: true, home: g.home, away: g.away }).filter((m) => m.phase === "done") : [];
~~~

- [ ] **Step 5: 통과 확인 + 빈도 실측**

Run:

```bash
cd courtside-web
npx vitest run lib/records.moments.parity.test.ts lib/records.moments.replay.test.ts lib/records.frequency.test.ts
cd ..
```

Expected: 대조·재생 통과(픽스처 수만큼), 빈도 테스트는 환경변수가 없어 `skipped`. 대조가 실패하면 출력의 `row`/`got`이 어긋난 보드·값이다 — 파이썬과 `recordsMoments.ts`의 정의가 어긋난 것이므로 한쪽을 고쳐 다시 맞춘다.

그다음 **빈도 실측**(2025-26, 약 1~2분):

```bash
FREQ="C:/Users/mwon0/AppData/Local/Temp/claude/d-------------kbl-realdata/c76288f4-a2fc-4980-9325-453c81dc2035/scratchpad/freq2"
rm -rf "$FREQ" && mkdir -p "$FREQ"
cd tools && PYTHONIOENCODING=utf-8 "$PY" dump_record_fixtures.py --freq "$FREQ/events" --prefix S47 --entries "$FREQ/entries.json" && cd ../courtside-web
RECORD_FREQ_EVENTS="$FREQ/events" RECORD_FREQ_ENTRIES="$FREQ/entries.json" npx vitest run lib/records.frequency.test.ts --disableConsoleIntercept --reporter=dot
cd ..
```

Expected(2026-10-10 리허설 실측, 270경기·1+2단계 합산): `전체(TOP10) 달성 알림/경기: {"n":270,"mean":0.65,"p50":0,"p90":2,"p95":3,"max":24,"atLeast1":93,"atLeast3":15}`, `순위 5위 이내만 ... "mean":0.31`(1단계만일 때 0.55/p95 2/max 23). 새 보드가 더한 것은 평균 +0.10(트리플더블 클럽 8건 등).

**판정 기준(설계 §7)**: `전체(TOP10) 달성 알림/경기`가 평균 ≤ 1이고 상위 5%(p95) ≤ 3이면 지금 구현(전부 토스트) 유지. 넘으면 가장 시끄러운 보드(`보드별 상위` 출력)를 확인해, 그 보드만 토스트 순위 한도를 5위로 줄이도록 `GameReplay`의 `computePushNotifications` 호출부 필터를 고친다(별도 단계로 계획서에 추가). 결과(평균·p95·최대·상위 보드)를 스펙 §7에 한 줄로 기록한다(Task 9).

- [ ] **Step 6: 커밋**

```bash
git add tools/dump_record_fixtures.py courtside-web/lib/__fixtures__/momentParity courtside-web/lib/records.moments.parity.test.ts courtside-web/lib/records.moments.replay.test.ts courtside-web/lib/records.frequency.test.ts
git commit -m "$(cat <<'EOF'
test(records): pin Python and web phase 2 definitions against real games, replay Marey's triple-double and a 24-0 run

The moment fixtures hold real games where the event quarter scores equal the official ones, with
the running score per event; the web engine's final values must equal every row the Python side
produces (win margin, bench points, clubs, fastest times, bursts, runs). The frequency harness now
replays phase 1 and phase 2 together.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: B — 통산 평균 순위(`avg` 목표)

**Files:**
- Modify: `courtside-web/lib/milestones.ts`, `courtside-web/lib/milestones.test.ts`, `courtside-web/lib/careerMarks.ts`, `courtside-web/lib/careerMarks.test.ts`

**Interfaces:**
- Produces: `MilestoneTarget`에 `{ kind: "avg"; cat; scope: "all" | "active"; rank; need; rival: { pcode; name; avg }; activeRank? }`, `NEAR.avg`, `AVG_MIN_GP = 300`, `AVG_CATS`, `AVG_RANK_CAP = { all: 20, active: 10 }`(careerMarks.ts에서 export), `buildMilestoneContext`가 정규시즌 경기에서 평균 목표를 `targets`에 더한다.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- edit: courtside-web/lib/careerMarks.test.ts -->
<!-- old -->
~~~typescript
import { buildMilestoneContext, type DeltaGame, type Snapshot } from "./careerMarks";
~~~
<!-- new -->
~~~typescript
import { AVG_MIN_GP, buildMilestoneContext, type DeltaGame, type Snapshot } from "./careerMarks";
~~~

<!-- edit: courtside-web/lib/careerMarks.test.ts -->
<!-- old -->
~~~typescript
describe("buildMilestoneContext - 경기 수", () => {
~~~
<!-- new -->
~~~typescript
// 통산 평균 득점표(정규리그, 300경기): A 22.0 · B 20.0 · C 19.0(현역) · D 18.5. 나(M)는 299경기 5,660점(18.93) - 오늘 뛰면 300경기가 된다.
const avgPlayers = (me: { total: number; gp: number }): Snapshot["players"] => ({
  A: { n: "에이", a: 0, reg: [6600, 0, 0, 0, 0, 0, 300], po: [0, 0, 0, 0, 0, 0, 0], hi: null },
  B: { n: "비", a: 0, reg: [6000, 0, 0, 0, 0, 0, 300], po: [0, 0, 0, 0, 0, 0, 0], hi: null },
  C: { n: "씨", a: 1, reg: [5700, 0, 0, 0, 0, 0, 300], po: [0, 0, 0, 0, 0, 0, 0], hi: null },
  D: { n: "디", a: 1, reg: [5550, 0, 0, 0, 0, 0, 300], po: [0, 0, 0, 0, 0, 0, 0], hi: null },
  M: { n: "나", a: 1, reg: [me.total, 0, 0, 0, 0, 0, me.gp], po: [0, 0, 0, 0, 0, 0, 0], hi: null },
});
const avgCtx = (me: { total: number; gp: number }, split: "regular" | "playoffs" = "regular") =>
  buildMilestoneContext({ snapshot: { asOf: "2026-10-06", recentFrom: "2026-09-15", recentGmkeys: [], players: avgPlayers(me) }, games: [], gameDate: "2026-10-07", split, players: [{ pcode: "M", name: "나" }] });
const avgTargets = (ctx: ReturnType<typeof buildMilestoneContext>) => (ctx.players.M?.targets ?? []).filter((t) => t.kind === "avg");

describe("buildMilestoneContext - 통산 평균 순위(avg)", () => {
  it("앞선 선수의 평균을 엄밀히 넘으려면 필요한 한 경기 값(정수 계산)과 넘은 뒤 순위", () => {
    // C(5700/300 = 19.0)를 넘으려면 (5660 + x)/300 > 19.0 -> x > 40 -> 41점. 더 위(B 20.0)는 341점이라 한 경기에 못 닿는다.
    const t = avgTargets(avgCtx({ total: 5660, gp: 299 }));
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: "avg", cat: "pts", scope: "all", need: 41, rank: 3, rival: { pcode: "C", name: "씨", avg: 19 }, activeRank: 1 });
  });
  it("정확히 같은 평균은 추월이 아니다(경계)", () => {
    // 5699 + 1 = 5700 -> 19.0 == C. 한 점 더(2점)여야 넘는다.
    expect(avgTargets(avgCtx({ total: 5699, gp: 299 }))[0]).toMatchObject({ need: 2, rival: { pcode: "C" } });
  });
  it("자격: 이 경기를 포함해 300경기 미만이면 목표가 없고, 정규시즌이 아니면 만들지 않는다", () => {
    expect(AVG_MIN_GP).toBe(300);
    expect(avgTargets(avgCtx({ total: 5000, gp: 298 }))).toEqual([]);
    expect(avgTargets(avgCtx({ total: 5660, gp: 299 }, "playoffs"))).toEqual([]);
  });
  it("이미 앞선 선수는 목표가 아니고, 순위표 자격이 없는(299경기) 선수는 rival이 아니다", () => {
    const snap: Snapshot = { asOf: "2026-10-06", recentFrom: "2026-09-15", recentGmkeys: [], players: { ...avgPlayers({ total: 6700, gp: 299 }), Z: { n: "제트", a: 0, reg: [6900, 0, 0, 0, 0, 0, 299], po: [0, 0, 0, 0, 0, 0, 0], hi: null } } };
    const ctx = buildMilestoneContext({ snapshot: snap, games: [], gameDate: "2026-10-07", split: "regular", players: [{ pcode: "M", name: "나" }] });
    expect((ctx.players.M?.targets ?? []).filter((t) => t.kind === "avg")).toEqual([]);     // M(22.4)이 A(22.0)보다도 앞, Z는 299경기라 순위표에 없다
  });
});

describe("buildMilestoneContext - 경기 수", () => {
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/careerMarks.test.ts`

Expected: FAIL — `AVG_MIN_GP`가 export되지 않았다.

- [ ] **Step 3: 구현 — milestones.ts**

<!-- edit: courtside-web/lib/milestones.ts -->
<!-- old -->
~~~typescript
export const NEAR: Record<"rank" | "step" | "high", Record<MilestoneCat, number>> = {
  rank: { pts: 10, reb: 6, ast: 5, stl: 3, blk: 3, threep: 3 },
~~~
<!-- new -->
~~~typescript
export const NEAR: Record<"rank" | "step" | "high" | "avg", Record<MilestoneCat, number>> = {
  avg: { pts: 10, reb: 6, ast: 5, stl: 3, blk: 3, threep: 3 },
  rank: { pts: 10, reb: 6, ast: 5, stl: 3, blk: 3, threep: 3 },
~~~

<!-- edit: courtside-web/lib/milestones.ts -->
<!-- old -->
~~~typescript
  /** 한 경기 커리어 하이(high). 같으면 타이, 넘으면 경신. */
  | { kind: "high"; cat: MilestoneCat; high: number };
~~~
<!-- new -->
~~~typescript
  /** 한 경기 커리어 하이(high). 같으면 타이, 넘으면 경신. */
  | { kind: "high"; cat: MilestoneCat; high: number }
  /**
   * 통산 평균 순위 돌파(정규리그, 300경기 이상) - 이 경기에서 `need` 이상을 기록하면 평균이 앞선 rival의 평균을 엄밀히 넘어 `rank`위가 된다.
   * 평균은 경기 중 오르내리므로 "지금 평균"이 아니라 이 경기 한 번의 값(need)으로 판정한다(basis game). rival.avg = 그 선수의 통산 평균.
   */
  | { kind: "avg"; cat: MilestoneCat; scope: "all" | "active"; rank: number; need: number; rival: { pcode: string; name: string; avg: number }; activeRank?: number };
~~~

<!-- edit: courtside-web/lib/milestones.ts -->
<!-- old -->
~~~typescript
export function significance(t: MilestoneTarget): number {
  return t.kind === "step" ? 0 : t.kind === "high" ? 1_000 : 2_000 + (t.scope === "all" ? t.rank : t.rank * 2);
}
~~~
<!-- new -->
~~~typescript
export function significance(t: MilestoneTarget): number {
  if (t.kind === "step") return 0;
  if (t.kind === "high") return 1_000;
  return (t.kind === "avg" ? 1_500 : 2_000) + (t.scope === "all" ? t.rank : t.rank * 2);
}
~~~

<!-- edit: courtside-web/lib/milestones.ts -->
<!-- old -->
~~~typescript
function checksOf(pcode: string, p: MilestonePlayer): Check[] {
  return p.targets.flatMap((t, i): Check[] =>
    t.kind === "high"
      ? [
          { id: `${pcode}:${i}:tie`, target: t, cat: t.cat, at: t.high, basis: "game", variant: "tie" },
          { id: `${pcode}:${i}:break`, target: t, cat: t.cat, at: t.high + 1, basis: "game", variant: "break" },
        ]
      : [{ id: `${pcode}:${i}`, target: t, cat: t.cat, at: t.at, basis: "career" }]
  );
}
~~~
<!-- new -->
~~~typescript
function checksOf(pcode: string, p: MilestonePlayer): Check[] {
  return p.targets.flatMap((t, i): Check[] => {
    if (t.kind === "high") {
      return [
        { id: `${pcode}:${i}:tie`, target: t, cat: t.cat, at: t.high, basis: "game", variant: "tie" },
        { id: `${pcode}:${i}:break`, target: t, cat: t.cat, at: t.high + 1, basis: "game", variant: "break" },
      ];
    }
    if (t.kind === "avg") return [{ id: `${pcode}:${i}`, target: t, cat: t.cat, at: t.need, basis: "game" }];
    return [{ id: `${pcode}:${i}`, target: t, cat: t.cat, at: t.at, basis: "career" }];
  });
}
~~~

<!-- edit: courtside-web/lib/milestones.ts -->
<!-- old -->
~~~typescript
  const today = `오늘 ${g[c.cat]}${cat.unit}째`;
  if (t.kind === "rank") {
~~~
<!-- new -->
~~~typescript
  const today = `오늘 ${g[c.cat]}${cat.unit}째`;
  if (t.kind === "avg") {
    const scope = t.scope === "all" ? "올타임" : "현역";
    const active = t.activeRank != null ? ` · 현역 ${t.activeRank}위` : "";
    const rival = `기존 ${t.rank}위 ${t.rival.name}(${t.rival.avg.toFixed(2)}${cat.unit})`;
    if (phase === "done") {
      const after = (p.before[c.cat] + g[c.cat]) / ((p.gp ?? 0) + 1);
      const by = cat.unit === "점" ? "으로" : "로";
      return { text: `통산 평균 ${cat.name} ${after.toFixed(2)}${cat.unit}${by} 올라 ${scope} ${t.rank}위 진입${active}`, detail: `${rival} 추월 · 오늘 ${g[c.cat]}${cat.unit}` };
    }
    return { text: `${remaining}${cat.unit}만 더 ${cat.verb} 통산 평균 ${cat.name} ${scope} ${t.rank}위${active}`, detail: `${rival} · ${today}` };
  }
  if (t.kind === "rank") {
~~~

<!-- edit: courtside-web/lib/milestones.ts -->
<!-- old -->
~~~typescript
  const now = `현재 통산 ${fmt(p.before[t.cat])}${cat.unit}`;
  if (t.kind === "rank") {
~~~
<!-- new -->
~~~typescript
  const now = `현재 통산 ${fmt(p.before[t.cat])}${cat.unit}`;
  if (t.kind === "avg") {
    const scope = t.scope === "all" ? "올타임" : "현역";
    const active = t.activeRank != null ? `(현역 ${t.activeRank}위)` : "";
    const avgNow = p.gp ? (p.before[t.cat] / p.gp).toFixed(2) : "-";
    return {
      ...base,
      text: `${ask} 통산 평균 ${cat.name} ${scope} ${t.rank}위${active}에 오른다`,
      detail: `기존 ${t.rank}위 ${t.rival.name}(${t.rival.avg.toFixed(2)}${cat.unit}) 추월 · 현재 평균 ${avgNow}${cat.unit}`,
    };
  }
  if (t.kind === "rank") {
~~~

<!-- edit: courtside-web/lib/milestones.ts -->
<!-- old -->
~~~typescript
      const need = t.kind === "high" ? t.high + 1 : t.at - p.before[t.cat];
      if (need < 1 || need > reachOf(t.cat, p)) return;
      const key = `${t.cat}:${t.kind}:${t.kind === "rank" ? t.scope : ""}`;
~~~
<!-- new -->
~~~typescript
      const need = t.kind === "high" ? t.high + 1 : t.kind === "avg" ? t.need : t.at - p.before[t.cat];
      if (need < 1 || need > reachOf(t.cat, p)) return;
      const key = `${t.cat}:${t.kind}:${t.kind === "rank" || t.kind === "avg" ? t.scope : ""}`;
~~~

- [ ] **Step 4: 구현 — careerMarks.ts**

<!-- edit: courtside-web/lib/careerMarks.ts -->
<!-- old -->
~~~typescript
/** 스냅샷 기준일과 이 경기 날짜가 이보다 벌어지면 보정할 경기가 너무 많아져 기능을 끈다. */
~~~
<!-- new -->
~~~typescript
/** 통산 평균 순위(2단계 B) - 정규리그 이 경기 포함 300경기 이상만 순위표에 넣고, 올타임 TOP20·현역 TOP10까지 목표를 만든다(상수라 바꾸기 쉽다). */
export const AVG_MIN_GP = 300;
export const AVG_CATS = ["pts", "reb", "ast", "stl", "blk"] as const;
export const AVG_RANK_CAP = { all: 20, active: 10 } as const;

/** 스냅샷 기준일과 이 경기 날짜가 이보다 벌어지면 보정할 경기가 너무 많아져 기능을 끈다. */
~~~

<!-- edit: courtside-web/lib/careerMarks.ts -->
<!-- old -->
~~~typescript
/** 이 값을 가진 선수의 순위 = 그보다 큰 값을 가진 선수 수 + 1(동률은 같은 순위). list는 값 오름차순. */
~~~
<!-- new -->
~~~typescript
type AvgEntry = { pcode: string; name: string; total: number; gp: number; active: boolean };
/** a의 평균이 b의 평균보다 큰 정도의 부호 - total/gp를 나누지 않는 교차곱(정수)이라 동률 판정이 정확하다. */
const avgCmp = (a: AvgEntry, b: AvgEntry) => a.total * b.gp - b.total * a.gp;

/**
 * 한 부문의 통산 평균 순위 돌파 목표. me는 오늘 뛰면 (total + x)/(gp + 1)이 되는 선수 - 앞선 선수(rival)를 엄밀히 넘는 가장 작은 x(need)와
 * 넘은 뒤 순위(rival보다 평균이 엄밀히 큰 다른 선수 수 + 1)를 낸다. 오늘 0을 기록해도 이미 넘는 rival(need <= 0)은 건너뛰고,
 * need가 한 경기 현실 한도(MAX_GAIN)를 넘으면 거기서 멈춘다.
 */
function avgTargetsFor(cat: MilestoneCat, me: { pcode: string; total: number; gp: number }, entries: AvgEntry[], scope: "all" | "active"): Extract<MilestoneTarget, { kind: "avg" }>[] {
  const others = entries.filter((e) => e.pcode !== me.pcode && (scope === "all" || e.active)).sort((x, y) => avgCmp(x, y));
  const found: Extract<MilestoneTarget, { kind: "avg" }>[] = [];
  for (const q of others) {
    const num = q.total * (me.gp + 1);
    const need = (num - (num % q.gp)) / q.gp - me.total + 1; // floor(q.total*(gp+1)/q.gp) - total + 1 - 정수 나눗셈
    if (need <= 0) continue; // 오늘 0을 기록해도 이미 넘는다(그 rival은 한참 아래) - 목표가 아니다
    if (need > MAX_GAIN[cat]) break; // others가 평균 오름차순이라 need도 늘어난다
    const rank = others.filter((o) => avgCmp(o, q) > 0).length + 1;
    if (rank > AVG_RANK_CAP[scope]) continue;
    const t = { kind: "avg" as const, cat, scope, rank, need, rival: { pcode: q.pcode, name: q.name, avg: q.total / q.gp } };
    // 필요량이 같으면 더 높은 평균의 rival을 넘는 목표가 이긴다(그 값이면 아래 rival도 함께 넘는다).
    if (found.length && found[found.length - 1].need === need) found[found.length - 1] = t;
    else found.push(t);
  }
  return found;
}

/** 이 값을 가진 선수의 순위 = 그보다 큰 값을 가진 선수 수 + 1(동률은 같은 순위). list는 값 오름차순. */
~~~

<!-- edit: courtside-web/lib/careerMarks.ts -->
<!-- old -->
~~~typescript
  // ponytail: 아래 순위 목표는 (경기 선수 × 부문 × 범위)마다 board 전체를 훑고 후보마다 rankOf로 또 훑는다 - 역대 선수 수 N에 거의 N².
~~~
<!-- new -->
~~~typescript
  // 통산 평균 순위표 - 정규시즌 경기에서만(플레이오프는 평균 목표 없음), 이 경기 직전 기준 300경기 이상.
  const avgEntries = (cat: MilestoneCat): AvgEntry[] =>
    split !== "regular"
      ? []
      : [...adj.entries()]
          .filter(([, a]) => a.totals[6] >= AVG_MIN_GP && a.totals[CAT_INDEX[cat]] > 0)
          .map(([pcode, a]) => ({ pcode, name: a.name, total: a.totals[CAT_INDEX[cat]], gp: a.totals[6], active: a.active }));
  const avgBoards = Object.fromEntries(AVG_CATS.map((cat) => [cat, avgEntries(cat)])) as Record<(typeof AVG_CATS)[number], AvgEntry[]>;

  // ponytail: 아래 순위 목표는 (경기 선수 × 부문 × 범위)마다 board 전체를 훑고 후보마다 rankOf로 또 훑는다 - 역대 선수 수 N에 거의 N².
~~~

<!-- edit: courtside-web/lib/careerMarks.ts -->
<!-- old -->
~~~typescript
    if (targets.length) out[p.pcode] = { name: a.name, ...(p.tcode ? { tcode: p.tcode } : {}), gp: a.totals[6], before, targets };
~~~
<!-- new -->
~~~typescript
    // 통산 평균 순위 - 오늘 뛰면 이 경기를 포함해 300경기 이상이 되는 선수만. 올타임 목표에 같은 rival을 현역에서도 넘으면 한 줄로 합친다.
    if (split === "regular" && a.totals[6] + 1 >= AVG_MIN_GP) {
      for (const cat of AVG_CATS) {
        const me = { pcode: p.pcode, total: a.totals[CAT_INDEX[cat]], gp: a.totals[6] };
        const allT = avgTargetsFor(cat, me, avgBoards[cat], "all");
        const activeT = avgTargetsFor(cat, me, avgBoards[cat], "active");
        for (const t of allT) {
          const twin = activeT.find((x) => x.rival.pcode === t.rival.pcode);
          targets.push(twin ? { ...t, activeRank: twin.rank } : t);
        }
        for (const t of activeT) if (!allT.some((x) => x.rival.pcode === t.rival.pcode)) targets.push(t);
      }
    }
    if (targets.length) out[p.pcode] = { name: a.name, ...(p.tcode ? { tcode: p.tcode } : {}), gp: a.totals[6], before, targets };
~~~

- [ ] **Step 5: milestones 단위 테스트 추가(문구·경기 중 판정·경기 전 도전)**

<!-- edit: courtside-web/lib/milestones.test.ts -->
<!-- old -->
~~~typescript
describe("evaluateApproaching", () => {
~~~
<!-- new -->
~~~typescript
describe("통산 평균 순위(avg) 목표", () => {
  const avgPlayer = (): MilestoneContext["players"][string] => ({
    name: "김선형", gp: 299, before: { pts: 5660, reb: 0, ast: 0, stl: 0, blk: 0, threep: 0 },
    targets: [{ kind: "avg", cat: "pts", scope: "all", rank: 3, need: 41, rival: { pcode: "C", name: "씨", avg: 19 }, activeRank: 1 }],
  });
  const avgCtx: MilestoneContext = { split: "regular", asOf: "2026-10-06", players: { P: avgPlayer() } };
  it("need 이상을 기록하는 순간 '통산 평균 득점 N점으로 올라 올타임 3위 진입'(done), 직전엔 임박(near)", () => {
    const ev = (code: string, i: number) => ({ pcode: "P", action_code: code, quarter: "Q4", clock_min: 9, clock_sec: 50 - i });
    const events = [...Array.from({ length: 20 }, (_, i) => ev("201", i)), ev("203", 20)];
    const m = buildMilestoneTimeline(avgCtx, events);
    const done = m.filter((x) => x.phase === "done");
    expect(done).toHaveLength(1);
    expect(done[0].text).toBe("통산 평균 득점 19.00점으로 올라 올타임 3위 진입 · 현역 1위");
    expect(done[0].detail).toBe("기존 3위 씨(19.00점) 추월 · 오늘 41점");
    const near = m.find((x) => x.phase === "near");
    expect(near?.text).toBe("9점만 더 넣으면 통산 평균 득점 올타임 3위 · 현역 1위");        // 임박 구간(남은 10점 이내)에 처음 든 순간은 32점째 - 남은 9점
  });
  it("경기 전 '기록 도전': 41점은 평균 18.9 x 1.7 = 32 > 30(cap)이라 닿지 않고, need가 작으면 문장으로", () => {
    expect(buildRecordChances(avgCtx)).toEqual([]);
    const near: MilestoneContext = { ...avgCtx, players: { P: { ...avgPlayer(), targets: [{ kind: "avg", cat: "pts", scope: "all", rank: 3, need: 12, rival: { pcode: "C", name: "씨", avg: 19 } }] } } };
    const [c] = buildRecordChances(near);
    expect(c).toMatchObject({ kind: "avg", need: 12, text: "12점 이상 넣으면 통산 평균 득점 올타임 3위에 오른다", detail: "기존 3위 씨(19.00점) 추월 · 현재 평균 18.93점" });
  });
  it("중요도는 통산 합계 순위 돌파보다 위, 커리어 하이보다 아래", () => {
    const avg = significance({ kind: "avg", cat: "pts", scope: "all", rank: 3, need: 5, rival: { pcode: "x", name: "x", avg: 1 } });
    expect(avg).toBeGreaterThan(significance({ kind: "high", cat: "pts", high: 20 }));
    expect(avg).toBeLessThan(significance({ kind: "rank", cat: "pts", scope: "all", at: 10, rank: 1, rival: { pcode: "x", name: "x", value: 1 } }));
  });
});

describe("evaluateApproaching", () => {
~~~

- [ ] **Step 6: 통과 확인**

Run: `cd courtside-web && head -12 lib/milestones.test.ts` 로 import 줄을 보고, 위 새 테스트가 쓰는 이름(`buildMilestoneTimeline`, `buildRecordChances`, `significance`, `MilestoneContext`)이 import에 없으면 추가한 뒤:

```bash
npx vitest run lib/careerMarks.test.ts lib/milestones.test.ts lib/postgameReport.test.ts components/MilestoneWatch.test.tsx
npx tsc --noEmit
npx eslint lib/milestones.ts lib/careerMarks.ts
```

Expected: 통과, `tsc`·`eslint` 출력 없음. `tsc`가 `kind` 분기 누락을 지적하면 그 자리에 `avg` 처리를 더한다(`MilestoneWatch`·리포트는 `kind`와 무관하게 `text`/`detail`을 그리므로 보통 없다).

- [ ] **Step 7: 커밋**

```bash
git add courtside-web/lib/milestones.ts courtside-web/lib/milestones.test.ts courtside-web/lib/careerMarks.ts courtside-web/lib/careerMarks.test.ts
git commit -m "$(cat <<'EOF'
feat(web): career-average rank targets in the record watch (points, rebounds, assists, steals, blocks)

For regular-season games, a player with 300+ games after tonight gets targets 'score N or more and
your career average passes X (all-time rank k)'. The needed amount comes from exact integer
cross-multiplication (an equal average is not an overtake); the existing panel, toasts, pre-game
'record chances' and post-game 'records' pick the new kind up through the same text/detail fields.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 문서·스펙 보정·전체 확인

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-10-record-book-phase2-design.md`

- [ ] **Step 1: README 운영 런북에 2단계 항목**

<!-- edit: README.md -->
<!-- old -->
~~~text
- 이벤트는 옛 경기(2006~09)에서 공식 기록과 어긋난다(김승현 2007-03-23 공식 11어시스트, 이벤트 15개) - 이벤트 기반 보드는 공식 쿼터 점수·박스 합계와 대조를
  통과한 경기만 쓴다. 이 검증 때문에 "기록을 놓칠 수는 있어도 틀린 기록은 안 만든다".
~~~
<!-- new -->
~~~text
- 이벤트는 옛 경기(2006~09)에서 공식 기록과 어긋난다(김승현 2007-03-23 공식 11어시스트, 이벤트 15개) - 이벤트 기반 보드는 공식 쿼터 점수·박스 합계와 대조를
  통과한 경기만 쓴다. 이 검증 때문에 "기록을 놓칠 수는 있어도 틀린 기록은 안 만든다".
- **2단계(2026-10-10, 설계 `docs/superpowers/specs/2026-10-10-record-book-phase2-design.md`)** - 같은 테이블에 순간 기록 14개 보드: 점수차(`tg.margin.max`), 벤치 득점·무득점 리바/어시,
  트리플더블/쿼드러플더블/5x5 클럽(달성 경기마다 한 행), 최단 시간 더블더블/트리플더블/5반칙 퇴장(코트 출전 초), 10/35/60초 득점, 팀 연속 득점 런.
  코트 출전 시간은 101/102 교체 이벤트를 합산해 **모든 선수의 공식 출전 시간과 ±3초 일치**할 때만 쓰고, 초 단위 보드(N초 득점·런)는 **2017-18시즌(S31) 이후 자료만**
  쓴다(그 전은 같은 초에 득점이 여러 개 찍혀 가짜 기록이 나온다). `record_book.py`는 정산마다 새 프로세스라 코드를 고쳐도 수집기 재시작은 필요 없다.
  보드를 더하거나 정의를 고친 뒤에는 `python record_book.py --rebuild`(DB 쓰기)로 테이블을 다시 채우고 `--verify`로 확인한다.
  통산 평균 순위(득점·리바운드·어시스트·스틸·블록, 정규리그 300경기 이상, 올타임 TOP20·현역 TOP10)는 테이블이 아니라 통산 스냅샷(`career_marks.json`)으로 웹이 계산한다.
~~~

- [ ] **Step 2: 스펙 보정(구현에서 확정된 사항)**

<!-- edit: docs/superpowers/specs/2026-10-10-record-book-phase2-design.md -->
<!-- old -->
~~~text
`RecordMoment`에 선택 필드 `club?: true`를 추가하고 `recordToast`는 클럽이면 제목을 `🏅 트리플더블!`처럼 낸다(타이/신기록 문구 아님).
~~~
<!-- new -->
~~~text
`RecordMoment`에 선택 필드 `club?: string`(클럽 이름)을 추가하고 `recordToast`는 클럽이면 제목을 `🏅 트리플더블 달성!`처럼 낸다(타이/신기록 문구 아님).
`records.ts`가 새 모듈을 불러오면 순환 import가 되므로 1단계와 2단계는 `buildAllRecordMoments`(lib/recordsMoments.ts)가 합친다 - GameReplay와 리포트는 이 함수를 쓴다.
~~~

- [ ] **Step 3: 전체 확인**

Run:

```bash
cd courtside-web
npx tsc --noEmit
npx eslint lib components app --quiet
npx vitest run
cd ../tools
PYTHONIOENCODING=utf-8 "$PY" test_record_book.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_hook.py
cd ..
```

Expected: `tsc` 출력 없음, `eslint` 에러 0, vitest 전체 통과(건너뜀 포함), 파이썬 테스트 전부 `실패 없음.`

- [ ] **Step 4: 빈도 실측 결과를 스펙 §7에 기록**

Task 7 Step 5에서 잰 값이 리허설과 다르면 아래 문장의 숫자를 그 값으로 고쳐 적용한다.

<!-- edit: docs/superpowers/specs/2026-10-10-record-book-phase2-design.md -->
<!-- old -->
~~~text
평균 > 1개 또는 상위 5% > 3개이면 신기록/타이/5위까지만 토스트로 하고 나머지는 패널 전용으로 줄인다(보드별로 가장 시끄러운 쪽부터 — 예상: 10초 창 공동 3위 6점).
~~~
<!-- new -->
~~~text
평균 > 1개 또는 상위 5% > 3개이면 신기록/타이/5위까지만 토스트로 하고 나머지는 패널 전용으로 줄인다(보드별로 가장 시끄러운 쪽부터 — 예상: 10초 창 공동 3위 6점).
  - **실측(2026-10-10, 2025-26 270경기, 1·2단계 합산)**: 경기당 평균 0.65개(1단계만 0.55), 중앙값 0, p90 2, p95 3, 최대 24개(허웅 51점·3점슛 14개 경기), 1개 이상 93경기, 3개 이상 15경기.
    가장 많은 보드는 1단계 `pq.tpm.max`(21건), 2단계는 트리플더블 클럽 8건 등. 평균 ≤ 1, p95 ≤ 3을 만족하므로 **전부 토스트 유지**로 확정한다.
~~~

- [ ] **Step 5: 커밋**

```bash
git add README.md docs/superpowers/specs/2026-10-10-record-book-phase2-design.md docs/superpowers/plans/2026-10-10-record-book-phase2.md
git commit -m "$(cat <<'EOF'
docs(records): phase 2 runbook, spec adjustments and the implementation plan

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 새 보드 적재 · 검증 (**사용자 확인 필요 - 운영 DB 쓰기**)

**Files:** (코드 변경 없음 - 운영 작업)

**먼저 사용자에게 확인한다**: "`record_entries`를 새 14개 보드까지 포함해 전체 다시 채웁니다(`record_book.py --rebuild`, 기존 1단계 행 2,773개도 같은 계산으로 교체 - 한 트랜잭션, 다른 테이블 영향 없음, 롤백은 `DELETE FROM record_entries WHERE board IN (<새 14개>)` 또는 이전 코드로 `--rebuild`). 진행할까요?"

- [ ] **Step 1: 사전 점검(DB 읽기만)**

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild --dry-run
```

Expected: `보관 행 N개`(약 3,200±) 와 `최대 M행`이 `MAX_ROWS`(20,000) 안.

- [ ] **Step 2: 적재**

```bash
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild
```

Expected: `교체 완료: N행`, `[revalidate] 1개 태그 무효화: ['records']`.

- [ ] **Step 3: 검증과 멱등성**

```bash
PYTHONIOENCODING=utf-8 "$PY" record_book.py --verify
PYTHONIOENCODING=utf-8 "$PY" record_book.py --gmkeys S49G01N9
PYTHONIOENCODING=utf-8 "$PY" record_book.py --gmkeys S49G01N9
PYTHONIOENCODING=utf-8 "$PY" record_book.py --verify
cd ..
```

Expected: `--verify` 두 번 모두 `없는 행 0 / 남는 행 0 / 값이 다른 행 0`, `--gmkeys` 두 번의 `{'candidates': ..., 'pruned': ..., 'boards': ...}`가 같다.

- [ ] **Step 4: 새 보드 상위 행 확인**

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" -c "import sys; sys.path.insert(0, '.'); from sync_upcoming_games import get_conn; c = get_conn(); cur = c.cursor(); cur.execute(\"select board, count(*), min(value), max(value) from record_entries where board in ('tg.margin.max','pg.benchpts.max','pg.nopts_reb.max','pg.nopts_ast.max','pg.club_td.max','pg.club_qd.max','pg.club_x5.max','pg.dd_time.min','pg.td_time.min','pg.foul5_time.min','pg.burst10.max','pg.burst35.max','pg.burst60.max','tg.run.max') group by board order by board\"); [print(r) for r in cur.fetchall()]"
cd ..
```

Expected: 14개 보드 중 `pg.club_qd.max`를 뺀 13개가 행을 가진다(쿼드러플더블은 역사에 없음), `pg.club_td.max` 행 수 78, `tg.margin.max` 최대 56, `pg.dd_time.min` 최소 465.

---

### Task 11: 배포와 프로덕션 검증 (**푸시 전 사용자 확인 필요**)

**Files:** (코드 변경 없음)

**먼저 사용자에게 확인한다**: "로컬 커밋 N개(Task 1~9)를 `main`에 푸시합니다. Vercel이 courtside-web을 배포합니다. 진행할까요?" (진행 중인 경기가 있으면 경기 끝난 뒤를 권한다.)

- [ ] **Step 1: 푸시 전 최종 확인**

```bash
git fetch origin && git status -sb | head -3
cd courtside-web && npx tsc --noEmit && npx eslint lib components app --quiet && npx vitest run && cd ..
```

Expected: 로컬이 `origin/main`보다 앞서 있기만 하고(뒤처졌으면 `git pull --rebase`), 모든 검사 통과.

- [ ] **Step 2: 푸시와 배포 대기**

```bash
git push origin main
gh api repos/onnebang/kbl_realdata/commits/$(git rev-parse --short HEAD)/status --jq '[.statuses[] | {context, state}]'
```

`Vercel – courtside-web`이 `success`가 될 때까지 확인한다(`Vercel – kbl-realdata` 실패는 기존 증상).

- [ ] **Step 3: 프로덕션 확인**

```bash
curl -s --compressed "https://courtside-web-ten.vercel.app/games/S49G01N9" -o "$SP/s49g01n9.html"
grep -c "Application error" "$SP/s49g01n9.html"
grep -o "1쿼터 어시스트 9개 KBL 신기록(종전 8개 · [^)]*)" "$SP/s49g01n9.html" | head -1
for g in S49G01N8 S49G01N10 S49G01N13; do curl -s -o /dev/null -w "$g %{http_code} %{time_total}s\n" --compressed "https://courtside-web-ten.vercel.app/games/$g"; done
```

Expected: `Application error` 0, 1단계 문구 그대로, 모든 경기 200 · 응답시간이 이전과 비슷(종료 경기 1.2~1.7초). 2단계 문구는 이 경기에 해당 기록이 있는 경기에서만 보인다 — 다음 실제 경기(정산 후)에 `record_book.py -> exit 0`과 리포트 "역대 기록"에 새 항목이 있는지 확인하고, 라이브 중 패널·토스트는 눈으로 본다(코트 시간 기반 알림은 경기 중에만 나온다).

- [ ] **Step 4: 실패 시 롤백 순서**

웹 문제: 해당 커밋을 `git revert`(새 보드 행은 옛 웹이 무시하므로 DB는 그대로 둬도 된다). 파이썬 문제: `tools/record_book.py`를 이전 커밋으로 되돌려 `--rebuild`. DB 정리: `DELETE FROM record_entries WHERE board IN (<새 14개>)`.
