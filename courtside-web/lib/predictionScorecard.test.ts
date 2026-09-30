import { describe, expect, it } from "vitest";
import {
  calibrationBins,
  cumulativeLogLoss,
  scoreSeries,
  seasonsOf,
  seriesRows,
  SCORECARD_EVIDENCE,
  type ScoredGame,
} from "./predictionScorecard";

// 이 페이지의 숫자는 전부 "기준선과 비교해서만" 의미가 있으므로, 기준선 공식을 먼저 고정한다.
// 실측 대조값(2026-09-30, Supabase 집계): 종료 4,192경기에서 홈 승률 0.5532,
// 라이브 PRE 계열 log-loss 0.6346 / Brier 0.2220 / 적중 64.2%.

const LN2 = Math.LN2;

describe("scoreSeries 기준선", () => {
  it("항상 50%로 찍으면 log-loss가 ln2, Brier가 0.25다(동전 기준선의 정의)", () => {
    const rows = [
      { p: 0.5, y: 1 as const },
      { p: 0.5, y: 0 as const },
      { p: 0.5, y: 1 as const },
      { p: 0.5, y: 0 as const },
    ];
    const m = scoreSeries("live", rows)!;
    expect(m.logLoss).toBeCloseTo(LN2, 10);
    expect(m.brier).toBeCloseTo(0.25, 10);
    expect(m.coinLogLoss).toBeCloseTo(LN2, 10);
    expect(m.coinBrier).toBe(0.25);
  });

  it("정확히 50%는 적중으로도 실패로도 세지 않는다(반쪽)", () => {
    const m = scoreSeries("live", [{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }])!;
    expect(m.hitRate).toBe(0.5);
  });

  it("상수 예측의 Brier 기준선은 baseRate*(1-baseRate)", () => {
    // 홈 6승 4패 -> baseRate 0.6, 기준선 Brier 0.24
    const rows: { p: number; y: 0 | 1 }[] = [
      ...Array.from({ length: 6 }, () => ({ p: 0.6, y: 1 as const })),
      ...Array.from({ length: 4 }, () => ({ p: 0.6, y: 0 as const })),
    ];
    const m = scoreSeries("live", rows)!;
    expect(m.baseRate).toBeCloseTo(0.6, 10);
    expect(m.baseBrier).toBeCloseTo(0.24, 10);
    // 예측이 곧 baseRate와 같으면 실력이 0이어야 한다.
    expect(m.brier).toBeCloseTo(0.24, 10);
    expect(m.skill).toBeCloseTo(0, 10);
    // 그 baseRate를 아는 상수 예측의 log-loss = 이진 엔트로피
    const entropy = -(0.6 * Math.log(0.6) + 0.4 * Math.log(0.4));
    expect(m.baseLogLoss).toBeCloseTo(entropy, 10);
    expect(m.logLoss).toBeCloseTo(entropy, 10);
  });

  it("완벽한 예측은 skill 100%, 반대로 찍으면 음수", () => {
    const perfect = scoreSeries("live", [{ p: 1, y: 1 }, { p: 0, y: 0 }])!;
    expect(perfect.brier).toBeCloseTo(0, 10);
    expect(perfect.skill).toBe(1);
    const inverted = scoreSeries("live", [{ p: 0, y: 1 }, { p: 1, y: 0 }])!;
    expect(inverted.brier).toBeCloseTo(1, 10);
    expect(inverted.skill).toBeLessThan(0);
  });

  it("p=0 또는 1에서 결과가 반대로 나와도 발산하지 않는다(clamp)", () => {
    const m = scoreSeries("live", [{ p: 1, y: 0 }])!;
    expect(Number.isFinite(m.logLoss)).toBe(true);
    expect(m.logLoss).toBeGreaterThan(15); // 아주 큰 벌점이지만 유한
  });

  it("빈 표본은 null(섹션을 만들지 않는다)", () => {
    expect(scoreSeries("live", [])).toBeNull();
  });

  // 사용자가 직접 확인한 수치 - 오픈매치 10경기 엔트리 기준 5승 5패, log-loss 0.7200.
  // 동전(0.6931)보다 나쁘다는 것이 이 성적표의 첫 관찰이다.
  it("오픈매치 10경기 엔트리 계열이 동전 기준선보다 나쁘다는 사실을 재현한다", () => {
    const real: [number, 0 | 1][] = [
      [0.6406, 0], [0.5622, 1], [0.6925, 1], [0.6334, 1], [0.6359, 0],
      [0.4704, 0], [0.4961, 1], [0.5446, 0], [0.4406, 0], [0.6543, 0],
    ];
    const m = scoreSeries("entry", real.map(([p, y]) => ({ p, y })))!;
    expect(m.n).toBe(10);
    expect(m.hitRate).toBeCloseTo(0.5, 10); // 5/10
    expect(m.logLoss).toBeGreaterThan(LN2); // 동전보다 나쁘다
    expect(m.logLoss).toBeCloseTo(0.72, 2);
  });
});

describe("calibrationBins", () => {
  const rows = [
    { p: 0.05, y: 0 as const },
    { p: 0.55, y: 1 as const },
    { p: 0.55, y: 0 as const },
    { p: 0.95, y: 1 as const },
    { p: 1.0, y: 1 as const },
  ];

  it("고정 폭 10칸이고, p=1.0이 마지막 칸에 들어간다(어디에도 안 빠진다)", () => {
    const bins = calibrationBins(rows);
    expect(bins).toHaveLength(10);
    expect(bins.reduce((s, b) => s + b.n, 0)).toBe(rows.length);
    expect(bins[9].n).toBe(2); // 0.95와 1.0
  });

  it("빈 칸은 observed가 null이고 점을 그리지 않는다", () => {
    const bins = calibrationBins(rows);
    expect(bins[3].n).toBe(0);
    expect(bins[3].observed).toBeNull();
  });

  it("실제 승률과 구간 평균 예측값을 같이 낸다", () => {
    const b = calibrationBins(rows)[5]; // 0.5~0.6
    expect(b.n).toBe(2);
    expect(b.meanPred).toBeCloseTo(0.55, 10);
    expect(b.observed).toBeCloseTo(0.5, 10);
  });

  it("Wilson 구간이 항상 0~1 안에 있고 표본이 작으면 넓다", () => {
    const bins = calibrationBins(rows);
    for (const b of bins) {
      expect(b.ciLo).toBeGreaterThanOrEqual(0);
      expect(b.ciHi).toBeLessThanOrEqual(1);
      expect(b.ciLo).toBeLessThanOrEqual(b.ciHi);
    }
    // 2경기 전승 구간은 구간이 아주 넓어야 한다(정규근사면 [1,1]로 나와 거짓 확신이 된다).
    const last = bins[9];
    expect(last.observed).toBe(1);
    expect(last.ciLo).toBeLessThan(0.5);
  });

  it("칸 수를 바꿀 수 있다", () => {
    expect(calibrationBins(rows, 4)).toHaveLength(4);
  });
});

describe("cumulativeLogLoss", () => {
  it("마지막 점이 전체 평균 log-loss와 같다", () => {
    const rows = [
      { p: 0.7, y: 1 as const },
      { p: 0.4, y: 0 as const },
      { p: 0.6, y: 1 as const },
    ];
    const cum = cumulativeLogLoss(rows, ["1", "2", "3"]);
    expect(cum).toHaveLength(3);
    expect(cum[2].logLoss).toBeCloseTo(scoreSeries("live", rows)!.logLoss, 12);
    expect(cum[0].i).toBe(1);
  });

  it("기준선도 같이 쌓이고 유한하다(초반 전승/전패에서 발산 금지)", () => {
    const cum = cumulativeLogLoss([{ p: 0.9, y: 1 }, { p: 0.9, y: 1 }], ["1", "2"]);
    for (const p of cum) expect(Number.isFinite(p.baseline)).toBe(true);
  });
});

describe("seriesRows / seasonsOf", () => {
  const g = (over: Partial<ScoredGame>): ScoredGame => ({
    gmkey: "G", seasonName: "2025-2026", gameDate: "2026-01-01", seasonCategory: "정규시즌",
    y: 1, live: 0.6, pregame: null, entry: null, ...over,
  });

  it("값이 없는 계열은 그 경기를 건너뛴다", () => {
    const games = [g({}), g({ gmkey: "H", pregame: 0.4 })];
    expect(seriesRows(games, "live")).toHaveLength(2);
    expect(seriesRows(games, "pregame")).toEqual([{ p: 0.4, y: 1 }]);
    expect(seriesRows(games, "entry")).toHaveLength(0);
  });

  it("시즌은 최신 우선으로 정렬된다", () => {
    const games = [g({ seasonName: "2024-2025" }), g({ seasonName: "2026-2027" }), g({ seasonName: "2025-2026" })];
    expect(seasonsOf(games)).toEqual(["2026-2027", "2025-2026", "2024-2025"]);
  });

  it("학습 제외 시즌 상수가 실제 시즌 이름 형식과 맞는다", () => {
    expect(SCORECARD_EVIDENCE.outOfSampleSeason).toMatch(/^\d{4}-\d{4}$/);
  });
});
