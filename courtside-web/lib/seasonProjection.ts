import { PRESEASON_SEASON, getTeams, isRealGmkey, prevSeasonName, type TeamInfo } from "./preseason";
import { supabase } from "./supabase";

// 정규시즌 전체(54경기) 전망 - 요청: "기대승수가 26경기 기준이다보니 파워를 가늠하기 어려워,
// 9경기씩 6라운드 총 54경기인데, 전반기 3라운드까지와, 6라운드 54경기 전체 기대승수와 AI 예상
// 순위를 적어줘".
//
// ── 왜 지금 값이 팀마다 다른가 ────────────────────────────────────────────────────
// KBL이 공개한 26-27 일정은 2027-01-02까지 131경기뿐이고, 팀당 24~27경기로 제각각이다.
// 그 일정에 매긴 승률을 그냥 더하면 SK(24경기)와 KT(27경기)의 기대승수를 나란히 놓을 수 없다.
// 실측(2026-09-04)으로 확인한 공개 일정의 구조:
//   · 모든 팀이 모든 상대와 정확히 3번씩 만나도록 짜여 있다 = 3라운드(전반기)분이다.
//   · 딱 4경기가 비어 있다 - DB↔소노 1, 삼성↔SK 1, SK↔가스공사 2. 131 + 4 = 135 = 45 × 3.
// 즉 "전반기 27경기"는 추정이 아니라 공개 일정 + 4경기다. 그리고 KBL 정규시즌은 상대별
// 홈 3 · 원정 3으로 완전히 균형 잡힌 54경기라(25-26 실측: 90개 순서쌍 전부 정확히 3경기),
// 전체 54경기 기대승수는 일정 편성과 무관하게 매치업 승률만으로 결정된다.
//
// ── 승률의 출처 ──────────────────────────────────────────────────────────────────
// pregame_features.home_win_prob(경기 전 모델)은 같은 순서쌍이면 값이 사실상 같다
// (실측: 86개 순서쌍의 min/max 차이가 최대 0.002 - 휴식일 같은 미세 피처 차이). 그래서
// "순서쌍 -> 승률"이 이 모델의 실체다. 90개 순서쌍 중 86개는 모델이 매긴 값을 그대로 쓴다.
// 나머지 4개(아직 그 방향으로 편성되지 않은 대진)는 반대 방향 값을 홈코트 이점으로 뒤집어
// 채운다: logit p(A홈) + logit p(B홈) = 2h 이므로 p(A홈) = sigmoid(2h - logit p(B홈)).
// h는 양방향이 다 있는 41쌍의 평균에서 뽑는다. 추정한 4쌍은 화면이 반드시 그 수를 밝힌다.
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
/** 시뮬레이션 횟수. 10,000이면 확률의 표준오차가 최대 0.5%p라 소수점 없이 쓰기에 충분하다. */
export const SIMS = 10000;

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
  /** 전반기 27경기를 채우려고 대칭으로 보탠 경기 수. */
  halfFilledN: number;
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
};

export type SeasonProjection = {
  season: string;
  prevSeason: string;
  teams: ProjectionTeam[];
  matrix: MatchupMatrix;
  /** 공개 일정 경기 수(승률이 매겨진 것만). */
  scheduledN: number;
  /** 전반기 3라운드를 채우려고 보탠 경기 수(리그 전체). */
  halfFilledN: number;
  firstGameDate: string | null;
  lastGameDate: string | null;
  sims: number;
};

/**
 * 전반기(27경기)·전체(54경기) 기대승수 + 시뮬레이션 순위 분포.
 * 매치업 행렬이 불완전하면(팀 수가 10이 아니거나 순서쌍이 모자라면) null - 화면은 기존
 * 공개 일정 기준 표만 보여주면 된다.
 */
export async function getSeasonProjection(season = PRESEASON_SEASON): Promise<SeasonProjection | null> {
  const prevSeason = prevSeasonName(season);
  const [teamMap, sched, prevRes] = await Promise.all([
    getTeams(season),
    fetchScheduleWithProbs(season),
    supabase
      .from("games")
      .select("home_tcode, away_tcode, home_score, away_score")
      .eq("season_name", prevSeason)
      .eq("is_ended", true)
      .eq("season_category", "정규시즌"),
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

  // ── 전반기: 공개 일정 그대로 + 상대별 3경기를 못 채운 만큼 보탠다 ──────────────────
  // 보탠 경기의 홈/원정은 알 수 없다(3라운드 안에서 2:1도 3:0도 실제로 나온다). 그래서
  // 양쪽 홈 승률의 평균을 쓴다 - 실측상 리그 전체에서 4경기뿐이라 영향은 팀당 최대 2경기.
  const halfExp = new Map<string, number>();
  const schedN = new Map<string, number>();
  const filledN = new Map<string, number>();
  const met = new Map<string, number>(); // "팀|상대" -> 편성된 맞대결 수
  for (const t of tcodes) {
    halfExp.set(t, 0);
    schedN.set(t, 0);
    filledN.set(t, 0);
  }
  const bump = (t: string, add: number) => halfExp.set(t, (halfExp.get(t) as number) + add);
  for (const g of priced) {
    const ph = probs.get(g.gmkey) as number;
    bump(g.home, ph);
    bump(g.away, 1 - ph);
    schedN.set(g.home, (schedN.get(g.home) as number) + 1);
    schedN.set(g.away, (schedN.get(g.away) as number) + 1);
    for (const [a, b] of [
      [g.home, g.away],
      [g.away, g.home],
    ]) {
      met.set(`${a}|${b}`, (met.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  for (const t of tcodes) {
    for (const o of tcodes) {
      if (t === o) continue;
      const short = ROUNDS_HALF - (met.get(`${t}|${o}`) ?? 0);
      if (short <= 0) continue;
      const neutral = (p(t, o) + (1 - p(o, t))) / 2;
      bump(t, short * neutral);
      filledN.set(t, (filledN.get(t) as number) + short);
    }
  }

  // ── 전체 54경기: 상대별 홈 3 · 원정 3(일정 편성과 무관한 항등식) ────────────────────
  const fullExp = new Map<string, number>();
  for (const t of tcodes) {
    let e = 0;
    for (const o of tcodes) {
      if (t === o) continue;
      e += ROUNDS_HALF * p(t, o); // 홈 3경기
      e += ROUNDS_HALF * (1 - p(o, t)); // 원정 3경기
    }
    fullExp.set(t, e);
  }

  // ── 시뮬레이션: 같은 54경기 일정을 SIMS번 ────────────────────────────────────────
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
        gameP.push(p(h, a));
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

  const quantile = (hist: number[], q: number): number => {
    const target = SIMS * q;
    let acc = 0;
    for (let w = 0; w < hist.length; w++) {
      acc += hist[w];
      if (acc >= target) return w;
    }
    return hist.length - 1;
  };

  const rows: ProjectionTeam[] = tcodes.map((t) => {
    const i = idx.get(t) as number;
    const info = teamMap.get(t);
    const dist = rankCount[i].map((c) => c / SIMS);
    let modal = 0;
    for (let r = 1; r < n; r++) if (dist[r] > dist[modal]) modal = r;
    const r = rec.get(t);
    return {
      tcode: t,
      name: info?.name ?? t,
      abbr: info?.abbr ?? t,
      color: info?.color ?? "#888888",
      logoUrl: info?.logoUrl ?? null,
      schedN: schedN.get(t) as number,
      halfFilledN: filledN.get(t) as number,
      halfExp: halfExp.get(t) as number,
      fullExp: fullExp.get(t) as number,
      fullPct: (fullExp.get(t) as number) / GAMES_FULL,
      simMean: winsSum[i] / SIMS,
      winsLo: quantile(winsHist[i], 0.1),
      winsHi: quantile(winsHist[i], 0.9),
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
    firstGameDate: games.length ? games[0].gameDate : null,
    lastGameDate: games.length ? games[games.length - 1].gameDate : null,
    sims: SIMS,
  };
}
