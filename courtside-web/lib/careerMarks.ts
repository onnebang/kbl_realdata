import marksRaw from "./career_marks.json";
import { cachedFn, TTL } from "./cachePolicy";
import { MAX_GAIN, MILESTONE_CATS, type MilestoneCat, type MilestoneContext, type MilestonePlayer, type MilestoneTarget } from "./milestones";
import { getTeamRoster } from "./playerPageData";
import { supabaseServer as supabase } from "./supabaseServer";

// 라이브 경기 "기록 워치"(lib/milestones.ts)의 서버 쪽 재료 만들기 - 이 경기 직전까지의 선수별 통산 합계·순위·커리어 하이로
// "이 경기에서 달성할 수 있는 목표"를 선수별로 미리 뽑아 클라이언트에 내려준다(클라이언트는 경기 중 기록만 더해 비교).
//
// 통산 합계는 tools/build_alltime_leaders.py가 주 1회 굽는 스냅샷(lib/career_marks.json, 올타임 리더스와 같은 값)에
// "스냅샷 이후에 끝난 경기"를 Supabase에서 더해 항상 이 경기 직전 기준으로 맞춘다 - 스냅샷이 몇 경기씩 낡은 채로 쓰면
// 100개 단위 이정표나 순위 돌파 알림이 틀린다. 이미 스냅샷에 들어 있는데 이 경기보다 뒤인 경기(오래된 경기를 볼 때)는 뺀다.

type Split = "regular" | "playoffs";
/** [pts, reb, ast, stl, blk, threep, gp] */
type Totals = number[];
export type Snapshot = {
  asOf: string;
  recentFrom: string;
  recentGmkeys: string[];
  players: Record<string, { n: string; a: 0 | 1; reg: Totals; po: Totals; hi: number[] | null }>;
};
export type DeltaGame = {
  gmkey: string;
  game_date: string;
  season_category: string;
  rows: { pcode: string; pts: number; reb: number; ast: number; stl: number; blk: number; tpm: number }[];
};

const SNAPSHOT = marksRaw as unknown as Snapshot;

/** 순위 돌파 목표를 만들 최대 순위(그 밖의 순위 돌파는 알리지 않는다). 사용자 결정 2026-10-07: 올타임 100위·현역 50위까지 열어 자주 뜨게 한다
 *  (처음엔 30/15였다 - 실데이터 S49G01N8에서 50/30만 돼도 "현역 블록 21위" 같은 잔재미 알림이 늘어 줄였는데, 그 빈도를 원한다는 결정). */
export const RANK_CAP = { all: 100, active: 50 } as const;
/** 커리어 하이 알림의 노이즈 컷 - 하이 자체가 이만큼은 돼야 의미가 있고, 신인의 첫 몇 경기(하이가 곧 평균)는 뺀다. */
export const HIGH_MIN: Record<MilestoneCat, number> = { pts: 15, reb: 8, ast: 6, stl: 3, blk: 3, threep: 4 };
export const HIGH_MIN_GP = 15;
/** 스냅샷 기준일과 이 경기 날짜가 이보다 벌어지면 보정할 경기가 너무 많아져 기능을 끈다. */
const MAX_GAP_DAYS = 60;
const STEP = 100;

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const splitOf = (category: string): Split | null =>
  category === "정규시즌" ? "regular" : category === "플레이오프" || category === "챔피언결정전" ? "playoffs" : null;

const CAT_INDEX: Record<MilestoneCat, number> = { pts: 0, reb: 1, ast: 2, stl: 3, blk: 4, threep: 5 };
const rowStat = (r: DeltaGame["rows"][number], cat: MilestoneCat) => (cat === "threep" ? r.tpm : r[cat]) ?? 0;

type Adjusted = {
  name: string;
  active: boolean;
  /** 이 경기가 속한 통산표(정규/플레이오프)의 합계 - [pts, reb, ast, stl, blk, threep, gp]. */
  totals: Totals;
  /** 정규+플레이오프 합친 출전 경기 수(커리어 하이 노이즈 컷용). */
  gpAll: number;
  /** 한 경기 커리어 하이(정규+플레이오프) - 스냅샷 값에 추가 경기의 최댓값을 합친 것. */
  hi: number[] | null;
  /** 부문별로 hi를 믿어도 되는지 - 뺀 경기가 하이 자리를 차지했을 수 있으면 false. */
  hiOk: boolean[] | null;
};

/** 이 값을 가진 선수의 순위 = 그보다 큰 값을 가진 선수 수 + 1(동률은 같은 순위). list는 값 오름차순. */
function rankOf(list: { value: number }[], value: number): number {
  const i = list.findIndex((e) => e.value > value);
  return (i === -1 ? 0 : list.length - i) + 1;
}

/**
 * 순수 함수 - 스냅샷에 "이 경기 직전" 보정을 입히고 players 각자의 목표를 만든다(Supabase 없이 테스트 가능).
 * gameDate보다 이른 경기만 합계에 들어간다: 스냅샷에 없는 경기는 더하고, 스냅샷에 있는데 gameDate 이후인 경기는 뺀다.
 */
export function buildMilestoneContext(args: {
  snapshot: Snapshot;
  games: DeltaGame[];
  gameDate: string;
  split: Split;
  /** 이 경기에 나올 수 있는 선수들(박스/로스터). 이름은 스냅샷에 없을 때의 폴백. */
  players: { pcode: string; name: string; tcode?: string }[];
}): MilestoneContext {
  const { snapshot, games, gameDate, split, players } = args;
  const key = split === "regular" ? "reg" : "po";
  const recent = new Set(snapshot.recentGmkeys);
  const adj = new Map<string, Adjusted>();
  const get = (pcode: string, fallbackName = pcode): Adjusted => {
    let a = adj.get(pcode);
    if (!a) {
      const s = snapshot.players[pcode];
      a = {
        name: s?.n ?? fallbackName,
        active: s?.a === 1,
        totals: [...(s?.[key] ?? [0, 0, 0, 0, 0, 0, 0])],
        gpAll: (s?.reg?.[6] ?? 0) + (s?.po?.[6] ?? 0),
        hi: s?.hi ? [...s.hi] : null,
        hiOk: s?.hi ? s.hi.map(() => true) : null,
      };
      adj.set(pcode, a);
    }
    return a;
  };
  for (const [pcode, s] of Object.entries(snapshot.players)) get(pcode, s.n);

  for (const g of games) {
    const sp = splitOf(g.season_category);
    if (!sp) continue;
    const inSnapshot = g.game_date < snapshot.recentFrom ? true : recent.has(g.gmkey);
    const sign = inSnapshot && g.game_date >= gameDate ? -1 : !inSnapshot && g.game_date < gameDate ? 1 : 0;
    if (!sign) continue;
    for (const r of g.rows) {
      const a = get(r.pcode);
      a.gpAll += sign;
      if (sp === split) {
        MILESTONE_CATS.forEach((cat, i) => (a.totals[i] += sign * rowStat(r, cat)));
        a.totals[6] += sign;
      }
      // 커리어 하이는 최댓값이라 빼기가 안 된다 - 뺀 경기가 하이 자리를 차지했을 수 있는 부문은 "모름"으로 접는다.
      if (!a.hi || !a.hiOk) continue;
      if (sign > 0) {
        MILESTONE_CATS.forEach((cat, i) => (a.hi![i] = Math.max(a.hi![i], rowStat(r, cat))));
      } else {
        const hi0 = snapshot.players[r.pcode]?.hi;
        MILESTONE_CATS.forEach((cat, i) => {
          if (hi0 && rowStat(r, cat) >= hi0[i]) a.hiOk![i] = false;
        });
      }
    }
  }

  for (const p of players) get(p.pcode, p.name).active = true; // 이 경기에 나오는 선수는 현역이다

  // 부문별 순위표(올타임 / 현역), 값 오름차순.
  const board = (cat: MilestoneCat, activeOnly: boolean) =>
    [...adj.entries()]
      .filter(([, a]) => a.totals[CAT_INDEX[cat]] > 0 && (!activeOnly || a.active))
      .map(([pcode, a]) => ({ pcode, name: a.name, value: a.totals[CAT_INDEX[cat]] }))
      .sort((x, y) => x.value - y.value);
  const boards = Object.fromEntries(MILESTONE_CATS.map((cat) => [cat, { all: board(cat, false), active: board(cat, true) }])) as Record<
    MilestoneCat,
    { all: ReturnType<typeof board>; active: ReturnType<typeof board> }
  >;

  // ponytail: 아래 순위 목표는 (경기 선수 × 부문 × 범위)마다 board 전체를 훑고 후보마다 rankOf로 또 훑는다 - 역대 선수 수 N에 거의 N².
  // 실측(2026-10-07, N=1,049·선수 34명): 요청당 중앙 14ms, N 2배 ≈ 3배, 4배 ≈ 10배. N은 리그 역사(연 +50명 안팎)라 지금은 둔다.
  // 느려지면 board가 값 오름차순이니 이분 탐색으로 시작 위치와 순위를 구한다.
  const out: Record<string, MilestonePlayer> = {};
  for (const p of players) {
    const a = adj.get(p.pcode)!;
    const before = Object.fromEntries(MILESTONE_CATS.map((cat) => [cat, a.totals[CAT_INDEX[cat]]])) as Record<MilestoneCat, number>;
    const targets: MilestoneTarget[] = [];
    for (const cat of MILESTONE_CATS) {
      const b = before[cat];
      // 나를 뺀 순위표에서, 나와 같거나 앞선 선수를 가까운 순으로 넘어서는 목표(넘으려면 그 값 + 1).
      const rankTargets = (scope: "all" | "active") => {
        const others = boards[cat][scope].filter((e) => e.pcode !== p.pcode);
        const found: Extract<MilestoneTarget, { kind: "rank" }>[] = [];
        let lastAt = -1;
        for (const q of others) {
          if (q.value < b) continue;
          const at = q.value + 1;
          if (at - b > MAX_GAIN[cat]) break;
          if (at === lastAt) continue; // 같은 값의 동률 선수는 한 목표로
          const rank = rankOf(others, q.value);
          if (rank > RANK_CAP[scope]) continue;
          lastAt = at;
          found.push({ kind: "rank", cat, scope, at, rank, rival: { pcode: q.pcode, name: q.name, value: q.value } });
        }
        return found;
      };
      const allT = rankTargets("all");
      const activeT = rankTargets("active");
      for (const t of allT) {
        // 같은 선수를 현역 순위에서도 넘으면 한 줄로 합친다("올타임 10위 · 현역 3위").
        const twin = activeT.find((x) => x.at === t.at);
        targets.push(twin ? { ...t, activeRank: twin.rank } : t);
      }
      for (const t of activeT) if (!allT.some((x) => x.at === t.at)) targets.push(t);

      const nextStep = (Math.floor(b / STEP) + 1) * STEP;
      if (nextStep - b <= MAX_GAIN[cat]) targets.push({ kind: "step", cat, at: nextStep });

      const i = CAT_INDEX[cat];
      const hi = a.hi && a.hiOk?.[i] ? a.hi[i] : undefined;
      if (hi != null && hi >= HIGH_MIN[cat] && a.gpAll >= HIGH_MIN_GP) targets.push({ kind: "high", cat, high: hi });
    }
    if (targets.length) out[p.pcode] = { name: a.name, ...(p.tcode ? { tcode: p.tcode } : {}), before, targets };
  }
  return { split, asOf: snapshot.asOf, players: out };
}

/** 스냅샷 보정에 필요한 경기들(스냅샷 최근 구간 + 이 경기 날짜 이후) - 10분 캐시(이 경기 이전 날짜 경기만 쓰므로 당일엔 안 바뀐다). */
const fetchDeltaGames = cachedFn(
  async (from: string): Promise<DeltaGame[]> => {
    const { data, error } = await supabase
      .from("games")
      .select("gmkey, game_date, season_category, game_player_stats(pcode, pts, reb, ast, stl, blk, tpm)")
      .eq("is_ended", true)
      .in("season_category", ["정규시즌", "플레이오프", "챔피언결정전"])
      .gte("game_date", from)
      .order("game_date", { ascending: true });
    // 실패를 []로 삼키면 unstable_cache가 그 "보정할 경기 없음"을 10분간 굳혀 합계가 틀린 채 알림이 나간다(DB가 에러를 내는 건 대개
    // 트래픽이 몰릴 때다). 던지면 캐시에 안 들어가고, 호출부 soft()가 패널만 비운다.
    if (error) throw new Error(`careerMarksDelta: ${error.message}`);
    return (data ?? []).map((g) => ({
      gmkey: g.gmkey as string,
      game_date: g.game_date as string,
      season_category: g.season_category as string,
      rows: ((g.game_player_stats ?? []) as DeltaGame["rows"]).map((r) => ({
        pcode: r.pcode,
        pts: r.pts ?? 0,
        reb: r.reb ?? 0,
        ast: r.ast ?? 0,
        stl: r.stl ?? 0,
        blk: r.blk ?? 0,
        tpm: r.tpm ?? 0,
      })),
    }));
  },
  { name: "careerMarksDelta", ttl: TTL.scheduled }
);

/** 팀 로스터는 하루 단위로 안 바뀐다 - 경기 페이지를 열 때마다 두 번씩 치지 않게 1시간 캐시. */
const cachedRoster = cachedFn(
  async (tcode: string, season: string) => {
    const roster = await getTeamRoster(tcode, season);
    // getTeamRoster는 조회 실패를 []로 삼킨다 - 그대로 1시간 캐시하면 그동안 이 팀 선수가 통째로 빠진다. 빈 로스터는 캐시에 안 넣는다
    // (호출부 .catch가 박스 선수만으로 이어 간다).
    if (!roster.length) throw new Error(`milestoneRoster: empty ${tcode}/${season}`);
    return roster;
  },
  { name: "milestoneRoster", ttl: TTL.batchDaily }
);

/**
 * 경기 페이지용 - 이 경기에 뛸 선수들의 "달성 가능 기록" 재료. 전시경기(OPEN MATCH DAY)는 통산에 안 들어가므로 null,
 * 스냅샷과 너무 멀리 떨어진 오래된 경기도 null. 목표가 하나도 없어도 null(패널을 그릴 이유가 없다).
 * boxPlayers: 이 경기 박스/이벤트에 나온 선수. 시즌 로스터(진행 중 경기는 아직 안 나온 벤치 선수 포함)와 합친다.
 */
export async function getMilestoneContext(
  game: { game_date: string; season_category: string; season_name: string; home_team?: { tcode: string } | null; away_team?: { tcode: string } | null },
  boxPlayers: { pcode: string; name: string; tcode?: string }[]
): Promise<MilestoneContext | null> {
  const split = splitOf(game.season_category);
  if (!split || dayDiff(game.game_date, SNAPSHOT.asOf) > MAX_GAP_DAYS) return null;
  const tcodes = [game.home_team?.tcode, game.away_team?.tcode];
  const rosters = await Promise.all(tcodes.map((t) => (t ? cachedRoster(t, game.season_name).catch(() => []) : Promise.resolve([]))));
  const byPcode = new Map<string, { name: string; tcode?: string }>();
  rosters.forEach((list, i) => list.forEach((r) => byPcode.set(r.pcode, { name: r.name, tcode: tcodes[i] ?? undefined })));
  for (const p of boxPlayers) byPcode.set(p.pcode, { name: p.name, tcode: p.tcode });
  const from = game.game_date < SNAPSHOT.recentFrom ? game.game_date : SNAPSHOT.recentFrom;
  const games = await fetchDeltaGames(from);
  const ctx = buildMilestoneContext({
    snapshot: SNAPSHOT,
    games,
    gameDate: game.game_date,
    split,
    players: [...byPcode].map(([pcode, v]) => ({ pcode, ...v })),
  });
  return Object.keys(ctx.players).length ? ctx : null;
}
