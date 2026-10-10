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
  it("신기록을 매 경기 이어가는 것(순위 그대로)은 알리지 않는다 - 이정현이 출전할 때마다 뜨지 않게", () => {
    const s = streaksOf({ boards: { gp: GP }, state: { lee: { gp: { before: 393 } } }, known: ["lee"] });
    expect(buildStreakMoments(null, s, [ev("lee", "H", "101")], OPTS)).toEqual([]);
  });
  it("50의 배수(100 이상) 이정표 경기에서는 알린다 - 문구는 종전 기록과 보유자", () => {
    expect(isMilestone(400) && isMilestone(150) && !isMilestone(50) && !isMilestone(399)).toBe(true);
    const s = streaksOf({ boards: { gp: GP }, state: { lee: { gp: { before: 399 } } }, known: ["lee"] });
    const m = buildStreakMoments(null, s, [ev("lee", "H", "101")], OPTS).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ board: "pg.streak_gp.max", subject: "lee", value: 400, rank: 1, breaks: true, provisional: true, idx: 0 });
    expect(m[0].text).toBe("연속 출장 400경기째 KBL 신기록(종전 383경기)");
    expect(m[0].detail).toBe("주희정 보유");
  });
  it("순위가 좋아지면 알린다 - 10위 밖에서 처음 10위 안(공동 10위)으로 들어올 때, 이미 10위 안이고 순위 그대로면 알리지 않는다", () => {
    const enter = streaksOf({ boards: { gp: GP }, state: { z: { gp: { before: 190 } } }, known: ["z"] });
    const a = buildStreakMoments(null, enter, [ev("z", "H", "101")], OPTS)[0];
    expect(a.text).toBe("연속 출장 191경기째 KBL 역대 공동 10위");
    const stay = streaksOf({ boards: { gp: GP }, state: { alb: { gp: { before: 195 } } }, known: ["alb"] });
    expect(buildStreakMoments(null, stay, [ev("alb", "H", "101")], OPTS)).toEqual([]);
  });
  it("10위 밖이고 이정표도 아니면 만들지 않고, 상태를 믿을 수 없는 선수(known 밖)나 상태가 없는 선수도 건너뛴다", () => {
    const s = streaksOf({ boards: { gp: GP }, state: { a: { gp: { before: 30 } }, b: { gp: { before: 399 } } }, known: ["a"] });
    expect(buildStreakMoments(null, s, [ev("a", "H", "101"), ev("b", "H", "101"), ev("c", "H", "101")], OPTS)).toEqual([]);
  });
  it("종료 경기: 이 경기 로그 행(after)이 있어야 하고 '잠정'이 아니다", () => {
    const withRow = streaksOf({ boards: { gp: GP }, state: { lee: { gp: { before: 399, after: 400 } } }, known: ["lee"], final: true });
    const m = buildStreakMoments(null, withRow, [ev("lee", "H", "101")], { ...OPTS, final: true });
    expect(m).toHaveLength(1);
    expect(m[0].provisional).toBe(false);
    expect(m[0].value).toBe(400);
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
    const s = { ...streaksOf({ boards: { gp: GP, xft_made: FT }, state: { lee: { gp: { before: 399 } }, p: { xft_made: { before: 41 } } }, known: ["lee", "p"] }), players };
    const chances = buildStreakChances(s);
    expect(chances.map((c) => c.text)).toEqual([
      "오늘 출전하면 연속 출장 400경기째 KBL 신기록(종전 383경기)",
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
    const s = streaksOf({ boards: { gp: GP }, state: { lee: { gp: { before: 399 } } }, known: ["lee"] });
    const all = buildAllRecordMoments(ctxOf({}), [ev("lee", "H", "101"), ev("lee", "H", "201", 1)], OPTS, s);
    expect(all.map((x) => x.board)).toContain("pg.streak_gp.max");
    expect(buildAllRecordMoments(ctxOf({}), [ev("lee", "H", "101")], OPTS).map((x) => x.board)).not.toContain("pg.streak_gp.max");
  });
  it("summaryOf: 본인의 *진행 중* 행만 뺀다 - 본인이 예전에 끝낸 연속은 종전 기록으로 남는다", () => {
    const own = [ent(60, "p", "본인", true), ent(56, "p", "본인"), ent(52, "m", "문경은")];
    const sm = summaryOf(own, "p");
    expect(sm.tops).toEqual([56, 52]);
    expect(sm.holders[0]).toEqual({ v: 56, who: "본인", d: "2026-03-24" });
  });
  it("summaryOf: 본인 행을 빼고 순위 <= 10의 값과 상위 3위 보유자를 낸다", () => {
    const sm = summaryOf(GP, "lee");
    expect(sm.tops[0]).toBe(383);
    expect(sm.holders[0]).toEqual({ v: 383, who: "주희정", d: "2026-03-24" });
  });
});
