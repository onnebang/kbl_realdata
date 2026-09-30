import { describe, expect, it } from "vitest";
import {
  COINFLIP_EPS,
  ENTRY_LABEL,
  SEASON_LABEL,
  VERDICT_TEXT,
  fmtProbPct,
  gradePrediction,
  gradePredictions,
} from "./predictionVerdict";

// 이 파일이 존재하는 이유는 하나다: **같은 페이지가 같은 예측을 정반대로 채점해 내보낸 실측
// 버그**(2026-09-30, S49G14N4)를 다시 못 내게 하는 것. 자세한 경위는 predictionVerdict.ts
// 머리주석에 있다.

describe("gradePrediction", () => {
  // 버그의 핵심 수치. home_win_prob = 0.4977(홈 KCC 49.77%), 실제로는 원정 LG가 이겼다.
  const BUGGY = 0.4977;

  it("반올림한 정수로 채점하지 않는다 - 0.4977은 홈 우세가 아니다", () => {
    // 옛 코드: Math.round(0.4977*100) = 50 → `50 >= 50` → 홈 우세 → "빗나감".
    // 그 경로가 살아 있으면 아래가 "miss"로 나온다.
    expect(Math.round(BUGGY * 100)).toBe(50); // 반올림하면 정말로 50이 된다(버그의 씨앗)
    expect(gradePrediction(BUGGY, false)).toBe("coinflip");
    expect(gradePrediction(BUGGY, true)).toBe("coinflip");
  });

  it("양쪽 표시값이 다 50%가 되는 구간은 전부 '반반' - 승패와 무관하게 같은 판정", () => {
    for (const p of [0.4951, 0.4977, 0.5, 0.5023, 0.5049]) {
      expect(gradePrediction(p, true)).toBe("coinflip");
      expect(gradePrediction(p, false)).toBe("coinflip");
    }
  });

  it("경계 밖은 정상 채점 - 부호가 결과와 같으면 적중", () => {
    expect(gradePrediction(0.5 + COINFLIP_EPS, true)).toBe("hit");
    expect(gradePrediction(0.5 + COINFLIP_EPS, false)).toBe("miss");
    expect(gradePrediction(0.5 - COINFLIP_EPS, false)).toBe("hit");
    expect(gradePrediction(0.5 - COINFLIP_EPS, true)).toBe("miss");
    expect(gradePrediction(0.64, false)).toBe("miss");
    expect(gradePrediction(0.64, true)).toBe("hit");
  });

  it("반반 구간에서는 소수 첫째 자리까지 보여 어느 쪽이 명목상 앞섰는지 드러낸다", () => {
    // 정수로 깎으면 둘 다 50%가 되어 독자가 확인할 수 없다 - 그게 "50%인데 더 유력했다"는
    // 자기모순 문장이 배포된 원인이다.
    expect(fmtProbPct(BUGGY, true)).toBe("49.8");
    expect(fmtProbPct(1 - BUGGY, true)).toBe("50.2");
    expect(fmtProbPct(0.64, false)).toBe("64");
  });
});

// 제보 회귀(2026-10-01): 리포트가 시즌 기준만 채점해서, 엔트리로 맞춘 경기가 "빗나감"으로
// 나갔다. 아래 다섯 건은 오픈매치 10경기 중 두 판정이 실제로 갈린 전부다(Supabase 집계).
describe("gradePredictions - 두 예측을 따로 채점한다", () => {
  const cases: { gm: string; score: string; season: number; entry: number; homeWon: boolean; want: [string, string] }[] = [
    { gm: "S49G14N3", score: "SONO 99:86 SK", season: 0.4929, entry: 0.5622, homeWon: true, want: ["miss", "hit"] },
    { gm: "S49G14N6", score: "SK 85:103 DB", season: 0.5877, entry: 0.4704, homeWon: false, want: ["miss", "hit"] },
    { gm: "S49G14N7", score: "MOB 85:84 LG", season: 0.2954, entry: 0.4961, homeWon: true, want: ["miss", "coinflip"] },
    { gm: "S49G14N4", score: "KCC 82:88 LG", season: 0.4977, entry: 0.6359, homeWon: false, want: ["coinflip", "miss"] },
    { gm: "S49G14N9", score: "KT 96:114 SONO", season: 0.4876, entry: 0.5446, homeWon: false, want: ["hit", "miss"] },
  ];

  for (const c of cases) {
    it(`${c.gm} (${c.score}) - 시즌 ${c.want[0]} / 엔트리 ${c.want[1]}`, () => {
      const g = gradePredictions(c.season, c.entry, c.homeWon);
      expect(g.map((x) => x.label)).toEqual([SEASON_LABEL, ENTRY_LABEL]);
      expect(g.map((x) => x.verdict)).toEqual(c.want);
    });
  }

  it("두 판정이 갈린 경기가 실제로 존재한다(하나만 채점하면 안 되는 이유)", () => {
    const differ = cases.filter((c) => c.want[0] !== c.want[1]);
    expect(differ).toHaveLength(cases.length);
  });

  it("엔트리 승률이 없으면 시즌 기준 한 줄만", () => {
    const g = gradePredictions(0.58, null, false);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe(SEASON_LABEL);
  });

  it("시즌 승률이 없으면 엔트리만(순서는 시즌 -> 엔트리 고정)", () => {
    expect(gradePredictions(null, 0.62, true).map((x) => x.label)).toEqual([ENTRY_LABEL]);
    expect(gradePredictions(undefined, undefined, true)).toEqual([]);
  });

  it("표시 퍼센트는 반반일 때만 소수 첫째 자리", () => {
    const [season, entry] = gradePredictions(0.4977, 0.6359, false);
    expect([season.homePct, season.awayPct]).toEqual(["49.8", "50.2"]);
    expect([entry.homePct, entry.awayPct]).toEqual(["64", "36"]);
  });

  it("VERDICT_TEXT가 세 갈래를 모두 덮는다", () => {
    expect(VERDICT_TEXT).toEqual({ hit: "적중", miss: "빗나감", coinflip: "반반" });
  });
});
