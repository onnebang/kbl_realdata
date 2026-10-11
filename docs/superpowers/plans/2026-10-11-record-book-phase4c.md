# 역대 기록 4단계 C 구현 계획 — 시즌 누적 기록

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 선수의 정규시즌 누적(득점·리바운드·어시스트·스틸·블록·3점슛)을 역대 선수-시즌 순위와 비교해 라이브/종료 후 순위 상승을 알리고, 경기 전 "기록 도전"에 한 경기 안에 닿는 거리 줄과 페이스 줄을 보여 준다.

**Architecture:** `tools/record_streaks.py`의 전체 재계산 상태기계에 선수-시즌 누적을 얹어 보드 6개(bucket `S`)와 로그 종류 7개(`ss_*`)를 만든다 — DDL 없음. 웹은 `streakKinds`/`recordStreaks`가 새 종류의 상태를 읽고, 새 순수 엔진 `lib/seasonMoments.ts`가 이벤트로 누적이 늘 때마다 순위를 비교해(`streakVerdict`) 순간 기록과 경기 전 줄을 만든다.

**Tech Stack:** Python 3.11(venv, 평범한 스크립트 테스트), TypeScript/Next.js 16 + vitest, Supabase Postgres.

**Spec:** `docs/superpowers/specs/2026-10-11-record-book-phase4c-design.md`

## Global Constraints

- 파이썬은 **반드시** `D:\영상작업\축구\개발\.venv\Scripts\python.exe`(Anaconda 금지). 테스트 실행은 `PYTHONIOENCODING=utf-8`.
- 메인 작업트리에서 수집기가 돈다: `tools/live_collector.py`·`tools/daily_batch.py`는 건드리지 않는다. 브랜치 전환 금지. **다른 세션이 같은 작업트리를 쓰고 main에 직접 푸시한다** — `git add`는 항상 명시한 경로만, 편집 전 `git status --short`로 그 파일에 다른 세션의 미커밋 수정이 있는지 확인하고(있으면 그 파일은 건드리지 않고 사용자에게 알린다), 푸시 여부는 `git fetch`/`git status -sb`로 먼저 확인한다.
- DB 쓰기(`--rebuild`)와 `git push`는 각각 실행 직전에 사용자 확인을 받는다(Task 5·6). 로컬 커밋은 계획대로.
- 옛 iOS Safari 대상: 클라이언트 번들 파일(`seasonMoments.ts`, `streakKinds.ts`, `streakMoments.ts`, `recordsMoments.ts`)에 `.at()`, `.replaceAll()`, `??=` 같은 최신 문법을 쓰지 않는다. 서버 전용 모듈(`supabaseServer`, `cachePolicy`)을 import하지 않는다.
- 시즌 누적 = 정규시즌에서 뛴(출전 시간 > 0) 경기의 공식 박스 합계(득점 `score`, 리바 `rb`, 어시 `ast`, 스틸 `stl`, 블록 `bs`, 3점 `threep`), 시즌 = `seasonName`, 시즌 중 이적은 합산, 플레이오프·챔프전 제외. 알림은 순위가 좋아질 때만.
- 사용자에게는 한국어로 보고한다. 푸시 전 `git archive HEAD` 복사본으로 `next build`(Task 6).

---

### Task 1: 파이썬 — 선수-시즌 누적 상태·보드·로그

**Files:**
- Modify: `tools/record_streaks.py`, `tools/record_book.py`(`STREAK_BOARDS`), `tools/test_record_streaks.py`

**Interfaces:**
- Produces: `record_streaks.SEASON_STAT`(kind → (rec 키, 보드 이름, 후보 최소값)), `SEASON_MIN`, 로그 종류 `ss_gp ss_pts ss_reb ss_ast ss_stl ss_blk ss_tpm`(`before_len/after_len` = 그 시즌 누적), 보드 `pg.season_{pts,reb,ast,stl,blk,tpm}.max`(bucket `S`, `period` = `A:`/`E:` + 시즌 이름, `subject_name` = `이름(시즌)`, `gmkey` = 그 시즌 그 선수의 마지막 출전 경기). `rb.STREAK_BOARDS`는 `BOARD` 값 순서와 같은 21개.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
        old, old_kind = rs.MIN_ROW, rs.MIN_ROW_KIND
        rs.MIN_ROW, rs.MIN_ROW_KIND = 2, {}
        try:
            return fn()
        finally:
            rs.MIN_ROW, rs.MIN_ROW_KIND = old, old_kind
    return run
~~~
<!-- new -->
~~~python
        old, old_kind, old_season = rs.MIN_ROW, rs.MIN_ROW_KIND, rs.SEASON_MIN
        rs.MIN_ROW, rs.MIN_ROW_KIND, rs.SEASON_MIN = 2, {}, {}
        try:
            return fn()
        finally:
            rs.MIN_ROW, rs.MIN_ROW_KIND, rs.SEASON_MIN = old, old_kind, old_season
    return run
~~~

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
@small_min
def test_team_streaks_reset_each_season_and_ignore_playoffs():
~~~
<!-- new -->
~~~python
@small_min
def test_season_totals_accumulate_reset_each_season_and_ignore_playoffs_and_dnp():
    s1, s2 = "2025-2026", "2026-2027"
    games = [
        game_of("S47G01N1", "2025-10-01", "H", "A", [("p1", "H", "", {"score": 10, "threep": 2})], season=s1),
        game_of("S47G01N2", "2025-10-02", "H", "A", [("p1", "H", "", {"score": 20, "ast": 5})], season=s1),
        game_of("S47G01N3", "2025-10-03", "H", "A", [("p1", "H", "dnp", {"score": 99})], season=s1),                       # 0분 명단은 세지 않는다
        game_of("S47G03N1", "2025-10-04", "H", "A", [("p1", "H", "", {"score": 40})], season=s1, category="플레이오프"),     # 플레이오프도 세지 않는다
        game_of("S49G01N1", "2026-10-01", "H", "A", [("p1", "H", "", {"score": 7})], season=s2),                           # 새 시즌: 처음부터
    ]
    rows, log = rs.compute(games, keep_days=None)
    assert log_of(log, "p1", "ss_pts") == [("S47G01N1", 0, 10, False), ("S47G01N2", 10, 30, False), ("S49G01N1", 0, 7, True)]
    assert log_of(log, "p1", "ss_gp") == [("S47G01N1", 0, 1, False), ("S47G01N2", 1, 2, False), ("S49G01N1", 0, 1, True)]
    assert log_of(log, "p1", "ss_tpm") == [("S47G01N1", 0, 2, False)]                                                       # 값이 0인 경기엔 행이 없고, 지난 시즌 마지막 행은 alive가 아니다
    assert log_of(log, "p1", "ss_ast") == [("S47G01N2", 0, 5, False)]
    starts = {(r["gmkey"], r["kind"]): r["start_gmkey"] for r in log if r["pcode"] == "p1"}
    assert starts[("S47G01N2", "ss_pts")] == "S47G01N1" and starts[("S49G01N1", "ss_pts")] == "S49G01N1"                  # 시즌 첫 출전 경기
    assert rows_of(rows, "pg.season_pts.max") == [("p1", 7, "A:2026-2027", "S49G01N1"), ("p1", 30, "E:2025-2026", "S47G01N2")]
    assert [r["subject_name"] for r in rows if r["board"] == "pg.season_pts.max" and r["value"] == 30] == ["선수p1(2025-2026)"]
    assert {r["bucket"] for r in rows if r["board"].startswith("pg.season_")} == {"S"}


@small_min
def test_season_totals_follow_the_player_across_teams_and_use_the_candidate_floor():
    games = [
        game_of("S49G01N1", "2026-10-01", "H", "A", [("p1", "H", "", {"score": 10})]),
        game_of("S49G01N2", "2026-10-02", "X", "A", [("p1", "X", "", {"score": 12})]),           # 같은 시즌에 팀을 옮겼다
    ]
    rows, _ = rs.compute(games)
    row = [r for r in rows if r["board"] == "pg.season_pts.max"][0]
    assert (row["value"], row["tcode"], row["gmkey"]) == (22, "X", "S49G01N2")
    rs.SEASON_MIN = {"ss_pts": 50}
    rows2, _ = rs.compute(games)
    assert not [r for r in rows2 if r["board"] == "pg.season_pts.max"]                      # 후보 최소값 미만은 행이 아니다(small_min이 끝나면 원래 값으로 돌아온다)


@small_min
def test_team_streaks_reset_each_season_and_ignore_playoffs():
~~~

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
    assert tuple(rs.BOARD.values()) == rb.STREAK_BOARDS == rs.STREAK_BOARDS and len(rb.STREAK_BOARDS) == 15
~~~
<!-- new -->
~~~python
    assert tuple(rs.BOARD.values()) == rb.STREAK_BOARDS == rs.STREAK_BOARDS and len(rb.STREAK_BOARDS) == 21
~~~

<!-- edit: tools/test_record_streaks.py -->
<!-- old -->
~~~python
    alive = [r for r in log if r["pcode"] == "290381" and r["kind"] == "gp" and r["alive"]]
~~~
<!-- new -->
~~~python
    for board, name, value in (("pg.season_pts.max", "피트 마이클(2006-2007)", 1826), ("pg.season_reb.max", "제임스 메이스(2018-2019)", 780), ("pg.season_ast.max", "주희정(2008-2009)", 450),
                               ("pg.season_stl.max", "크리스 윌리엄스(2011-2012)", 142), ("pg.season_blk.max", "브라이언 던스톤(2008-2009)", 162), ("pg.season_tpm.max", "전성현(2021-2022)", 177)):
        t = top(board)[0]
        assert (t["subject_name"], t["value"]) == (name, value), (board, t)                                                                  # 2026-10-11 raw 실측
    alive = [r for r in log if r["pcode"] == "290381" and r["kind"] == "gp" and r["alive"]]
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py`

Expected: `@small_min` 래퍼가 `AttributeError: module 'record_streaks' has no attribute 'SEASON_MIN'`로 먼저 죽어 `small_min`을 쓰는 테스트 전부 FAIL.

- [ ] **Step 3: 구현**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
                 "tg.win_streak.max", "tg.loss_streak.max")
~~~
<!-- new -->
~~~python
                 "tg.win_streak.max", "tg.loss_streak.max",
                 "pg.season_pts.max", "pg.season_reb.max", "pg.season_ast.max", "pg.season_stl.max", "pg.season_blk.max", "pg.season_tpm.max")
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
TEAM_KINDS = ("tw", "tl")
~~~
<!-- new -->
~~~python
# 4단계 C - 선수-시즌 누적(정규시즌, 뛴 경기의 공식 박스 합계). 종류 -> (rec 키, 보드 이름, 보드 행 후보 최소값 - 10위 값보다 한참 낮게). 로그의 ss_gp는 그 시즌 출전 경기 수(보드 없음).
SEASON_STAT = {
    "ss_pts": ("score", "pg.season_pts.max", 600), "ss_reb": ("rb", "pg.season_reb.max", 300), "ss_ast": ("ast", "pg.season_ast.max", 150),
    "ss_stl": ("stl", "pg.season_stl.max", 60), "ss_blk": ("bs", "pg.season_blk.max", 50), "ss_tpm": ("threep", "pg.season_tpm.max", 60),
}
SEASON_MIN = {k: v[2] for k, v in SEASON_STAT.items()}
TEAM_KINDS = ("tw", "tl")
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
KINDS = tuple(GAME_COND) + ("xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss") + TEAM_KINDS
~~~
<!-- new -->
~~~python
KINDS = tuple(GAME_COND) + ("xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss") + TEAM_KINDS + ("ss_gp",) + tuple(SEASON_STAT)
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
    "tw": "tg.win_streak.max", "tl": "tg.loss_streak.max",
}
~~~
<!-- new -->
~~~python
    "tw": "tg.win_streak.max", "tl": "tg.loss_streak.max",
    **{k: v[1] for k, v in SEASON_STAT.items()},
}
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
    rows, log = [], []
    latest_log = {}
~~~
<!-- new -->
~~~python
    rows, log = [], []
    latest_log = {}
    season_tot = {}                                  # pcode -> {"season", "gp", "tot": {종류: 합계}, "first": 첫 경기 번호, "last": 마지막 경기 번호, "tc"} - 정규시즌 선수-시즌 누적
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
        rows.append(rb._row(g, BOARD[kind], "G", pcode, period, run["len"], names.get(pcode, pcode), run["tc"]))

    for n, g in enumerate(games):
~~~
<!-- new -->
~~~python
        rows.append(rb._row(g, BOARD[kind], "G", pcode, period, run["len"], names.get(pcode, pcode), run["tc"]))

    def emit_season(pcode, st, alive):
        g = info[st["last"]]
        for kind, (_, board, _) in SEASON_STAT.items():
            v = st["tot"][kind]
            if v > 0 and v >= SEASON_MIN.get(kind, 0):
                rows.append(rb._row(g, board, "S", pcode, ("A:" if alive else "E:") + st["season"], v, f"{names.get(pcode, pcode)}({st['season']})", st["tc"]))

    for n, g in enumerate(games):
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
            # --- 팀 연승·연패: 공식 최종 점수로 승패가 갈린 정규시즌 경기, 시즌이 바뀌면 처음부터
~~~
<!-- new -->
~~~python
            # --- 선수-시즌 누적: 뛴 경기의 공식 박스를 시즌(seasonName)별로 합산, 시즌이 바뀌면 이전 시즌을 행으로 닫고 처음부터
            for p in g["players"]:
                if rb.played_seconds(p["rec"]) <= 0:
                    continue
                pc, tc = p["pcode"], p["tcode"]
                st = season_tot.get(pc)
                if st and st["season"] != g["season"]:
                    emit_season(pc, st, False)
                    st = None
                if st is None:
                    st = season_tot[pc] = {"season": g["season"], "gp": 0, "tot": {k: 0 for k in SEASON_STAT}, "first": n, "last": n, "tc": tc}
                add_log(lg, pc, "ss_gp", st["gp"], st["gp"] + 1, st["first"])
                st["gp"] += 1
                for kind, (key, _, _) in SEASON_STAT.items():
                    v = p["rec"].get(key) or 0
                    if v > 0:
                        add_log(lg, pc, kind, st["tot"][kind], st["tot"][kind] + v, st["first"])
                        st["tot"][kind] += v
                st["last"], st["tc"] = n, tc
            # --- 팀 연승·연패: 공식 최종 점수로 승패가 갈린 정규시즌 경기, 시즌이 바뀌면 처음부터
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
    for tc, st in team.items():
        alive = info[st["last"]]["date"] >= cutoff
~~~
<!-- new -->
~~~python
    for pc, st in season_tot.items():
        seen = last_seen.get(pc)
        alive = seen is not None and info[seen]["date"] >= cutoff
        emit_season(pc, st, alive)
        if alive:
            for kind in ("ss_gp",) + tuple(SEASON_STAT):
                row = latest_log.get((pc, kind))
                if row and row["start_gmkey"] == info[st["first"]]["gmkey"]:        # 이번 시즌 행일 때만(지난 시즌 마지막 행은 alive가 아니다)
                    row["alive"] = True
    for tc, st in team.items():
        alive = info[st["last"]]["date"] >= cutoff
~~~

<!-- edit: tools/record_streaks.py -->
<!-- old -->
~~~python
- 보드 행(`BOARD`): 연속 하나당 한 행.
~~~
<!-- new -->
~~~python
- 선수-시즌 누적(4단계 C, `ss_*`): 정규시즌에서 뛴 경기의 공식 박스 합계(득점·리바·어시·스틸·블록·3점)를 시즌별로 쌓는다. 보드는 bucket `S`, 선수-시즌당 한 행(period `A:/E:<시즌>`).
- 보드 행(`BOARD`): 연속 하나당 한 행.
~~~

- [ ] **Step 4: 통과 확인**

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

Expected: 합성 테스트 전부 `실패 없음.`, 슬로우 실데이터 단언 통과, `--rebuild --dry-run`은 `연속 보드 N행 + 로그 M행`(로그가 약 1.5만 행 늘어난다)과 `보관 행 K개`(MAX_ROWS 20,000 이내)를 찍고 소요 시간이 크게 늘지 않는다(노트북 부하에 따라 2~8분).

- [ ] **Step 5: 커밋**

```bash
git add tools/record_streaks.py tools/record_book.py tools/test_record_streaks.py
git commit -m "$(cat <<'EOF'
feat(records): player-season cumulative totals as boards and log kinds

Regular-season official box totals for points, rebounds, assists, steals, blocks and made threes are summed
per player and season (transfers combined, playoffs and zero-minute entries ignored). Six season boards
(bucket S, one row per player-season, "name(season)") and seven log kinds carry the running totals so the
site can read tonight's carried-in season state. STREAK_BOARDS now has 21 boards.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 웹 — 새 종류 정의와 서버 컨텍스트

**Files:**
- Modify: `courtside-web/lib/streakKinds.ts`, `courtside-web/lib/recordStreaks.ts`, `courtside-web/lib/recordStreaks.test.ts`, `courtside-web/lib/postgameReport.test.ts`(boards 리터럴)

**Interfaces:**
- Produces: `STREAK_KINDS`(22종, `ss_gp`·`ss_*` 추가), `SEASON_KINDS = ["ss_pts","ss_reb","ss_ast","ss_stl","ss_blk","ss_tpm"]`, `SeasonKind`, `isSeasonKind(kind)`, `STREAK_BOARD`(새 보드, `ss_gp`는 행이 없는 이름 `pg.season_gp.max`), `GAME_BASED_KINDS`에 `ss_gp`와 `SEASON_KINDS` 포함. `summarizeStreaks`는 비종료 경기에서 `start_gmkey` 시즌이 이 경기 시즌과 다른 팀·시즌 종류 상태를 버린다.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- edit: courtside-web/lib/recordStreaks.test.ts -->
<!-- old -->
~~~typescript
  it("새 보드 8개를 종류별로 읽는다", () => {
~~~
<!-- new -->
~~~typescript
  it("시즌 누적: 같은 시즌 상태만, 합계는 after, 정규시즌이 아니면 버린다", () => {
    const rows = [
      logRow("S49G01N10", "lee", "ss_pts", 120, 134, true, "S49G01N1"),     // 이번 시즌 누적 134점
      logRow("S49G01N10", "lee", "ss_gp", 7, 8, true, "S49G01N1"),
      logRow("S49G01N10", "alb", "ss_ast", 40, 47, true, "S47G01N3"),       // 지난 시즌 합계 - 새 시즌 경기 전에 쓰지 않는다
    ];
    const pre = summarizeStreaks({ ...base, final: false, freshTeams: new Set(["DB"]), boardRows: [], logRows: rows })!;
    expect(pre.state).toEqual({ lee: { ss_pts: { before: 134 }, ss_gp: { before: 8 } } });
    const fin = summarizeStreaks({ ...base, final: true, freshTeams: null, boardRows: [], logRows: rows.map((r) => ({ ...r, gmkey: "S49G01N11" })) })!;
    expect(fin.state.lee.ss_pts).toEqual({ before: 120, after: 134 });
    expect(fin.state.alb.ss_ast).toEqual({ before: 40, after: 47 });                       // 종료 경기는 이 경기 행이라 시즌 확인이 필요 없다
    const po = summarizeStreaks({ ...base, final: false, freshTeams: new Set(["DB"]), boardRows: [], logRows: rows, regular: false });
    expect(po).toBeNull();
  });

  it("시즌 보드 6개를 종류별로 읽는다", () => {
    const ctx = summarizeStreaks({
      ...base, final: false, freshTeams: new Set(), logRows: [],
      boardRows: [board("pg.season_pts.max", "mk", 1826, "E:2006-2007", "피트 마이클(2006-2007)"), board("pg.season_tpm.max", "js", 177, "E:2021-2022", "전성현(2021-2022)")],
    })!;
    expect(ctx.boards.ss_pts[0]).toMatchObject({ v: 1826, pcode: "mk", who: "피트 마이클(2006-2007)", active: false });
    expect(ctx.boards.ss_tpm[0].v).toBe(177);
    expect(ctx.boards.ss_gp).toEqual([]);
  });

  it("새 보드 8개를 종류별로 읽는다", () => {
~~~

<!-- edit: courtside-web/lib/postgameReport.test.ts -->
<!-- old -->
~~~typescript
cg_pts10: [], cg_pts20: [], cg_dd: [], cg_reb10: [], cg_tpm1: [], cg_ast5: [], tw: [], tl: [] },
~~~
<!-- new -->
~~~typescript
cg_pts10: [], cg_pts20: [], cg_dd: [], cg_reb10: [], cg_tpm1: [], cg_ast5: [], tw: [], tl: [], ss_gp: [], ss_pts: [], ss_reb: [], ss_ast: [], ss_stl: [], ss_blk: [], ss_tpm: [] },
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/recordStreaks.test.ts`

Expected: FAIL — `ctx.boards.ss_pts`가 undefined, 시즌 상태가 읽히지 않는다.

- [ ] **Step 3: 구현**

<!-- edit: courtside-web/lib/streakKinds.ts -->
<!-- old -->
~~~typescript
  "cg_pts10", "cg_pts20", "cg_dd", "cg_reb10", "cg_tpm1", "cg_ast5", "tw", "tl",
] as const;
~~~
<!-- new -->
~~~typescript
  "cg_pts10", "cg_pts20", "cg_dd", "cg_reb10", "cg_tpm1", "cg_ast5", "tw", "tl",
  "ss_gp", "ss_pts", "ss_reb", "ss_ast", "ss_stl", "ss_blk", "ss_tpm",
] as const;
~~~

<!-- edit: courtside-web/lib/streakKinds.ts -->
<!-- old -->
~~~typescript
export const isTeamKind = (k: StreakKind) => k === "tw" || k === "tl";
~~~
<!-- new -->
~~~typescript
export const isTeamKind = (k: StreakKind) => k === "tw" || k === "tl";
/** 선수-시즌 누적 6종(4단계 C) - 로그의 before/after가 그 시즌 합계다. ss_gp는 그 시즌 출전 경기 수(상태만 있고 보드 행은 없다). */
export const SEASON_KINDS = ["ss_pts", "ss_reb", "ss_ast", "ss_stl", "ss_blk", "ss_tpm"] as const;
export type SeasonKind = (typeof SEASON_KINDS)[number];
export const isSeasonKind = (k: StreakKind) => k === "ss_gp" || (SEASON_KINDS as readonly string[]).indexOf(k) >= 0;
~~~

<!-- edit: courtside-web/lib/streakKinds.ts -->
<!-- old -->
~~~typescript
export const GAME_BASED_KINDS: readonly StreakKind[] = ["gp", ...CG_KINDS, ...TEAM_KINDS];
~~~
<!-- new -->
~~~typescript
export const GAME_BASED_KINDS: readonly StreakKind[] = ["gp", ...CG_KINDS, ...TEAM_KINDS, "ss_gp", ...SEASON_KINDS];
~~~

<!-- edit: courtside-web/lib/streakKinds.ts -->
<!-- old -->
~~~typescript
  tl: "tg.loss_streak.max",
};
~~~
<!-- new -->
~~~typescript
  tl: "tg.loss_streak.max",
  ss_gp: "pg.season_gp.max", // 행이 없는 이름(상태 전용 종류)
  ss_pts: "pg.season_pts.max",
  ss_reb: "pg.season_reb.max",
  ss_ast: "pg.season_ast.max",
  ss_stl: "pg.season_stl.max",
  ss_blk: "pg.season_blk.max",
  ss_tpm: "pg.season_tpm.max",
};
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
import { GAME_BASED_KINDS, isTeamKind, KIND_OF_BOARD,
~~~
<!-- new -->
~~~typescript
import { GAME_BASED_KINDS, isSeasonKind, isTeamKind, KIND_OF_BOARD,
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
    // 팀 연승·연패는 시즌 안에서만 이어진다 - 지난 시즌에 시작된 연속은 새 시즌 경기 전에 쓰지 않는다
    if (!args.final && isTeamKind(kind) && seasonOf(r.start_gmkey) !== seasonOf(args.gmkey)) continue;
~~~
<!-- new -->
~~~typescript
    // 팀 연승·연패와 시즌 누적은 시즌 안에서만 이어진다 - 지난 시즌에 시작된 상태는 새 시즌 경기 전에 쓰지 않는다
    if (!args.final && (isTeamKind(kind) || isSeasonKind(kind)) && seasonOf(r.start_gmkey) !== seasonOf(args.gmkey)) continue;
~~~

<!-- edit: courtside-web/lib/recordStreaks.ts -->
<!-- old -->
~~~typescript
/** 연속 보드 15개의 보관 행 전부(수백~천 행)
~~~
<!-- new -->
~~~typescript
/** 연속·시즌 보드 21개의 보관 행 전부(수백~천 행)
~~~

- [ ] **Step 4: 통과 확인**

Run:

```bash
cd courtside-web
npx vitest run lib/recordStreaks.test.ts lib/streakMoments.test.ts lib/gameStreakMoments.test.ts lib/postgameReport.test.ts
npx tsc --noEmit
npx eslint lib/streakKinds.ts lib/recordStreaks.ts lib/recordStreaks.test.ts --quiet
```

Expected: 통과, `tsc`·`eslint` 출력 없음(다른 세션의 작업 중 파일 오류는 내 파일이 아니면 사용자에게 알린다).

- [ ] **Step 5: 커밋**

```bash
git add courtside-web/lib/streakKinds.ts courtside-web/lib/recordStreaks.ts courtside-web/lib/recordStreaks.test.ts courtside-web/lib/postgameReport.test.ts
git commit -m "$(cat <<'EOF'
feat(web): streak context reads the player-season totals

ss_* kinds join the shared kind list; their carried-in state is only used when it started in the same season
as the game, and every season kind is dropped outside the regular season, like the team runs.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 웹 — 시즌 누적 엔진 `seasonMoments.ts`

**Files:**
- Create: `courtside-web/lib/seasonMoments.ts`, `courtside-web/lib/seasonMoments.test.ts`
- Modify: `courtside-web/lib/streakMoments.ts`(`streakVerdict`의 `before` 인자), `courtside-web/lib/recordsMoments.ts`

**Interfaces:**
- Consumes: Task 2의 `StreakContext`/`SEASON_KINDS`, `boxEvents.applyBoxEvent/emptyBoxLine`, `streakVerdict(entries, pcode, n, milestone, before?)`
- Produces: `buildSeasonMoments(streaks, events, opts, finals?) -> RecordMoment[]`(보드 `pg.season_*.max`, bucket `S`), `buildSeasonChances(streaks) -> SeasonChance[]`(최대 4), 상수 `REGULAR_GAMES`(54)·`PACE_MIN_GP`(10)·`PACE_TOP`(5), `buildAllRecordMoments`가 이를 합친다.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- create: courtside-web/lib/seasonMoments.test.ts -->
~~~typescript
import { describe, expect, it } from "vitest";
import { buildAllRecordMoments } from "./recordsMoments";
import type { RecordEvent } from "./records";
import { buildSeasonChances, buildSeasonMoments } from "./seasonMoments";
import { STREAK_KINDS, type StreakContext, type StreakEntry, type StreakKind } from "./streakKinds";

const names = { player: (p: string) => `선수${p}`, team: (t: string) => `팀${t}` };
const OPTS = { names, final: false, home: "H", away: "A" };
const ent = (v: number, pcode: string, who: string): StreakEntry => ({ v, pcode, who, active: false, d: "2022-04-01" });
function ctxOf(o: { boards?: Partial<Record<StreakKind, StreakEntry[]>>; state?: StreakContext["state"]; known?: string[]; final?: boolean; players?: StreakContext["players"] }): StreakContext {
  const boards = Object.fromEntries(STREAK_KINDS.map((k) => [k, o.boards?.[k] ?? []])) as Record<StreakKind, StreakEntry[]>;
  return { asOf: "2026-10-11", final: o.final ?? false, boards, state: o.state ?? {}, known: o.known ?? [], players: o.players ?? {} };
}
const ev = (pcode: string, code: string, n = 0): RecordEvent => ({ pcode, tcode: "H", action_code: code, quarter: "Q1", clock_min: 9, clock_sec: 59 - n });
const shots = (pcode: string, codes: string[]) => codes.map((c, i) => ev(pcode, c, i));

// 시즌 득점 보드: 순위 1~11 (TOP10 문턱 1,353)
const PTS = [1826, 1517, 1484, 1421, 1389, 1380, 1370, 1365, 1360, 1353, 1295].map((v, i) => ent(v, `p${i}`, `선수${i}(2020-2021)`));

describe("시즌 누적 - 이벤트로 누적이 늘 때마다 순위를 비교", () => {
  it("순위가 처음 10위 안에 드는 이벤트에서 알린다(아직 11위인 이벤트는 건너뛴다)", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350 } } }, known: ["z"] });
    const m = buildSeasonMoments(s, shots("z", ["201", "201"]), OPTS).filter((x) => x.phase === "done");     // 1352(11위) -> 1354(10위)
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ board: "pg.season_pts.max", bucket: "S", subject: "z", value: 1354, idx: 1, rank: 10, provisional: true, scope: "p", tcode: "H" });
    expect(m[0].text).toBe("시즌 득점 1,354점째 KBL 역대 시즌 10위");
    expect(m[0].detail).toBe("역대 1위 1,826점: 선수0(2020-2021)");
  });
  it("한 이벤트로 여러 점이 늘어도 직전 값과 비교한다(3점슛으로 11위 -> 10위)", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1352 } } }, known: ["z"] });
    const m = buildSeasonMoments(s, shots("z", ["205", "201"]), OPTS).filter((x) => x.phase === "done");   // 1355(10위) 이후 1357도 10위
    expect(m.map((x) => x.value)).toEqual([1355]);
  });
  it("순위가 그대로면 알리지 않고, 타이·신기록은 순위가 좋아지는 첫 돌파에서 한 번씩", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1824 } } }, known: ["z"] });
    const m = buildSeasonMoments(s, shots("z", ["201", "201", "201"]), OPTS).filter((x) => x.phase === "done");   // 1826(타이) -> 1828(신기록) -> 1830(그대로)
    expect(m.map((x) => x.value)).toEqual([1826, 1828]);
    expect(m[0].text).toBe("시즌 득점 1,826점째 KBL 역대 시즌 타이 기록(공동 1위)");
    expect(m[1].text).toBe("시즌 득점 1,828점째 KBL 역대 시즌 신기록(종전 1,826점)");
  });
  it("지표별로 따로 본다 - 3점슛 성공은 3점슛 보드로", () => {
    const TPM = [177, 171, 143, 142, 141, 140, 139, 138, 137, 133, 129].map((v, i) => ent(v, `t${i}`, `선수${i}(2021-2022)`));
    const s = ctxOf({ boards: { ss_tpm: TPM }, state: { z: { ss_tpm: { before: 130 } } }, known: ["z"] });
    const m = buildSeasonMoments(s, shots("z", ["205", "205", "205"]), OPTS).filter((x) => x.phase === "done" && x.board === "pg.season_tpm.max");   // 131(11위) 132(11위) 133(공동 10위)
    expect(m.map((x) => [x.value, x.text])).toEqual([[133, "시즌 3점슛 133개째 KBL 역대 시즌 공동 10위"]]);
  });
  it("본인의 진행 중 행은 비교에서 뺀다", () => {
    const own = [{ ...ent(1400, "z", "제트(2026-2027)"), active: true }, ...PTS];
    const s = ctxOf({ boards: { ss_pts: own }, state: { z: { ss_pts: { before: 1350 } } }, known: ["z"] });
    const m = buildSeasonMoments(s, shots("z", ["201", "201"]), OPTS).filter((x) => x.phase === "done");
    expect(m.map((x) => x.value)).toEqual([1354]);
  });
  it("상태를 믿을 수 없는 선수(known 밖)나 이벤트에 없는 선수는 만들지 않는다", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350 } } }, known: [] });
    expect(buildSeasonMoments(s, shots("z", ["201", "201"]), OPTS)).toEqual([]);
  });
});

describe("종료 경기 - 공식 로그 행이 기준", () => {
  const events = shots("z", ["201", "201"]);                                                  // 이벤트 합계 4점
  it("로그 행이 있고 이벤트 합계가 공식 증가분과 같으면 이벤트 위치에서, 잠정 아님", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350, after: 1354 } } }, known: ["z"], final: true });
    const m = buildSeasonMoments(s, events, { ...OPTS, final: true }).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ idx: 1, value: 1354, provisional: false });
  });
  it("이벤트가 공식과 다르면 그 선수의 마지막 이벤트에서 공식 값으로 한 번", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350, after: 1354 } } }, known: ["z"], final: true });
    const m = buildSeasonMoments(s, events.slice(0, 1), { ...OPTS, final: true }).filter((x) => x.phase === "done");           // 이벤트 2점 vs 공식 4점
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ idx: 0, value: 1354 });
  });
  it("로그 행이 없으면(공식에서 값이 늘지 않음) 알리지 않는다", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: {}, known: ["z"], final: true });
    expect(buildSeasonMoments(s, events, { ...OPTS, final: true })).toEqual([]);
  });
});

describe("finals(대조용)", () => {
  it("이 경기에서 늘어난 지표는 before + 이 경기 합계, 늘지 않은 지표와 출전 경기 수는 채우지 않는다", () => {
    const finals = new Map<string, number>();
    const s = ctxOf({ boards: {}, state: { z: { ss_pts: { before: 1350 }, ss_ast: { before: 200 } } }, known: ["z"] });
    buildSeasonMoments(s, shots("z", ["201", "201", "211"]), OPTS, finals);
    expect(Object.fromEntries(finals)).toEqual({ "ss_pts|z": 1354, "ss_ast|z": 201 });
  });
});

describe("경기 전 기록 도전", () => {
  it("한 경기 안에 닿는 거리 - 순위가 좋아지는 가장 작은 증가분", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350 }, ss_gp: { before: 30 } } }, known: ["z"], players: { z: { name: "제트", tcode: "H" } } });
    const c = buildSeasonChances(s);
    expect(c.map((x) => x.text)).toEqual(["오늘 3점 더하면 시즌 득점 1,353점 KBL 역대 시즌 공동 10위"]);
    expect(c[0]).toMatchObject({ name: "제트", tcode: "H" });
  });
  it("페이스 - 10경기 이상 뛴 선수의 54경기 환산이 5위 안이면(거리 줄이 우선)", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { w: { ss_pts: { before: 1100 }, ss_gp: { before: 40 } }, y: { ss_pts: { before: 1100 }, ss_gp: { before: 9 } } }, known: ["w", "y"],
      players: { w: { name: "더블유", tcode: "H" }, y: { name: "와이", tcode: "A" } } });
    const c = buildSeasonChances(s);
    expect(c.map((x) => x.text)).toEqual(["시즌 득점 1,100점(40경기) · 이 페이스면 54경기 1,485점 — KBL 역대 시즌 3위"]);       // y는 9경기라 페이스 줄이 없다
  });
  it("상한 4와 known 밖 제외", () => {
    const state: StreakContext["state"] = {};
    const players: StreakContext["players"] = {};
    const known: string[] = [];
    for (let i = 0; i < 6; i++) {
      state[`q${i}`] = { ss_pts: { before: 1350 }, ss_gp: { before: 30 } };
      players[`q${i}`] = { name: `큐${i}`, tcode: "H" };
      if (i < 5) known.push(`q${i}`);
    }
    const c = buildSeasonChances(ctxOf({ boards: { ss_pts: PTS }, state, known, players }));
    expect(c).toHaveLength(4);
  });
});

describe("buildAllRecordMoments", () => {
  it("시즌 누적 순간도 합쳐져 시간순이다", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350 } } }, known: ["z"] });
    expect(buildAllRecordMoments({ asOf: "x", boards: {} }, shots("z", ["201", "201"]), OPTS, s).map((x) => x.board)).toContain("pg.season_pts.max");
  });
});
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/seasonMoments.test.ts`

Expected: FAIL — `Failed to resolve import "./seasonMoments"`.

- [ ] **Step 3: 구현**

<!-- edit: courtside-web/lib/streakMoments.ts -->
<!-- old -->
~~~typescript
export function streakVerdict(entries: StreakEntry[], pcode: string, n: number, milestone: boolean) {
  const s = summaryOf(entries, pcode);
  const info = rankInfo(s.tops, n, "max");
  const beforeInfo = n > 1 ? rankInfo(s.tops, n - 1, "max") : null;
~~~
<!-- new -->
~~~typescript
export function streakVerdict(entries: StreakEntry[], pcode: string, n: number, milestone: boolean, before = n - 1) {
  const s = summaryOf(entries, pcode);
  const info = rankInfo(s.tops, n, "max");
  const beforeInfo = before > 0 ? rankInfo(s.tops, before, "max") : null;
~~~

<!-- create: courtside-web/lib/seasonMoments.ts -->
~~~typescript
import { applyBoxEvent, emptyBoxLine, type BoxLine } from "./boxEvents";
import { clockOf, holdersLine, rankInfo, TOP_RANKS, verdictText, type RankInfo, type RecordEvent, type RecordMoment, type RecordTimelineOptions, type ValueFmt } from "./records";
import { SEASON_KINDS, STREAK_BOARD, type SeasonKind, type StreakContext } from "./streakKinds";
import { streakVerdict, summaryOf } from "./streakMoments";

// 역대 기록 4단계 C 엔진 - 선수 시즌 누적(정규시즌 합계). 설계: docs/superpowers/specs/2026-10-11-record-book-phase4c-design.md §4
//
// 순간 기록: 이벤트로 선수의 이 경기 누적(applyBoxEvent)이 지표별로 늘 때마다 n = (이 경기 직전 시즌 누적) + 이 경기 누적을 만들고,
//   직전 값과 순위를 비교해 **순위가 좋아질 때만**(10위 안 첫 진입, 한 칸 상승, 신기록 첫 돌파) 알린다. 종료 경기는 공식 로그 행(after > before)이 있는 지표만.
// 경기 전 도전: ① 한 경기 안에 닿는 거리(순위가 좋아지는 가장 작은 증가분) ② 페이스(10경기 이상 뛴 선수의 54경기 환산이 5위 안).
// 순수 함수 - 서버 전용 모듈을 import하지 않는다.

export const REGULAR_GAMES = 54;
export const PACE_MIN_GP = 10;
export const PACE_TOP = 5;
const SCOPE = "역대 시즌";
const levelOf = (i: RankInfo) => (i.breaks ? 0 : i.rank);
const num = (v: number) => (v >= 1000 ? `${Math.floor(v / 1000)},${String(v % 1000).padStart(3, "0")}` : String(v));

const SEASON: Record<SeasonKind, { label: string; unit: string; of: (b: BoxLine) => number; reach: number }> = {
  ss_pts: { label: "득점", unit: "점", of: (b) => b.pts, reach: 25 },
  ss_reb: { label: "리바운드", unit: "개", of: (b) => b.reb, reach: 12 },
  ss_ast: { label: "어시스트", unit: "개", of: (b) => b.ast, reach: 10 },
  ss_stl: { label: "스틸", unit: "개", of: (b) => b.stl, reach: 4 },
  ss_blk: { label: "블록", unit: "개", of: (b) => b.blk, reach: 4 },
  ss_tpm: { label: "3점슛", unit: "개", of: (b) => b.threePM, reach: 5 },
};
const fmtOf = (kind: SeasonKind): ValueFmt => (v) => `${num(v)}${SEASON[kind].unit}`;

export function buildSeasonMoments(
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
  const lastAt = new Map<string, { idx: number; tcode: string; clock: string }>();
  const pending = new Map<string, RecordMoment[]>();        // 종료 경기: `${kind}|${pcode}` -> 이벤트 위치에서 만든 순간 기록(공식 증가분과 같을 때만 채택)

  const make = (kind: SeasonKind, pcode: string, idx: number, tcode: string, clock: string, n: number, v: ReturnType<typeof streakVerdict>): RecordMoment | null => {
    const r = v.ranked;
    if (!v.worthy || !r) return null;
    const fmt = fmtOf(kind);
    return {
      id: `${kind}|${pcode}|${n}`, idx, until: Infinity, clock, phase: "done",
      board: STREAK_BOARD[kind], bucket: "S", subject: pcode, period: "", scope: "p", name: opts.names.player(pcode), tcode, value: n,
      rank: r.rank, tie: r.tie, breaks: r.breaks, remaining: 0,
      text: `시즌 ${SEASON[kind].label} ${num(n)}${SEASON[kind].unit}째 ${verdictText(r, fmt, "KBL", SCOPE)}`,
      detail: holdersLine(v.s, r, fmt), provisional, sig: levelOf(r),
    };
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (!e.pcode || !e.tcode || !e.action_code || !e.quarter || e.quarter === "PRE") continue;
    let box = boxes.get(e.pcode);
    if (!box) {
      box = emptyBoxLine();
      boxes.set(e.pcode, box);
    }
    const was: Record<string, number> = {};
    for (const kind of SEASON_KINDS) was[kind] = SEASON[kind].of(box);
    applyBoxEvent(box, e.action_code);
    const clock = clockOf(e);
    lastAt.set(e.pcode, { idx, tcode: e.tcode, clock });
    if (!known.has(e.pcode)) continue;
    for (const kind of SEASON_KINDS) {
      const now = SEASON[kind].of(box);
      if (now <= was[kind]) continue;
      const st = streaks.state[e.pcode]?.[kind];
      if (streaks.final && !(st && st.after != null)) continue;                    // 종료 경기: 공식 로그 행이 있는 지표만
      const base = st?.before ?? 0;
      const m = make(kind, e.pcode, idx, e.tcode, clock, base + now, streakVerdict(streaks.boards[kind], e.pcode, base + now, false, base + was[kind]));
      if (!m) continue;
      if (streaks.final) {
        const key = `${kind}|${e.pcode}`;
        const list = pending.get(key);
        if (list) list.push(m);
        else pending.set(key, [m]);
      } else out.push(m);
    }
  }

  for (const pcode of Object.keys(streaks.state)) {
    if (!known.has(pcode)) continue;
    const box = boxes.get(pcode);
    for (const kind of SEASON_KINDS) {
      const st = streaks.state[pcode]?.[kind];
      const got = box ? SEASON[kind].of(box) : 0;
      if (got > 0) finals?.set(`${kind}|${pcode}`, (st?.before ?? 0) + got);
      if (!streaks.final || !st || st.after == null) continue;
      const key = `${kind}|${pcode}`;
      if (st.after - st.before === got) {
        for (const m of pending.get(key) ?? []) out.push(m);
      } else {
        const at = lastAt.get(pcode);                                              // 이벤트와 공식 박스가 다르다 - 공식 값으로 마지막 이벤트에서 한 번
        const m = at ? make(kind, pcode, at.idx, at.tcode, at.clock, st.after, streakVerdict(streaks.boards[kind], pcode, st.after, false, st.before)) : null;
        if (m) out.push(m);
      }
    }
  }
  return out;
}

/** 경기 전 "기록 도전" 한 줄(이름·팀 칩은 recordChanceList가 붙인다). */
export type SeasonChance = { id: string; name: string; tcode?: string; text: string; detail: string; sig: number };

/** 경기 전 도전 - 한 경기 안에 닿는 거리(우선)와 페이스. 상태를 믿을 수 없는 선수(known 밖)는 만들지 않는다. 알릴 만한 순으로 최대 4개. */
export function buildSeasonChances(streaks: StreakContext): SeasonChance[] {
  const out: SeasonChance[] = [];
  for (const pcode of streaks.known) {
    const st = streaks.state[pcode];
    const p = streaks.players[pcode];
    if (!st || !p) continue;
    const gp = st.ss_gp?.before ?? 0;
    for (const kind of SEASON_KINDS) {
      const total = st[kind]?.before ?? 0;
      if (total <= 0) continue;
      const fmt = fmtOf(kind);
      const who = { name: p.name, ...(p.tcode ? { tcode: p.tcode } : {}) };
      let found = false;
      for (let step = 1; step <= SEASON[kind].reach; step++) {
        const v = streakVerdict(streaks.boards[kind], pcode, total + step, false, total);
        if (v.worthy && v.ranked) {
          out.push({ ...who, id: `${kind}|${pcode}|reach`, text: `오늘 ${step}${SEASON[kind].unit} 더하면 시즌 ${SEASON[kind].label} ${fmt(total + step)} ${verdictText(v.ranked, fmt, "KBL", SCOPE)}`, detail: holdersLine(v.s, v.ranked, fmt), sig: levelOf(v.ranked) });
          found = true;
          break;
        }
      }
      if (found || gp < PACE_MIN_GP) continue;
      const pace = Math.round((total / gp) * REGULAR_GAMES);
      if (pace <= total) continue;
      const s = summaryOf(streaks.boards[kind], pcode);
      const info = rankInfo(s.tops, pace, "max");
      if (!info || info.rank > TOP_RANKS || !(info.breaks || info.rank <= PACE_TOP)) continue;
      out.push({ ...who, id: `${kind}|${pcode}|pace`, text: `시즌 ${SEASON[kind].label} ${fmt(total)}(${gp}경기) · 이 페이스면 ${REGULAR_GAMES}경기 ${fmt(pace)} — ${verdictText(info, fmt, "KBL", SCOPE)}`, detail: holdersLine(s, info, fmt), sig: 100 + levelOf(info) });
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
import { buildSeasonMoments } from "./seasonMoments";
import { buildStreakMoments } from "./streakMoments";
~~~

<!-- edit: courtside-web/lib/recordsMoments.ts -->
<!-- old -->
~~~typescript
  const comeback = buildComebackMoments(ctx, events, opts);
  return [...base, ...kept, ...streak, ...game, ...comeback].sort((a, b) => a.idx - b.idx);
~~~
<!-- new -->
~~~typescript
  const comeback = buildComebackMoments(ctx, events, opts);
  const season = buildSeasonMoments(streaks ?? null, events, opts);
  return [...base, ...kept, ...streak, ...game, ...comeback, ...season].sort((a, b) => a.idx - b.idx);
~~~

- [ ] **Step 4: 통과 확인(기대값은 손으로 계산해 맞춘다)**

Run: `cd courtside-web && npx vitest run lib/seasonMoments.test.ts lib/streakMoments.test.ts lib/gameStreakMoments.test.ts lib/recordsMoments.test.ts lib/records.test.ts`

Expected: 통과. 실패하는 단언이 있으면 **구현이 아니라 기대값이 틀렸는지** 손으로 먼저 계산한다 — `PTS`의 TOP10 값은 `[1826,1517,1484,1421,1389,1380,1370,1365,1360,1353]`(순위 1~10, 1295는 11위라 `tops`에 없다), 순위는 "나보다 확실히 큰 값의 개수 + 1": 1354 → 10위(공동 아님), 1353 → 공동 10위, 1485 → 3위, 1826 → 공동 1위(타이), 1828 → 신기록. 3점슛 보드 TPM은 `[177,171,143,142,141,140,139,138,137,133]`이 TOP10이다.

- [ ] **Step 5: 린트·전체**

Run: `cd courtside-web && npx tsc --noEmit && npx eslint lib/seasonMoments.ts lib/seasonMoments.test.ts lib/streakMoments.ts lib/recordsMoments.ts --quiet && npx vitest run`

Expected: 출력 없음 / 전체 통과.

- [ ] **Step 6: 커밋**

```bash
git add courtside-web/lib/seasonMoments.ts courtside-web/lib/seasonMoments.test.ts courtside-web/lib/streakMoments.ts courtside-web/lib/recordsMoments.ts
git commit -m "$(cat <<'EOF'
feat(web): season-cumulative engine - rank climbs on the live box, pre-game reach and pace lines

The running season total (carried-in state plus this game's events) is compared with the previous value after
every event and announced only when the rank improves; a finished game trusts the official log row and falls
back to the player's last event when events and the official box disagree. Pre-game challenges list the
smallest one-game gain that improves the rank and, for players with 10+ games, a 54-game pace inside the top 5.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 경기 페이지 연결 + 파이썬↔웹 대조 + 문서

**Files:**
- Modify: `courtside-web/app/games/[gmkey]/page.tsx`, `tools/dump_record_fixtures.py`, `courtside-web/lib/records.streaks.parity.test.ts`, `README.md`
- Regenerate: `courtside-web/lib/__fixtures__/streakParity/*.json`

- [ ] **Step 1: 페이지에 경기 전 줄 합치기** (먼저 `git status --short "courtside-web/app/games/[gmkey]/page.tsx"`로 다른 세션의 미커밋 수정이 없는지 확인한다)

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
import { buildGameStreakChances } from "@/lib/gameStreakMoments";
~~~
<!-- new -->
~~~typescript
import { buildGameStreakChances } from "@/lib/gameStreakMoments";
import { buildSeasonChances } from "@/lib/seasonMoments";
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
[...buildStreakChances(streaks), ...buildGameStreakChances(streaks)]
~~~
<!-- new -->
~~~typescript
[...buildStreakChances(streaks), ...buildGameStreakChances(streaks), ...buildSeasonChances(streaks)]
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~typescript
·연속 슛은 선수 본인의 시도 순서 기준입니다.
~~~
<!-- new -->
~~~typescript
·시즌 누적은 정규시즌 합계 기준·연속 슛은 선수 본인의 시도 순서 기준입니다.
~~~

- [ ] **Step 2: 대조 도구와 테스트 확장**

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
            if r["kind"].startswith("cg_") and not box_ok.get(r["pcode"], False):
                continue                      # 이벤트 합계가 공식 박스와 다른 선수의 조건 연속은 대조 대상이 아니다
~~~
<!-- new -->
~~~python
            if r["kind"] == "ss_gp":
                continue                      # 시즌 출전 경기 수는 이벤트로 재현할 값이 아니다(파이썬 테스트가 본다)
            if r["kind"].startswith(("cg_", "ss_")) and not box_ok.get(r["pcode"], False):
                continue                      # 이벤트 합계가 공식 박스와 다른 선수의 조건 연속·시즌 누적은 대조 대상이 아니다
~~~

<!-- edit: courtside-web/lib/records.streaks.parity.test.ts -->
<!-- old -->
~~~typescript
import { buildGameStreakMoments } from "./gameStreakMoments";
~~~
<!-- new -->
~~~typescript
import { buildGameStreakMoments } from "./gameStreakMoments";
import { buildSeasonMoments } from "./seasonMoments";
~~~

<!-- edit: courtside-web/lib/records.streaks.parity.test.ts -->
<!-- old -->
~~~typescript
      buildGameStreakMoments(streaks, events, opts, finals);
~~~
<!-- new -->
~~~typescript
      buildGameStreakMoments(streaks, events, opts, finals);
      buildSeasonMoments(streaks, events, opts, finals);
~~~

<!-- edit: README.md -->
<!-- old -->
~~~text
**감시**: Supabase pg_cron(`watch_live_collector`, 1분마다)이 수집기 심박(`live_collector_status`)을
~~~
<!-- new -->
~~~text
- **4단계 C(2026-10-11, 설계 `docs/superpowers/specs/2026-10-11-record-book-phase4c-design.md`)** - 시즌 누적 기록: 선수의 정규시즌 득점·리바·어시·스틸·블록·3점슛 합계를 역대 선수-시즌 순위와 비교한다.
  같은 `record_streaks.py` 전체 재계산이 보드 6개(`pg.season_*.max`, bucket `S`, 선수-시즌당 한 행, period `A:/E:<시즌>`, 이름은 `이름(시즌)`)와 로그 종류 7개(`ss_gp`, `ss_*` - before/after가 시즌 누적)를 만든다 —
  DDL 없음, `STREAK_BOARDS`는 21개, 로그가 약 1.5만 행 늘어난다. 알림은 순위가 좋아질 때만이고, 경기 전 "기록 도전"에는 한 경기 안에 닿는 거리 줄과 10경기 이상 뛴 선수의 54경기 페이스(5위 안) 줄이 나온다.
  롤백: 웹 `git revert`, DB `DELETE FROM record_entries WHERE board LIKE 'pg.season\_%'` + `DELETE FROM record_streak_log WHERE kind LIKE 'ss\_%'`.

**감시**: Supabase pg_cron(`watch_live_collector`, 1분마다)이 수집기 심박(`live_collector_status`)을
~~~

- [ ] **Step 3: 픽스처 재생성과 대조**

Run:

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" dump_record_fixtures.py --streaks ../courtside-web/lib/__fixtures__/streakParity --gmkeys S23G01N165,S15G01N119,S15G01N121,S43G01N265,S49G01N10,S35G01N31,S33G01N268,S13G01N90,S27G01N227,S23G01N194,S37G01N170,S23G01N15,S31G01N104,S39G01N151
cd ../courtside-web
npx vitest run lib/records.streaks.parity.test.ts
```

Expected: `streak fixtures: 14개`, 대조 통과. 실패하면 출력의 `want`/`got`로 어긋난 (주체, 종류)를 확인한다 — 웹 엔진의 시즌 합계 계산(`before + 이 경기 이벤트 합계`)이 파이썬 `after`와 다른 것이다(이벤트-공식 불일치 선수는 `box_matches_official`로 이미 제외됨).

- [ ] **Step 4: 전체 확인 후 커밋**

Run:

```bash
cd courtside-web && npx tsc --noEmit && npx eslint lib components app --quiet && npx vitest run
cd ../tools
for t in test_record_book test_record_book_moments test_record_streaks test_record_book_hook; do PYTHONIOENCODING=utf-8 "$PY" $t.py 2>&1 | grep -E "FAIL|실패"; done
```

Expected: tsc·eslint 출력 없음, vitest 전체 통과, 파이썬 4종 `실패 없음.`

```bash
git add "courtside-web/app/games/[gmkey]/page.tsx" tools/dump_record_fixtures.py courtside-web/lib/records.streaks.parity.test.ts courtside-web/lib/__fixtures__/streakParity README.md docs/superpowers/plans/2026-10-11-record-book-phase4c.md
git commit -m "$(cat <<'EOF'
feat(web): pre-game season challenges on the game page and a Python-vs-web parity check for season totals

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: DB 재적재 · 검증 (**사용자 확인 필요 - 운영 DB 쓰기**)

**Files:** (코드 변경 없음 - 운영 작업)

**먼저 사용자에게 확인한다**: "공유 Supabase의 `record_entries` 연속·시즌 보드를 21개로 늘리고 `record_streak_log`에 시즌 누적 종류를 채워 전체 다시 채웁니다(`record_book.py --rebuild`, 한 트랜잭션, 노트북 부하에 따라 2~8분, DDL 없음, 로그 약 1.5만 행 증가). 진행할까요?"

- [ ] **Step 1: 사전 점검(DB 읽기 없음)**

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild --dry-run
```

Expected: 보관 행 수가 `MAX_ROWS`(20,000) 이내.

- [ ] **Step 2: 적재와 검증**

```bash
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild
PYTHONIOENCODING=utf-8 "$PY" record_book.py --verify
```

Expected: `교체 완료`, `--verify`가 `없는 행 0 / 남는 행 0 / 값이 다른 행 0`과 `연속 로그 검증: 0/0/0`. 재적재 도중 정산된 경기가 있으면 1~2건 어긋날 수 있다 — `record_book.py --gmkeys <그 경기들>` 후 `--verify`를 다시 돌린다.

- [ ] **Step 3: 알려진 값 확인**

```bash
PYTHONIOENCODING=utf-8 "$PY" -c "import sys; sys.path.insert(0, '.'); from sync_upcoming_games import get_conn; c = get_conn(); cur = c.cursor(); cur.execute(\"select distinct on (board) board, subject_name, value, period from record_entries where board like 'pg.season_%' order by board, value desc\"); [print(r) for r in cur.fetchall()]; cur.execute(\"select kind, count(*), count(*) filter (where alive) from record_streak_log where kind like 'ss_%' group by kind order by kind\"); [print(r) for r in cur.fetchall()]"
```

Expected: 피트 마이클(2006-2007) 득점 1,826·제임스 메이스 리바 780·주희정 어시 450·크리스 윌리엄스 스틸 142·브라이언 던스톤 블록 162·전성현 3점 177, 로그에 `ss_gp ss_pts ss_reb ss_ast ss_stl ss_blk ss_tpm`이 모두 있다.

---

### Task 6: 푸시 전 빌드 점검과 배포 (**푸시 전 사용자 확인 필요**)

**Files:** (코드 변경 없음)

**먼저 `git fetch origin && git status -sb`로 로컬이 origin보다 얼마나 앞선지 확인한다**(다른 세션이 이미 내 커밋을 올렸을 수 있다). 올릴 게 남아 있으면 사용자에게 확인한다.

- [ ] **Step 1: 푸시 전 빌드 점검(커밋된 HEAD 복사본)**

`git archive HEAD courtside-web`을 스크래치패드에 풀고(`.env.local`과 `node_modules`는 실제 폴더에서 복사 — junction은 Turbopack이 거부) `npx next build`가 `exit=0`인지 확인한다.

- [ ] **Step 2: 푸시와 배포 확인**

```bash
git fetch origin && git status -sb | head -3
git push origin main
gh api repos/onnebang/kbl_realdata/commits/$(git rev-parse HEAD)/status --jq '[.statuses[] | {context, state}]'
```

`Vercel – courtside-web`이 `success`가 될 때까지 확인한다(`Vercel – kbl-realdata` 실패는 기존 증상).

- [ ] **Step 3: 프로덕션 확인**

```bash
for g in S49G01N10 S49G01N16 S49G01N18; do curl -s -o "$SP/$g.html" -w "$g %{http_code} %{time_total}s\n" --compressed "https://courtside-web-ten.vercel.app/games/$g"; grep -c "Application error" "$SP/$g.html"; done
grep -o 'pg.season_pts.max|S[^,]\{0,30\}' "$SP/S49G01N16.html" | head -2
```

Expected: 200, `Application error` 0, 종료 경기 페이지 데이터에 시즌 보드(`pg.season_pts.max|S`)가 실려 있다. 새 줄은 시즌 중·후반에 순위가 오르는 경기에서 드물게 뜬다.

- [ ] **Step 4: 실패 시 롤백 순서**

웹 문제: 해당 커밋 `git revert`(새 보드·로그 종류는 옛 웹이 읽지 않으므로 DB는 그대로). 파이썬 문제: `record_streaks.py`·`record_book.py`를 이전 커밋으로 되돌려 `--rebuild`. DB 정리: `DELETE FROM record_entries WHERE board LIKE 'pg.season\_%'`, `DELETE FROM record_streak_log WHERE kind LIKE 'ss\_%'`.
