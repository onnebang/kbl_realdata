import { describe, expect, it } from "vitest";
import { computeFourFactors, effectiveFgPct, orebPct, turnoverPct, type TeamStatLine } from "./fourFactors";
import { computePredictionAudit, rebShare, trueShootingPct } from "./predictionAudit";
import type { GameEvent } from "../postgameReport";

// 픽스처는 실측 경기다 - S49G14N4(2026-09-25, 홈 부산 KCC 82 : 원정 창원 LG 88).
// game_team_stats에서 그대로 가져온 값이고, 이 경기가 두 섹션이 생긴 이유이기도 하다
// (자유투로 +10점이 갈렸는데 리포트에 자유투가 한 줄도 없었다 - fourFactors.ts 머리주석).
const homeTeam = { tcode: "60", name: "부산 KCC", abbr: "KCC", color: "#111111" };
const awayTeam = { tcode: "50", name: "창원 LG", abbr: "LG", color: "#222222" };

// fgm/fga는 2점 전용이다(전체 야투 = fgm+tpm / fga+tpa). score = fgm*2 + tpm*3 + ftm.
const KCC: TeamStatLine = {
  tcode: "60", score: 82, fgm: 25, fga: 47, tpm: 7, tpa: 25, ftm: 11, fta: 16,
  reb: 36, ast: 15, turnovers: 11, fouls: 25, pace: null,
};
const LG: TeamStatLine = {
  tcode: "50", score: 88, fgm: 26, fga: 37, tpm: 5, tpa: 24, ftm: 21, fta: 28,
  reb: 36, ast: 19, turnovers: 11, fouls: 19, pace: null,
};

it("픽스처가 실제 점수 항등식을 만족한다(2점 전용 fgm/fga 가정의 검산)", () => {
  expect(KCC.fgm * 2 + KCC.tpm * 3 + KCC.ftm).toBe(82);
  expect(LG.fgm * 2 + LG.tpm * 3 + LG.ftm).toBe(88);
});

describe("지표 공식", () => {
  it("eFG%는 전체 야투(2점+3점) 기준", () => {
    // KCC: (32 + 0.5*7) / 72 = 49.3% / LG: (31 + 0.5*5) / 61 = 54.9%
    expect(effectiveFgPct(KCC)).toBeCloseTo(0.4931, 4);
    expect(effectiveFgPct(LG)).toBeCloseTo(0.5492, 4);
  });

  it("TS%는 자유투 시도를 0.44로 환산해 넣는다", () => {
    expect(trueShootingPct(KCC)).toBeCloseTo(51.87, 2);
    expect(trueShootingPct(LG)).toBeCloseTo(60.01, 2);
  });

  it("TOV%는 추정 포제션 기준", () => {
    expect(turnoverPct(KCC)).toBeCloseTo(0.1222, 4);
    expect(turnoverPct(LG)).toBeCloseTo(0.1305, 4);
  });

  it("ORB%는 내 공격리바운드 대 상대 수비리바운드", () => {
    expect(orebPct(10, 30)).toBeCloseTo(0.25, 6);
    expect(orebPct(0, 0)).toBe(0); // 0 나눗셈 방어
  });

  it("리바운드 점유율은 양 팀 합계 대비", () => {
    expect(rebShare(36, 36)).toBe(50);
    expect(rebShare(40, 20)).toBeCloseTo(66.667, 3);
  });
});

describe("computeFourFactors", () => {
  const ff = computeFourFactors({
    home: homeTeam, away: awayTeam, homeStats: KCC, awayStats: LG,
    homeOreb: 10, homeDreb: 26, awayOreb: 6, awayDreb: 30,
    homeScore: 82, awayScore: 88,
  })!;

  it("득점 출처의 합이 정확히 최종 점수다(표가 스스로 검산된다)", () => {
    expect(ff.scoring.reduce((s, r) => s + r.home, 0)).toBe(82);
    expect(ff.scoring.reduce((s, r) => s + r.away, 0)).toBe(88);
  });

  it("승자가 가장 크게 앞선 출처를 고른다 - 이 경기는 자유투(+10점)", () => {
    expect(ff.winnerIsHome).toBe(false);
    expect(ff.decisive).toEqual({ label: "자유투 득점", pts: 10 });
    // 마진(6점)보다 크다 - 문장이 이 비교로 갈린다.
    expect(ff.decisive.pts).toBeGreaterThan(ff.margin);
  });

  it("승자가 오히려 밀린 출처도 숨기지 않는다 - LG는 3점에서 6점 밀렸다", () => {
    expect(ff.conceded).toEqual([{ label: "3점 득점", pts: -6 }]);
  });

  it("TOV%는 막대만 뒤집고 표시 숫자는 실제 비율을 쓴다", () => {
    const tov = ff.factors.find((f) => f.label === "TOV%")!;
    // 턴오버가 적은 KCC(12.2%)의 막대가 LG(13.1%)보다 길어야 한다.
    expect(tov.homeBar).toBeGreaterThan(tov.awayBar);
    expect(tov.homeDisp).toBe("12.2%");
    expect(tov.awayDisp).toBe("13.0%"); // 13.0455% → 소수 첫째 자리
    expect(tov.homeEdge).toBeGreaterThan(0); // 홈에 유리한 방향
  });

  it("동점이나 기록 없는 경기는 섹션을 안 만든다", () => {
    const base = {
      home: homeTeam, away: awayTeam, homeStats: KCC, awayStats: LG,
      homeOreb: 10, homeDreb: 26, awayOreb: 6, awayDreb: 30,
    };
    expect(computeFourFactors({ ...base, homeScore: 80, awayScore: 80 })).toBeNull();
    const blank: TeamStatLine = { ...KCC, fga: 0, tpa: 0 };
    expect(computeFourFactors({ ...base, homeStats: blank, homeScore: 82, awayScore: 88 })).toBeNull();
  });
});

describe("computePredictionAudit", () => {
  // 실측 pregame_features 행: 모델은 홈(KCC)의 TS%가 7.6%p 높다고 봤다.
  const expectation = {
    homeTsRt: 59.44, awayTsRt: 51.84,
    homeRebRt: 54.17, awayRebRt: 52.02,
    homeTovRt: 13.83, awayTovRt: 13.77,
    homeWinProb: 0.6397,
  };
  // 홈 승률이 경기 내내 50%를 넘지 않는 궤적(실측: 628개 이벤트 중 0회).
  const ev = (quarter: string, p: number, order: number): GameEvent =>
    ({
      event_order: order, quarter, clock_min: 9, clock_sec: 0, action_code: null, action_label: null,
      pcode: null, player_name: null, tcode: null, home_score: 0, away_score: 0,
      home_win_prob: p, wpa_home: 0, objective_prob: p, elapsed: order, runHome: 0, runAway: 0, surge: null,
    }) as GameEvent;
  const events = [ev("PRE", 0.4977, 0), ev("Q1", 0.42, 1), ev("Q2", 0.31, 2), ev("Q3", 0.08, 3), ev("Q4", 0.01, 4)];

  const audit = computePredictionAudit({
    home: homeTeam, away: awayTeam, events, homeScore: 82, awayScore: 88,
    homeStats: KCC, awayStats: LG, expectation,
  })!;

  it("경기 전 승률이 반반이면 적중/빗나감을 매기지 않는다", () => {
    expect(audit.verdict).toBe("coinflip");
    expect(audit.preProb).toBeCloseTo(0.4977, 4);
  });

  it("홈이 한 번도 앞서지 못한 경기를 0으로 집계한다(PRE행 제외)", () => {
    expect(audit.homeAheadShare).toBe(0);
    expect(audit.homeMaxProb).toBeCloseTo(0.42, 4);
  });

  it("기대와 부호가 뒤집힌 항목만 flipped - 이 경기는 슛 효율뿐", () => {
    const ts = audit.checks.find((c) => c.label.startsWith("슛 효율"))!;
    expect(ts.expectedEdge).toBeCloseTo(7.6, 1);
    expect(ts.actualEdge).toBeCloseTo(-8.14, 2);
    expect(ts.flipped).toBe(true);
    expect(audit.checks.filter((c) => c.flipped)).toHaveLength(1);
  });

  it("양쪽 격차가 잡음 수준이면 뒤집혔다고 하지 않는다(턴오버 -0.06 vs +0.83)", () => {
    const tov = audit.checks.find((c) => c.label.startsWith("턴오버율"))!;
    expect(Math.sign(tov.expectedEdge)).not.toBe(Math.sign(tov.actualEdge));
    expect(tov.flipped).toBe(false);
    // "일치"라고도 쓰지 않는다 - 부호가 실제로 다르다(실측 S49G14N3의 리바운드 점유율이
    // 기대 -0.7%p / 실제 +10.0%p인데 "방향 일치"로 나갔던 자리).
    expect(tov.kind).toBe("negligible");
  });

  it("부호가 같으면 aligned, 둘 다 유의미하게 뒤집히면 flipped", () => {
    const ts = audit.checks.find((c) => c.label.startsWith("슛 효율"))!;
    expect(ts.kind).toBe("flipped");
    const reb = audit.checks.find((c) => c.label.startsWith("리바운드"))!;
    expect(reb.kind).toBe("negligible"); // 기대 +2.1 / 실제 0.0
  });

  it("경기 전 예측이 두 갈래로 갈린 경우를 숨기지 않는다", () => {
    // 카드는 0.4977(원정 우세)인데 pregame_features는 0.6397(홈 우세)이다.
    expect(audit.modelSplit).toEqual({ cardProb: audit.preProb, featuresProb: 0.6397 });
  });

  it("두 예측이 같은 팀을 우세로 보면 modelSplit은 null", () => {
    const agreed = computePredictionAudit({
      home: homeTeam, away: awayTeam, events, homeScore: 82, awayScore: 88,
      homeStats: KCC, awayStats: LG, expectation: { ...expectation, homeWinProb: 0.44 },
    })!;
    expect(agreed.modelSplit).toBeNull();
  });
});

// objMaxProb - 점수·시간만 본 승률이 50%를 넘었는데 전력 보정 승률은 못 넘은 경우를 잡는다
// (실측 S49G14N4: objective 57.5% vs home_win_prob 최고 49.8%). 컴포넌트가 이 조합에서만
// "두 선이 갈린 지점" 문장을 낸다.
describe("computePredictionAudit objMaxProb", () => {
  const ev = (quarter: string, p: number, obj: number | null, order: number): GameEvent =>
    ({
      event_order: order, quarter, clock_min: 9, clock_sec: 0, action_code: null, action_label: null,
      pcode: null, player_name: null, tcode: null, home_score: 0, away_score: 0,
      home_win_prob: p, wpa_home: 0, objective_prob: obj, elapsed: order, runHome: 0, runAway: 0, surge: null,
    }) as GameEvent;

  it("PRE행을 빼고 objective_prob의 최고치를 잡는다", () => {
    const a = computePredictionAudit({
      home: homeTeam, away: awayTeam,
      events: [ev("PRE", 0.4977, 0.99, 0), ev("Q1", 0.42, 0.575, 1), ev("Q4", 0.01, 0.02, 2)],
      homeScore: 82, awayScore: 88, homeStats: KCC, awayStats: LG, expectation: null,
    })!;
    expect(a.objMaxProb).toBeCloseTo(0.575, 4); // PRE의 0.99는 포함되지 않는다
    expect(a.homeAheadShare).toBe(0);
  });

  it("objective_prob이 전부 비어 있으면 null", () => {
    const a = computePredictionAudit({
      home: homeTeam, away: awayTeam,
      events: [ev("PRE", 0.4977, null, 0), ev("Q1", 0.42, null, 1)],
      homeScore: 82, awayScore: 88, homeStats: KCC, awayStats: LG, expectation: null,
    })!;
    expect(a.objMaxProb).toBeNull();
  });
});
