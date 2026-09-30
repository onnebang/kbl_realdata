/**
 * 경기 전 승률 하나를 '적중 / 빗나감 / 반반' 중 하나로 채점한다.
 *
 * 왜 별도 모듈인가 (2026-09-30 실측 버그): 같은 채점을 두 곳이 **각자** 하고 있었고, 서로
 * 반대되는 결론을 같은 페이지에 동시에 출력했다.
 *   - lib/postgameReport.ts '경기 결과'          : `Math.round(p*100) >= 50` → 홈 우세
 *   - lib/matchupInsights.ts gradeMatchupInsights : `p >= 0.5`               → 홈 우세
 * S49G14N4(2026-09-25 KCC 82 : 88 LG)의 home_win_prob는 **0.4977**이다. 반올림한 쪽은 50이
 * 되어 `50 >= 50`으로 홈(KCC)을 우세로 잡고 "예측은 빗나감"이라 썼고, 원값을 본 쪽은
 * 원정(LG)을 우세로 잡고 "예측 적중"이라 썼다. 한 페이지가 같은 예측을 두 번, 정반대로
 * 채점해 내보낸 것이다. 그래서 규칙을 한 곳에만 둔다 - 두 벌이 있으면 또 어긋난다.
 *
 * 규칙:
 *  1) 채점은 **항상 원값**으로 한다. 반올림한 정수를 비교하면 49.5~49.99%가 "홈 우세"로
 *     뒤집힌다(위 버그의 직접 원인).
 *  2) 양쪽 표시값이 **둘 다 50%로 반올림되는** 구간은 '반반'이다. 그 구간에서 "50%로 더
 *     유력했다"는 문장은 바로 옆에 찍힌 숫자와 모순된다 - 실제로 그렇게 배포돼 있었다.
 *     확률 예측을 0.23%p 차이로 "적중"이라 부르는 것도 같은 종류의 과장이라 같이 막는다.
 */
export type PredictionVerdict = "hit" | "miss" | "coinflip";

/**
 * 이 안쪽이면 양쪽 표시값이 다 50%가 되어 '우세한 쪽'이 없다.
 * 0.005 = 반올림해서 50%가 되는 경계(0.495 ~ 0.505)의 절반폭. 즉 "화면에 50:50으로 보이는
 * 모든 경우"와 정확히 같은 집합이다 - 임의로 고른 값이 아니라 표시 규칙에서 따라온 값.
 */
export const COINFLIP_EPS = 0.005;

export function gradePrediction(homeProb: number, homeWon: boolean): PredictionVerdict {
  if (Math.abs(homeProb - 0.5) < COINFLIP_EPS) return "coinflip";
  return (homeProb >= 0.5) === homeWon ? "hit" : "miss";
}

/**
 * 표시용 퍼센트. 반반 구간에서는 소수 첫째 자리까지 보여 **어느 쪽이 명목상 앞섰는지**를
 * 드러낸다(49.8 : 50.2). 정수로 깎으면 50 : 50이 되어 독자가 확인할 수 없다.
 */
export function fmtProbPct(prob: number, coinflip: boolean): string {
  return coinflip ? (prob * 100).toFixed(1) : String(Math.round(prob * 100));
}
