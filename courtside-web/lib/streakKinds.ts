// 연속 기록(3단계) 공통 정의 - 서버(recordStreaks.ts)와 클라이언트 엔진(streakMoments.ts)이 같이 쓴다. 서버 전용 import가 없다.
// 설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md

export const STREAK_KINDS = [
  "gp", "xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss",
  "cg_pts10", "cg_pts20", "cg_dd", "cg_reb10", "cg_tpm1", "cg_ast5", "tw", "tl",
  "ss_gp", "ss_pts", "ss_reb", "ss_ast", "ss_stl", "ss_blk", "ss_tpm",
] as const;
export type StreakKind = (typeof STREAK_KINDS)[number];
/** 선수 연속 경기 6종(4단계 A) - 정규시즌 명단 기준 */
export const CG_KINDS = ["cg_pts10", "cg_pts20", "cg_dd", "cg_reb10", "cg_tpm1", "cg_ast5"] as const;
export type CgKind = (typeof CG_KINDS)[number];
/** 팀 시즌 내 연승·연패 - 로그의 pcode 칸에 팀 코드가 들어간다 */
export const TEAM_KINDS = ["tw", "tl"] as const;
export const isTeamKind = (k: StreakKind) => k === "tw" || k === "tl";
/** 선수-시즌 누적 6종(4단계 C) - 로그의 before/after가 그 시즌 합계다. ss_gp는 그 시즌 출전 경기 수(상태만 있고 보드 행은 없다). */
export const SEASON_KINDS = ["ss_pts", "ss_reb", "ss_ast", "ss_stl", "ss_blk", "ss_tpm"] as const;
export type SeasonKind = (typeof SEASON_KINDS)[number];
export const isSeasonKind = (k: StreakKind) => k === "ss_gp" || (SEASON_KINDS as readonly string[]).indexOf(k) >= 0;
/** 정규시즌 경기에서만 의미가 있는 종류 - 플레이오프·챔프전에서는 상태를 쓰지 않는다(슛 연속만 유지). */
export const GAME_BASED_KINDS: readonly StreakKind[] = ["gp", ...CG_KINDS, ...TEAM_KINDS, "ss_gp", ...SEASON_KINDS];

/** 보드 이름(record_entries.board) - tools/record_streaks.py BOARD와 같아야 한다. */
export const STREAK_BOARD: Record<StreakKind, string> = {
  gp: "pg.streak_gp.max",
  xfg_made: "pg.xfg_made.max",
  xfg_miss: "pg.xfg_miss.max",
  xtp_made: "pg.xtp_made.max",
  xtp_miss: "pg.xtp_miss.max",
  xft_made: "pg.xft_made.max",
  xft_miss: "pg.xft_miss.max",
  cg_pts10: "pg.cg_pts10.max",
  cg_pts20: "pg.cg_pts20.max",
  cg_dd: "pg.cg_dd.max",
  cg_reb10: "pg.cg_reb10.max",
  cg_tpm1: "pg.cg_tpm1.max",
  cg_ast5: "pg.cg_ast5.max",
  tw: "tg.win_streak.max",
  tl: "tg.loss_streak.max",
  ss_gp: "pg.season_gp.max", // 행이 없는 이름(상태 전용 종류)
  ss_pts: "pg.season_pts.max",
  ss_reb: "pg.season_reb.max",
  ss_ast: "pg.season_ast.max",
  ss_stl: "pg.season_stl.max",
  ss_blk: "pg.season_blk.max",
  ss_tpm: "pg.season_tpm.max",
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
  /** 이 경기 두 팀의 표시 이름(tcode -> 이름) - 팀 연승·연패 줄 문구용. 팀 코드도 `known`/`state`의 키로 쓴다. */
  teams?: Record<string, string>;
};
