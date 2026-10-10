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

  it("정규시즌이 아닌 경기(regular=false)에서는 연속 출장 상태를 쓰지 않는다(슛 연속은 그대로)", () => {
    const rows = [logRow("S49G01N10", "lee", "gp", 392, 393, true), logRow("S49G01N10", "lee", "xft_made", 4, 5, true)];
    const po = summarizeStreaks({ ...base, final: false, freshTeams: new Set(["DB"]), boardRows: [board("pg.streak_gp.max", "lee", 746, "A:x")], logRows: rows, regular: false })!;
    expect(po.state).toEqual({ lee: { xft_made: { before: 5 } } });
    expect(po.boards.gp).toHaveLength(1);
    const reg = summarizeStreaks({ ...base, final: false, freshTeams: new Set(["DB"]), boardRows: [], logRows: rows })!;
    expect(reg.state.lee.gp).toEqual({ before: 393 });
  });

  it("보드도 상태도 없으면 null", () => {
    expect(summarizeStreaks({ ...base, final: false, freshTeams: new Set(), boardRows: [], logRows: [] })).toBeNull();
  });
});
