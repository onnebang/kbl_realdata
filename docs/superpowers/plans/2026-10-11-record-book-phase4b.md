# 역대 기록 4단계 B 구현 계획 — 최다 점수차 역전승

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이긴 팀이 경기 중 뒤졌던 최대 점수차를 역대 순위로 알린다 — 라이브 임박 줄(20점+ 열세)·리드 탈환 토스트(잠정), 종료 후 리포트·재생 줄.

**Architecture:** 파이썬은 `moment_candidates`(게이트 1 통과 경기)에 `comeback_candidates`를 더해 보드 `tg.comeback.max`(경기 단위, 승자 tcode)를 만든다 — 상태·로그·DDL 없음. 웹은 새 순수 엔진 `lib/comebackMoments.ts`가 이벤트의 두 팀 점수로 최대 열세를 따라가며 보드 요약과 비교하고, `buildAllRecordMoments`가 합친다.

**Tech Stack:** Python 3.11(venv, 평범한 스크립트 테스트), TypeScript/Next.js 16 + vitest, Supabase Postgres.

**Spec:** `docs/superpowers/specs/2026-10-11-record-book-phase4b-design.md`

## Global Constraints

- 파이썬은 **반드시** `D:\영상작업\축구\개발\.venv\Scripts\python.exe`(Anaconda 금지). 테스트 실행은 `PYTHONIOENCODING=utf-8`.
- 메인 작업트리에서 수집기가 돈다: `tools/live_collector.py`·`tools/daily_batch.py`는 건드리지 않는다. 브랜치 전환 금지. **다른 세션이 같은 작업트리를 쓰고 main에 직접 푸시한다** — `git add`는 항상 명시한 경로만(전체 add 금지), 작업트리의 무관한 수정(`playerStatus.ts` 등)은 건드리지 않고, 푸시 여부는 `git status -sb`/`git fetch`로 먼저 확인한다.
- DB 쓰기(`--rebuild`)와 `git push`는 각각 실행 직전에 사용자 확인을 받는다(Task 4·5). 로컬 커밋은 계획대로.
- 옛 iOS Safari 대상: 클라이언트 번들 파일(`comebackMoments.ts`, `recordsMoments.ts`)에 `.at()`, `.replaceAll()`, `??=` 같은 최신 문법을 쓰지 않는다. 서버 전용 모듈(`supabaseServer`, `cachePolicy`)을 import하지 않는다.
- 사용자에게는 한국어로 보고한다. 푸시 전 `next build` 복사본 점검(Task 5).

---

### Task 1: 파이썬 — 역전승 후보 `comeback_candidates`

**Files:**
- Modify: `tools/record_book.py`, `tools/test_record_book_moments.py`

**Interfaces:**
- Produces: `record_book.COMEBACK_MIN`(15), `record_book.comeback_candidates(g) -> [행]`(보드 `tg.comeback.max`, bucket `G`, `subject`=이긴 팀 tcode, `period=""`, `value`=최대 열세). `moment_candidates`가 게이트 1 통과 경기에서 이 행도 낸다.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- edit: tools/test_record_book_moments.py -->
<!-- old -->
~~~python
def test_moment_candidates_are_in_the_game_candidates_and_cover_all_boards():
~~~
<!-- new -->
~~~python
def comeback_rows(order):
    return boards(rb.moment_candidates(run_game(order)), "tg.comeback.max")


def test_comeback_is_the_winners_max_deficit():
    assert comeback_rows([("A", "201")] * 8 + [("H", "205")] * 6) == [("H", 16)]           # A가 16-0까지 앞섰고 H가 18-16으로 뒤집었다


def test_comeback_needs_a_win_and_the_minimum_deficit():
    assert comeback_rows([("A", "201")] * 7 + [("H", "205")] * 5) == []                     # 14점 열세는 후보가 아니다(15 미만)
    assert comeback_rows([("A", "201")] * 8 + [("H", "201")] * 2) == []                     # 끝까지 앞선 팀은 열세가 없고 졌다
    assert comeback_rows([("A", "201")] * 8 + [("H", "201")] * 8) == []                     # 동점은 승자가 없다
    assert comeback_rows([("H", "205")] * 3 + [("A", "205")] * 8 + [("H", "205")] * 8) == [("H", 15)]   # 먼저 앞섰다가 15점 뒤진 뒤 뒤집어도 센다(9-0 -> 9-24 -> 33-24)


def test_comeback_is_skipped_when_events_disagree_with_the_official_score():
    g = run_game([("A", "201")] * 8 + [("H", "205")] * 6)
    g["quarters"]["H"]["q"] = [0, 0, 20, 0]                                                 # 이벤트 득점 18과 공식 쿼터 점수 20이 다르다 - 게이트 1 탈락
    assert boards(rb.moment_candidates(g), "tg.comeback.max") == []


def test_moment_candidates_are_in_the_game_candidates_and_cover_all_boards():
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd tools && PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py`

Expected: 새 테스트 3개 중 `comeback_*` 기대 행이 있는 첫째·둘째 FAIL(행이 비어 있다).

- [ ] **Step 3: 구현**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
# 3단계 - 한 경기 안 연속 슛. 종목: fg(2점+3점 야투, 자유투 제외) / tp(3점) / ft(자유투). (성공 코드, 실패 코드, 공식 성공 열, 공식 시도 열)
~~~
<!-- new -->
~~~python
COMEBACK_MIN = 15       # 4단계 B - 이긴 팀이 이만큼 이상 뒤졌던 경기만 후보(보관 순위 ≤15가 21점이라 이보다 작은 값은 어차피 잘린다). lib/comebackMoments.ts COMEBACK_MIN과 같아야 한다.


def comeback_candidates(g):
    """역전승 - 이긴 팀이 경기 중 뒤졌던 최대 점수차(연장 포함), 경기당 이긴 팀 한 행. 이벤트 득점으로 쌓은 두 팀 점수의 이벤트 순서(n) 경로이며,
    호출부가 게이트 1(이벤트 득점 = 공식 쿼터·최종 점수)을 통과한 경기에만 부른다. 진 팀의 '리드를 날린 패배'는 같은 값이라 보드를 따로 만들지 않는다."""
    h, a = g["home"], g["away"]
    hs, as_ = (g["teams"].get(h) or {}).get("score"), (g["teams"].get(a) or {}).get("score")
    if not (isinstance(hs, int) and isinstance(as_, int)) or hs == as_:
        return []
    win, lose = (h, a) if hs > as_ else (a, h)
    sc, worst = {h: 0, a: 0}, 0
    for e in ordered_events(g):
        pts, q, tc, name = PTS_BY_CODE.get(e.get("a")), e.get("q"), e.get("t"), e.get("p")
        if pts and q and name and tc in sc:
            sc[tc] += pts
            worst = max(worst, sc[lose] - sc[win])
    if worst < COMEBACK_MIN or win not in g["names"]:
        return []
    return [_row(g, "tg.comeback.max", "G", win, "", worst, g["names"][win], win)]


# 3단계 - 한 경기 안 연속 슛. 종목: fg(2점+3점 야투, 자유투 제외) / tp(3점) / ft(자유투). (성공 코드, 실패 코드, 공식 성공 열, 공식 시도 열)
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
        rows += time_candidates(g) + burst_candidates(g) + run_candidates(g)
~~~
<!-- new -->
~~~python
        rows += time_candidates(g) + burst_candidates(g) + run_candidates(g) + comeback_candidates(g)
~~~

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~python
    """2·3단계 선수-경기 보드 전부 - 공식 보드와 한 경기 안 연속 슛은 늘, 이벤트 보드는 게이트 1을 통과한 경기만."""
~~~
<!-- new -->
~~~python
    """2·3·4B단계 경기 단위 보드 전부 - 공식 보드와 한 경기 안 연속 슛은 늘, 이벤트 보드(시간·창·런·역전승)는 게이트 1을 통과한 경기만."""
~~~

<!-- edit: tools/test_record_book_moments.py -->
<!-- old -->
~~~python
    runs = [r for r in rows if r["board"] == "tg.run.max"]
    assert max(r["value"] for r in runs) == 24 and {"S37G01N269", "S31G01N108"} & {r["gmkey"] for r in runs if r["value"] == 24}
~~~
<!-- new -->
~~~python
    runs = [r for r in rows if r["board"] == "tg.run.max"]
    assert max(r["value"] for r in runs) == 24 and {"S37G01N269", "S31G01N108"} & {r["gmkey"] for r in runs if r["value"] == 24}
    cb = top("tg.comeback.max")[0]
    assert (cb["value"], cb["gmkey"]) == (29, "S39G01N151"), cb                            # 서울 SK가 안양 KGC에 29점 뒤지다 역전(2022-01-09)
    assert all(r["value"] >= rb.COMEBACK_MIN for r in rows if r["board"] == "tg.comeback.max")
~~~

- [ ] **Step 4: 통과 확인(합성 + 실데이터 + 전체 드라이런)**

Run:

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book.py
PYTHONIOENCODING=utf-8 "$PY" test_record_streaks.py
PYTHONIOENCODING=utf-8 "$PY" test_record_book_hook.py
RECORD_BOOK_SLOW=1 PYTHONIOENCODING=utf-8 "$PY" test_record_book_moments.py
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild --dry-run
```

Expected: 합성 테스트 전부 `실패 없음.`, 슬로우 단언 통과(게이트 1이 최종 점수만 보던 간이 조사보다 엄격하므로 1위가 다르면 단언 값을 실제 값으로 고치기 전에 그 경기가 게이트에서 빠졌는지 먼저 확인한다), 드라이런은 보관 행 수가 `MAX_ROWS`(20,000) 이내.

- [ ] **Step 5: 커밋**

```bash
git add tools/record_book.py tools/test_record_book_moments.py
git commit -m "$(cat <<'EOF'
feat(records): biggest comeback win - the winner's largest deficit as a per-game board

The score path comes from the scoring events in order and is only used for games whose event points match
the official quarter and final scores. One row per game for the winner; deficits under 15 are not candidates.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 웹 — 역전승 엔진 `comebackMoments.ts`

**Files:**
- Create: `courtside-web/lib/comebackMoments.ts`, `courtside-web/lib/comebackMoments.test.ts`
- Modify: `courtside-web/lib/recordsMoments.ts`

**Interfaces:**
- Consumes: `records.ts`의 `clockOf`, `holdersLine`, `rankInfo`, `TOP_RANKS`, `verdictText`, `RecordContext`(`boards["tg.comeback.max|G"]`, `validated`), `RecordEvent.home_score/away_score`, `RecordTimelineOptions {names, final, home, away}`
- Produces: `buildComebackMoments(ctx, events, opts, finals?) -> RecordMoment[]`, 상수 `COMEBACK_BOARD`, `NEAR_FROM`(20), `COMEBACK_MIN`(15); `buildAllRecordMoments`가 이를 합친다.

- [ ] **Step 1: 실패하는 테스트 작성**

<!-- create: courtside-web/lib/comebackMoments.test.ts -->
~~~typescript
import { describe, expect, it } from "vitest";
import { buildComebackMoments } from "./comebackMoments";
import { buildAllRecordMoments } from "./recordsMoments";
import type { BoardSummary, RecordContext, RecordEvent } from "./records";

const names = { player: (p: string) => `선수${p}`, team: (t: string) => `팀${t}` };
const LIVE = { names, final: false, home: "H", away: "A" };
const FINAL = { ...LIVE, final: true };
const KEY = "tg.comeback.max|G";
const TOPS = [29, 28, 26, 25, 24, 24, 23, 23, 23, 23];     // 순위 1,2,3,4,5,5,7,7,7,7 - TOP10 문턱 23
function board(tops: number[]): BoardSummary {
  const holders: BoardSummary["holders"] = [];
  let rank = 0;
  let last: number | null = null;
  tops.forEach((v, i) => {
    if (v !== last) {
      rank = i + 1;
      last = v;
    }
    if (rank <= 3 && holders.length < 6) holders.push({ v, who: `보유${i}`, d: "2022-01-09" });
  });
  return { tops, holders };
}
const ctxOf = (validated?: string[], tops = TOPS): RecordContext => ({ asOf: "2026-10-09", boards: { [KEY]: board(tops) }, ...(validated ? { validated } : {}) });
const ev = (home: number, away: number, i: number): RecordEvent => ({ pcode: "p", tcode: "H", action_code: "201", quarter: "Q1", clock_min: 9, clock_sec: 59 - (i % 50), home_score: home, away_score: away });
const seq = (pairs: [number, number][]) => pairs.map(([h, a], i) => ev(h, a, i));

/** H가 24점 뒤진 뒤(원정 2점씩 12번) 3점씩 9번으로 27-24 역전 - idx 0..11 열세, idx 12..20 추격, idx 20이 리드 탈환 */
const awayRun = Array.from({ length: 12 }, (_, i): [number, number] => [0, 2 * (i + 1)]);
const homeRun = Array.from({ length: 9 }, (_, i): [number, number] => [3 * (i + 1), 24]);
const COMEBACK = seq([...awayRun, ...homeRun]);

describe("임박(near) - 큰 열세 중인 팀", () => {
  it("20점에서 열리고 열세가 늘 때마다 새로 열리며 리드를 잡으면 닫힌다", () => {
    const m = buildComebackMoments(ctxOf(), COMEBACK, LIVE).filter((x) => x.phase === "near");
    expect(m.map((x) => x.value)).toEqual([20, 22, 24]);
    expect(m.map((x) => x.until)).toEqual([10, 11, 20]);
    expect(m[0].text).toBe("팀H 최대 20점 열세 · 23점차가 되면 역전승 KBL 역대 공동 7위");
    expect(m[0].remaining).toBe(3);
    expect(m[2].text).toBe("팀H 최대 24점 열세 · 이기면 역전승 KBL 역대 공동 5위");
    expect(m[2]).toMatchObject({ scope: "t", subject: "H", tcode: "H", board: "tg.comeback.max", bucket: "G", provisional: true, remaining: 0 });
  });
  it("19점 열세까지는 아무것도 없다", () => {
    const small = seq([...Array.from({ length: 9 }, (_, i): [number, number] => [0, 2 * (i + 1)]), [0, 19]]);
    expect(buildComebackMoments(ctxOf(), small, LIVE)).toEqual([]);
  });
  it("보드 요약이 없으면 만들지 않는다", () => {
    expect(buildComebackMoments(null, COMEBACK, LIVE)).toEqual([]);
    expect(buildComebackMoments({ asOf: "x", boards: {} }, COMEBACK, LIVE)).toEqual([]);
  });
});

describe("확정(done) - 리드 탈환", () => {
  it("라이브: TOP10 열세를 뒤집고 리드를 잡는 이벤트에서 잠정으로", () => {
    const m = buildComebackMoments(ctxOf(), COMEBACK, LIVE).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ idx: 20, value: 24, rank: 5, tie: true, provisional: true, scope: "t", subject: "H" });
    expect(m[0].text).toBe("팀H 24점차 열세를 뒤집고 리드 · 이대로 이기면 KBL 역대 공동 5위");
  });
  it("라이브: 순위가 같으면 다시 알리지 않고, 열세가 더 깊어진 뒤 뒤집으면 좋아진 순위로 다시 알린다", () => {
    const again = seq([...awayRun, ...homeRun, [27, 28], [30, 28]]);                      // 같은 24점 열세로 한 번 더 리드 탈환
    expect(buildComebackMoments(ctxOf(), again, LIVE).filter((x) => x.phase === "done")).toHaveLength(1);
    const deeper = seq([...awayRun, ...homeRun, [27, 28], [27, 54], [57, 54]]);            // 54-27 = 27점 열세 뒤 역전
    const m = buildComebackMoments(ctxOf(), deeper, LIVE).filter((x) => x.phase === "done");
    expect(m.map((x) => x.value)).toEqual([24, 27]);
    expect(m[1].text).toBe("팀H 27점차 열세를 뒤집고 리드 · 이대로 이기면 KBL 역대 3위");
  });
  it("라이브: 열세가 TOP10 밖(22점)이면 확정은 없다", () => {
    const small = seq([...Array.from({ length: 11 }, (_, i): [number, number] => [0, 2 * (i + 1)]), [3, 22], [24, 22]]);
    expect(buildComebackMoments(ctxOf(), small, LIVE).filter((x) => x.phase === "done")).toEqual([]);
  });
  it("종료 경기: 이긴 팀의 마지막 리드 탈환 이벤트에서 한 번, 이 경기 행(validated)이 있을 때만, 잠정 아님", () => {
    const m = buildComebackMoments(ctxOf([`${KEY}|H|`]), COMEBACK, FINAL).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ idx: 20, value: 24, provisional: false });
    expect(m[0].text).toBe("팀H 24점차 열세를 뒤집은 역전승 KBL 역대 공동 5위");
    expect(m[0].detail).toBe("팀A 24점 리드를 날림 · 역대 1위 29점: 보유0");
    expect(buildComebackMoments(ctxOf([]), COMEBACK, FINAL).filter((x) => x.phase === "done")).toEqual([]);
  });
  it("종료 경기: 뒤지던 팀이 끝내 졌으면 확정은 없다(임박만 남는다)", () => {
    const lost = seq([...awayRun, [3, 24], [6, 24]]);
    const m = buildComebackMoments(ctxOf([`${KEY}|H|`, `${KEY}|A|`]), lost, FINAL);
    expect(m.filter((x) => x.phase === "done")).toEqual([]);
    expect(m.filter((x) => x.phase === "near").length).toBeGreaterThan(0);
  });
  it("종료 경기: 열세가 TOP10 밖이면 행이 있어도 알리지 않는다", () => {
    const small = seq([...Array.from({ length: 11 }, (_, i): [number, number] => [0, 2 * (i + 1)]), [3, 22], [24, 22]]);
    expect(buildComebackMoments(ctxOf([`${KEY}|H|`]), small, FINAL).filter((x) => x.phase === "done")).toEqual([]);
  });
});

describe("점수 처리와 대조(finals)", () => {
  it("점수가 없는 이벤트와 홈/원정을 모르는 호출은 건너뛴다", () => {
    const withGap = COMEBACK.map((e, i) => (i === 5 ? { ...e, home_score: null } : e));
    expect(buildComebackMoments(ctxOf(), withGap, LIVE).filter((x) => x.phase === "done")).toHaveLength(1);
    expect(buildComebackMoments(ctxOf(), COMEBACK, { names, final: false })).toEqual([]);
  });
  it("finals: 이긴 팀의 최대 열세(15 이상)만 파이썬 행과 맞출 키로", () => {
    const finals = new Map<string, number>();
    buildComebackMoments(null, COMEBACK, FINAL, finals);
    expect(Object.fromEntries(finals)).toEqual({ "tg.comeback.max|G|H|": 24 });
    const small = new Map<string, number>();
    buildComebackMoments(null, seq([...Array.from({ length: 7 }, (_, i): [number, number] => [0, 2 * (i + 1)]), [18, 14]]), FINAL, small);   // 14점 열세 뒤 역전
    expect(small.size).toBe(0);
  });
  it("buildAllRecordMoments의 한 갈래로 합쳐진다", () => {
    const all = buildAllRecordMoments(ctxOf(), COMEBACK, LIVE);
    expect(all.some((x) => x.board === "tg.comeback.max" && x.phase === "done")).toBe(true);
  });
});
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/comebackMoments.test.ts`

Expected: FAIL — `Failed to resolve import "./comebackMoments"`.

- [ ] **Step 3: 구현**

<!-- create: courtside-web/lib/comebackMoments.ts -->
~~~typescript
import { clockOf, holdersLine, rankInfo, TOP_RANKS, verdictText, type RankInfo, type RecordContext, type RecordEvent, type RecordMoment, type RecordTimelineOptions, type ValueFmt } from "./records";

// 역대 기록 4단계 B 라이브 엔진 - 최다 점수차 역전승. 설계: docs/superpowers/specs/2026-10-11-record-book-phase4b-design.md §4
//
// 이벤트의 두 팀 점수(home_score/away_score)로 팀별 "지금까지 최대 열세"를 따라가며 보드 요약(tg.comeback.max|G)과 비교한다.
//  - 임박(near, 패널): 열세가 20점 이상인 채 아직 리드를 못 잡은 팀 - 열세가 늘 때마다 새로 열고, 리드를 잡으면 닫는다.
//  - 확정(done): TOP10에 드는 열세를 뒤집고 리드를 잡는 이벤트. 라이브는 잠정(이대로 이기면), 종료 경기는 이긴 팀의 마지막 리드 탈환 이벤트 한 번(테이블에 이 경기 행이 있을 때만).
// 순수 함수 - 서버 전용 모듈을 import하지 않는다.

export const COMEBACK_BOARD = "tg.comeback.max";
const KEY = `${COMEBACK_BOARD}|G`;
/** 임박 줄을 올리는 최대 열세(점) */
export const NEAR_FROM = 20;
/** 파이썬 후보 행의 최소 점수 - tools/record_book.py COMEBACK_MIN과 같아야 한다 */
export const COMEBACK_MIN = 15;
const pts: ValueFmt = (v) => `${v}점`;
const levelOf = (i: RankInfo) => (i.breaks ? 0 : i.rank);

export function buildComebackMoments(
  ctx: RecordContext | null,
  events: RecordEvent[],
  opts: RecordTimelineOptions,
  finals?: Map<string, number>
): RecordMoment[] {
  const out: RecordMoment[] = [];
  const home = opts.home;
  const away = opts.away;
  if (!home || !away) return out;
  const summary = ctx?.boards[KEY];
  const provisional = !opts.final;
  const worst: Record<string, number> = { [home]: 0, [away]: 0 };
  const lead: Record<string, number> = { [home]: 0, [away]: 0 };
  const open = new Map<string, RecordMoment>();
  const takeover = new Map<string, number>();
  const lastEmit = new Map<string, { level: number; value: number }>();
  let last: RecordEvent | null = null;

  const mk = (phase: "near" | "done", tc: string, idx: number, value: number, info: RankInfo, text: string, detail: string, remaining: number): RecordMoment => ({
    id: `cb|${phase}|${tc}|${value}`, idx, until: Infinity, clock: clockOf(events[idx]), phase,
    board: COMEBACK_BOARD, bucket: "G", subject: tc, period: "", scope: "t", name: opts.names.team(tc), tcode: tc, value,
    rank: info.rank, tie: info.tie, breaks: info.breaks, remaining, text, detail, provisional, sig: levelOf(info),
  });
  const closeNear = (tc: string, at: number) => {
    const o = open.get(tc);
    if (o) {
      o.until = at;
      open.delete(tc);
    }
  };
  const ensureNear = (tc: string, idx: number) => {
    if (!summary) return;
    const m = worst[tc];
    const cur = open.get(tc);
    if (cur && cur.value === m) return;
    closeNear(tc, idx);
    const tops = summary.tops;
    const info = rankInfo(tops, m, "max");
    if (!info) return;
    const name = opts.names.team(tc);
    let near: RecordMoment;
    if (info.rank <= TOP_RANKS) {
      near = mk("near", tc, idx, m, info, `${name} 최대 ${m}점 열세 · 이기면 역전승 ${verdictText(info, pts, "KBL")}`, holdersLine(summary, info, pts), 0);
    } else {
      const floor = tops[tops.length - 1];
      const target = rankInfo(tops, floor, "max");
      if (!target) return;
      near = mk("near", tc, idx, m, target, `${name} 최대 ${m}점 열세 · ${floor}점차가 되면 역전승 ${verdictText(target, pts, "KBL")}`, holdersLine(summary, target, pts), floor - m);
    }
    open.set(tc, near);
    out.push(near);
  };
  const liveDone = (tc: string, idx: number) => {
    if (!summary) return;
    const m = worst[tc];
    const info = rankInfo(summary.tops, m, "max");
    if (!info || info.rank > TOP_RANKS) return;
    const level = levelOf(info);
    const prev = lastEmit.get(tc);
    if (prev && !(level < prev.level || (level === 0 && m > prev.value))) return;     // 순위가 좋아질 때만(신기록은 값이 늘 때만) 다시 알린다
    lastEmit.set(tc, { level, value: m });
    out.push(mk("done", tc, idx, m, info, `${opts.names.team(tc)} ${m}점차 열세를 뒤집고 리드 · 이대로 이기면 ${verdictText(info, pts, "KBL")}`, holdersLine(summary, info, pts), 0));
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (e.home_score == null || e.away_score == null) continue;
    last = e;
    const margin = e.home_score - e.away_score;
    for (const tc of [home, away]) {
      const prev = lead[tc];
      const cur = tc === home ? margin : -margin;
      lead[tc] = cur;
      if (cur < 0 && -cur > worst[tc]) worst[tc] = -cur;
      if (cur > 0 && prev <= 0) {
        closeNear(tc, idx);
        takeover.set(tc, idx);
        if (!opts.final) liveDone(tc, idx);
      } else if (cur < 0 && worst[tc] >= NEAR_FROM) {
        ensureNear(tc, idx);
      }
    }
  }
  for (const tc of [home, away]) closeNear(tc, events.length);

  const winner = last ? (lead[home] > 0 ? home : lead[away] > 0 ? away : null) : null;
  if (winner) {
    const m = worst[winner];
    if (finals && m >= COMEBACK_MIN) finals.set(`${KEY}|${winner}|`, m);
    const at = takeover.get(winner);
    if (opts.final && summary && at != null && ctx?.validated?.includes(`${KEY}|${winner}|`)) {
      const info = rankInfo(summary.tops, m, "max");
      if (info && info.rank <= TOP_RANKS) {
        const loser = winner === home ? away : home;
        const h = holdersLine(summary, info, pts);
        out.push(mk("done", winner, at, m, info, `${opts.names.team(winner)} ${m}점차 열세를 뒤집은 역전승 ${verdictText(info, pts, "KBL")}`, `${opts.names.team(loser)} ${m}점 리드를 날림${h ? ` · ${h}` : ""}`, 0));
      }
    }
  }
  return out;
}
~~~

<!-- edit: courtside-web/lib/recordsMoments.ts -->
<!-- old -->
~~~typescript
import { buildGameStreakMoments } from "./gameStreakMoments";
~~~
<!-- new -->
~~~typescript
import { buildComebackMoments } from "./comebackMoments";
import { buildGameStreakMoments } from "./gameStreakMoments";
~~~

<!-- edit: courtside-web/lib/recordsMoments.ts -->
<!-- old -->
~~~typescript
  const game = buildGameStreakMoments(streaks ?? null, events, opts);
  return [...base, ...kept, ...streak, ...game].sort((a, b) => a.idx - b.idx);
~~~
<!-- new -->
~~~typescript
  const game = buildGameStreakMoments(streaks ?? null, events, opts);
  const comeback = buildComebackMoments(ctx, events, opts);
  return [...base, ...kept, ...streak, ...game, ...comeback].sort((a, b) => a.idx - b.idx);
~~~

- [ ] **Step 4: 통과 확인(기대값은 손으로 계산해 맞춘다)**

Run: `cd courtside-web && npx vitest run lib/comebackMoments.test.ts lib/recordsMoments.test.ts lib/records.test.ts`

Expected: 통과. 실패하는 단언이 있으면 **구현이 아니라 기대값이 틀렸는지** 손으로 먼저 계산한다 — `TOPS = [29,28,26,25,24,24,23,23,23,23]`에서 순위는 \"나보다 확실히 큰 값의 개수 + 1\"이다(24 → 5위 공동, 27 → 3위, 23 → 7위 공동). 임박 문구의 문턱 `23`은 `tops`의 마지막 값(TOP10 진입선)이다.

- [ ] **Step 5: 린트·전체**

Run: `cd courtside-web && npx tsc --noEmit && npx eslint lib/comebackMoments.ts lib/comebackMoments.test.ts lib/recordsMoments.ts --quiet && npx vitest run`

Expected: 출력 없음 / 전체 통과(다른 세션의 작업 중 파일 때문에 생기는 tsc 오류는 내 파일이 아니면 무시하고 사용자에게 알린다).

- [ ] **Step 6: 커밋**

```bash
git add courtside-web/lib/comebackMoments.ts courtside-web/lib/comebackMoments.test.ts courtside-web/lib/recordsMoments.ts
git commit -m "$(cat <<'EOF'
feat(web): comeback-win engine - near line from 20 points down, lead-retaking toast, post-game line

Per-team max deficit is followed on the event scores; a big deficit opens a near line, retaking the lead
after a top-10 deficit fires a provisional moment live, and a finished game announces the winner once at
its last lead change when the table holds the game's row.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 파이썬↔웹 대조와 문서

**Files:**
- Modify: `courtside-web/lib/records.moments.parity.test.ts`, `tools/dump_record_fixtures.py`, `README.md`
- Regenerate: `courtside-web/lib/__fixtures__/momentParity/*.json`

- [ ] **Step 1: 대조 테스트 확장**

<!-- edit: courtside-web/lib/records.moments.parity.test.ts -->
<!-- old -->
~~~typescript
import { buildMomentTimeline } from "./recordsMoments";
~~~
<!-- new -->
~~~typescript
import { buildComebackMoments } from "./comebackMoments";
import { buildMomentTimeline } from "./recordsMoments";
~~~

<!-- edit: courtside-web/lib/records.moments.parity.test.ts -->
<!-- old -->
~~~typescript
      buildMomentTimeline({ asOf: "x", boards: {} }, events, { names: { player: (p) => p, team: (t) => t }, final: true, home: fx.home, away: fx.away }, finals);
~~~
<!-- new -->
~~~typescript
      const opts = { names: { player: (p: string) => p, team: (t: string) => t }, final: true, home: fx.home, away: fx.away };
      buildMomentTimeline({ asOf: "x", boards: {} }, events, opts, finals);
      buildComebackMoments(null, events, opts, finals);
~~~

<!-- edit: courtside-web/lib/records.moments.parity.test.ts -->
<!-- old -->
~~~typescript
    for (const b of ["tg.margin.max", "pg.benchpts.max", "pg.club_td.max", "pg.dd_time.min", "pg.td_time.min", "pg.burst35.max", "tg.run.max"]) expect(seen.has(b)).toBe(true);
~~~
<!-- new -->
~~~typescript
    for (const b of ["tg.margin.max", "pg.benchpts.max", "pg.club_td.max", "pg.dd_time.min", "pg.td_time.min", "pg.burst35.max", "tg.run.max", "tg.comeback.max"]) expect(seen.has(b)).toBe(true);
~~~

- [ ] **Step 1b: 대조 도구 - 한 경기 안 연속 슛 보드는 2단계 픽스처에서 뺀다**

<!-- edit: tools/dump_record_fixtures.py -->
<!-- old -->
~~~python
        rows = rb.moment_candidates(g)
        if not rows:
            print(f"  건너뜀(2단계 행 없음): {gmkey}")
~~~
<!-- new -->
~~~python
        single = set(rb.SINGLE_BOARD.values())                       # 한 경기 안 연속 슛 보드는 3단계 엔진이 만든다(--streaks 픽스처의 'single'이 대조한다)
        rows = [r for r in rb.moment_candidates(g) if r["board"] not in single]
        if not rows:
            print(f"  건너뜀(2단계 행 없음): {gmkey}")
~~~

- [ ] **Step 2: 픽스처 재생성(역전승 경기 추가)**

Run:

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" dump_record_fixtures.py --moments ../courtside-web/lib/__fixtures__/momentParity --gmkeys S29G01N233,S31G01N108,S33G01N50,S35G01N162,S37G01N269,S41G03N11,S43G01N218,S43G01N236,S45G01N22,S45G01N220,S45G01N231,S47G01N269,S39G01N151,S31G01N104,S29G01N42,S27G01N119,S47G01N224
```

Expected: `moment fixtures: N개`(동명이인·게이트 1 탈락 경기는 `건너뜀`으로 빠진다). 새로 추가한 다섯 경기 중 **적어도 둘이 써져야** 한다(기존 12개 + 새 파일). 모두 건너뛰면 `top("tg.comeback.max")` 상위 경기 gmkey를 찾아 바꿔 넣는다.

- [ ] **Step 3: 대조 통과 확인**

Run: `cd courtside-web && npx vitest run lib/records.moments.parity.test.ts`

Expected: 통과 — 새 보드가 덮이는지(`tg.comeback.max`) 단언 포함. 실패하면 `got`이 어긋난 (보드|구간|주체|기간) 키를 확인한다: 웹 점수 경로(`home_score`/`away_score`, `to_moment_events`가 득점 이벤트로 쌓은 값)와 파이썬 경로가 다른 것이다.

- [ ] **Step 4: README**

<!-- edit: README.md -->
<!-- old -->
~~~text
**감시**: Supabase pg_cron(`watch_live_collector`, 1분마다)이 수집기 심박(`live_collector_status`)을
~~~
<!-- new -->
~~~text
- **4단계 B(2026-10-11, 설계 `docs/superpowers/specs/2026-10-11-record-book-phase4b-design.md`)** - 최다 점수차 역전승: 이긴 팀이 경기 중 뒤졌던 최대 점수차(연장·플레이오프 포함)를 경기 단위 보드
  `tg.comeback.max`(이긴 팀 tcode, 15점 미만 제외, 게이트 1 통과 경기만)로 쌓는다 — 상태 테이블·DDL 없음(`--gmkeys`/`--rebuild`가 처리). 라이브는 20점 이상 열세 중 임박 줄, TOP10 열세를 뒤집고 리드를 잡는
  순간 잠정 토스트, 종료 후 리포트에 "○점차 열세를 뒤집은 역전승 … 진 팀은 ○점 리드를 날림". 롤백: 웹 `git revert`, DB `DELETE FROM record_entries WHERE board = 'tg.comeback.max'`.

**감시**: Supabase pg_cron(`watch_live_collector`, 1분마다)이 수집기 심박(`live_collector_status`)을
~~~

- [ ] **Step 5: 전체 확인 후 커밋**

Run:

```bash
cd courtside-web && npx tsc --noEmit && npx eslint lib components app --quiet && npx vitest run
cd ../tools
for t in test_record_book test_record_book_moments test_record_streaks test_record_book_hook; do PYTHONIOENCODING=utf-8 "$PY" $t.py 2>&1 | grep -E "FAIL|실패"; done
```

Expected: tsc·eslint 출력 없음(다른 세션 작업 파일의 오류는 사용자에게 알린다), vitest 전체 통과, 파이썬 4종 `실패 없음.`

```bash
git add courtside-web/lib/records.moments.parity.test.ts tools/dump_record_fixtures.py courtside-web/lib/__fixtures__/momentParity README.md docs/superpowers/plans/2026-10-11-record-book-phase4b.md
git commit -m "$(cat <<'EOF'
test(records): pin the comeback board against real games and document the phase

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: DB 재적재 · 검증 (**사용자 확인 필요 - 운영 DB 쓰기**)

**Files:** (코드 변경 없음 - 운영 작업)

**먼저 사용자에게 확인한다**: "공유 Supabase의 `record_entries`를 역전승 보드(`tg.comeback.max`)까지 포함해 전체 다시 채웁니다(`record_book.py --rebuild`, 한 트랜잭션, 노트북 부하에 따라 2~8분, DDL 없음). 진행할까요?"

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

Expected: `교체 완료`, `--verify`가 `없는 행 0 / 남는 행 0 / 값이 다른 행 0`과 `연속 로그 검증: 0/0/0`. 재적재 도중 정산된 경기가 있으면 `--verify`가 1~2건 어긋날 수 있다 — `record_book.py --gmkeys <그 경기들>`로 반영하고 `--verify`를 다시 돌린다.

- [ ] **Step 3: 알려진 값 확인**

```bash
PYTHONIOENCODING=utf-8 "$PY" -c "import sys; sys.path.insert(0, '.'); from sync_upcoming_games import get_conn; c = get_conn(); cur = c.cursor(); cur.execute(\"select subject_name, value, gmkey from record_entries where board = 'tg.comeback.max' order by value desc, gmkey limit 6\"); [print(r) for r in cur.fetchall()]; cur.execute(\"select count(*) from record_entries where board = 'tg.comeback.max'\"); print(cur.fetchone())"
```

Expected: 맨 위 29점차(서울 SK, S39G01N151), 28(원주 DB), 26(부산 KT)…

---

### Task 5: 푸시 전 빌드 점검과 배포 (**푸시 전 사용자 확인 필요**)

**Files:** (코드 변경 없음)

**먼저 `git fetch origin && git status -sb`로 로컬이 origin보다 얼마나 앞선지 확인한다**(다른 세션이 이미 내 커밋을 올렸을 수 있다). 올릴 게 남아 있으면 사용자에게 확인한다: "로컬 커밋 N개를 `main`에 푸시합니다(Vercel 자동 배포)."

- [ ] **Step 1: 푸시 전 빌드 점검(복사본)**

`courtside-web`을 스크래치패드로 복사(`node_modules` 포함 — junction은 Turbopack이 거부)하고 `npx next build`가 `exit=0`인지 확인한다(다른 세션의 커밋이 섞여 있어도 빌드가 깨지지 않는지).

- [ ] **Step 2: 푸시와 배포 확인**

```bash
git fetch origin && git status -sb | head -3
git push origin main
gh api repos/onnebang/kbl_realdata/commits/$(git rev-parse HEAD)/status --jq '[.statuses[] | {context, state}]'
```

`Vercel – courtside-web`이 `success`가 될 때까지 확인한다(`Vercel – kbl-realdata` 실패는 기존 증상).

- [ ] **Step 3: 프로덕션 확인**

```bash
for g in S49G01N10 S49G01N15 S49G01N18; do curl -s -o "$SP/$g.html" -w "$g %{http_code} %{time_total}s\n" --compressed "https://courtside-web-ten.vercel.app/games/$g"; grep -c "Application error" "$SP/$g.html"; done
```

Expected: 200, `Application error` 0. 역전승 줄은 20점 이상 열세 경기에서만 나오므로 눈으로 확인할 수 있는 실제 사례(2022-01-09 서울 SK·안양 KGC전 `S39G01N151` 페이지의 리포트)를 열어 "29점차 열세를 뒤집은 역전승"이 보이는지 확인한다(60일이 지난 경기는 기록 요약이 없다 — 그 경우 이 확인은 건너뛰고 대조 테스트로 갈음한다).

- [ ] **Step 4: 실패 시 롤백 순서**

웹 문제: 해당 커밋 `git revert`(새 보드는 옛 웹이 읽지 않으므로 DB는 그대로). 파이썬 문제: `record_book.py`를 이전 커밋으로 되돌려 `--rebuild`. DB 정리: `DELETE FROM record_entries WHERE board = 'tg.comeback.max'`.
