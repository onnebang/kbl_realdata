import type { CSSProperties } from "react";
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

// ── 텍스트용 팀 색 ────────────────────────────────────────────────────────────
// 요청: "경기후 AI 코트사이드 리포트에서, 신주영 같은경우 GAS 소속이니 색상을 좀 더 변경해주고,
// 팀에 대한 구분이 조금 더 되도록".
//
// 위 accentFor()는 못 쓴다. 그건 "딥다크 히어로 위의 별자리 점"용이라 명도 0.08 미만만 손대고
// 결과를 0.58로 고정한다. 본문 텍스트 기준(4.5:1)으로 보면 그 문턱을 통과한 현대모비스(L .090)·
// 정관장(.128)·SK(.167)가 다크 배경에서 각각 2.25 / 2.87 / 3.48로 떨어진다.
//
// 그리고 이 사이트에는 테마 토글이 없다 - globals.css의 @media (prefers-color-scheme: dark)
// 하나뿐이라 **서버는 사용자의 테마를 모른다.** 그래서 hex 하나를 인라인 color로 박으면 반드시
// 한쪽 테마가 깨진다. 두 색을 같이 내려보내고 미디어쿼리가 고르게 한다(개막 리포트의 --tc 패턴과
// 같은 사상, 등급만 텍스트용으로 올린 것).
//
// 표를 캐시로 두지 않는 이유: 이 계산은 팀당 이분탐색 40회라 렌더 비용이 사실상 0이고,
// 캐시 표는 팀이 색을 바꾸면 조용히 낡는다. TEAM_ACCENT는 이미 그 위험을 안고 있어서
// "살아 있는 color로 먼저 계산" 규칙을 붙여야 했다 - 여기서는 표를 아예 만들지 않는다.

/** 본문 텍스트 기준. 굵은 12.5px는 WCAG "large text"가 아니므로 3:1이 아니라 4.5:1이다. */
export const TEXT_CONTRAST_TARGET = 4.5;
/** 각 테마에서 가장 불리한 면(--surface-soft). 여기서 통과하면 --surface/--bg에서도 통과한다. */
export const LIGHT_TEXT_BG = "#ECEEF3";
export const DARK_TEXT_BG = "#23272F";

/** WCAG 2.x 대비비(1~21). hex가 아니면 null. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la == null || lb == null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 색상(hue)·채도는 그대로 두고 HSL 명도만 옮겨 배경 대비 target을 만족시킨다.
 * 이미 만족하면 원색을 그대로 돌려준다 - 필요 없는 보정은 팀 색을 왜곡할 뿐이다.
 * lighten이 true면 밝은 쪽으로(다크 배경용), false면 어두운 쪽으로 찾는다.
 */
export function readableInk(color: string, bg: string, lighten: boolean, target = TEXT_CONTRAST_TARGET): string {
  const cur = contrastRatio(color, bg);
  if (cur == null) return color; // hex가 아니면 손대지 않는다
  if (cur >= target) return color;
  // 이분탐색: lighten이면 [현재 명도, 1], 아니면 [0, 현재 명도].
  const startL = hslLightness(color);
  if (startL == null) return color;
  let lo = lighten ? startL : 0;
  let hi = lighten ? 1 : startL;
  let best = withLightness(color, lighten ? 1 : 0);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const c = withLightness(color, mid);
    const r = contrastRatio(c, bg) ?? 0;
    if (r >= target) {
      best = c; // 조건을 만족하는 것 중 원색에 가장 가까운 쪽을 계속 좁힌다
      if (lighten) hi = mid;
      else lo = mid;
    } else if (lighten) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

/**
 * 비텍스트 UI 기준(WCAG 1.4.11 Non-text Contrast). 3px 팀 색 바처럼 "읽는" 것이 아니라
 * "알아보는" 표식은 4.5:1이 아니라 3:1이다 - 그만큼 원색을 덜 밀어도 된다.
 */
export const UI_CONTRAST_TARGET = 3;

/**
 * 팀 색을 **막대·점 같은 비텍스트 표식**으로 쓸 때의 두 테마 쌍.
 *
 * accentFor를 쓰면 안 된다: 그건 딥다크 히어로 위의 별자리 점 전용이라 **다크 한쪽만** 본다.
 * 실측(하네스, 라이트 카드 #ffffff 위): 고양 소노 #3FA9F5가 2.30:1로 사라진다 - 원색이 이미
 * 밝아서 accentFor가 손대지 않고 통과시키기 때문이다. 반대로 teamInkPair(4.5:1)는 글자 기준이라
 * 막대에는 과보정이다(원색에서 그만큼 멀어진다). 그래서 같은 이분탐색을 3:1로만 돌린다.
 */
export function teamBarPair(color: string | null | undefined): { light: string; dark: string } {
  if (!color || relativeLuminance(color) == null) return { light: "#5B5F6E", dark: "#9297A8" };
  return {
    light: readableInk(color, LIGHT_TEXT_BG, false, UI_CONTRAST_TARGET),
    dark: readableInk(color, DARK_TEXT_BG, true, UI_CONTRAST_TARGET),
  };
}

/** teamInkStyle과 같은 규약(--tb-l/--tb-d 두 색을 같이 내려보내고 CSS 미디어쿼리가 고른다). */
export function teamBarStyle(color: string | null | undefined): CSSProperties {
  const bar = teamBarPair(color);
  return { "--tb-l": bar.light, "--tb-d": bar.dark } as CSSProperties;
}

/** 한 팀의 두 테마용 잉크 한 쌍. 색이 없으면 중립 잉크로 폴백한다(팀 색을 지어내지 않는다). */
export function teamInkPair(color: string | null | undefined): { light: string; dark: string } {
  if (!color || relativeLuminance(color) == null) return { light: "#5B5F6E", dark: "#9297A8" };
  return {
    light: readableInk(color, LIGHT_TEXT_BG, false),
    dark: readableInk(color, DARK_TEXT_BG, true),
  };
}

/** withLightness가 쓰는 것과 같은 변환의 명도 성분만. */
function hslLightness(hex: string): number | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

/**
 * 팀 색을 **글자색**으로 쓸 때의 인라인 스타일. 원색을 그대로 color에 넣으면 안 된다 -
 * 예: 부산 KCC #0C2340(남색)은 다크 모드 배경에서 사실상 안 보인다(실기기 제보).
 * lib/postgameReport.ts가 리포트 문장에서 쓰는 --ti-l/--ti-d 규약을 그대로 공유한다:
 * 서버는 테마를 모르므로 두 색을 같이 내려보내고 CSS 미디어쿼리가 고른다.
 */
export function teamInkStyle(color: string | null | undefined): CSSProperties {
  const ink = teamInkPair(color);
  // CSS 사용자 정의 속성은 CSSProperties에 없어서 단언이 필요하다(React가 그대로 내보낸다).
  return { "--ti-l": ink.light, "--ti-d": ink.dark } as CSSProperties;
}
