import { supabaseServer as supabase } from "./supabaseServer";
import { TAG, TTL, cached, cachedFn } from "./cachePolicy";
import { fetchAllPagesBounded } from "./scoringExplorer";
import type { TeamSeasonGame } from "./matchups";

// 팀 프로필 "데이터 사이언스" 대개편(app/teams/[tcode])의 데이터 레이어 -
// lib/playerDataScience.ts와 같은 구조: GROUP BY가 필요한 집계(4팩터/로스터/베스트 유닛/
// 존 구성비)는 마이그레이션 team_profile_datasci_rpc의 RPC 4종을 호출하고, 행 수가 적은
// 것(시즌 WPA, 프리게임 승률)은 PostgREST로 직접.
//
// 캐시(감사 2026-09-06: 팀 프로필이 요청마다 RPC 4종 + 슛 로그 수천 행을 다시 받았다):
// 입력이 전부 daily_batch 산출물(박스스코어·슛로그·스틴트·로스터)이라 TTL.batchDaily로
// 감싼다. 반환값은 전부 배열/객체/숫자뿐이라 unstable_cache의 JSON 직렬화가 안전하다
// (Map을 돌려주는 getPregameProbs만 감싸지 않았다). RPC 오류는 null/[]로 삼키지 않고
// throw 한다 - 삼키면 "오류로 빈 결과"가 1시간 캐시에 갇히고, 페이지의 soft 폴백이
// 어차피 console.error로 남기고 그 패널만 비우기 때문이다.

// ── 팀 시즌 슛 전체(히어로 별자리 + 슛 프로필 캡션이 공유) ─────────────────────────
// 시즌 슛은 팀당 ~4천 건 - shot_log에 tcode 단독 인덱스가 없어서(스키마 실측) 시즌
// gmkey 목록(이미 스케줄 조회로 확보, 최대 60여 개)을 IN으로 넘겨 기존 인덱스
// idx_shotlog_game_player(gmkey 선두)를 타게 함.
export type TeamShot = { x: number; y: number; d: string; made: boolean };

/**
 * gmkey 목록이 배열이라 cachedFn 인자로 못 넣는다(스칼라만) - 정렬해 이어 붙인 문자열을
 * 키로 쓴다(같은 집합이면 순서가 달라도 같은 키, lib/playerPageData.ts 관례). 시즌이
 * 진행돼 치른 경기가 늘면 목록이 달라져 자연히 새 키가 된다. 호출부(팀 프로필)가 넘기는
 * gmkey는 종료 경기뿐이라 라이브 슛이 캐시에 갇힐 일은 없다. seasonName은 태그용(선택).
 */
export function getTeamSeasonShots(tcode: string, gmkeys: string[], seasonName?: string): Promise<TeamShot[]> {
  if (!gmkeys.length) return Promise.resolve([]);
  const sorted = [...gmkeys].sort();
  return cached(
    () => computeTeamSeasonShots(tcode, sorted),
    ["teamSeasonShots", tcode, sorted.join(",")],
    TTL.batchDaily,
    [TAG.batch, ...(seasonName ? [TAG.season(seasonName)] : [])]
  );
}

async function computeTeamSeasonShots(tcode: string, gmkeys: string[]): Promise<TeamShot[]> {
  return fetchAllPagesBounded<TeamShot>(
    (from, to) =>
      supabase
        .from("shot_log")
        .select("x, y, d, made", { count: "exact" })
        .eq("tcode", tcode)
        .in("gmkey", gmkeys)
        .range(from, to) as unknown as PromiseLike<{ data: TeamShot[] | null; error: unknown; count: number | null }>
  );
}

// ── 4팩터 vs 리그(RPC team_season_four_factors - 정규시즌만) ──────────────────────
// 이 DB의 fgm/fga는 2점 전용이고 tpm/tpa가 별도(RPC 마이그레이션 주석의 실측) - 총 FGA는
// fga+tpa. 수비 팩터 = 같은 경기 "상대 행"의 팩터(상대가 우리를 상대로 낸 eFG% 등).
type FourFactorsRow = {
  tcode: string;
  gp: number;
  pts_pg: number;
  opp_pts_pg: number;
  off_efg: number;
  off_tov: number;
  off_oreb: number;
  off_ftr: number;
  def_efg: number;
  def_tov: number;
  def_oreb: number;
  def_ftr: number;
  off_rtg: number;
  def_rtg: number;
  net_rtg: number;
  pace: number;
};

export type FactorAxis = {
  key: string;
  label: string;
  side: "OFF" | "DEF";
  value: number;
  display: string;
  leagueAvg: number;
  leagueAvgDisplay: string;
  rank: number; // 1 = 리그 최고(방향 보정 후)
  teamsN: number;
  pctFill: number; // 0~100 - 바 길이((N-rank)/(N-1))
};

export type TeamFourFactors = {
  gp: number;
  ptsPg: number;
  oppPtsPg: number;
  offRtg: number;
  defRtg: number;
  netRtg: number;
  netRtgRank: number;
  pace: number;
  teamsN: number;
  axes: FactorAxis[];
};

// 방향 보정: 값이 "낮을수록 좋은" 축(공격 TOV%, 수비 eFG%/OREB%/FTr)은 invert.
// 수비 TOV%(상대 턴오버 유발)는 높을수록 좋음.
const FACTOR_DEFS: {
  key: keyof FourFactorsRow;
  label: string;
  side: "OFF" | "DEF";
  invert: boolean;
  fmt: (v: number) => string;
}[] = [
  { key: "off_efg", label: "eFG%", side: "OFF", invert: false, fmt: (v) => `${v.toFixed(1)}%` },
  { key: "off_tov", label: "TOV%", side: "OFF", invert: true, fmt: (v) => `${v.toFixed(1)}%` },
  { key: "off_oreb", label: "OREB%", side: "OFF", invert: false, fmt: (v) => `${v.toFixed(1)}%` },
  { key: "off_ftr", label: "FTr", side: "OFF", invert: false, fmt: (v) => v.toFixed(3) },
  { key: "def_efg", label: "eFG%", side: "DEF", invert: true, fmt: (v) => `${v.toFixed(1)}%` },
  { key: "def_tov", label: "TOV%", side: "DEF", invert: false, fmt: (v) => `${v.toFixed(1)}%` },
  { key: "def_oreb", label: "OREB%", side: "DEF", invert: true, fmt: (v) => `${v.toFixed(1)}%` },
  { key: "def_ftr", label: "FTr", side: "DEF", invert: true, fmt: (v) => v.toFixed(3) },
];

/**
 * RPC는 시즌 단위(p_season만 받아 10팀 전부)라 시즌 하나로 캐시하고 팀 행은 아래에서 고른다 -
 * (tcode, season)으로 캐시하면 같은 RPC 결과를 팀 수만큼 저장하고 미스도 팀 수만큼 난다.
 */
const getFourFactorsRows = cachedFn(computeFourFactorsRows, {
  name: "teamSeasonFourFactors",
  ttl: TTL.batchDaily,
  tags: (seasonName) => [TAG.batch, TAG.season(seasonName)],
});

async function computeFourFactorsRows(seasonName: string): Promise<FourFactorsRow[]> {
  const { data, error } = await supabase.rpc("team_season_four_factors", { p_season: seasonName });
  if (error) throw new Error(`team_season_four_factors(${seasonName}) 실패: ${error.message}`);
  // numeric 컬럼이 문자열로 오는 경우 대비해 숫자화하되, tcode(문자 코드 - "50" 등)는
  // 절대 Number()로 만들면 안 됨(=== 비교가 영영 실패하는 버그를 실제로 겪음).
  return ((data ?? []) as FourFactorsRow[]).map((r) => {
    const num = Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, k !== "tcode" && typeof v === "string" ? Number(v) : v])
    );
    return num as unknown as FourFactorsRow;
  });
}

export async function getTeamFourFactors(tcode: string, seasonName: string): Promise<TeamFourFactors | null> {
  const rows = await getFourFactorsRows(seasonName);
  const me = rows.find((r) => r.tcode === tcode);
  if (!me || rows.length < 2) return null;

  const teamsN = rows.length;
  const axes: FactorAxis[] = FACTOR_DEFS.map((def) => {
    const mine = me[def.key] as number;
    const values = rows.map((r) => r[def.key] as number);
    const leagueAvg = values.reduce((s, v) => s + v, 0) / teamsN;
    // 순위: 방향 보정 후 1위 = 리그 최고. 동률은 같은 순위(자기보다 확실히 나은 팀 수 + 1).
    const better = values.filter((v) => (def.invert ? v < mine : v > mine)).length;
    const rank = better + 1;
    return {
      key: def.key,
      label: def.label,
      side: def.side,
      value: mine,
      display: def.fmt(mine),
      leagueAvg,
      leagueAvgDisplay: def.fmt(leagueAvg),
      rank,
      teamsN,
      pctFill: Math.round(((teamsN - rank) / (teamsN - 1)) * 100),
    };
  });

  const netBetter = rows.filter((r) => r.net_rtg > me.net_rtg).length;
  return {
    gp: me.gp,
    ptsPg: me.pts_pg,
    oppPtsPg: me.opp_pts_pg,
    offRtg: me.off_rtg,
    defRtg: me.def_rtg,
    netRtg: me.net_rtg,
    netRtgRank: netBetter + 1,
    pace: me.pace,
    teamsN,
    axes,
  };
}

// ── 시즌 여정(게임별 마진 + 누적 승률 + 연승 + 모델 기준 업셋) ─────────────────────
// 프리게임 모델 승률 = game_events의 event_order=0(경기 시작 시점) home_win_prob -
// pregame_features엔 모델 "출력"(승률) 컬럼이 없음(실측 - 피처만 있음). 4,207경기 중
// 4,182경기에 존재(모델 미실행 25경기는 마커 없이 그냥 지나감).
export type JourneyGame = {
  gmkey: string;
  gameDate: string;
  oppTcode: string;
  oppName: string;
  isHome: boolean;
  teamScore: number;
  oppScore: number;
  seasonCategory: string;
  margin: number;
  won: boolean;
  runningWinPct: number; // 이 경기까지의 누적 승률(0~1)
  preWinProb: number | null; // 이 팀 기준 프리게임 모델 승률
  upsetWin: boolean; // 모델이 상대 우세(<0.5)로 봤는데 이김
};

export type SeasonJourney = {
  games: JourneyGame[];
  longestStreak: { len: number; startIdx: number; endIdx: number } | null;
  upsetWins: number;
  probCoverage: number; // 프리게임 승률이 있는 경기 수
};

export async function getPregameProbs(gmkeys: string[]): Promise<Map<string, number>> {
  if (!gmkeys.length) return new Map();
  const { data } = await supabase
    .from("game_events")
    .select("gmkey, home_win_prob")
    .in("gmkey", gmkeys)
    .eq("event_order", 0);
  const map = new Map<string, number>();
  for (const r of data ?? []) {
    if (r.home_win_prob != null) map.set(r.gmkey as string, Number(r.home_win_prob));
  }
  return map;
}

export function buildSeasonJourney(schedule: TeamSeasonGame[], homeProbByGmkey: Map<string, number>): SeasonJourney {
  let wins = 0;
  const games: JourneyGame[] = schedule.map((g, i) => {
    const won = g.teamScore > g.oppScore;
    if (won) wins++;
    const homeProb = homeProbByGmkey.get(g.gmkey);
    const preWinProb = homeProb == null ? null : g.isHome ? homeProb : 1 - homeProb;
    return {
      ...g,
      margin: g.teamScore - g.oppScore,
      won,
      runningWinPct: wins / (i + 1),
      preWinProb,
      upsetWin: preWinProb != null && preWinProb < 0.5 && won,
    };
  });

  // 최다 연승 구간(동률이면 앞선 구간) - 시즌 서사 주석용. 2연승 미만이면 주석 생략.
  let longestStreak: SeasonJourney["longestStreak"] = null;
  let curLen = 0;
  let curStart = 0;
  for (let i = 0; i < games.length; i++) {
    if (games[i].won) {
      if (curLen === 0) curStart = i;
      curLen++;
      if (!longestStreak || curLen > longestStreak.len) {
        longestStreak = { len: curLen, startIdx: curStart, endIdx: i };
      }
    } else {
      curLen = 0;
    }
  }
  if (longestStreak && longestStreak.len < 2) longestStreak = null;

  return {
    games,
    longestStreak,
    upsetWins: games.filter((g) => g.upsetWin).length,
    probCoverage: games.filter((g) => g.preWinProb != null).length,
  };
}

// ── 로스터 기여도(RPC team_season_roster + player_season_wpa 조인) ─────────────────
export type RosterRow = {
  pcode: string;
  name: string;
  pos: string | null;
  backNum: string | null;
  gp: number;
  minPg: number;
  ppg: number;
  rpg: number;
  apg: number;
  totalWpa: number | null;
};

/** 로스터 기여도 - RPC + WPA 조인. 둘 다 daily_batch 산출물이라 TTL.batchDaily. */
export const getRosterContribution = cachedFn(computeRosterContribution, {
  name: "teamRosterContribution",
  ttl: TTL.batchDaily,
  tags: (_tcode, seasonName) => [TAG.batch, TAG.season(seasonName)],
});

async function computeRosterContribution(tcode: string, seasonName: string): Promise<RosterRow[]> {
  type Raw = {
    pcode: string;
    name: string;
    pos: string | null;
    back_num: string | null;
    gp: number;
    min_total: string | number;
    pts_total: number;
    reb_total: number;
    ast_total: number;
  };
  const [{ data, error }, { data: wpaRows }] = await Promise.all([
    supabase.rpc("team_season_roster", { p_tcode: tcode, p_season: seasonName }),
    supabase.from("player_season_wpa").select("pcode, total_wpa").eq("season_name", seasonName).eq("tcode", tcode),
  ]);
  // 오류를 []로 돌려주면 캐시에 "빈 로스터"가 1시간 갇힌다 - throw 해서 저장을 막는다.
  if (error) throw new Error(`team_season_roster(${tcode}, ${seasonName}) 실패: ${error.message}`);
  if (!data) return [];
  const wpaByPcode = new Map((wpaRows ?? []).map((r) => [r.pcode as string, Number(r.total_wpa)]));
  return (data as Raw[])
    .map((r) => {
      const gp = Number(r.gp);
      return {
        pcode: r.pcode,
        name: r.name,
        pos: r.pos,
        backNum: r.back_num,
        gp,
        minPg: Number(r.min_total) / gp,
        ppg: Number(r.pts_total) / gp,
        rpg: Number(r.reb_total) / gp,
        apg: Number(r.ast_total) / gp,
        totalWpa: wpaByPcode.get(r.pcode) ?? null,
      };
    })
    .sort((a, b) => b.minPg * b.gp - a.minPg * a.gp);
}

// ── 베스트 유닛(RPC team_best_units) ────────────────────────────────────────────────
// lineup_combo는 15시즌 통산이고 시즌/팀 분리가 없음(스키마 실측) - "이 시즌 로스터만으로
// 구성된 조합"으로 제한하고, 표기되는 넷레이팅이 통산 표본이라는 사실을 UI 캡션에 명시
// (spec의 정직성 요구). 최소 시간: 2인 50분(선수 프로필 COMBO_MIN_MINUTES 관례), 5인 20분.
export const UNIT_MIN_MINUTES_2MAN = 50;
export const UNIT_MIN_MINUTES_5MAN = 20;

export type BestUnit = { n: number; pcodes: string[]; names: string[]; minutes: number; netRatingPer40: number };

/** 베스트 유닛 - lineup_combo(수동 build) × 이 시즌 로스터(daily_batch). 더 자주 바뀌는 쪽에 맞춰 batchDaily, 태그는 둘 다. */
export const getBestUnits = cachedFn(computeBestUnits, {
  name: "teamBestUnits",
  ttl: TTL.batchDaily,
  tags: (_tcode, seasonName) => [TAG.batch, TAG.build, TAG.season(seasonName)],
});

async function computeBestUnits(tcode: string, seasonName: string): Promise<BestUnit[]> {
  const { data, error } = await supabase.rpc("team_best_units", { p_tcode: tcode, p_season: seasonName });
  if (error) throw new Error(`team_best_units(${tcode}, ${seasonName}) 실패: ${error.message}`);
  if (!data) return [];
  type Raw = { n: number; pcodes: string[]; names: string[] | null; minutes: string | number; net_rating_per40: string | number };
  return (data as Raw[]).map((r) => ({
    n: Number(r.n),
    pcodes: r.pcodes,
    names: r.names ?? r.pcodes,
    minutes: Number(r.minutes),
    netRatingPer40: Number(r.net_rating_per40),
  }));
}

// ── 슛 프로필: 팀 존 구성비 vs 리그 평균(RPC season_zone_mix) ──────────────────────
// 존 분류는 RPC 안 SQL이 lib/formIndex.ts classifyShot과 동일 상수로 수행(마이그레이션
// 주석 참고 - 상수 변경 시 양쪽 함께). 리그 평균 = 이 팀 제외가 아니라 전 팀 합(관례:
// 선수 퍼센타일 풀도 자신 포함).
export const ZONE_KEYS = ["rim", "close", "midShort", "midLong", "three"] as const;
export type ZoneKey = (typeof ZONE_KEYS)[number];
export const ZONE_LABELS: Record<ZoneKey, string> = {
  rim: "림",
  close: "근거리",
  midShort: "중거리",
  midLong: "롱2",
  three: "3점",
};

export type ZoneProfileRow = {
  zone: ZoneKey;
  teamShare: number; // 0~1
  leagueShare: number;
  teamFgPct: number | null;
  leagueFgPct: number | null;
  att: number;
};

export type TeamZoneProfile = { rows: ZoneProfileRow[]; teamTotal: number; leagueTotal: number };

type ZoneMixRow = { tcode: string; zone: string; att: number; made: number };

/** 4팩터와 같은 이유로 시즌 단위 캐시(RPC가 p_season만 받아 전 팀 행을 돌려준다). */
const getZoneMixRows = cachedFn(computeZoneMixRows, {
  name: "seasonZoneMix",
  ttl: TTL.batchDaily,
  tags: (seasonName) => [TAG.batch, TAG.season(seasonName)],
});

async function computeZoneMixRows(seasonName: string): Promise<ZoneMixRow[]> {
  const { data, error } = await supabase.rpc("season_zone_mix", { p_season: seasonName });
  if (error) throw new Error(`season_zone_mix(${seasonName}) 실패: ${error.message}`);
  return ((data ?? []) as ZoneMixRow[]).map((r) => ({ tcode: r.tcode, zone: r.zone, att: Number(r.att), made: Number(r.made) }));
}

export async function getTeamZoneProfile(tcode: string, seasonName: string): Promise<TeamZoneProfile | null> {
  const rows = await getZoneMixRows(seasonName);
  if (!rows.length) return null;
  const team: Record<ZoneKey, { att: number; made: number }> = {
    rim: { att: 0, made: 0 },
    close: { att: 0, made: 0 },
    midShort: { att: 0, made: 0 },
    midLong: { att: 0, made: 0 },
    three: { att: 0, made: 0 },
  };
  const league: Record<ZoneKey, { att: number; made: number }> = {
    rim: { att: 0, made: 0 },
    close: { att: 0, made: 0 },
    midShort: { att: 0, made: 0 },
    midLong: { att: 0, made: 0 },
    three: { att: 0, made: 0 },
  };
  for (const r of rows) {
    const z = r.zone as ZoneKey;
    if (!ZONE_KEYS.includes(z)) continue;
    league[z].att += Number(r.att);
    league[z].made += Number(r.made);
    if (r.tcode === tcode) {
      team[z].att += Number(r.att);
      team[z].made += Number(r.made);
    }
  }
  const teamTotal = ZONE_KEYS.reduce((s, z) => s + team[z].att, 0);
  const leagueTotal = ZONE_KEYS.reduce((s, z) => s + league[z].att, 0);
  if (!teamTotal || !leagueTotal) return null;
  return {
    teamTotal,
    leagueTotal,
    rows: ZONE_KEYS.map((z) => ({
      zone: z,
      teamShare: team[z].att / teamTotal,
      leagueShare: league[z].att / leagueTotal,
      teamFgPct: team[z].att ? team[z].made / team[z].att : null,
      leagueFgPct: league[z].att ? league[z].made / league[z].att : null,
      att: team[z].att,
    })),
  };
}
