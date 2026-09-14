import { supabaseServer as supabase } from "./supabaseServer";
import { cachedFn, TAG, TTL } from "./cachePolicy";
import { getAllTeams } from "./playerProfile";
import { displayTeamName } from "./teamNames";

// 슈팅 리포트 "KBL 슛의 15년" 탭 데이터 - 원천은 tools/rpc_shot_trend.sql(출처를 박스스코어/좌표로 나눈 이유와
// 2017-18 좌표 기록 변화 근거가 그 파일 머리 주석에 있다). 비중은 전부 '야투 시도 전체' 대비.

type Counts = { fga2: number; fgm2: number; fga3: number; fgm3: number; pts: number; poss: number; paint_a: number; paint_m: number; mid_a: number; mid_m: number };

export type ShotMix = {
  /** 야투 시도 중 3점 / 중거리(3m~3점선) / 페인트존(3m 이내) 비중 - 합 1. */
  three: number;
  mid: number;
  paint: number;
  /** 야투 1개당 득점(자유투 제외). */
  pps: number;
  threePct: number;
  midFg: number;
  paintFg: number;
  /** 100포제션당 득점(자유투·리바운드·실책까지 포함한 공격 효율). */
  ortg: number;
};

export type SeasonShot = ShotMix & { season: string; label: string; teamGames: number };
export type TeamShot = ShotMix & { tcode: string; name: string; color: string | null; games: number };

function mix(c: Counts): ShotMix {
  const fga = c.fga2 + c.fga3;
  const two = fga ? c.fga2 / fga : 0;
  const zoneTotal = c.paint_a + c.mid_a;
  // 2점 안의 페인트/중거리 나눔만 좌표 비율을 쓰고, 2점·3점 크기 자체는 박스스코어를 따른다.
  const paintOfTwo = zoneTotal ? c.paint_a / zoneTotal : 0;
  return {
    three: fga ? c.fga3 / fga : 0,
    paint: two * paintOfTwo,
    mid: two * (1 - paintOfTwo),
    pps: fga ? (2 * c.fgm2 + 3 * c.fgm3) / fga : 0,
    threePct: c.fga3 ? c.fgm3 / c.fga3 : 0,
    paintFg: c.paint_a ? c.paint_m / c.paint_a : 0,
    midFg: c.mid_a ? c.mid_m / c.mid_a : 0,
    ortg: c.poss ? (100 * c.pts) / c.poss : 0,
  };
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (data ?? []) as T[];
}

export const seasonShort = (s: string) => `${s.slice(2, 4)}-${s.slice(7, 9)}`;

export const getLeagueShotTrend = cachedFn(
  async (): Promise<SeasonShot[]> => {
    const rows = await rpc<Counts & { season_name: string; team_games: number }>("league_shot_trend");
    return rows.map((r) => ({ season: r.season_name, label: seasonShort(r.season_name), teamGames: r.team_games, ...mix(r) }));
  },
  { name: "leagueShotTrend", ttl: TTL.batchDaily, tags: () => [TAG.batch] }
);

export const getTeamShotProfile = cachedFn(
  async (season: string): Promise<TeamShot[]> => {
    const [rows, teams] = await Promise.all([rpc<Counts & { tcode: string; team_games: number }>("season_team_shot_profile", { p_season: season }), getAllTeams()]);
    return rows
      .map((r) => {
        const t = teams.get(r.tcode);
        return { tcode: r.tcode, name: displayTeamName(r.tcode, t?.name ?? r.tcode, season), color: t?.color ?? null, games: r.team_games, ...mix(r) };
      })
      .sort((a, b) => b.three - a.three);
  },
  { name: "teamShotProfile", ttl: TTL.batchDaily, tags: (s) => [TAG.batch, TAG.season(String(s))] }
);
