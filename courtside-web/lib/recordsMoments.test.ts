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
