import { describe, expect, it } from "vitest";
import {
  buildRecordTimeline,
  doneUpTo,
  nearAt,
  nextTarget,
  rankInfo,
  RecordAccumulator,
  recordLine,
  recordToast,
  type BoardSummary,
  type RecordContext,
  type RecordEvent,
} from "./records";

const names = { player: (p: string) => (p === "h" ? "허훈" : `선수${p}`), team: (t: string) => `팀${t}` };
const WHO = ["문태종", "박지현", "허훈", "이정현", "마레이", "박지훈", "김승현", "이정석"];

/** tops(좋은 순)에서 순위 <= 3 항목만 보유자로 붙인 요약. */
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
  asOf: "2026-10-07",
  boards: Object.fromEntries(Object.entries(boards).map(([k, t]) => [k, board(t)])),
  ...(validated ? { validated } : {}),
});

let seq = 0;
const ev = (pcode: string | null, tcode: string | null, code: string, quarter = "Q1", min = 8, sec = 0): RecordEvent => ({ pcode, tcode, action_code: code, quarter, clock_min: min, clock_sec: sec + (seq++ % 50) });
const repeat = (n: number, f: (i: number) => RecordEvent) => Array.from({ length: n }, (_, i) => f(i));

const EIGHTS = [8, 8, 8, 8, 8, 8, 7, 7, 7, 7]; // 이 경기 이전의 한 쿼터 최다 어시스트: 8개 6건 공동 1위, 7개 공동 7위

describe("rankInfo / nextTarget", () => {
  it("공동 순위, 신기록, 타이", () => {
    expect(rankInfo(EIGHTS, 9, "max")).toEqual({ rank: 1, tie: false, breaks: true, best: 8, n1: 6 });
    expect(rankInfo(EIGHTS, 8, "max")).toMatchObject({ rank: 1, tie: true, breaks: false });
    expect(rankInfo(EIGHTS, 7, "max")).toMatchObject({ rank: 7, tie: true });
    expect(rankInfo(EIGHTS, 6, "max")).toMatchObject({ rank: 11, tie: false }); // 10위 밖
    expect(rankInfo([], 5, "max")).toBeNull();
    expect(rankInfo([2, 2, 3, 3], 2, "min")).toMatchObject({ rank: 1, tie: true, breaks: false });
    expect(rankInfo([3, 3, 4], 2, "min")).toMatchObject({ rank: 1, breaks: true });
  });

  it("다음 기록 선 = 상위 3위 값과 신기록(1위 + 1) 중 현재 값 바로 위", () => {
    expect(nextTarget(EIGHTS, 5)).toBe(8);
    expect(nextTarget(EIGHTS, 8)).toBe(9);
    expect(nextTarget(EIGHTS, 9)).toBeNull();
    expect(nextTarget([20, 18, 18, 15, 14], 16)).toBe(18); // 15는 4위라 선이 아니다
  });
});

describe("RecordAccumulator", () => {
  it("선수·팀의 쿼터/경기 누적과 테이블 키, 팀 득점은 최소 보드 키도", () => {
    const acc = new RecordAccumulator();
    for (const e of [ev("p", "T", "201"), ev("p", "T", "205"), ev("p", "T", "202", "Q2"), ev("q", "T", "211"), ev("p", "T", "209", "X1")]) acc.apply(e);
    const v = acc.finalValues();
    expect(v.get("pq.pts.max|Q1|p|Q1")).toBe(5);
    expect(v.get("pg.pts.max|G|p|")).toBe(5);
    expect(v.get("pq.tpm.max|Q1|p|Q1")).toBe(1);
    expect(v.get("tq.pts.max|Q1|T|Q1")).toBe(5);
    expect(v.get("tq.pts.min|Q1|T|Q1")).toBe(5);
    expect(v.get("tq.ast.max|Q1|T|Q1")).toBe(1);
    expect(v.get("tg.fgm.max|G|T|")).toBe(2);
    expect(v.get("tg.fgmiss.max|G|T|")).toBe(1);
    expect(v.get("pq.reb.max|OT|p|X1")).toBe(1);                 // 연장은 OT 구간
    expect(v.has("tq.pts.min|OT|T|X1")).toBe(false);             // 연장 최소 보드는 없다
  });

  it("선수 귀속이 아닌 이벤트·경기 시작 전(PRE)은 세지 않는다", () => {
    const acc = new RecordAccumulator();
    expect(acc.apply(ev(null, "T", "201"))).toEqual([]);
    expect(acc.apply(ev("p", null, "201"))).toEqual([]);
    expect(acc.apply(ev("p", "T", "201", "PRE"))).toEqual([]);
    expect(acc.apply({ pcode: "p", tcode: "T", action_code: null, quarter: "Q1" })).toEqual([]);
    expect(acc.finalValues().size).toBe(0);
  });
});

describe("buildRecordTimeline - 허훈 1쿼터 9어시스트(경기 이전 기록 8개)", () => {
  const boards = { "pq.ast.max|Q1": EIGHTS, "pq.ast.max|ALL": EIGHTS };
  const events = repeat(9, (i) => ev("h", "K", "211", "Q1", 9 - i, 0));

  it("7개는 공동 7위, 8개는 타이 기록(공동 1위), 9개는 신기록 - 순위가 좋아질 때만 알린다", () => {
    const m = buildRecordTimeline(ctxOf(boards), events, { names, final: false });
    const done = m.filter((x) => x.phase === "done");
    expect(done.map((x) => [x.idx, x.rank, x.tie, x.breaks])).toEqual([
      [6, 7, true, false],
      [7, 1, true, false],
      [8, 1, false, true],
    ]);
    expect(done[2]).toMatchObject({ name: "허훈", bucket: "Q1", period: "Q1", board: "pq.ast.max", value: 9, provisional: true, sig: 0 });
    expect(done[2].text).toBe("1쿼터 어시스트 9개 KBL 신기록(종전 8개)");
    // 설명에는 값을 되풀이하지 않는다("종전 8개"는 본문에 있다) - 보유자만. 1쿼터 판정이 본문(전체 구간)과 같으면 덧붙이지 않는다.
    expect(done[2].detail).toBe("문태종·박지현·허훈 외 3건 보유");
    expect(done[1].text).toBe("1쿼터 어시스트 8개 KBL 타이 기록(공동 1위)");
    expect(done[1].detail).toBe("문태종·박지현·허훈 외 3건 보유");
    expect(done[0].text).toBe("1쿼터 어시스트 7개 KBL 역대 공동 7위");
    expect(done[0].detail).toBe("역대 1위 8개: 문태종·박지현·허훈 외 3건");
    expect(recordLine(done[2])).toBe("1쿼터 어시스트 9개 KBL 신기록(종전 8개 · 문태종·박지현·허훈 외 3건 보유)");
    expect(recordLine(done[1])).toBe("1쿼터 어시스트 8개 KBL 타이 기록(공동 1위 · 문태종·박지현·허훈 외 3건 보유)");
    expect(recordLine(done[0])).toBe("1쿼터 어시스트 7개 KBL 역대 공동 7위(역대 1위 8개: 문태종·박지현·허훈 외 3건)");
    expect(done[0].clock).toMatch(/^Q1 3:\d{2}$/);                  // 7번째 이벤트 = 남은 시간 3분대
  });

  it("임박은 기록 선까지 2개 이내일 때 열리고 값이 바뀔 때마다 새로 열리며, 달성 때 닫힌다", () => {
    const m = buildRecordTimeline(ctxOf(boards), events, { names, final: false });
    const near = m.filter((x) => x.phase === "near");
    expect(near.map((x) => [x.idx, x.value, x.remaining, x.until])).toEqual([
      [5, 6, 2, 6],
      [6, 7, 1, 7],
      [7, 8, 1, 8],
    ]);
    expect(near[0].text).toBe("1쿼터 어시스트 6개 · 2개 더하면 KBL 타이 기록(공동 1위)");
    expect(near[2].text).toBe("1쿼터 어시스트 8개 · 1개 더하면 KBL 신기록(종전 8개)");
    expect(nearAt(m, 6).map((x) => x.value)).toEqual([7]);    // 스크럽 위치 6에서 유효한 임박은 하나뿐
    expect(nearAt(m, 8)).toEqual([]);                          // 9개를 채운 뒤엔 임박이 없다
    expect(doneUpTo(m, 7).map((x) => x.idx)).toEqual([7, 6]);  // 최근 것이 위
  });

  it("종료 경기는 테이블(validated)에 있는 항목만 남기고 잠정 표시가 없다", () => {
    const ok = buildRecordTimeline(ctxOf(boards, ["pq.ast.max|Q1|h|Q1"]), events, { names, final: true });
    expect(ok.filter((x) => x.phase === "done")).toHaveLength(3);
    expect(ok.every((x) => x.provisional === false)).toBe(true);
    expect(buildRecordTimeline(ctxOf(boards, []), events, { names, final: true })).toEqual([]);
    expect(buildRecordTimeline(ctxOf(boards, ["pq.ast.max|Q2|h|Q2"]), events, { names, final: true })).toEqual([]);
  });

  it("보드가 없으면(요약에 없는 종목) 아무것도 안 만든다", () => {
    expect(buildRecordTimeline(ctxOf({}), events, { names, final: false })).toEqual([]);
  });
});

describe("buildRecordTimeline - 순위 변화가 없으면 다시 알리지 않는다", () => {
  it("2위 구간에서 값이 올라도 순위가 같으면 한 번만, 1위를 넘으면 신기록", () => {
    const tops = [30, 5, 5, 5, 4, 4, 3, 3, 2, 2];
    const events = repeat(16, () => ev("p", "T", "201", "Q3")); // 쿼터 득점 2, 4, ... 32
    const m = buildRecordTimeline(ctxOf({ "pq.pts.max|Q3": tops }), events, { names, final: false }).filter((x) => x.phase === "done");
    // 2 = 공동 9위, 4 = 공동 5위, 6~28 = 2위(1위 30 하나뿐이라 값이 올라도 순위 그대로 -> 다시 안 알림), 30 = 타이, 32 = 신기록
    expect(m.map((x) => [x.value, x.rank, x.breaks])).toEqual([
      [2, 9, false],
      [4, 5, false],
      [6, 2, false],
      [30, 1, false],
      [32, 1, true],
    ]);
  });

  it("신기록을 깬 뒤 기록을 계속 늘리면 값이 오를 때마다 다시 알린다(11개 -> 12개 -> 13개)", () => {
    const events = repeat(13, () => ev("p", "T", "205", "Q2"));          // 3점슛 13개(득점 39)
    const m = buildRecordTimeline(ctxOf({ "pg.tpm.max|G": [10, 10, 9, 9, 9, 8, 8, 8, 8, 8] }), events, { names, final: false }).filter((x) => x.phase === "done" && x.board === "pg.tpm.max");
    expect(m.map((x) => [x.value, x.rank, x.breaks])).toEqual([
      [8, 6, false], // 8개 = 공동 6위
      [9, 3, false],
      [10, 1, false],
      [11, 1, true],
      [12, 1, true],
      [13, 1, true],
    ]);
    expect(new Set(m.map((x) => x.id)).size).toBe(m.length);              // 알림 id는 값마다 달라 토스트가 서로 덮이지 않는다
    expect(m[m.length - 1].text).toBe("한 경기 3점슛 13개 KBL 신기록(종전 10개)");
  });

  it("첫 값부터 TOP10 밖이면 아무것도 안 만든다", () => {
    const events = repeat(1, () => ev("p", "T", "201", "Q3"));
    expect(buildRecordTimeline(ctxOf({ "pq.pts.max|Q3": [30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20] }), events, { names, final: false })).toEqual([]);
  });
});

describe("buildRecordTimeline - 팀·경기·연장·최소 보드", () => {
  it("팀 쿼터 득점 최다: 한 이벤트로 40점 타이(공동 2위) -> 42점 신기록", () => {
    const tops = [41, 40, 40, 40, 39, 39, 39, 38, 38, 38, 38];
    const events = repeat(21, () => ev("p", "T", "201", "Q1"));
    const m = buildRecordTimeline(ctxOf({ "tq.pts.max|Q1": tops, "tq.pts.max|ALL": tops }), events, { names, final: false }).filter((x) => x.phase === "done");
    expect(m.filter((x) => x.scope === "t").map((x) => [x.idx, x.value, x.rank, x.breaks])).toEqual([
      [18, 38, 8, false], [19, 40, 2, false], [20, 42, 1, true],
    ]);
    expect(m[m.length - 1]).toMatchObject({ name: "팀T", tcode: "T", bucket: "Q1", period: "Q1" });
    expect(m[m.length - 1].text).toBe("1쿼터 득점 42점 KBL 신기록(종전 41점)");
  });

  it("연장은 OT 구간만(ALL에 섞이지 않는다), 저장 구간은 OT, 기간은 X1", () => {
    const events = repeat(11, () => ev("p", "T", "201", "X1", 4));
    const m = buildRecordTimeline(ctxOf({ "pq.pts.max|OT": [20, 18, 18, 16], "pq.pts.max|ALL": [1] }), events, { names, final: false });
    const done = m.filter((x) => x.phase === "done");
    expect(done[done.length - 1]).toMatchObject({ bucket: "OT", period: "X1", breaks: true, value: 22 });
    expect(done[done.length - 1].text).toBe("연장 득점 22점 KBL 신기록(종전 20점)");
  });

  it("경기 보드: 선수 경기 어시스트 21개 타이 - 구간 G, 기간 빈 문자열", () => {
    const events = [...repeat(10, () => ev("p", "T", "211", "Q1")), ...repeat(11, () => ev("p", "T", "211", "Q3"))];
    const m = buildRecordTimeline(ctxOf({ "pg.ast.max|G": [21, 17, 16, 16, 15] }), events, { names, final: false }).filter((x) => x.phase === "done");
    expect(m[m.length - 1]).toMatchObject({ idx: 20, bucket: "G", period: "", rank: 1, tie: true, board: "pg.ast.max" });
    expect(m[m.length - 1].text).toBe("한 경기 어시스트 21개 KBL 타이 기록(공동 1위)");
  });

  it("팀 쿼터 최소 득점은 쿼터가 끝난 뒤에만 판정한다(다음 쿼터 첫 이벤트에서, 종료 경기는 마지막 쿼터도)", () => {
    const tens = (v: number) => Array<number>(10).fill(v);
    const boards = { "tq.pts.min|Q2": tens(3), "tq.pts.min|ALL": [2, 2, ...Array<number>(8).fill(3)] };
    const events = [ev("p", "T", "201", "Q2"), ev("q", "U", "201", "Q2"), ev("q", "U", "201", "Q2"), ev("p", "T", "201", "Q3")];
    const live = buildRecordTimeline(ctxOf(boards), events, { names, final: false }).filter((x) => x.phase === "done");
    // T는 2쿼터에 2점 - 2쿼터 보드 신기록(종전 3점), 전체 보드로는 공동 1위. U는 4점이라 두 보드 모두 TOP10(최소) 밖.
    // 3쿼터(진행 중)는 아직 안 끝났으므로 판정하지 않는다. 판정 시점은 2쿼터의 마지막 이벤트(idx 2).
    expect(live.map((x) => [x.idx, x.name, x.value, x.breaks, x.tie])).toEqual([[2, "팀T", 2, true, false]]);
    expect(live[0].text).toBe("2쿼터 최소 득점 2점 KBL 신기록(종전 3점)");
    expect(live[0].detail.startsWith("한 쿼터 기준 공동 1위")).toBe(true);
    // 종료 경기는 마지막 쿼터와 경기 끝도 판정 - 3쿼터 T 2점은 신기록, 경기 최소 보드(전부 1점)는 총점 4점이라 TOP10 밖.
    const fin = buildRecordTimeline(ctxOf({ "tq.pts.min|Q3": [5, 5], "tg.pts.min|G": tens(1) }), events, { names, final: true }).filter((x) => x.phase === "done");
    expect(fin.map((x) => [x.board, x.name, x.value])).toEqual([["tq.pts.min", "팀T", 2]]);
    // 경기 최소 득점: 총점이 보드 최소(41)보다 낮으면 경기 끝에서 신기록.
    const game = buildRecordTimeline(ctxOf({ "tg.pts.min|G": [41, 41, 43] }), events, { names, final: true }).filter((x) => x.phase === "done");
    expect(game.map((x) => [x.board, x.name, x.value, x.idx, x.breaks])).toEqual([["tg.pts.min", "팀T", 4, 3, true], ["tg.pts.min", "팀U", 4, 3, true]]);
    expect(game[0].text).toBe("한 경기 최소 득점 4점 KBL 신기록(종전 41점)");
  });

  it("턴오버는 '불명예' 문구", () => {
    const events = repeat(6, () => ev("p", "T", "214", "Q1"));
    const m = buildRecordTimeline(ctxOf({ "pq.to.max|Q1": [5, 5, 4] }), events, { names, final: false }).filter((x) => x.phase === "done");
    expect(m[m.length - 1].text).toBe("1쿼터 턴오버 6개 불명예 신기록(종전 5개)");
    expect(recordToast(m[m.length - 1])).toEqual({ icon: "🏆", title: "불명예 신기록!", msg: "(잠정) 선수p 1쿼터 턴오버 6개 불명예 신기록(종전 5개)" });
  });
});

describe("recordLine", () => {
  it("본문이 괄호로 끝나면 같은 괄호 안에 이어 붙이고, 아니면 괄호로 감싸며, 설명이 없으면 본문만", () => {
    expect(recordLine({ text: "A 신기록(종전 8개)", detail: "보유자 외 3건 보유" })).toBe("A 신기록(종전 8개 · 보유자 외 3건 보유)");
    expect(recordLine({ text: "A 역대 공동 6위", detail: "역대 1위 6개: 허웅" })).toBe("A 역대 공동 6위(역대 1위 6개: 허웅)");
    expect(recordLine({ text: "A 역대 공동 6위", detail: "" })).toBe("A 역대 공동 6위");
    expect(recordLine({ text: "A 신기록(종전 8개)", detail: "" })).toBe("A 신기록(종전 8개)");
  });

  it("괄호가 연달아 붙는 문장이 만들어지지 않는다", () => {
    for (const text of ["x 신기록(종전 8개)", "x 타이 기록(공동 1위)", "x 역대 3위"]) expect(recordLine({ text, detail: "a · b" })).not.toContain(")(");
  });
});

describe("recordToast", () => {
  it("신기록 / 타이 / 상위 / 그 밖의 TOP10 아이콘과 제목", () => {
    const base = { board: "pq.ast.max", provisional: false, name: "허훈", text: "본문" } as never;
    const t = (o: object) => recordToast({ ...(base as object), ...o } as never);
    expect(t({ breaks: true, rank: 1 })).toMatchObject({ icon: "🏆", title: "KBL 신기록!" });
    expect(t({ breaks: false, rank: 1 })).toMatchObject({ icon: "🏆", title: "KBL 타이 기록" });
    expect(t({ breaks: false, rank: 3 })).toMatchObject({ icon: "🥈", title: "역대 기록" });
    expect(t({ breaks: false, rank: 8 })).toMatchObject({ icon: "🏅", title: "역대 기록", msg: "허훈 본문" });
  });
});
