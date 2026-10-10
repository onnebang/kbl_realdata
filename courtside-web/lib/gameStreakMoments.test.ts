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
