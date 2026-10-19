import { supabaseServer as supabase } from "./supabaseServer";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { getRoundGames } from "./homeGames";
import { getSeasonDirectory, getTeams, type TeamInfo } from "./preseason";
import {
  aggregateSeasonPlayers,
  isQualified,
  PLAYER_SELECT,
  qualifyRule,
  teamGameCounts,
  type PlayerGameRow,
  type SeasonPlayerAgg,
} from "./seasonLeaders";
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

export type RoundAwardRow = {
  pcode: string;
  name: string;
  tcode: string;
  team: TeamInfo | null;
  photoUrl: string | null;
  pos: PositionKey | null;
  posLabel: string;
  /** 국내 / 용병 / 아시아쿼터(season_roster.note 기준). 올스타팀 한도 판정과 화면 표기에 쓴다. */
  role: RoundRoleKey;
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
  /** 자격 기준 예시 - 이 라운드에서 가장 많이 치른 팀 기준(실제로는 팀마다 자기 경기 수로 적용). teamGames 0 = 아직 없음. */
  qualify: { teamGames: number; gp: number; minutes: number };
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

/** 라운드 자격 = 시즌 리더보드의 시즌 초반 기준(lib/seasonLeaders.ts qualifyRule/isQualified)을 소속팀이 이
 * 라운드에서 치른 경기 수에 적용한다: 팀 경기의 절반 이상(최소 2경기) 출전 AND 누적 팀 경기당 8분 이상
 * (팀 6경기면 3경기·48분). 예전 "3경기 또는 50분"은 OR라서 1~2분씩 3번 뛴 벤치가 통과했다 - 경기 PER은
 * 분당 비율이라 0.98분에 3점 하나로 193.3이 나오고, 총 4.5분이라 출전시간 가중 평균도 못 눌러 2026-27 1라운드
 * 국내 MVP 1위가 PER 42.2(3경기 1.7점)였다. 시즌 리더보드가 같은 이유로 이미 AND로 바꿔 둔 기준이라 새 숫자를
 * 만들지 않았다.
 *
 * MVP·포지션 베스트·올스타가 같은 목록을 쓰도록 getRoundAwards가 한 번만 거르고, 아래 build*는 이미 거른 목록을
 * 받는다. 팀 경기 수를 모르는 tcode는 가장 많이 치른 팀 기준으로 본다 - 모르면 느슨하게 통과시키지 않는다. */
export function qualifyRoundAggs(aggs: SeasonPlayerAgg[], teamGames: ReadonlyMap<string, number>): SeasonPlayerAgg[] {
  const most = Math.max(0, ...teamGames.values());
  return aggs.filter((a) => isQualified(a, qualifyRule(teamGames.get(a.tcode) ?? most)));
}

function qualifyInfo(teamGames: number): RoundAwardsResult["qualify"] {
  const rule = qualifyRule(teamGames);
  return { teamGames, gp: rule.gp, minutes: rule.min };
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
    role: roleKey(info?.role ?? null),
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

/** 순수 버킷팅/정렬부 - Supabase 없이 단위 테스트 가능(lib/roundAwards.test.ts). aggs는 qualifyRoundAggs를 거친 목록. */
export function buildRoundMvpBoards(
  aggs: SeasonPlayerAgg[],
  infoByPcode: Map<string, PlayerDirectoryInfo>,
  teams: Map<string, TeamInfo>,
  topN = 5
): RoundMvpBoard[] {
  const buckets: Record<RoundRoleKey, SeasonPlayerAgg[]> = { domestic: [], import: [], asiaQuota: [] };
  for (const a of aggs) {
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
  for (const a of aggs) {
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

/** 올스타 한 팀의 자리(2가드+2포워드+1센터)와 국적 한도(사용자 요청 2026-10-20: 용병 최대 2명, 아시아쿼터 최대 1명 -
 * 나머지는 국내). 한도는 "최대"라서 국내 선수만으로 채운 팀도 유효하다. */
const ALL_STAR_SLOTS: Record<PositionKey, number> = { G: 2, F: 2, C: 1 };
const ALL_STAR_FOREIGN_MAX = { import: 2, asiaQuota: 1 } as const;

/** 올스타팀 퍼스트/세컨드/써드(사용자 요청) - NBA 올-리그 팀과 같은 2가드+2포워드+1센터 구성에 위 국적 한도를 건다.
 * 새 순위를 만들지 않는다: 포지션이 확인된 선수를 PER 높은 순(같으면 출전시간 많은 쪽)으로 훑으며, 그 포지션 자리가
 * 남아 있고 용병·아시아쿼터 한도가 안 찼으면 이번 팀에 넣는다. 한도 때문에 못 들어간 선수(예: 셋째 용병)는 다음 팀
 * 후보로 남고, 퍼스트 → 세컨드 → 써드 순으로 남은 선수에게 같은 일을 반복한다. 조건에 맞는 선수가 모자라면 그 자리는
 * 비운다(억지로 채우지 않음). 팀 안 표시 순서는 가드 → 포워드 → 센터, 같은 포지션끼리는 PER 순. */
export function buildAllStarTeams(
  aggs: SeasonPlayerAgg[],
  infoByPcode: Map<string, PlayerDirectoryInfo>,
  teams: Map<string, TeamInfo>
): AllStarTeam[] {
  type Cand = { a: SeasonPlayerAgg; pos: PositionKey; role: RoundRoleKey };
  let pool: Cand[] = [];
  for (const a of aggs) {
    const pos = normalizePos(a.pos);
    if (pos) pool.push({ a, pos, role: roleKey(infoByPcode.get(a.pcode)?.role ?? null) });
  }
  pool.sort((x, y) => byPerThenMinutes(x.a, y.a));

  const out: AllStarTeam[] = [];
  for (const tier of [1, 2, 3] as const) {
    const open = { ...ALL_STAR_SLOTS };
    const used: Record<RoundRoleKey, number> = { domestic: 0, import: 0, asiaQuota: 0 };
    const picked: Cand[] = [];
    for (const c of pool) {
      if (open[c.pos] === 0) continue;
      if (c.role !== "domestic" && used[c.role] >= ALL_STAR_FOREIGN_MAX[c.role]) continue;
      open[c.pos] -= 1;
      used[c.role] += 1;
      picked.push(c);
    }
    pool = pool.filter((c) => !picked.includes(c));
    out.push({
      tier,
      label: ALL_STAR_TIER_LABEL[tier],
      players: (["G", "F", "C"] as const)
        .flatMap((pos) => picked.filter((c) => c.pos === pos))
        .map((c) => toRow(c.a, infoByPcode, teams)),
    });
  }
  return out;
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
      qualify: qualifyInfo(0),
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
  const { byTcode: teamGames, max: mostTeamGames } = teamGameCounts(
    ended.map((g) => ({ homeTcode: g.home_team?.tcode ?? "", awayTcode: g.away_team?.tcode ?? "" }))
  );
  const aggs = qualifyRoundAggs(aggregateSeasonPlayers(rows).filter((a) => a.gp > 0), teamGames);

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
    qualify: qualifyInfo(mostTeamGames),
    mvpBoards: buildRoundMvpBoards(aggs, infoByPcode, teams, 5),
    positionBoards: buildPositionBestBoards(aggs, infoByPcode, teams, 3),
    allStarTeams: buildAllStarTeams(aggs, infoByPcode, teams),
    bestMoments: winMoments.bestMoments,
    impactPlays: winMoments.impactPlays,
  };
}
