import { describe, expect, it } from "vitest";
import { computeFourFactors, type FourFactors, type TeamStatLine } from "./fourFactors";
import { buildScoreChart, scoreSourceNotes, SCORE_GRID_STEP_PTS } from "./scoreSourceChart";
import type { ZoneTotal } from "./shotHotZone";

// 픽스처는 사용자가 스크린샷으로 올린 경기 - S49G14N10(2026-09-27, 전주 KCC(홈) 67 : 80 대구 한국가스공사).
// 구역 집계는 shot_log를 computeZoneTotals와 같은 거리 규칙으로 직접 센 값이고, 공식 팀 스탯은
// game_team_stats다. 이 경기는 좌표 구역 합이 공식 2점 득점과 정확히 일치한다(KCC 15개=30점, GAS 22개=44점).
const KCC = { tcode: "60", name: "부산 KCC", abbr: "KCC", color: "#0C2340" };
const GAS = { tcode: "64", name: "대구 한국가스공사", abbr: "GAS", color: "#0072CE" };

const kccStats: TeamStatLine = { tcode: "60", score: 67, fgm: 15, fga: 38, tpm: 10, tpa: 29, ftm: 7, fta: 8, reb: 30, ast: 12, turnovers: 14, fouls: 17, pace: null };
const gasStats: TeamStatLine = { tcode: "64", score: 80, fgm: 22, fga: 43, tpm: 7, tpa: 27, ftm: 15, fta: 21, reb: 38, ast: 17, turnovers: 8, fouls: 15, pace: null };

const z = (key: string, hm: number, ha: number, am: number, aa: number): ZoneTotal => ({
  key,
  home: { made: hm, att: ha, pts: hm * 2 },
  away: { made: am, att: aa, pts: am * 2 },
});
const exactZones = (): ZoneTotal[] => [z("rim", 4, 6, 6, 10), z("close", 9, 19, 11, 23), z("midShort", 1, 8, 3, 6), z("midLong", 1, 4, 2, 4)];

const ffOf = (zones: ZoneTotal[] | null): FourFactors =>
  computeFourFactors({
    home: KCC, away: GAS, homeStats: kccStats, awayStats: gasStats,
    homeOreb: 9, homeDreb: 24, awayOreb: 11, awayDreb: 28,
    homeScore: 67, awayScore: 80, zones,
  })!;

const rowOf = (m: ReturnType<typeof buildScoreChart>, key: string) => m.rows.find((r) => r.key === key)!;

describe("buildScoreChart - 모든 줄이 하나의 눈금", () => {
  const m = buildScoreChart(ffOf(exactZones()));

  it("구역 6줄이 코트 순서로 나오고 줄 합이 최종 점수다", () => {
    expect(m.rows.map((r) => r.key)).toEqual(["rim", "close", "midShort", "midLong", "three", "ft"]);
    expect(m.rows.reduce((t, r) => t + r.home, 0)).toBe(67);
    expect(m.rows.reduce((t, r) => t + r.away, 0)).toBe(80);
    expect(m.total).toEqual({ home: 67, away: 80, lead: "away", margin: 13 });
  });

  it("막대 길이는 점수 ÷ 눈금 최댓값이다 - 줄마다 다시 정규화하지 않는다", () => {
    // 최댓값은 KCC 3점 30점 -> 눈금 30점. 그 줄의 홈 막대가 반 폭 전체다.
    expect(m.axisMax).toBe(30);
    expect(rowOf(m, "three").homePct).toBeCloseTo(100, 6);
    expect(rowOf(m, "rim").homePct).toBeCloseTo((8 / 30) * 100, 6);
    expect(rowOf(m, "close").awayPct).toBeCloseTo((22 / 30) * 100, 6);
  });

  it("다른 줄의 막대와 길이를 직접 비교할 수 있다(길이 비 = 점수 비)", () => {
    const close = rowOf(m, "close").awayPct; // GAS 22
    const ft = rowOf(m, "ft").awayPct; // GAS 15
    expect(close / ft).toBeCloseTo(22 / 15, 6);
    expect(close).toBeGreaterThan(ft);
  });

  it("눈금선 한 칸이 10점이고 반 폭 대비 %로 내려간다", () => {
    expect(SCORE_GRID_STEP_PTS).toBe(10);
    expect(m.stepPct).toBeCloseTo((10 / 30) * 100, 6);
  });

  it("줄마다 우세 쪽과 점수차를 낸다", () => {
    expect([rowOf(m, "three").lead, rowOf(m, "three").margin]).toEqual(["home", 9]);
    expect([rowOf(m, "ft").lead, rowOf(m, "ft").margin]).toEqual(["away", 8]);
    expect([rowOf(m, "rim").lead, rowOf(m, "rim").margin]).toEqual(["away", 4]);
    // 줄별 순 득실(원정 기준)을 더하면 최종 마진 13이다 - 차트가 승부를 분해한다는 것의 검산.
    const awayNet = m.rows.reduce((t, r) => t + (r.away - r.home), 0);
    expect(awayNet).toBe(13);
  });
});

// 이 테스트가 존재하는 이유 - 사용자가 올린 스크린샷의 불만 그대로다. 예전 차트는 줄마다 두 팀
// 합 대비 비율로 막대를 그려서 자유투 15점(원정 점유율 68%)이 2점 44점(59%)보다 긴 막대였다.
describe("회귀: 자유투 15점이 2점 44점보다 길어 보이던 차트", () => {
  const m = buildScoreChart(ffOf(null)); // 구역 없이 공식 3분류 - 사용자 스크린샷과 같은 3줄

  it("3분류도 같은 눈금이라 2점 44점의 막대가 자유투 15점의 막대보다 훨씬 길다", () => {
    expect(m.rows.map((r) => r.key)).toEqual(["two", "three", "ft"]);
    const two = rowOf(m, "two").awayPct;
    const ft = rowOf(m, "ft").awayPct;
    expect(two).toBeGreaterThan(ft);
    // 예전 방식의 점유율이었다면 자유투가 더 길었다(68% > 59%) - 그 역전이 다시 생기면 여기서 깨진다.
    const oldShare = (a: number, b: number) => b / (a + b);
    expect(oldShare(7, 15)).toBeGreaterThan(oldShare(30, 44));
    expect(two / ft).toBeCloseTo(44 / 15, 6);
  });
});

describe("buildScoreChart - 0·동점·아주 작은 값", () => {
  const edge = (): ZoneTotal[] => [z("rim", 0, 0, 4, 5), z("close", 6, 9, 6, 11), z("midShort", 1, 7, 0, 4), z("midLong", 0, 3, 0, 1)];
  const edgeFF = () =>
    computeFourFactors({
      home: KCC, away: GAS,
      homeStats: { ...kccStats, score: 53, fgm: 7, fga: 19, tpm: 12, tpa: 30, ftm: 3, fta: 4 },
      awayStats: { ...gasStats, score: 61, fgm: 10, fga: 21, tpm: 9, tpa: 25, ftm: 14, fta: 16 },
      homeOreb: 9, homeDreb: 24, awayOreb: 11, awayDreb: 28,
      homeScore: 53, awayScore: 61, zones: edge(),
    })!;
  const m = buildScoreChart(edgeFF());

  it("0점은 막대가 없다(0 폭) - 있는 것처럼 그리지 않는다", () => {
    expect(rowOf(m, "rim").homePct).toBe(0);
    expect(rowOf(m, "rim").awayPct).toBeGreaterThan(0);
  });

  it("동점은 tie 태그, 둘 다 0이면 none 태그, 그 밖은 태그 없음", () => {
    expect(rowOf(m, "close").tag).toBe("tie");
    expect(rowOf(m, "close").lead).toBe("tie");
    expect(rowOf(m, "midLong").tag).toBe("none");
    expect(rowOf(m, "rim").tag).toBeNull();
  });

  it("0이 아닌 작은 값은 0처럼 사라지지 않는다 - 최소 길이를 보장한다", () => {
    // 중거리 홈 2점은 눈금 36점 대비 5.6%지만, 더 극단(1점 대 40점)에서도 보여야 한다.
    const tiny = computeFourFactors({
      home: KCC, away: GAS,
      homeStats: { ...kccStats, score: 41, fgm: 0, fga: 0, tpm: 13, tpa: 20, ftm: 2, fta: 2 },
      awayStats: { ...gasStats, score: 40, fgm: 20, fga: 30, tpm: 0, tpa: 0, ftm: 0, fta: 0 },
      homeOreb: 1, homeDreb: 1, awayOreb: 1, awayDreb: 1,
      homeScore: 41, awayScore: 40,
      zones: [z("rim", 0, 0, 10, 12), z("close", 0, 0, 5, 9), z("midShort", 0, 0, 3, 6), z("midLong", 0, 0, 2, 4)],
    })!;
    const model = buildScoreChart(tiny);
    const ft = rowOf(model, "ft"); // 홈 자유투 2점 vs 눈금 40점
    expect(ft.homePct).toBeGreaterThanOrEqual(1.6);
    expect(ft.homePct).toBeLessThan(10);
  });
});

describe("구역 미확인 줄 - 합 = 최종 점수를 지키되 숨기지 않는다", () => {
  // KCC 근거리 9 -> 8개: 구역 합 28점, 공식 30점(2점 부족). GAS는 일치.
  const mismatch = () => exactZones().map((x) => (x.key === "close" ? z("close", 8, 19, 11, 23) : x));
  const m = buildScoreChart(ffOf(mismatch()));

  it("3점 줄 뒤·자유투 줄 앞에 '구역 미확인'이 들어가고 부족한 2점만 담는다", () => {
    expect(m.rows.map((r) => r.key)).toEqual(["rim", "close", "midShort", "midLong", "three", "unplaced", "ft"]);
    const un = rowOf(m, "unplaced");
    expect([un.home, un.away, un.unplaced]).toEqual([2, 0, true]);
  });

  it("미확인 줄까지 더하면 줄 합계가 정확히 최종 점수다", () => {
    expect(m.rows.reduce((t, r) => t + r.home, 0)).toBe(67);
    expect(m.rows.reduce((t, r) => t + r.away, 0)).toBe(80);
  });

  it("어긋남이 없으면 미확인 줄이 아예 없다", () => {
    expect(buildScoreChart(ffOf(exactZones())).rows.some((r) => r.unplaced)).toBe(false);
  });

  it("구역 합이 공식보다 많으면(음수) 막대를 만들지 않고 주석이 말한다", () => {
    // KCC 롱2 1 -> 3개: 구역 합 34점 vs 공식 30점.
    const over = exactZones().map((x) => (x.key === "midLong" ? z("midLong", 3, 4, 2, 4) : x));
    const model = buildScoreChart(ffOf(over));
    expect(model.rows.some((r) => r.unplaced)).toBe(false);
    expect(scoreSourceNotes(ffOf(over)).join(" ")).toContain("4점 많습니다");
  });

  it("최종 점수 행은 구역 상태와 무관하게 공식 기록이다", () => {
    for (const zones of [exactZones(), mismatch(), null]) {
      expect(buildScoreChart(ffOf(zones)).total).toEqual({ home: 67, away: 80, lead: "away", margin: 13 });
    }
  });
});

describe("scoreSourceNotes", () => {
  it("구역이 정확히 맞으면 아무 말도 하지 않는다(3경기 중 2경기는 조용해야 한다)", () => {
    expect(scoreSourceNotes(ffOf(exactZones()))).toEqual([]);
  });

  it("부족분이 있으면 팀 이름과 점수와 '구역 미확인'을 그대로 적는다", () => {
    const off = exactZones().map((x) => (x.key === "close" ? z("close", 8, 19, 11, 23) : x));
    const notes = scoreSourceNotes(ffOf(off));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("부산 KCC");
    expect(notes[0]).toContain("2점");
    expect(notes[0]).toContain("구역 미확인");
    expect(notes[0]).toContain("최종 점수와 같아집니다");
  });

  it("허용을 넘어 3분류로 물러나면 그 이유와 수치를 적는다", () => {
    const far = exactZones().map((x) => (x.key === "close" ? z("close", 5, 19, 11, 23) : x)); // KCC 8점 부족
    const notes = scoreSourceNotes(ffOf(far));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("크게 어긋나");
    expect(notes[0]).toContain("공식 2점 득점 30점");
  });

  it("슛 위치 기록이 없으면 3분류로만 나눴다고 적는다", () => {
    expect(scoreSourceNotes(ffOf(null))[0]).toContain("슛 위치 자료 없이");
  });
});
