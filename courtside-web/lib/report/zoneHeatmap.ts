import {
  COURT_X,
  COURT_Y,
  HOOP_RIGHT,
  SCALE_M_PER_UNIT,
  ZONE_BOUNDS_M,
  drawCourtMarkings,
  drawHoop,
} from "../zoneCompare";

// ---------------------------------------------------------------------------
// 구역 히트맵 (Zone Heatmap)
//
// 리포트의 '슈팅 핫존' 절은 지금까지 글자만 있었다. 구역은 **골대로부터의 거리 하나로만**
// 갈리므로(zoneCompare.ts의 ZONE_BOUNDS_M - 각도 무관), 골대를 중심으로 한 동심원 밴드가
// 근사가 아니라 정확한 모양이다. 그래서 새 기하학을 만들 것이 없다:
//  - 밴드 = 골대 중심 원 5개를 큰 것부터 겹쳐 그리고, 코트 사각형으로 클리핑한다.
//  - 코트 외곽선/레인/3점 라인/림은 zoneCompare.ts의 drawCourtMarkings/drawHoop 그대로.
//
// 색은 새 팔레트를 만들지 않는다 - 팀 색 하나의 **불투명도**로 성공률을 나타낸다(브랜드 색
// 유지 + 다크/라이트 양쪽에서 같은 규칙). 숫자는 SVG 안에 넣지 않고 섹션의 HTML 표로 낸다
// (viewBox 스케일에 따라 SVG 글자 크기가 달라지는 문제를 이 프로젝트가 이미 겪었다 -
// components/GameReplay.tsx의 WinProbLiveChart 주석 참고).
// ---------------------------------------------------------------------------

/** 반오른쪽 코트만 보는 viewBox - 슛 점 차트(.zc-court)가 쓰는 것과 같은 값을 쓴다. */
export const HEATMAP_VIEWBOX = "355 27 375 357";

const u = (m: number) => m / SCALE_M_PER_UNIT;

/**
 * 성공률 → 불투명도.
 *
 * 구간을 15~90%로 잡는 이유(실측): 처음엔 0~70%로 잡았는데, 림 구역 성공률은 원래 60~90%대라
 * 상한에 다 걸려서 **88%와 82%가 같은 진하기로** 보였다(S49G14N4의 LG 림 15/17과 근거리 9/11).
 * 농구에서 실제로 나오는 구간에 계조를 몰아주는 것이 이 그림의 목적이다.
 * 시도 0회는 호출부가 회색으로 따로 뺀다.
 */
const OPACITY_MIN_PCT = 0.15;
const OPACITY_MAX_PCT = 0.9;
function opacityFor(pct: number): number {
  const t = (pct - OPACITY_MIN_PCT) / (OPACITY_MAX_PCT - OPACITY_MIN_PCT);
  return 0.1 + Math.max(0, Math.min(1, t)) * 0.75;
}

export type ZoneShare = { key: string; made: number; att: number };

/**
 * 한 팀의 구역 히트맵 SVG 내용(문자열). 호출부가 <svg viewBox={HEATMAP_VIEWBOX}>로 감싼다.
 *
 * zones는 ZONE_BOUNDS_M의 키를 쓴다. 표에 없는 키는 무시하고, 없는 키는 '시도 0'으로 그린다.
 */
export function buildZoneHeatmapSvg(zones: ZoneShare[], color: string): string {
  const byKey = new Map(zones.map((z) => [z.key, z]));
  const [hx, hy] = HOOP_RIGHT;
  const clipId = `zoneclip-${color.replace(/[^a-zA-Z0-9]/g, "")}`;

  let svg = `<defs><clipPath id="${clipId}"><rect x="${COURT_X[0]}" y="${COURT_Y[0]}" width="${COURT_X[1] - COURT_X[0]}" height="${COURT_Y[1] - COURT_Y[0]}"/></clipPath></defs>`;
  svg += `<rect x="${COURT_X[0]}" y="${COURT_Y[0]}" width="${COURT_X[1] - COURT_X[0]}" height="${COURT_Y[1] - COURT_Y[0]}" fill="var(--surface-soft)" stroke="var(--ink-faint)" stroke-width="2"/>`;

  // 큰 밴드부터 그려서 작은 밴드가 위에 얹히게 한다(동심원 겹치기 = 밴드와 같은 결과).
  // '3점'(상한 999)은 원이 아니라 남는 영역 전체라서 코트 사각형을 그대로 칠한다.
  svg += `<g clip-path="url(#${clipId})">`;
  const ordered = [...ZONE_BOUNDS_M].sort((a, b) => b[2] - a[2]);
  for (const [key, , outerM] of ordered) {
    const z = byKey.get(key);
    const pct = z && z.att > 0 ? z.made / z.att : null;
    const fill = pct == null ? "var(--ink-faint)" : color;
    const opacity = pct == null ? 0.06 : opacityFor(pct);
    if (outerM > 100) {
      svg += `<rect x="${COURT_X[0]}" y="${COURT_Y[0]}" width="${COURT_X[1] - COURT_X[0]}" height="${COURT_Y[1] - COURT_Y[0]}" fill="${fill}" opacity="${opacity.toFixed(3)}"/>`;
    } else {
      svg += `<circle cx="${hx}" cy="${hy}" r="${u(outerM).toFixed(1)}" fill="${fill}" opacity="${opacity.toFixed(3)}"/>`;
    }
  }
  // 밴드 경계선 - 색만으로는 구역이 어디서 끊기는지 안 보인다.
  for (const [, , outerM] of ZONE_BOUNDS_M) {
    if (outerM > 100) continue;
    svg += `<circle cx="${hx}" cy="${hy}" r="${u(outerM).toFixed(1)}" fill="none" stroke="var(--ink-faint)" stroke-width="1" opacity="0.45"/>`;
  }
  svg += `</g>`;

  svg += drawCourtMarkings(hx, COURT_X[1], -1, "var(--ink-faint)", 1.2);
  svg += drawHoop(hx, hy, false);
  return svg;
}
