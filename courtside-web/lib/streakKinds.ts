// 연속 기록(3단계) 공통 정의 - 서버(recordStreaks.ts)와 클라이언트 엔진(streakMoments.ts)이 같이 쓴다. 서버 전용 import가 없다.
// 설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md

export const STREAK_KINDS = ["gp", "xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss"] as const;
export type StreakKind = (typeof STREAK_KINDS)[number];

/** 보드 이름(record_entries.board) - tools/record_streaks.py BOARD와 같아야 한다. */
export const STREAK_BOARD: Record<StreakKind, string> = {
  gp: "pg.streak_gp.max",
  xfg_made: "pg.xfg_made.max",
  xfg_miss: "pg.xfg_miss.max",
  xtp_made: "pg.xtp_made.max",
  xtp_miss: "pg.xtp_miss.max",
  xft_made: "pg.xft_made.max",
  xft_miss: "pg.xft_miss.max",
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
};
