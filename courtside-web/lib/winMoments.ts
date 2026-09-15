import { supabaseServer as supabase } from "./supabaseServer";
import { cachedFn, TAG, TTL } from "./cachePolicy";
import { getAllTeams, type TeamMeta } from "./playerProfile";
import { cumulativeElapsed } from "./postgameReport";
import { displayTeamName } from "./teamNames";

// "승부를 가른 순간"(/leaderboards/win-contribution) 데이터 - 원천은 tools/rpc_win_moments.sql의 함수 4개.
// 왜 순위표에서 장면 중심으로 바꿨는지(실측 수치)는 그 SQL 파일 머리 주석에 있다.
// 요약: 선수 시즌 WPA 합계는 득점과 r=0.991이라 새 정보가 없고, 데이터가 확실히 말하는 건 '순간'이다.

export type TeamLite = { tcode: string; name: string; abbr: string; color: string | null; logoUrl: string | null };
/** [경과초, 승률] - 승률은 그 카드 주인공 팀(한 방은 득점한 팀, 역전은 이긴 팀) 기준. */
export type CurvePoint = [number, number];

export type BigPlay = {
  gmkey: string;
  gameDate: string;
  period: string;
  clock: string;
  shot: string;
  pcode: string;
  playerName: string;
  /** 요청("시즌 최고의 한 방에 선수 사진·팀 로고를 은은하게") - 없으면 카드가 사진 없이 그린다. */
  photoUrl: string | null;
  team: TeamLite;
  opp: TeamLite;
  /** 그 플레이 직후 점수(팀 기준). */
  teamScore: number;
  oppScore: number;
  finalTeam: number;
  finalOpp: number;
  won: boolean;
  /** 그 플레이로 오른 승률(0~1). */
  wpa: number;
  /** 모델이 본 직전 승률. 경기 끝 순간은 모델이 종료를 모르므로 직후 값은 쓰지 않는다(곡선 끝을 실제 결과로 닫는다). */
  probBefore: number;
  elapsed: number;
  curve: CurvePoint[];
};

export type Comeback = {
  gmkey: string;
  gameDate: string;
  winner: TeamLite;
  loser: TeamLite;
  finalWinner: number;
  finalLoser: number;
  minProb: number;
  period: string;
  clock: string;
  winnerScoreAtMin: number;
  loserScoreAtMin: number;
  elapsed: number;
  curve: CurvePoint[];
};

export type WeightPoint = { pcode: string; playerName: string; photoUrl: string | null; team: TeamLite; games: number; pts: number; wpa: number };

export type WinMoments = {
  season: string;
  plays: BigPlay[];
  comebacks: Comeback[];
  weight: { players: WeightPoint[]; perPoint: number; r: number };
};

const SHOT_LABEL: Record<string, string> = { "201": "2점슛", "205": "3점슛", "207": "덩크", "203": "자유투" };
/** 정규 경기 길이(초). 곡선 가로축은 이 값 이상으로 잡는다. */
export const REGULATION_SEC = 2400;

export const periodLabel = (q: string) => (q.startsWith("Q") ? `${q.slice(1)}쿼터` : q.startsWith("X") ? (q === "X1" ? "연장" : `연장 ${q.slice(1)}`) : q);
const clockLabel = (m: number, s: number) => `${m}:${String(s).padStart(2, "0")}`;

function teamLite(teams: Map<string, TeamMeta>, tcode: string, season: string): TeamLite {
  const t = teams.get(tcode);
  return { tcode, name: displayTeamName(tcode, t?.name ?? tcode, season), abbr: t?.abbr ?? tcode, color: t?.color ?? null, logoUrl: t?.logoUrl ?? null };
}

/** players.photo_url 배치 조회(773명 중 130명만 있음 - 실측). 이 파일 전용 - 같은 패턴이
 * lib/wowy.ts·lib/lineupCombos.ts·lib/teamSeasonStats.ts에도 각자 있다(저장소 관례). */
async function fetchPlayerPhotos(pcodes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniq = [...new Set(pcodes)];
  if (!uniq.length) return map;
  const { data } = await supabase.from("players").select("pcode, photo_url").in("pcode", uniq);
  for (const r of data ?? []) {
    const url = r.photo_url as string | null;
    if (url) map.set(r.pcode as string, url);
  }
  return map;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (data ?? []) as T[];
}

type PlayRow = {
  gmkey: string; game_date: string; quarter: string; clock_min: number; clock_sec: number; action_code: string;
  pcode: string; player_name: string | null; tcode: string; home_tcode: string; away_tcode: string;
  home_score: number; away_score: number; final_home: number; final_away: number; wpa: number; prob_after: number;
};
type ComebackRow = {
  gmkey: string; game_date: string; home_tcode: string; away_tcode: string; final_home: number; final_away: number;
  winner_tcode: string; min_prob: number; min_quarter: string; min_clock_min: number; min_clock_sec: number;
  min_home_score: number; min_away_score: number;
};
/** game_winprob_series는 경기당 1행 - [경과초, 홈 승률] 배열(경과초 오름차순). */
type SeriesRow = { gmkey: string; points: [number, number][] };
type WeightRow = { pcode: string; player_name: string | null; tcode: string; games: number; pts: number; wpa: number };

/** 홈 기준 곡선을 주인공 팀 기준으로 뒤집고, 끝을 실제 결과(이기면 1, 지면 0)로 닫는다. */
function sideCurve(series: [number, number][], isHome: boolean, won: boolean): CurvePoint[] {
  const pts: CurvePoint[] = series.map(([t, p]) => [t, isHome ? Number(p) : 1 - Number(p)]);
  const end = Math.max(REGULATION_SEC, pts.length ? pts[pts.length - 1][0] : 0);
  pts.push([end, won ? 1 : 0]);
  return pts;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/**
 * tcode를 주면 리그 전체가 아니라 그 팀이 낀 경기만 본다(팀 페이지 "이 팀의 결정적 순간"용).
 * season_scoring_weight는 team 인자가 없어 결과를 받은 뒤 걸러낸다 - 200점 문턱을 넘는 선수가
 * 원래도 시즌당 90명 안팎이라 필터링 비용은 무시할 만하다.
 */
async function computeWinMoments(season: string, tcode?: string): Promise<WinMoments> {
  const [playRows, comebackRows, weightRowsAll, teams] = await Promise.all([
    rpc<PlayRow>("season_big_plays", { p_season: season, p_limit: 12, p_tcode: tcode ?? null }),
    rpc<ComebackRow>("season_comebacks", { p_season: season, p_limit: 6, p_tcode: tcode ?? null }),
    rpc<WeightRow>("season_scoring_weight", { p_season: season, p_min_pts: 200 }),
    getAllTeams(),
  ]);
  const weightRows = tcode ? weightRowsAll.filter((r) => r.tcode === tcode) : weightRowsAll;
  const gmkeys = [...new Set([...playRows.map((r) => r.gmkey), ...comebackRows.map((r) => r.gmkey)])];
  const [seriesRows, photos] = await Promise.all([
    gmkeys.length ? rpc<SeriesRow>("game_winprob_series", { p_gmkeys: gmkeys }) : Promise.resolve<SeriesRow[]>([]),
    fetchPlayerPhotos([...playRows.map((r) => r.pcode), ...weightRows.map((r) => r.pcode)]),
  ]);
  const seriesOf = (gmkey: string) => seriesRows.find((r) => r.gmkey === gmkey)?.points ?? [];

  const plays: BigPlay[] = playRows.map((r) => {
    const isHome = r.tcode === r.home_tcode;
    const oppCode = isHome ? r.away_tcode : r.home_tcode;
    const finalTeam = isHome ? r.final_home : r.final_away;
    const finalOpp = isHome ? r.final_away : r.final_home;
    const won = finalTeam > finalOpp;
    return {
      gmkey: r.gmkey,
      gameDate: r.game_date,
      period: periodLabel(r.quarter),
      clock: clockLabel(r.clock_min, r.clock_sec),
      shot: SHOT_LABEL[r.action_code] ?? "플레이",
      pcode: r.pcode,
      playerName: r.player_name ?? r.pcode,
      photoUrl: photos.get(r.pcode) ?? null,
      team: teamLite(teams, r.tcode, season),
      opp: teamLite(teams, oppCode, season),
      teamScore: isHome ? r.home_score : r.away_score,
      oppScore: isHome ? r.away_score : r.home_score,
      finalTeam,
      finalOpp,
      won,
      wpa: r.wpa,
      probBefore: Math.min(1, Math.max(0, r.prob_after - r.wpa)),
      elapsed: cumulativeElapsed(r.quarter, r.clock_min, r.clock_sec),
      curve: sideCurve(seriesOf(r.gmkey), isHome, won),
    };
  });

  const comebacks: Comeback[] = comebackRows.map((r) => {
    const winnerHome = r.winner_tcode === r.home_tcode;
    return {
      gmkey: r.gmkey,
      gameDate: r.game_date,
      winner: teamLite(teams, r.winner_tcode, season),
      loser: teamLite(teams, winnerHome ? r.away_tcode : r.home_tcode, season),
      finalWinner: winnerHome ? r.final_home : r.final_away,
      finalLoser: winnerHome ? r.final_away : r.final_home,
      minProb: r.min_prob,
      period: periodLabel(r.min_quarter),
      clock: clockLabel(r.min_clock_min, r.min_clock_sec),
      winnerScoreAtMin: winnerHome ? r.min_home_score : r.min_away_score,
      loserScoreAtMin: winnerHome ? r.min_away_score : r.min_home_score,
      elapsed: cumulativeElapsed(r.min_quarter, r.min_clock_min, r.min_clock_sec),
      curve: sideCurve(seriesOf(r.gmkey), winnerHome, true),
    };
  });

  const players: WeightPoint[] = weightRows.map((r) => ({
    pcode: r.pcode,
    playerName: r.player_name ?? r.pcode,
    photoUrl: photos.get(r.pcode) ?? null,
    team: teamLite(teams, r.tcode, season),
    games: r.games,
    pts: r.pts,
    wpa: r.wpa,
  }));
  const totalPts = players.reduce((s, p) => s + p.pts, 0);
  return {
    season,
    plays,
    comebacks,
    weight: {
      players,
      perPoint: totalPts ? players.reduce((s, p) => s + p.wpa, 0) / totalPts : 0,
      r: pearson(players.map((p) => p.pts), players.map((p) => p.wpa)),
    },
  };
}

export const getWinMoments = cachedFn(computeWinMoments, {
  name: "winMoments-v2", // v2: 곡선이 응답 상한에 잘려 비던 캐시를 버린다

  ttl: TTL.batchDaily,
  tags: (season, tcode) => [TAG.batch, TAG.season(String(season)), ...(tcode ? [`team:${tcode}`] : [])],
});

/** WinContributionPage용 아주 짧은 요약(팀 필터 없을 때는 계산 자체를 안 한다). */
export type TeamHighlight = { play: BigPlay | null; comeback: Comeback | null };

/**
 * 팀 페이지 "이 팀의 결정적 순간" 미리보기 전용 - season_scoring_weight·승률 곡선 시리즈를
 * 아예 부르지 않는다(그 둘은 미리보기에 안 쓰인다). getWinMoments(season, tcode)는 표·산점도까지
 * 계산하므로 팀 페이지엔 과하다.
 */
async function computeTeamHighlight(season: string, tcode: string): Promise<TeamHighlight> {
  const [playRows, comebackRows, teams] = await Promise.all([
    rpc<PlayRow>("season_big_plays", { p_season: season, p_limit: 1, p_tcode: tcode }),
    rpc<ComebackRow>("season_comebacks", { p_season: season, p_limit: 1, p_tcode: tcode }),
    getAllTeams(),
  ]);
  const r = playRows[0];
  const c = comebackRows[0];
  const play: BigPlay | null = r
    ? (() => {
        const isHome = r.tcode === r.home_tcode;
        const oppCode = isHome ? r.away_tcode : r.home_tcode;
        const finalTeam = isHome ? r.final_home : r.final_away;
        const finalOpp = isHome ? r.final_away : r.final_home;
        const won = finalTeam > finalOpp;
        return {
          gmkey: r.gmkey,
          gameDate: r.game_date,
          period: periodLabel(r.quarter),
          clock: clockLabel(r.clock_min, r.clock_sec),
          shot: SHOT_LABEL[r.action_code] ?? "플레이",
          pcode: r.pcode,
          playerName: r.player_name ?? r.pcode,
          photoUrl: null, // 팀 페이지 미리보기 카드는 사진을 안 그린다 - 안 불러온다.
          team: teamLite(teams, r.tcode, season),
          opp: teamLite(teams, oppCode, season),
          teamScore: isHome ? r.home_score : r.away_score,
          oppScore: isHome ? r.away_score : r.home_score,
          finalTeam,
          finalOpp,
          won,
          wpa: r.wpa,
          probBefore: Math.min(1, Math.max(0, r.prob_after - r.wpa)),
          elapsed: cumulativeElapsed(r.quarter, r.clock_min, r.clock_sec),
          curve: [],
        };
      })()
    : null;
  const comeback: Comeback | null = c
    ? (() => {
        const winnerHome = c.winner_tcode === c.home_tcode;
        return {
          gmkey: c.gmkey,
          gameDate: c.game_date,
          winner: teamLite(teams, c.winner_tcode, season),
          loser: teamLite(teams, winnerHome ? c.away_tcode : c.home_tcode, season),
          finalWinner: winnerHome ? c.final_home : c.final_away,
          finalLoser: winnerHome ? c.final_away : c.final_home,
          minProb: c.min_prob,
          period: periodLabel(c.min_quarter),
          clock: clockLabel(c.min_clock_min, c.min_clock_sec),
          winnerScoreAtMin: winnerHome ? c.min_home_score : c.min_away_score,
          loserScoreAtMin: winnerHome ? c.min_away_score : c.min_home_score,
          elapsed: cumulativeElapsed(c.min_quarter, c.min_clock_min, c.min_clock_sec),
          curve: [],
        };
      })()
    : null;
  return { play, comeback };
}

export const getTeamHighlight = cachedFn(computeTeamHighlight, {
  name: "teamHighlight",
  ttl: TTL.batchDaily,
  tags: (season, tcode) => [TAG.batch, TAG.season(String(season)), `team:${tcode}`],
});

/** 곡선 SVG path(viewBox 0..w × 0..h, 위가 승률 100%). */
export function curvePath(curve: CurvePoint[], w: number, h: number): string {
  if (!curve.length) return "";
  const xMax = Math.max(REGULATION_SEC, curve[curve.length - 1][0]);
  return curve
    .map(([t, p], i) => `${i ? "L" : "M"}${((t / xMax) * w).toFixed(1)},${((1 - p) * h).toFixed(1)}`)
    .join("");
}

/** 곡선 위 한 점의 위치(%) - HTML 점을 겹칠 때 쓴다(SVG 원은 preserveAspectRatio=none에서 찌그러진다). */
export function curvePos(curve: CurvePoint[], elapsed: number, prob: number): { left: string; top: string } {
  const xMax = Math.max(REGULATION_SEC, curve.length ? curve[curve.length - 1][0] : 0);
  return { left: `${(elapsed / xMax) * 100}%`, top: `${(1 - prob) * 100}%` };
}
