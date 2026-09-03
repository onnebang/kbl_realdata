import { PRESEASON_SEASON, prevSeasonName, shortSeason } from "./preseason";

// "이번 시즌"의 정의를 한 곳에 두는 모듈(프로필 개편 1단계, profile_direction_final.json thesis (1)).
//
// 두 프로필(/players/[pcode], /teams/[tcode])의 모든 시즌 의존 패널은 seasons[0]·recentGames[0]을
// 직접 읽지 않고 여기서 만든 focusSeason/statSeason을 받는다. 개막일 밤에 1경기 평균이 "시즌
// 수치"로 승격되는 사고를 막기 위해서다 - 사실(전적·순위·경기 로그)은 첫 경기 즉시 26-27로,
// 추정(평균·4팩터·퍼센타일·온/오프)은 이름 붙은 임계값에서만 26-27로 바뀐다.
//
//   focusSeason = 이 선수/팀이 "지금 속한" 시즌. season_roster에 있는 선수와 모든 현역 팀은
//                 PRESEASON_SEASON(2026-2027); 이탈·아카이브 선수는 마지막 출전 시즌.
//   statSeason  = 추정 패널(평균·퍼센타일·4팩터 등)이 기본으로 집계하는 시즌. focusSeason의
//                 표본이 임계(선수 10GP / 팀 정규 5경기)를 넘으면 focusSeason, 아니면 그 직전에
//                 실제로 뛴 시즌. 하나도 없으면 null(신입의 첫 시즌).
//
// 칩 문구는 basisChip()/emptyState()만이 만든다 - 페이지마다 다른 문구가 생기지 않도록
// (shared_design_language (2), (9)).

export { PRESEASON_SEASON, prevSeasonName };

/** "2025-2026" -> "25-26". lib/preseason.ts shortSeason의 별칭(한 곳에서 import하도록). */
export const seasonShort = shortSeason;

// ---------------------------------------------------------------------------
// 임계값 - 전부 디자인 상수다. 통계적으로 "이 표본부터 유의하다"는 근거가 아니라 "이 표본
// 아래에서는 시즌 수치로 승격시키지 않는다"는 편집 규칙이다(실측 근거가 있는 것은 옆에 적음).
// 페이지 코드에 숫자 리터럴을 쓰지 말고 반드시 이 이름을 쓴다(배포 전 grep 대상).
// ---------------------------------------------------------------------------

/** 선수 statSeason 전환: focusSeason GP가 이 값 이상이면 히어로 타일·온/오프·슈팅 챕터 기본 시즌이 바뀐다. */
export const STAT_SEASON_MIN_GP_PLAYER = 10;

/** 팀 statSeason 전환: focusSeason에서 치른 정규시즌 경기가 이 값 이상이면 NET/4팩터/레이팅이 바뀐다. */
export const STAT_SEASON_MIN_REG_GAMES_TEAM = 5;

/** 퍼센타일 "잠정"(빗금) 표시 하한 - GP와 분을 모두 넘어야 함. 근거: 2025-26 개막 21일 시점 5GP&100분 충족 64명(검증). */
export const PERCENTILE_PROVISIONAL = { gp: 5, min: 100 } as const;

/** 퍼센타일 "확정" - GP 또는 분 중 하나만 넘으면 됨(기존 lib/playerDataScience.ts PERCENTILE_MIN_GP/MINUTES와 같은 값). 같은 시점 충족 0명(검증). */
export const PERCENTILE_FINAL = { gp: 15, min: 300 } as const;

/** 슈팅 DNA·슈팅 챕터 기본 시즌이 26-27로 넘어가는 시즌 슛 수(lib/playerDataScience.ts DNA_MIN_SEASON_SHOTS와 동일). */
export const DNA_MIN_SHOTS = 30;

/** 팀 존 프로필이 26-27로 넘어가는 팀 슛 수. */
export const TEAM_ZONE_MIN_SHOTS = 300;

/** 온/오프 표시 하한(분) - 온코트와 오프코트 둘 다 넘어야 표시(2단계 RPC용, 상수만 먼저 고정). */
export const ONOFF_MIN = { on: 300, off: 100 } as const;

/** 라이브 챕터 한 장의 경기 수 - 이 수 미만이면 평균 대신 "표본 N/5"만(2단계). */
export const CHAPTER_GAMES = 5;

/** 팀 히어로 NET/PPG/OPP 타일이 26-27로 넘어가는 정규 경기 수(= STAT_SEASON_MIN_REG_GAMES_TEAM, 이름만 분리). */
export const HERO_TILE_MIN_GP_TEAM = 5;

// ---------------------------------------------------------------------------
// focus/stat 시즌 판정
// ---------------------------------------------------------------------------

/**
 *   final      - focusSeason은 PRESEASON_SEASON이지만 표본 임계 미달이라 statSeason은 직전 출전 시즌(개막 전의 기본값)
 *   inprogress - statSeason === focusSeason === PRESEASON_SEASON(임계 통과)
 *   career     - 현역인데 직전 출전 시즌이 없음(pcode가 갓 연결된 신입) → statSeason null, 패널은 커리어/잠정 폴백
 *   archive    - 확정 명단에 없음(이탈·아카이브 선수, 해체 팀) → focusSeason = statSeason = 마지막 출전 시즌
 */
export type SeasonBasis = "final" | "inprogress" | "career" | "archive";

export type SeasonFocus = {
  focusSeason: string;
  statSeason: string | null;
  /** focusSeason에서의 표본(선수 GP / 팀 정규 치른 경기). archive면 마지막 시즌의 값. */
  focusGp: number;
  basis: SeasonBasis;
  /** 이 판정에 쓰인 임계(선수 STAT_SEASON_MIN_GP_PLAYER / 팀 STAT_SEASON_MIN_REG_GAMES_TEAM). */
  threshold: number;
  /** 칩 문구용 임계 표기('10경기' / '정규 5경기'). */
  thresholdLabel: string;
  /** 출전 기록이 있는 시즌 수(커리어 칩용). 팀은 알 수 없으면 0. */
  seasonsPlayed: number;
};

export type SeasonGp = { seasonName: string; gp: number };

/**
 * 선수의 focus/stat 시즌.
 * @param seasonsPlayedDesc 시즌별 출전 경기 수(순서는 무관 - 안에서 최신순 정렬). gp 0인 시즌은 "뛴 시즌"으로 치지 않음.
 * @param onRoster season_roster(PRESEASON_SEASON)에 행이 있는가 = lib/playerStatus.ts state === "active".
 */
export function resolvePlayerSeasons(pcode: string, seasonsPlayedDesc: SeasonGp[], onRoster: boolean): SeasonFocus {
  void pcode; // 시그니처 고정용(호출부 가독성) - 판정 자체는 표본과 명단 여부만으로 결정된다.
  const played = seasonsPlayedDesc.filter((s) => s.gp > 0).sort((a, b) => (a.seasonName < b.seasonName ? 1 : -1));
  const base = { threshold: STAT_SEASON_MIN_GP_PLAYER, thresholdLabel: `${STAT_SEASON_MIN_GP_PLAYER}경기`, seasonsPlayed: played.length };

  if (!onRoster) {
    // 이탈·아카이브: 마지막 출전 시즌이 곧 focus이자 stat(카운트다운·다음 경기 없음).
    const last = played[0] ?? null;
    return { ...base, focusSeason: last?.seasonName ?? PRESEASON_SEASON, statSeason: last?.seasonName ?? null, focusGp: last?.gp ?? 0, basis: "archive" };
  }

  const focusSeason = PRESEASON_SEASON;
  const focusGp = played.find((s) => s.seasonName === focusSeason)?.gp ?? 0;
  if (focusGp >= STAT_SEASON_MIN_GP_PLAYER) return { ...base, focusSeason, statSeason: focusSeason, focusGp, basis: "inprogress" };

  // 임계 미달이면 focusSeason "이전"에 실제로 뛴 최신 시즌(26-27 3경기가 statSeason이 되는 일이 없도록 < 비교).
  const prior = played.find((s) => s.seasonName < focusSeason) ?? null;
  if (prior) return { ...base, focusSeason, statSeason: prior.seasonName, focusGp, basis: "final" };
  return { ...base, focusSeason, statSeason: null, focusGp, basis: "career" };
}

/**
 * 팀의 focus/stat 시즌. 팀 규칙은 "정규시즌 치른 경기 ≥ 5"(PO 표본 섞지 않음 - lib/matchups.ts 관례).
 * @param playedRegGamesInFocus lib/matchups.ts getTeamPlayedRegCount(tcode, PRESEASON_SEASON)
 * @param isActiveTeam 이 시즌 roster_changes/season_roster 행이 있는 팀(해체된 옛 팀코드는 false)
 * @param lastPlayedSeason 비활성 팀의 마지막 시즌(모르면 직전 시즌으로 둠)
 */
export function resolveTeamSeasons(tcode: string, playedRegGamesInFocus: number, isActiveTeam: boolean, lastPlayedSeason?: string | null): SeasonFocus {
  void tcode;
  const base = { threshold: STAT_SEASON_MIN_REG_GAMES_TEAM, thresholdLabel: `정규 ${STAT_SEASON_MIN_REG_GAMES_TEAM}경기`, seasonsPlayed: 0 };
  if (!isActiveTeam) {
    const s = lastPlayedSeason ?? prevSeasonName(PRESEASON_SEASON);
    return { ...base, focusSeason: s, statSeason: s, focusGp: playedRegGamesInFocus, basis: "archive" };
  }
  const focusSeason = PRESEASON_SEASON;
  if (playedRegGamesInFocus >= STAT_SEASON_MIN_REG_GAMES_TEAM) {
    return { ...base, focusSeason, statSeason: focusSeason, focusGp: playedRegGamesInFocus, basis: "inprogress" };
  }
  return { ...base, focusSeason, statSeason: prevSeasonName(focusSeason), focusGp: playedRegGamesInFocus, basis: "final" };
}

/** ?season= 쿼리가 프리시즌보다 과거인가(팀 페이지의 "결과 중심 패널만" 게이트). */
export function isPastSeason(season: string): boolean {
  return season < PRESEASON_SEASON;
}

// ---------------------------------------------------------------------------
// 칩 문구 - 다섯 어휘만 존재한다. 다른 문구가 필요하면 여기에 추가하고 페이지에서 리터럴을 쓰지 않는다.
//   '25-26 최종' / '26-27 진행 중 · N경기 (임계 K)' / '커리어 15시즌' / '잠정 · N경기 M분' / '오프라인 집계 갱신 전'
// 'final'의 last 변형('23-24 · 마지막 KBL 시즌')은 직전 시즌보다 오래된 statSeason(복귀·아카이브)에만 쓴다.
// ---------------------------------------------------------------------------
export type BasisChipKind = "final" | "inprogress" | "preseason" | "career" | "provisional" | "offline";

export function basisChip(kind: "final", opts: { season: string; last?: boolean }): string;
export function basisChip(kind: "inprogress", opts: { n: number; threshold: number | string; season?: string; unit?: string }): string;
export function basisChip(kind: "preseason", opts?: { season?: string }): string;
export function basisChip(kind: "career", opts: { seasons: number }): string;
export function basisChip(kind: "provisional", opts: { gp: number; min: number }): string;
export function basisChip(kind: "offline"): string;
export function basisChip(kind: BasisChipKind, opts?: Record<string, unknown>): string {
  switch (kind) {
    case "final": {
      const o = opts as { season: string; last?: boolean };
      return o.last ? `${shortSeason(o.season)} · 마지막 KBL 시즌` : `${shortSeason(o.season)} 최종`;
    }
    case "inprogress": {
      const o = opts as { n: number; threshold: number | string; season?: string; unit?: string };
      const unit = o.unit ?? "경기";
      const k = typeof o.threshold === "number" ? `${o.threshold}${unit}` : o.threshold;
      // 경기 수가 0이면 "진행 중"이 거짓이다 - 아직 한 경기도 안 열린 시즌은 preseason 칩으로.
      if (o.n <= 0) return basisChip("preseason", { season: o.season });
      return `${shortSeason(o.season ?? PRESEASON_SEASON)} 진행 중 · ${o.n.toLocaleString()}${unit} (임계 ${k})`;
    }
    // 아직 한 경기도 치르지 않은 시즌(개막 전, 또는 ?season=으로 직접 고른 미래 시즌).
    // "진행 중 · 0경기"라고 쓰면 시즌이 시작한 것처럼 읽히므로 별도 어휘를 둔다.
    case "preseason": {
      const o = (opts ?? {}) as { season?: string };
      return `${shortSeason(o.season ?? PRESEASON_SEASON)} · 개막 전`;
    }
    case "career": {
      const o = opts as { seasons: number };
      return `커리어 ${o.seasons}시즌`;
    }
    case "provisional": {
      const o = opts as { gp: number; min: number };
      return `잠정 · ${o.gp}경기 ${Math.round(o.min).toLocaleString()}분`;
    }
    case "offline":
      return "오프라인 집계 갱신 전";
  }
}

/**
 * SeasonFocus 하나로 "기준 시즌" 칩을 고르는 표준 경로 - 시즌 의존 패널 제목은 이 함수 결과를 그대로 단다.
 *   inprogress → '26-27 진행 중 · 12경기 (임계 10경기)'
 *   final/archive → statSeason이 직전 시즌이면 '25-26 최종', 더 오래됐으면 '23-24 · 마지막 KBL 시즌'
 *   career → 26-27 표본이 있으면 진행 중 칩, 없으면 '커리어 N시즌'
 */
export function statSeasonChip(f: SeasonFocus): string {
  if (f.basis === "inprogress") return basisChip("inprogress", { n: f.focusGp, threshold: f.thresholdLabel });
  if (f.statSeason) return basisChip("final", { season: f.statSeason, last: f.statSeason < prevSeasonName(PRESEASON_SEASON) });
  if (f.focusGp > 0) return basisChip("inprogress", { n: f.focusGp, threshold: f.thresholdLabel });
  return basisChip("career", { seasons: f.seasonsPlayed });
}

/** 개막 후·임계 전 상태('25-26 최종' 옆에 붙는 두 번째 칩 '26-27 진행 중 · 3경기 (임계 10경기)'). 해당 없으면 null. */
export function progressChip(f: SeasonFocus): string | null {
  if (f.basis !== "final" || f.focusGp <= 0) return null;
  return basisChip("inprogress", { n: f.focusGp, threshold: f.thresholdLabel });
}

// ---------------------------------------------------------------------------
// 빈 상태 문구 - 원인별로 분리된 네 가지만('RPC 오류'와 '이 시즌 출전 없음'을 한 문구로 뭉개지 않는다).
// ---------------------------------------------------------------------------
export type EmptyStateKind = "none" | "sample" | "offline" | "rpc";

export function emptyState(kind: "none" | "offline" | "rpc"): string;
export function emptyState(kind: "sample", opts: { n: number; threshold: number | string; unit?: string }): string;
export function emptyState(kind: EmptyStateKind, opts?: { n: number; threshold: number | string; unit?: string }): string {
  switch (kind) {
    case "none":
      return "이 시즌 출전 없음";
    case "sample": {
      const o = opts!;
      const k = typeof o.threshold === "number" ? `${o.threshold}${o.unit ?? "경기"}` : o.threshold;
      return `표본 부족 · ${o.n.toLocaleString()}/${k}`;
    }
    case "offline":
      return "오프라인 집계 갱신 전";
    case "rpc":
      return "RPC 오류";
  }
}
