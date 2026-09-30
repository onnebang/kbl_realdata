import type { GameEvent } from "../postgameReport";
import { gradePrediction, type PredictionVerdict } from "../predictionVerdict";
import { turnoverPct, type TeamStatLine } from "./fourFactors";
import type { ReportTeamMeta } from "./renderKit";

// ---------------------------------------------------------------------------
// 예측 오차 진단 (Prediction Audit)
//
// 요청: "예상이 틀렸다면 왜 틀렸는지에 대한 분석".
//
// 기존 리포트는 예측이 빗나가면 "확률 예측은 100% 확신이 아니라…"라는 한 문장만 붙였다. 그건
// 틀린 말은 아니지만 어떤 경기에나 붙는 말이고, **무엇을 잘못 봤는지**는 하나도 말하지 않는다.
//
// 재료는 이미 다 있다:
//  1) pregame_features - 모델이 경기 전에 실제로 본 입력값(TS%/리바운드 점유율/턴오버율/페이스).
//     page.tsx가 프리뷰 카드용으로 이미 받아 둔다.
//  2) game_team_stats - 같은 지표의 이 경기 실제값.
//  => 같은 지표를 나란히 놓고 **부호가 뒤집힌 항목**을 찾으면, 그게 예측이 어긋난 지점이다.
//     실측(S49G14N4): 모델은 홈(KCC)의 TS%가 7.6%p 높다고 봤는데 실제로는 8.1%p 낮았다.
//  3) game_events의 home_win_prob/objective_prob 궤적 - "예측이 언제부터 어긋났나"를 그림으로.
//     실측: 그 경기에서 홈 승률은 628개 이벤트 중 **한 번도** 50%를 넘지 않았다. 그런데도
//     다른 절은 "홈이 흐름을 완전히 뒤집어놓음"이라고 쓰고 있었다.
//
// 원칙: 새로운 인과를 주장하지 않는다. "이 항목이 기대와 반대로 나왔다"까지만 말한다.
// 한 경기 결과로 모델을 평가할 수 없다는 것도 같이 적는다(경기 하나는 표본 1이다).
// ---------------------------------------------------------------------------

/** pregame_features에서 이 섹션이 쓰는 칼럼만. 전부 퍼센트 단위(예: 59.44 = 59.44%). */
export type PregameExpectation = {
  homeTsRt: number | null;
  awayTsRt: number | null;
  homeRebRt: number | null;
  awayRebRt: number | null;
  homeTovRt: number | null;
  awayTovRt: number | null;
  /** 모델이 본 경기 전 홈 승률. 카드에 찍히는 값(game_events PRE행)과 다를 수 있다 - 아래 참고. */
  homeWinProb: number | null;
};

export type AuditCheck = {
  label: string;
  /** 경기 전 기대한 홈-원정 격차(홈에 유리하면 +). 퍼센트포인트. */
  expectedEdge: number;
  /** 이 경기 실제 홈-원정 격차(홈에 유리하면 +). 퍼센트포인트. */
  actualEdge: number;
  /** 부호가 뒤집혔다 = 모델이 기대한 방향과 반대로 나왔다. */
  flipped: boolean;
};

export type TracePoint = { x: number; actual: number; objective: number | null };

export type PredictionAudit = {
  kind: "prediction_audit";
  home: ReportTeamMeta;
  away: ReportTeamMeta;
  verdict: PredictionVerdict;
  /** 카드에 찍힌 경기 전 홈 승률(game_events PRE행). */
  preProb: number;
  homeWon: boolean;
  trace: TracePoint[];
  quarterTicks: { x: number; q: string }[];
  /** 홈 승률이 50%를 넘어 있던 이벤트 비율(0~1). 0이면 한 번도 앞선 적이 없다. */
  homeAheadShare: number;
  homeMaxProb: number;
  homeMinProb: number;
  /**
   * objective_prob(점수·시간만 본 승률)의 최고치. home_win_prob과 갈리는 지점이 곧 "시즌
   * 전력 보정이 얼마나 끌어당겼나"다 - 실측 S49G14N4: 점수·시간만 보면 홈이 57.5%까지
   * 앞섰는데 전력 보정이 들어간 승률은 끝까지 50%를 넘지 못했다. null이면 그 칼럼이 비어 있다.
   */
  objMaxProb: number | null;
  checks: AuditCheck[];
  /**
   * 경기 전 예측이 두 갈래로 갈린 경우에만 채워진다(카드에 쓰는 game_events PRE행과
   * pregame_features가 **서로 다른 팀을 우세로** 본 경우).
   *
   * 두 값은 애초에 다른 모델이다(lib/pregameInsights.ts의 home_win_prob 주석 참고): PRE행은
   * 라이브 모델을 0-0·풀타임 잔여로 평가한 값(피처 5개), pregame_features는 경기 전 모델
   * (팀당 피처 30개). 실측(2026-09-30): pregame_features.home_win_prob이 채워진 종료 경기는
   * 10건(전부 2026-27 개막 OM 경기 - 그 앞 4,182건은 스크립트가 생기기 전이라 null)이고,
   * 그 10건 중 3건에서 우세팀이 반대로 갈렸다. 프리뷰 불릿과 최종 예측 카드가 서로 다른 팀을
   * 가리키게 되므로, 그 사실을 숨기지 않고 적는다.
   */
  modelSplit: { cardProb: number; featuresProb: number } | null;
};

/** TS% = 득점 ÷ (2 × (야투시도 + 0.44×자유투시도)). 퍼센트로 돌려준다. */
export function trueShootingPct(t: TeamStatLine): number {
  const att = t.fga + t.tpa;
  const denom = 2 * (att + 0.44 * t.fta);
  return denom > 0 ? (t.score / denom) * 100 : 0;
}

/** 리바운드 점유율 = 내 리바운드 ÷ 양 팀 합계. 퍼센트. */
export function rebShare(mine: number, theirs: number): number {
  const total = mine + theirs;
  return total > 0 ? (mine / total) * 100 : 0;
}

/** 두 격차의 부호가 반대이고, 둘 다 잡음이라 부르기 어려운 크기일 때만 '뒤집혔다'고 한다. */
const FLIP_MIN_EDGE_PP = 1.0;

function mkCheck(label: string, expectedEdge: number, actualEdge: number): AuditCheck {
  const flipped =
    Math.sign(expectedEdge) !== Math.sign(actualEdge) &&
    Math.abs(expectedEdge) >= FLIP_MIN_EDGE_PP &&
    Math.abs(actualEdge) >= FLIP_MIN_EDGE_PP;
  return { label, expectedEdge, actualEdge, flipped };
}

export type PredictionAuditInput = {
  home: ReportTeamMeta;
  away: ReportTeamMeta;
  events: GameEvent[];
  homeScore: number;
  awayScore: number;
  homeStats: TeamStatLine | null;
  awayStats: TeamStatLine | null;
  expectation: PregameExpectation | null;
};

export function computePredictionAudit(input: PredictionAuditInput): PredictionAudit | null {
  const { home, away, events, homeScore, awayScore, homeStats, awayStats, expectation } = input;
  if (homeScore === awayScore) return null;

  // 승률이 들어온 행만. PRE행도 포함한다 - 궤적의 출발점(경기 전 예측)이 바로 그 행이다.
  const valid = events.filter((e) => e.home_win_prob != null);
  if (valid.length < 2) return null;

  const preProb = valid[0].home_win_prob as number;
  const homeWon = homeScore > awayScore;

  // x축은 경과 시간이 아니라 이벤트 순서다 - 기존 WinProbLiveChart(종료 경기)와 같은 규칙이라
  // 두 차트가 같은 모양으로 읽힌다(elapsed는 단조증가가 아니라서 종료 경기엔 쓰지 않는다).
  const n = valid.length;
  const trace: TracePoint[] = valid.map((e, i) => ({
    x: i / (n - 1),
    actual: e.home_win_prob as number,
    objective: e.objective_prob ?? null,
  }));

  const quarterTicks: { x: number; q: string }[] = [];
  let lastQ: string | null = null;
  valid.forEach((e, i) => {
    if (e.quarter !== "PRE" && e.quarter !== lastQ) {
      quarterTicks.push({ x: i / (n - 1), q: e.quarter });
      lastQ = e.quarter;
    }
  });

  // PRE행은 '경기 중'이 아니므로 앞섰는지 계산에서 뺀다.
  const inGame = valid.filter((e) => e.quarter !== "PRE").map((e) => e.home_win_prob as number);
  const probs = inGame.length ? inGame : [preProb];
  const homeAheadShare = probs.filter((p) => p > 0.5).length / probs.length;
  const objInGame = valid.filter((e) => e.quarter !== "PRE" && e.objective_prob != null).map((e) => e.objective_prob as number);
  const objMaxProb = objInGame.length ? Math.max(...objInGame) : null;

  const checks: AuditCheck[] = [];
  if (expectation && homeStats && awayStats) {
    const { homeTsRt, awayTsRt, homeRebRt, awayRebRt, homeTovRt, awayTovRt } = expectation;
    if (homeTsRt != null && awayTsRt != null) {
      checks.push(mkCheck("슛 효율 (TS%)", homeTsRt - awayTsRt, trueShootingPct(homeStats) - trueShootingPct(awayStats)));
    }
    if (homeRebRt != null && awayRebRt != null) {
      checks.push(
        mkCheck(
          "리바운드 점유율",
          homeRebRt - awayRebRt,
          rebShare(homeStats.reb, awayStats.reb) - rebShare(awayStats.reb, homeStats.reb)
        )
      );
    }
    if (homeTovRt != null && awayTovRt != null) {
      // 턴오버는 낮을수록 좋다 - 홈에 유리한 격차는 "상대가 더 많이 흘린 만큼"이라 부호를 뒤집어 담는다.
      checks.push(
        mkCheck(
          "턴오버율 (낮을수록 유리)",
          awayTovRt - homeTovRt,
          (turnoverPct(awayStats) - turnoverPct(homeStats)) * 100
        )
      );
    }
    // eFG%는 pregame_features에 대응 칼럼이 없어 '경기 전 기대값'을 만들 수 없다 - 기대 없이
    // 실제값만 있는 항목을 이 표에 섞으면 비교표가 아니게 되므로 넣지 않는다(그 값은 '네 가지
    // 요인' 섹션에 있다).
  }

  const featuresProb = expectation?.homeWinProb ?? null;
  const modelSplit =
    featuresProb != null && (featuresProb >= 0.5) !== (preProb >= 0.5)
      ? { cardProb: preProb, featuresProb }
      : null;

  return {
    kind: "prediction_audit",
    home,
    away,
    verdict: gradePrediction(preProb, homeWon),
    preProb,
    homeWon,
    trace,
    quarterTicks,
    homeAheadShare,
    homeMaxProb: Math.max(...probs),
    homeMinProb: Math.min(...probs),
    objMaxProb,
    checks,
    modelSplit,
  };
}
