// 팀 색 보조 액센트(프로필 개편 1단계, shared_design_language (8)).
//
// 두 프로필의 히어로는 라이트/다크 어느 테마에서도 딥다크(--hero-team = teams.color 인라인 주입,
// 별자리 점·그라디언트 혼합에 팀 색을 그대로 씀). 수원 KT(#1A1A1A)처럼 명도가 아주 낮은 팀 색은
// 검은 히어로 위에서 점이 사라지므로, 그런 팀만 "같은 색상(hue)의 밝은 틴트"로 점 색·그라디언트
// 혼합을 바꾼다. 배지·약어 워터마크·팀 공식 색 표기는 그대로(이건 디자인 상수이지 팀 공식 색도
// 데이터 주장도 아니다 - 캡션 없이 조용히 적용, 주석으로만 남긴다).
//
// 규칙(재현 가능하도록 고정):
//   1. teams.color의 WCAG 상대 명도 L = 0.2126 R + 0.7152 G + 0.0722 B (sRGB 선형화 후).
//   2. L < ACCENT_LUMINANCE_THRESHOLD(0.08)이면 HSL 색상·채도는 유지한 채 명도(lightness)를
//      ACCENT_LIGHTNESS(0.58)로 올린 색을 쓴다. 그 외는 팀 색 그대로.
//   3. TEAM_ACCENT는 오늘(2026-09-03) teams 테이블 13개 색에 규칙 2를 적용한 결과를 미리 적어 둔
//      표다(실측 L: KT .010 / KCC .017 / 오리온스 .022 / 삼성 .042 / LG .069 - 현대모비스 .090은 통과).
//      단, 이 표는 "규칙을 건너뛰는 상수"가 아니라 "출처 색까지 같이 적어 둔 캐시"다. accentFor()는
//      항상 살아 있는 teams.color로 규칙 1·2를 먼저 돌리고, 표의 color가 그 색과 같을 때만 미리 적어
//      둔 accent를 그대로 쓴다. 팀이 색을 바꾸거나 새 팀이 생기면 표를 건너뛰고 즉석 계산하므로
//      배지·히어로 그라디언트(=teams.color)와 별자리 점 색이 어긋나지 않는다.
//      (검증 2026-09-03: 13개 팀 전부 표 값 == 즉석 계산 값. 표는 실측 기록이자 계산 생략용일 뿐이다.)

export const ACCENT_LUMINANCE_THRESHOLD = 0.08;
export const ACCENT_LIGHTNESS = 0.58;

/**
 * tcode -> { 이 값을 계산한 출처 팀 색, 규칙 2 결과 액센트 }. 액센트는 팀 공식 색이 아니다.
 * color는 캐시 유효성 검사용이라 teams.color와 반드시 같아야 한다(다르면 accentFor가 무시하고 재계산).
 */
export const TEAM_ACCENT: Record<string, { color: string; accent: string }> = {
  "06": { color: "#1A1A1A", accent: "#949494" }, // 수원 KT (L 0.010) - 무채색이라 밝은 회색이 된다
  "60": { color: "#0C2340", accent: "#4B8BDD" }, // 부산 KCC (L 0.017)
  "30": { color: "#1E2749", accent: "#677AC1" }, // 고양 오리온스 (L 0.022, 해체 팀 - 과거 시즌 페이지용)
  "35": { color: "#1428A0", accent: "#4158E7" }, // 서울 삼성 (L 0.042)
  "50": { color: "#8E1B3D", accent: "#DD4B76" }, // 창원 LG (L 0.069)
};

function parseHex(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** WCAG 2.x 상대 명도(0~1). 파싱 실패 시 null. */
export function relativeLuminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** HSL 색상·채도를 유지하고 명도만 lightness(0~1)로 바꾼 hex. */
export function withLightness(hex: string, lightness: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l0 = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l0 > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const l = Math.min(1, Math.max(0, lightness));
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let out: [number, number, number];
  if (s === 0) out = [l, l, l];
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    out = [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
  }
  return "#" + out.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * 별자리 점·그라디언트 혼합에 쓸 색. 팀 색을 그대로 돌려주되, 명도가 임계 미만이면 보조 액센트를
 * 돌려준다. 색이 없거나 hex 파싱이 안 되면 기존 폴백(#888888 / 원본 색).
 *
 * 판단 순서가 중요하다: 표를 먼저 보고 반환하면 팀이 색을 밝게 바꿔도 옛 액센트를 계속 칠해
 * 배지·히어로 그라디언트(teams.color)와 어긋난다. 그래서 살아 있는 color로 명도를 먼저 재고,
 * 표는 "그 색으로 계산한 값이 이미 있는가"를 확인하는 캐시로만 쓴다.
 */
export function accentFor(tcode: string, color: string | null | undefined): string {
  if (!color) return "#888888";
  const lum = relativeLuminance(color);
  if (lum == null) return color; // hex가 아니면 손대지 않는다(팀 색 표기를 지어내지 않는다)
  if (lum >= ACCENT_LUMINANCE_THRESHOLD) return color;
  const cached = TEAM_ACCENT[tcode];
  if (cached && cached.color.toUpperCase() === color.trim().toUpperCase()) return cached.accent;
  return withLightness(color, ACCENT_LIGHTNESS);
}

/** 이 팀이 보조 액센트를 쓰는가(히어로 캡션 없이 조용히 적용하지만, 페이지가 알고 싶을 때). */
export function usesAccent(tcode: string, color: string | null | undefined): boolean {
  return accentFor(tcode, color) !== (color ?? "#888888");
}
