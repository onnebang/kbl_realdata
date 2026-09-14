import { supabaseServer as supabase } from "./supabaseServer";
import { cachedFn, TAG, TTL } from "./cachePolicy";
import { getAllTeams, type TeamMeta } from "./playerProfile";
import { cumulativeElapsed } from "./postgameReport";
import { displayTeamName } from "./teamNames";

// "승부를 가른 순간"(/leaderboards/win-contribution) 데이터 - 원천은 tools/rpc_win_moments.sql의 함수 4개.
// 왜 순위표에서 장면 중심으로 바꿨는지(실측 수치)는 그 SQL 파일 머리 주석에 있다.
// 요약: 선수 시즌 WPA 합계는 득점과 r=0.991이라 새 정보가 없고, 데이터가 확실히 말하는 건 '순간'이다.

export type TeamLite = { tcode: string; name: string; abbr: string; color: string | null };
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

export type WeightPoint = { pcode: string; playerName: string; team: TeamLite; games: number; pts: number; wpa: number };

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
  return { tcode, name: displayTeamName(tcode, t?.name ?? tcode, season), abbr: t?.abbr ?? tcode, color: t?.color ?? null };
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
type SeriesRow = { gmkey: string; elapsed: number; home_win_prob: number };
type WeightRow = { pcode: string; player_name: string | null; tcode: string; games: number; pts: number; wpa: number };

/** 홈 기준 곡선을 주인공 팀 기준으로 뒤집고, 끝을 실제 결과(이기면 1, 지면 0)로 닫는다. */
function sideCurve(series: SeriesRow[], isHome: boolean, won: boolean): CurvePoint[] {
  const pts: CurvePoint[] = series.map((r) => [r.elapsed, isHome ? r.home_win_prob : 1 - r.home_win_prob]);
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

async function computeWinMoments(season: string): Promise<WinMoments> {
  const [playRows, comebackRows, weightRows, teams] = await Promise.all([
    rpc<PlayRow>("season_big_plays", { p_season: season, p_limit: 12 }),
    rpc<ComebackRow>("season_comebacks", { p_season: season, p_limit: 6 }),
    rpc<WeightRow>("season_scoring_weight", { p_season: season, p_min_pts: 200 }),
    getAllTeams(),
  ]);
  const gmkeys = [...new Set([...playRows.map((r) => r.gmkey), ...comebackRows.map((r) => r.gmkey)])];
  const seriesRows = gmkeys.length ? await rpc<SeriesRow>("game_winprob_series", { p_gmkeys: gmkeys }) : [];
  const seriesOf = (gmkey: string) => seriesRows.filter((r) => r.gmkey === gmkey).sort((a, b) => a.elapsed - b.elapsed);

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
  name: "winMoments",
  ttl: TTL.batchDaily,
  tags: (season) => [TAG.batch, TAG.season(String(season))],
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
