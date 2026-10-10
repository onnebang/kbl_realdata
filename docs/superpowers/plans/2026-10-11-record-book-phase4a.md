# 역대 기록 4단계 A 구현 계획 — 선수 연속 경기 6종 + 팀 연승·연패

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 연속 출장과 같은 방식(정규시즌, 명단 기준)의 선수 연속 경기 기록 6종(득점 10+/20+·더블더블·리바운드 10+·3점슛·어시스트 5+)과 팀 시즌 내 연승·연패를 역대 기록집에 더해 경기 후 리포트·종료 경기 재생·경기 전 "기록 도전"·라이브 토스트로 알린다.

**Architecture:** `tools/record_streaks.py`의 전체 재계산 상태기계에 "정규시즌 명단 기준 조건 연속"(gp를 일반화)과 팀 승패 연속을 얹어 보드 8개와 로그 행을 만든다(DDL 없음, 로그 `pcode` 칸에 팀 코드). 웹은 `streakKinds`/`recordStreaks`가 새 종류의 상태를 읽고, 새 순수 엔진 `lib/gameStreakMoments.ts`가 이벤트로 조건 충족 순간(선수)과 경기 결과(팀)를 판정해 `buildAllRecordMoments`에 합친다.

**Tech Stack:** Python 3.11(venv, 평범한 스크립트 테스트), TypeScript/Next.js 16 + vitest, Supabase Postgres.

**Spec:** `docs/superpowers/specs/2026-10-11-record-book-phase4a-design.md` (이전: `2026-10-10-record-book-streaks-design.md`)

## Global Constraints

- 파이썬은 **반드시** `D:\영상작업\축구\개발\.venv\Scripts\python.exe`(Anaconda 금지). 테스트 실행은 `PYTHONIOENCODING=utf-8`.
- 메인 작업트리에서 수집기가 돈다: `tools/live_collector.py`·`tools/daily_batch.py`는 건드리지 않는다. 브랜치 전환 금지. 다른 세션이 main에 직접 푸시하므로 푸시 전 `git fetch`.
- DB 쓰기(`--rebuild`)와 `git push`는 각각 실행 직전에 사용자 확인을 받는다(Task 6·7). 로컬 커밋은 계획대로. 커밋은 항상 명시한 경로만 `git add`(전체 add 금지). 작업트리의 무관한 untracked 파일(`courtside-web/scratch_goodwin.py`, `.devcontainer/` 등)은 건드리지 않는다.
- 옛 iOS Safari 대상: 클라이언트 번들 파일(`streakKinds.ts`, `streakMoments.ts`, `gameStreakMoments.ts`, `recordsMoments.ts`)에 `.at()`, `.replaceAll()`, `??=` 같은 최신 문법을 쓰지 않는다. 클라이언트 번들 파일은 서버 전용 모듈(`supabaseServer`, `cachePolicy`)을 import하지 않는다.
- 연속 정의: **정규시즌만**, 명단(player-stat 행)에 올라 뛰고(출전 시간 > 0) 조건을 채우면 +1 / 명단에 올랐는데 0분이거나 조건 미달이면 끊김 / 명단에 없던 경기는 건너뜀 / 이적 무관 / 플레이오프·챔프전 무시. 팀 연승·연패는 정규시즌 시즌 안(시즌이 바뀌면 리셋).
- 알림 규칙: 순위가 좋아지거나(10위 안 첫 진입 포함) 이정표일 때만. 신기록을 매 경기 이어가는 줄은 만들지 않는다.
- 사용자에게는 한국어로 보고한다. 푸시 전 `next build` 복사본 점검(Task 7) — 이전에 다른 세션의 Suspense 누락이 배포를 막았다.

---

### Task 1: 파이썬 — 정규시즌 명단 기준 조건 연속(gp 일반화) + 선수 연속 경기 6종

**Files:**
- Modify: `tools/record_streaks.py`, `tools/record_book.py`(`STREAK_BOARDS`), `tools/test_record_streaks.py`

**Interfaces:**
- Produces: `record_streaks.GAME_COND`(kind → `rec` 조건 함수; `gp`는 항상 True), `MIN_ROW_KIND`, 종류 `cg_pts10 cg_pts20 cg_dd cg_reb10 cg_tpm1 cg_ast5`, 보드 `pg.cg_<이름>.max`(bucket G, period `A:/E:<시작 gmkey>`), 로그 kind `cg_*`. `rb.STREAK_BOARDS`는 `BOARD` 값 순서와 같다.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
def game_of(gmkey, date, home, away, specs, start="19:00", season="2026-2027", category="정규시즌"):
    """specs: [(pcode, tcode, tokens)] - tokens가 None이면 명단에 없음(박스에 안 나옴), "dnp"이면 명단에는 올랐지만 0분, ""이면 출전했지만 슛 없음.
    슛 토큰('2+','2-','3+','3-','f+','f-')은 공식 박스(rec)와 이벤트(text-cast)에 같이 반영돼 게이트를 통과한다."""
    players, events, n = [], [], 0
    for pcode, tc, tokens in specs:
        if tokens is None:
            continue
        rec = {"playMin": 0 if tokens == "dnp" else 10, "playSec": 0, "fgt": 0, "fgtA": 0, "threep": 0, "threepA": 0, "ft": 0, "ftA": 0, "score": 0}
        for t in ([] if tokens == "dnp" else tokens.split()):
~~~
<!-- new -->
~~~python
def game_of(gmkey, date, home, away, specs, start="19:00", season="2026-2027", category="정규시즌", score=None):
    """specs: [(pcode, tcode, tokens[, rec 덮어쓰기])] - tokens가 None이면 명단에 없음(박스에 안 나옴), "dnp"이면 명단에는 올랐지만 0분, ""이면 출전했지만 슛 없음.
    슛 토큰('2+','2-','3+','3-','f+','f-')은 공식 박스(rec)와 이벤트(text-cast)에 같이 반영돼 게이트를 통과한다. score=(홈, 원정)은 팀 최종 점수."""
    players, events, n = [], [], 0
    for spec in specs:
        pcode, tc, tokens = spec[:3]
        if tokens is None:
            continue
        rec = {"playMin": 0 if tokens == "dnp" else 10, "playSec": 0, "fgt": 0, "fgtA": 0, "threep": 0, "threepA": 0, "ft": 0, "ftA": 0, "score": 0}
        rec.update(spec[3] if len(spec) > 3 else {})
        for t in ([] if tokens == "dnp" else tokens.split()):
~~~

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
        "players": players, "teams": {home: {"score": 0}, away: {"score": 0}}, "events": events,
~~~
<!-- new -->
~~~python
        "players": players, "teams": {home: {"score": score[0] if score else 0}, away: {"score": score[1] if score else 0}}, "events": events,
~~~

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
        old = rs.MIN_ROW
        rs.MIN_ROW = 2
        try:
            return fn()
        finally:
            rs.MIN_ROW = old
    return run
~~~
<!-- new -->
~~~python
        old, old_kind = rs.MIN_ROW, rs.MIN_ROW_KIND
        rs.MIN_ROW, rs.MIN_ROW_KIND = 2, {}
        try:
            return fn()
        finally:
            rs.MIN_ROW, rs.MIN_ROW_KIND = old, old_kind
    return run
~~~

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
@small_min
def test_shot_runs_carry_across_games_and_show_in_log_and_rows():
~~~
<!-- new -->
~~~python
@small_min
def test_cg_conditions_at_the_boundary():
    a = {"score": 10, "rb": 9, "ast": 4}                                  # 득점 10만
    b = {"score": 20, "rb": 10, "ast": 5, "threep": 1}                    # 전부
    c = {"score": 9, "stl": 10, "bs": 10}                                 # 스틸·블록으로 더블더블만
    d = {"score": 9, "rb": 9, "ast": 4}                                   # 아무것도 못 채움
    g = game_of("S49G01N1", "2026-10-01", "H", "A", [("a", "H", "", a), ("b", "H", "", b), ("c", "A", "", c), ("d", "A", "", d)])
    _, log = rs.compute([g])
    got = sorted((r["pcode"], r["kind"]) for r in log if r["kind"].startswith("cg_") and r["after_len"] == 1)
    assert got == sorted([("a", "cg_pts10"), ("b", "cg_pts10"), ("b", "cg_pts20"), ("b", "cg_dd"), ("b", "cg_reb10"), ("b", "cg_tpm1"), ("b", "cg_ast5"), ("c", "cg_dd")]), got
    assert not [r for r in log if r["pcode"] == "d" and r["kind"].startswith("cg_")]          # 조건 미달 + 이어진 연속 없음 -> 로그 행도 없다


@small_min
def test_cg_a_failed_game_or_a_dnp_entry_breaks_and_unlisted_games_are_skipped():
    ok, low = {"score": 12}, {"score": 5}
    games = [
        game_of("S49G01N1", "2026-10-01", "H", "A", [("p1", "H", "", ok)]),
        game_of("S49G01N2", "2026-10-02", "H", "A", [("p1", "H", "", ok)]),
        game_of("S49G01N3", "2026-10-03", "H", "A", [("p1", "H", "", low)]),              # 뛰었지만 조건 미달 -> 끊김
        game_of("S49G01N4", "2026-10-04", "H", "A", [("p1", "H", "", ok)]),
        game_of("S49G01N5", "2026-10-05", "H", "A", [("p1", "H", None)]),                  # 명단에 없음 -> 건너뜀
        game_of("S49G01N6", "2026-10-06", "H", "A", [("p1", "H", "", ok)]),
        game_of("S49G01N7", "2026-10-07", "H", "A", [("p1", "H", "dnp", ok)]),             # 명단에 올랐는데 0분 -> 끊김
        game_of("S49G01N8", "2026-10-08", "H", "A", [("p1", "H", "", ok)]),
    ]
    rows, log = rs.compute(games)
    assert log_of(log, "p1", "cg_pts10") == [("S49G01N1", 0, 1, False), ("S49G01N2", 1, 2, False), ("S49G01N3", 2, 0, False), ("S49G01N4", 0, 1, False),
                                             ("S49G01N6", 1, 2, False), ("S49G01N7", 2, 0, False), ("S49G01N8", 0, 1, True)]
    assert rows_of(rows, "pg.cg_pts10.max") == [("p1", 2, "E:S49G01N1", "S49G01N2"), ("p1", 2, "E:S49G01N4", "S49G01N6")]


@small_min
def test_cg_playoffs_are_ignored():
    ok = {"score": 12}
    games = [
        game_of("S49G01N1", "2026-10-01", "H", "A", [("p1", "H", "", ok)]),
        game_of("S49G03N1", "2026-10-02", "H", "A", [("p1", "H", "", {"score": 2})], category="플레이오프"),     # 플레이오프의 조건 미달도 끊지 않는다
        game_of("S49G01N2", "2026-10-03", "H", "A", [("p1", "H", "", ok)]),
    ]
    _, log = rs.compute(games)
    assert log_of(log, "p1", "cg_pts10") == [("S49G01N1", 0, 1, False), ("S49G01N2", 1, 2, True)]


@small_min
def test_shot_runs_carry_across_games_and_show_in_log_and_rows():
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py`

Expected: 새 테스트 3개 FAIL(`AttributeError: module 'record_streaks' has no attribute 'MIN_ROW_KIND'`로 `small_min` 래퍼가 먼저 죽는다 — 기존 `@small_min` 테스트도 함께 FAIL).

- [ ] **Step 3: 구현**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
STREAK_BOARDS = ("pg.streak_gp.max", "pg.xfg_made.max", "pg.xfg_miss.max", "pg.xtp_made.max", "pg.xtp_miss.max", "pg.xft_made.max", "pg.xft_miss.max")
~~~
<!-- new -->
~~~python
STREAK_BOARDS = ("pg.streak_gp.max", "pg.xfg_made.max", "pg.xfg_miss.max", "pg.xtp_made.max", "pg.xtp_miss.max", "pg.xft_made.max", "pg.xft_miss.max",
                 "pg.cg_pts10.max", "pg.cg_pts20.max", "pg.cg_dd.max", "pg.cg_reb10.max", "pg.cg_tpm1.max", "pg.cg_ast5.max")
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
KINDS = ("gp", "xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss")
BOARD = {
    "gp": "pg.streak_gp.max",
    "xfg_made": "pg.xfg_made.max", "xfg_miss": "pg.xfg_miss.max",
    "xtp_made": "pg.xtp_made.max", "xtp_miss": "pg.xtp_miss.max",
    "xft_made": "pg.xft_made.max", "xft_miss": "pg.xft_miss.max",
}
STREAK_BOARDS = rb.STREAK_BOARDS
MIN_ROW = 6               # 이보다 짧은 연속은 보드 행 후보가 아니다(보관 순위가 어차피 훨씬 높다)
~~~
<!-- new -->
~~~python
def _ge(key, n):
    return lambda r: (r.get(key) or 0) >= n


def _double_double(r):
    """득점·리바운드·어시스트·스틸·블록 중 2개 이상이 10 이상(2단계 클럽과 같은 정의)."""
    return sum(1 for k in ("score", "rb", "ast", "stl", "bs") if (r.get(k) or 0) >= 10) >= 2


# 정규시즌 '명단 기준' 연속 경기 종류 -> 조건(공식 박스 records). 뛰었고(출전 시간 > 0) 조건을 채우면 +1, 명단에 올랐는데 못 뛰었거나 조건 미달이면 끊김, 명단에 없던 경기는 건너뜀.
# gp(연속 출장)는 조건이 없고 뛰기만 하면 된다.
GAME_COND = {
    "gp": lambda r: True,
    "cg_pts10": _ge("score", 10), "cg_pts20": _ge("score", 20), "cg_dd": _double_double,
    "cg_reb10": _ge("rb", 10), "cg_tpm1": _ge("threep", 1), "cg_ast5": _ge("ast", 5),
}
KINDS = tuple(GAME_COND) + ("xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss")
BOARD = {
    "gp": "pg.streak_gp.max",
    "xfg_made": "pg.xfg_made.max", "xfg_miss": "pg.xfg_miss.max",
    "xtp_made": "pg.xtp_made.max", "xtp_miss": "pg.xtp_miss.max",
    "xft_made": "pg.xft_made.max", "xft_miss": "pg.xft_miss.max",
    "cg_pts10": "pg.cg_pts10.max", "cg_pts20": "pg.cg_pts20.max", "cg_dd": "pg.cg_dd.max",
    "cg_reb10": "pg.cg_reb10.max", "cg_tpm1": "pg.cg_tpm1.max", "cg_ast5": "pg.cg_ast5.max",
}
STREAK_BOARDS = rb.STREAK_BOARDS
MIN_ROW = 6               # 이보다 짧은 연속은 보드 행 후보가 아니다(보관 순위가 어차피 훨씬 높다)
MIN_ROW_KIND = {k: 8 for k in GAME_COND if k != "gp"}      # 선수 연속 경기 종류는 더 길어야 후보(10위 값이 15~55)
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
    gp = {}                                          # pcode -> {"len", "start", "last", "tc"} - 정규시즌 연속 출장
~~~
<!-- new -->
~~~python
    game_runs = {k: {} for k in GAME_COND}           # 종류 -> pcode -> {"len", "start", "last", "tc"} - 정규시즌 명단 기준 연속(연속 출장 포함)
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
        if run["len"] < MIN_ROW:
            return
~~~
<!-- new -->
~~~python
        if run["len"] < MIN_ROW_KIND.get(kind, MIN_ROW):
            return
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
        # --- 연속 출장 (정규시즌만): 명단에 올라 뛰면 +1, 명단에 올랐는데 못 뛰면 끊김, 명단에 없으면 그대로
        if regular:
            for p in g["players"]:
                pc, tc = p["pcode"], p["tcode"]
                st = gp.get(pc)
                if rb.played_seconds(p["rec"]) > 0:
                    before = st["len"] if st else 0
                    start = st["start"] if st else n
                    gp[pc] = {"len": before + 1, "start": start, "last": n, "tc": tc}
                    add_log(lg, pc, "gp", before, before + 1, start)
                elif st:
                    emit("gp", pc, {"len": st["len"], "start": st["start"], "end": st["last"], "tc": st["tc"]}, False)
                    add_log(lg, pc, "gp", st["len"], 0, st["start"])
                    del gp[pc]
~~~
<!-- new -->
~~~python
        # --- 연속 출장 + 연속 경기 6종 (정규시즌만): 명단에 올라 뛰고 조건을 채우면 +1, 명단에 올랐는데 못 뛰었거나 조건 미달이면 끊김, 명단에 없으면 그대로
        if regular:
            for p in g["players"]:
                pc, tc = p["pcode"], p["tcode"]
                played = rb.played_seconds(p["rec"]) > 0
                for kind, cond in GAME_COND.items():
                    runs_k = game_runs[kind]
                    st = runs_k.get(pc)
                    if played and cond(p["rec"]):
                        before = st["len"] if st else 0
                        start = st["start"] if st else n
                        runs_k[pc] = {"len": before + 1, "start": start, "last": n, "tc": tc}
                        add_log(lg, pc, kind, before, before + 1, start)
                    elif st:
                        emit(kind, pc, {"len": st["len"], "start": st["start"], "end": st["last"], "tc": st["tc"]}, False)
                        add_log(lg, pc, kind, st["len"], 0, st["start"])
                        del runs_k[pc]
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
    for pc, st in gp.items():
        seen = last_seen.get(pc)
        alive = seen is not None and info[seen]["date"] >= cutoff       # 최근 120일 안에 뛰었으면 '지금 이어지는 중'(명단에 없던 경기는 끊지 않는다)
        emit("gp", pc, {"len": st["len"], "start": st["start"], "end": st["last"], "tc": st["tc"]}, alive)
        if alive and (pc, "gp") in latest_log:
            latest_log[(pc, "gp")]["alive"] = True
~~~
<!-- new -->
~~~python
    for kind, runs_k in game_runs.items():
        for pc, st in runs_k.items():
            seen = last_seen.get(pc)
            alive = seen is not None and info[seen]["date"] >= cutoff   # 최근 120일 안에 뛰었으면 '지금 이어지는 중'(명단에 없던 경기는 끊지 않는다)
            emit(kind, pc, {"len": st["len"], "start": st["start"], "end": st["last"], "tc": st["tc"]}, alive)
            if alive and (pc, kind) in latest_log:
                latest_log[(pc, kind)]["alive"] = True
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
- 보드 행 7개(`BOARD`): 연속 하나당 한 행.
~~~
<!-- new -->
~~~python
- 선수 연속 경기 6종(4단계 A, 설계 `2026-10-11-record-book-phase4a-design.md`): 연속 출장과 같은 틀에 조건만 얹는다(`GAME_COND` - 득점 10+/20+·더블더블·리바운드 10+·3점슛 1+·어시스트 5+).
- 보드 행(`BOARD`): 연속 하나당 한 행.
~~~

- [ ] **Step 4: 통과 확인**

Run:

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py
```

Expected: 모두 `실패 없음.` (기존 gp 테스트와 `test_per_game_apply_never_touches_streak_rows`의 `BOARD.values() == rb.STREAK_BOARDS` 단언 포함)

- [ ] **Step 5: 커밋**

```bash
git add tools/record_streaks.py tools/record_book.py tools/test_record_streaks.py
git commit -m "$(cat <<'EOF'
feat(records): consecutive-game streaks for six conditions on the roster-based rules of games played

gp becomes one of GAME_COND: a regular-season roster entry that plays and meets the condition adds one,
a roster entry with zero minutes or a missed condition breaks, an unlisted game is skipped, playoffs are
ignored. New kinds: 10+/20+ points, double-double, 10+ rebounds, a made three, 5+ assists.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 파이썬 — 팀 연승·연패 + 실데이터 단언

**Files:**
- Modify: `tools/record_streaks.py`, `tools/record_book.py`(`STREAK_BOARDS`), `tools/test_record_streaks.py`, `tools/rollback_record_streak_log.sql`

**Interfaces:**
- Consumes: Task 1의 `emit`/`add_log`/`game_runs` 구조
- Produces: 종류 `tw`, `tl`; 보드 `tg.win_streak.max`, `tg.loss_streak.max`(subject = tcode); 로그 `(gmkey, pcode=tcode, kind=tw|tl)`. `TEAM_KINDS = ("tw", "tl")`.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
@small_min
def test_shot_runs_carry_across_games_and_show_in_log_and_rows():
~~~
<!-- new -->
~~~python
@small_min
def test_team_streaks_reset_each_season_and_ignore_playoffs():
    s1, s2 = "2025-2026", "2026-2027"
    games = [
        game_of("S47G01N1", "2025-10-01", "H", "A", [], season=s1, score=(80, 70)),                              # H 승
        game_of("S47G01N2", "2025-10-02", "H", "A", [], season=s1, score=(90, 85)),                              # H 승
        game_of("S47G03N1", "2025-10-03", "A", "H", [], season=s1, score=(100, 60), category="플레이오프"),       # 플레이오프는 세지도 끊지도 않는다
        game_of("S47G01N3", "2025-10-04", "H", "A", [], season=s1, score=(75, 74)),                              # H 승 -> H 3연승
        game_of("S47G01N4", "2025-10-05", "A", "H", [], season=s1, score=(88, 70)),                              # A 승 -> H 3연승 끝, A 3연패 끝
        game_of("S49G01N1", "2026-10-01", "H", "A", [], season=s2, score=(60, 70)),                              # 새 시즌: 열린 연속은 닫히고 처음부터
    ]
    rows, log = rs.compute(games, keep_days=None)
    assert log_of(log, "H", "tw") == [("S47G01N1", 0, 1, False), ("S47G01N2", 1, 2, False), ("S47G01N3", 2, 3, False), ("S47G01N4", 3, 0, False)]
    assert log_of(log, "H", "tl") == [("S47G01N4", 0, 1, False), ("S49G01N1", 0, 1, True)]
    assert log_of(log, "A", "tl") == [("S47G01N1", 0, 1, False), ("S47G01N2", 1, 2, False), ("S47G01N3", 2, 3, False), ("S47G01N4", 3, 0, False)]
    assert log_of(log, "A", "tw") == [("S47G01N4", 0, 1, False), ("S49G01N1", 0, 1, True)]
    assert rows_of(rows, "tg.win_streak.max") == [("H", 3, "E:S47G01N1", "S47G01N3")]
    assert rows_of(rows, "tg.loss_streak.max") == [("A", 3, "E:S47G01N1", "S47G01N3")]


@small_min
def test_team_streaks_skip_games_without_a_decisive_official_score():
    games = [game_of("S49G01N1", "2026-10-01", "H", "A", [], score=(70, 70)), game_of("S49G01N2", "2026-10-02", "H", "A", [])]       # 동점·점수 0:0은 건너뜀
    _, log = rs.compute(games)
    assert not [r for r in log if r["kind"] in ("tw", "tl")]


@small_min
def test_shot_runs_carry_across_games_and_show_in_log_and_rows():
~~~

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
    alive = [r for r in log if r["pcode"] == "290381" and r["kind"] == "gp" and r["alive"]]
~~~
<!-- new -->
~~~python
    for board, name, value in (("pg.cg_pts10.max", "데이비드 사이먼", 146), ("pg.cg_pts20.max", "피트 마이클", 42), ("pg.cg_dd.max", "리카르도 라틀리프", 59),
                               ("pg.cg_reb10.max", "리카르도 라틀리프", 59), ("pg.cg_tpm1.max", "전성현", 76), ("pg.cg_ast5.max", "주희정", 27)):
        t = top(board)[0]
        assert (t["subject_name"], t["value"]) == (name, value), (board, t)                                                                  # 2026-10-11 raw 실측
    tw = top("tg.win_streak.max")[0]
    assert (tw["value"], tw["subject"], tw["period"][:2]) == (16, "16", "E:"), tw                                                            # 원주 DB 2011-12 16연승
    tl = top("tg.loss_streak.max")[0]
    assert tl["value"] == 14, tl                                                                                                             # 서울 삼성 2011-12 · 원주 DB 2013-14 14연패(공동)
    alive = [r for r in log if r["pcode"] == "290381" and r["kind"] == "gp" and r["alive"]]
~~~

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
    assert tuple(rs.BOARD.values()) == rb.STREAK_BOARDS == rs.STREAK_BOARDS
~~~
<!-- new -->
~~~python
    assert tuple(rs.BOARD.values()) == rb.STREAK_BOARDS == rs.STREAK_BOARDS and len(rb.STREAK_BOARDS) == 15
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py`

Expected: 팀 테스트 2개와 `test_per_game_apply_never_touches_streak_rows`(15개 단언) FAIL.

- [ ] **Step 3: 구현**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
                 "pg.cg_pts10.max", "pg.cg_pts20.max", "pg.cg_dd.max", "pg.cg_reb10.max", "pg.cg_tpm1.max", "pg.cg_ast5.max")
~~~
<!-- new -->
~~~python
                 "pg.cg_pts10.max", "pg.cg_pts20.max", "pg.cg_dd.max", "pg.cg_reb10.max", "pg.cg_tpm1.max", "pg.cg_ast5.max",
                 "tg.win_streak.max", "tg.loss_streak.max")
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
KINDS = tuple(GAME_COND) + ("xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss")
~~~
<!-- new -->
~~~python
TEAM_KINDS = ("tw", "tl")      # 팀 시즌 내 연승 / 연패 - 로그의 pcode 칸에 팀 코드를 넣는다(선수 코드는 6자리 숫자, 팀 코드는 2자리라 겹치지 않는다)
KINDS = tuple(GAME_COND) + ("xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss") + TEAM_KINDS
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
    "cg_reb10": "pg.cg_reb10.max", "cg_tpm1": "pg.cg_tpm1.max", "cg_ast5": "pg.cg_ast5.max",
}
~~~
<!-- new -->
~~~python
    "cg_reb10": "pg.cg_reb10.max", "cg_tpm1": "pg.cg_tpm1.max", "cg_ast5": "pg.cg_ast5.max",
    "tw": "tg.win_streak.max", "tl": "tg.loss_streak.max",
}
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
MIN_ROW_KIND = {k: 8 for k in GAME_COND if k != "gp"}      # 선수 연속 경기 종류는 더 길어야 후보(10위 값이 15~55)
~~~
<!-- new -->
~~~python
MIN_ROW_KIND = {**{k: 8 for k in GAME_COND if k != "gp"}, "tw": 6, "tl": 6}      # 선수 연속 경기 종류는 더 길어야 후보(10위 값이 15~55), 팀 연승·연패는 10위 값이 12
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
    game_runs = {k: {} for k in GAME_COND}           # 종류 -> pcode -> {"len", "start", "last", "tc"} - 정규시즌 명단 기준 연속(연속 출장 포함)
~~~
<!-- new -->
~~~python
    game_runs = {k: {} for k in GAME_COND}           # 종류 -> pcode -> {"len", "start", "last", "tc"} - 정규시즌 명단 기준 연속(연속 출장 포함)
    team = {}                                        # tcode -> {"season", "tw": run, "tl": run, "last": 경기 번호} - 정규시즌 시즌 내 연승·연패
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
                        add_log(lg, pc, kind, st["len"], 0, st["start"])
                        del runs_k[pc]
~~~
<!-- new -->
~~~python
                        add_log(lg, pc, kind, st["len"], 0, st["start"])
                        del runs_k[pc]
            # --- 팀 연승·연패: 공식 최종 점수로 승패가 갈린 정규시즌 경기, 시즌이 바뀌면 처음부터
            hs, as_ = (g["teams"].get(g["home"]) or {}).get("score"), (g["teams"].get(g["away"]) or {}).get("score")
            if isinstance(hs, int) and isinstance(as_, int) and hs != as_:
                for tc, won in ((g["home"], hs > as_), (g["away"], as_ > hs)):
                    names[tc] = g["names"].get(tc, tc)
                    st = team.get(tc)
                    if st and st["season"] != g["season"]:
                        for kind in TEAM_KINDS:
                            if st[kind]["len"] > 0:
                                emit(kind, tc, st[kind], False)
                        st = None
                    if st is None:
                        st = team[tc] = {"season": g["season"], "tw": _new_run(), "tl": _new_run(), "last": n}
                    cur_k, oth_k = ("tw", "tl") if won else ("tl", "tw")
                    if st[oth_k]["len"] > 0:
                        add_log(lg, tc, oth_k, st[oth_k]["len"], 0, st[oth_k]["start"])
                        emit(oth_k, tc, st[oth_k], False)
                        st[oth_k] = _new_run()
                    before = st[cur_k]["len"]
                    st[cur_k] = {"len": before + 1, "start": st[cur_k]["start"] if before else n, "end": n, "tc": tc}
                    st["last"] = n
                    add_log(lg, tc, cur_k, before, before + 1, st[cur_k]["start"])
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
            if alive and (pc, kind) in latest_log:
                latest_log[(pc, kind)]["alive"] = True
~~~
<!-- new -->
~~~python
            if alive and (pc, kind) in latest_log:
                latest_log[(pc, kind)]["alive"] = True
    for tc, st in team.items():
        alive = info[st["last"]]["date"] >= cutoff
        for kind in TEAM_KINDS:
            if st[kind]["len"] > 0:
                emit(kind, tc, st[kind], alive)
                if alive and (tc, kind) in latest_log:
                    latest_log[(tc, kind)]["alive"] = True
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
- 보드 행(`BOARD`): 연속 하나당 한 행.
~~~
<!-- new -->
~~~python
- 팀 연승·연패(`tw`/`tl`): 정규시즌 시즌 안에서 이어진 연속 승리/패배(공식 최종 점수, 시즌이 바뀌면 리셋). 로그의 pcode 칸에 팀 코드를 넣는다.
- 보드 행(`BOARD`): 연속 하나당 한 행.
~~~

<!-- edit: tools/rollback_record_streak_log.sql -->
<!-- old -->
~~~sql
-- ('pg.streak_gp.max','pg.xfg_made.max','pg.xfg_miss.max','pg.xtp_made.max','pg.xtp_miss.max','pg.xft_made.max','pg.xft_miss.max');
~~~
<!-- new -->
~~~sql
-- ('pg.streak_gp.max','pg.xfg_made.max','pg.xfg_miss.max','pg.xtp_made.max','pg.xtp_miss.max','pg.xft_made.max','pg.xft_miss.max',
--  'pg.cg_pts10.max','pg.cg_pts20.max','pg.cg_dd.max','pg.cg_reb10.max','pg.cg_tpm1.max','pg.cg_ast5.max','tg.win_streak.max','tg.loss_streak.max');
~~~

- [ ] **Step 4: 통과 확인(합성 + 실데이터 + 전체 드라이런)**

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

Expected: 합성 테스트 전부 통과, 슬로우 실데이터 단언 통과(걸리면 단언 값을 실제 값으로 고치기 전에 이름·정의 차이를 먼저 확인), `--rebuild --dry-run`은 `연속 보드 N행 + 로그 M행`과 `보관 행 K개`(MAX_ROWS 20,000 이내)를 찍고 약 2분 안쪽.

- [ ] **Step 5: 커밋**

```bash
git add tools/record_streaks.py tools/record_book.py tools/test_record_streaks.py tools/rollback_record_streak_log.sql
git commit -m "$(cat <<'EOF'
feat(records): team win and loss streaks within a regular season

Official final scores decide each regular-season game; a new season restarts every team's run.
Rows and log entries use the same shape as the player streaks, with the team code in the log's pcode
column. STREAK_BOARDS now has 15 boards.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 웹 — 새 종류 정의와 서버 컨텍스트(팀 상태·정규시즌 판정·시즌 일치)

**Files:**
- Modify: `courtside-web/lib/streakKinds.ts`, `courtside-web/lib/recordStreaks.ts`, `courtside-web/lib/recordStreaks.test.ts`, `courtside-web/lib/postgameReport.test.ts`(boards 리터럴에 새 종류)

**Interfaces:**
- Consumes: Task 1·2의 보드·로그 종류 이름
- Produces: `STREAK_KINDS`(15종), `STREAK_BOARD`, `GAME_BASED_KINDS`, `CG_KINDS`, `TEAM_KINDS`, `isTeamKind(kind)`, `StreakContext.teams?: Record<string, string>`, `StreakLogRow.start_gmkey`, `summarizeStreaks({..., teams?, regular?})`(팀 코드도 `known`/`state`에 포함, 정규시즌이 아니면 `GAME_BASED_KINDS` 상태 버림, 비종료 팀 상태는 시즌이 같을 때만).

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- edit: courtside-web/lib/recordStreaks.test.ts -->
<!-- old -->
~~~typescript
const logRow = (gmkey: string, pcode: string, kind: string, before: number, after: number, alive: boolean): StreakLogRow => ({ gmkey, pcode, kind, before_len: before, after_len: after, alive });
~~~
<!-- new -->
~~~typescript
const logRow = (gmkey: string, pcode: string, kind: string, before: number, after: number, alive: boolean, start = "S49G01N1"): StreakLogRow => ({
  gmkey, pcode, kind, before_len: before, after_len: after, alive, start_gmkey: start,
});
~~~

<!-- edit: courtside-web/lib/recordStreaks.test.ts -->
<!-- old -->
~~~typescript
  it("보드도 상태도 없으면 null", () => {
~~~
<!-- new -->
~~~typescript
  it("정규시즌이 아니면 연속 출장·연속 경기·팀 연승 상태를 모두 버린다(슛 연속만 남는다)", () => {
    const rows = [
      logRow("S49G01N10", "lee", "gp", 745, 746, true),
      logRow("S49G01N10", "lee", "cg_pts10", 3, 4, true),
      logRow("S49G01N10", "DB", "tw", 4, 5, true, "S49G01N5"),
      logRow("S49G01N10", "lee", "xft_made", 4, 5, true),
    ];
    const po = summarizeStreaks({ ...base, final: false, freshTeams: new Set(["DB"]), boardRows: [], logRows: rows, regular: false, teams: { DB: "원주 DB" } })!;
    expect(po.state).toEqual({ lee: { xft_made: { before: 5 } } });
  });

  it("팀 연승·연패: 신선한 팀의 alive 행만, 같은 시즌의 연속만, known에 팀 코드가 들어간다", () => {
    const rows = [
      logRow("S49G01N10", "DB", "tw", 4, 5, true, "S49G01N5"),    // 이번 시즌 5연승 진행 중
      logRow("S49G01N10", "KT", "tl", 2, 3, true, "S49G01N8"),    // KT는 로그가 신선하지 않다
      logRow("S49G01N10", "SK", "tw", 7, 8, true, "S47G01N200"),  // 지난 시즌 연승 - 새 시즌 경기로 이어지지 않는다
    ];
    const ctx = summarizeStreaks({ ...base, final: false, freshTeams: new Set(["DB", "SK"]), boardRows: [], logRows: rows, teams: { DB: "원주 DB", KT: "부산 KT", SK: "서울 SK" } })!;
    expect(ctx.state).toEqual({ DB: { tw: { before: 5 } }, KT: { tl: { before: 3 } } });          // 상태는 읽되 KT는 신선하지 않아 known에서 빠진다, SK는 시즌이 달라 버린다
    expect(ctx.known).toEqual(expect.arrayContaining(["DB", "SK"]));
    expect(ctx.known).not.toContain("KT");
    expect(ctx.teams).toEqual({ DB: "원주 DB", KT: "부산 KT", SK: "서울 SK" });
  });

  it("종료 경기: 팀 상태는 이 경기 행의 before·after, known은 팀 전원", () => {
    const rows = [logRow("S49G01N11", "DB", "tw", 4, 5, false, "S49G01N5"), logRow("S49G01N11", "KT", "tl", 2, 3, false, "S49G01N8")];
    const ctx = summarizeStreaks({ ...base, final: true, freshTeams: null, boardRows: [], logRows: rows, teams: { DB: "원주 DB", KT: "부산 KT" } })!;
    expect(ctx.state).toEqual({ DB: { tw: { before: 4, after: 5 } }, KT: { tl: { before: 2, after: 3 } } });
    expect(ctx.known).toEqual(expect.arrayContaining(["DB", "KT"]));
  });

  it("새 보드 8개를 종류별로 읽는다", () => {
    const ctx = summarizeStreaks({
      ...base, final: false, freshTeams: new Set(), logRows: [],
      boardRows: [board("pg.cg_pts20.max", "p", 42, "E:x", "마이클"), board("tg.win_streak.max", "16", 16, "E:y", "원주 DB"), board("tg.loss_streak.max", "35", 14, "E:z", "서울 삼성")],
    })!;
    expect(ctx.boards.cg_pts20[0]).toMatchObject({ v: 42, pcode: "p", who: "마이클", active: false });
    expect(ctx.boards.tw[0].who).toBe("원주 DB");
    expect(ctx.boards.tl[0].v).toBe(14);
  });

  it("보드도 상태도 없으면 null", () => {
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/recordStreaks.test.ts`

Expected: FAIL — 새 종류가 없어 `boards.cg_pts20` 등이 undefined이고 `start_gmkey`가 타입에 없다.

- [ ] **Step 3: 구현**

<!-- edit: courtside-web/lib/streakKinds.ts -->
<!-- old -->
~~~typescript
export const STREAK_KINDS = ["gp", "xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss"] as const;
export type StreakKind = (typeof STREAK_KINDS)[number];
~~~
<!-- new -->
~~~typescript
export const STREAK_KINDS = [
  "gp", "xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss",
  "cg_pts10", "cg_pts20", "cg_dd", "cg_reb10", "cg_tpm1", "cg_ast5", "tw", "tl",
] as const;
export type StreakKind = (typeof STREAK_KINDS)[number];
/** 선수 연속 경기 6종(4단계 A) - 정규시즌 명단 기준 */
export const CG_KINDS = ["cg_pts10", "cg_pts20", "cg_dd", "cg_reb10", "cg_tpm1", "cg_ast5"] as const;
export type CgKind = (typeof CG_KINDS)[number];
/** 팀 시즌 내 연승·연패 - 로그의 pcode 칸에 팀 코드가 들어간다 */
export const TEAM_KINDS = ["tw", "tl"] as const;
export const isTeamKind = (k: StreakKind) => k === "tw" || k === "tl";
/** 정규시즌 경기에서만 의미가 있는 종류 - 플레이오프·챔프전에서는 상태를 쓰지 않는다(슛 연속만 유지). */
export const GAME_BASED_KINDS: readonly StreakKind[] = ["gp", ...CG_KINDS, ...TEAM_KINDS];
~~~

<!-- edit: courtside-web/lib/streakKinds.ts -->
<!-- old -->
~~~typescript
  xft_miss: "pg.xft_miss.max",
};
~~~
<!-- new -->
~~~typescript
  xft_miss: "pg.xft_miss.max",
  cg_pts10: "pg.cg_pts10.max",
  cg_pts20: "pg.cg_pts20.max",
  cg_dd: "pg.cg_dd.max",
  cg_reb10: "pg.cg_reb10.max",
  cg_tpm1: "pg.cg_tpm1.max",
  cg_ast5: "pg.cg_ast5.max",
  tw: "tg.win_streak.max",
  tl: "tg.loss_streak.max",
};
~~~

<!-- edit: courtside-web/lib/streakKinds.ts -->
<!-- old -->
~~~typescript
  known: string[];
  players: Record<string, { name: string; tcode?: string }>;
};
~~~
<!-- new -->
~~~typescript
  known: string[];
  players: Record<string, { name: string; tcode?: string }>;
  /** 이 경기 두 팀의 표시 이름(tcode -> 이름) - 팀 연승·연패 줄 문구용. 팀 코드도 `known`/`state`의 키로 쓴다. */
  teams?: Record<string, string>;
};
~~~

<!-- edit: courtside-web/lib/postgameReport.test.ts -->
<!-- old -->
~~~typescript
xfg_made: [], xfg_miss: [], xtp_made: [], xtp_miss: [], xft_made: [], xft_miss: [] },
~~~
<!-- new -->
~~~typescript
xfg_made: [], xfg_miss: [], xtp_made: [], xtp_miss: [], xft_made: [], xft_miss: [], cg_pts10: [], cg_pts20: [], cg_dd: [], cg_reb10: [], cg_tpm1: [], cg_ast5: [], tw: [], tl: [] },
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
import { KIND_OF_BOARD, STREAK_BOARD, STREAK_KINDS, type StreakContext, type StreakEntry, type StreakKind } from "./streakKinds";
~~~
<!-- new -->
~~~typescript
import { GAME_BASED_KINDS, isTeamKind, KIND_OF_BOARD, STREAK_BOARD, STREAK_KINDS, type StreakContext, type StreakEntry, type StreakKind } from "./streakKinds";
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
export type StreakLogRow = { gmkey: string; pcode: string; kind: string; before_len: number; after_len: number; alive: boolean };
~~~
<!-- new -->
~~~typescript
/** pcode: 선수 코드(팀 연승·연패 종류는 팀 코드). start_gmkey: 그 연속이 시작된 경기 */
export type StreakLogRow = { gmkey: string; pcode: string; kind: string; before_len: number; after_len: number; alive: boolean; start_gmkey: string };
const seasonOf = (gmkey: string) => gmkey.split("G")[0];
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
  /** 정규시즌 경기인가 - 연속 출장은 정규시즌만 세므로 플레이오프·챔프전에서는 그 상태를 쓰지 않는다(기본 true). */
  regular?: boolean;
}): StreakContext | null {
~~~
<!-- new -->
~~~typescript
  /** 정규시즌 경기인가 - 연속 출장·연속 경기·팀 연승/연패는 정규시즌만 세므로 플레이오프·챔프전에서는 그 상태를 쓰지 않는다(기본 true). */
  regular?: boolean;
  /** 이 경기 두 팀의 표시 이름(tcode -> 이름) */
  teams?: Record<string, string>;
}): StreakContext | null {
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
    if (args.final || (p.tcode != null && args.freshTeams != null && args.freshTeams.has(p.tcode))) known.push(pcode);
  }
  const state: StreakContext["state"] = {};
  for (const r of args.logRows) {
    const kind = STREAK_KINDS.find((k) => k === r.kind);
    if (!kind || (kind === "gp" && args.regular === false)) continue;
    if (args.final ? r.gmkey !== args.gmkey : !r.alive) continue;
~~~
<!-- new -->
~~~typescript
    if (args.final || (p.tcode != null && args.freshTeams != null && args.freshTeams.has(p.tcode))) known.push(pcode);
  }
  for (const tcode of Object.keys(args.teams ?? {})) {
    if (args.final || (args.freshTeams != null && args.freshTeams.has(tcode))) known.push(tcode);
  }
  const state: StreakContext["state"] = {};
  for (const r of args.logRows) {
    const kind = STREAK_KINDS.find((k) => k === r.kind);
    if (!kind) continue;
    if (args.regular === false && GAME_BASED_KINDS.indexOf(kind) >= 0) continue;
    if (args.final ? r.gmkey !== args.gmkey : !r.alive) continue;
    // 팀 연승·연패는 시즌 안에서만 이어진다 - 지난 시즌에 시작된 연속은 새 시즌 경기 전에 쓰지 않는다
    if (!args.final && isTeamKind(kind) && seasonOf(r.start_gmkey) !== seasonOf(args.gmkey)) continue;
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
  return { asOf: args.asOf, final: args.final, boards, state, known, players: args.players };
}
~~~
<!-- new -->
~~~typescript
  return { asOf: args.asOf, final: args.final, boards, state, known, players: args.players, ...(args.teams ? { teams: args.teams } : {}) };
}
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
    const { data, error } = await supabase.from("record_streak_log").select("gmkey, pcode, kind, before_len, after_len, alive").eq("gmkey", gmkey).limit(3000);
~~~
<!-- new -->
~~~typescript
    const { data, error } = await supabase.from("record_streak_log").select("gmkey, pcode, kind, before_len, after_len, alive, start_gmkey").eq("gmkey", gmkey).limit(3000);
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
    const { data, error } = await supabase.from("record_streak_log").select("gmkey, pcode, kind, before_len, after_len, alive").in("pcode", pcodes).eq("alive", true).limit(5000);
~~~
<!-- new -->
~~~typescript
    const { data, error } = await supabase.from("record_streak_log").select("gmkey, pcode, kind, before_len, after_len, alive, start_gmkey").in("pcode", pcodes).eq("alive", true).limit(5000);
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
    home_team?: { tcode: string } | null; away_team?: { tcode: string } | null;
  },
~~~
<!-- new -->
~~~typescript
    home_team?: { tcode: string; name?: string } | null; away_team?: { tcode: string; name?: string } | null;
  },
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
  const [boardRows, logRows] = await Promise.all([fetchStreakBoards(), final ? fetchLogByGame(game.gmkey) : fetchAliveLog(Object.keys(players).sort().join(","))]);
  return summarizeStreaks({ boardRows, logRows, gmkey: game.gmkey, final, asOf: `${game.game_date} ${start}`.trim(), players, freshTeams, regular: game.season_category === "정규시즌" });
~~~
<!-- new -->
~~~typescript
  const teams: Record<string, string> = {};
  for (const t of [game.home_team, game.away_team]) if (t?.tcode) teams[t.tcode] = t.name ?? t.tcode;
  const [boardRows, logRows] = await Promise.all([fetchStreakBoards(), final ? fetchLogByGame(game.gmkey) : fetchAliveLog(Object.keys(players).concat(tcodes).sort().join(","))]);
  return summarizeStreaks({ boardRows, logRows, gmkey: game.gmkey, final, asOf: `${game.game_date} ${start}`.trim(), players, freshTeams, regular: game.season_category === "정규시즌", teams });
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
/** 연속 보드 7개의 보관 행 전부(수백 행) - 10분 캐시, 정산이 'records' 태그로 즉시 비운다. 조회 에러는 던진다(빈 배열을 캐시에 굳히지 않는다). */
~~~
<!-- new -->
~~~typescript
/** 연속 보드 15개의 보관 행 전부(수백~천 행) - 10분 캐시, 정산이 'records' 태그로 즉시 비운다. 조회 에러는 던진다(빈 배열을 캐시에 굳히지 않는다). */
~~~

- [ ] **Step 4: 통과 확인**

Run:

```bash
cd courtside-web
npx vitest run lib/recordStreaks.test.ts lib/streakMoments.test.ts
npx tsc --noEmit
npx eslint lib/streakKinds.ts lib/recordStreaks.ts lib/recordStreaks.test.ts --quiet
```

Expected: 통과, `tsc`·`eslint` 출력 없음. (`.order("board")...range()` 페이지네이션이 이미 1000행 단위라 15개 보드 행 수가 늘어도 그대로 동작한다.)

- [ ] **Step 5: 커밋**

```bash
git add courtside-web/lib/streakKinds.ts courtside-web/lib/recordStreaks.ts courtside-web/lib/recordStreaks.test.ts courtside-web/lib/postgameReport.test.ts
git commit -m "$(cat <<'EOF'
feat(web): streak context reads the new kinds - consecutive-game streaks and team win/loss runs

Team codes are keys of known/state next to player codes, team runs only carry within the same season,
and every games-based kind (games played, consecutive games, team runs) is dropped outside the regular
season. The log rows now carry their start game so the season can be checked.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 웹 — 판정 헬퍼 일반화와 새 엔진 `gameStreakMoments.ts`

**Files:**
- Modify: `courtside-web/lib/streakMoments.ts`, `courtside-web/lib/streakMoments.test.ts`, `courtside-web/lib/recordsMoments.ts`
- Create: `courtside-web/lib/gameStreakMoments.ts`, `courtside-web/lib/gameStreakMoments.test.ts`

**Interfaces:**
- Consumes: Task 3의 `StreakContext`(`teams`, 팀·`cg_*` 상태), `boxEvents.applyBoxEvent/emptyBoxLine`
- Produces: `streakVerdict(entries, pcode, n, milestone) -> { s, ranked: RankInfo | null, worthy }`(streakMoments.ts 내보냄; `summaryOf`는 본인의 *진행 중* 행만 뺀다), `buildGameStreakMoments(streaks, events, opts, finals?) -> RecordMoment[]`, `buildGameStreakChances(streaks) -> GameStreakChance[]`(최대 4), `buildAllRecordMoments`가 새 엔진을 합친다.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- create: courtside-web/lib/gameStreakMoments.test.ts -->
~~~typescript
import { describe, expect, it } from "vitest";
import { buildAllRecordMoments } from "./recordsMoments";
import type { RecordEvent } from "./records";
import { buildGameStreakChances, buildGameStreakMoments } from "./gameStreakMoments";
import { STREAK_KINDS, type StreakContext, type StreakEntry, type StreakKind } from "./streakKinds";

const names = { player: (p: string) => `선수${p}`, team: (t: string) => `팀${t}` };
const OPTS = { names, final: false, home: "H", away: "A" };
const ent = (v: number, pcode: string, who: string, active = false): StreakEntry => ({ v, pcode, who, active, d: "2020-01-01" });
function ctxOf(o: { boards?: Partial<Record<StreakKind, StreakEntry[]>>; state?: StreakContext["state"]; known?: string[]; final?: boolean; teams?: Record<string, string> }): StreakContext {
  const boards = Object.fromEntries(STREAK_KINDS.map((k) => [k, o.boards?.[k] ?? []])) as Record<StreakKind, StreakEntry[]>;
  return { asOf: "2026-10-11", final: o.final ?? false, boards, state: o.state ?? {}, known: o.known ?? [], players: {}, ...(o.teams ? { teams: o.teams } : {}) };
}
const ev = (pcode: string, code: string, n = 0, extra: Partial<RecordEvent> = {}): RecordEvent => ({ pcode, tcode: "H", action_code: code, quarter: "Q1", clock_min: 9, clock_sec: 59 - n, ...extra });
const makes = (pcode: string, count: number, code = "201") => Array.from({ length: count }, (_, i) => ev(pcode, code, i));

// 득점 20+ 연속 경기: 10위 값 17
const P20 = [ent(42, "mk", "마이클"), ent(29, "em", "에밋"), ent(23, "em", "에밋"), ent(22, "ms", "메이스"), ent(20, "a", "에이"), ent(19, "b", "비"), ent(19, "c", "씨"), ent(18, "d", "디"), ent(17, "e", "이"), ent(17, "f", "에프"), ent(16, "g", "지")];

describe("선수 연속 경기 - 조건을 처음 채우는 이벤트에서", () => {
  it("득점 20점째 득점에서 N=before+1경기째, 순위가 좋아질 때만(10위 안 첫 진입)", () => {
    const s = ctxOf({ boards: { cg_pts20: P20 }, state: { z: { cg_pts20: { before: 16 } } }, known: ["z"] });
    const m = buildGameStreakMoments(s, makes("z", 10), OPTS).filter((x) => x.phase === "done");   // 2점 10개 = 20점
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ board: "pg.cg_pts20.max", subject: "z", value: 17, idx: 9, provisional: true, scope: "p", tcode: "H" });
    expect(m[0].text).toBe("득점 20+ 연속 17경기째 KBL 역대 공동 9위");
  });
  it("19점에서는 아무것도 없고, 순위가 그대로면(이미 10위 안에서 이어가기) 알리지 않는다", () => {
    const s = ctxOf({ boards: { cg_pts20: P20 }, state: { z: { cg_pts20: { before: 16 }, cg_pts10: { before: 3 } } }, known: ["z"] });
    expect(buildGameStreakMoments(s, [...makes("z", 9), ev("z", "203", 9)], OPTS).filter((x) => x.board === "pg.cg_pts20.max")).toEqual([]);   // 19점
    const stay = ctxOf({ boards: { cg_pts20: P20 }, state: { z: { cg_pts20: { before: 30 } } }, known: ["z"] });                                // 30 -> 31: 둘 다 2위(42만 앞) - 순위 그대로라 알리지 않는다
    expect(buildGameStreakMoments(stay, makes("z", 10), OPTS).filter((x) => x.board === "pg.cg_pts20.max")).toEqual([]);
    const up = ctxOf({ boards: { cg_pts20: P20 }, state: { z: { cg_pts20: { before: 18 } } }, known: ["z"] });                                  // 18 -> 19: 공동 8위 -> 공동 6위 - 좋아졌으니 알린다
    expect(buildGameStreakMoments(up, makes("z", 10), OPTS).filter((x) => x.board === "pg.cg_pts20.max")[0].text).toBe("득점 20+ 연속 19경기째 KBL 역대 공동 6위");
  });
  it("이정표(20 이상 10 단위)에서는 순위와 상관없이 '달성'으로 알린다", () => {
    const s = ctxOf({ boards: {}, state: { z: { cg_reb10: { before: 19 } } }, known: ["z"] });
    const m = buildGameStreakMoments(s, Array.from({ length: 10 }, (_, i) => ev("z", "210", i)), OPTS).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0].text).toBe("리바운드 10+ 연속 20경기 달성");
    expect(m[0].rank).toBe(11);
  });
  it("더블더블은 득점·리바·어시·스틸·블록 중 두 항목이 10을 넘는 순간", () => {
    const s = ctxOf({ boards: {}, state: { z: { cg_dd: { before: 19 } } }, known: ["z"] });
    const events = [...makes("z", 5), ...Array.from({ length: 9 }, (_, i) => ev("z", "209", 5 + i)), ...Array.from({ length: 10 }, (_, i) => ev("z", "211", 14 + i))];   // 득점 10(idx 4), 리바 9, 어시 10(idx 23)
    const m = buildGameStreakMoments(s, events, OPTS).filter((x) => x.phase === "done" && x.board === "pg.cg_dd.max");
    expect(m).toHaveLength(1);
    expect(m[0].idx).toBe(23);                                                                                                                // 득점 10 + 어시스트 10번째에서 두 항목이 10을 넘는다(리바운드는 9에서 멈춤)
    expect(m[0].text).toBe("더블더블 연속 20경기 달성");
  });
  it("3점슛 1개: 첫 3점슛에서, 3점슛이 아닌 득점으로는 안 채운다", () => {
    const s = ctxOf({ boards: {}, state: { z: { cg_tpm1: { before: 29 } } }, known: ["z"] });
    const m = buildGameStreakMoments(s, [...makes("z", 3), ev("z", "205", 3)], OPTS).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ value: 30, idx: 3, text: "3점슛 성공 연속 30경기 달성" });
  });
  it("상태를 믿을 수 없는 선수(known 밖)는 만들지 않는다", () => {
    const s = ctxOf({ boards: { cg_pts20: P20 }, state: { z: { cg_pts20: { before: 16 } } }, known: [] });
    expect(buildGameStreakMoments(s, makes("z", 10), OPTS)).toEqual([]);
  });
  it("종료 경기: 로그 행(after>before)이 있는 선수만, 이벤트가 조건을 못 채워도 마지막 이벤트에서 보정, '잠정' 아님", () => {
    const withRow = ctxOf({ boards: { cg_pts20: P20 }, state: { z: { cg_pts20: { before: 16, after: 17 } } }, known: ["z"], final: true });
    const m = buildGameStreakMoments(withRow, makes("z", 10), { ...OPTS, final: true }).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0].provisional).toBe(false);
    const mismatch = buildGameStreakMoments(withRow, makes("z", 8), { ...OPTS, final: true }).filter((x) => x.phase === "done");                 // 이벤트는 16점 - 공식은 20점+
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].idx).toBe(7);
    const broke = ctxOf({ boards: { cg_pts20: P20 }, state: { z: { cg_pts20: { before: 16, after: 0 } } }, known: ["z"], final: true });
    expect(buildGameStreakMoments(broke, makes("z", 10), { ...OPTS, final: true })).toEqual([]);
  });
  it("finals: 조건을 채운 선수는 before+1, 이어지던 연속이 끊긴 선수는 0", () => {
    const finals = new Map<string, number>();
    const s = ctxOf({ boards: {}, state: { z: { cg_pts20: { before: 4 } }, y: { cg_pts10: { before: 6 } } }, known: ["z", "y"] });
    buildGameStreakMoments(s, [...makes("z", 10), ev("y", "201", 11)], OPTS, finals);
    expect(finals.get("cg_pts20|z")).toBe(5);
    expect(finals.get("cg_pts10|z")).toBe(1);
    expect(finals.get("cg_pts10|y")).toBe(0);
  });
});

describe("팀 연승·연패 - 종료 경기와 경기 전", () => {
  const WIN = [ent(16, "16", "원주 DB"), ent(15, "55", "서울 SK"), ent(13, "50", "에이"), ent(13, "x", "비"), ent(13, "y", "씨"), ent(12, "z", "디"), ent(12, "w", "이"), ent(12, "v", "에프"), ent(12, "u", "지"), ent(12, "t", "에이치"), ent(11, "s", "아이")];
  const last = (home: number, away: number): RecordEvent => ({ pcode: null, tcode: null, action_code: "101", quarter: "Q4", clock_min: 0, clock_sec: 0, home_score: home, away_score: away });
  it("종료 경기: 이긴 팀의 tw·진 팀의 tl 행이 있고 순위가 좋아지면 마지막 이벤트에 순간 기록", () => {
    const s = ctxOf({ boards: { tw: WIN }, state: { H: { tw: { before: 12, after: 13 } }, A: { tl: { before: 3, after: 4 } } }, known: ["H", "A"], final: true, teams: { H: "홈팀", A: "원정팀" } });
    const m = buildGameStreakMoments(s, [ev("p", "201", 0), last(80, 70)], { ...OPTS, final: true }).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ board: "tg.win_streak.max", subject: "H", scope: "t", tcode: "H", value: 13, idx: 1, provisional: false });
    expect(m[0].text).toBe("팀H 시즌 13연승째 KBL 역대 공동 3위");
  });
  it("라이브(비종료)에서는 팀 순간 기록이 없다", () => {
    const s = ctxOf({ boards: { tw: WIN }, state: { H: { tw: { before: 12 } } }, known: ["H"], teams: { H: "홈팀" } });
    expect(buildGameStreakMoments(s, [ev("p", "201", 0), last(80, 70)], OPTS)).toEqual([]);
  });
  it("finals(대조용): 마지막 점수로 이긴 팀 tw=before+1, 진 팀 tl=before+1, 반대 종류는 이어지던 게 있으면 0", () => {
    const finals = new Map<string, number>();
    const s = ctxOf({ boards: {}, state: { H: { tw: { before: 2 } }, A: { tw: { before: 5 }, tl: { before: 1 } } }, known: ["H", "A"] });
    buildGameStreakMoments(s, [ev("p", "201", 0), last(60, 70)], OPTS, finals);
    expect(Object.fromEntries(finals)).toMatchObject({ "tw|A": 6, "tl|A": 0, "tl|H": 1, "tw|H": 0 });
  });
  it("경기 전 도전: 이기면 순위가 좋아지는 연승 팀, 지면 불명예 순위가 오르는 연패 팀만", () => {
    const LOSE = [ent(14, "35", "서울 삼성"), ent(14, "16", "원주 DB"), ent(13, "65", "에이"), ent(13, "55", "비"), ent(13, "x", "씨"), ent(12, "y", "디"), ent(12, "z", "이"), ent(12, "w", "에프"), ent(11, "v", "지"), ent(11, "u", "에이치"), ent(10, "t", "아이")];
    const s = ctxOf({ boards: { tw: WIN, tl: LOSE }, state: { H: { tw: { before: 12 } }, A: { tl: { before: 11 } } }, known: ["H", "A"], teams: { H: "원주 DB", A: "서울 삼성" } });
    const chances = buildGameStreakChances(s);
    expect(chances.map((c) => c.text)).toEqual(["이기면 시즌 13연승째 KBL 역대 공동 3위", "지면 시즌 12연패째 불명예 역대 공동 6위"]);
    expect(chances.find((c) => c.tcode === "H")?.name).toBe("원주 DB");
  });
  it("경기 전 도전: 선수 - 오늘 조건을 채우면 순위가 좋아지는 경우만, 상한 4", () => {
    const s = ctxOf({ boards: { cg_pts20: P20 }, state: { z: { cg_pts20: { before: 16 } }, y: { cg_pts20: { before: 18 } } }, known: ["z", "y"] });
    s.players = { z: { name: "제트", tcode: "H" }, y: { name: "와이", tcode: "A" } };
    const c = buildGameStreakChances(s);
    expect(c.map((x) => x.text)).toContain("오늘 20점 이상 넣으면 득점 20+ 연속 17경기째 KBL 역대 공동 9위");
    expect(c.length).toBeLessThanOrEqual(4);
  });
});

describe("buildAllRecordMoments", () => {
  it("5번째 배열로 합쳐져 시간순이다", () => {
    const s = ctxOf({ boards: { cg_pts20: P20 }, state: { z: { cg_pts20: { before: 16 } } }, known: ["z"] });
    const all = buildAllRecordMoments({ asOf: "x", boards: {} }, makes("z", 10), OPTS, s);
    expect(all.map((x) => x.board)).toContain("pg.cg_pts20.max");
    expect(buildAllRecordMoments({ asOf: "x", boards: {} }, makes("z", 10), OPTS).map((x) => x.board)).not.toContain("pg.cg_pts20.max");
  });
});
~~~

<!-- edit: courtside-web/lib/streakMoments.test.ts -->
<!-- old -->
~~~typescript
  it("summaryOf: 본인 행을 빼고 순위 <= 10의 값과 상위 3위 보유자를 낸다", () => {
~~~
<!-- new -->
~~~typescript
  it("summaryOf: 본인의 *진행 중* 행만 뺀다 - 본인이 예전에 끝낸 연속은 종전 기록으로 남는다", () => {
    const own = [ent(60, "p", "본인", true), ent(56, "p", "본인"), ent(52, "m", "문경은")];
    const sm = summaryOf(own, "p");
    expect(sm.tops).toEqual([56, 52]);
    expect(sm.holders[0]).toEqual({ v: 56, who: "본인", d: "2026-03-24" });
  });
  it("summaryOf: 본인 행을 빼고 순위 <= 10의 값과 상위 3위 보유자를 낸다", () => {
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/gameStreakMoments.test.ts lib/streakMoments.test.ts`

Expected: FAIL — `Failed to resolve import "./gameStreakMoments"`, `summaryOf` 새 테스트 FAIL.

- [ ] **Step 3: 구현**

<!-- edit: courtside-web/lib/streakMoments.ts -->
<!-- old -->
~~~typescript
/** 연속 보드의 항목들(본인 행 제외)을 순위 요약으로 - 비교할 "다른 사람들의 연속". */
export function summaryOf(entries: StreakEntry[], excludePcode?: string): BoardSummary {
  const list = entries.filter((e) => e.pcode !== excludePcode).sort((a, b) => b.v - a.v);
~~~
<!-- new -->
~~~typescript
/** 연속 보드의 항목들을 순위 요약으로 - 비교할 "다른 연속들". 본인의 *진행 중* 행(지금 재고 있는 바로 그 연속)만 빼고, 본인이 예전에 끝낸 연속은 종전 기록으로 남긴다. */
export function summaryOf(entries: StreakEntry[], excludePcode?: string): BoardSummary {
  const list = entries.filter((e) => !(e.pcode === excludePcode && e.active)).sort((a, b) => b.v - a.v);
~~~

<!-- edit: courtside-web/lib/streakMoments.ts -->
<!-- old -->
~~~typescript
function gpVerdict(entries: StreakEntry[], pcode: string, n: number) {
  const s = summaryOf(entries, pcode);
  const info = rankInfo(s.tops, n, "max");
  const beforeInfo = n > 1 ? rankInfo(s.tops, n - 1, "max") : null;
  const ranked = info != null && info.rank <= TOP_RANKS ? info : null;
  const improved = ranked != null && (beforeInfo == null || beforeInfo.rank > TOP_RANKS || ranked.rank < beforeInfo.rank || (ranked.breaks && !beforeInfo.breaks));
  return { s, ranked, worthy: improved || isMilestone(n) };
}
~~~
<!-- new -->
~~~typescript
export function streakVerdict(entries: StreakEntry[], pcode: string, n: number, milestone: boolean) {
  const s = summaryOf(entries, pcode);
  const info = rankInfo(s.tops, n, "max");
  const beforeInfo = n > 1 ? rankInfo(s.tops, n - 1, "max") : null;
  const ranked = info != null && info.rank <= TOP_RANKS ? info : null;
  const improved = ranked != null && (beforeInfo == null || beforeInfo.rank > TOP_RANKS || ranked.rank < beforeInfo.rank || (ranked.breaks && !beforeInfo.breaks));
  return { s, ranked, worthy: improved || milestone };
}
const gpVerdict = (entries: StreakEntry[], pcode: string, n: number) => streakVerdict(entries, pcode, n, isMilestone(n));
~~~

<!-- create: courtside-web/lib/gameStreakMoments.ts -->
~~~typescript
import { applyBoxEvent, emptyBoxLine, type BoxLine } from "./boxEvents";
import { clockOf, holdersLine, TOP_RANKS, verdictText, type RecordEvent, type RecordMoment, type RecordTimelineOptions, type ValueFmt } from "./records";
import { CG_KINDS, STREAK_BOARD, type CgKind, type StreakContext } from "./streakKinds";
import { streakVerdict } from "./streakMoments";

// 역대 기록 4단계 A 라이브 엔진 - 선수 연속 경기 6종(정규시즌 명단 기준)과 팀 연승·연패. 설계: docs/superpowers/specs/2026-10-11-record-book-phase4a-design.md §4
//
// 선수: 이벤트로 이 경기 누적(박스)을 쌓다가 **조건을 처음 채우는 이벤트**에서 N = (이 경기 직전 연속) + 1경기째를 판정한다. 종료 경기는 공식 박스를 담은 로그 행(after > before)이 있는 선수만 알리고,
//       이벤트가 조건을 못 채웠으면(이벤트-공식 불일치) 그 선수의 마지막 이벤트에서 보정한다.
// 팀:   경기 결과는 끝나야 알 수 있어 종료 경기(리포트·종료 경기 재생)와 경기 전 줄에서만 쓴다.
// 알릴 만한 순간은 streakVerdict(순위가 좋아지거나 이정표)뿐이다. 순수 함수 - 서버 전용 모듈을 import하지 않는다.

const gameCnt: ValueFmt = (v) => `${v}경기`;
const ddCount = (b: BoxLine) => [b.pts, b.reb, b.ast, b.stl, b.blk].filter((v) => v >= 10).length;

const CG: Record<CgKind, { short: string; cond: string; ok: (b: BoxLine) => boolean; from: number; step: number }> = {
  cg_pts10: { short: "득점 10+", cond: "오늘 10점 이상 넣으면", ok: (b) => b.pts >= 10, from: 50, step: 50 },
  cg_pts20: { short: "득점 20+", cond: "오늘 20점 이상 넣으면", ok: (b) => b.pts >= 20, from: 20, step: 10 },
  cg_dd: { short: "더블더블", cond: "오늘 더블더블을 하면", ok: (b) => ddCount(b) >= 2, from: 20, step: 10 },
  cg_reb10: { short: "리바운드 10+", cond: "오늘 리바운드 10개를 잡으면", ok: (b) => b.reb >= 10, from: 20, step: 10 },
  cg_tpm1: { short: "3점슛 성공", cond: "오늘 3점슛을 넣으면", ok: (b) => b.threePM >= 1, from: 20, step: 10 },
  cg_ast5: { short: "어시스트 5+", cond: "오늘 어시스트 5개를 하면", ok: (b) => b.ast >= 5, from: 20, step: 10 },
};
const isCgMilestone = (kind: CgKind, n: number) => n >= CG[kind].from && n % CG[kind].step === 0;
const levelOf = (rank: number, breaks: boolean) => (breaks ? 0 : rank);

export function buildGameStreakMoments(
  streaks: StreakContext | null,
  events: RecordEvent[],
  opts: RecordTimelineOptions,
  finals?: Map<string, number>
): RecordMoment[] {
  const out: RecordMoment[] = [];
  if (!streaks) return out;
  const provisional = !opts.final;
  const known = new Set(streaks.known);
  const boxes = new Map<string, BoxLine>();
  const reached = new Set<string>();
  const lastAt = new Map<string, { idx: number; tcode: string; clock: string }>();

  /** 선수 pcode의 kind 연속이 이 경기에서 이어졌다고 확정하는 순간(조건 충족 이벤트 또는 종료 경기 보정 위치). */
  const reach = (kind: CgKind, pcode: string, idx: number, tcode: string, clock: string) => {
    const key = `${kind}|${pcode}`;
    if (reached.has(key)) return;
    const st = known.has(pcode) ? streaks.state[pcode]?.[kind] : undefined;
    if (streaks.final && !(st && st.after != null && st.after > st.before)) return;      // 종료 경기: 공식 박스(로그)가 연속이 이어졌다고 한 선수만
    const n = streaks.final && st && st.after != null ? st.after : (st?.before ?? 0) + 1;
    reached.add(key);
    finals?.set(key, n);
    if (!known.has(pcode)) return;
    const v = streakVerdict(streaks.boards[kind], pcode, n, isCgMilestone(kind, n));
    if (!v.worthy) return;
    const r = v.ranked;
    out.push({
      id: `${kind}|${pcode}|${n}`, idx, until: Infinity, clock, phase: "done",
      board: STREAK_BOARD[kind], bucket: "G", subject: pcode, period: "", scope: "p", name: opts.names.player(pcode), tcode, value: n,
      rank: r ? r.rank : TOP_RANKS + 1, tie: r ? r.tie : false, breaks: r ? r.breaks : false, remaining: 0,
      text: r ? `${CG[kind].short} 연속 ${n}경기째 ${verdictText(r, gameCnt, "KBL")}` : `${CG[kind].short} 연속 ${n}경기 달성`,
      detail: r ? holdersLine(v.s, r, gameCnt) : "",
      provisional, sig: r ? levelOf(r.rank, r.breaks) : 50,
    });
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (!e.pcode || !e.tcode || !e.action_code || !e.quarter || e.quarter === "PRE") continue;
    const clock = clockOf(e);
    let box = boxes.get(e.pcode);
    if (!box) {
      box = emptyBoxLine();
      boxes.set(e.pcode, box);
    }
    applyBoxEvent(box, e.action_code);
    lastAt.set(e.pcode, { idx, tcode: e.tcode, clock });
    for (const kind of CG_KINDS) if (CG[kind].ok(box)) reach(kind, e.pcode, idx, e.tcode, clock);
  }
  for (const pcode of Object.keys(streaks.state)) {
    if (!known.has(pcode)) continue;
    const at = lastAt.get(pcode);
    for (const kind of CG_KINDS) {
      const st = streaks.state[pcode]?.[kind];
      if (!st) continue;
      if (streaks.final && at && st.after != null && st.after > st.before && !reached.has(`${kind}|${pcode}`)) reach(kind, pcode, at.idx, at.tcode, at.clock);   // 이벤트-공식 불일치 보정
      if (st.before > 0 && !reached.has(`${kind}|${pcode}`)) finals?.set(`${kind}|${pcode}`, 0);                                                             // 이어지던 연속이 이 경기에서 끊겼다
    }
  }

  // --- 팀 연승·연패: 마지막 이벤트의 점수로 승패를 가른다(점수가 없으면 건너뜀)
  const last = events.length > 0 ? events[events.length - 1] : null;
  if (opts.home && opts.away && last && last.home_score != null && last.away_score != null && last.home_score !== last.away_score) {
    const win = last.home_score > last.away_score ? opts.home : opts.away;
    const lose = win === opts.home ? opts.away : opts.home;
    for (const [tc, kind, oth, isWin] of [[win, "tw", "tl", true], [lose, "tl", "tw", false]] as const) {
      if (!known.has(tc)) continue;
      const st = streaks.state[tc]?.[kind];
      finals?.set(`${kind}|${tc}`, (st?.before ?? 0) + 1);
      if ((streaks.state[tc]?.[oth]?.before ?? 0) > 0) finals?.set(`${oth}|${tc}`, 0);
      if (!streaks.final || !st || st.after == null || st.after <= st.before) continue;       // 라이브에서는 결과를 모른다 - 종료 경기의 로그 행만
      const n = st.after;
      const v = streakVerdict(streaks.boards[kind], tc, n, false);
      if (!v.worthy || !v.ranked) continue;
      const r = v.ranked;
      const fmt: ValueFmt = (x) => (isWin ? `${x}연승` : `${x}연패`);
      out.push({
        id: `${kind}|${tc}|${n}`, idx: events.length - 1, until: Infinity, clock: clockOf(last), phase: "done",
        board: STREAK_BOARD[kind], bucket: "G", subject: tc, period: "", scope: "t", name: opts.names.team(tc), tcode: tc, value: n,
        rank: r.rank, tie: r.tie, breaks: r.breaks, remaining: 0,
        text: `${opts.names.team(tc)} 시즌 ${n}${isWin ? "연승" : "연패"}째 ${verdictText(r, fmt, isWin ? "KBL" : "불명예")}`,
        detail: holdersLine(v.s, r, fmt), provisional: false, sig: levelOf(r.rank, r.breaks),
      });
    }
  }
  return out;
}

/** 경기 전 "기록 도전" 한 줄(이름·팀 칩은 recordChanceList가 붙인다). */
export type GameStreakChance = { id: string; name: string; tcode?: string; text: string; detail: string; sig: number };

/**
 * 경기 전 도전: 오늘 조건을 채우면 순위가 좋아지는 선수(연속 경기 6종)와, 이기면/지면 순위가 좋아지는 팀. 상태를 믿을 수 없는 대상(known 밖)은 만들지 않는다.
 * 알릴 만한 순(신기록 먼저)으로 최대 4개.
 */
export function buildGameStreakChances(streaks: StreakContext): GameStreakChance[] {
  const out: GameStreakChance[] = [];
  for (const id of streaks.known) {
    const st = streaks.state[id];
    if (!st) continue;
    const team = streaks.teams?.[id];
    if (team != null) {
      for (const [kind, label, who, verb] of [["tw", "연승", "KBL", "이기면"], ["tl", "연패", "불명예", "지면"]] as const) {
        const before = st[kind]?.before ?? 0;
        if (before <= 0) continue;
        const v = streakVerdict(streaks.boards[kind], id, before + 1, false);
        if (!v.worthy || !v.ranked) continue;
        const fmt: ValueFmt = (x) => `${x}${label}`;
        out.push({ id: `${kind}|${id}`, name: team, tcode: id, text: `${verb} 시즌 ${before + 1}${label}째 ${verdictText(v.ranked, fmt, who)}`, detail: holdersLine(v.s, v.ranked, fmt), sig: levelOf(v.ranked.rank, v.ranked.breaks) });
      }
      continue;
    }
    const p = streaks.players[id];
    if (!p) continue;
    for (const kind of CG_KINDS) {
      const before = st[kind]?.before ?? 0;
      if (before <= 0) continue;
      const n = before + 1;
      const v = streakVerdict(streaks.boards[kind], id, n, isCgMilestone(kind, n));
      if (!v.worthy) continue;
      const r = v.ranked;
      out.push({
        id: `${kind}|${id}`, name: p.name, ...(p.tcode ? { tcode: p.tcode } : {}),
        text: r ? `${CG[kind].cond} ${CG[kind].short} 연속 ${n}경기째 ${verdictText(r, gameCnt, "KBL")}` : `${CG[kind].cond} ${CG[kind].short} 연속 ${n}경기 달성`,
        detail: r ? holdersLine(v.s, r, gameCnt) : "", sig: r ? levelOf(r.rank, r.breaks) : 50,
      });
    }
  }
  return out.sort((a, b) => a.sig - b.sig || a.name.localeCompare(b.name, "ko")).slice(0, 4);
}
~~~

<!-- edit: courtside-web/lib/recordsMoments.ts -->
<!-- old -->
~~~typescript
import { buildStreakMoments } from "./streakMoments";
~~~
<!-- new -->
~~~typescript
import { buildGameStreakMoments } from "./gameStreakMoments";
import { buildStreakMoments } from "./streakMoments";
~~~

<!-- edit: courtside-web/lib/recordsMoments.ts -->
<!-- old -->
~~~typescript
  const streak = buildStreakMoments(ctx, streaks ?? null, events, opts);
  return [...base, ...kept, ...streak].sort((a, b) => a.idx - b.idx);
~~~
<!-- new -->
~~~typescript
  const streak = buildStreakMoments(ctx, streaks ?? null, events, opts);
  const game = buildGameStreakMoments(streaks ?? null, events, opts);
  return [...base, ...kept, ...streak, ...game].sort((a, b) => a.idx - b.idx);
~~~

- [ ] **Step 4: 통과 확인(테스트 기대값은 손으로 계산해 맞춘다)**

Run: `cd courtside-web && npx vitest run lib/gameStreakMoments.test.ts lib/streakMoments.test.ts lib/recordsMoments.test.ts lib/records.test.ts`

Expected: 통과. 실패하는 단언이 있으면 **구현이 아니라 기대값이 틀렸는지** 손으로 먼저 계산한다(순위·공동 표기는 `P20`/`WIN`/`LOSE` 보드에서 `rankInfo`가 "나보다 확실히 앞선 값의 개수 + 1"로 낸다).

- [ ] **Step 5: 린트·전체**

Run: `cd courtside-web && npx tsc --noEmit && npx eslint lib/gameStreakMoments.ts lib/gameStreakMoments.test.ts lib/streakMoments.ts lib/recordsMoments.ts --quiet && npx vitest run`

Expected: 출력 없음 / 전체 통과.

- [ ] **Step 6: 커밋**

```bash
git add courtside-web/lib/gameStreakMoments.ts courtside-web/lib/gameStreakMoments.test.ts courtside-web/lib/streakMoments.ts courtside-web/lib/streakMoments.test.ts courtside-web/lib/recordsMoments.ts
git commit -m "$(cat <<'EOF'
feat(web): live engine for consecutive-game streaks and team win/loss runs

Player conditions are judged on a running box built from the events (the existing applyBoxEvent), at the
event that first meets the condition; a finished game only announces players whose log row says the
streak continued and falls back to the player's last event when events and the official box disagree.
Team runs use the final score of the last event and are shown only for finished games and as pre-game
challenges. summaryOf now removes only the measured player's active row, so a player's own earlier
record stays the 'previous record'.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 경기 페이지 연결 + 파이썬↔웹 대조 + 문서

**Files:**
- Modify: `courtside-web/app/games/[gmkey]/page.tsx`, `tools/dump_record_fixtures.py`, `courtside-web/lib/records.streaks.parity.test.ts`, `README.md`, `docs/superpowers/specs/2026-10-11-record-book-phase4a-design.md`
- Regenerate: `courtside-web/lib/__fixtures__/streakParity/*.json`

- [ ] **Step 1: 페이지에 경기 전 줄 합치기**

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
import { buildStreakChances } from "@/lib/streakMoments";
~~~
<!-- new -->
~~~typescript
import { buildGameStreakChances } from "@/lib/gameStreakMoments";
import { buildStreakChances } from "@/lib/streakMoments";
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
...(status !== "final" && streaks ? buildStreakChances(streaks) : [])];
~~~
<!-- new -->
~~~typescript
...(status !== "final" && streaks ? [...buildStreakChances(streaks), ...buildGameStreakChances(streaks)] : [])];
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
연속 출장은 정규시즌 경기 명단 기준(명단에 올랐는데 못 뛴 경기에서 끊기고, 명단에 없던 경기는 건너뜀)·연속 슛은 선수 본인의 시도 순서 기준입니다.
~~~
<!-- new -->
~~~typescript
연속 출장·연속 경기 기록은 정규시즌 경기 명단 기준(명단에 올랐는데 못 뛰었거나 조건 미달이면 끊기고, 명단에 없던 경기는 건너뜀)·팀 연승/연패는 정규시즌 시즌 안 기준·연속 슛은 선수 본인의 시도 순서 기준입니다.
~~~

- [ ] **Step 2: 대조 도구와 테스트 확장**

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
def dump_streaks(outdir, gmkeys):
~~~
<!-- new -->
~~~python
def box_matches_official(g):
    """pcode -> 그 선수의 이벤트 합계(득점·리바·어시·스틸·블록·3점)가 공식 박스와 모두 같은가 - 선수 연속 경기(cg_*)는 공식 박스로 판정하므로 이벤트가 어긋난 선수는 대조에서 뺀다."""
    idx = rb.player_index(g)
    tot = collections.defaultdict(collections.Counter)
    for e in g["events"]:
        a, name, tc = e.get("a"), e.get("p"), e.get("t")
        pcode = idx.get((name, tc)) if (a and name and tc) else None
        if not pcode:
            continue
        tot[pcode]["pts"] += rb.PTS_BY_CODE.get(a, 0)
        for m, codes in rb.COUNT_CODES.items():
            if a in codes:
                tot[pcode][m] += 1
    return {p["pcode"]: all(tot[p["pcode"]][m] == (p["rec"].get(rb.PLAYER_OFFICIAL[m]) or 0) for m in ("pts", "reb", "ast", "stl", "blk", "tpm")) for p in g["players"]}


def dump_streaks(outdir, gmkeys):
~~~

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
        _, bad = rb.shot_sequences(g)
        state = collections.defaultdict(dict)
        for r in by_game.get(gmkey, []):
~~~
<!-- new -->
~~~python
        _, bad = rb.shot_sequences(g)
        box_ok = box_matches_official(g)
        state = collections.defaultdict(dict)
        for r in by_game.get(gmkey, []):
            if r["kind"].startswith("cg_") and not box_ok.get(r["pcode"], False):
                continue                      # 이벤트 합계가 공식 박스와 다른 선수의 조건 연속은 대조 대상이 아니다
~~~

<!-- edit: courtside-web/lib/records.streaks.parity.test.ts -->
<!-- old -->
~~~typescript
import { buildStreakMoments } from "./streakMoments";
~~~
<!-- new -->
~~~typescript
import { buildGameStreakMoments } from "./gameStreakMoments";
import { buildStreakMoments } from "./streakMoments";
~~~

<!-- edit: courtside-web/lib/records.streaks.parity.test.ts -->
<!-- old -->
~~~typescript
      buildStreakMoments({ asOf: "x", boards: {} }, streaks, events, { names: { player: (p) => p, team: (t) => t }, final: false, home: fx.home, away: fx.away }, finals);
~~~
<!-- new -->
~~~typescript
      const opts = { names: { player: (p: string) => p, team: (t: string) => t }, final: false, home: fx.home, away: fx.away };
      buildStreakMoments({ asOf: "x", boards: {} }, streaks, events, opts, finals);
      buildGameStreakMoments(streaks, events, opts, finals);
~~~

- [ ] **Step 3: 픽스처 재생성과 대조**

Run:

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" dump_record_fixtures.py --streaks ../courtside-web/lib/__fixtures__/streakParity --gmkeys S23G01N165,S15G01N119,S15G01N121,S43G01N265,S49G01N10,S35G01N31,S33G01N268,S13G01N90,S27G01N227,S23G01N194,S37G01N170,S23G01N15,S31G01N104,S39G01N151
cd ../courtside-web
npx vitest run lib/records.streaks.parity.test.ts
```

Expected: `streak fixtures: 14개`(추가 두 경기는 최다 역전승 경기 — 팀 연승 상태가 다양하게 들어오도록), 대조 테스트 통과. 실패하면 출력의 `want`/`got`로 어긋난 (주체, 종류)를 확인한다 — 웹 엔진의 조건 판정/끊김 규칙이 파이썬과 다른 것이므로 한쪽을 고쳐 맞춘다(이벤트-공식 불일치는 위 `box_matches_official`로 이미 제외됨). 첫 줄 `files.length > 3`·`carried >= 3` 단언은 그대로 유지된다.

- [ ] **Step 4: README와 스펙 보정**

<!-- edit: README.md -->
<!-- old -->
~~~text
**감시**: Supabase pg_cron(`watch_live_collector`, 1분마다)이 수집기 심박(`live_collector_status`)을
~~~
<!-- new -->
~~~text
- **4단계 A(2026-10-11, 설계 `docs/superpowers/specs/2026-10-11-record-book-phase4a-design.md`)** - 선수 연속 경기 6종(정규시즌 명단 기준, 연속 출장과 같은 방식: 득점 10+/20+·더블더블·리바운드 10+·3점슛 성공·어시스트 5+)과
  팀 시즌 내 연승·연패. 같은 `record_streaks.py` 전체 재계산이 보드 8개를 더 만든다(총 15개, `STREAK_BOARDS`) — DDL 없음, 로그의 `pcode` 칸에 팀 코드. 알림은 순위가 좋아지거나 이정표일 때만이고
  팀 연승·연패는 종료 경기 리포트·재생과 경기 전 줄에서만 보인다. 롤백: 웹 `git revert`, DB는 새 보드 8개 + 로그 종류 8개 삭제(`rollback_record_streak_log.sql` 주석).

**감시**: Supabase pg_cron(`watch_live_collector`, 1분마다)이 수집기 심박(`live_collector_status`)을
~~~

<!-- edit: docs/superpowers/specs/2026-10-11-record-book-phase4a-design.md -->
<!-- old -->
~~~text
전체 줄 수 상한 6(3단계와 합산, 중요도 순).
~~~
<!-- new -->
~~~text
이 종류의 줄은 별도 상한 4(중요도 순, 3단계 경기 전 줄과 따로).
~~~

- [ ] **Step 5: 전체 확인 후 커밋**

Run:

```bash
cd courtside-web && npx tsc --noEmit && npx eslint lib components app --quiet && npx vitest run
cd ../tools
for t in test_record_book test_record_book_moments test_record_streaks test_record_book_hook; do PYTHONIOENCODING=utf-8 "$PY" $t.py 2>&1 | grep -E "FAIL|실패"; done
```

Expected: tsc·eslint 출력 없음, vitest 전체 통과, 파이썬 4종 `실패 없음.`

```bash
git add "courtside-web/app/games/[gmkey]/page.tsx" tools/dump_record_fixtures.py courtside-web/lib/records.streaks.parity.test.ts courtside-web/lib/__fixtures__/streakParity README.md docs/superpowers/specs/2026-10-11-record-book-phase4a-design.md docs/superpowers/plans/2026-10-11-record-book-phase4a.md
git commit -m "$(cat <<'EOF'
feat(web): pre-game challenges for the new streaks and a Python-vs-web parity check on real games

The game page merges the consecutive-game and team-run challenge lines; the parity fixtures now carry
the six consecutive-game kinds and the team runs (players whose event totals differ from the official
box are left out), and the web engine must reproduce them from the carried-in state and the events.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: DB 재적재 · 검증 (**사용자 확인 필요 - 운영 DB 쓰기**)

**Files:** (코드 변경 없음 - 운영 작업)

**먼저 사용자에게 확인한다**: "공유 Supabase의 `record_entries` 연속 보드를 15개로 늘려 전체 다시 채우고(`record_book.py --rebuild`, 한 트랜잭션, 약 2분) `record_streak_log`도 새 종류까지 다시 채웁니다(DDL 없음). 진행할까요?"

- [ ] **Step 1: 사전 점검(DB 읽기 없음)**

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild --dry-run
```

Expected: `연속 보드 N행 + 로그 M행`, `보관 행 K개`가 `MAX_ROWS`(20,000) 이내.

- [ ] **Step 2: 적재와 검증·멱등성**

```bash
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild
PYTHONIOENCODING=utf-8 "$PY" record_book.py --verify
PYTHONIOENCODING=utf-8 "$PY" record_book.py --gmkeys S49G01N9
PYTHONIOENCODING=utf-8 "$PY" record_book.py --verify
```

Expected: `교체 완료: N행 + 연속 로그 M행`, `--verify` 두 번 모두 `없는 행 0 / 남는 행 0 / 값이 다른 행 0`과 `연속 로그 검증: 0/0/0`.

- [ ] **Step 3: 알려진 값 확인**

```bash
PYTHONIOENCODING=utf-8 "$PY" -c "import sys; sys.path.insert(0, '.'); from sync_upcoming_games import get_conn; c = get_conn(); cur = c.cursor(); cur.execute(\"select board, subject_name, value, period from record_entries where board in ('pg.cg_pts10.max','pg.cg_dd.max','pg.cg_tpm1.max','tg.win_streak.max','tg.loss_streak.max') order by board, value desc\"); rows = cur.fetchall(); seen = {}; [print(r) for r in rows if seen.setdefault(r[0], 0) < 2 and not seen.update({r[0]: seen[r[0]] + 1})]; cur.execute(\"select kind, count(*), count(*) filter (where alive) from record_streak_log group by kind order by kind\"); [print(r) for r in cur.fetchall()]"
```

Expected: 사이먼 146·라틀리프 DD 59·전성현 3점 76·팀 연승 16·연패 14가 각 보드 맨 위, 로그에 `cg_*`·`tw`·`tl` 종류가 모두 있다.

---

### Task 7: 푸시 전 빌드 점검과 배포 (**푸시 전 사용자 확인 필요**)

**Files:** (코드 변경 없음)

**먼저 사용자에게 확인한다**: "로컬 커밋 N개를 `main`에 푸시합니다(Vercel 자동 배포)."

- [ ] **Step 1: 푸시 전 빌드 점검(복사본)**

`courtside-web`을 스크래치패드로 복사(`node_modules` 포함 — junction은 Turbopack이 거부)하고 `npx next build`를 돌려 `exit=0`을 확인한다(다른 세션의 커밋이 섞여 있어도 빌드가 깨지지 않는지). 실패하면 첫 `⨯`/Error 줄로 원인을 찾는다.

- [ ] **Step 2: 푸시와 배포 확인**

```bash
git fetch origin && git status -sb | head -3
git push origin main
gh api repos/onnebang/kbl_realdata/commits/$(git rev-parse HEAD)/status --jq '[.statuses[] | {context, state}]'
```

`Vercel – courtside-web`이 `success`가 될 때까지 확인한다(`Vercel – kbl-realdata` 실패는 기존 증상). `HEAD`가 푸시 도중 다른 세션 커밋으로 바뀌었으면 *지금의 HEAD* 상태를 다시 본다.

- [ ] **Step 3: 프로덕션 확인**

```bash
for g in S49G01N8 S49G01N10 S49G01N11 S49G01N18; do curl -s -o "$SP/$g.html" -w "$g %{http_code} %{time_total}s\n" --compressed "https://courtside-web-ten.vercel.app/games/$g"; grep -c "Application error" "$SP/$g.html"; done
```

Expected: 200, `Application error` 0. 새 줄은 조건이 맞는 다음 경기(예정 경기의 "기록 도전", 종료 경기 리포트의 "연속 …경기째"/"시즌 N연승째")에서 눈으로 확인한다.

- [ ] **Step 4: 실패 시 롤백 순서**

웹 문제: 해당 커밋 `git revert`(새 보드·로그 종류는 옛 웹이 읽지 않으므로 DB는 그대로). 파이썬 문제: `record_streaks.py`·`record_book.py`를 이전 커밋으로 되돌려 `--rebuild`. DB 정리: `DELETE FROM record_entries WHERE board IN (<새 보드 8개>)`, `DELETE FROM record_streak_log WHERE kind IN ('cg_pts10','cg_pts20','cg_dd','cg_reb10','cg_tpm1','cg_ast5','tw','tl')`.
