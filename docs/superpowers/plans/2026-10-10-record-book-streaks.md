# 역대 기록 3단계(연속 기록 C-1 + C-2) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 연속 출장(팀 경기 기준, 이적 이어감)과 경기 간·한 경기 안 연속 야투·3점·자유투 성공/실패를 역대 기록집에 더해 라이브 토스트·패널·경기 전 "기록 도전"·경기 후 리포트로 알린다.

**Architecture:** 파이썬 `tools/record_streaks.py`가 raw 전체를 날짜순으로 훑는 상태기계로 7개 보드 행(연속 하나당 한 행)과 최근 120일 로그(`record_streak_log`)를 만들고(정산 훅이 노트북에서 전체 재계산, 역사 자료가 없는 클라우드에서는 건너뜀), 한 경기 안 보드 6개는 기존 방식(`record_book.py` 선수-경기 후보)으로 만든다. 웹은 서버 `lib/recordStreaks.ts`가 보드·로그를 읽어 `StreakContext`를 만들고, 순수 엔진 `lib/streakMoments.ts`가 이벤트를 훑어 순간 기록을 뽑는다(`buildAllRecordMoments`가 1·2단계와 합친다).

**Tech Stack:** Python 3.11(venv, 테스트는 평범한 스크립트), TypeScript/Next.js 16 + vitest, Supabase Postgres.

**Spec:** `docs/superpowers/specs/2026-10-10-record-book-streaks-design.md` (이전 단계: `2026-10-08-record-book-design.md`, `2026-10-10-record-book-phase2-design.md`)

## Global Constraints

- 파이썬은 **반드시** `D:\영상작업\축구\개발\.venv\Scripts\python.exe`(Anaconda 금지). 테스트 실행은 `PYTHONIOENCODING=utf-8`.
- 메인 작업트리에서 수집기가 돈다: `tools/live_collector.py`·`tools/daily_batch.py`는 **건드리지 않는다**(이 계획은 `record_book.py`·`record_streaks.py`와 웹만 고친다). 브랜치 전환 금지.
- DB 쓰기(DDL 적용·`--rebuild`)와 `git push`는 각각 실행 직전에 사용자 확인을 받는다(Task 9·10). 로컬 커밋은 계획대로 한다. 커밋은 항상 명시한 경로만 `git add`(전체 add 금지).
- 옛 iOS Safari 대상 웹 코드: `.at()`, `.replaceAll()`, `aspect-ratio`, `??=` 같은 최신 문법을 클라이언트 번들 파일(`streakKinds.ts`, `streakMoments.ts`, `recordsMoments.ts`)에 쓰지 않는다.
- 클라이언트 번들 파일(`streakKinds.ts`, `streakMoments.ts`)은 서버 전용 모듈(`supabaseServer`, `cachePolicy`)을 import하지 않는다.
- 연속 출장 정의: 소속팀의 모든 경기(정규시즌+플레이오프·챔프전)에 출전(공식 출전 시간 > 0), 이적은 이어감(시즌 중 이적 = 새 팀이 마지막 출전 이후 치른 첫 경기에 뜀, 시즌을 넘는 이적 = 새 팀 그 시즌 첫 경기에 뜀).
- 슛 연속 게이트: 그 선수-경기의 그 종목 이벤트 시도·성공 수가 공식 박스와 같을 때만 믿는다; 탈락(또는 동명이인) 경기는 그 종목 연속을 끊는다.
- 사용자에게는 한국어로 보고한다.

---

### Task 1: 파이썬 — 한 경기 안 연속 슛 보드 6개

**Files:**
- Modify: `tools/record_book.py`
- Create: `tools/test_record_streaks.py`

**Interfaces:**
- Produces: `record_book.shot_sequences(g) -> (ok, bad)`(`ok = {pcode: {kind: [bool, ...]}}`, `bad = {pcode: {kind, ...}}`, kind ∈ fg|tp|ft), `record_book.single_shot_candidates(g)`, `SHOT_KINDS`, `SINGLE_BOARD`; 보드 `pg.sfg_made.max` `pg.sfg_miss.max` `pg.stp_made.max` `pg.stp_miss.max` `pg.sft_made.max` `pg.sft_miss.max`(bucket G, period "", 값 ≥ 5만).

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- create: tools/test_record_streaks.py -->
~~~python
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
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py`

Expected: 5개 모두 `AttributeError: module 'record_book' has no attribute 'shot_sequences'`로 FAIL.

- [ ] **Step 3: `record_book.py` 구현**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
def moment_candidates(g):
    """2단계 보드 전부 - 공식 보드는 늘, 이벤트 보드는 게이트 1을 통과한 경기만."""
    rows = official_moment_candidates(g)
    if quarters_match_official(g):
        rows += time_candidates(g) + burst_candidates(g) + run_candidates(g)
    return rows
~~~
<!-- new -->
~~~python
# 3단계 - 한 경기 안 연속 슛. 종목: fg(2점+3점 야투, 자유투 제외) / tp(3점) / ft(자유투). (성공 코드, 실패 코드, 공식 성공 열, 공식 시도 열)
SHOT_KINDS = {
    "fg": (("201", "205", "207"), ("202", "206", "208"), "fgt", "fgtA"),
    "tp": (("205",), ("206",), "threep", "threepA"),
    "ft": (("203",), ("204",), "ft", "ftA"),
}
SINGLE_BOARD = {
    ("fg", "made"): "pg.sfg_made.max", ("fg", "miss"): "pg.sfg_miss.max",
    ("tp", "made"): "pg.stp_made.max", ("tp", "miss"): "pg.stp_miss.max",
    ("ft", "made"): "pg.sft_made.max", ("ft", "miss"): "pg.sft_miss.max",
}
SINGLE_MIN = 5


def shot_sequences(g):
    """선수-경기의 슛 결과 순서 -> (ok, bad). ok = {pcode: {kind: [True(성공)/False(실패), ...]}} - 이벤트의 시도·성공 수가 공식 박스와 같은 (선수, 종목)만.
    bad = {pcode: {kind}} - 어긋났거나(또는 같은 팀 동명이인이라 이름으로 선수를 못 가린) 종목. 슛이 없는 선수도 공식 시도 0이면 빈 순서로 ok다."""
    idx = player_index(g)
    seqs = collections.defaultdict(lambda: collections.defaultdict(list))
    for e in ordered_events(g):
        a, name, tc = e.get("a"), e.get("p"), e.get("t")
        pcode = idx.get((name, tc)) if (a and name and tc) else None
        if not pcode:
            continue
        for kind, (mk, ms, _, _) in SHOT_KINDS.items():
            if a in mk:
                seqs[pcode][kind].append(True)
            elif a in ms:
                seqs[pcode][kind].append(False)
    ok, bad = {}, collections.defaultdict(set)
    for p in g["players"]:
        pcode = p["pcode"]
        if idx.get((p["pname"], p["tcode"])) != pcode:
            bad[pcode].update(SHOT_KINDS)
            continue
        for kind, (_, _, fm, fa) in SHOT_KINDS.items():
            seq = seqs[pcode][kind] if pcode in seqs else []
            made, att = p["rec"].get(fm), p["rec"].get(fa)
            if isinstance(made, int) and isinstance(att, int) and len(seq) == att and sum(seq) == made:
                ok.setdefault(pcode, {})[kind] = seq
            else:
                bad[pcode].add(kind)
    return ok, dict(bad)


def single_shot_candidates(g):
    """한 경기 안 최대 연속 성공/실패(종목별) - 선수-경기당 한 행. SINGLE_MIN(5) 미만은 후보가 아니다."""
    ok, _ = shot_sequences(g)
    by_pcode = {p["pcode"]: p for p in g["players"]}
    rows = []
    for pcode, kinds in ok.items():
        p = by_pcode[pcode]
        for kind, seq in kinds.items():
            run, best = {"made": 0, "miss": 0}, {"made": 0, "miss": 0}
            for s in seq:
                cur, oth = ("made", "miss") if s else ("miss", "made")
                run[cur] += 1
                run[oth] = 0
                best[cur] = max(best[cur], run[cur])
            for res, v in best.items():
                if v >= SINGLE_MIN:
                    rows.append(_row(g, SINGLE_BOARD[(kind, res)], "G", pcode, "", v, p["pname"], p["tcode"]))
    return rows


def moment_candidates(g):
    """2·3단계 선수-경기 보드 전부 - 공식 보드와 한 경기 안 연속 슛은 늘, 이벤트 보드는 게이트 1을 통과한 경기만."""
    rows = official_moment_candidates(g) + single_shot_candidates(g)
    if quarters_match_official(g):
        rows += time_candidates(g) + burst_candidates(g) + run_candidates(g)
    return rows
~~~

- [ ] **Step 4: 통과 확인**

Run:

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_hook.py
```

Expected: 모두 `실패 없음.`

- [ ] **Step 5: 커밋**

```bash
git add tools/record_book.py tools/test_record_streaks.py
git commit -m "$(cat <<'EOF'
feat(records): single-game consecutive made/missed field goals, threes and free throws (six boards)

shot_sequences rebuilds each player's shot order from the play-by-play and trusts a (player, kind)
only when attempts and makes equal the official box (99%+ of player-games); the best run per
game becomes a row once it reaches five.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 파이썬 — 연속 상태기계 `record_streaks.py` + 로그 테이블 DDL + 저장소 확장

**Files:**
- Create: `tools/record_streaks.py`, `tools/schema_record_streak_log.sql`, `tools/rollback_record_streak_log.sql`
- Modify: `tools/record_book.py`(MemoryStore·PgStore·diff_log), `tools/test_record_streaks.py`

**Interfaces:**
- Consumes: Task 1의 `shot_sequences`; `rb.player_index/_row/retain/played_seconds/season_number`
- Produces: `record_streaks.compute(games, keep_days=LOG_KEEP_DAYS) -> (rows, log)`, `build(raw_dir=None, keep=15, games=None) -> (retained_rows, log)`, `refresh(store, raw_dir=None, keep=15, games=None)`, `have_history(raw_dir=None)`, `iter_games(raw_dir=None)`, `STREAK_BOARDS`, `BOARD`, `KINDS`, `MIN_ROW`; 저장소 메서드 `replace_board_rows(boards, rows)`, `replace_log(rows)`, `all_log()`; `record_book.diff_log(expected, actual)`. 보드 행: `period`가 `A:<시작 gmkey>`(진행 중) 또는 `E:<시작 gmkey>`(끝남), gmkey = 연속의 마지막 경기, subject = pcode.

- [ ] **Step 1: DDL과 롤백**

<!-- create: tools/schema_record_streak_log.sql -->
~~~sql
-- 역대 기록(Record Book) 3단계 - 선수별 연속 상태 로그(최근 120일). 설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md §4
-- 적용: README "역대 기록" 런북 참고. 롤백: rollback_record_streak_log.sql.
-- 서버(서비스 키)와 DATABASE_URL 쓰기 스크립트(tools/record_book.py -> record_streaks.py)만 접근한다 - 정책을 만들지 않고 anon/authenticated 권한도 회수한다.
create table if not exists record_streak_log (
  gmkey       text    not null,
  pcode       text    not null,
  kind        text    not null,                 -- gp | xfg_made | xfg_miss | xtp_made | xtp_miss | xft_made | xft_miss
  before_len  integer not null,                 -- 그 경기 전 연속 길이
  after_len   integer not null,                 -- 그 경기 후 연속 길이(끝났으면 0)
  start_gmkey text    not null,                 -- 그 연속이 시작된 경기(끝난 경우엔 끝난 연속의 시작)
  game_date   date    not null,
  game_start  text    not null default '',      -- 'HH:MM'
  alive       boolean not null default false,   -- 이 행이 그 선수·종목의 최신 행이고 연속이 지금도 이어지는 중
  primary key (gmkey, pcode, kind)
);
create index if not exists record_streak_log_alive_idx on record_streak_log (pcode, kind) where alive;
alter table record_streak_log enable row level security;
revoke all on record_streak_log from anon, authenticated;
~~~

<!-- create: tools/rollback_record_streak_log.sql -->
~~~sql
-- 역대 기록 3단계 롤백 - record_streak_log를 지운다. 연속 보드 행은 따로: delete from record_entries where board in
-- ('pg.streak_gp.max','pg.xfg_made.max','pg.xfg_miss.max','pg.xtp_made.max','pg.xtp_miss.max','pg.xft_made.max','pg.xft_miss.max');
drop table if exists record_streak_log;
~~~

- [ ] **Step 2: 실패하는 테스트 작성**

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
if __name__ == "__main__":
    failed = 0
~~~
<!-- new -->
~~~python
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
~~~

- [ ] **Step 3: 실패 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py`

Expected: `ModuleNotFoundError: No module named 'record_streaks'`(파일 전체가 import에서 멈춘다).

- [ ] **Step 4: 저장소 확장**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
class MemoryStore:
    def __init__(self, rows=()):
        self._rows = {pk(r): dict(r) for r in rows}
~~~
<!-- new -->
~~~python
LOG_PK = ("gmkey", "pcode", "kind")
LOG_COLUMNS = ("gmkey", "pcode", "kind", "before_len", "after_len", "start_gmkey", "game_date", "game_start", "alive")
# 3단계 연속 보드(연속 출장·경기 간 연속 슛) - tools/record_streaks.py가 통째로 다시 계산해 교체한다. 경기 단위 반영(apply_game)은 이 행들을 지우거나 건드리지 않는다
# (gmkey가 '연속의 마지막 경기'라서 그 경기를 다시 정산할 때 같이 지워지면 클라우드처럼 역사 자료가 없는 곳에서는 복구할 수 없다).
STREAK_BOARDS = ("pg.streak_gp.max", "pg.xfg_made.max", "pg.xfg_miss.max", "pg.xtp_made.max", "pg.xtp_miss.max", "pg.xft_made.max", "pg.xft_miss.max")


class MemoryStore:
    def __init__(self, rows=()):
        self._rows = {pk(r): dict(r) for r in rows}
        self._log = {}
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
    def all_rows(self):
        return [dict(r) for r in self._rows.values()]
~~~
<!-- new -->
~~~python
    def all_rows(self):
        return [dict(r) for r in self._rows.values()]

    def replace_board_rows(self, boards, rows):
        """3단계 - 이 보드들의 행만 통째로 교체(다른 보드는 그대로)."""
        self._rows = {k: r for k, r in self._rows.items() if r["board"] not in boards}
        for r in rows:
            self._rows[pk(r)] = dict(r)

    def replace_log(self, rows):
        self._log = {tuple(r[c] for c in LOG_PK): dict(r) for r in rows}

    def all_log(self):
        return [dict(r) for r in self._log.values()]
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
    def delete_rows(self, rows):
        for r in rows:
            self.cur.execute("delete from record_entries where board = %s and bucket = %s and gmkey = %s and subject = %s and period = %s", pk(r))
~~~
<!-- new -->
~~~python
    def delete_rows(self, rows):
        for r in rows:
            self.cur.execute("delete from record_entries where board = %s and bucket = %s and gmkey = %s and subject = %s and period = %s", pk(r))

    def replace_board_rows(self, boards, rows):
        """3단계 - 이 보드들의 행만 통째로 교체(다른 보드는 그대로). 호출부가 한 트랜잭션으로 묶는다."""
        self.cur.execute("delete from record_entries where board = any(%s)", (list(boards),))
        self.upsert(rows)

    def replace_log(self, rows):
        self.cur.execute("delete from record_streak_log")
        if not rows:
            return
        from psycopg2.extras import execute_values
        execute_values(
            self.cur,
            f"insert into record_streak_log ({', '.join(LOG_COLUMNS)}) values %s",
            [tuple(r[c] for c in LOG_COLUMNS) for r in rows],
            page_size=1000,
        )

    def all_log(self):
        self.cur.execute(f"select {', '.join(LOG_COLUMNS)} from record_streak_log")
        rows = [dict(zip(LOG_COLUMNS, r)) for r in self.cur.fetchall()]
        for r in rows:
            r["game_date"] = r["game_date"].isoformat() if hasattr(r["game_date"], "isoformat") else str(r["game_date"])
        return rows
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
        gone = [k for k, r in self._rows.items() if r["gmkey"] == gmkey]
~~~
<!-- new -->
~~~python
        gone = [k for k, r in self._rows.items() if r["gmkey"] == gmkey and r["board"] not in STREAK_BOARDS]
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
        self.cur.execute("delete from record_entries where gmkey = %s returning board, bucket", (gmkey,))
~~~
<!-- new -->
~~~python
        self.cur.execute("delete from record_entries where gmkey = %s and not (board = any(%s)) returning board, bucket", (gmkey, list(STREAK_BOARDS)))
~~~

<!-- edit: tools/test_record_book.py -->
<!-- old -->
~~~python
    assert "delete from record_entries where gmkey = %s returning board, bucket" in cur2.statements[-1][0]
~~~
<!-- new -->
~~~python
    assert "delete from record_entries where gmkey = %s and not (board = any(%s)) returning board, bucket" in cur2.statements[-1][0]    # 3단계 연속 보드는 경기 단위 반영이 건드리지 않는다
    assert cur2.statements[-1][1] == ("G1", list(rb.STREAK_BOARDS))
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
~~~
<!-- new -->
~~~python
def diff_log(expected, actual):
    """--verify(3단계): 연속 상태 로그 비교 -> (없는 것, 남는 것, 값이 다른 것) - 키 = (gmkey, pcode, kind), 값 = 길이·alive·시작 경기."""
    def key(r):
        return tuple(r[c] for c in LOG_PK)

    def val(r):
        return (r["before_len"], r["after_len"], bool(r["alive"]), r["start_gmkey"])
    e, a = {key(r): val(r) for r in expected}, {key(r): val(r) for r in actual}
    return sorted(set(e) - set(a)), sorted(set(a) - set(e)), sorted(k for k in set(e) & set(a) if e[k] != a[k])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
~~~

- [ ] **Step 5: 상태기계 구현**

<!-- create: tools/record_streaks.py -->
~~~python
# -*- coding: utf-8 -*-
"""역대 기록(Record Book) 3단계 - 연속 기록: 연속 출장(gp)과 경기 간 연속 야투·3점·자유투 성공/실패.

설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md

raw/games 전체를 날짜·시작시각 순으로 훑는 상태기계다(정산이 순서 없이 와도 안 틀어지게 매번 전체를 다시 계산한다).
- 보드 행 7개(`BOARD`): 연속 하나당 한 행. period = 'A:<시작 gmkey>'(지금 이어지는 중) / 'E:<시작 gmkey>'(끝남), gmkey = 연속의 마지막 경기.
- 로그(record_streak_log): 최근 LOG_KEEP_DAYS일 경기의 (선수, 종류)별 전·후 길이와 alive 표시 - 웹이 "이 경기 직전 연속 상태"를 읽는다.
- 한 경기 안 연속 슛 6개 보드는 여기가 아니라 record_book.single_shot_candidates(선수-경기 후보)다.
역사 자료(raw/games)가 충분히 있을 때만 갱신한다(`have_history`) - 클라우드 수집기처럼 오늘 경기뿐인 환경이 부분 자료로 테이블을 덮어쓰지 못하게.
"""
import bisect
import collections
import datetime
import json
import os

import record_book as rb

KINDS = ("gp", "xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss")
BOARD = {
    "gp": "pg.streak_gp.max",
    "xfg_made": "pg.xfg_made.max", "xfg_miss": "pg.xfg_miss.max",
    "xtp_made": "pg.xtp_made.max", "xtp_miss": "pg.xtp_miss.max",
    "xft_made": "pg.xft_made.max", "xft_miss": "pg.xft_miss.max",
}
STREAK_BOARDS = rb.STREAK_BOARDS
MIN_ROW = 6               # 이보다 짧은 연속은 보드 행 후보가 아니다(보관 순위가 어차피 훨씬 높다)
LOG_KEEP_DAYS = 120       # 로그는 이 기간(최근 경기 날짜 기준)만
RAW_HISTORY_MIN = 5000    # raw/games에 이 수 이상의 경기 폴더가 있어야 전체 재계산을 한다
LOG_COLUMNS = rb.LOG_COLUMNS


def have_history(raw_dir=None):
    """전체 재계산을 할 만큼 raw 역사가 있는가(클라우드처럼 오늘 경기뿐이면 False)."""
    try:
        return len(os.listdir(raw_dir or rb.RAW_GAMES)) >= RAW_HISTORY_MIN
    except OSError:
        return False


def raw_order(raw_dir=None):
    """대상 경기(정규시즌·플레이오프·챔프전, 종료)의 gmkey를 (날짜, 시작시각, gmkey) 순으로."""
    raw_dir = raw_dir or rb.RAW_GAMES
    out = []
    for gmkey in os.listdir(raw_dir):
        try:
            with open(os.path.join(raw_dir, gmkey, "meta.json"), encoding="utf-8") as f:
                g = json.load(f)["game"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if g.get("seasonCategoryName") not in rb.ELIGIBLE_CATEGORIES or not g.get("isEnded"):
            continue
        out.append((str(g.get("gameDate")), str(g.get("gameStart") or ""), gmkey))
    return [k for _, _, k in sorted(out)]


def iter_games(raw_dir=None):
    """raw 경기를 날짜순으로 하나씩(이벤트 포함 - 한꺼번에 메모리에 올리지 않는다)."""
    raw_dir = raw_dir or rb.RAW_GAMES
    for gmkey in raw_order(raw_dir):
        g = rb.load_game(gmkey, raw_dir)
        if g is not None:
            yield g


def _continues(st, tc, n, season, team_games, season_first):
    """선수의 이전 출전(st)에서 이번 출전(팀 tc, 경기 번호 n; team_games[tc]의 마지막이 n)으로 연속이 이어지는가."""
    lst = team_games[tc]
    if st["tc"] == tc:
        return len(lst) >= 2 and lst[-2] == st["last"]                  # 같은 팀: 그 팀의 바로 다음 경기
    if st["season"] == season:
        return lst[bisect.bisect_right(lst, st["last"])] == n           # 시즌 중 이적: 마지막 출전 이후 새 팀의 첫 경기
    return season_first[(tc, season)] == n                               # 시즌을 넘는 이적: 새 팀의 그 시즌 첫 경기


def _new_run():
    return {"len": 0, "start": -1, "end": -1, "tc": ""}


def compute(games, keep_days=LOG_KEEP_DAYS):
    """날짜순 경기 dict iterable(이벤트 포함) -> (보드 행, 로그 행). 행은 아직 보관 순위로 자르지 않았다. keep_days=None이면 로그를 자르지 않는다(검증 픽스처용)."""
    team_games = collections.defaultdict(list)       # tcode -> [경기 번호]
    season_first = {}                                # (tcode, 시즌 번호) -> 그 팀 그 시즌 첫 경기 번호
    info = []                                        # 경기 번호 -> 가벼운 경기 정보
    names = {}
    gp = {}                                          # pcode -> {"len", "start", "last", "tc", "season"}
    runs = {}                                        # (pcode, kind) -> {"made": run, "miss": run}
    last_seen = {}                                   # pcode -> 마지막 출전 경기 번호
    rows, log = [], []
    latest_log = {}

    def add_log(lg, pcode, kind, before, after, start_n):
        row = {"gmkey": lg["gmkey"], "pcode": pcode, "kind": kind, "before_len": before, "after_len": after,
               "start_gmkey": info[start_n]["gmkey"], "game_date": lg["date"], "game_start": lg["start"], "alive": False}
        log.append(row)
        latest_log[(pcode, kind)] = row

    def emit(kind, pcode, run, alive):
        if run["len"] < MIN_ROW:
            return
        g = info[run["end"]]
        period = ("A:" if alive else "E:") + info[run["start"]]["gmkey"]
        rows.append(rb._row(g, BOARD[kind], "G", pcode, period, run["len"], names.get(pcode, pcode), run["tc"]))

    for n, g in enumerate(games):
        lg = {k: g[k] for k in ("gmkey", "date", "start", "season", "category", "home", "away", "names", "has_ot")}
        info.append(lg)
        season = rb.season_number(g["gmkey"])
        for tc in (g["home"], g["away"]):
            team_games[tc].append(n)
            season_first.setdefault((tc, season), n)
        by_pcode = {p["pcode"]: p for p in g["players"]}
        # --- 연속 출장
        for p in g["players"]:
            names[p["pcode"]] = p["pname"]
            if rb.played_seconds(p["rec"]) <= 0 or p["tcode"] not in (g["home"], g["away"]):
                continue
            pc, tc = p["pcode"], p["tcode"]
            st = gp.get(pc)
            cont = st is not None and _continues(st, tc, n, season, team_games, season_first)
            if st is not None and not cont:
                emit("gp", pc, {"len": st["len"], "start": st["start"], "end": st["last"], "tc": st["tc"]}, False)
            before = st["len"] if cont else 0
            start = st["start"] if cont else n
            gp[pc] = {"len": before + 1, "start": start, "last": n, "tc": tc, "season": season}
            last_seen[pc] = n
            add_log(lg, pc, "gp", before, before + 1, start)
        # --- 경기 간 연속 슛
        ok, bad = rb.shot_sequences(g)
        for pcode, kinds in bad.items():                                  # 게이트 탈락: 그 종목 연속을 끊는다(모르는 구간을 이어 붙이지 않는다)
            for kind in kinds:
                st = runs.pop((pcode, kind), None)
                for res in ("made", "miss"):
                    if st and st[res]["len"] > 0:
                        add_log(lg, pcode, f"x{kind}_{res}", st[res]["len"], 0, st[res]["start"])
                        emit(f"x{kind}_{res}", pcode, st[res], False)
        for pcode, kinds in ok.items():
            tc = by_pcode[pcode]["tcode"]
            for kind, seq in kinds.items():
                if not seq:
                    continue
                st = runs.setdefault((pcode, kind), {"made": _new_run(), "miss": _new_run()})
                before = {res: st[res]["len"] for res in st}
                starts = {res: st[res]["start"] for res in st}
                for s in seq:
                    cur, oth = ("made", "miss") if s else ("miss", "made")
                    if st[oth]["len"] > 0:
                        emit(f"x{kind}_{oth}", pcode, st[oth], False)
                        st[oth] = _new_run()
                    if st[cur]["len"] == 0:
                        st[cur] = {"len": 1, "start": n, "end": n, "tc": tc}
                    else:
                        st[cur]["len"] += 1
                        st[cur]["end"] = n
                        st[cur]["tc"] = tc
                for res in ("made", "miss"):
                    after = st[res]["len"]
                    if before[res] or after:
                        add_log(lg, pcode, f"x{kind}_{res}", before[res], after, st[res]["start"] if after else starts[res])

    # --- 마무리: 아직 열려 있는 연속을 행으로(지금 이어지는 중이면 A:, 아니면 E:)
    last_date = info[-1]["date"] if info else ""
    cutoff = ""
    if keep_days is not None and last_date:
        cutoff = (datetime.date.fromisoformat(last_date) - datetime.timedelta(days=keep_days)).isoformat()
    for pc, st in gp.items():
        alive = team_games[st["tc"]][-1] == st["last"]
        emit("gp", pc, {"len": st["len"], "start": st["start"], "end": st["last"], "tc": st["tc"]}, alive)
        if alive and (pc, "gp") in latest_log:
            latest_log[(pc, "gp")]["alive"] = True
    for (pc, kind), st in runs.items():
        seen = last_seen.get(pc)
        alive_p = seen is not None and info[seen]["date"] >= cutoff
        for res in ("made", "miss"):
            if st[res]["len"] > 0:
                emit(f"x{kind}_{res}", pc, st[res], alive_p)
                if alive_p and (pc, f"x{kind}_{res}") in latest_log:
                    latest_log[(pc, f"x{kind}_{res}")]["alive"] = True
    if cutoff:
        log = [r for r in log if r["game_date"] >= cutoff]
    return rows, log


def build(raw_dir=None, keep=rb.KEEP_RANK, games=None):
    """연속 보드 행(보관 순위로 자른 것)과 로그. games를 주면 raw 대신 그것으로(테스트)."""
    rows, log = compute(iter_games(raw_dir) if games is None else games)
    unique = {}
    for r in rows:                               # 한 경기 안에서 시작·끝난 같은 길이 이상의 연속이 여럿이면 PK가 같다 - 큰 쪽 하나만(upsert가 임의로 고르지 않게)
        k = rb.pk(r)
        if k not in unique or r["value"] > unique[k]["value"]:
            unique[k] = r
    return rb.retain(list(unique.values()), keep), log


def refresh(store, raw_dir=None, keep=rb.KEEP_RANK, games=None):
    """연속 보드 7개와 로그를 통째로 다시 계산해 교체한다(멱등). 호출부가 락과 트랜잭션을 잡는다."""
    rows, log = build(raw_dir, keep, games)
    store.replace_board_rows(STREAK_BOARDS, rows)
    store.replace_log(log)
    return {"rows": len(rows), "log": len(log)}
~~~

- [ ] **Step 6: 통과 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py && PYTHONIOENCODING=utf-8 "$PY" test_record_book.py`

Expected: 모두 `실패 없음.` 실패하면 **구현이 아니라 기대값이 틀렸는지** 손으로 먼저 다시 계산한다(특히 연속의 시작/끝 gmkey, `alive` 표시, 경기 번호).

- [ ] **Step 7: 커밋**

```bash
git add tools/record_streaks.py tools/record_book.py tools/test_record_streaks.py tools/schema_record_streak_log.sql tools/rollback_record_streak_log.sql
git commit -m "$(cat <<'EOF'
feat(records): consecutive-games-played and cross-game shot-streak state machine with a 120-day log table

One pass over every raw game in date order keeps each player's current run per kind (games played,
made/missed field goals, threes, free throws). Transfers keep a games-played streak alive if the
player appears in the new team's first available game. A shot gate failure resets only that kind.
Streak rows are one per streak (A: active / E: ended + start game); the log holds before/after
lengths and an alive flag for the last 120 days so the site can read tonight's carried-in state.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 파이썬 — CLI 연결(`--rebuild`·`--verify`·`--gmkeys`)과 실데이터 단언

**Files:**
- Modify: `tools/record_book.py`(main, docstring), `tools/test_record_streaks.py`

**Interfaces:**
- Consumes: Task 2의 `record_streaks.build/refresh/have_history`, `rb.diff_log`, 저장소 메서드
- Produces: `--rebuild`/`--verify`/`--dry-run --dump`가 연속 보드·로그까지 다룬다; `--gmkeys`는 경기 반영 뒤 raw 역사가 있으면 `refresh`를 한 번 더 한다.

- [ ] **Step 1: 실데이터 단언 테스트 추가**

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
if __name__ == "__main__":
    failed = 0
~~~
<!-- new -->
~~~python
# ---------------------------------------------------------------------------
# 실데이터 - RECORD_BOOK_SLOW=1
# ---------------------------------------------------------------------------

def test_known_streaks_on_real_data():
    if os.environ.get("RECORD_BOOK_SLOW") != "1" or not os.path.isdir(rb.RAW_GAMES):
        print("    (건너뜀: RECORD_BOOK_SLOW=1 이고 raw/games가 있을 때만)")
        return
    rows, log = rs.build()

    def top(board, n=1):
        return [r for rank, r in rb.rank_sorted([r for r in rows if r["board"] == board]) if rank <= n]

    gp = top("pg.streak_gp.max")[0]
    assert (gp["subject_name"], gp["subject"]) == ("이정현", "290381") and gp["value"] >= 393 and gp["period"].startswith("A:"), gp   # 이정현 진행 중(2019-03-01~)
    ended = [r for r in rows if r["board"] == "pg.streak_gp.max" and r["subject_name"] == "주희정" and r["value"] == 383]
    assert ended and ended[0]["period"].startswith("E:"), ended                                                                            # 주희정 383(2006-11~2013-10)
    ft = top("pg.xft_made.max")[0]
    assert (ft["subject_name"], ft["value"]) == ("조성민", 56), ft
    fg = top("pg.xfg_made.max")[0]
    assert (fg["subject_name"], fg["value"]) == ("서장훈", 24), fg
    alive = [r for r in log if r["pcode"] == "290381" and r["kind"] == "gp" and r["alive"]]
    assert len(alive) == 1 and alive[0]["after_len"] >= 393, alive                                                                         # 최신 행 하나만 alive
    assert len({(r["pcode"], r["kind"]) for r in log if r["alive"]}) == len([r for r in log if r["alive"]])                              # (선수, 종류)당 alive 행은 하나
    assert min(r["game_date"] for r in log) >= "2026-05-01"                                                                                # 120일 로그


if __name__ == "__main__":
    failed = 0
~~~

- [ ] **Step 2: `main()` 연결**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
        rows, stats = build_all(keep=args.keep)
        log(f"경기 {stats['games']}개(이벤트 검증 통과 {stats['event_games']}개), 후보 {stats['candidates']}개")
        _summary(rows)
~~~
<!-- new -->
~~~python
        rows, stats = build_all(keep=args.keep)
        import record_streaks
        streak_rows, streak_log = record_streaks.build(keep=args.keep)
        rows = rows + streak_rows
        log(f"경기 {stats['games']}개(이벤트 검증 통과 {stats['event_games']}개), 후보 {stats['candidates']}개, 연속 보드 {len(streak_rows)}행 + 로그 {len(streak_log)}행")
        _summary(rows)
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
            store.replace_all(rows)
            conn.commit()
            log(f"교체 완료: {len(rows)}행")
~~~
<!-- new -->
~~~python
            store.replace_all(rows)
            store.replace_log(streak_log)
            conn.commit()
            log(f"교체 완료: {len(rows)}행 + 연속 로그 {len(streak_log)}행")
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
            missing, extra, changed = diff_rows(rows, store.all_rows())
            log(f"검증: 없는 행 {len(missing)} / 남는 행 {len(extra)} / 값이 다른 행 {len(changed)}")
            for label, ks in (("없음", missing), ("남음", extra), ("다름", changed)):
                for k in ks[:10]:
                    log(f"  {label}: {k}")
            return 0 if not (missing or extra or changed) else 1
~~~
<!-- new -->
~~~python
            missing, extra, changed = diff_rows(rows, store.all_rows())
            log(f"검증: 없는 행 {len(missing)} / 남는 행 {len(extra)} / 값이 다른 행 {len(changed)}")
            for label, ks in (("없음", missing), ("남음", extra), ("다름", changed)):
                for k in ks[:10]:
                    log(f"  {label}: {k}")
            lmissing, lextra, lchanged = diff_log(streak_log, store.all_log())
            log(f"연속 로그 검증: 없는 행 {len(lmissing)} / 남는 행 {len(lextra)} / 값이 다른 행 {len(lchanged)}")
            for label, ks in (("로그 없음", lmissing), ("로그 남음", lextra), ("로그 다름", lchanged)):
                for k in ks[:10]:
                    log(f"  {label}: {k}")
            return 0 if not (missing or extra or changed or lmissing or lextra or lchanged) else 1
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
                log(f"{gmkey}: {res}")
            _revalidate()
            return 1 if failed else 0
~~~
<!-- new -->
~~~python
                log(f"{gmkey}: {res}")
            import record_streaks
            if record_streaks.have_history():
                store.lock()
                log(f"연속 기록 갱신: {record_streaks.refresh(store)}")
                conn.commit()
            else:
                log("연속 기록 갱신 건너뜀: raw/games에 역사 자료가 없다(클라우드 등) - 노트북이 다음에 갱신한다")
            _revalidate()
            return 1 if failed else 0
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
2단계(2026-10-10): docs/superpowers/specs/2026-10-10-record-book-phase2-design.md - 순간 기록 14개 보드(`moment_candidates`)
~~~
<!-- new -->
~~~python
2단계(2026-10-10): docs/superpowers/specs/2026-10-10-record-book-phase2-design.md - 순간 기록 14개 보드(`moment_candidates`)
3단계(2026-10-10): docs/superpowers/specs/2026-10-10-record-book-streaks-design.md - 연속 기록(한 경기 안 연속 슛 6개 보드는 `single_shot_candidates`,
경기 간 연속 슛·연속 출장 7개 보드와 로그는 tools/record_streaks.py - raw 전체를 다시 계산해 교체)
~~~

- [ ] **Step 3: 통과 확인(합성 + 실데이터 + 전체 드라이런)**

Run:

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_hook.py
RECORD_BOOK_SLOW=1 PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild --dry-run
```

Expected: 합성 테스트 전부 통과, 슬로우 실데이터 단언 통과(걸리면 §2 조사 값과 어긋난 보드를 확인 - 실제 값이 맞으면 단언을 실제 값으로 고치고 이유를 주석으로 남긴다). `--rebuild --dry-run`은 `... 연속 보드 N행 + 로그 M행`과 `보관 행 K개 / 보드·구간 L개`를 찍고, 시간은 2분 안쪽(1·2단계 약 1분 + 연속 약 40~60초).

- [ ] **Step 4: 커밋**

```bash
git add tools/record_book.py tools/test_record_streaks.py
git commit -m "$(cat <<'EOF'
feat(records): rebuild, verify and settlement refresh the streak boards and the log

--rebuild/--verify include the seven streak boards and record_streak_log; --gmkeys refreshes the
streaks after applying the games, but only when the raw history is present (the cloud checkout
only has today's game and must never overwrite the table with partial data).

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 웹 — 연속 공통 정의·서버 로더·`quiet` 표시

**Files:**
- Create: `courtside-web/lib/streakKinds.ts`, `courtside-web/lib/recordStreaks.ts`, `courtside-web/lib/recordStreaks.test.ts`
- Modify: `courtside-web/lib/records.ts`

**Interfaces:**
- Produces: `streakKinds.ts`: `STREAK_KINDS`, `StreakKind`, `STREAK_BOARD`, `KIND_OF_BOARD`, `StreakEntry`, `StreakState`, `StreakContext`; `recordStreaks.ts`: `summarizeStreaks(args) -> StreakContext | null`, `getStreakContext(game, final, boxPlayers) -> Promise<StreakContext | null>`, 타입 `StreakBoardRow`, `StreakLogRow`; `records.ts`: `RecordMoment.quiet?: boolean`.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- create: courtside-web/lib/recordStreaks.test.ts -->
~~~typescript
import { describe, expect, it } from "vitest";
import { summarizeStreaks, type StreakBoardRow, type StreakLogRow } from "./recordStreaks";

const board = (b: string, subject: string, value: number, period: string, name = subject): StreakBoardRow => ({ board: b, subject, period, value, name, date: "2026-10-08" });
const logRow = (gmkey: string, pcode: string, kind: string, before: number, after: number, alive: boolean): StreakLogRow => ({ gmkey, pcode, kind, before_len: before, after_len: after, alive });
const players = { lee: { name: "이정현", tcode: "DB" }, alb: { name: "알바노", tcode: "DB" }, kim: { name: "허훈", tcode: "KT" } };
const base = { gmkey: "S49G01N11", asOf: "2026-10-10", players };

describe("summarizeStreaks", () => {
  it("보드 행을 종류별로 값 내림차순, A:는 진행 중으로", () => {
    const ctx = summarizeStreaks({
      ...base, final: false, freshTeams: new Set(["DB"]), logRows: [],
      boardRows: [board("pg.streak_gp.max", "lee", 393, "A:S33G01N231", "이정현"), board("pg.streak_gp.max", "jhj", 383, "E:S11G01N1", "주희정"), board("pg.xft_made.max", "s", 56, "E:S23G01N1", "조성민"), board("pq.ast.max", "x", 9, "Q1")],
    })!;
    expect(ctx.boards.gp).toEqual([
      { v: 393, pcode: "lee", who: "이정현", active: true, d: "2026-10-08" },
      { v: 383, pcode: "jhj", who: "주희정", active: false, d: "2026-10-08" },
    ]);
    expect(ctx.boards.xft_made.map((e) => e.v)).toEqual([56]);
    expect(ctx.boards.xfg_made).toEqual([]);                                  // 연속 보드가 아닌 행은 무시
  });

  it("경기 전: 신선한 팀 선수의 alive 로그 행만 '이 경기 직전 길이'(after_len)로, 낡은 팀은 known에서 빠진다", () => {
    const ctx = summarizeStreaks({
      ...base, final: false, freshTeams: new Set(["DB"]),
      boardRows: [board("pg.streak_gp.max", "lee", 393, "A:x")],
      logRows: [logRow("S49G01N10", "lee", "gp", 392, 393, true), logRow("S49G01N10", "alb", "xft_made", 4, 5, true), logRow("S49G01N9", "alb", "xft_made", 3, 4, false), logRow("S49G01N10", "kim", "gp", 10, 11, true)],
    })!;
    expect(ctx.state).toEqual({ lee: { gp: { before: 393 } }, alb: { xft_made: { before: 5 } }, kim: { gp: { before: 11 } } });
    expect(ctx.known.sort()).toEqual(["alb", "lee"]);                          // KT는 신선하지 않아 허훈 상태는 있어도 믿지 않는다
    expect(ctx.final).toBe(false);
  });

  it("종료 경기: 이 경기 gmkey의 행만 before/after로", () => {
    const ctx = summarizeStreaks({
      ...base, final: true, freshTeams: null,
      boardRows: [board("pg.streak_gp.max", "lee", 394, "A:x")],
      logRows: [logRow("S49G01N11", "lee", "gp", 393, 394, false), logRow("S49G01N10", "lee", "gp", 392, 393, false), logRow("S49G01N11", "alb", "xft_miss", 2, 0, false)],
    })!;
    expect(ctx.state).toEqual({ lee: { gp: { before: 393, after: 394 } }, alb: { xft_miss: { before: 2, after: 0 } } });
    expect(ctx.final).toBe(true);
    expect(ctx.known.sort()).toEqual(["alb", "kim", "lee"]);
  });

  it("보드도 상태도 없으면 null", () => {
    expect(summarizeStreaks({ ...base, final: false, freshTeams: new Set(), boardRows: [], logRows: [] })).toBeNull();
  });
});
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/recordStreaks.test.ts`

Expected: FAIL — `Failed to resolve import "./recordStreaks"`.

- [ ] **Step 3: 구현**

<!-- create: courtside-web/lib/streakKinds.ts -->
~~~typescript
// 연속 기록(3단계) 공통 정의 - 서버(recordStreaks.ts)와 클라이언트 엔진(streakMoments.ts)이 같이 쓴다. 서버 전용 import가 없다.
// 설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md

export const STREAK_KINDS = ["gp", "xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss"] as const;
export type StreakKind = (typeof STREAK_KINDS)[number];

/** 보드 이름(record_entries.board) - tools/record_streaks.py BOARD와 같아야 한다. */
export const STREAK_BOARD: Record<StreakKind, string> = {
  gp: "pg.streak_gp.max",
  xfg_made: "pg.xfg_made.max",
  xfg_miss: "pg.xfg_miss.max",
  xtp_made: "pg.xtp_made.max",
  xtp_miss: "pg.xtp_miss.max",
  xft_made: "pg.xft_made.max",
  xft_miss: "pg.xft_miss.max",
};
export const KIND_OF_BOARD: Record<string, StreakKind> = Object.fromEntries(STREAK_KINDS.map((k) => [STREAK_BOARD[k], k]));

/** 연속 하나(끝난 것 또는 진행 중). */
export type StreakEntry = { v: number; pcode: string; who: string; active: boolean; d: string };
/** 한 선수·종류의 "이 경기 직전" 길이. 종료 경기에서는 after(이 경기 뒤 길이)도 있다. */
export type StreakState = { before: number; after?: number };

export type StreakContext = {
  asOf: string;
  /** 종료 경기(상태가 이 경기 로그 행에서 온다) */
  final: boolean;
  /** 종류별 보관된 연속들(값 내림차순, 진행 중 포함) */
  boards: Record<StreakKind, StreakEntry[]>;
  state: Record<string, Partial<Record<StreakKind, StreakState>>>;
  /** 경기 전 상태를 믿어도 되는 선수(그 팀의 직전 경기까지 로그가 반영된 팀의 선수). 종료 경기는 전원. */
  known: string[];
  players: Record<string, { name: string; tcode?: string }>;
};
~~~

<!-- create: courtside-web/lib/recordStreaks.ts -->
~~~typescript
import { cachedFn, TAG, TTL } from "./cachePolicy";
import { getTeamRoster } from "./playerPageData";
import { isRecordEligible } from "./recordBook";
import { supabaseServer as supabase } from "./supabaseServer";
import { KIND_OF_BOARD, STREAK_BOARD, STREAK_KINDS, type StreakContext, type StreakEntry, type StreakKind } from "./streakKinds";

// 연속 기록(3단계) 서버 쪽 - record_entries의 연속 보드 7개와 record_streak_log(최근 120일)를 읽어 "이 경기 직전의 연속 상태" 요약(StreakContext)을 만든다.
// 설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md §5. 테이블 갱신은 tools/record_streaks.py(경기 종료 정산이 노트북에서 호출).

export type StreakBoardRow = { board: string; subject: string; period: string; value: number; name: string; date: string };
export type StreakLogRow = { gmkey: string; pcode: string; kind: string; before_len: number; after_len: number; alive: boolean };

const PAGE = 1000;
const CATEGORIES = ["정규시즌", "플레이오프", "챔피언결정전"];

/** 순수 함수 - 보드 행과 로그 행으로 StreakContext를 만든다. 보드도 상태도 없으면 null. */
export function summarizeStreaks(args: {
  boardRows: StreakBoardRow[];
  logRows: StreakLogRow[];
  gmkey: string;
  final: boolean;
  asOf: string;
  players: Record<string, { name: string; tcode?: string }>;
  /** 경기 전: 로그가 그 팀의 직전 경기까지 반영된 팀들. 종료 경기는 쓰지 않는다. */
  freshTeams: Set<string> | null;
}): StreakContext | null {
  const boards = Object.fromEntries(STREAK_KINDS.map((k) => [k, [] as StreakEntry[]])) as Record<StreakKind, StreakEntry[]>;
  for (const r of args.boardRows) {
    const kind = KIND_OF_BOARD[r.board];
    if (kind) boards[kind].push({ v: r.value, pcode: r.subject, who: r.name, active: r.period.indexOf("A:") === 0, d: r.date });
  }
  for (const k of STREAK_KINDS) boards[k].sort((a, b) => b.v - a.v);
  const known: string[] = [];
  for (const [pcode, p] of Object.entries(args.players)) {
    if (args.final || (p.tcode != null && args.freshTeams != null && args.freshTeams.has(p.tcode))) known.push(pcode);
  }
  const state: StreakContext["state"] = {};
  for (const r of args.logRows) {
    const kind = STREAK_KINDS.find((k) => k === r.kind);
    if (!kind) continue;
    if (args.final ? r.gmkey !== args.gmkey : !r.alive) continue;
    const slot = state[r.pcode] ?? {};
    slot[kind] = args.final ? { before: r.before_len, after: r.after_len } : { before: r.after_len };
    state[r.pcode] = slot;
  }
  const hasBoard = STREAK_KINDS.some((k) => boards[k].length > 0);
  if (!hasBoard && Object.keys(state).length === 0) return null;
  return { asOf: args.asOf, final: args.final, boards, state, known, players: args.players };
}

const BOARD_LIST = STREAK_KINDS.map((k) => STREAK_BOARD[k]);

/** 연속 보드 7개의 보관 행 전부(수백 행) - 10분 캐시, 정산이 'records' 태그로 즉시 비운다. 조회 에러는 던진다(빈 배열을 캐시에 굳히지 않는다). */
const fetchStreakBoards = cachedFn(
  async (): Promise<StreakBoardRow[]> => {
    const out: StreakBoardRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("record_entries")
        .select("board, subject, period, value, game_date, subject_name")
        .in("board", BOARD_LIST)
        .order("board")
        .order("bucket")
        .order("gmkey")
        .order("subject")
        .order("period")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`streakBoards: ${error.message}`);
      for (const r of data ?? []) {
        out.push({ board: r.board as string, subject: r.subject as string, period: r.period as string, value: r.value as number, name: r.subject_name as string, date: r.game_date as string });
      }
      if (!data || data.length < PAGE) break;
    }
    return out;
  },
  { name: "streakBoards", ttl: TTL.scheduled, tags: () => [TAG.records] }
);

/** 한 경기의 로그 행(약 130행). */
const fetchLogByGame = cachedFn(
  async (gmkey: string): Promise<StreakLogRow[]> => {
    const { data, error } = await supabase.from("record_streak_log").select("gmkey, pcode, kind, before_len, after_len, alive").eq("gmkey", gmkey).limit(3000);
    if (error) throw new Error(`streakLogGame: ${error.message}`);
    return (data ?? []) as StreakLogRow[];
  },
  { name: "streakLogGame", ttl: TTL.scheduled, tags: () => [TAG.records] }
);

/** 선수들의 alive 로그 행(그 선수·종류의 최신 행) - pcodes는 콤마로 이은 문자열(캐시 키). */
const fetchAliveLog = cachedFn(
  async (pcodesKey: string): Promise<StreakLogRow[]> => {
    const pcodes = pcodesKey.split(",").filter(Boolean);
    if (pcodes.length === 0) return [];
    const { data, error } = await supabase.from("record_streak_log").select("gmkey, pcode, kind, before_len, after_len, alive").in("pcode", pcodes).eq("alive", true).limit(5000);
    if (error) throw new Error(`streakLogAlive: ${error.message}`);
    return (data ?? []) as StreakLogRow[];
  },
  { name: "streakLogAlive", ttl: TTL.scheduled, tags: () => [TAG.records] }
);

/** 그 팀이 이 경기 직전에 치른 종료 경기의 gmkey(없으면 null). */
const fetchPrevGame = cachedFn(
  async (tcode: string, date: string, start: string, gmkey: string): Promise<string | null> => {
    const { data, error } = await supabase
      .from("games")
      .select("gmkey, game_date, game_start")
      .eq("is_ended", true)
      .in("season_category", CATEGORIES)
      .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`)
      .lte("game_date", date)
      .order("game_date", { ascending: false })
      .order("game_start", { ascending: false })
      .limit(4);
    if (error) throw new Error(`streakPrevGame: ${error.message}`);
    const prev = (data ?? []).find((g) => g.gmkey !== gmkey && ((g.game_date as string) < date || String(g.game_start ?? "").slice(0, 5) < start));
    return prev ? (prev.gmkey as string) : null;
  },
  { name: "streakPrevGame", ttl: TTL.scheduled, tags: () => [TAG.records] }
);

/** 팀 로스터는 하루 단위로 안 바뀐다 - 1시간 캐시, 빈 로스터는 캐시에 안 넣는다(호출부 catch가 박스 선수만으로 이어 간다). */
const cachedRoster = cachedFn(
  async (tcode: string, season: string) => {
    const roster = await getTeamRoster(tcode, season);
    if (!roster.length) throw new Error(`streakRoster: empty ${tcode}/${season}`);
    return roster;
  },
  { name: "streakRoster", ttl: TTL.batchDaily }
);

/**
 * 경기 페이지용 - 이 경기에 나올 선수들의 연속 상태 요약. 대상이 아니거나(전시경기·60일 초과) 읽을 게 없으면 null.
 * 경기 전·라이브: 로그의 alive 행(= 직전까지 이어지던 연속)을 쓰되, 그 팀의 직전 경기까지 로그가 반영된 팀만 믿는다(클라우드만 정산한 날은 한 경기 늦다).
 * 종료 경기: 이 경기의 로그 행(before·after).
 */
export async function getStreakContext(
  game: {
    gmkey: string; game_date: string; game_start: string | null; season_category: string; season_name: string;
    home_team?: { tcode: string } | null; away_team?: { tcode: string } | null;
  },
  final: boolean,
  boxPlayers: { pcode: string; name: string; tcode?: string }[]
): Promise<StreakContext | null> {
  if (!isRecordEligible(game, Date.now())) return null;
  const tcodes = [game.home_team?.tcode, game.away_team?.tcode].filter((t): t is string => !!t);
  const rosters = await Promise.all(tcodes.map((t) => cachedRoster(t, game.season_name).catch(() => [] as { pcode: string; name: string }[])));
  const players: Record<string, { name: string; tcode?: string }> = {};
  rosters.forEach((list, i) => list.forEach((r) => (players[r.pcode] = { name: r.name, tcode: tcodes[i] })));
  for (const p of boxPlayers) players[p.pcode] = { name: p.name, tcode: p.tcode };
  const start = (game.game_start ?? "").slice(0, 5);
  const freshTeams = final
    ? null
    : new Set(
        (
          await Promise.all(
            tcodes.map(async (t) => {
              const prev = await fetchPrevGame(t, game.game_date, start, game.gmkey);
              if (prev == null) return t; // 그 팀의 첫 경기 - 이어받을 상태가 없으니 믿어도 된다
              return (await fetchLogByGame(prev)).some((r) => r.kind === "gp") ? t : null;
            })
          )
        ).filter((t): t is string => t != null)
      );
  const [boardRows, logRows] = await Promise.all([fetchStreakBoards(), final ? fetchLogByGame(game.gmkey) : fetchAliveLog(Object.keys(players).sort().join(","))]);
  return summarizeStreaks({ boardRows, logRows, gmkey: game.gmkey, final, asOf: `${game.game_date} ${start}`.trim(), players, freshTeams });
}
~~~

<!-- edit: courtside-web/lib/records.ts -->
<!-- old -->
~~~typescript
  /** 클럽(트리플더블·쿼드러플더블·5x5) 알림이면 클럽 이름 - 순위가 없어 토스트 제목이 다르다. */
  club?: string;
};
~~~
<!-- new -->
~~~typescript
  /** 클럽(트리플더블·쿼드러플더블·5x5) 알림이면 클럽 이름 - 순위가 없어 토스트 제목이 다르다. */
  club?: string;
  /** true면 패널·리포트에만 올리고 토스트는 띄우지 않는다(신기록 경신을 매 경기 이어가는 연속 출장 등 새로울 게 없는 줄). */
  quiet?: boolean;
};
~~~

- [ ] **Step 4: 통과 확인**

Run: `cd courtside-web && npx vitest run lib/recordStreaks.test.ts lib/records.test.ts && npx tsc --noEmit && npx eslint lib/streakKinds.ts lib/recordStreaks.ts lib/recordStreaks.test.ts`

Expected: 통과, `tsc`·`eslint` 출력 없음. `getTeamRoster`가 돌려주는 선수에 `pcode`·`name`이 있어 타입이 맞는다(다르면 그 이름에 맞춘다).

- [ ] **Step 5: 커밋**

```bash
git add courtside-web/lib/streakKinds.ts courtside-web/lib/recordStreaks.ts courtside-web/lib/recordStreaks.test.ts courtside-web/lib/records.ts
git commit -m "$(cat <<'EOF'
feat(web): streak context loader - boards, carried-in state from the 120-day log, stale-state guard

summarizeStreaks turns the seven streak boards and the log rows into one StreakContext; before a game
only teams whose previous game is already in the log are trusted (a cloud-only settlement day leaves the
log one game behind), and a finished game reads its own before/after rows. RecordMoment gains a quiet
flag so continuing records can skip the toast.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 웹 — 연속 순간 기록 엔진 `lib/streakMoments.ts`

**Files:**
- Create: `courtside-web/lib/streakMoments.ts`, `courtside-web/lib/streakMoments.test.ts`
- Modify: `courtside-web/lib/recordsMoments.ts`

**Interfaces:**
- Consumes: Task 4의 `StreakContext` 등, 1·2단계 `rankInfo/nextTarget/verdictText/holdersLine/clockOf`
- Produces: `buildStreakMoments(ctx: RecordContext | null, streaks: StreakContext | null, events, opts, finals?) -> RecordMoment[]`, `buildStreakChances(streaks) -> StreakChance[]`, `StreakChance`, `isMilestone`, `summaryOf`; `buildAllRecordMoments(ctx, events, opts, streaks?)`(4번째 인자 추가).

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- create: courtside-web/lib/streakMoments.test.ts -->
~~~typescript
import { describe, expect, it } from "vitest";
import { buildAllRecordMoments } from "./recordsMoments";
import type { BoardSummary, RecordContext, RecordEvent } from "./records";
import { buildStreakChances, buildStreakMoments, isMilestone, summaryOf } from "./streakMoments";
import { STREAK_KINDS, type StreakContext, type StreakEntry, type StreakKind } from "./streakKinds";

const names = { player: (p: string) => `선수${p}`, team: (t: string) => `팀${t}` };
const OPTS = { names, final: false, home: "H", away: "A" };
const ent = (v: number, pcode: string, who: string, active = false): StreakEntry => ({ v, pcode, who, active, d: "2026-03-24" });
function streaksOf(o: { boards?: Partial<Record<StreakKind, StreakEntry[]>>; state?: StreakContext["state"]; known?: string[]; final?: boolean }): StreakContext {
  const boards = Object.fromEntries(STREAK_KINDS.map((k) => [k, o.boards?.[k] ?? []])) as Record<StreakKind, StreakEntry[]>;
  return { asOf: "2026-10-10", final: o.final ?? false, boards, state: o.state ?? {}, known: o.known ?? [], players: {} };
}
const ev = (pcode: string | null, tcode: string | null, code: string, n = 0): RecordEvent => ({ pcode, tcode, action_code: code, quarter: "Q1", clock_min: 9, clock_sec: 59 - n });
const repeat = (n: number, pcode: string, code: string) => Array.from({ length: n }, (_, i) => ev(pcode, "H", code, i));
function board(tops: number[]): BoardSummary {
  const holders: BoardSummary["holders"] = [];
  let rank = 0;
  let last: number | null = null;
  tops.forEach((v, i) => {
    if (v !== last) {
      rank = i + 1;
      last = v;
    }
    if (rank <= 3 && holders.length < 6) holders.push({ v, who: `보유${i}`, d: "2020-01-12" });
  });
  return { tops, holders };
}
const ctxOf = (boards: Record<string, number[]>, validated?: string[]): RecordContext => ({
  asOf: "2026-10-09", boards: Object.fromEntries(Object.entries(boards).map(([k, t]) => [k, board(t)])), ...(validated ? { validated } : {}),
});
const GP = [ent(393, "lee", "이정현", true), ent(383, "jhj", "주희정"), ent(306, "ljd", "이재도"), ent(247, "khb", "김효범"), ent(240, "hjh", "함지훈"), ent(240, "jbg", "정병국"),
  ent(223, "rga", "라건아"), ent(206, "lhm", "이현민"), ent(195, "alb", "알바노", true), ent(191, "ldj", "이동준"), ent(190, "xx", "엑스")];

describe("연속 출장(gp) - 그 선수의 첫 이벤트에서", () => {
  it("신기록 경신을 이어가는 줄(순위 그대로)은 quiet, 문구는 종전 기록과 보유자", () => {
    const s = streaksOf({ boards: { gp: GP }, state: { lee: { gp: { before: 393 } } }, known: ["lee"] });
    const m = buildStreakMoments(null, s, [ev("lee", "H", "101")], OPTS).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ board: "pg.streak_gp.max", subject: "lee", value: 394, rank: 1, breaks: true, quiet: true, provisional: true, idx: 0 });
    expect(m[0].text).toBe("연속 출장 394경기째 KBL 신기록(종전 383경기)");
    expect(m[0].detail).toBe("주희정 보유");
  });
  it("50의 배수(100 이상) 이정표는 quiet이 아니다", () => {
    expect(isMilestone(400) && isMilestone(150) && !isMilestone(50) && !isMilestone(399)).toBe(true);
    const s = streaksOf({ boards: { gp: GP }, state: { lee: { gp: { before: 399 } } }, known: ["lee"] });
    const m = buildStreakMoments(null, s, [ev("lee", "H", "101")], OPTS)[0];
    expect(m.text).toBe("연속 출장 400경기째 KBL 신기록(종전 383경기)");
    expect(m.quiet).toBeFalsy();
  });
  it("TOP10 밖에서 순위가 처음 10위 안으로 들어오면 알린다(공동 10위), 이미 10위 안이고 그대로면 quiet", () => {
    const enter = streaksOf({ boards: { gp: GP }, state: { z: { gp: { before: 190 } } }, known: ["z"] });
    const a = buildStreakMoments(null, enter, [ev("z", "H", "101")], OPTS)[0];
    expect(a.text).toBe("연속 출장 191경기째 KBL 역대 공동 10위");
    expect(a.quiet).toBeFalsy();
    const stay = streaksOf({ boards: { gp: GP }, state: { alb: { gp: { before: 195 } } }, known: ["alb"] });
    const b = buildStreakMoments(null, stay, [ev("alb", "H", "101")], OPTS)[0];
    expect(b.value).toBe(196);
    expect(b.quiet).toBe(true);
  });
  it("10위 밖이고 이정표도 아니면 만들지 않고, 상태를 믿을 수 없는 선수(known 밖)나 상태가 없는 선수도 건너뛴다", () => {
    const s = streaksOf({ boards: { gp: GP }, state: { a: { gp: { before: 30 } }, b: { gp: { before: 399 } } }, known: ["a"] });
    expect(buildStreakMoments(null, s, [ev("a", "H", "101"), ev("b", "H", "101"), ev("c", "H", "101")], OPTS)).toEqual([]);
  });
  it("종료 경기: 이 경기 로그 행(after)이 있어야 하고 '잠정'이 아니다", () => {
    const withRow = streaksOf({ boards: { gp: GP }, state: { lee: { gp: { before: 393, after: 394 } } }, known: ["lee"], final: true });
    const m = buildStreakMoments(null, withRow, [ev("lee", "H", "101")], { ...OPTS, final: true });
    expect(m).toHaveLength(1);
    expect(m[0].provisional).toBe(false);
    expect(m[0].value).toBe(394);
    const noRow = streaksOf({ boards: { gp: GP }, state: {}, known: ["lee"], final: true });
    expect(buildStreakMoments(null, noRow, [ev("lee", "H", "101")], { ...OPTS, final: true })).toEqual([]);
  });
});

describe("경기 간 연속 슛 - 앞 경기에서 이어진 연속만", () => {
  const FT = [ent(56, "s", "조성민"), ent(52, "m", "문경은"), ent(44, "y", "양희승"), ent(43, "t", "문태종"), ent(42, "u", "유현준"), ent(42, "v", "레이션 테리"),
    ent(40, "w", "헤인즈"), ent(40, "x", "리틀"), ent(39, "a", "에이"), ent(38, "b", "비"), ent(37, "c", "씨")];
  it("자유투 36개째 이어진 선수가 8개를 더 넣으면 38·39·40·42·43·44에서 순위가 좋아질 때마다 알린다", () => {
    const s = streaksOf({ boards: { xft_made: FT }, state: { p: { xft_made: { before: 36 } } }, known: ["p"] });
    const m = buildStreakMoments(null, s, repeat(8, "p", "203"), OPTS).filter((x) => x.phase === "done" && x.board === "pg.xft_made.max");
    expect(m.map((x) => [x.value, x.rank])).toEqual([[38, 10], [39, 9], [40, 7], [42, 5], [43, 4], [44, 3]]);
    expect(m[0].text).toBe("자유투 연속 성공 38개(경기 간) KBL 역대 공동 10위");
    expect(m[m.length - 1].text).toBe("자유투 연속 성공 44개(경기 간) KBL 역대 공동 3위");
    expect(m[0]).toMatchObject({ scope: "p", bucket: "G", period: "", subject: "p" });
  });
  it("실패 연속은 불명예 문구 - 3점 24개째 이어진 선수가 3개 더 실패하면 25(공동 2위)·26(타이)·27(신기록)", () => {
    const TP = [ent(26, "k", "김민수", true), ent(25, "j", "전현우"), ent(25, "l", "이원대"), ent(24, "g", "이광재"), ent(24, "y", "양홍석"), ent(23, "h", "변현수"), ent(22, "i", "조한진"), ent(22, "d", "임동섭"), ent(21, "e", "이"), ent(20, "f", "에프")];
    const s = streaksOf({ boards: { xtp_miss: TP }, state: { p: { xtp_miss: { before: 24 } } }, known: ["p"] });
    const m = buildStreakMoments(null, s, repeat(3, "p", "206"), OPTS).filter((x) => x.phase === "done" && x.board === "pg.xtp_miss.max");
    expect(m.map((x) => x.text)).toEqual([
      "3점슛 연속 실패 25개(경기 간) 불명예 역대 공동 2위",
      "3점슛 연속 실패 26개(경기 간) 불명예 타이 기록(공동 1위)",
      "3점슛 연속 실패 27개(경기 간) 불명예 신기록(종전 26개)",
    ]);
  });
  it("본인 옛 행은 비교에서 뺀다(자기 진행 중 행과 겹쳐 순위가 밀리지 않는다)", () => {
    const own = [ent(60, "p", "본인", true), ...FT];
    const s = streaksOf({ boards: { xft_made: own }, state: { p: { xft_made: { before: 60 } } }, known: ["p"] });
    const m = buildStreakMoments(null, s, repeat(1, "p", "203"), OPTS).filter((x) => x.phase === "done");
    expect(m[0].text).toBe("자유투 연속 성공 61개(경기 간) KBL 신기록(종전 56개)");
  });
  it("그 경기 안에서 시작한 연속은 경기 간 알림이 아니라 한 경기 보드가 알린다(중복 방지)", () => {
    const s = streaksOf({ boards: { xft_made: FT }, state: {}, known: ["p"] });
    const events = repeat(45, "p", "203");
    expect(buildStreakMoments(null, s, events, OPTS).filter((x) => x.board === "pg.xft_made.max")).toEqual([]);
    const c = ctxOf({ "pg.sft_made.max|G": [18, 15, 15, 14, 14, 13, 13, 12, 12, 11] });
    const m = buildStreakMoments(c, s, repeat(12, "p", "203"), OPTS).filter((x) => x.phase === "done");
    expect(m.map((x) => [x.board, x.value, x.text])).toEqual([
      ["pg.sft_made.max", 11, "한 경기 자유투 연속 성공 11개 KBL 역대 공동 10위"],
      ["pg.sft_made.max", 12, "한 경기 자유투 연속 성공 12개 KBL 역대 공동 8위"],
    ]);
  });
  it("임박(패널 전용): 다음 기록 선까지 자유투 3개 이내", () => {
    const s = streaksOf({ boards: { xft_made: FT }, state: { p: { xft_made: { before: 40 } } }, known: ["p"] });
    const near = buildStreakMoments(null, s, repeat(1, "p", "203"), OPTS).filter((x) => x.phase === "near" && x.board === "pg.xft_made.max");
    expect(near.length).toBeGreaterThan(0);
    expect(near[0].remaining).toBe(3);
    expect(near[0].text).toContain("더하면");
  });
  it("종료 경기: 이 경기 로그 행이 없는 (선수, 종류)는 알리지 않는다", () => {
    const withRow = streaksOf({ boards: { xft_made: FT }, state: { p: { xft_made: { before: 36, after: 44 } } }, known: ["p"], final: true });
    expect(buildStreakMoments(null, withRow, repeat(8, "p", "203"), { ...OPTS, final: true }).filter((x) => x.phase === "done").length).toBeGreaterThan(0);
    const noRow = streaksOf({ boards: { xft_made: FT }, state: {}, known: ["p"], final: true });
    expect(buildStreakMoments(null, noRow, repeat(8, "p", "203"), { ...OPTS, final: true })).toEqual([]);
  });
});

describe("한 경기 안 연속 슛 보드(요약기 사용)", () => {
  it("야투 성공/실패와 3점은 성공 코드와 실패 코드로, 종료 경기는 validated 항목만", () => {
    const c = ctxOf({ "pg.sfg_made.max|G": [16, 15, 14, 14, 13, 12, 12, 11, 11, 10], "pg.sfg_miss.max|G": [14, 14, 14, 13, 13, 12, 12, 11, 11, 10] });
    const events = [...repeat(11, "p", "201"), ...repeat(1, "p", "202")];
    const live = buildStreakMoments(c, null, events, OPTS).filter((x) => x.phase === "done");
    expect(live.map((x) => [x.value, x.text])).toEqual([[10, "한 경기 야투 연속 성공 10개 KBL 역대 공동 10위"], [11, "한 경기 야투 연속 성공 11개 KBL 역대 공동 8위"]]);
    const finOk = buildStreakMoments(ctxOf({ "pg.sfg_made.max|G": [16, 15, 14, 14, 13, 12, 12, 11, 11, 10] }, ["pg.sfg_made.max|G|p|"]), null, events, { ...OPTS, final: true }).filter((x) => x.phase === "done");
    expect(finOk.every((x) => x.provisional === false)).toBe(true);
    expect(buildStreakMoments(ctxOf({ "pg.sfg_made.max|G": [16, 15, 14, 14, 13, 12, 12, 11, 11, 10] }, []), null, events, { ...OPTS, final: true })).toEqual([]);
  });
  it("실패 연속은 불명예", () => {
    const c = ctxOf({ "pg.stp_miss.max|G": [12, 12, 11, 11, 11, 10, 10, 9, 9, 9] });
    const m = buildStreakMoments(c, null, repeat(12, "p", "206"), OPTS).filter((x) => x.phase === "done" && x.board === "pg.stp_miss.max");
    expect(m[m.length - 1].text).toBe("한 경기 3점슛 연속 실패 12개 불명예 타이 기록(공동 1위)");
  });
});

describe("경기 전 기록 도전 / finals / 합치기", () => {
  const players = { lee: { name: "이정현", tcode: "DB" }, p: { name: "조성민", tcode: "KT" } };
  it("연속 출장 도전(순위 문구)과 성공 연속이 다음 개수로 기록 선을 넘는 경우만", () => {
    const FT = [ent(56, "s", "조성민"), ent(52, "m", "문경은"), ent(44, "y", "양희승"), ent(43, "t", "문태종"), ent(42, "u", "유현준"), ent(42, "v", "레이션 테리"), ent(40, "w", "헤인즈"), ent(40, "x", "리틀"), ent(39, "a", "에이"), ent(38, "b", "비"), ent(37, "c", "씨")];
    const s = { ...streaksOf({ boards: { gp: GP, xft_made: FT }, state: { lee: { gp: { before: 393 } }, p: { xft_made: { before: 41 } } }, known: ["lee", "p"] }), players };
    const chances = buildStreakChances(s);
    expect(chances.map((c) => c.text)).toEqual([
      "오늘 출전하면 연속 출장 394경기째 KBL 신기록(종전 383경기)",
      "다음 자유투가 들어가면 연속 성공 42개째 KBL 역대 공동 5위",
    ]);
    expect(chances[0]).toMatchObject({ pcode: "lee", name: "이정현", tcode: "DB" });
    expect(buildStreakChances({ ...s, known: [] })).toEqual([]);                  // 상태를 믿을 수 없으면 도전 문장도 없다
  });
  it("finals: 한 경기 안 최대 연속(5 이상)과 경기 간 연속의 경기 끝 길이를 파이썬 행과 맞출 수 있게 채운다", () => {
    const finals = new Map<string, number>();
    const s = streaksOf({ boards: {}, state: { p: { xft_made: { before: 3 } } }, known: ["p"] });
    buildStreakMoments(null, s, [...repeat(6, "p", "203"), ...repeat(1, "p", "204"), ...repeat(2, "p", "203")], OPTS, finals);
    expect(Object.fromEntries(finals)).toMatchObject({ "pg.sft_made.max|G|p|": 6, "xft_made|p": 2, "xft_miss|p": 0 });
    expect(finals.has("pg.sft_miss.max|G|p|")).toBe(false);
  });
  it("buildAllRecordMoments의 4번째 인자로 합쳐지고 시간순이다", () => {
    const s = streaksOf({ boards: { gp: GP }, state: { lee: { gp: { before: 393 } } }, known: ["lee"] });
    const all = buildAllRecordMoments(ctxOf({}), [ev("lee", "H", "101"), ev("lee", "H", "201", 1)], OPTS, s);
    expect(all.map((x) => x.board)).toContain("pg.streak_gp.max");
    expect(buildAllRecordMoments(ctxOf({}), [ev("lee", "H", "101")], OPTS).map((x) => x.board)).not.toContain("pg.streak_gp.max");
  });
  it("summaryOf: 본인 행을 빼고 순위 <= 10의 값과 상위 3위 보유자를 낸다", () => {
    const sm = summaryOf(GP, "lee");
    expect(sm.tops[0]).toBe(383);
    expect(sm.holders[0]).toEqual({ v: 383, who: "주희정", d: "2026-03-24" });
  });
});
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/streakMoments.test.ts`

Expected: FAIL — `Failed to resolve import "./streakMoments"`.

- [ ] **Step 3: 엔진 구현**

<!-- create: courtside-web/lib/streakMoments.ts -->
~~~typescript
import {
  clockOf,
  holdersLine,
  nextTarget,
  rankInfo,
  TOP_RANKS,
  verdictText,
  type BoardSummary,
  type RankInfo,
  type RecordContext,
  type RecordEvent,
  type RecordMoment,
  type RecordTimelineOptions,
  type ValueFmt,
} from "./records";
import { STREAK_BOARD, type StreakContext, type StreakEntry, type StreakKind } from "./streakKinds";

// 역대 기록 3단계 라이브 엔진(연속 기록) - 설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md §5
//
// 이벤트를 한 번 훑으며 (1) 선수가 경기에 처음 나오는 순간 연속 출장 N경기째, (2) 슛 연속(경기 간: 앞 경기에서 이어진 것 / 한 경기 안)을 판정해
// 서버가 내려준 보드(StreakContext)·요약(RecordContext)의 TOP10과 비교한다. 순수 함수 - 서버 전용 모듈을 import하지 않는다.

export const MILESTONE_FROM = 100;
export const MILESTONE_STEP = 50;
export const isMilestone = (n: number) => n >= MILESTONE_FROM && n % MILESTONE_STEP === 0;

type ShotKind = "fg" | "tp" | "ft";
type Res = "made" | "miss";
const SHOT_KINDS: ShotKind[] = ["fg", "tp", "ft"];
const SHOT: Record<ShotKind, { made: string[]; miss: string[]; word: string; ga: string }> = {
  fg: { made: ["201", "205", "207"], miss: ["202", "206", "208"], word: "야투", ga: "야투가" },
  tp: { made: ["205"], miss: ["206"], word: "3점슛", ga: "3점슛이" },
  ft: { made: ["203"], miss: ["204"], word: "자유투", ga: "자유투가" },
};
const RES_WORD: Record<Res, string> = { made: "성공", miss: "실패" };
/** 임박(near) 기준 - 다음 기록 선과의 차가 이 값 이하일 때만 패널에 올린다. */
const NEAR_GAP: Record<ShotKind, Record<Res, number>> = { fg: { made: 2, miss: 2 }, tp: { made: 1, miss: 2 }, ft: { made: 3, miss: 1 } };
const cnt: ValueFmt = (v) => `${v}개`;
const gameCnt: ValueFmt = (v) => `${v}경기`;
const levelOf = (i: RankInfo) => (i.breaks ? 0 : i.rank);
const whoOf = (res: Res) => (res === "miss" ? "불명예" : "KBL");
const crossKind = (kind: ShotKind, res: Res) => `x${kind}_${res}` as StreakKind;
const singleBoard = (kind: ShotKind, res: Res) => `pg.s${kind}_${res}.max`;

/** 연속 보드의 항목들(본인 행 제외)을 순위 요약으로 - 비교할 "다른 사람들의 연속". */
export function summaryOf(entries: StreakEntry[], excludePcode?: string): BoardSummary {
  const list = entries.filter((e) => e.pcode !== excludePcode).sort((a, b) => b.v - a.v);
  const tops: number[] = [];
  const holders: BoardSummary["holders"] = [];
  let rank = 0;
  let last: number | null = null;
  list.forEach((e, i) => {
    if (e.v !== last) {
      rank = i + 1;
      last = e.v;
    }
    if (rank <= TOP_RANKS) tops.push(e.v);
    if (rank <= 3 && holders.length < 6) holders.push({ v: e.v, who: e.who, d: e.d });
  });
  return { tops, holders };
}

type PState = {
  run: Record<ShotKind, Record<Res, number>>;
  carried: Record<ShotKind, Record<Res, boolean>>;
  single: Record<ShotKind, Record<Res, number>>;
  best: Record<ShotKind, Record<Res, number>>;
};
const zero = <T,>(v: T): Record<ShotKind, Record<Res, T>> => ({ fg: { made: v, miss: v }, tp: { made: v, miss: v }, ft: { made: v, miss: v } });

/**
 * 연속 기록 순간들. ctx는 한 경기 안 보드(pg.s{fg,tp,ft}_{made,miss}.max)의 요약이고 streaks는 연속 출장·경기 간 연속의 보드와 이 경기 직전 상태다(둘 다 null일 수 있다).
 * 종료 경기: 한 경기 안 보드는 ctx.validated(테이블에 이 경기 행이 있는 것)만, 연속 출장·경기 간 연속은 이 경기 로그 행이 있는 것만 남긴다.
 * finals를 주면 파이썬 후보·로그와 맞출 값을 채운다 - 한 경기 안 최대 연속(5 이상) `${board}|G|${pcode}|`, 경기 간 연속의 경기 끝 길이 `${종류}|${pcode}`.
 */
export function buildStreakMoments(
  ctx: RecordContext | null,
  streaks: StreakContext | null,
  events: RecordEvent[],
  opts: RecordTimelineOptions,
  finals?: Map<string, number>
): RecordMoment[] {
  const out: RecordMoment[] = [];
  const provisional = !opts.final;
  const validated = ctx?.validated ? new Set(ctx.validated) : null;
  const known = new Set(streaks?.known ?? []);
  const players = new Map<string, PState>();
  const seen = new Set<string>();
  const lastEmit = new Map<string, { level: number; value: number }>();
  const openNear = new Map<string, RecordMoment>();

  const closeNear = (key: string, at: number) => {
    const open = openNear.get(key);
    if (open) {
      open.until = at;
      openNear.delete(key);
    }
  };
  const pstate = (pcode: string): PState => {
    let ps = players.get(pcode);
    if (!ps) {
      const st = known.has(pcode) ? streaks?.state[pcode] : undefined;
      const run = zero(0);
      for (const kind of SHOT_KINDS) for (const res of ["made", "miss"] as Res[]) run[kind][res] = st?.[crossKind(kind, res)]?.before ?? 0;
      const carried = zero(false);
      for (const kind of SHOT_KINDS) for (const res of ["made", "miss"] as Res[]) carried[kind][res] = run[kind][res] > 0;
      ps = { run, carried, single: zero(0), best: zero(0) };
      players.set(pcode, ps);
    }
    return ps;
  };

  type Who = { pcode: string; name: string; tcode: string; idx: number; clock: string };

  /** 순위 보드 판정 - 상위 10위 안이고 순위가 좋아질 때(신기록 이후엔 값이 늘 때마다)만 알린다. */
  const emit = (a: Who & { key: string; board: string; summary: BoardSummary; value: number; label: string; fmt: ValueFmt; who: string; quiet?: boolean }) => {
    const info = rankInfo(a.summary.tops, a.value, "max");
    if (!info || info.rank > TOP_RANKS) return;
    const level = levelOf(info);
    const prev = lastEmit.get(a.key);
    if (prev && !(level < prev.level || (level === 0 && a.value > prev.value))) return;
    lastEmit.set(a.key, { level, value: a.value });
    closeNear(a.key, a.idx);
    out.push({
      id: `${a.key}|${level}|${a.value}|done`, idx: a.idx, until: Infinity, clock: a.clock, phase: "done",
      board: a.board, bucket: "G", subject: a.pcode, period: "", scope: "p", name: a.name, tcode: a.tcode, value: a.value,
      rank: info.rank, tie: info.tie, breaks: info.breaks, remaining: 0,
      text: `${a.label} ${verdictText(info, a.fmt, a.who)}`, detail: holdersLine(a.summary, info, a.fmt),
      provisional, sig: level, ...(a.quiet ? { quiet: true } : {}),
    });
  };

  /** 임박 - 현재 값이 다음 기록 선(상위 3위 값·신기록)과 gap 이내이면 패널용 near를 새로 연다. */
  const near = (a: Who & { key: string; board: string; summary: BoardSummary; value: number; label: string; fmt: ValueFmt; who: string; gap: number }) => {
    closeNear(a.key, a.idx);
    if (a.summary.tops.length === 0) return;
    const target = nextTarget(a.summary.tops, a.value);
    if (target == null || target - a.value > a.gap) return;
    const tInfo = rankInfo(a.summary.tops, target, "max");
    if (!tInfo) return;
    const m: RecordMoment = {
      id: `${a.key}|${target}|near|${a.value}`, idx: a.idx, until: Infinity, clock: a.clock, phase: "near",
      board: a.board, bucket: "G", subject: a.pcode, period: "", scope: "p", name: a.name, tcode: a.tcode, value: a.value,
      rank: tInfo.rank, tie: tInfo.tie, breaks: tInfo.breaks, remaining: target - a.value,
      text: `${a.label} · ${target - a.value}개 더하면 ${verdictText(tInfo, a.fmt, a.who)}`, detail: holdersLine(a.summary, tInfo, a.fmt),
      provisional, sig: levelOf(tInfo),
    };
    openNear.set(a.key, m);
    out.push(m);
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (!e.pcode || !e.tcode || !e.action_code || !e.quarter || e.quarter === "PRE") continue;
    const pcode = e.pcode;
    const name = opts.names.player(pcode);
    const w = { pcode, name, tcode: e.tcode, idx, clock: clockOf(e) };

    // 연속 출장 - 그 선수의 첫 이벤트에서 "N경기째"(이 경기를 뛰었으니 before + 1)
    if (!seen.has(pcode)) {
      seen.add(pcode);
      const st = streaks && known.has(pcode) ? streaks.state[pcode]?.gp : undefined;
      if (streaks && st && (!streaks.final || st.after != null)) {
        const n = streaks.final ? (st.after as number) : st.before + 1;
        const before = n - 1;
        const s = summaryOf(streaks.boards.gp, pcode);
        const info = rankInfo(s.tops, n, "max");
        const beforeInfo = before > 0 ? rankInfo(s.tops, before, "max") : null;
        const ranked = info != null && info.rank <= TOP_RANKS;
        const improved = ranked && (beforeInfo == null || beforeInfo.rank > TOP_RANKS || info.rank < beforeInfo.rank || (info.breaks && !beforeInfo.breaks));
        const milestone = isMilestone(n);
        finals?.set(`gp|${pcode}`, n);
        if (ranked || milestone) {
          out.push({
            id: `gp|${pcode}|${n}`, idx, until: Infinity, clock: w.clock, phase: "done",
            board: STREAK_BOARD.gp, bucket: "G", subject: pcode, period: "", scope: "p", name, tcode: e.tcode, value: n,
            rank: ranked ? info.rank : TOP_RANKS + 1, tie: ranked ? info.tie : false, breaks: ranked ? info.breaks : false, remaining: 0,
            text: ranked ? `연속 출장 ${n}경기째 ${verdictText(info, gameCnt, "KBL")}` : `연속 출장 ${n}경기 달성`,
            detail: ranked ? holdersLine(s, info, gameCnt) : "",
            provisional, sig: ranked ? levelOf(info) : 50, ...(improved || milestone ? {} : { quiet: true }),
          });
        }
      }
    }

    // 슛 연속
    for (const kind of SHOT_KINDS) {
      const res: Res | null = SHOT[kind].made.indexOf(e.action_code) >= 0 ? "made" : SHOT[kind].miss.indexOf(e.action_code) >= 0 ? "miss" : null;
      if (!res) continue;
      const oth: Res = res === "made" ? "miss" : "made";
      const ps = pstate(pcode);
      ps.run[kind][res] += 1;
      ps.run[kind][oth] = 0;
      ps.carried[kind][oth] = false;
      ps.single[kind][res] += 1;
      ps.single[kind][oth] = 0;
      ps.best[kind][res] = Math.max(ps.best[kind][res], ps.single[kind][res]);

      // 한 경기 안(요약기 보드). 종료 경기는 테이블에 이 경기 행이 있는 것만.
      const sBoard = singleBoard(kind, res);
      const sSummary = ctx?.boards[`${sBoard}|G`];
      if (sSummary && (!opts.final || (validated != null && validated.has(`${sBoard}|G|${pcode}|`)))) {
        const base = { ...w, key: `${sBoard}|${pcode}`, board: sBoard, summary: sSummary, value: ps.single[kind][res], label: `한 경기 ${SHOT[kind].word} 연속 ${RES_WORD[res]} ${ps.single[kind][res]}개`, fmt: cnt, who: whoOf(res) };
        emit(base);
        near({ ...base, gap: NEAR_GAP[kind][res] });
      }

      // 경기 간 - 앞 경기에서 이어진 연속만(이 경기 안에서 시작한 연속은 위의 한 경기 보드가 알린다)
      const ckind = crossKind(kind, res);
      if (streaks && known.has(pcode) && ps.carried[kind][res] && (!streaks.final || streaks.state[pcode]?.[ckind] != null)) {
        const cSummary = summaryOf(streaks.boards[ckind], pcode);
        const base = { ...w, key: `${STREAK_BOARD[ckind]}|${pcode}`, board: STREAK_BOARD[ckind], summary: cSummary, value: ps.run[kind][res], label: `${SHOT[kind].word} 연속 ${RES_WORD[res]} ${ps.run[kind][res]}개(경기 간)`, fmt: cnt, who: whoOf(res) };
        emit(base);
        near({ ...base, gap: NEAR_GAP[kind][res] });
      }
    }
  }

  if (finals) {
    for (const [pcode, ps] of players) {
      for (const kind of SHOT_KINDS) {
        for (const res of ["made", "miss"] as Res[]) {
          if (ps.best[kind][res] >= 5) finals.set(`${singleBoard(kind, res)}|G|${pcode}|`, ps.best[kind][res]);
          if (known.has(pcode)) finals.set(`${crossKind(kind, res)}|${pcode}`, ps.run[kind][res]);
        }
      }
    }
  }
  for (const key of [...openNear.keys()]) closeNear(key, events.length);
  return out;
}

/** 경기 전 "기록 도전" 한 줄(이름·팀 칩은 recordChanceList가 붙인다). */
export type StreakChance = { id: string; pcode: string; name: string; tcode?: string; text: string; detail: string; sig: number };

/**
 * 경기 전 도전: 오늘 출전하면 연속 출장이 순위에 오르는 선수, 성공 연속이 이어져 다음 개수로 순위가 좋아지는 선수.
 * 상태를 믿을 수 없는 선수(known 밖)는 만들지 않는다. 알릴 만한 순(신기록 먼저)으로 최대 6개.
 */
export function buildStreakChances(streaks: StreakContext): StreakChance[] {
  const out: StreakChance[] = [];
  for (const pcode of streaks.known) {
    const st = streaks.state[pcode];
    const p = streaks.players[pcode];
    if (!st || !p) continue;
    const who = { pcode, name: p.name, ...(p.tcode ? { tcode: p.tcode } : {}) };
    const gp = st.gp?.before ?? 0;
    if (gp > 0) {
      const s = summaryOf(streaks.boards.gp, pcode);
      const info = rankInfo(s.tops, gp + 1, "max");
      if (info && info.rank <= TOP_RANKS) out.push({ ...who, id: `gp|${pcode}`, text: `오늘 출전하면 연속 출장 ${gp + 1}경기째 ${verdictText(info, gameCnt, "KBL")}`, detail: holdersLine(s, info, gameCnt), sig: levelOf(info) });
      else if (isMilestone(gp + 1)) out.push({ ...who, id: `gp|${pcode}`, text: `오늘 출전하면 연속 출장 ${gp + 1}경기 달성`, detail: "", sig: 50 });
    }
    for (const kind of SHOT_KINDS) {
      const before = st[crossKind(kind, "made")]?.before ?? 0;
      if (before <= 0) continue;
      const s = summaryOf(streaks.boards[crossKind(kind, "made")], pcode);
      const info = rankInfo(s.tops, before + 1, "max");
      const beforeInfo = rankInfo(s.tops, before, "max");
      if (!info || info.rank > TOP_RANKS) continue;
      if (beforeInfo && beforeInfo.rank <= TOP_RANKS && !(info.rank < beforeInfo.rank || (info.breaks && !beforeInfo.breaks))) continue;
      out.push({ ...who, id: `${crossKind(kind, "made")}|${pcode}`, text: `다음 ${SHOT[kind].ga} 들어가면 연속 성공 ${before + 1}개째 ${verdictText(info, cnt, "KBL")}`, detail: holdersLine(s, info, cnt), sig: levelOf(info) + 100 });
    }
  }
  return out.sort((a, b) => a.sig - b.sig || a.name.localeCompare(b.name, "ko")).slice(0, 6);
}
~~~

<!-- edit: courtside-web/lib/recordsMoments.ts -->
<!-- old -->
~~~typescript
/** 1단계(쿼터·경기 최다/최소)와 2단계(순간 기록)를 합쳐 시간순으로. 종료 경기는 2단계도 테이블에 있는(validated) 항목만 남긴다. */
export function buildAllRecordMoments(ctx: RecordContext, events: RecordEvent[], opts: RecordTimelineOptions): RecordMoment[] {
  const base = buildRecordTimeline(ctx, events, opts);
  const extra = buildMomentTimeline(ctx, events, opts);
  const validated = ctx.validated ? new Set(ctx.validated) : null;
  const kept = validated ? extra.filter((m) => validated.has(validatedKey(m))) : extra;
  return [...base, ...kept].sort((a, b) => a.idx - b.idx);
}
~~~
<!-- new -->
~~~typescript
/**
 * 1단계(쿼터·경기 최다/최소)와 2단계(순간 기록)와 3단계(연속 기록)를 합쳐 시간순으로. 종료 경기는 1·2단계 순간을 테이블에 있는(validated) 항목만 남기고,
 * 3단계(streakMoments)는 스스로 같은 기준(한 경기 안 = validated, 연속 출장·경기 간 = 이 경기 로그 행)으로 거른다.
 */
export function buildAllRecordMoments(ctx: RecordContext, events: RecordEvent[], opts: RecordTimelineOptions, streaks?: StreakContext | null): RecordMoment[] {
  const base = buildRecordTimeline(ctx, events, opts);
  const extra = buildMomentTimeline(ctx, events, opts);
  const validated = ctx.validated ? new Set(ctx.validated) : null;
  const kept = validated ? extra.filter((m) => validated.has(validatedKey(m))) : extra;
  const streak = buildStreakMoments(ctx, streaks ?? null, events, opts);
  return [...base, ...kept, ...streak].sort((a, b) => a.idx - b.idx);
}
~~~

<!-- edit: courtside-web/lib/recordsMoments.ts -->
<!-- old -->
~~~typescript
} from "./records";

// 역대 기록 2단계 라이브 엔진
~~~
<!-- new -->
~~~typescript
} from "./records";
import type { StreakContext } from "./streakKinds";
import { buildStreakMoments } from "./streakMoments";

// 역대 기록 2단계 라이브 엔진
~~~

- [ ] **Step 4: 통과 확인**

Run: `cd courtside-web && npx vitest run lib/streakMoments.test.ts lib/recordsMoments.test.ts lib/records.test.ts && npx tsc --noEmit && npx eslint lib/streakMoments.ts lib/streakMoments.test.ts lib/recordsMoments.ts`

Expected: 통과, `tsc`·`eslint` 출력 없음. 실패하는 단언은 **구현이 아니라 기대값이 틀렸는지** 손으로 계산해 먼저 확인한다(순위·공동 표기·`quiet`·near의 remaining).

- [ ] **Step 5: 커밋**

```bash
git add courtside-web/lib/streakMoments.ts courtside-web/lib/streakMoments.test.ts courtside-web/lib/recordsMoments.ts
git commit -m "$(cat <<'EOF'
feat(web): streak record engine - games-played rank, cross-game and single-game shot streaks, pre-game chances

A player's first event this game gives 'N-th straight game' against the stored streaks (his own old row
excluded); continuing a record he already holds stays quiet (panel/report only) unless it is a new rank
or a 50-game milestone. Shot streaks carried in from earlier games are judged against the cross-game
boards, runs that start inside the game against the single-game boards, so one event never says the
same thing twice. buildAllRecordMoments takes the streak context as an optional fourth argument.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 웹 — 화면 연결(GameReplay·리포트·경기 페이지)

**Files:**
- Modify: `courtside-web/components/GameReplay.tsx`, `courtside-web/lib/postgameReport.ts`, `courtside-web/lib/postgameReport.test.ts`, `courtside-web/app/games/[gmkey]/page.tsx`

**Interfaces:**
- Consumes: Task 4·5의 `getStreakContext`, `StreakContext`, `buildStreakChances`, `buildAllRecordMoments(..., streaks)`
- Produces: `GameReplay`의 새 prop `streaks?: StreakContext | null`(토스트는 `quiet` 제외); `recordBookSection(ctx, events, tags, names, sides?, streaks?)`; `BuildReportInput.streaks`; `recordChanceList`가 이름·팀·문장만 있는 줄도 받는다(`ChanceLine`).

- [ ] **Step 1: 리포트 테스트 추가(실패)**

<!-- edit: courtside-web/lib/postgameReport.test.ts -->
<!-- old -->
~~~typescript
  it("종료 경기에서 테이블에 없는 항목(validated 밖)은 쓰지 않고, 아무것도 없으면 null", () => {
~~~
<!-- new -->
~~~typescript
  it("3단계 연속 기록(연속 출장)도 같은 섹션에 - 이 경기 로그 행이 있을 때만, 신기록 경신 줄도 리포트에는 남는다", () => {
    const evs = attachDerivedFields([
      ev({ event_order: 0, quarter: "PRE", home_score: 0, away_score: 0, home_win_prob: 0.5 }),
      ev({ event_order: 1, quarter: "Q1", clock_min: 10, clock_sec: 0, home_score: 0, away_score: 0, action_code: "101", pcode: "p1", player_name: "허훈", tcode: "H", home_win_prob: 0.5 }),
    ]);
    const entry = (v: number, pcode: string, who: string, active = false) => ({ v, pcode, who, active, d: "2026-03-24" });
    const mk = (state: StreakContext["state"]): StreakContext => ({
      asOf: "x", final: true, known: ["p1"], players: {}, state,
      boards: { gp: [entry(393, "lee", "이정현", true), entry(383, "jhj", "주희정")], xfg_made: [], xfg_miss: [], xtp_made: [], xtp_miss: [], xft_made: [], xft_miss: [] },
    });
    const c: RecordContext = { asOf: "x", boards: {}, validated: [] };
    const html = htmlOf(recordBookSection(c, evs, tags, names, { home: "H", away: "A" }, mk({ p1: { gp: { before: 393, after: 394 } } }))!);
    expect(html).toContain("연속 출장 394경기째 KBL 신기록(종전 393경기 · 이정현 보유)");              // 허훈이 진행 중인 이정현 393을 넘는다
    expect(recordBookSection(c, evs, tags, names, { home: "H", away: "A" }, mk({}))).toBeNull();
  });

  it("종료 경기에서 테이블에 없는 항목(validated 밖)은 쓰지 않고, 아무것도 없으면 null", () => {
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/postgameReport.test.ts`

Expected: FAIL — `StreakContext` 미정의(import 전) 또는 `recordBookSection`이 6번째 인자를 받지 않는다. (import는 Step 3에서 테스트 파일에 추가한다.)

- [ ] **Step 3: 연결**

<!-- edit: courtside-web/lib/postgameReport.test.ts -->
<!-- old -->
~~~typescript
  recordBookSection,
~~~
<!-- new -->
~~~typescript
  recordBookSection,
  type StreakContext,
~~~

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~typescript
import { buildAllRecordMoments } from "./recordsMoments";
~~~
<!-- new -->
~~~typescript
import { buildAllRecordMoments } from "./recordsMoments";
import type { StreakContext } from "./streakKinds";
export type { StreakContext } from "./streakKinds";
~~~

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~typescript
export function recordBookSection(ctx: RecordContext, events: GameEvent[], tags: ReportTags, names: RecordNames, sides?: { home: string; away: string }): ReportSection | null {
  const last = new Map<string, RecordMoment>();
  for (const m of buildAllRecordMoments(ctx, events, { names, final: true, ...(sides ?? {}) })) if (m.phase === "done") last.set(`${m.board}|${m.subject}|${m.period}`, m);
~~~
<!-- new -->
~~~typescript
export function recordBookSection(
  ctx: RecordContext,
  events: GameEvent[],
  tags: ReportTags,
  names: RecordNames,
  sides?: { home: string; away: string },
  streaks?: StreakContext | null
): ReportSection | null {
  const last = new Map<string, RecordMoment>();
  for (const m of buildAllRecordMoments(ctx, events, { names, final: true, ...(sides ?? {}) }, streaks)) if (m.phase === "done") last.set(`${m.board}|${m.subject}|${m.period}`, m);
~~~

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~typescript
  if (input.records) {
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
<!-- new -->
~~~typescript
  if (input.records || input.streaks) {
    const book = recordBookSection(
      input.records ?? { asOf: "", boards: {}, validated: [] },
      events,
      tags,
      {
        player: (pcode) => boxByPcode.get(pcode)?.name ?? pcode,
        team: (tcode) => (tcode === homeTcode ? homeTname : tcode === awayTcode ? awayTname : tcode),
      },
      { home: homeTcode, away: awayTcode },
      input.streaks ?? null
    );
~~~

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~typescript
  records?: RecordContext | null;
};
~~~
<!-- new -->
~~~typescript
  records?: RecordContext | null;
  /** 연속 기록(연속 출장·연속 슛) 상태 - 종료 경기라 이 경기 로그 행(before·after)이 들어 있다. 없으면 연속 줄만 빠진다. */
  streaks?: StreakContext | null;
};
~~~

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~typescript
export function recordChanceList(chances: RecordChance[], homeTeam: ReportTeamMeta, awayTeam: ReportTeamMeta): string {
~~~
<!-- new -->
~~~typescript
export function recordChanceList<T extends Pick<RecordChance, "name" | "tcode" | "text" | "detail">>(chances: T[], homeTeam: ReportTeamMeta, awayTeam: ReportTeamMeta): string {
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~typescript
import { buildAllRecordMoments } from "@/lib/recordsMoments";
~~~
<!-- new -->
~~~typescript
import { buildAllRecordMoments } from "@/lib/recordsMoments";
import type { StreakContext } from "@/lib/streakKinds";
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~typescript
  milestones,
  records,
  boxOnly = false,
}: {
~~~
<!-- new -->
~~~typescript
  milestones,
  records,
  streaks,
  boxOnly = false,
}: {
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~typescript
  records?: RecordContext | null;
  // true면 "코트 위" 박스스코어 패널만 그린다
~~~
<!-- new -->
~~~typescript
  records?: RecordContext | null;
  // 연속 기록(연속 출장·경기 간 연속 슛) - page.tsx가 lib/recordStreaks.ts로 "이 경기 직전" 상태와 보드를 만들어 내려준다. 없으면 연속 줄만 없다.
  streaks?: StreakContext | null;
  // true면 "코트 위" 박스스코어 패널만 그린다
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~typescript
      records
        ? buildAllRecordMoments(records, events, {
            names: {
              player: (pcode) => nameByPcode.get(pcode) ?? liveNames?.[pcode] ?? liveCtx.lateNames[pcode] ?? pcode,
              team: (tcode) => (tcode === homeTeam.tcode ? homeTeam.name : tcode === awayTeam.tcode ? awayTeam.name : tcode),
            },
            final: !live,
            home: homeTeam.tcode,
            away: awayTeam.tcode,
          })
        : [],
    [records, events, nameByPcode, liveNames, liveCtx.lateNames, homeTeam, awayTeam, live]
~~~
<!-- new -->
~~~typescript
      records || streaks
        ? buildAllRecordMoments(
            records ?? { asOf: "", boards: {} },
            events,
            {
              names: {
                player: (pcode) => nameByPcode.get(pcode) ?? liveNames?.[pcode] ?? liveCtx.lateNames[pcode] ?? pcode,
                team: (tcode) => (tcode === homeTeam.tcode ? homeTeam.name : tcode === awayTeam.tcode ? awayTeam.name : tcode),
              },
              final: !live,
              home: homeTeam.tcode,
              away: awayTeam.tcode,
            },
            streaks
          )
        : [],
    [records, streaks, events, nameByPcode, liveNames, liveCtx.lateNames, homeTeam, awayTeam, live]
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~typescript
  for (const m of records?.get(newIdx) ?? []) {
    if (m.phase === "done") out.push(recordToast(m));
  }
~~~
<!-- new -->
~~~typescript
  for (const m of records?.get(newIdx) ?? []) {
    if (m.phase === "done" && !m.quiet) out.push(recordToast(m));
  }
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
import { getRecordContext } from "@/lib/recordBook";
~~~
<!-- new -->
~~~typescript
import { getRecordContext } from "@/lib/recordBook";
import { getStreakContext } from "@/lib/recordStreaks";
import { buildStreakChances } from "@/lib/streakMoments";
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
  const recordsPromise = status === "scheduled" ? Promise.resolve(null) : soft("records", getRecordContext(game, status === "final"), null);
~~~
<!-- new -->
~~~typescript
  const recordsPromise = status === "scheduled" ? Promise.resolve(null) : soft("records", getRecordContext(game, status === "final"), null);
  // 연속 기록(연속 출장·연속 슛) 상태 - 이 경기 직전 기준. 예정 경기도 경기 전 "기록 도전"에 필요해서 만든다. 실패하면 그 줄들만 사라진다(soft).
  const streaksPromise = soft(
    "streaks",
    getStreakContext(
      game,
      status === "final",
      playerStats.length > 0
        ? playerStats.map((p) => ({ pcode: p.pcode, name: p.player?.name ?? p.pcode, tcode: p.tcode }))
        : [...liveTcodeByPcode].map(([pcode, tcode]) => ({ pcode, name: livePlayerFallback.get(pcode)?.name ?? pcode, tcode }))
    ),
    null
  );
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
  const milestones = await milestonesPromise;
  const records = await recordsPromise;
~~~
<!-- new -->
~~~typescript
  const milestones = await milestonesPromise;
  const records = await recordsPromise;
  const streaks = await streaksPromise;
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
      milestones,
      records,
    });
  }
~~~
<!-- new -->
~~~typescript
      milestones,
      records,
      streaks,
    });
  }
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
  const recordChances = status !== "final" && milestones ? buildRecordChances(milestones) : [];
  const recordChanceHtml =
    recordChances.length > 0 && game.home_team && game.away_team
      ? recordChanceList(
          recordChances,
~~~
<!-- new -->
~~~typescript
  const recordChances = [...(status !== "final" && milestones ? buildRecordChances(milestones) : []), ...(status !== "final" && streaks ? buildStreakChances(streaks) : [])];
  const recordChanceHtml =
    recordChances.length > 0 && game.home_team && game.away_team
      ? recordChanceList(
          recordChances,
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
        {recordChanceHtml && milestones && (
          <div className="panel">
            <div className="panel-title">기록 도전 (이 경기에서 세울 수 있는 기록)</div>
            <div dangerouslySetInnerHTML={{ __html: recordChanceHtml }} />
            <div className="insight-caveat">{basisNote(milestones.split)} · 평소 기록으로 한 경기에 닿을 만한 것만 골랐습니다.</div>
          </div>
        )}
~~~
<!-- new -->
~~~typescript
        {recordChanceHtml && (
          <div className="panel">
            <div className="panel-title">기록 도전 (이 경기에서 세울 수 있는 기록)</div>
            <div dangerouslySetInnerHTML={{ __html: recordChanceHtml }} />
            <div className="insight-caveat">
              {milestones ? `${basisNote(milestones.split)} · ` : ""}평소 기록으로 한 경기에 닿을 만한 것만 골랐습니다. 연속 기록은 팀 경기 기준(이적해도 이어짐)·선수 본인의 시도 순서 기준입니다.
            </div>
          </div>
        )}
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
            milestones={milestones}
            records={records}
            live={status === "live"}
~~~
<!-- new -->
~~~typescript
            milestones={milestones}
            records={records}
            streaks={streaks}
            live={status === "live"}
~~~

- [ ] **Step 4: 통과 확인**

Run:

```bash
cd courtside-web
npx vitest run lib/postgameReport.test.ts components/MilestoneWatch.test.tsx lib/streakMoments.test.ts
npx tsc --noEmit
npx eslint components/GameReplay.tsx lib/postgameReport.ts "app/games/[gmkey]/page.tsx" --quiet
```

Expected: 통과, `tsc` 출력 없음, `eslint` 에러 없음. `page.tsx`에서 `playerStats`의 `p.player?.name`/`p.tcode` 접근이 milestones 호출부와 같은 모양이라 타입이 맞는다(다르면 그 호출부와 똑같이 맞춘다). 이 파일은 `live`·`liveTcodeByPcode`·`livePlayerFallback` 변수를 `milestonesPromise` 위에서 이미 선언한다.

- [ ] **Step 5: 커밋**

```bash
git add courtside-web/components/GameReplay.tsx courtside-web/lib/postgameReport.ts courtside-web/lib/postgameReport.test.ts "courtside-web/app/games/[gmkey]/page.tsx"
git commit -m "$(cat <<'EOF'
feat(web): streak records on the game page - live panel, quiet toasts, report lines and pre-game challenges

The page builds the streak context next to the milestone and record contexts (soft: a failure only
drops the streak lines), GameReplay merges it into the record moments and skips toasts for quiet
lines, the report section reads it as validated rows of the finished game, and the pre-game
'record chances' panel lists tonight's streak chances too.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 파이썬↔웹 대조 픽스처와 테스트

**Files:**
- Modify: `tools/dump_record_fixtures.py`
- Create: `courtside-web/lib/__fixtures__/streakParity/*.json`(도구가 생성), `courtside-web/lib/records.streaks.parity.test.ts`

**Interfaces:**
- Produces: 픽스처 형식 `{"gmkey","home","away","events":[[pcode,tcode,code,quarter,min,sec,homeScore,awayScore]...],"state":{pcode:{kind:[before,after]}},"single":[[board,subject,value]...]}`, 도구 `--streaks OUTDIR --gmkeys ...`.

- [ ] **Step 1: 도구 확장**

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
def parity_ok(g, official_rows, event_rows):
~~~
<!-- new -->
~~~python
def dump_streaks(outdir, gmkeys):
    """3단계 대조 픽스처 - 경기마다 이벤트, 파이썬 상태기계의 (선수, 종류)별 [전, 후] 길이, 한 경기 안 연속 후보 행."""
    import record_streaks as rs
    os.makedirs(outdir, exist_ok=True)
    _, log = rs.compute(rs.iter_games(), keep_days=None)          # 전체 로그(120일로 자르지 않는다)
    by_game = collections.defaultdict(list)
    for r in log:
        by_game[r["gmkey"]].append(r)
    written = 0
    for gmkey in gmkeys:
        g = rb.load_game(gmkey)
        if g is None or any(v is None for v in rb.player_index(g).values()):
            print(f"  건너뜀(없음/동명이인): {gmkey}")
            continue
        _, bad = rb.shot_sequences(g)
        state = collections.defaultdict(dict)
        for r in by_game.get(gmkey, []):
            if r["kind"] != "gp" and r["kind"][1:].split("_")[0] in bad.get(r["pcode"], ()):
                continue                      # 게이트 탈락 선수-종목은 파이썬이 연속을 끊지만 웹은 이벤트로 이어간다 - 대조 대상이 아니다
            state[r["pcode"]][r["kind"]] = [r["before_len"], r["after_len"]]
        single = [[r["board"], r["subject"], r["value"]] for r in rb.single_shot_candidates(g)]
        with open(os.path.join(outdir, f"{gmkey}.json"), "w", encoding="utf-8") as f:
            json.dump({"gmkey": gmkey, "home": g["home"], "away": g["away"], "events": to_moment_events(g), "state": state, "single": single},
                      f, ensure_ascii=False, separators=(",", ":"))
        carried = sum(1 for kinds in state.values() for k, (b, a) in kinds.items() if k != "gp" and b > 0)
        print(f"  {gmkey}: 선수 {len(state)}명, 이어진 슛 연속 {carried}개, 한 경기 안 행 {len(single)}개")
        written += 1
    print(f"streak fixtures: {written}개 -> {outdir}")


def parity_ok(g, official_rows, event_rows):
~~~

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
    ap.add_argument("--moments", help="2단계(순간 기록) 대조 픽스처를 쓸 폴더 - --gmkeys 필요")
~~~
<!-- new -->
~~~python
    ap.add_argument("--moments", help="2단계(순간 기록) 대조 픽스처를 쓸 폴더 - --gmkeys 필요")
    ap.add_argument("--streaks", help="3단계(연속 기록) 대조 픽스처를 쓸 폴더 - --gmkeys 필요(raw 전체를 한 번 훑어 약 1분)")
~~~

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
    if not (args.parity or args.freq or args.moments):
        ap.error("--parity, --moments, --freq 중 하나가 필요하다")
~~~
<!-- new -->
~~~python
    if not (args.parity or args.freq or args.moments or args.streaks):
        ap.error("--parity, --moments, --streaks, --freq 중 하나가 필요하다")
    if args.streaks:
        dump_streaks(args.streaks, [x.strip() for x in (args.gmkeys or "").split(",") if x.strip()])
~~~

- [ ] **Step 2: 픽스처 생성**

Run (저장소 루트에서):

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" dump_record_fixtures.py --streaks ../courtside-web/lib/__fixtures__/streakParity --gmkeys S23G01N165,S15G01N119,S15G01N121,S43G01N265,S49G01N10,S35G01N31,S33G01N268,S13G01N90,S27G01N227,S23G01N194,S37G01N170,S23G01N15
cd ..
```

Expected: `streak fixtures: 12개`. 경기 12개는 임의 8개 + 기록 연속이 끝난 경기(S15G01N121 서장훈 야투 24, S23G01N194 조성민 자유투 56, S37G01N170 김민수 3점 실패 26, S23G01N15 주희정 383경기째)다 — 긴 연속이 이어져 들어오는 경기를 웹 엔진이 같은 길이로 재현하는지 대조하는 것이 이 테스트의 핵심이다.

- [ ] **Step 3: 대조 테스트 작성**

<!-- create: courtside-web/lib/records.streaks.parity.test.ts -->
~~~typescript
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RecordEvent } from "./records";
import { STREAK_KINDS, type StreakContext, type StreakKind } from "./streakKinds";
import { buildStreakMoments } from "./streakMoments";

// 파이썬 상태기계(tools/record_streaks.py)가 실제 경기에서 계산한 (선수, 종류)별 [경기 전, 경기 후] 연속 길이와 한 경기 안 연속 후보 행을 웹 엔진이
// "경기 전 상태 + 이 경기 이벤트"만으로 똑같이 재현하는지 대조한다. 픽스처는 tools/dump_record_fixtures.py --streaks 로 만든다.

const DIR = process.env.RECORD_STREAK_PARITY_DIR ?? join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "streakParity");
type Fixture = {
  gmkey: string; home: string; away: string;
  events: [string | null, string | null, string, string, number | null, number | null, number, number][];
  state: Record<string, Record<string, [number, number]>>;
  single: [string, string, number][];
};
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => join(DIR, f)) : [];

describe("파이썬 연속 상태 vs 웹 엔진(경기 전 상태 + 이벤트)", () => {
  it("픽스처가 있고 앞 경기에서 10개 이상 이어져 들어온 슛 연속이 충분히 덮인다", () => {
    expect(files.length).toBeGreaterThan(3);
    let carried = 0;
    for (const f of files) for (const kinds of Object.values((JSON.parse(readFileSync(f, "utf8")) as Fixture).state)) for (const [k, [b]] of Object.entries(kinds)) if (k !== "gp" && b >= 10) carried++;
    expect(carried).toBeGreaterThanOrEqual(3);
  });
  for (const file of files) {
    it(file.split(/[\\/]/).slice(-1)[0], () => {
      const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
      const events: RecordEvent[] = fx.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score]) => ({ pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score }));
      const state: StreakContext["state"] = {};
      for (const [pcode, kinds] of Object.entries(fx.state)) for (const [kind, [before]] of Object.entries(kinds)) (state[pcode] ??= {})[kind as StreakKind] = { before };
      const boards = Object.fromEntries(STREAK_KINDS.map((k) => [k, []])) as unknown as StreakContext["boards"];
      const streaks: StreakContext = { asOf: "x", final: false, boards, state, known: Object.keys(fx.state), players: {} };
      const finals = new Map<string, number>();
      buildStreakMoments({ asOf: "x", boards: {} }, streaks, events, { names: { player: (p) => p, team: (t) => t }, final: false, home: fx.home, away: fx.away }, finals);
      // 경기 간 연속: 파이썬 로그가 있는 (선수, 종류) - 슛 종류는 경기 끝 길이가 같고, 연속 출장은 N경기째 = after
      const bad: unknown[] = [];
      for (const [pcode, kinds] of Object.entries(fx.state)) {
        for (const [kind, [, after]] of Object.entries(kinds)) {
          const key = kind === "gp" ? `gp|${pcode}` : `${kind}|${pcode}`;
          if (finals.get(key) !== after) bad.push({ pcode, kind, want: after, got: finals.get(key) });
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
      // 한 경기 안 연속(5 이상): 파이썬 후보 행과 값이 같다
      const badSingle = fx.single.filter(([board, subject, value]) => finals.get(`${board}|G|${subject}|`) !== value);
      expect(badSingle.slice(0, 5)).toEqual([]);
    });
  }
});
~~~

- [ ] **Step 4: 통과 확인**

Run: `cd courtside-web && npx vitest run lib/records.streaks.parity.test.ts && npx tsc --noEmit && npx eslint lib/records.streaks.parity.test.ts`

Expected: 통과. 실패하면 출력의 `want`/`got`이 어긋난 (선수, 종류)다 — 웹 엔진의 연속 규칙(경기 전 상태에서 이어가기, 성공↔실패 전환)이 파이썬과 다른 것이므로 한쪽을 고쳐 맞춘다. (`??=`는 이 테스트 파일에만 쓴다 - 클라이언트 번들이 아니다.)

- [ ] **Step 5: 커밋**

```bash
git add tools/dump_record_fixtures.py courtside-web/lib/__fixtures__/streakParity courtside-web/lib/records.streaks.parity.test.ts
git commit -m "$(cat <<'EOF'
test(records): pin the Python streak state machine and the web engine against real games

The fixtures carry each player's before/after streak lengths from the Python pass over every raw game
(including streaks that cross games) plus the single-game rows; the web engine, started from the
carried-in state, must reproduce them from the game's events alone.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 문서와 전체 확인

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-10-record-book-streaks-design.md`

- [ ] **Step 1: README 운영 런북에 3단계 항목**

<!-- edit: README.md -->
<!-- old -->
~~~text
  통산 평균 순위(득점·리바운드·어시스트·스틸·블록, 정규리그 300경기 이상, 올타임 TOP20·현역 TOP10)는 테이블이 아니라 통산 스냅샷(`career_marks.json`)으로 웹이 계산한다.
~~~
<!-- new -->
~~~text
  통산 평균 순위(득점·리바운드·어시스트·스틸·블록, 정규리그 300경기 이상, 올타임 TOP20·현역 TOP10)는 테이블이 아니라 통산 스냅샷(`career_marks.json`)으로 웹이 계산한다.
- **3단계(2026-10-10, 설계 `docs/superpowers/specs/2026-10-10-record-book-streaks-design.md`)** - 연속 기록. 연속 출장(팀 경기 기준, 이적해도 이어감: 이정현 393경기 진행 중 = KBL 역대 1위,
  종전 주희정 383)과 경기 간 연속 야투·3점·자유투 성공/실패 7개 보드는 `tools/record_streaks.py`가 **raw 전체를 날짜순으로 다시 계산**해 `record_entries`(연속 하나당 한 행,
  period `A:<시작 gmkey>`=진행 중 / `E:`=끝남)와 `record_streak_log`(최근 120일 선수별 전·후 길이, `alive`=지금 이어지는 중)를 통째로 교체한다. 한 경기 안 연속 슛 6개 보드는
  선수-경기 후보(`record_book.single_shot_candidates`). 슛 순서는 그 선수-경기의 이벤트 시도·성공 수가 공식 박스와 같을 때만 믿고(통과율 99%+) 탈락 경기는 연속을 끊는다.
  **노트북에서만 갱신된다**: `--gmkeys`는 `raw/games`에 경기가 5,000개 이상 있을 때만 연속 기록을 다시 계산하고(클라우드 수집기·배치는 오늘 경기뿐이라 건너뜀), 웹은 로그가
  그 팀의 직전 경기까지 반영되지 않았으면(클라우드만 정산한 날) 그 선수의 "오늘 N경기째"를 말하지 않는다. DDL: `schema_record_streak_log.sql` / 롤백 `rollback_record_streak_log.sql`.
~~~

- [ ] **Step 2: 스펙 보정(구현에서 확정된 사항)**

<!-- edit: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md -->
<!-- old -->
~~~text
- 표기(1단계 문법): `연속 출장 394경기째 KBL 신기록 경신 중(종전 383경기 주희정)`,
~~~
<!-- new -->
~~~text
- 구현 메모: 경기 간 연속은 **앞 경기에서 이어진 연속**(그 경기 시작 때 길이 > 0)일 때만 알린다 - 그 경기 안에서 시작한 연속은 한 경기 안 보드가 알려서 한 사건이 두 줄이 되지 않게 했다. 신기록 경신을 매 경기 이어가는 줄은 `RecordMoment.quiet`(토스트 제외).
  한 경기 안 보드 6개는 상태가 없어 `record_book.single_shot_candidates`, 연속 출장·경기 간 연속 7개 보드와 로그는 `tools/record_streaks.py`(순서가 어긋나도 안전하도록 매번 전체 재계산).
- 표기(1단계 문법): `연속 출장 394경기째 KBL 신기록(종전 383경기)`(보유자는 설명 줄 `주희정 보유`),
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
PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_hook.py
cd ..
```

Expected: `tsc` 출력 없음, `eslint` 에러 0, vitest 전체 통과(건너뜀 포함), 파이썬 4종 모두 `실패 없음.`

- [ ] **Step 4: 커밋**

```bash
git add README.md docs/superpowers/specs/2026-10-10-record-book-streaks-design.md docs/superpowers/plans/2026-10-10-record-book-streaks.md
git commit -m "$(cat <<'EOF'
docs(records): streak records runbook, spec notes and the implementation plan

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 로그 테이블 적용 · 전체 적재 · 검증 (**사용자 확인 필요 - 운영 DB 변경**)

**Files:** (코드 변경 없음 - 운영 작업)

**먼저 사용자에게 확인한다**: "공유 Supabase에 새 테이블 `record_streak_log` 1개를 만들고(RLS 켬·정책 없음·anon 권한 회수, 롤백 `DROP TABLE`), `record_entries`를 연속 보드 13개까지 포함해 전체 다시 채웁니다(`record_book.py --rebuild`, 한 트랜잭션). 진행할까요?"

- [ ] **Step 1: 사전 점검(DB 읽기만)**

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild --dry-run
```

Expected: `연속 보드 N행 + 로그 M행`, `보관 행 K개`가 `MAX_ROWS`(20,000) 안, 2분 안쪽.

- [ ] **Step 2: DDL 적용과 익명 차단 확인**

```bash
PYTHONIOENCODING=utf-8 "$PY" -c "import sys; sys.path.insert(0, '.'); from sync_upcoming_games import get_conn; c = get_conn(); cur = c.cursor(); cur.execute(open('schema_record_streak_log.sql', encoding='utf-8').read()); c.commit(); print('schema applied')"
cd ../courtside-web
KEY="$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)"
URL="$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)"
curl -s -o /dev/null -w "%{http_code}\n" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "$URL/rest/v1/record_streak_log?select=gmkey&limit=1"
cd ..
```

Expected: `schema applied`, 익명 조회는 `401`(권한 오류). `200`이면 즉시 `rollback_record_streak_log.sql`을 적용하고 원인을 조사한다.

- [ ] **Step 3: 전체 적재와 검증·멱등성**

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild
PYTHONIOENCODING=utf-8 "$PY" record_book.py --verify
PYTHONIOENCODING=utf-8 "$PY" record_book.py --gmkeys S49G01N9
PYTHONIOENCODING=utf-8 "$PY" record_book.py --verify
cd ..
```

Expected: `교체 완료: N행 + 연속 로그 M행`, `--verify` 두 번 모두 `없는 행 0 / 남는 행 0 / 값이 다른 행 0`과 `연속 로그 검증: 0/0/0`(종료코드 0). `--gmkeys`는 `연속 기록 갱신: {...}`을 찍는다.

- [ ] **Step 4: 알려진 값 확인**

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" -c "import sys; sys.path.insert(0, '.'); from sync_upcoming_games import get_conn; c = get_conn(); cur = c.cursor(); cur.execute(\"select board, value, subject_name, period, gmkey from record_entries where board in ('pg.streak_gp.max','pg.xft_made.max','pg.xfg_made.max') order by board, value desc limit 9\"); [print(r) for r in cur.fetchall()]; cur.execute(\"select pcode, kind, before_len, after_len, alive from record_streak_log where pcode = '290381' and kind = 'gp' order by game_date desc limit 3\"); [print(r) for r in cur.fetchall()]"
cd ..
```

Expected: 연속 출장 1위가 이정현(진행 중 `A:...`, 393 이상), 2위 주희정 383(`E:...`); 자유투 연속 성공 조성민 56, 야투 서장훈 24; 이정현 로그 최신 행 `alive` true.

---

### Task 10: 배포와 프로덕션 검증 (**푸시 전 사용자 확인 필요**)

**Files:** (코드 변경 없음)

**먼저 사용자에게 확인한다**: "로컬 커밋 N개(Task 1~8)를 `main`에 푸시합니다. Vercel이 courtside-web을 배포합니다. 진행할까요?" (진행 중인 경기가 있으면 경기 끝난 뒤를 권한다.)

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
for g in S49G01N8 S49G01N11 S49G01N14; do curl -s -o "$SP/$g.html" -w "$g %{http_code} %{time_total}s\n" --compressed "https://courtside-web-ten.vercel.app/games/$g"; grep -c "Application error" "$SP/$g.html"; done
curl -s --compressed "https://courtside-web-ten.vercel.app/games/S49G01N9" -o "$SP/s49n9.html"; grep -o "1쿼터 어시스트 9개 KBL 신기록(종전 8개 · [^)]*)" "$SP/s49n9.html" | head -1
```

Expected: 모든 경기 200 · `Application error` 0 · 응답시간이 이전과 비슷, 1·2단계 문구 그대로. 연속 줄은 **다음 경기**(예정 경기 페이지의 "기록 도전"에 `오늘 출전하면 연속 출장 N경기째 …`, 라이브 패널 "🏆 역대 기록", 종료 후 리포트)에서 눈으로 확인한다 - 이정현 소속 DB 경기가 있는 날이 가장 좋다.

- [ ] **Step 4: 실패 시 롤백 순서**

웹 문제: 해당 커밋을 `git revert`(새 보드·테이블은 옛 웹이 읽지 않으므로 DB는 그대로 둬도 된다). 파이썬 문제: `tools/record_book.py`·`record_streaks.py`를 이전 커밋으로 되돌려 `--rebuild`. DB 정리: `DELETE FROM record_entries WHERE board IN (<연속 보드 13개>)`, `rollback_record_streak_log.sql`.
