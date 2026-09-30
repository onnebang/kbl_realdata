import { describe, expect, it } from "vitest";
import { COINFLIP_EPS, fmtProbPct, gradePrediction } from "./predictionVerdict";

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
