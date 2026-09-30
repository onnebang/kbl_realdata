import { supabaseServer as supabase } from "./supabaseServer";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { cached, TAG, TTL } from "./cachePolicy";

// ---------------------------------------------------------------------------
// 예측 성적표 (Prediction Scorecard)
//
// 요청(2026-09-30): "시즌 내내 log-loss·Brier·캘리브레이션 곡선을 누적해 보여주는 예측
// 성적표 페이지".
//
// 왜 적중률을 머리에 두지 않는가(사용자 견해 그대로): "이길겁니다/질겁니다"를 1000번 중
// 1000번 맞혀도 그건 문어가 축구 승리를 맞히는 것과 같은 종류의 점수다. 확률 예측의 값은
// **58%라고 말한 경기들이 실제로 58% 비율로 일어났는가**에 있다. 그래서 이 모듈의 1급 지표는
// log-loss와 Brier, 그리고 그 둘을 읽을 기준선이다. 적중률은 같이 보여주되 기준선과 함께 둔다.
//
// 기준선 두 개를 항상 같이 낸다(실측, 15시즌 4,192경기 / 2026-09-30):
//   - 동전 던지기(항상 50%)      : log-loss ln2 = 0.6931, Brier 0.25
//   - 홈 승률만 아는 예측         : 홈 승률 55.32% -> log-loss 0.6877, Brier 0.2472
//   - 라이브 PRE 모델(참고)       : log-loss 0.6346, Brier 0.2220, 적중 64.2%
// 즉 "홈팀만 찍기"보다 얼마나 나은지가 실질적인 실력이다. 동전만 기준으로 삼으면 홈 어드밴티지
// 만으로도 잘해 보인다.
//
// **표본 구분이 이 페이지의 핵심 정직성 장치다**: 과거 시즌은 모델이 학습에 쓴 구간이라
// 성적이 낙관적으로 나온다(save_pregame_model.py의 CURRENT_SEASON_EXCLUDE=49로 2026-27만
// 학습에서 빠져 있다). 그래서 현재 시즌(모델이 본 적 없는 경기)과 과거 시즌을 섞어 한 숫자로
// 만들지 않는다.
// ---------------------------------------------------------------------------

/** 항상 같이 보여줄 기준선. 값의 출처는 위 머리주석(실측). */
export const SCORECARD_EVIDENCE = {
  /** 15시즌 4,192경기 홈 승률. */
  homeWinRate: 0.5532,
  /** 학습에서 제외된 시즌(= 진짜 성적표가 되는 구간). */
  outOfSampleSeason: "2026-2027",
} as const;

export type SeriesKey = "live" | "pregame" | "entry";

export const SERIES_LABEL: Record<SeriesKey, string> = {
  live: "라이브 PRE (시즌 전력 반영)",
  pregame: "경기 전 모델",
  entry: "엔트리 기준 (결장자 반영)",
};

export const SERIES_NOTE: Record<SeriesKey, string> = {
  live: "game_events의 경기 시작 전 행. 라이브 승률 모델을 0-0·풀타임 잔여 상태로 평가한 값이라 15시즌 전 경기에 있습니다.",
  pregame: "pregame_features의 경기 전 모델 예측(팀당 피처 30개). 예정 경기 동기화가 생긴 2026-09 이후 경기에만 있습니다.",
  entry: "12인 엔트리 발표 뒤 결장자를 반영해 다시 계산한 값. 엔트리가 공개된 경기에만 있습니다.",
};

/** 한 경기의 실제 결과와 세 계열의 예측값. */
export type ScoredGame = {
  gmkey: string;
  seasonName: string;
  gameDate: string;
  seasonCategory: string | null;
  /** 홈 승리면 1. */
  y: 0 | 1;
  live: number | null;
  pregame: number | null;
  entry: number | null;
};

export type SeriesMetrics = {
  key: SeriesKey;
  n: number;
  /** 표본의 홈 승률 - 기준선을 이 표본 자체로 계산해야 비교가 공정하다. */
  baseRate: number;
  logLoss: number;
  brier: number;
  /** 적중률(0~1). 기준선과 함께만 읽을 값. */
  hitRate: number;
  /** 같은 표본에서 "항상 홈 승률"로 찍었을 때의 값. */
  baseLogLoss: number;
  baseBrier: number;
  /** 동전 던지기(항상 50%). */
  coinLogLoss: number;
  coinBrier: number;
  /**
   * Brier skill score = 1 - brier/baseBrier. 0이면 "홈 승률만 아는 예측과 같다",
   * 양수면 그만큼 낫다, 음수면 더 못하다.
   */
  skill: number;
};

/** 캘리브레이션 한 구간. lo~hi 사이로 예측한 경기들이 실제로 몇 번 이겼나. */
export type CalibrationBin = {
  lo: number;
  hi: number;
  n: number;
  /** 그 구간 예측값의 평균(가로축). */
  meanPred: number;
  /** 실제 승률(세로축). n=0이면 null. */
  observed: number | null;
  /** Wilson 95% 구간 - 표본이 얇은 구간이 얼마나 못 믿을 값인지 그림으로 보이게. */
  ciLo: number;
  ciHi: number;
};

const EPS = 1e-9;
const clamp01 = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));

/** 상수 예측 q로 y를 맞혔을 때의 log-loss. 기준선 계산용. */
function constLogLoss(q: number, baseRate: number): number {
  const c = clamp01(q);
  return -(baseRate * Math.log(c) + (1 - baseRate) * Math.log(1 - c));
}

export function scoreSeries(key: SeriesKey, rows: { p: number; y: 0 | 1 }[]): SeriesMetrics | null {
  if (!rows.length) return null;
  const n = rows.length;
  const baseRate = rows.reduce((s, r) => s + r.y, 0) / n;
  let ll = 0;
  let br = 0;
  let hit = 0;
  for (const { p, y } of rows) {
    const c = clamp01(p);
    ll += -(y === 1 ? Math.log(c) : Math.log(1 - c));
    br += (p - y) ** 2;
    // 정확히 0.5는 어느 쪽도 찍지 않은 것이라 적중으로 세지 않는다(반쪽으로 센다).
    if (p === 0.5) hit += 0.5;
    else if (p > 0.5 === (y === 1)) hit += 1;
  }
  // 상수 예측의 Brier는 q=baseRate일 때 baseRate*(1-baseRate)이다.
  const baseBrier = baseRate * (1 - baseRate);
  const brier = br / n;
  return {
    key,
    n,
    baseRate,
    logLoss: ll / n,
    brier,
    hitRate: hit / n,
    baseLogLoss: constLogLoss(baseRate, baseRate),
    baseBrier,
    coinLogLoss: Math.LN2,
    coinBrier: 0.25,
    skill: baseBrier > 0 ? 1 - brier / baseBrier : 0,
  };
}

/** Wilson 95% 구간. 정규근사(p±1.96·se)는 n이 작거나 p가 0/1에 붙으면 구간이 밖으로 나간다. */
function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959964;
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * 고정 폭 구간으로 나눈다(기본 10칸). 분위수로 나누면 칸마다 표본이 같아져 보기 좋지만,
 * "55%라고 말한 경기"를 찾아보려는 독자의 질문과 축이 어긋난다 - 축은 확률 그대로 둔다.
 */
export function calibrationBins(rows: { p: number; y: 0 | 1 }[], binCount = 10): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = i / binCount;
    const hi = (i + 1) / binCount;
    // 마지막 칸만 상한을 포함한다(p=1.0이 어디에도 안 들어가는 것을 막는다).
    const inBin = rows.filter((r) => r.p >= lo && (i === binCount - 1 ? r.p <= hi : r.p < hi));
    const wins = inBin.reduce((s, r) => s + r.y, 0);
    const [ciLo, ciHi] = wilson(wins, inBin.length);
    bins.push({
      lo,
      hi,
      n: inBin.length,
      meanPred: inBin.length ? inBin.reduce((s, r) => s + r.p, 0) / inBin.length : (lo + hi) / 2,
      observed: inBin.length ? wins / inBin.length : null,
      ciLo,
      ciHi,
    });
  }
  return bins;
}

export function seriesRows(games: ScoredGame[], key: SeriesKey): { p: number; y: 0 | 1 }[] {
  const out: { p: number; y: 0 | 1 }[] = [];
  for (const g of games) {
    const p = key === "live" ? g.live : key === "pregame" ? g.pregame : g.entry;
    if (p != null) out.push({ p, y: g.y });
  }
  return out;
}

// ── 조회 ──────────────────────────────────────────────────────────────────────
// 세 테이블에서 "경기당 한 줄"만 모은다. game_events는 quarter='PRE' 행만 골라 4,192행이고
// (240만행 전체를 훑지 않는다), games/pregame_features도 같은 규모라 페이지네이션 한 번씩이면
// 끝난다. 종료 경기는 정산 후 불변이라 TTL.final로 캐시한다.

async function fetchScoredGames(): Promise<ScoredGame[]> {
  const [games, pre, pf] = await Promise.all([
    fetchAllPagesBounded<{
      gmkey: string;
      season_name: string;
      game_date: string;
      season_category: string | null;
      home_score: number;
      away_score: number;
    }>((from, to) =>
      supabase
        .from("games")
        .select("gmkey, season_name, game_date, season_category, home_score, away_score", { count: "exact" })
        .eq("is_ended", true)
        .not("home_score", "is", null)
        .not("away_score", "is", null)
        // PK 정렬 필수(fetchAllPagesBounded 주석의 실측 - 정렬 없이 받으면 4,192행 중 고유 2,915개).
        .order("gmkey", { ascending: true })
        .range(from, to)
    ),
    fetchAllPagesBounded<{ gmkey: string; home_win_prob: number | null }>((from, to) =>
      supabase
        .from("game_events")
        .select("gmkey, home_win_prob", { count: "exact" })
        .eq("quarter", "PRE")
        .order("gmkey", { ascending: true })
        .range(from, to)
    ),
    fetchAllPagesBounded<{ gmkey: string; home_win_prob: number | null; home_win_prob_lineup: number | null }>(
      (from, to) =>
        supabase
          .from("pregame_features")
          .select("gmkey, home_win_prob, home_win_prob_lineup", { count: "exact" })
          .order("gmkey", { ascending: true })
          .range(from, to)
    ),
  ]);

  // 검산: 페이지네이션이 중복/누락으로 망가지면 받은 행 수는 맞는데 고유 키가 줄어든다
  // (fetchAllPagesBounded 주석의 실측). 그 경우 조용히 틀린 표본으로 성적표를 그리게 되므로
  // 여기서 바로 던진다 - 배포본이 4,192경기를 2,857경기로 집계해 나간 적이 있다.
  for (const [name, rows] of [["games", games], ["game_events(PRE)", pre], ["pregame_features", pf]] as const) {
    const unique = new Set(rows.map((r) => r.gmkey)).size;
    if (unique !== rows.length) {
      throw new Error(`predictionScorecard: ${name} 조회에 중복 gmkey가 있다(${rows.length}행 / 고유 ${unique}개) - 페이지네이션 정렬을 확인할 것.`);
    }
  }

  const liveBy = new Map(pre.map((r) => [r.gmkey, r.home_win_prob]));
  const pfBy = new Map(pf.map((r) => [r.gmkey, r]));
  // 무승부는 KBL에 없지만(연장 무제한) 데이터가 그렇게 들어오면 채점 대상에서 뺀다.
  return games
    .filter((g) => g.home_score !== g.away_score)
    .map((g) => ({
      gmkey: g.gmkey,
      seasonName: g.season_name,
      gameDate: g.game_date,
      seasonCategory: g.season_category,
      y: (g.home_score > g.away_score ? 1 : 0) as 0 | 1,
      live: liveBy.get(g.gmkey) ?? null,
      pregame: pfBy.get(g.gmkey)?.home_win_prob ?? null,
      entry: pfBy.get(g.gmkey)?.home_win_prob_lineup ?? null,
    }))
    .sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.gmkey.localeCompare(b.gmkey));
}

export function getScoredGames(): Promise<ScoredGame[]> {
  return cached(fetchScoredGames, ["predictionScorecard:games"], TTL.final, [TAG.batch]);
}

/** 시즌 목록(최신 우선). 채점 가능한 경기가 있는 시즌만. */
export function seasonsOf(games: ScoredGame[]): string[] {
  return [...new Set(games.map((g) => g.seasonName))].sort((a, b) => b.localeCompare(a));
}

/** 누적 곡선 한 점 - 경기 순서대로 쌓아 온 평균 log-loss. */
export type CumulativePoint = { i: number; gameDate: string; logLoss: number; baseline: number };

/**
 * 시즌이 진행되는 동안 성적이 어디로 가는지. 기준선(그 시점까지의 홈 승률로 찍었을 때)을 같이
 * 쌓아서, 곡선이 기준선 아래에 있는 동안만 "실력이 있다"고 읽을 수 있게 한다.
 */
export function cumulativeLogLoss(rows: { p: number; y: 0 | 1 }[], dates: string[]): CumulativePoint[] {
  const out: CumulativePoint[] = [];
  let ll = 0;
  let wins = 0;
  for (let i = 0; i < rows.length; i++) {
    const { p, y } = rows[i];
    ll += -(y === 1 ? Math.log(clamp01(p)) : Math.log(1 - clamp01(p)));
    wins += y;
    const n = i + 1;
    const rate = wins / n;
    out.push({
      i: n,
      gameDate: dates[i] ?? "",
      logLoss: ll / n,
      // 그 시점까지의 홈 승률을 아는 상수 예측. 0/1로 쏠린 초반은 발산하므로 살짝 막는다.
      baseline: constLogLoss(Math.min(0.99, Math.max(0.01, rate)), rate),
    });
  }
  return out;
}
