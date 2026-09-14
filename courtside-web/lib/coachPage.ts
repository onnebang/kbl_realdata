import { supabaseServer as supabase } from "./supabaseServer";
import { TAG, TTL, cached } from "./cachePolicy";
import { signed } from "./format";
import { getAllTeams } from "./playerProfile";
import { PRESEASON_SEASON, shortSeason } from "./preseason";
import { displayTeamName } from "./teamNames";

// 감독 프로필(app/coaches) 데이터 레이어. 원천은 tools/build_coach_profile.py가 만든 집계 4종
// (coach_season_record / coach_season_style / coach_challenge_usage / coach_challenge_league - RLS on,
// 정책 0, service_role만 읽는다). 측정 결과(2026-09-07, 15시즌 검정)의 판정을 그대로 따른다:
//   F 커리어 기본  weak  → 승-패·득실은 사실로 내되 '감독 효과/랭킹' 금지, 캡션 3개 필수(RECORD_CAPTIONS).
//   D 전술 프로필  weak  → 이름은 "재임기 팀 스타일"(DNA 아님). 6축 z, |z|<SE 축은 회색.
//   E 챌린지       noise → 성공률·WPA 없음. 리그 요약 한 줄 + 사용 성향(순위 없이).
//   ATO           noise → 부른 뒤 첫 공격 효율(PPP)은 싣지 않는다. '언제 부르는가'(coach_timeout_tendency, 분할 r 0.59~0.77)만.
//   로테이션·클러치는 아직 화면에 없다(MEASURING_NOTE 한 줄만).
// 통산은 시즌 행을 경기 수로 가중해 웹에서 만든다(정규시즌만). 2026-27은 stats가 없어 이름·팀만.

/** 경기당 마진 SD(2011-12~2025-26 팀-경기) - build_coach_profile.py MARGIN_SD와 같은 값. 통산 넷마진 SE = 이 값/√G. */
export const MARGIN_SD = 12.64;
/** 순위표 최소 경기 수(결과 F: 1시즌 감독은 승률 SE ±.068 - 108경기 = 2시즌). */
export const LIST_MIN_GAMES = 108;
/** 통산 스타일 z를 만드는 최소 시즌 수(결과 D: 1~2시즌 감독의 통산 라벨 금지). */
export const CAREER_MIN_SEASONS = 3;

/** "2011-2012" -> "2011-12" (캡션 원문 표기). */
const seasonLong = (s: string) => `${s.slice(0, 4)}-${s.slice(7, 9)}`;

export const RECORD_CAPTIONS = (first: string, last: string) => [
  `정규시즌 ${seasonLong(first)}~${seasonLong(last)}, 승-패는 감독이 배정된 시즌의 팀 성적이며 감독 개인의 기여도가 아님`,
  "시즌 도중 감독 교체는 반영되지 않음(팀-시즌당 감독 1명으로 기록)",
  "감독 간 승률 차이의 대부분은 팀 전력·로스터 연속성으로 설명됨(팀 통제 후 감독 라벨 추가 설명력 p=0.21)",
];
export const STYLE_CAPTION =
  "정규시즌 팀 기록을 감독 재임 시즌 기준으로 집계. 로스터 영향 포함 — 감독 교체보다 로스터 회전율이 변화를 더 설명함(페이스 축만 감독 교체에 반응)";
export const CHALLENGE_CAPTION =
  "2025-26 정규시즌 12/4~4/8 187경기만 기록됨(그 이전 83경기는 코드 미기록). 챌린지 성공 여부는 KBL 기록에 없어 산출하지 않음. 감독 간 빈도 차이는 통계적으로 우연 수준(셔플 P=0.50)";
export const MEASURING_NOTE = "준비 중: 로테이션 · 클러치 성향 — 검정 결과대로 정리되기 전에는 싣지 않는다";
/** 결과 coach2_r03(2026-09-07, 정규시즌 15시즌 작전타임 32,988건)의 표시 권고 그대로. */
export const TIMEOUT_CAPTIONS = [
  "작전타임을 '언제' 부르는가는 감독 성향이다 - 한 시즌을 홀·짝 경기로 나눠도 같은 값이 나온다(상대 연속 득점 r 0.77 · 경기당 호출 0.73 · 4쿼터 비중 0.59). 좋고 나쁨이 아니라 스타일이고, 승패와의 관계는 검증하지 않았다.",
  "작전타임 직후 첫 공격 득점은 1.02점으로 다른 데드볼 공격(1.04점)과 같다(15시즌 28,239회). 감독 간 차이가 표본오차와 구분되지 않아 감독별 효율은 싣지 않는다.",
  "상대 연속 득점 = 호출 시점까지, 호출한 팀이 마지막으로 득점한 뒤 상대가 넣은 점수. 경기당 호출은 작전타임이 기록된 경기로 나눈다(2013-14는 27경기에 기록이 없다). 4쿼터 비중에 연장은 넣지 않는다.",
];
/** all3_pct는 n_ch>=3 비율이다 - 허용은 3회지만 4회로 기록된 팀-경기가 2025-26에 8건 있다(DB 재계산). */
export const CHALLENGE_ALL3_NOTE = "‘3회 이상’ = 허용 3회를 다 쓴 경기 + 4회로 기록된 팀-경기 8건(연장 5건 · 연장 없는 경기 3건 - 로깅 오류 가능성)";
/** 2019-20은 코로나 중단으로 팀당 42~43경기. */
export const SHORT_SEASON = "2019-2020";
/** 완주 시즌의 팀당 경기 수. */
export const FULL_SEASON_GAMES = 54;
/**
 * 진행 중인 시즌은 **데이터셋의 마지막 시즌뿐이다.** 경기 수만으로 판정하면 안 된다:
 * 2019-20은 코로나 중단으로 팀당 42~43경기라, 42경기를 치른 팀(현주엽·유도훈·유재학·전창진)이
 * 6년이 지난 지금도 '진행 중'으로 찍혔다. 실제로 현주엽 페이지에서는 그게 마지막 시즌이라
 * 배지가 붙었고, 같은 카드의 각주("2019-20은 코로나 중단으로 팀당 42~43경기")와 자기모순이었다.
 * 끝난 시즌을 '진행 중'이라고 쓰는 것은 이 저장소의 데이터 정직성 규칙 위반이다.
 */
export const isPartialSeason = (seasonName: string, g: number, dataLast: string) =>
  seasonName === dataLast && g < FULL_SEASON_GAMES;
export const PARTIAL_SEASON_NOTE = "진행 중인 시즌이라 표본이 작다 - z 표준오차는 54경기 기준값보다 크다";
/** 레이더 기본 시즌이 이보다 적은 경기면 직전 완주 시즌을 그린다(?season=으로는 그대로 볼 수 있다). */
export const RADAR_MIN_N = 40;

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------
export type TeamRef = { tcode: string; name: string; abbr: string; color: string | null; logoUrl: string | null };

export type CoachSeasonRecord = {
  seasonName: string;
  tcode: string;
  g: number;
  w: number;
  l: number;
  wpct: number;
  wpctSe: number;
  pf: number;
  pa: number;
  net: number;
  netSe: number;
  homeG: number;
  homeW: number;
  awayG: number;
  awayW: number;
};

export type RawKey = "tpar" | "fb" | "oreb" | "ast" | "pace" | "tov" | "efg" | "ftr";
export type ZKey = "tpar" | "fb" | "oreb" | "ast" | "pace" | "ballcare" | "efg" | "ftr";
export type RadarKey = Exclude<ZKey, "efg" | "ftr">;

export type CoachSeasonStyle = {
  seasonName: string;
  tcode: string;
  n: number;
  raw: Record<RawKey, number>;
  /** 같은 시즌 10팀 평균(툴팁용). */
  lg: Record<RawKey, number>;
  /** 시즌 내 10팀 z. ballcare = −TOV% z(낮을수록 바깥). */
  z: Record<ZKey, number>;
};

export type CoachCareerStyle = { n: number; z: Record<ZKey, number>; se: number };

export type CoachChallenge = {
  seasonName: string;
  tcode: string;
  games: number;
  challenges: number;
  perGame: number;
  sePoisson: number;
  all3Pct: number;
  q4Pct: number | null;
  /** 이항 SE = √(p(1−p)/n). */
  q4Se: number | null;
  clutchPct: number | null;
};

export type ChallengeLeague = {
  seasonName: string;
  windowFrom: string;
  windowTo: string;
  games: number;
  teamGames: number;
  challenges: number;
  perGame: number;
  perTeamGame: number;
  all3Pct: number;
  q4Pct: number;
  q4Under5: number;
  q4Under2: number;
  trailingN: number;
  tiedN: number;
  leadingN: number;
};

/** 작전타임 호출 성향 한 묶음(감독-시즌, 리그 시즌, 통산이 같은 모양). */
export type TimeoutTendency = { games: number; timeouts: number; perGame: number; oppRunMean: number; q4Share: number };
export type CoachTimeout = TimeoutTendency & { seasonName: string; tcode: string; league: TimeoutTendency };

export type CoachCareer = {
  g: number;
  w: number;
  l: number;
  wpct: number;
  wpctSe: number;
  pf: number;
  pa: number;
  net: number;
  netSe: number;
  seasons: number;
  first: string;
  last: string;
  teams: TeamRef[];
};

export type CoachSeasonRow = {
  seasonName: string;
  tcode: string;
  team: TeamRef;
  /** 시즌 문맥 표시명(displayTeamName). */
  teamName: string;
  record: CoachSeasonRecord;
  style: CoachSeasonStyle | null;
  challenge: CoachChallenge | null;
  timeout: CoachTimeout | null;
};

export type CurrentTeam = TeamRef & { seasonName: string; confirmed: boolean };

export type CoachProfile = {
  coach: { coachId: number; name: string };
  seasons: CoachSeasonRow[];
  career: CoachCareer | null;
  careerStyle: CoachCareerStyle | null;
  currentTeam: CurrentTeam | null;
  challengeLeague: ChallengeLeague | null;
  /** 작전타임 호출 성향 통산(시즌 행을 호출 수로 가중). 기록 시즌이 없으면 null. */
  timeoutCareer: (TimeoutTendency & { seasons: number }) | null;
  /** 집계 테이블 전체의 시즌 범위(캡션 "정규시즌 2011-12~2025-26"용 - 감독 개인 재임 범위가 아니다). */
  dataRange: { first: string; last: string };
};

export type CoachListRow = {
  coachId: number;
  name: string;
  career: CoachCareer | null;
  currentTeam: CurrentTeam | null;
};

// ---------------------------------------------------------------------------
// 행 변환
// ---------------------------------------------------------------------------
const n = (v: unknown) => Number(v);
const nn = (v: unknown) => (v == null ? null : Number(v));

function toRecord(r: Record<string, unknown>): CoachSeasonRecord {
  return {
    seasonName: r.season_name as string,
    tcode: r.tcode as string,
    g: n(r.g), w: n(r.w), l: n(r.l),
    wpct: n(r.wpct), wpctSe: n(r.wpct_se),
    pf: n(r.pf), pa: n(r.pa), net: n(r.net), netSe: n(r.net_se),
    homeG: n(r.home_g), homeW: n(r.home_w), awayG: n(r.away_g), awayW: n(r.away_w),
  };
}

function toStyle(r: Record<string, unknown>): CoachSeasonStyle {
  return {
    seasonName: r.season_name as string,
    tcode: r.tcode as string,
    n: n(r.n),
    raw: { tpar: n(r.tpar), fb: n(r.fb), oreb: n(r.oreb_pct), ast: n(r.ast_pct), pace: n(r.pace), tov: n(r.tov_pct), efg: n(r.efg_pct), ftr: n(r.ftr) },
    lg: { tpar: n(r.lg_tpar), fb: n(r.lg_fb), oreb: n(r.lg_oreb), ast: n(r.lg_ast), pace: n(r.lg_pace), tov: n(r.lg_tov), efg: n(r.lg_efg), ftr: n(r.lg_ftr) },
    z: { tpar: n(r.z_tpar), fb: n(r.z_fb), oreb: n(r.z_oreb), ast: n(r.z_ast), pace: n(r.z_pace), ballcare: n(r.z_ballcare), efg: n(r.z_efg), ftr: n(r.z_ftr) },
  };
}

function toChallenge(r: Record<string, unknown>): CoachChallenge {
  const q4 = nn(r.q4_pct);
  const ch = n(r.challenges);
  return {
    seasonName: r.season_name as string,
    tcode: r.tcode as string,
    games: n(r.games),
    challenges: ch,
    perGame: n(r.per_game),
    sePoisson: n(r.se_poisson),
    all3Pct: n(r.all3_pct),
    q4Pct: q4,
    q4Se: q4 == null || ch === 0 ? null : Math.sqrt((q4 * (1 - q4)) / ch),
    clutchPct: nn(r.clutch_pct),
  };
}

function toLeague(r: Record<string, unknown>): ChallengeLeague {
  return {
    seasonName: r.season_name as string,
    windowFrom: r.window_from as string,
    windowTo: r.window_to as string,
    games: n(r.games), teamGames: n(r.team_games), challenges: n(r.challenges),
    perGame: n(r.per_game), perTeamGame: n(r.per_team_game), all3Pct: n(r.all3_pct), q4Pct: n(r.q4_pct),
    q4Under5: n(r.q4_under5), q4Under2: n(r.q4_under2),
    trailingN: n(r.trailing_n), tiedN: n(r.tied_n), leadingN: n(r.leading_n),
  };
}

/** 여러 행을 하나로: 경기당 호출 = 호출 합 / 경기 합, 상대 연속 득점·4쿼터 비중 = 호출 수 가중 평균. */
export function poolTimeouts(rows: TimeoutTendency[]): TimeoutTendency | null {
  const games = rows.reduce((s, r) => s + r.games, 0);
  const timeouts = rows.reduce((s, r) => s + r.timeouts, 0);
  if (!games || !timeouts) return null;
  return {
    games,
    timeouts,
    perGame: timeouts / games,
    oppRunMean: rows.reduce((s, r) => s + r.oppRunMean * r.timeouts, 0) / timeouts,
    q4Share: rows.reduce((s, r) => s + r.q4Share * r.timeouts, 0) / timeouts,
  };
}

function toTimeout(r: Record<string, unknown>): TimeoutTendency & { coachId: number; seasonName: string; tcode: string } {
  return {
    coachId: n(r.coach_id),
    seasonName: r.season_name as string,
    tcode: r.tcode as string,
    games: n(r.games),
    timeouts: n(r.timeouts),
    perGame: n(r.per_game),
    oppRunMean: n(r.opp_run_mean),
    q4Share: n(r.q4_share),
  };
}

function teamRef(teams: Map<string, { tcode: string; name: string; abbr: string; color: string | null; logoUrl: string | null }>, tcode: string): TeamRef {
  const t = teams.get(tcode);
  return t ? { tcode, name: t.name, abbr: t.abbr, color: t.color, logoUrl: t.logoUrl } : { tcode, name: tcode, abbr: tcode, color: null, logoUrl: null };
}

// ---------------------------------------------------------------------------
// 집계
// ---------------------------------------------------------------------------
/** 시즌 행을 경기 수로 가중해 통산으로. 정규시즌만(원천이 그렇다). */
export function aggregateCareer(rows: CoachSeasonRecord[], teamOf: (tcode: string) => TeamRef): CoachCareer | null {
  if (!rows.length) return null;
  const sorted = rows.slice().sort((a, b) => a.seasonName.localeCompare(b.seasonName));
  let g = 0, w = 0, l = 0, pf = 0, pa = 0, net = 0;
  for (const r of sorted) {
    g += r.g; w += r.w; l += r.l;
    pf += r.pf * r.g; pa += r.pa * r.g; net += r.net * r.g;
  }
  const wpct = w / g;
  const teams: TeamRef[] = [];
  for (const r of sorted) if (!teams.some((t) => t.tcode === r.tcode)) teams.push(teamOf(r.tcode));
  return {
    g, w, l, wpct,
    wpctSe: Math.sqrt((wpct * (1 - wpct)) / g),
    pf: pf / g, pa: pa / g, net: net / g,
    netSe: MARGIN_SD / Math.sqrt(g),
    seasons: new Set(sorted.map((r) => r.seasonName)).size,
    first: sorted[0].seasonName,
    last: sorted[sorted.length - 1].seasonName,
    teams,
  };
}

const Z_KEYS: ZKey[] = ["tpar", "fb", "oreb", "ast", "pace", "ballcare", "efg", "ftr"];

/** 재임 시즌 z의 단순평균(결과 D definition). 3시즌 미만이면 null. SE ≈ 0.75/√n(감독 내 시즌 sd 0.67~0.86). */
export function aggregateCareerStyle(rows: CoachSeasonStyle[]): CoachCareerStyle | null {
  if (rows.length < CAREER_MIN_SEASONS) return null;
  const z = {} as Record<ZKey, number>;
  for (const k of Z_KEYS) z[k] = rows.reduce((s, r) => s + r.z[k], 0) / rows.length;
  return { n: rows.length, z, se: 0.75 / Math.sqrt(rows.length) };
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------
async function fetchCurrentTeams(): Promise<Map<number, { tcode: string; confirmed: boolean }>> {
  const { data } = await supabase.from("team_coach_season").select("coach_id, tcode, confirmed").eq("season_name", PRESEASON_SEASON);
  return new Map((data ?? []).map((r) => [n(r.coach_id), { tcode: r.tcode as string, confirmed: !!r.confirmed }]));
}

export function getCoachList(): Promise<CoachListRow[]> {
  return cached(computeCoachList, ["coachList-v2", PRESEASON_SEASON], TTL.batchDaily, [TAG.build]);
}

async function computeCoachList(): Promise<CoachListRow[]> {
  const [{ data: coaches }, { data: records }, current, teams] = await Promise.all([
    supabase.from("coaches").select("coach_id, name"),
    supabase.from("coach_season_record").select("*"), // 150행(감독-시즌) - 1,000행 캡 아래
    fetchCurrentTeams(),
    getAllTeams(),
  ]);
  const byCoach = new Map<number, CoachSeasonRecord[]>();
  for (const r of (records ?? []) as Record<string, unknown>[]) {
    const id = n(r.coach_id);
    byCoach.set(id, [...(byCoach.get(id) ?? []), toRecord(r)]);
  }
  const teamOf = (t: string) => teamRef(teams, t);
  return (coaches ?? []).map((c) => {
    const id = n(c.coach_id);
    const cur = current.get(id);
    return {
      coachId: id,
      name: c.name as string,
      career: aggregateCareer(byCoach.get(id) ?? [], teamOf),
      currentTeam: cur ? { ...teamOf(cur.tcode), name: displayTeamName(cur.tcode, teamOf(cur.tcode).name, PRESEASON_SEASON), seasonName: PRESEASON_SEASON, confirmed: cur.confirmed } : null,
    };
  });
}

export function getCoachProfile(coachId: number): Promise<CoachProfile | null> {
  // 키의 v2 = 작전타임 필드 추가(2026-09-15). Data Cache는 배포를 넘어 살아 있어서, 모양이 바뀌면 키를 올려야 옛 객체가 안 나온다.
  return cached(() => computeCoachProfile(coachId), ["coachProfile-v3", String(coachId), PRESEASON_SEASON], TTL.batchDaily, [TAG.build]);
}

async function computeCoachProfile(coachId: number): Promise<CoachProfile | null> {
  const { data: coach } = await supabase.from("coaches").select("coach_id, name").eq("coach_id", coachId).maybeSingle();
  if (!coach) return null;
  const [{ data: records }, { data: styles }, { data: usage }, { data: league }, { data: lo }, { data: hi }, { data: timeouts }, current, teams] = await Promise.all([
    supabase.from("coach_season_record").select("*").eq("coach_id", coachId),
    supabase.from("coach_season_style").select("*").eq("coach_id", coachId),
    supabase.from("coach_challenge_usage").select("*").eq("coach_id", coachId),
    supabase.from("coach_challenge_league").select("*").order("season_name", { ascending: false }).limit(1),
    supabase.from("coach_season_record").select("season_name").order("season_name", { ascending: true }).limit(1),
    supabase.from("coach_season_record").select("season_name").order("season_name", { ascending: false }).limit(1),
    // 리그 시즌 평균도 같은 표에서 만들어야 해서 전체를 읽는다 - 감독-시즌 150행(시즌당 10행씩 는다, 1,000행 캡 아래).
    supabase.from("coach_timeout_tendency").select("*"),
    fetchCurrentTeams(),
    getAllTeams(),
  ]);
  const teamOf = (t: string) => teamRef(teams, t);
  const recs = ((records ?? []) as Record<string, unknown>[]).map(toRecord).sort((a, b) => a.seasonName.localeCompare(b.seasonName));
  const styleRows = ((styles ?? []) as Record<string, unknown>[]).map(toStyle);
  const chRows = ((usage ?? []) as Record<string, unknown>[]).map(toChallenge);
  const toRows = ((timeouts ?? []) as Record<string, unknown>[]).map(toTimeout);
  const mineTo = toRows.filter((t) => t.coachId === coachId);
  const leagueTo = (season: string) => poolTimeouts(toRows.filter((t) => t.seasonName === season));
  const seasons: CoachSeasonRow[] = recs.map((record) => {
    const team = teamOf(record.tcode);
    const to = mineTo.find((t) => t.seasonName === record.seasonName && t.tcode === record.tcode);
    const toLeague = to ? leagueTo(to.seasonName) : null;
    return {
      seasonName: record.seasonName,
      tcode: record.tcode,
      team,
      teamName: displayTeamName(record.tcode, team.name, record.seasonName),
      record,
      style: styleRows.find((s) => s.seasonName === record.seasonName && s.tcode === record.tcode) ?? null,
      challenge: chRows.find((c) => c.seasonName === record.seasonName && c.tcode === record.tcode) ?? null,
      timeout:
        to && toLeague
          ? { seasonName: to.seasonName, tcode: to.tcode, games: to.games, timeouts: to.timeouts, perGame: to.perGame, oppRunMean: to.oppRunMean, q4Share: to.q4Share, league: toLeague }
          : null,
    };
  });
  const careerTo = poolTimeouts(mineTo);
  const cur = current.get(coachId);
  const lg = (league ?? [])[0] as Record<string, unknown> | undefined;
  return {
    coach: { coachId, name: coach.name as string },
    seasons,
    career: aggregateCareer(recs, teamOf),
    careerStyle: aggregateCareerStyle(styleRows),
    currentTeam: cur ? { ...teamOf(cur.tcode), name: displayTeamName(cur.tcode, teamOf(cur.tcode).name, PRESEASON_SEASON), seasonName: PRESEASON_SEASON, confirmed: cur.confirmed } : null,
    challengeLeague: lg ? toLeague(lg) : null,
    timeoutCareer: careerTo ? { ...careerTo, seasons: new Set(mineTo.map((t) => t.seasonName)).size } : null,
    dataRange: { first: (lo?.[0]?.season_name as string | undefined) ?? "", last: (hi?.[0]?.season_name as string | undefined) ?? "" },
  };
}

/**
 * 팀 페이지가 "이 시즌 감독 → 프로필" 링크를 달 때 쓴다(다음 단계). 치른 시즌은 coach_season_record,
 * 아직 stats가 없는 시즌(26-27)은 team_coach_season. 둘 다 없으면 null.
 */
export function getTeamCoachLink(tcode: string, seasonName: string): Promise<{ coachId: number; name: string; href: string } | null> {
  return cached(
    async () => {
      const { data: rec } = await supabase.from("coach_season_record").select("coach_id").eq("tcode", tcode).eq("season_name", seasonName).limit(1);
      let coachId = rec?.[0] ? n(rec[0].coach_id) : null;
      if (coachId == null) {
        const { data: tcs } = await supabase.from("team_coach_season").select("coach_id").eq("tcode", tcode).eq("season_name", seasonName).limit(1);
        coachId = tcs?.[0] ? n(tcs[0].coach_id) : null;
      }
      if (coachId == null) return null;
      const { data: c } = await supabase.from("coaches").select("name").eq("coach_id", coachId).maybeSingle();
      return c ? { coachId, name: c.name as string, href: `/coaches/${coachId}` } : null;
    },
    ["teamCoachLink", tcode, seasonName],
    TTL.batchDaily,
    [TAG.build, TAG.season(seasonName)]
  );
}

// ---------------------------------------------------------------------------
// 표기
// ---------------------------------------------------------------------------
/** .667 꼴(앞 0 없이 3자리). */
export const fmtPct3 = (p: number) => p.toFixed(3).replace(/^0/, "");
export const seasonLabel = shortSeason;
// 부호 포맷은 lib/format.ts signed/signTone 하나만 쓴다 - 여기 자체 구현이 있던 동안
// net=-0.037이 빨간 "−0.0"으로, +0.0185가 초록 "+0.0"으로 찍혔다(표시값과 부호가 어긋남).

// ---------------------------------------------------------------------------
// 레이더(raw SVG 문자열 - lib/seasonRibbon.ts 규약: 페이지가 <svg dangerouslySetInnerHTML>, 클라이언트 JS 0)
// ---------------------------------------------------------------------------
export type RadarAxis = { key: RadarKey; raw: RawKey; label: string; short: string; unit: string; se: number; note: string | null };

/** 시계 방향 6축(결과 D displayRecommendation 2). se = 시즌 z 표준오차(같은 문서 5). */
export const RADAR_AXES: RadarAxis[] = [
  { key: "tpar", raw: "tpar", label: "3점 시도 비중", short: "3PAr", unit: "%", se: 0.3, note: null },
  { key: "fb", raw: "fb", label: "속공(경기당)", short: "속공", unit: "회", se: 0.45, note: "기록 관행이 시즌마다 달라 원값의 시즌 간 비교는 하지 말 것" },
  { key: "oreb", raw: "oreb", label: "공격 리바운드율", short: "OREB%", unit: "%", se: 0.45, note: null },
  { key: "ast", raw: "ast", label: "어시스트율", short: "AST%", unit: "%", se: 0.45, note: null },
  { key: "pace", raw: "pace", label: "페이스", short: "페이스", unit: "", se: 0.5, note: "양 팀 동일값(절반은 상대 몫)이지만 감독 교체에 반응한 유일한 축" },
  { key: "ballcare", raw: "tov", label: "볼 관리(−TOV%)", short: "볼관리", unit: "%", se: 0.55, note: "TOV%를 부호 반전 - 낮을수록 바깥" },
];

export const RADAR_VIEWBOX = { w: 320, h: 300 };
const CX = 160, CY = 150, R = 92, LABEL_R = R + 20;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const clamp2 = (z: number) => Math.max(-2, Math.min(2, z));
function pt(i: number, z: number): [number, number] {
  const a = -Math.PI / 2 + (i * Math.PI) / 3;
  const r = (R * (clamp2(z) + 2)) / 4;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}
const poly = (zs: number[]) => zs.map((z, i) => pt(i, z).map((v) => v.toFixed(1)).join(",")).join(" ");

export type RadarInput = {
  season: CoachSeasonStyle;
  seasonLabel: string;
  /** 3시즌 이상일 때만 옅게 오버레이. */
  career: CoachCareerStyle | null;
};

/**
 * 6축 레이더. 축 범위 −2~+2 클립, 중심 = −2, 회색 기준 육각형 = 리그 평균(0), 바깥 테두리 = +2.
 * |z| < 시즌 SE인 축은 꼭짓점·라벨을 회색으로(리그 평균 수준).
 * 글자 크기는 .radarSvg{min-width:320px;max-width:340px}에 **의존한다**: 뷰박스 320 대비 배율이
 * 1.0~1.0625로 고정되므로 13 유닛 = 13.0~13.8px(목표 12px보다 여유 1px). 12 유닛이던 동안은
 * 정확히 12.0px로 바닥에 걸쳐 있었다. min-width가 사라지면 320px 화면의 지면은 246px = 배율
 * 0.77이라 10px로 즉시 미달이니, 그때는 lib/seasonRibbon.ts처럼 SVG 안 <style> 미디어쿼리로
 * 구간별 font-size를 갈아끼워야 한다(크기를 되돌리지 말 것).
 * 축 라벨은 한글이 섞여(속공·페이스·볼관리) Pretendard, z 값(숫자)만 IBM Plex Mono - 라벨 전부를
 * Plex Mono로 두면 한글 셋만 이름 없는 시스템 폴백으로 떨어져 한 육각형 위에서 얼굴이 갈렸다.
 */
export function buildCoachRadarSvg({ season, seasonLabel, career }: RadarInput): string {
  const parts: string[] = [];
  const line = (a: number) => `rgba(var(--line-rgb),${a})`;
  // 눈금 육각형: −1·+1·+2 점선, 0 = 리그 평균 실선
  for (const z of [-1, 1, 2]) parts.push(`<polygon points="${poly([z, z, z, z, z, z])}" fill="none" stroke="${line(0.16)}" stroke-width="0.8" stroke-dasharray="3 3"/>`);
  parts.push(`<polygon points="${poly([0, 0, 0, 0, 0, 0])}" fill="${line(0.05)}" stroke="${line(0.5)}" stroke-width="1.3"/>`);
  for (let i = 0; i < 6; i++) {
    const [x, y] = pt(i, 2);
    parts.push(`<line x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${line(0.16)}" stroke-width="0.8"/>`);
  }
  // 통산 오버레이(옅게)
  if (career) {
    parts.push(
      `<polygon points="${poly(RADAR_AXES.map((a) => career.z[a.key]))}" fill="${line(0.1)}" stroke="${line(0.55)}" stroke-width="1.2" stroke-dasharray="4 3"><title>${esc(
        `통산 ${career.n}시즌 z 평균(SE ±${career.se.toFixed(2)})`
      )}</title></polygon>`
    );
  }
  // 이번 시즌
  parts.push(`<polygon points="${poly(RADAR_AXES.map((a) => season.z[a.key]))}" fill="var(--gold)" fill-opacity="0.2" stroke="var(--gold)" stroke-width="2"/>`);
  // 축 꼭짓점 + 라벨(+툴팁)
  RADAR_AXES.forEach((a, i) => {
    const z = season.z[a.key];
    const sig = Math.abs(z) >= a.se;
    const [vx, vy] = pt(i, z);
    const ang = -Math.PI / 2 + (i * Math.PI) / 3;
    const lx = CX + LABEL_R * Math.cos(ang), ly = CY + LABEL_R * Math.sin(ang);
    const anchor = i === 0 || i === 3 ? "middle" : i < 3 ? "start" : "end";
    const dy = i === 0 ? -8 : i === 3 ? 12 : 0;
    const ink = sig ? "var(--ink)" : line(0.45);
    const dot = sig ? "var(--gold)" : "var(--ink-faint)";
    const raw = season.raw[a.raw], lg = season.lg[a.raw];
    const title =
      `${a.label} · ${seasonLabel} z ${signed(z, 2)}${sig ? "" : ` (|z| < SE ${a.se} - 리그 평균 수준)`}` +
      ` · 원값 ${raw.toFixed(1)}${a.unit} · 리그 평균 ${lg.toFixed(1)}${a.unit}` +
      (career ? ` · 통산 ${career.n}시즌 z ${signed(career.z[a.key], 2)}` : "") +
      (a.note ? ` · ${a.note}` : "");
    parts.push(
      `<g><title>${esc(title)}</title>` +
        `<circle cx="${vx.toFixed(1)}" cy="${vy.toFixed(1)}" r="3.6" fill="${dot}" stroke="var(--surface)" stroke-width="1"/>` +
        `<text x="${lx.toFixed(1)}" y="${(ly + dy).toFixed(1)}" text-anchor="${anchor}" font-size="13" font-weight="700" fill="${ink}" font-family="Pretendard, sans-serif">` +
        `<tspan>${esc(a.short)}</tspan><tspan x="${lx.toFixed(1)}" dy="14" font-size="13" font-weight="600" fill="${sig ? "var(--gold)" : line(0.45)}" font-family="IBM Plex Mono, monospace">${esc(signed(z, 1))}</tspan></text>` +
        `<rect x="${(vx - 9).toFixed(1)}" y="${(vy - 9).toFixed(1)}" width="18" height="18" fill="transparent"/></g>`
    );
  });
  return parts.join("");
}
