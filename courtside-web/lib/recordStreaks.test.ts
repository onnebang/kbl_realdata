import { describe, expect, it } from "vitest";
import { summarizeStreaks, type StreakBoardRow, type StreakLogRow } from "./recordStreaks";

const board = (b: string, subject: string, value: number, period: string, name = subject): StreakBoardRow => ({ board: b, subject, period, value, name, date: "2026-10-08" });
const logRow = (gmkey: string, pcode: string, kind: string, before: number, after: number, alive: boolean, start = "S49G01N1"): StreakLogRow => ({
  gmkey, pcode, kind, before_len: before, after_len: after, alive, start_gmkey: start,
});
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
    const ctx = summarizeStreaks({
      ...base, final: false, freshTeams: new Set(), logRows: [],
      boardRows: [board("pg.cg_pts20.max", "p", 42, "E:x", "마이클"), board("tg.win_streak.max", "16", 16, "E:y", "원주 DB"), board("tg.loss_streak.max", "35", 14, "E:z", "서울 삼성")],
    })!;
    expect(ctx.boards.cg_pts20[0]).toMatchObject({ v: 42, pcode: "p", who: "마이클", active: false });
    expect(ctx.boards.tw[0].who).toBe("원주 DB");
    expect(ctx.boards.tl[0].v).toBe(14);
  });

  it("보드도 상태도 없으면 null", () => {
    expect(summarizeStreaks({ ...base, final: false, freshTeams: new Set(), boardRows: [], logRows: [] })).toBeNull();
  });
});
