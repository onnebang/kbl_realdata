import { supabaseServer as supabase } from "./supabaseServer";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { getRoundGames } from "./homeGames";
import { getSeasonDirectory, getTeams, type TeamInfo } from "./preseason";
import { aggregateSeasonPlayers, PLAYER_SELECT, type PlayerGameRow, type SeasonPlayerAgg } from "./seasonLeaders";
import { normalizePos, posLabel } from "./teamSeasonStats";
import { getRoundWinMoments, type BigPlay, type Comeback } from "./winMoments";

// 라운드 어워드(/awards/round) - 라운드 MVP(국내/용병/아시아쿼터) + 포지션별 베스트(G/F/C
// 1~3위). 둘 다 같은 라운드 선수 집계(aggs) 하나에서 그룹 기준만 바꿔 뽑는다 - 쿼리도
// game_player_stats 한 번뿐이다.
//
// 새 계산식을 만들지 않았다: game_player_stats에 경기별 PER이 이미 있고,
// aggregateSeasonPlayers()(lib/seasonLeaders.ts)는 "선수-경기 행 묶음 → 선수별 집계(출전시간
// 가중 PER 평균 포함)"를 하는 순수 함수라, 시즌 전체 대신 이 라운드 경기들만 넘기면 그대로
// 라운드 집계가 된다. 국내/용병/아시아쿼터 구분도 getSeasonDirectory(season_roster.note 기반,
// lib/preseason.ts의 roleFromNote와 같은 규칙)를 그대로 쓴다.
//
// 선정 기준은 두 어워드 모두 순수하게 스탯(출전시간 가중 PER 평균)이다 - 팀 성적·서사는
// 반영하지 않고 그 사실을 화면에 명시한다(시즌 리더보드와 같은 "자격 기준 없는 순위표는
// 거짓말" 기조).

export type RoundRoleKey = "domestic" | "import" | "asiaQuota";

export const ROUND_ROLE_LABEL: Record<RoundRoleKey, string> = {
  domestic: "국내",
  import: "용병",
  asiaQuota: "아시아쿼터",
};

export type PositionKey = "G" | "F" | "C";

export const POSITION_LABEL: Record<PositionKey, string> = {
  G: "가드",
  F: "포워드",
  C: "센터",
};

/** 시즌 리더보드 자격(15경기 또는 300분, lib/seasonLeaders.ts LEADER_QUALIFY)을 라운드 최대
 * 경기 수(10팀 기준 라운드당 9경기)에 맞춰 스케일: 15/54*9≈2.5→3경기, 300/54*9≈50분. */
export const ROUND_QUALIFY = { gp: 3, minutes: 50 } as const;

export type RoundAwardRow = {
  pcode: string;
  name: string;
  tcode: string;
  team: TeamInfo | null;
  photoUrl: string | null;
  pos: PositionKey | null;
  posLabel: string;
  gp: number;
  minutes: number;
  perW: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tpm: number;
};

export type RoundMvpBoard = {
  role: RoundRoleKey;
  label: string;
  /** 자격 통과 + 이 버킷에 속한 인원(화면에 "N명 중" 캡션용). */
  poolN: number;
  rows: RoundAwardRow[];
};

export type PositionBestBoard = {
  pos: PositionKey;
  label: string;
  poolN: number;
  rows: RoundAwardRow[];
};

export type AllStarTier = 1 | 2 | 3;

export const ALL_STAR_TIER_LABEL: Record<AllStarTier, string> = { 1: "퍼스트팀", 2: "세컨드팀", 3: "써드팀" };

export type AllStarTeam = {
  tier: AllStarTier;
  label: string;
  /** 2가드 + 2포워드 + 1센터. 해당 포지션 자격자가 모자라면 그만큼 빈다(채워 넣지 않음). */
  players: RoundAwardRow[];
};

export type RoundAwardsResult = {
  seasonName: string;
  round: number;
  roundCount: number;
  gamesTotal: number;
  gamesEnded: number;
  qualify: typeof ROUND_QUALIFY;
  mvpBoards: RoundMvpBoard[];
  positionBoards: PositionBestBoard[];
  allStarTeams: AllStarTeam[];
  /** "최고의 순간" top5 - 한 경기의 가장 극적인 역전 드라마(팀 단위). */
  bestMoments: Comeback[];
  /** "가장 임팩트있는 장면" top10 - 경기당 승률을 가장 크게 끌어올린 개인 플레이 하나씩. */
  impactPlays: BigPlay[];
};

export type PlayerDirectoryInfo = { role: string | null; name: string; photoUrl: string | null };

function roleKey(role: string | null): RoundRoleKey {
  if (!role) return "domestic";
  return role.includes("아시아") ? "asiaQuota" : "import";
}

/** 자격 통과(라운드 내 3경기 또는 50분 이상)한 선수만. 두 어워드가 같은 기준을 쓴다. */
function qualifiedAggs(aggs: SeasonPlayerAgg[]): SeasonPlayerAgg[] {
  return aggs.filter((a) => a.gp >= ROUND_QUALIFY.gp || a.minutes >= ROUND_QUALIFY.minutes);
}

function toRow(a: SeasonPlayerAgg, infoByPcode: Map<string, PlayerDirectoryInfo>, teams: Map<string, TeamInfo>): RoundAwardRow {
  const info = infoByPcode.get(a.pcode);
  const pos = normalizePos(a.pos);
  return {
    pcode: a.pcode,
    name: info?.name ?? a.pcode,
    tcode: a.tcode,
    team: teams.get(a.tcode) ?? null,
    photoUrl: info?.photoUrl ?? null,
    pos,
    posLabel: posLabel(pos),
    gp: a.gp,
    minutes: a.minutes,
    perW: a.perW,
    pts: a.pts,
    reb: a.reb,
    ast: a.ast,
    stl: a.stl,
    blk: a.blk,
    tpm: a.tpm,
  };
}

const byPerThenMinutes = (a: SeasonPlayerAgg, b: SeasonPlayerAgg) => b.perW - a.perW || b.minutes - a.minutes;

/** 순수 버킷팅/정렬부 - Supabase 없이 단위 테스트 가능(lib/roundAwards.test.ts). */
export function buildRoundMvpBoards(
  aggs: SeasonPlayerAgg[],
  infoByPcode: Map<string, PlayerDirectoryInfo>,
  teams: Map<string, TeamInfo>,
  topN = 5
): RoundMvpBoard[] {
  const buckets: Record<RoundRoleKey, SeasonPlayerAgg[]> = { domestic: [], import: [], asiaQuota: [] };
  for (const a of qualifiedAggs(aggs)) {
    buckets[roleKey(infoByPcode.get(a.pcode)?.role ?? null)].push(a);
  }
  return (["domestic", "import", "asiaQuota"] as const).map((role) => {
    const pool = [...buckets[role]].sort(byPerThenMinutes);
    return {
      role,
      label: ROUND_ROLE_LABEL[role],
      poolN: pool.length,
      rows: pool.slice(0, topN).map((a) => toRow(a, infoByPcode, teams)),
    };
  });
}

/** 포지션별 베스트(G/F/C 1~3위) - MVP와 같은 자격·같은 순위 기준(출전시간 가중 PER 평균),
 * 그룹 기준만 국적 역할 대신 포지션. 포지션 미확인(null)인 행은 어느 보드에도 넣지 않는다. */
export function buildPositionBestBoards(
  aggs: SeasonPlayerAgg[],
  infoByPcode: Map<string, PlayerDirectoryInfo>,
  teams: Map<string, TeamInfo>,
  topN = 3
): PositionBestBoard[] {
  const buckets: Record<PositionKey, SeasonPlayerAgg[]> = { G: [], F: [], C: [] };
  for (const a of qualifiedAggs(aggs)) {
    const pos = normalizePos(a.pos);
    if (pos) buckets[pos].push(a);
  }
  return (["G", "F", "C"] as const).map((pos) => {
    const pool = [...buckets[pos]].sort(byPerThenMinutes);
    return {
      pos,
      label: POSITION_LABEL[pos],
      poolN: pool.length,
      rows: pool.slice(0, topN).map((a) => toRow(a, infoByPcode, teams)),
    };
  });
}

/** 올스타팀 퍼스트/세컨드/써드(사용자 요청) - NBA 올-리그 팀과 같은 2가드+2포워드+1센터
 * 구성. 새 순위를 만들지 않고 buildPositionBestBoards를 포지션당 6명(가드·포워드는 팀당 2명
 * × 3팀, 센터는 팀당 1명 × 3팀 = 3명이면 충분하지만 가드·포워드 커트라인에 맞춰 6명 통일)으로
 * 넉넉히 뽑은 뒤 2/2/1씩 세 팀에 나눠 담는다. */
export function buildAllStarTeams(
  aggs: SeasonPlayerAgg[],
  infoByPcode: Map<string, PlayerDirectoryInfo>,
  teams: Map<string, TeamInfo>
): AllStarTeam[] {
  const posBoards = buildPositionBestBoards(aggs, infoByPcode, teams, 6);
  const guards = posBoards.find((b) => b.pos === "G")?.rows ?? [];
  const forwards = posBoards.find((b) => b.pos === "F")?.rows ?? [];
  const centers = posBoards.find((b) => b.pos === "C")?.rows ?? [];
  return ([1, 2, 3] as const).map((tier) => ({
    tier,
    label: ALL_STAR_TIER_LABEL[tier],
    players: [
      ...guards.slice((tier - 1) * 2, tier * 2),
      ...forwards.slice((tier - 1) * 2, tier * 2),
      ...centers.slice(tier - 1, tier),
    ],
  }));
}

export async function getRoundAwards(seasonName: string, round?: number): Promise<RoundAwardsResult> {
  const { games, round: r, roundCount } = await getRoundGames(seasonName, undefined, round);
  const ended = games.filter((g) => g.is_ended);
  if (!ended.length) {
    return {
      seasonName,
      round: r,
      roundCount,
      gamesTotal: games.length,
      gamesEnded: 0,
      qualify: ROUND_QUALIFY,
      mvpBoards: [],
      positionBoards: [],
      allStarTeams: [],
      bestMoments: [],
      impactPlays: [],
    };
  }

  const gmkeys = ended.map((g) => g.gmkey);
  const [rows, winMoments] = await Promise.all([
    fetchAllPagesBounded<PlayerGameRow>((from, to) =>
      supabase.from("game_player_stats").select(PLAYER_SELECT, { count: "exact" }).in("gmkey", gmkeys).range(from, to)
    ),
    getRoundWinMoments(seasonName, gmkeys),
  ]);
  const aggs = aggregateSeasonPlayers(rows).filter((a) => a.gp > 0);

  const [directory, teams] = await Promise.all([getSeasonDirectory(seasonName), getTeams(seasonName)]);
  const infoByPcode = new Map<string, PlayerDirectoryInfo>();
  for (const dt of directory) {
    for (const p of dt.players) {
      if (p.pcode) infoByPcode.set(p.pcode, { role: p.role, name: p.name, photoUrl: p.photoUrl });
    }
  }

  return {
    seasonName,
    round: r,
    roundCount,
    gamesTotal: games.length,
    gamesEnded: ended.length,
    qualify: ROUND_QUALIFY,
    mvpBoards: buildRoundMvpBoards(aggs, infoByPcode, teams, 5),
    positionBoards: buildPositionBestBoards(aggs, infoByPcode, teams, 3),
    allStarTeams: buildAllStarTeams(aggs, infoByPcode, teams),
    bestMoments: winMoments.bestMoments,
    impactPlays: winMoments.impactPlays,
  };
}
