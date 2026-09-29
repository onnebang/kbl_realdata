import { supabaseServer as supabase } from "./supabaseServer";
import { TAG, TTL, cachedFn } from "./cachePolicy";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { getTeams, shortSeason, type TeamInfo } from "./preseason";

// 팀 프로필 "팀 전체 기록 + 리그 순위"와 "팀 리더" 데이터 레이어 - 요청:
// "팀 자세히보기에서 4쿼터 기록뿐만 아니라, 팀 전체 기록도 순위를 볼 수 있게 / 팀 리더 추가".
//
// 기존 4팩터 패널(lib/teamDataScience.ts getTeamFourFactors)은 RPC team_season_four_factors가
// 미리 구워둔 8개 축만 보여준다. 여기서는 같은 표본(정규시즌 game_team_stats)을 그대로 쓰되
// 24개 지표를 전부 리그 순위와 함께 낸다. RPC를 새로 못 만드는 범위라(DB 스키마 불변) 집계는
// PostgREST로 원본 행을 받아 JS에서 한다 - 한 시즌 정규시즌은 팀 행 540개뿐이라 부담이 없다.
//
// 검증(2026-09-04, SQL 직접 대조): 2025-2026 정규시즌 창원 LG(50) - 득점 77.1(7위),
// 실점 71.8(1위), 득실차 +5.3(1위), ORtg 105.4(6위), DRtg 98.7(2위), NET +6.7(1위),
// eFG 50.6%(5위), OREB% 31.7, TOV% 15.5, 3P% 34.8%. 아래 산식이 그 값을 그대로 낸다.

/** 이 파일의 모든 팀 집계 표본 - 4팩터 RPC와 같은 기준(정규시즌만)이라 두 패널의 순위가 어긋나지 않는다. */
export const SEASON_CATEGORY_REGULAR = "정규시즌";

/**
 * 2026-27시즌 신설 프리시즌 이벤트(games.season_category='OPEN MATCH DAY', 10경기, 2026-09-24~27).
 * season_name은 정규시즌과 같은 '2026-2027'을 공유하므로, getSeasonGames({category: null})로 순수
 * "이 시즌 경기" 필터를 안 거는 호출부는 이걸 걷어내야 한다(2026-10-03 개막 전까진 이 10경기가
 * "2026-27 시즌"인 척한다). 경기 자체를 보여주는 화면(일정 목록)은 이 상수를 안 쓴다.
 */
const OPEN_MATCH_CATEGORY = "OPEN MATCH DAY";

/**
 * gmkey IN 목록 한 덩어리 크기. game_player_stats/game_team_stats에는 시즌 컬럼이 없어서
 * games에서 뽑은 gmkey로 좁히는데, 한 시즌 283경기를 한 번에 IN으로 넣으면 URL이 3KB를
 * 넘어간다(PostgREST GET). 120개씩 끊어서 여러 번 부른다.
 */
export const GMKEY_CHUNK = 120;

/** 공용 청크 헬퍼 - lib/seasonLeaders.ts, lib/wowy.ts도 같은 gmkey 청크 전략을 쓴다. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** numeric 컬럼(min_played 등)이 문자열로 오는 경우가 있어 전부 이 헬퍼로 숫자화한다. */
export function num(v: unknown): number {
  if (v == null) return 0;
  return typeof v === "string" ? Number(v) || 0 : (v as number);
}

export type SeasonGameRow = {
  gmkey: string;
  seasonCategory: string;
  gameDate: string;
  homeTcode: string;
  awayTcode: string;
  homeScore: number | null;
  awayScore: number | null;
};

/**
 * 한 시즌의 경기 목록(= 다른 테이블을 좁히는 gmkey 원천).
 * opts.category 를 넘기면 그 season_category만(기본 정규시즌), null이면 "정규+PO"(현재 호출부
 * 전부가 원하는 뜻 - WOWY/조합 표본은 라인업 로그가 귀해 PO는 안 버리지만, 오픈매치(전시경기)는
 * 애초에 그 표본의 정의 밖이다). 오픈매치까지 포함해 문자 그대로 "전 카테고리"가 필요한 호출부는
 * 아직 없다 - 생기면 별도 옵션으로 추가할 것.
 * 끝난 경기만 - 예정 경기는 스탯 행이 없고 라이브 드라이런 합성 경기가 섞일 수 있다.
 */
export async function getSeasonGames(
  seasonName: string,
  opts?: { category?: string | null }
): Promise<SeasonGameRow[]> {
  const category = opts && "category" in opts ? opts.category : SEASON_CATEGORY_REGULAR;
  const rows = await fetchAllPagesBounded<{
    gmkey: string;
    season_category: string;
    game_date: string;
    home_tcode: string;
    away_tcode: string;
    home_score: number | null;
    away_score: number | null;
  }>((from, to) => {
    let q = supabase
      .from("games")
      .select("gmkey, season_category, game_date, home_tcode, away_tcode, home_score, away_score", { count: "exact" })
      .eq("season_name", seasonName)
      .eq("is_ended", true);
    if (category) q = q.eq("season_category", category);
    else q = q.neq("season_category", OPEN_MATCH_CATEGORY);
    return q.range(from, to);
  });
  return rows.map((r) => ({
    gmkey: r.gmkey,
    seasonCategory: r.season_category,
    gameDate: r.game_date,
    homeTcode: r.home_tcode,
    awayTcode: r.away_tcode,
    homeScore: r.home_score,
    awayScore: r.away_score,
  }));
}

// ---------------------------------------------------------------------------
// A. 팀 전체 기록 + 리그 순위
// ---------------------------------------------------------------------------

export type TeamStatKey =
  | "pts" | "oppPts" | "diff" | "ortg" | "drtg" | "net" | "pace"
  | "efg" | "ts" | "twoPct" | "tpaPg" | "tpPct" | "ftPct" | "ftr"
  | "reb" | "orebPct" | "drebPct"
  | "ast" | "astPct" | "tov" | "tovPct"
  | "stl" | "blk" | "fouls";

export type TeamStatGroup = "종합" | "슈팅" | "리바운드" | "소유" | "수비";

export const TEAM_STAT_GROUPS: TeamStatGroup[] = ["종합", "슈팅", "리바운드", "소유", "수비"];

/** 지표 하나의 정적 정의(값이 없어도 UI가 표 헤더를 그릴 수 있게 따로 export). */
export type TeamStatDef = {
  key: TeamStatKey;
  label: string;
  group: TeamStatGroup;
  /** 낮을수록 좋은 지표(실점/DRtg/TOV%/턴오버/파울) - 순위·좋고나쁨 판정을 여기서 뒤집는다. */
  lowerIsBetter: boolean;
  /** 방향 자체가 없는 스타일 지표(페이스, 3점 시도) - 순위는 내림차순으로 매기되 좋고나쁨 색을 쓰지 말 것. */
  neutral: boolean;
  /** 산식/함정 주석. 데이터 정직성 - UI는 이걸 툴팁이나 캡션에 그대로 쓴다. */
  note: string | null;
};

/**
 * 표시 자릿수에서 0으로 접히는 값은 부호를 떼기 위해 진짜 0으로 스냅한다.
 * 이유: NetRtg·득실차의 리그 평균은 수학적으로 정확히 0이다(한 경기에서 한 팀의 마진은 상대 팀
 * 마진의 음수이고 팀당 경기 수도 같다). 그런데 경기별 값을 팀별로 평균한 뒤 다시 평균하는 과정에서
 * 부동소수 오차가 -0.004처럼 남고, toFixed(1)이 그걸 "-0.0"으로 찍는다. 0을 기준선으로 읽는
 * 지표에서 부호 붙은 0은 "리그 평균이 근소하게 마이너스"라는 없는 사실을 암시한다.
 * 표시 전용 - 순위·바 길이·better 판정은 전부 원값(value)으로 하므로 영향이 없다.
 */
const snapZero = (v: number, digits: number) => (Math.abs(v) < 0.5 / 10 ** digits ? 0 : v);

const F1 = (v: number) => snapZero(v, 1).toFixed(1);
const FPCT = (v: number) => `${snapZero(v, 1).toFixed(1)}%`;
const F3 = (v: number) => snapZero(v, 3).toFixed(3);
/** 부호를 붙이는 지표(득실차·NetRtg) 전용. 0은 "+0.0"이 아니라 "0.0"으로 - 기준선 그 자체다. */
const FSIGN1 = (v: number) => {
  const s = snapZero(v, 1);
  return s > 0 ? `+${s.toFixed(1)}` : s.toFixed(1);
};

type Formatter = (v: number) => string;

// dfmt = "리그 평균과의 차이" 전용 포맷터. 득실차/NetRtg처럼 fmt가 이미 부호를 붙이는 지표는
// 차이 표기에서 "++2.0"이 되어버려서 부호 없는 포맷을 따로 둔다(없으면 fmt를 그대로 쓴다).
const DEFS: (TeamStatDef & { fmt: Formatter; dfmt?: Formatter })[] = [
  { key: "pts", label: "득점", group: "종합", lowerIsBetter: false, neutral: false, note: null, fmt: F1 },
  { key: "oppPts", label: "실점", group: "종합", lowerIsBetter: true, neutral: false, note: "같은 경기 상대 팀 행의 득점", fmt: F1 },
  { key: "diff", label: "득실차", group: "종합", lowerIsBetter: false, neutral: false, note: null, fmt: FSIGN1, dfmt: F1 },
  { key: "ortg", label: "ORtg", group: "종합", lowerIsBetter: false, neutral: false, note: "경기별 off_rtg의 단순 평균(100포제션당 득점)", fmt: F1 },
  { key: "drtg", label: "DRtg", group: "종합", lowerIsBetter: true, neutral: false, note: "경기별 def_rtg의 단순 평균(100포제션당 실점)", fmt: F1 },
  { key: "net", label: "NetRtg", group: "종합", lowerIsBetter: false, neutral: false, note: "경기별 net_rtg의 단순 평균", fmt: FSIGN1, dfmt: F1 },
  { key: "pace", label: "페이스", group: "종합", lowerIsBetter: false, neutral: true, note: "48분 환산 포제션 - 빠름/느림은 스타일이지 우열이 아니다", fmt: F1 },

  { key: "efg", label: "eFG%", group: "슈팅", lowerIsBetter: false, neutral: false, note: "(2점 성공 + 1.5×3점 성공) / (2점 시도 + 3점 시도)", fmt: FPCT },
  { key: "ts", label: "TS%", group: "슈팅", lowerIsBetter: false, neutral: false, note: "득점 / (2 × (2점 시도 + 3점 시도 + 0.44×자유투 시도))", fmt: FPCT },
  { key: "twoPct", label: "2P%", group: "슈팅", lowerIsBetter: false, neutral: false, note: "이 DB의 fgm/fga는 2점 전용(3점은 tpm/tpa) - 총 야투는 fga+tpa", fmt: FPCT },
  { key: "tpaPg", label: "3P 시도", group: "슈팅", lowerIsBetter: false, neutral: true, note: "경기당 3점 시도 - 많고 적음은 스타일", fmt: F1 },
  { key: "tpPct", label: "3P%", group: "슈팅", lowerIsBetter: false, neutral: false, note: "tpm / tpa(시즌 합계 기준)", fmt: FPCT },
  { key: "ftPct", label: "FT%", group: "슈팅", lowerIsBetter: false, neutral: false, note: "ftm / fta(시즌 합계 기준)", fmt: FPCT },
  { key: "ftr", label: "자유투 유도율", group: "슈팅", lowerIsBetter: false, neutral: false, note: "자유투 시도 / 야투 시도(2점+3점) = FTr, 4팩터의 네 번째 축", fmt: F3 },

  { key: "reb", label: "리바운드", group: "리바운드", lowerIsBetter: false, neutral: false, note: "game_team_stats.reb(총 리바운드) - 같은 표의 oreb/dreb는 전 행 NULL이라 못 쓴다", fmt: F1 },
  { key: "orebPct", label: "OREB%", group: "리바운드", lowerIsBetter: false, neutral: false, note: "oreb/dreb 원값이 NULL이라 경기별 oreb_pct의 평균(4팩터 RPC와 같은 방식)", fmt: FPCT },
  { key: "drebPct", label: "DREB%", group: "리바운드", lowerIsBetter: false, neutral: false, note: "경기별 dreb_pct의 평균", fmt: FPCT },

  { key: "ast", label: "어시스트", group: "소유", lowerIsBetter: false, neutral: false, note: null, fmt: F1 },
  { key: "astPct", label: "AST%", group: "소유", lowerIsBetter: false, neutral: false, note: "어시스트 / 야투 성공(fgm+tpm) - 도움받은 득점 비율", fmt: FPCT },
  { key: "tov", label: "턴오버", group: "소유", lowerIsBetter: true, neutral: false, note: null, fmt: F1 },
  { key: "tovPct", label: "TOV%", group: "소유", lowerIsBetter: true, neutral: false, note: "턴오버 / 포제션(poss). game_team_stats.tov_pct 컬럼은 분모가 달라(슛+0.44FT+TO) 값이 다르다 - 여기선 4팩터 RPC와 같은 분모를 쓴다", fmt: FPCT },

  { key: "stl", label: "스틸", group: "수비", lowerIsBetter: false, neutral: false, note: null, fmt: F1 },
  { key: "blk", label: "블록", group: "수비", lowerIsBetter: false, neutral: false, note: null, fmt: F1 },
  { key: "fouls", label: "파울", group: "수비", lowerIsBetter: true, neutral: false, note: null, fmt: F1 },
];

/** UI가 데이터 없이도 표 헤더/그룹 탭을 그릴 수 있게 정적 정의만 따로. */
export const TEAM_STAT_DEFS: TeamStatDef[] = DEFS.map((d) => ({
  key: d.key,
  label: d.label,
  group: d.group,
  lowerIsBetter: d.lowerIsBetter,
  neutral: d.neutral,
  note: d.note,
}));

export type TeamStatCell = {
  key: TeamStatKey;
  label: string;
  group: TeamStatGroup;
  lowerIsBetter: boolean;
  neutral: boolean;
  note: string | null;
  value: number;
  display: string;
  /** 1 = 방향 보정 후 리그 최고. 동률은 같은 순위(자기보다 확실히 나은 팀 수 + 1). */
  rank: number;
  teamsN: number;
  /** "10팀 중 2위" */
  rankLabel: string;
  leagueAvg: number;
  leagueAvgDisplay: string;
  /** 원값 - 리그 평균(부호는 지표 원래 방향 그대로. 실점 -3.2는 "3.2점 덜 준다"는 뜻). */
  vsLeague: number;
  vsLeagueDisplay: string;
  /** 방향 보정 후 리그 평균보다 좋은가. neutral 지표는 항상 null. */
  better: boolean | null;
  /** 바 길이용 0~100 ((N-rank)/(N-1)×100) - 4팩터 패널 pctFill과 같은 규칙. */
  pctFill: number;
};

export type TeamSeasonStatRow = {
  tcode: string;
  name: string;
  abbr: string;
  color: string;
  logoUrl: string | null;
  gp: number;
  wins: number;
  losses: number;
  winPct: number;
  cells: TeamStatCell[];
  cellByKey: Record<TeamStatKey, TeamStatCell>;
};

export type TeamSeasonStats = {
  seasonName: string;
  seasonCategory: string;
  teamsN: number;
  gpPerTeam: number;
  /** NetRtg 내림차순. UI가 다른 정렬을 원하면 rows를 직접 정렬하면 된다. */
  rows: TeamSeasonStatRow[];
  byTcode: Record<string, TeamSeasonStatRow>;
  defs: TeamStatDef[];
  leagueAvgByKey: Record<TeamStatKey, number>;
  caption: string;
};

type Agg = {
  tcode: string;
  gp: number;
  wins: number;
  losses: number;
  score: number;
  opp: number;
  fgm: number; fga: number; tpm: number; tpa: number; ftm: number; fta: number;
  reb: number; ast: number; stl: number; blk: number; tov: number; fouls: number;
  poss: number;
  offSum: number; defSum: number; netSum: number; paceSum: number;
  orebPctSum: number; drebPctSum: number;
};

type TeamStatRawRow = {
  gmkey: string;
  tcode: string;
  score: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  turnovers: number | null;
  fouls: number | null;
  fgm: number | null; fga: number | null; tpm: number | null; tpa: number | null;
  ftm: number | null; fta: number | null;
  off_rtg: number | null; def_rtg: number | null; net_rtg: number | null;
  pace: number | null; poss: number | null;
  oreb_pct: number | null; dreb_pct: number | null;
};

const TEAM_STAT_SELECT =
  "gmkey, tcode, score, reb, ast, stl, blk, turnovers, fouls, fgm, fga, tpm, tpa, ftm, fta, off_rtg, def_rtg, net_rtg, pace, poss, oreb_pct, dreb_pct";

async function fetchTeamStatRows(gmkeys: string[]): Promise<TeamStatRawRow[]> {
  const out: TeamStatRawRow[] = [];
  for (const part of chunk(gmkeys, GMKEY_CHUNK)) {
    const rows = await fetchAllPagesBounded<TeamStatRawRow>((from, to) =>
      supabase.from("game_team_stats").select(TEAM_STAT_SELECT, { count: "exact" }).in("gmkey", part).range(from, to)
    );
    out.push(...rows);
  }
  return out;
}

function emptyAgg(tcode: string): Agg {
  return {
    tcode, gp: 0, wins: 0, losses: 0, score: 0, opp: 0,
    fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
    reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fouls: 0, poss: 0,
    offSum: 0, defSum: 0, netSum: 0, paceSum: 0, orebPctSum: 0, drebPctSum: 0,
  };
}

/** 지표 하나를 팀 집계에서 뽑는 함수(값이 없으면 null - 분모 0 방어). */
const VALUE_OF: Record<TeamStatKey, (a: Agg) => number | null> = {
  pts: (a) => (a.gp ? a.score / a.gp : null),
  oppPts: (a) => (a.gp ? a.opp / a.gp : null),
  diff: (a) => (a.gp ? (a.score - a.opp) / a.gp : null),
  ortg: (a) => (a.gp ? a.offSum / a.gp : null),
  drtg: (a) => (a.gp ? a.defSum / a.gp : null),
  net: (a) => (a.gp ? a.netSum / a.gp : null),
  pace: (a) => (a.gp ? a.paceSum / a.gp : null),
  efg: (a) => (a.fga + a.tpa ? ((a.fgm + 1.5 * a.tpm) / (a.fga + a.tpa)) * 100 : null),
  ts: (a) => {
    const d = a.fga + a.tpa + 0.44 * a.fta;
    return d ? (a.score / (2 * d)) * 100 : null;
  },
  twoPct: (a) => (a.fga ? (a.fgm / a.fga) * 100 : null),
  tpaPg: (a) => (a.gp ? a.tpa / a.gp : null),
  tpPct: (a) => (a.tpa ? (a.tpm / a.tpa) * 100 : null),
  ftPct: (a) => (a.fta ? (a.ftm / a.fta) * 100 : null),
  ftr: (a) => (a.fga + a.tpa ? a.fta / (a.fga + a.tpa) : null),
  reb: (a) => (a.gp ? a.reb / a.gp : null),
  orebPct: (a) => (a.gp ? a.orebPctSum / a.gp : null),
  drebPct: (a) => (a.gp ? a.drebPctSum / a.gp : null),
  ast: (a) => (a.gp ? a.ast / a.gp : null),
  astPct: (a) => (a.fgm + a.tpm ? (a.ast / (a.fgm + a.tpm)) * 100 : null),
  tov: (a) => (a.gp ? a.tov / a.gp : null),
  tovPct: (a) => (a.poss ? (a.tov / a.poss) * 100 : null),
  stl: (a) => (a.gp ? a.stl / a.gp : null),
  blk: (a) => (a.gp ? a.blk / a.gp : null),
  fouls: (a) => (a.gp ? a.fouls / a.gp : null),
};

/**
 * 시즌 전체 팀 기록 표(지표마다 리그 순위 + 리그 평균).
 * 표본: games.season_category = '정규시즌' & is_ended, game_team_stats 원본 행.
 * 경기가 하나도 없는 시즌(개막 전 2026-2027 등)은 null - 호출부가 정직하게 폴백할 것.
 */
/** 시즌 팀 기록 - 경기가 끝날 때만 바뀐다. /teams와 팀 상세가 같이 쓴다. */
export const getTeamSeasonStats = cachedFn(computeTeamSeasonStats, {
  name: "teamSeasonStats",
  ttl: TTL.batchDaily,
  tags: (seasonName) => [TAG.batch, TAG.season(seasonName)],
});

async function computeTeamSeasonStats(seasonName: string): Promise<TeamSeasonStats | null> {
  const games = await getSeasonGames(seasonName, { category: SEASON_CATEGORY_REGULAR });
  if (!games.length) return null;

  const rows = await fetchTeamStatRows(games.map((g) => g.gmkey));
  if (!rows.length) return null;

  // 같은 경기의 상대 행(실점·상대 팩터용). 한 경기에 팀 행은 정확히 2개.
  const byGame = new Map<string, TeamStatRawRow[]>();
  for (const r of rows) {
    const list = byGame.get(r.gmkey);
    if (list) list.push(r);
    else byGame.set(r.gmkey, [r]);
  }

  const aggs = new Map<string, Agg>();
  for (const r of rows) {
    const pair = byGame.get(r.gmkey) ?? [];
    const opp = pair.find((x) => x.tcode !== r.tcode);
    if (!opp) continue; // 상대 행이 없는 반쪽 경기는 실점/득실차가 성립하지 않으므로 통째로 제외
    const a = aggs.get(r.tcode) ?? emptyAgg(r.tcode);
    a.gp += 1;
    const my = num(r.score);
    const th = num(opp.score);
    if (my > th) a.wins += 1;
    else if (my < th) a.losses += 1;
    a.score += my;
    a.opp += th;
    a.fgm += num(r.fgm); a.fga += num(r.fga); a.tpm += num(r.tpm); a.tpa += num(r.tpa);
    a.ftm += num(r.ftm); a.fta += num(r.fta);
    a.reb += num(r.reb); a.ast += num(r.ast); a.stl += num(r.stl); a.blk += num(r.blk);
    a.tov += num(r.turnovers); a.fouls += num(r.fouls); a.poss += num(r.poss);
    a.offSum += num(r.off_rtg); a.defSum += num(r.def_rtg); a.netSum += num(r.net_rtg);
    a.paceSum += num(r.pace);
    a.orebPctSum += num(r.oreb_pct); a.drebPctSum += num(r.dreb_pct);
    aggs.set(r.tcode, a);
  }

  const list = [...aggs.values()];
  if (!list.length) return null;
  const teamsN = list.length;
  const teams = await getTeams(seasonName);

  // 지표별 값 테이블을 먼저 만들고(팀 → 값) 그 위에서 순위/평균을 계산한다.
  const valuesByKey = new Map<TeamStatKey, Map<string, number>>();
  const leagueAvgByKey = {} as Record<TeamStatKey, number>;
  for (const def of DEFS) {
    const m = new Map<string, number>();
    for (const a of list) {
      const v = VALUE_OF[def.key](a);
      if (v != null && Number.isFinite(v)) m.set(a.tcode, v);
    }
    valuesByKey.set(def.key, m);
    const vals = [...m.values()];
    leagueAvgByKey[def.key] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  }

  const rowsOut: TeamSeasonStatRow[] = list.map((a) => {
    const info: TeamInfo | undefined = teams.get(a.tcode);
    const cells: TeamStatCell[] = [];
    for (const def of DEFS) {
      const m = valuesByKey.get(def.key)!;
      const v = m.get(a.tcode);
      if (v == null) continue; // 값이 없는 지표는 셀 자체를 만들지 않는다(0으로 위장 금지)
      const others = [...m.values()];
      const better = others.filter((o) => (def.lowerIsBetter ? o < v : o > v)).length;
      const rank = better + 1;
      const n = others.length;
      const avg = leagueAvgByKey[def.key];
      const vs = v - avg;
      // 차이의 절댓값을 먼저 포맷하고 부호를 앞에 붙인다. 다만 표시 자릿수에서 0으로 접히면
      // ("0.0", "0.0%", "0.000") 부호를 붙이지 않는다 - 위 snapZero와 같은 이유로 "-0.0"을 막는다.
      const vsMag = (def.dfmt ?? def.fmt)(Math.abs(vs));
      const vsIsZero = !/[1-9]/.test(vsMag);
      cells.push({
        key: def.key,
        label: def.label,
        group: def.group,
        lowerIsBetter: def.lowerIsBetter,
        neutral: def.neutral,
        note: def.note,
        value: v,
        display: def.fmt(v),
        rank,
        teamsN: n,
        rankLabel: `${n}팀 중 ${rank}위`,
        leagueAvg: avg,
        leagueAvgDisplay: def.fmt(avg),
        vsLeague: vs,
        vsLeagueDisplay: vsIsZero ? vsMag : `${vs >= 0 ? "+" : "-"}${vsMag}`,
        better: def.neutral ? null : def.lowerIsBetter ? vs < 0 : vs > 0,
        pctFill: n > 1 ? Math.round(((n - rank) / (n - 1)) * 100) : 100,
      });
    }
    const cellByKey = Object.fromEntries(cells.map((c) => [c.key, c])) as Record<TeamStatKey, TeamStatCell>;
    return {
      tcode: a.tcode,
      name: info?.name ?? a.tcode,
      abbr: info?.abbr ?? a.tcode,
      color: info?.color ?? "#888888",
      logoUrl: info?.logoUrl ?? null,
      gp: a.gp,
      wins: a.wins,
      losses: a.losses,
      winPct: a.gp ? a.wins / a.gp : 0,
      cells,
      cellByKey,
    };
  });

  rowsOut.sort((x, y) => (y.cellByKey.net?.value ?? 0) - (x.cellByKey.net?.value ?? 0));
  const gpPerTeam = Math.round(rowsOut.reduce((s, r) => s + r.gp, 0) / rowsOut.length);

  return {
    seasonName,
    seasonCategory: SEASON_CATEGORY_REGULAR,
    teamsN,
    gpPerTeam,
    rows: rowsOut,
    byTcode: Object.fromEntries(rowsOut.map((r) => [r.tcode, r])),
    defs: TEAM_STAT_DEFS,
    leagueAvgByKey,
    caption:
      `${shortSeason(seasonName)} 정규시즌 ${teamsN}팀 · 팀당 ${gpPerTeam}경기 · ` +
      `순위는 같은 시즌 ${teamsN}팀 안에서(동률은 같은 순위) · 실점/DRtg/TOV%/턴오버/파울은 낮을수록 1위 · ` +
      `페이스와 3점 시도는 방향 없는 스타일 지표`,
  };
}

// ---------------------------------------------------------------------------
// B. 팀 리더(득점/리바운드/어시스트/스틸/블록 5장)
// ---------------------------------------------------------------------------

/**
 * 리더 카드 자격 - "팀 경기의 30% 이상 출전"(하한 3경기). 근거가 아니라 편집 규칙이다:
 * 54경기 시즌이면 17경기. 6경기만 뛴 단기 대체 외국선수가 팀 득점 1위로 올라오는 걸 막으면서
 * 시즌 중반 부상 복귀 선수는 살린다. 개막 직후(팀 3~5경기)에는 하한 3경기가 먹는다.
 * 자격자가 한 명도 없으면(=팀 경기 3경기 미만) 자격을 풀고 전원을 후보로 삼되 caption에 적는다.
 */
export const TEAM_LEADER_MIN_GP_RATIO = 0.3;
export const TEAM_LEADER_MIN_GP_FLOOR = 3;

export type TeamLeaderKey = "pts" | "reb" | "ast" | "stl" | "blk";

export const TEAM_LEADER_DEFS: { key: TeamLeaderKey; label: string; unit: string }[] = [
  { key: "pts", label: "득점", unit: "PPG" },
  { key: "reb", label: "리바운드", unit: "RPG" },
  { key: "ast", label: "어시스트", unit: "APG" },
  { key: "stl", label: "스틸", unit: "SPG" },
  { key: "blk", label: "블록", unit: "BPG" },
];

/** game_player_stats.pos 는 FD/GD/C 세 값뿐(실측 42,086 / 41,098 / 17,737) - 화면엔 G/F/C로. */
export function normalizePos(raw: string | null | undefined): "G" | "F" | "C" | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (s.startsWith("G")) return "G";
  if (s.startsWith("F")) return "F";
  if (s.startsWith("C")) return "C";
  return null;
}

export function posLabel(pos: "G" | "F" | "C" | null): string {
  return pos === "G" ? "가드" : pos === "F" ? "포워드" : pos === "C" ? "센터" : "";
}

export type TeamLeader = {
  key: TeamLeaderKey;
  label: string;
  unit: string;
  pcode: string;
  name: string;
  backNum: string | null;
  pos: "G" | "F" | "C" | null;
  posLabel: string;
  gp: number;
  minutes: number;
  total: number;
  perGame: number;
  display: string;
  /** players.photo_url - 773명 중 31명만 존재(실측). null이면 UI가 등번호 타일로 대체할 것. */
  photoUrl: string | null;
  href: string;
  /** 같은 카테고리 팀 2위(카드 뒷면·비교용). 자격자가 1명뿐이면 null. */
  runnerUp: { pcode: string; name: string; perGame: number; display: string } | null;
};

export type TeamLeaders = {
  seasonName: string;
  seasonCategory: string;
  tcode: string;
  teamGp: number;
  minGp: number;
  qualifiedN: number;
  rosterN: number;
  leaders: TeamLeader[];
  caption: string;
};

type PlayerStatRawRow = {
  gmkey: string;
  pcode: string;
  tcode: string;
  back_num: string | null;
  pos: string | null;
  min_played: number | string | null;
  pts: number | null; reb: number | null; ast: number | null; stl: number | null; blk: number | null;
};

/**
 * 팀 리더 5장. 표본은 팀 기록표와 같은 정규시즌.
 * 출전 경기(gp)는 min_played > 0인 경기만 센다 - 엔트리에만 든 0분 행(2025-2026 정규시즌 612행,
 * 전부 득점·시도·리바운드 0)을 경기로 세면 경기당 수치의 분모가 부풀려진다.
 */
export const getTeamLeaders = cachedFn(computeTeamLeaders, {
  name: "teamLeaders",
  ttl: TTL.batchDaily,
  tags: (_tcode, seasonName) => [TAG.batch, TAG.season(seasonName)],
});

async function computeTeamLeaders(tcode: string, seasonName: string): Promise<TeamLeaders | null> {
  const games = await getSeasonGames(seasonName, { category: SEASON_CATEGORY_REGULAR });
  const teamGames = games.filter((g) => g.homeTcode === tcode || g.awayTcode === tcode);
  if (!teamGames.length) return null;

  const rows: PlayerStatRawRow[] = [];
  for (const part of chunk(teamGames.map((g) => g.gmkey), GMKEY_CHUNK)) {
    const got = await fetchAllPagesBounded<PlayerStatRawRow>((from, to) =>
      supabase
        .from("game_player_stats")
        .select("gmkey, pcode, tcode, back_num, pos, min_played, pts, reb, ast, stl, blk", { count: "exact" })
        .eq("tcode", tcode)
        .in("gmkey", part)
        .range(from, to)
    );
    rows.push(...got);
  }
  if (!rows.length) return null;

  type Acc = {
    pcode: string; gp: number; minutes: number; backNum: string | null; pos: string | null;
    pts: number; reb: number; ast: number; stl: number; blk: number;
  };
  const accs = new Map<string, Acc>();
  for (const r of rows) {
    const min = num(r.min_played);
    const a =
      accs.get(r.pcode) ??
      { pcode: r.pcode, gp: 0, minutes: 0, backNum: r.back_num, pos: r.pos, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 };
    if (min > 0) a.gp += 1; // 0분 행은 DNP - 경기로 세지 않는다
    a.minutes += min;
    a.pts += num(r.pts); a.reb += num(r.reb); a.ast += num(r.ast); a.stl += num(r.stl); a.blk += num(r.blk);
    if (r.back_num) a.backNum = r.back_num;
    if (r.pos) a.pos = r.pos;
    accs.set(r.pcode, a);
  }

  const teamGp = teamGames.length;
  const minGpRule = Math.max(TEAM_LEADER_MIN_GP_FLOOR, Math.ceil(teamGp * TEAM_LEADER_MIN_GP_RATIO));
  const roster = [...accs.values()].filter((a) => a.gp > 0);
  let pool = roster.filter((a) => a.gp >= minGpRule);
  let minGp = minGpRule;
  let relaxed = false;
  if (!pool.length) {
    pool = roster;
    minGp = 1;
    relaxed = true;
  }
  if (!pool.length) return null;

  const { data: pRows } = await supabase
    .from("players")
    .select("pcode, name, photo_url")
    .in("pcode", pool.map((a) => a.pcode));
  const meta = new Map((pRows ?? []).map((p) => [p.pcode as string, p as { pcode: string; name: string; photo_url: string | null }]));

  const leaders: TeamLeader[] = [];
  for (const def of TEAM_LEADER_DEFS) {
    const ranked = pool
      .map((a) => ({ a, per: a.gp ? (a[def.key] as number) / a.gp : 0 }))
      .sort((x, y) => y.per - x.per || y.a.minutes - x.a.minutes);
    const top = ranked[0];
    if (!top || top.per <= 0) continue; // 아무도 기록이 없는 카테고리는 카드를 만들지 않는다
    const second = ranked[1];
    const pos = normalizePos(top.a.pos);
    leaders.push({
      key: def.key,
      label: def.label,
      unit: def.unit,
      pcode: top.a.pcode,
      name: meta.get(top.a.pcode)?.name ?? top.a.pcode,
      backNum: top.a.backNum,
      pos,
      posLabel: posLabel(pos),
      gp: top.a.gp,
      minutes: top.a.minutes,
      total: top.a[def.key] as number,
      perGame: top.per,
      display: top.per.toFixed(1),
      photoUrl: meta.get(top.a.pcode)?.photo_url ?? null,
      href: `/players/${top.a.pcode}`,
      runnerUp: second
        ? {
            pcode: second.a.pcode,
            name: meta.get(second.a.pcode)?.name ?? second.a.pcode,
            perGame: second.per,
            display: second.per.toFixed(1),
          }
        : null,
    });
  }
  if (!leaders.length) return null;

  return {
    seasonName,
    seasonCategory: SEASON_CATEGORY_REGULAR,
    tcode,
    teamGp,
    minGp,
    qualifiedN: pool.length,
    rosterN: roster.length,
    leaders,
    caption: relaxed
      ? `${shortSeason(seasonName)} 정규시즌 경기당 기록 · 표본이 적어 출전 하한 없이 ${roster.length}명 전원 기준`
      : `${shortSeason(seasonName)} 정규시즌 경기당 기록 · 팀 ${teamGp}경기의 30%인 ${minGp}경기 이상 출전한 ${pool.length}명 중 · 출전 경기는 0분 엔트리 제외`,
  };
}
