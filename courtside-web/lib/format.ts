// 부호 붙은 숫자 포맷 - 사이트 전체에서 이 하나만 쓴다(감사 항목 3 "부호 포맷 헬퍼 통일").
//
// 왜 반올림을 먼저 하나: 예전 각 페이지의 자체 헬퍼(`${v > 0 ? "+" : ""}${v.toFixed(1)}`)는
// v=-0.04를 "-0.0"으로 찍고, 색 클래스는 `v >= 0`으로 갈라 "빨간 -0.0"이나 "+0.0 없는 파란 0.0"
// 같이 표시값과 부호·색이 어긋나는 셀을 만들었다. 화면에 보이는 값은 반올림 결과이므로 부호와
// 색도 그 반올림값으로 판정해야 한다 - Number(v.toFixed(d))로 먼저 반올림하고, -0을 0으로
// 정규화한 뒤, 그 값이 양수일 때만 '+'를 붙인다. 0은 부호도 색도 없는 중립이다.
//
// 아직 자체 헬퍼를 쓰는 곳(통합 예정): app/teams/[tcode]/page.tsx signed, app/players/[pcode]/
// page.tsx signed, components/WinImpact.tsx signed(`>= 0`이라 "+0.0"을 찍는다), components/
// ImportRule.tsx signed1, components/CustomMetricBuilder.tsx, lib/playerGlance.ts signed.

/** v를 소수 digits자리로 반올림한 값. -0은 0으로 정규화한다(Object.is(-0, 0)은 false라 따로 잡는다). */
function roundTo(v: number, digits: number): number {
  const r = Number(v.toFixed(digits));
  return Object.is(r, -0) ? 0 : r;
}

/** "+1.2" / "-0.3" / "0.0" - 반올림값이 양수일 때만 '+'. */
export function signed(v: number, digits = 1): string {
  const r = roundTo(v, digits);
  return `${r > 0 ? "+" : ""}${r.toFixed(digits)}`;
}

export type SignTone = "pos" | "neg" | "zero";

/** 색 클래스 판정용 - signed()와 같은 반올림값 기준이라 "표시는 0.0인데 색은 음수" 가 생기지 않는다. */
export function signTone(v: number, digits = 1): SignTone {
  const r = roundTo(v, digits);
  return r > 0 ? "pos" : r < 0 ? "neg" : "zero";
}
