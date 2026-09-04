import { PRESEASON_SEASON, getTeams, isRealGmkey, prevSeasonName, type TeamInfo } from "./preseason";
import { supabase } from "./supabase";
import { MARGIN_TO_LOGIT, getStrengthAdjustment, type StrengthAdjustment, type TeamAdjustment } from "./strengthAdjustment";
import { memoAsync } from "./memo";

// 정규시즌 전체(54경기) 전망 - 요청: "기대승수가 26경기 기준이다보니 파워를 가늠하기 어려워,
// 9경기씩 6라운드 총 54경기인데, 전반기 3라운드까지와, 6라운드 54경기 전체 기대승수와 AI 예상
// 순위를 적어줘".
//
// ── 일정은 이제 전부 있다 (2026-09-05) ───────────────────────────────────────────
// 한동안 이 모듈은 "KBL 공개분이 131경기뿐"이라는 전제 위에 서 있었다. 실제로는 KBL이 270경기를
// 다 올려 뒀고, 우리 수집기(tools/sync_upcoming_games.py)의 조회 창이 120일이라 2027-01-02에서
// 잘렸던 것이다. 창을 넓혀 받으니 정규시즌 270경기 전부가 들어왔다(2026-10-03 ~ 2027-04-11,
// 팀당 54경기, 홈 27 · 원정 27, 90개 순서쌍이 전부 정확히 3경기 - 전수 확인).
//
// 그래서 전반기도 추정이 아니다. 각 팀의 날짜순 앞 27경기를 그대로 세면 된다. 실측하면 8팀은
// 그 27경기가 상대별 정확히 3경기이고, 삼성·SK만 한 상대와 2경기/다른 상대와 4경기다 - 그것도
// 실제 편성이라 보정 대상이 아니다.
//
// 보정 경로(아래 filled / halfFilled)는 지우지 않고 남긴다. 다음 시즌 개막 전엔 다시 일정이
// 부분 공개될 수 있고, 그때 이 모듈이 조용히 틀린 값을 내는 것보다 낫다. 지금은 0이다.
//
// ── 승률의 출처 ──────────────────────────────────────────────────────────────────
// pregame_features.home_win_prob(경기 전 모델)은 같은 순서쌍이면 값이 사실상 같다(실측: 순서쌍
// 안 min/max 차이가 최대 0.002 - 휴식일 같은 미세 피처 차이). 그래서 "순서쌍 -> 승률"이 이
// 모델의 실체이고, 이제 90쌍 전부가 모델이 직접 매긴 값이다. 순서쌍이 비었을 때만 반대 방향
// 값을 홈코트 이점으로 뒤집어 채운다: logit p(A홈) + logit p(B홈) = 2h 이므로
// p(A홈) = sigmoid(2h - logit p(B홈)). h는 양방향이 다 있는 쌍의 평균에서 뽑는다.
//
// ── AI 예상 순위 ────────────────────────────────────────────────────────────────
// 기대승수 순위는 "평균적으로 몇 승"만 말하고 "1위 할 확률"은 말하지 못한다. 그래서 완전
// 균형 54경기 일정(순서쌍마다 3경기)을 시드 고정 PRNG로 SIMS번 돌려 순위 분포를 낸다.
// 시드를 고정하는 이유: 서버 컴포넌트가 렌더될 때마다 순위 확률이 흔들리면 안 된다.

/** KBL 정규시즌: 9개 상대 × 6라운드 = 54경기. 상대별 홈 3 · 원정 3. */
export const ROUNDS_TOTAL = 6;
export const GAMES_FULL = 54;
/** 전반기 = 3라운드 = 상대별 3경기. */
export const ROUNDS_HALF = 3;
export const GAMES_HALF = 27;
/** 6강 플레이오프 - 정규시즌 6위까지 진출. */
export const PLAYOFF_SPOTS = 6;
/**
 * 시뮬레이션 횟수. 10만이면 해상도가 0.001%라 "1위 확률 0.03%" 같은 값을 두 자리로 적을 수 있다
 * (1만이면 해상도가 0.01%뿐이라 낮은 확률이 통째로 0으로 뭉갠다). 측정: 1만 94ms / 10만 838ms.
 */
export const SIMS = 100000;

/**
 * 확률 표기 - 요청: "1위확률이 0%인데 살짝 위험한 느낌이 들어서, 소수점 1자리까지 표시,
 * 혹시 0.1%보다 낮다면 소수점 2자리까지".
 *
 * 0%로 적으면 안 되는 이유: 시뮬레이션에서 한 번도 안 나왔다는 뜻이지 불가능하다는 뜻이 아니다.
 * 10만 번을 돌려도 못 본 값은 "0"이 아니라 "0.01% 미만"이 정확한 표현이다.
 */
export function formatOdds(p: number): string {
  const pct = p * 100;
  if (pct >= 0.1) return `${pct.toFixed(1)}%`;
  if (pct >= 0.005) return `${pct.toFixed(2)}%`; // 0.01% ~ 0.09%
  return "<0.01%";
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const pairKey = (home: string, away: string) => `${home}>${away}`;

export type ScheduledGame = { gmkey: string; gameDate: string; home: string; away: string };

/** 예정 경기 + 경기 전 승률. getSeasonOutlook과 이 모듈이 같은 조회를 두 번 하지 않도록 공용. */
export async function fetchScheduleWithProbs(season: string): Promise<{
  games: ScheduledGame[];
  probs: Map<string, number>;
}> {
  const { data } = await supabase
    .from("games")
    .select("gmkey, game_date, home_tcode, away_tcode")
    .eq("season_name", season)
    .order("game_date");
  const games: ScheduledGame[] = (data ?? [])
    .filter((g) => isRealGmkey(g.gmkey as string))
    .map((g) => ({
      gmkey: g.gmkey as string,
      gameDate: g.game_date as string,
      home: g.home_tcode as string,
      away: g.away_tcode as string,
    }));

  const probs = new Map<string, number>();
  for (let i = 0; i < games.length; i += 200) {
    const chunk = games.slice(i, i + 200).map((g) => g.gmkey);
    const { data: pf } = await supabase.from("pregame_features").select("gmkey, home_win_prob").in("gmkey", chunk);
    for (const r of pf ?? []) if (r.home_win_prob != null) probs.set(r.gmkey as string, Number(r.home_win_prob));
  }
  return { games, probs };
}

export type MatchupMatrix = {
  /** "홈>원정" -> 홈 승률. 90개 순서쌍 전부(모델 값 + 뒤집어 채운 값). */
  prob: Map<string, number>;
  tcodes: string[];
  /** 모델이 직접 매긴 순서쌍 수. */
  fromModel: number;
  /** 대칭으로 채운 순서쌍 수. */
  filled: number;
  /** 홈코트 이점(logit). 양방향이 다 있는 쌍에서만 추정. */
  hcaLogit: number;
  /** 같은 전력끼리 붙었을 때의 홈 승률. */
  hcaProb: number;
};

/** 예정 경기의 승률을 순서쌍 단위로 접어 90칸 매치업 행렬을 만든다. */
export function buildMatchupMatrix(games: ScheduledGame[], probs: Map<string, number>, tcodes: string[]): MatchupMatrix {
  // 같은 순서쌍이 여러 번 나오면 평균(실측상 차이가 0.002 이하라 어느 쪽이든 같지만,
  // "아무거나 하나" 대신 평균이면 실행마다 값이 흔들리지 않는다).
  const sum = new Map<string, { s: number; n: number }>();
  for (const g of games) {
    const p = probs.get(g.gmkey);
    if (p == null) continue;
    const k = pairKey(g.home, g.away);
    const cur = sum.get(k) ?? { s: 0, n: 0 };
    cur.s += p;
    cur.n += 1;
    sum.set(k, cur);
  }
  const prob = new Map<string, number>();
  for (const [k, v] of sum) prob.set(k, v.s / v.n);
  const fromModel = prob.size;

  // 홈코트 이점: 양방향이 다 있는 쌍에서 (logit pA + logit pB) / 2.
  const hs: number[] = [];
  for (let i = 0; i < tcodes.length; i++) {
    for (let j = i + 1; j < tcodes.length; j++) {
      const a = prob.get(pairKey(tcodes[i], tcodes[j]));
      const b = prob.get(pairKey(tcodes[j], tcodes[i]));
      if (a != null && b != null) hs.push((logit(a) + logit(b)) / 2);
    }
  }
  const hcaLogit = hs.length ? hs.reduce((t, v) => t + v, 0) / hs.length : 0;

  let filled = 0;
  for (const h of tcodes) {
    for (const a of tcodes) {
      if (h === a) continue;
      const k = pairKey(h, a);
      if (prob.has(k)) continue;
      const rev = prob.get(pairKey(a, h));
      // 반대 방향도 없으면(두 팀이 공개 일정에서 아예 안 만남) 채울 근거가 없다 - 비워 둔다.
      if (rev == null) continue;
      prob.set(k, sigmoid(2 * hcaLogit - logit(rev)));
      filled += 1;
    }
  }

  return { prob, tcodes, fromModel, filled, hcaLogit, hcaProb: sigmoid(hcaLogit) };
}

/** 상대별 홈 3 · 원정 3 항등식으로 나오는 54경기 기대승수. 일정 편성과 무관하다. */
function fullExpected(prob: Map<string, number>, tcodes: string[]): Map<string, number> {
  const p = (h: string, a: string) => prob.get(pairKey(h, a)) as number;
  const out = new Map<string, number>();
  for (const t of tcodes) {
    let e = 0;
    for (const o of tcodes) {
      if (t === o) continue;
      e += ROUNDS_HALF * p(t, o); // 홈 3경기
      e += ROUNDS_HALF * (1 - p(o, t)); // 원정 3경기
    }
    out.set(t, e);
  }
  return out;
}

type SimResult = {
  /** [팀 인덱스][순위] 확률. */
  rankDist: number[][];
  winsMean: number[];
  winsLo: number[];
  winsHi: number[];
};

/**
 * 완전 균형 54경기 일정을 SIMS번 돌린다. 시드를 고정하는 이유: 서버 컴포넌트가 렌더될 때마다
 * 순위 확률이 흔들리면 안 된다. 기본/조정 두 행렬에 같은 시드를 쓰므로 두 결과의 차이는
 * 오로지 승률 차이에서만 온다(난수 차이가 섞이지 않는다).
 */
function simulate(prob: Map<string, number>, tcodes: string[]): SimResult {
  const n = tcodes.length;
  const idx = new Map(tcodes.map((t, i) => [t, i]));
  // 순서쌍마다 3경기. 미리 평탄화해 두면 내부 루프에서 Map 조회가 사라진다.
  const gameHome: number[] = [];
  const gameAway: number[] = [];
  const gameP: number[] = [];
  for (const h of tcodes) {
    for (const a of tcodes) {
      if (h === a) continue;
      for (let k = 0; k < ROUNDS_HALF; k++) {
        gameHome.push(idx.get(h) as number);
        gameAway.push(idx.get(a) as number);
        gameP.push(prob.get(pairKey(h, a)) as number);
      }
    }
  }
  const rand = mulberry32(0x5cb1a5ed);
  const rankCount = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const winsSum = new Array<number>(n).fill(0);
  const winsHist = Array.from({ length: n }, () => new Array<number>(GAMES_FULL + 1).fill(0));
  const wins = new Float64Array(n);
  const order = new Array<number>(n);
  for (let s = 0; s < SIMS; s++) {
    wins.fill(0);
    for (let g = 0; g < gameP.length; g++) {
      if (rand() < gameP[g]) wins[gameHome[g]] += 1;
      else wins[gameAway[g]] += 1;
    }
    // 동률은 무작위로 가른다(KBL 실제 규정은 상대 전적 우선이지만, 시뮬레이션에서 그걸
    // 재현하려면 맞대결 결과를 따로 들고 있어야 한다 - 여기서는 편향 없는 무작위가 맞다).
    for (let i = 0; i < n; i++) {
      order[i] = i;
      wins[i] += rand() * 1e-6;
    }
    order.sort((x, y) => wins[y] - wins[x]);
    for (let r = 0; r < n; r++) {
      const team = order[r];
      rankCount[team][r] += 1;
      const w = Math.round(wins[team] - 5e-7);
      winsSum[team] += w;
      winsHist[team][Math.max(0, Math.min(GAMES_FULL, w))] += 1;
    }
  }
  const quantile = (hist: number[], q: number): number => {
    const target = SIMS * q;
    let acc = 0;
    for (let w = 0; w < hist.length; w++) {
      acc += hist[w];
      if (acc >= target) return w;
    }
    return hist.length - 1;
  };
  return {
    rankDist: rankCount.map((c) => c.map((v) => v / SIMS)),
    winsMean: winsSum.map((v) => v / SIMS),
    winsLo: winsHist.map((h) => quantile(h, 0.1)),
    winsHi: winsHist.map((h) => quantile(h, 0.9)),
  };
}

/**
 * 전력 델타를 매치업 행렬에 밀어 넣은 사본. 원본은 건드리지 않는다.
 * 델타의 리그 평균은 (Δ홈 - Δ원정)에서 저절로 상쇄되므로 중심화하지 않는다.
 */
function adjustMatrix(base: Map<string, number>, tcodes: string[], adj: StrengthAdjustment): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of tcodes) {
    for (const a of tcodes) {
      if (h === a) continue;
      const k = pairKey(h, a);
      const p0 = base.get(k);
      if (p0 == null) continue;
      const dh = adj.teams.get(h)?.dMarginTotal ?? 0;
      const da = adj.teams.get(a)?.dMarginTotal ?? 0;
      const z = logit(p0) + (dh - da) * MARGIN_TO_LOGIT;
      // 극단으로 밀리지 않게 잘라 둔다(시뮬레이션이 0/1 확률에서 퇴화하는 것을 막는다).
      out.set(k, Math.min(0.99, Math.max(0.01, sigmoid(z))));
    }
  }
  return out;
}

/** 시드 고정 PRNG(mulberry32) - 렌더마다 같은 순위 확률이 나오게. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ProjectionTeam = TeamInfo & {
  /** 공개 일정에서 이 팀에 실제로 편성된 경기 수(승률이 있는 것만). */
  schedN: number;
  /** 전반기 27경기를 채우려고 대칭으로 보탠 경기 수(일정이 다 있으면 0). */
  halfFilledN: number;
  /** 전반기 27경기 중 홈경기 수 - 팀마다 13 또는 14로 갈린다. */
  halfHomeN: number;
  /** 전반기 3라운드(27경기) 기대승수. */
  halfExp: number;
  /** 정규시즌 전체 54경기 기대승수. */
  fullExp: number;
  fullPct: number;
  /** 시뮬레이션 평균 승수(fullExp와 거의 같아야 한다 - 검산용). */
  simMean: number;
  /** 승수 80% 구간. */
  winsLo: number;
  winsHi: number;
  /** 정규시즌 1위 확률. */
  titleOdds: number;
  /** 6강 플레이오프 진출 확률. */
  playoffOdds: number;
  /** 가장 자주 나온 순위. */
  modalRank: number;
  /** 순위별 확률(길이 = 팀 수, 인덱스 0이 1위). */
  rankDist: number[];
  /** 기대승수 기준 순위(1부터). */
  expRank: number;
  prevW: number;
  prevL: number;
  prevPct: number | null;
  /**
   * 이탈·규정 변경·신입 스카우팅을 반영한 시나리오. 재료가 없으면 null.
   * **측정이 아니라 시나리오다** - lib/strengthAdjustment.ts 머리말을 읽을 것.
   */
  adj: {
    fullExp: number;
    winsLo: number;
    winsHi: number;
    titleOdds: number;
    playoffOdds: number;
    rankDist: number[];
    modalRank: number;
    expRank: number;
    /** 팀별 전력 델타 원자료(이탈/슬롯/기타/규정 분해 포함). */
    team: TeamAdjustment;
    /** 리그 평균을 뺀 상대 델타 - 순위는 차이로만 정해지므로 이 값이 읽을 값이다. */
    relMargin: number;
  } | null;
};

export type SeasonProjection = {
  season: string;
  prevSeason: string;
  teams: ProjectionTeam[];
  matrix: MatchupMatrix;
  /** 공개 일정 경기 수(승률이 매겨진 것만). */
  scheduledN: number;
  /** 전반기를 채우려고 보탠 경기 수(리그 전체). 일정이 전부 공개되면 0. */
  halfFilledN: number;
  /** 모든 팀이 54경기를 다 갖고 있는가 - 화면 문구가 이걸로 갈린다. */
  scheduleComplete: boolean;
  /** 조정 전망 재료(없으면 null - 화면은 기본 전망만 그린다). */
  adjustment: StrengthAdjustment | null;
  firstGameDate: string | null;
  lastGameDate: string | null;
  sims: number;
};

/**
 * 전반기(27경기)·전체(54경기) 기대승수 + 시뮬레이션 순위 분포.
 * 매치업 행렬이 불완전하면(팀 수가 10이 아니거나 순서쌍이 모자라면) null - 화면은 기존
 * 공개 일정 기준 표만 보여주면 된다.
 */
/**
 * 전망 한 판의 비용은 대부분 시뮬레이션이다(54경기 × SIMS × 2 시나리오). 그 결과는 같은 시즌
 * 안에서 배치가 돌기 전까지 바뀌지 않으므로 요청마다 다시 돌릴 이유가 없다.
 * 실측(2026-09-05, dev): 메모 없이 요청당 35~42초, SIMS를 2,000으로 낮추면 8초(= DB 왕복만).
 * TTL 10분이면 배치 갱신이 늦어도 다음 10분 안에 반영되고, 개막 후 라이브 경기 화면은
 * 이 함수를 쓰지 않으므로 30초 갱신 요구와 충돌하지 않는다.
 */
export const PROJECTION_TTL_MS = 10 * 60 * 1000;

export const getSeasonProjection = memoAsync(computeSeasonProjection, {
  name: "seasonProjection",
  ttlMs: PROJECTION_TTL_MS,
  key: (season) => season ?? PRESEASON_SEASON,
});

async function computeSeasonProjection(season = PRESEASON_SEASON): Promise<SeasonProjection | null> {
  const prevSeason = prevSeasonName(season);
  const [teamMap, sched, prevRes, adjustment] = await Promise.all([
    getTeams(season),
    fetchScheduleWithProbs(season),
    supabase
      .from("games")
      .select("home_tcode, away_tcode, home_score, away_score")
      .eq("season_name", prevSeason)
      .eq("is_ended", true)
      .eq("season_category", "정규시즌"),
    getStrengthAdjustment(season),
  ]);
  const { games, probs } = sched;
  const priced = games.filter((g) => probs.has(g.gmkey));
  if (!priced.length) return null;

  const tcodes = [...new Set(priced.flatMap((g) => [g.home, g.away]))].sort();
  if (tcodes.length < 2) return null;
  const matrix = buildMatchupMatrix(priced, probs, tcodes);
  // 순서쌍이 하나라도 비면 54경기 전망을 만들 수 없다(없는 대진을 지어내지 않는다).
  const needed = tcodes.length * (tcodes.length - 1);
  if (matrix.prob.size < needed) return null;

  const p = (h: string, a: string) => matrix.prob.get(pairKey(h, a)) as number;

  // ── 전반기: 각 팀의 날짜순 앞 27경기 ─────────────────────────────────────────────
  // 일정이 전부 있으므로 실제로 편성된 27경기를 그대로 센다. 상대별 3경기가 아니어도 손대지
  // 않는다 - 삼성·SK는 앞 27경기에서 한 상대와 2번, 다른 상대와 4번 만나는데 그게 실제 달력이다.
  const halfExp = new Map<string, number>();
  const schedN = new Map<string, number>();
  const filledN = new Map<string, number>();
  const halfHomeN = new Map<string, number>();
  const byTeam = new Map<string, ScheduledGame[]>();
  for (const t of tcodes) {
    halfExp.set(t, 0);
    schedN.set(t, 0);
    filledN.set(t, 0);
    halfHomeN.set(t, 0);
    byTeam.set(t, []);
  }
  for (const g of priced) {
    schedN.set(g.home, (schedN.get(g.home) as number) + 1);
    schedN.set(g.away, (schedN.get(g.away) as number) + 1);
    (byTeam.get(g.home) as ScheduledGame[]).push(g);
    (byTeam.get(g.away) as ScheduledGame[]).push(g);
  }
  const bump = (t: string, add: number) => halfExp.set(t, (halfExp.get(t) as number) + add);
  for (const t of tcodes) {
    const mine = (byTeam.get(t) as ScheduledGame[])
      .slice()
      .sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.gmkey.localeCompare(b.gmkey));
    const met = new Map<string, number>(); // 앞 27경기 안에서 상대별 맞대결 수
    for (const g of mine.slice(0, GAMES_HALF)) {
      const ph = probs.get(g.gmkey) as number;
      const isHome = g.home === t;
      bump(t, isHome ? ph : 1 - ph);
      if (isHome) halfHomeN.set(t, (halfHomeN.get(t) as number) + 1);
      const opp = isHome ? g.away : g.home;
      met.set(opp, (met.get(opp) ?? 0) + 1);
    }
    // 일정이 부분 공개인 시즌을 위한 보정 경로. 27경기가 다 있으면 여기는 아무것도 하지 않는다.
    // (보탠 경기의 홈/원정은 알 수 없으니 양쪽 홈 승률의 평균을 쓴다.)
    let short = GAMES_HALF - Math.min(mine.length, GAMES_HALF);
    for (const o of tcodes) {
      if (t === o || short <= 0) continue;
      const need = Math.min(short, ROUNDS_HALF - (met.get(o) ?? 0));
      if (need <= 0) continue;
      bump(t, need * ((p(t, o) + (1 - p(o, t))) / 2));
      filledN.set(t, (filledN.get(t) as number) + need);
      short -= need;
    }
  }

  // ── 전체 54경기 기대승수 + 시뮬레이션 ───────────────────────────────────────────
  // 조정 재료가 있으면 같은 일정을 두 번 돌린다(기본 / 조정). 시드가 같아서 두 결과의 차이는
  // 오로지 매치업 승률 차이에서만 온다.
  const n = tcodes.length;
  const idx = new Map(tcodes.map((t, i) => [t, i]));
  const fullExp = fullExpected(matrix.prob, tcodes);
  const sim = simulate(matrix.prob, tcodes);

  const adjProb = adjustment ? adjustMatrix(matrix.prob, tcodes, adjustment) : null;
  const adjExp = adjProb ? fullExpected(adjProb, tcodes) : null;
  const adjSim = adjProb ? simulate(adjProb, tcodes) : null;
  const adjRankOrder = adjExp
    ? [...tcodes].sort((a, b) => (adjExp.get(b) as number) - (adjExp.get(a) as number))
    : null;

  const rec = new Map<string, { w: number; l: number }>();
  for (const g of prevRes.data ?? []) {
    const hs = g.home_score as number;
    const as = g.away_score as number;
    if (hs == null || as == null || hs === as) continue;
    const h = rec.get(g.home_tcode as string) ?? { w: 0, l: 0 };
    const a = rec.get(g.away_tcode as string) ?? { w: 0, l: 0 };
    if (hs > as) {
      h.w++;
      a.l++;
    } else {
      h.l++;
      a.w++;
    }
    rec.set(g.home_tcode as string, h);
    rec.set(g.away_tcode as string, a);
  }

  const rows: ProjectionTeam[] = tcodes.map((t) => {
    const i = idx.get(t) as number;
    const info = teamMap.get(t);
    const dist = sim.rankDist[i];
    let modal = 0;
    for (let r = 1; r < n; r++) if (dist[r] > dist[modal]) modal = r;
    const r = rec.get(t);
    const a = adjustment?.teams.get(t) ?? null;
    let adj: ProjectionTeam["adj"] = null;
    if (a && adjSim && adjExp && adjRankOrder) {
      const ad = adjSim.rankDist[i];
      let am = 0;
      for (let k = 1; k < n; k++) if (ad[k] > ad[am]) am = k;
      adj = {
        fullExp: adjExp.get(t) as number,
        winsLo: adjSim.winsLo[i],
        winsHi: adjSim.winsHi[i],
        titleOdds: ad[0],
        playoffOdds: ad.slice(0, PLAYOFF_SPOTS).reduce((s2, v) => s2 + v, 0),
        rankDist: ad,
        modalRank: am + 1,
        expRank: adjRankOrder.indexOf(t) + 1,
        team: a,
        relMargin: a.dMarginTotal - (adjustment as StrengthAdjustment).leagueMean,
      };
    }
    return {
      adj,
      tcode: t,
      name: info?.name ?? t,
      abbr: info?.abbr ?? t,
      color: info?.color ?? "#888888",
      logoUrl: info?.logoUrl ?? null,
      schedN: schedN.get(t) as number,
      halfFilledN: filledN.get(t) as number,
      halfHomeN: halfHomeN.get(t) as number,
      halfExp: halfExp.get(t) as number,
      fullExp: fullExp.get(t) as number,
      fullPct: (fullExp.get(t) as number) / GAMES_FULL,
      simMean: sim.winsMean[i],
      winsLo: sim.winsLo[i],
      winsHi: sim.winsHi[i],
      titleOdds: dist[0],
      playoffOdds: dist.slice(0, PLAYOFF_SPOTS).reduce((s, v) => s + v, 0),
      modalRank: modal + 1,
      rankDist: dist,
      expRank: 0,
      prevW: r?.w ?? 0,
      prevL: r?.l ?? 0,
      prevPct: r && r.w + r.l > 0 ? r.w / (r.w + r.l) : null,
    };
  });
  rows.sort((a, b) => b.fullExp - a.fullExp);
  rows.forEach((t, i) => (t.expRank = i + 1));

  let halfFilledTotal = 0;
  for (const t of tcodes) halfFilledTotal += filledN.get(t) as number;

  return {
    season,
    prevSeason,
    teams: rows,
    matrix,
    scheduledN: priced.length,
    halfFilledN: halfFilledTotal / 2, // 두 팀 양쪽에서 세었으니 절반이 실제 경기 수
    scheduleComplete: rows.every((t) => t.schedN === GAMES_FULL) && matrix.filled === 0,
    adjustment,
    firstGameDate: games.length ? games[0].gameDate : null,
    lastGameDate: games.length ? games[games.length - 1].gameDate : null,
    sims: SIMS,
  };
}
