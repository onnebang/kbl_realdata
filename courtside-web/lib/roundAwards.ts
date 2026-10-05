import { supabaseServer as supabase } from "./supabaseServer";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { getRoundGames } from "./homeGames";
import { getSeasonDirectory, getTeams, type TeamInfo } from "./preseason";
import { aggregateSeasonPlayers, PLAYER_SELECT, type PlayerGameRow, type SeasonPlayerAgg } from "./seasonLeaders";
import { normalizePos, posLabel } from "./teamSeasonStats";

// 라운드 MVP(국내/용병/아시아쿼터) - /awards/round-mvp.
//
// 새 계산식을 만들지 않았다: game_player_stats에 경기별 PER이 이미 있고,
// aggregateSeasonPlayers()(lib/seasonLeaders.ts)는 "선수-경기 행 묶음 → 선수별 집계(출전시간
// 가중 PER 평균 포함)"를 하는 순수 함수라, 시즌 전체 대신 이 라운드 경기들만 넘기면 그대로
// 라운드 집계가 된다. 국내/용병/아시아쿼터 구분도 getSeasonDirectory(season_roster.note 기반,
// lib/preseason.ts의 roleFromNote와 같은 규칙)를 그대로 쓴다.
//
// 선정 기준은 순수하게 스탯(출전시간 가중 PER 평균)이다 - 팀 성적·서사는 반영하지 않고 그
// 사실을 화면에 명시한다(시즌 리더보드와 같은 "자격 기준 없는 순위표는 거짓말" 기조).

export type RoundRoleKey = "domestic" | "import" | "asiaQuota";

export const ROUND_ROLE_LABEL: Record<RoundRoleKey, string> = {
  domestic: "국내",
  import: "용병",
  asiaQuota: "아시아쿼터",
};

/** 시즌 리더보드 자격(15경기 또는 300분, lib/seasonLeaders.ts LEADER_QUALIFY)을 라운드 최대
 * 경기 수(10팀 기준 라운드당 9경기)에 맞춰 스케일: 15/54*9≈2.5→3경기, 300/54*9≈50분. */
export const ROUND_QUALIFY = { gp: 3, minutes: 50 } as const;

export type RoundMvpRow = {
  pcode: string;
  name: string;
  tcode: string;
  team: TeamInfo | null;
  photoUrl: string | null;
  pos: "G" | "F" | "C" | null;
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
  rows: RoundMvpRow[];
};

export type RoundMvpResult = {
  seasonName: string;
  round: number;
  roundCount: number;
  gamesTotal: number;
  gamesEnded: number;
  qualify: typeof ROUND_QUALIFY;
  boards: RoundMvpBoard[];
};

export type PlayerDirectoryInfo = { role: string | null; name: string; photoUrl: string | null };

function roleKey(role: string | null): RoundRoleKey {
  if (!role) return "domestic";
  return role.includes("아시아") ? "asiaQuota" : "import";
}

/** 순수 버킷팅/정렬부 - Supabase 없이 단위 테스트 가능(lib/roundAwards.test.ts). */
export function buildRoundMvpBoards(
  aggs: SeasonPlayerAgg[],
  infoByPcode: Map<string, PlayerDirectoryInfo>,
  teams: Map<string, TeamInfo>,
  topN = 5
): RoundMvpBoard[] {
  const qualified = aggs.filter((a) => a.gp >= ROUND_QUALIFY.gp || a.minutes >= ROUND_QUALIFY.minutes);
  const buckets: Record<RoundRoleKey, SeasonPlayerAgg[]> = { domestic: [], import: [], asiaQuota: [] };
  for (const a of qualified) {
    buckets[roleKey(infoByPcode.get(a.pcode)?.role ?? null)].push(a);
  }
  return (["domestic", "import", "asiaQuota"] as const).map((role) => {
    const pool = [...buckets[role]].sort((a, b) => b.perW - a.perW || b.minutes - a.minutes);
    const rows: RoundMvpRow[] = pool.slice(0, topN).map((a) => {
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
    });
    return { role, label: ROUND_ROLE_LABEL[role], poolN: pool.length, rows };
  });
}

export async function getRoundMvp(seasonName: string, round?: number, topN = 5): Promise<RoundMvpResult> {
  const { games, round: r, roundCount } = await getRoundGames(seasonName, undefined, round);
  const ended = games.filter((g) => g.is_ended);
  if (!ended.length) {
    return { seasonName, round: r, roundCount, gamesTotal: games.length, gamesEnded: 0, qualify: ROUND_QUALIFY, boards: [] };
  }

  const gmkeys = ended.map((g) => g.gmkey);
  const rows = await fetchAllPagesBounded<PlayerGameRow>((from, to) =>
    supabase.from("game_player_stats").select(PLAYER_SELECT, { count: "exact" }).in("gmkey", gmkeys).range(from, to)
  );
  const aggs = aggregateSeasonPlayers(rows).filter((a) => a.gp > 0);

  const [directory, teams] = await Promise.all([getSeasonDirectory(seasonName), getTeams(seasonName)]);
  const infoByPcode = new Map<string, PlayerDirectoryInfo>();
  for (const dt of directory) {
    for (const p of dt.players) {
      if (p.pcode) infoByPcode.set(p.pcode, { role: p.role, name: p.name, photoUrl: p.photoUrl });
    }
  }

  const boards = buildRoundMvpBoards(aggs, infoByPcode, teams, topN);
  return { seasonName, round: r, roundCount, gamesTotal: games.length, gamesEnded: ended.length, qualify: ROUND_QUALIFY, boards };
}
