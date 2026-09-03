import { COURT_X, COURT_Y, HOOP_RIGHT, drawCourtMarkings, mirrorShotX } from "./zoneCompare";

// ── 히어로 배경 아트: 슛 "밀도 장(場)" ─────────────────────────────────────────────
//
// 왜 바꾸는가(요청: "시각적으로 더 화려했으면"): 기존 buildConstellationSvg는 커리어 슛을
// 최대 3,000개까지 개별 점으로 흩뿌린다. 실측(자밀 워니 커리어 7,173슛)으로 확인한 두 가지:
//   1. 점이 서로를 지운다. 림 앞은 이미 포화라 "많다"는 것만 보이고 어느 방향으로 기울었는지가
//      안 보인다. 실제로 워니는 림 정면 셀에 366개가 몰려 있는데 점으로는 그 축이 안 읽힌다.
//   2. 무겁다. 원 3,070개 ≈ 250KB. 같은 데이터를 격자로 집계하면 374셀 ≈ 30KB로 88% 줄어든다.
// 즉 이 교체는 "더 화려해지면서 동시에 가벼워지는" 흔치 않은 경우다.
//
// 기법: 격자 밀도를 흰 원의 불투명도로 그린 뒤 feGaussianBlur로 뭉개 휘도 마스크를 만들고,
// 그 마스크로 골대 중심 방사형 그라디언트를 오려낸다. 클라이언트 JS는 전혀 없고(서버에서
// 문자열로 생성해 dangerouslySetInnerHTML로 주입 - React 19의 JSX <title> 함정과 무관),
// 색은 페이지가 주입하는 CSS 변수(--hero-team/--hero-dot/--hero-dot-made)를 그대로 쓴다.
//
// 정직성: 밝기 = "시도 밀도"이지 성공률이 아니다. 성공/실패 구분은 이 레이어에서 의도적으로
// 버렸다(배경 아트가 두 가지를 동시에 주장하면 둘 다 못 읽는다). 성공률은 슛 임팩트 코트와
// 존별 표가 따로 보여준다. 호출부는 캡션에 표본 수를 반드시 적을 것.

// 반코트 뷰(히어로 viewBox "345 27 375 357")보다 살짝 넓게 잡아 흐림이 잘린 티가 나지 않게.
const FIELD_X0 = COURT_X[1] - 400; // 320
const FIELD_X1 = COURT_X[1]; // 720
const FIELD_Y0 = COURT_Y[0] - 10; // 17
const FIELD_Y1 = COURT_Y[1] + 10; // 394
const NX = 32;
const NY = 26;
const CW = (FIELD_X1 - FIELD_X0) / NX;
const CH = (FIELD_Y1 - FIELD_Y0) / NY;

/** 이보다 적으면 장이 뭉개져 형태가 안 나온다 - 점 구름으로 폴백(1시즌 선수·신입 보호).
 *  실측(2026-09-04): 26-27 로스터 198명 중 151명이 이 하한을 넘고 47명은 점으로 그려진다. */
export const FIELD_MIN_SHOTS = 60;

/**
 * 밝기 정규화의 공통 기준 - "한 칸이 전체 슛의 몇 %인가".
 * 리그 전체 553,248슛을 이 파일과 같은 격자로 집계했을 때 가장 뜨거운 칸이 14,623개 = 2.64%
 * (2026-09-04 실측). 그 값을 1.0으로 두면 선수·팀·리그의 장이 전부 같은 자에 놓여 서로 비교
 * 가능해지고, 다음 단계에서 리그 등고선을 같은 분모로 겹칠 수 있다. 이 상수를 바꾸면 모든
 * 히어로의 밝기가 함께 움직이므로, 격자(NX/NY/FIELD_*)를 고칠 때 반드시 같이 재측정할 것.
 */
export const DENSITY_SHARE_REF = 0.0264;

export type FieldShot = { x: number; y: number; d: string; made: boolean };

export type DensityFieldOptions = {
  /** SVG 내부 id 충돌 방지용 접두어. 한 문서에 히어로가 둘 이상 뜰 수 있다(비교 뷰). */
  uid: string;
  /** 등고선 모드: 흐림을 discrete로 계단화해 밀도 밴드를 만든다. 히어로 배경에 적합. */
  contour?: boolean;
  /** 코트 라인을 함께 그릴지(기본 true). */
  court?: boolean;
};

function safeId(uid: string): string {
  return uid.replace(/[^A-Za-z0-9_-]/g, "") || "x";
}

/** 점 구름 폴백 - 기존 buildConstellationSvg와 같은 그림(순환 import를 피하려고 여기 둔다). */
function dotsFallback(shots: FieldShot[]): string {
  let svg = "";
  for (const s of shots) {
    const x = mirrorShotX(s.x, s.d);
    svg += s.made
      ? `<circle cx="${x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="2.1" fill="var(--hero-dot-made)" opacity="0.5"/>`
      : `<circle cx="${x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="1.6" fill="var(--hero-dot)" opacity="0.2"/>`;
  }
  return svg;
}

export type DensityFieldResult = {
  svg: string;
  /** 폴백(점 구름)으로 그렸는지 - 호출부가 캡션을 다르게 쓸 수 있게. */
  fellBack: boolean;
  shots: number;
  cells: number;
};

/**
 * 슛 배열 -> 히어로 배경 SVG 문자열. 코트 좌표계는 lib/zoneCompare.ts 그대로이며
 * d 필드로 항상 오른쪽 골대에 미러링한다(이 저장소 전체의 컨벤션).
 */
export function buildDensityFieldSvg(shots: FieldShot[], opts: DensityFieldOptions): DensityFieldResult {
  const id = safeId(opts.uid);
  const court = opts.court === false ? "" : drawCourtMarkings(HOOP_RIGHT[0], COURT_X[1], -1, "rgba(255,255,255,0.09)", 1.3);

  if (shots.length < FIELD_MIN_SHOTS) {
    return { svg: court + dotsFallback(shots), fellBack: true, shots: shots.length, cells: 0 };
  }

  // 격자 집계. 반코트 밖(백코트 장거리 슛 등)은 가장자리 셀로 클램프해 버리지 않고 흡수한다.
  const counts = new Float64Array(NX * NY);
  let total = 0;
  for (const s of shots) {
    const mx = mirrorShotX(s.x, s.d);
    let gx = Math.floor((mx - FIELD_X0) / CW);
    let gy = Math.floor((s.y - FIELD_Y0) / CH);
    gx = gx < 0 ? 0 : gx >= NX ? NX - 1 : gx;
    gy = gy < 0 ? 0 : gy >= NY ? NY - 1 : gy;
    counts[gy * NX + gx] += 1;
    total += 1;
  }

  // 마스크용 원: 반지름은 셀 크기 고정(겹쳐서 연속면이 되도록), 불투명도만 밀도에 비례.
  //
  // 정규화는 "자기 슛 중 이 칸의 비율"(share of own shots)이다. 처음엔 자기 최대 셀 기준
  // (n/max)이었는데, 그러면 100슛짜리 림 러너와 7,215슛짜리 워니의 히어로가 똑같이 하얗게
  // 포화돼 두 선수를 나란히 놓고 비교할 수 없다(검증 지적). 분모를 "자기 총 슛"으로 바꾸면
  // 밝기가 선수·팀·리그에서 같은 뜻을 갖고, 다음 단계의 리그 등고선 층을 같은 분모로 겹칠 수 있다.
  const r = (CW * 1.3).toFixed(1);
  let circles = "";
  let cells = 0;
  for (let gy = 0; gy < NY; gy++) {
    for (let gx = 0; gx < NX; gx++) {
      const n = counts[gy * NX + gx];
      if (n <= 0) continue;
      cells++;
      const share = n / total;
      const o = Math.min(1, Math.pow(share / DENSITY_SHARE_REF, 0.6));
      const cx = (FIELD_X0 + (gx + 0.5) * CW).toFixed(1);
      const cy = (FIELD_Y0 + (gy + 0.5) * CH).toFixed(1);
      circles += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" opacity="${o.toFixed(3)}"/>`;
    }
  }

  // 등고선 모드: 알파를 7단계로 끊어 밀도 밴드를 만든다(필터 한 줄, 추가 비용 사실상 0).
  const posterize = opts.contour
    ? '<feComponentTransfer><feFuncA type="discrete" tableValues="0 .16 .32 .48 .64 .8 1"/></feComponentTransfer>'
    : "";
  const blur = opts.contour ? 11 : 9;

  // 그라디언트는 골대 중심 방사형 - 색이 코트 구조를 따라가서 장식이 아니라 지형처럼 읽힌다.
  const svg =
    `<defs>` +
    `<radialGradient id="hfg-${id}" gradientUnits="userSpaceOnUse" cx="${HOOP_RIGHT[0]}" cy="${HOOP_RIGHT[1]}" r="330">` +
    `<stop offset="0" stop-color="var(--hero-dot-made)"/>` +
    `<stop offset="0.28" stop-color="var(--hero-dot)"/>` +
    `<stop offset="0.62" stop-color="var(--hero-team)"/>` +
    `<stop offset="1" stop-color="var(--hero-team)" stop-opacity="0.35"/>` +
    `</radialGradient>` +
    `<filter id="hfb-${id}" x="-18%" y="-18%" width="136%" height="136%" color-interpolation-filters="sRGB">` +
    `<feGaussianBlur stdDeviation="${blur}"/>${posterize}` +
    `</filter>` +
    `<mask id="hfm-${id}">` +
    `<rect x="${FIELD_X0}" y="${FIELD_Y0}" width="${FIELD_X1 - FIELD_X0}" height="${FIELD_Y1 - FIELD_Y0}" fill="#000"/>` +
    `<g filter="url(#hfb-${id})">${circles}</g>` +
    `</mask>` +
    `</defs>` +
    `<rect x="${FIELD_X0}" y="${FIELD_Y0}" width="${FIELD_X1 - FIELD_X0}" height="${FIELD_Y1 - FIELD_Y0}" fill="url(#hfg-${id})" mask="url(#hfm-${id})"/>` +
    court;

  return { svg, fellBack: false, shots: shots.length, cells };
}
