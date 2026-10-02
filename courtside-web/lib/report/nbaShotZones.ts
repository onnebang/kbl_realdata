import { mirrorShotX, type ShotRow } from "../zoneCompare";

// ---------------------------------------------------------------------------
// NBA 2K 스타일 구역별 슈팅 브레이크다운 (NBA-Style Shooting Breakdown)
//
// 12개 기하학적 구역(Rim, Paint 3구역, Mid-range 3구역, 3-Point 5구역)으로
// 코트를 분할하고, 각 구역 안에 성공-시도(made-att) 및 성공률(pct%)과
// 핫(Red) / 콜드(Blue) / 뉴트럴(Dark) 색상을 표시한다.
// ---------------------------------------------------------------------------

export type NbaZoneKey =
  | "rim"
  | "paint_top"
  | "paint_center"
  | "paint_bottom"
  | "mid_top"
  | "mid_center"
  | "mid_bottom"
  | "three_corner_top"
  | "three_wing_top"
  | "three_top"
  | "three_wing_bottom"
  | "three_corner_bottom";

export type ZoneStats = {
  made: number;
  att: number;
};

export type NbaZoneMap = Record<NbaZoneKey, ZoneStats>;

export const NBA_ZONE_LABELS: Record<NbaZoneKey, string> = {
  rim: "골밑 (림)",
  paint_top: "페인트 좌측",
  paint_center: "페인트 정면 (플로터)",
  paint_bottom: "페인트 우측",
  mid_top: "미드레인지 좌측",
  mid_center: "미드레인지 정면",
  mid_bottom: "미드레인지 우측",
  three_corner_top: "코너 3점 (좌)",
  three_wing_top: "윙 3점 (좌)",
  three_top: "정면 3점 (탑)",
  three_wing_bottom: "윙 3점 (우)",
  three_corner_bottom: "코너 3점 (우)",
};

const HOOP_RIGHT = [681, 205.5] as const;
const SCALE_M_PER_UNIT = 0.0413;

export function classifyNbaZone(x: number, y: number, d: string): NbaZoneKey {
  const mx = mirrorShotX(x, d);
  const distM = Math.hypot(mx - HOOP_RIGHT[0], y - HOOP_RIGHT[1]) * SCALE_M_PER_UNIT;

  // 1. 3점슛 판정 (거리 6.75m 이상 또는 코너 3점 직선 구역)
  const isCornerThree = (y <= 48.8 || y >= 362.2) && mx >= 634.6;
  const isThree = distM >= 6.75 || isCornerThree;

  if (isThree) {
    if (y <= 48.8) return "three_corner_top";
    if (y >= 362.2) return "three_corner_bottom";
    if (y < 133.9) return "three_wing_top";
    if (y > 277.1) return "three_wing_bottom";
    return "three_top";
  }

  // 2. 림 구역 (1.25m 이내 골밑)
  if (distM < 1.25) {
    return "rim";
  }

  // 3. 페인트존 구역 (자유투 라인 mx >= 579.6, 레인 폭 y: 146.2 ~ 264.8)
  if (mx >= 579.6 && y >= 146.2 && y <= 264.8) {
    if (y < 175.2) return "paint_top";
    if (y > 235.8) return "paint_bottom";
    return "paint_center";
  }

  // 4. 미드레인지 구역 (3점 라인 안쪽, 페인트존 및 림 바깥)
  if (y < 146.2) return "mid_top";
  if (y > 264.8) return "mid_bottom";
  return "mid_center";
}

export function computeNbaZoneStats(shots: ShotRow[], tcode: string): NbaZoneMap {
  const keys: NbaZoneKey[] = [
    "rim",
    "paint_top",
    "paint_center",
    "paint_bottom",
    "mid_top",
    "mid_center",
    "mid_bottom",
    "three_corner_top",
    "three_wing_top",
    "three_top",
    "three_wing_bottom",
    "three_corner_bottom",
  ];

  const stats = Object.fromEntries(keys.map((k) => [k, { made: 0, att: 0 }])) as NbaZoneMap;

  for (const s of shots) {
    if (s.tcode !== tcode) continue;
    const zone = classifyNbaZone(s.x, s.y, s.d);
    stats[zone].att++;
    if (s.made) stats[zone].made++;
  }

  return stats;
}

/**
 * 핫 & 콜드존 색상 팔레트:
 * NBA 2K 게임 스타일에 맞춰:
 * - HOT: 선명한 레드 (#d32f2f / #e03131 / #c92a2a)
 * - WARM: 벽돌 레드 (#a8383b)
 * - NEUTRAL: 다크 차콜/브라운 (#2b313a / #343a40)
 * - COOL: 딥 블루 계열 (#1d4ed8)
 * - COLD: 선명한 블루 (#1971c2 / #1864ab)
 * - NONE: 코트 기본 배경 (#181d24)
 */
export type ZoneColorStyle = {
  fill: string;
  stroke: string;
  textColor: string;
  tag: "hot" | "warm" | "neutral" | "cool" | "cold" | "none";
};

export function getZoneColorStyle(stat: ZoneStats, zoneKey: NbaZoneKey): ZoneColorStyle {
  if (stat.att === 0) {
    return {
      fill: "#181d24",
      stroke: "rgba(255, 255, 255, 0.28)",
      textColor: "transparent",
      tag: "none",
    };
  }

  const pct = Math.round((stat.made / stat.att) * 100);
  const isThree = zoneKey.startsWith("three");
  const isRim = zoneKey === "rim";

  // 3점은 40% 이상이면 Hot, 33~39% Neutral, 32% 이하 Cold (0%는 강력한 Cold)
  // 림은 65% 이상 Hot, 50~64% Neutral, 49% 이하 Cold
  // 미드/페인트는 50% 이상 Hot, 38~49% Neutral, 37% 이하 Cold
  if (pct === 0) {
    return {
      fill: "#1565c0", // 선명한 블루 (0%)
      stroke: "rgba(255, 255, 255, 0.55)",
      textColor: "#ffffff",
      tag: "cold",
    };
  }

  if (isThree) {
    if (pct >= 50) return { fill: "#c92a2a", stroke: "rgba(255, 255, 255, 0.65)", textColor: "#ffffff", tag: "hot" };
    if (pct >= 40) return { fill: "#b03a2e", stroke: "rgba(255, 255, 255, 0.55)", textColor: "#ffffff", tag: "warm" };
    if (pct >= 30) return { fill: "#2e3440", stroke: "rgba(255, 255, 255, 0.45)", textColor: "#ffffff", tag: "neutral" };
    return { fill: "#1e40af", stroke: "rgba(255, 255, 255, 0.55)", textColor: "#ffffff", tag: "cool" };
  }

  if (isRim) {
    if (pct >= 75) return { fill: "#c92a2a", stroke: "rgba(255, 255, 255, 0.65)", textColor: "#ffffff", tag: "hot" };
    if (pct >= 60) return { fill: "#b03a2e", stroke: "rgba(255, 255, 255, 0.55)", textColor: "#ffffff", tag: "warm" };
    if (pct >= 45) return { fill: "#2e3440", stroke: "rgba(255, 255, 255, 0.45)", textColor: "#ffffff", tag: "neutral" };
    return { fill: "#1e40af", stroke: "rgba(255, 255, 255, 0.55)", textColor: "#ffffff", tag: "cool" };
  }

  // 미드레인지 / 페인트존
  if (pct >= 55) return { fill: "#c92a2a", stroke: "rgba(255, 255, 255, 0.65)", textColor: "#ffffff", tag: "hot" };
  if (pct >= 42) return { fill: "#a8383b", stroke: "rgba(255, 255, 255, 0.55)", textColor: "#ffffff", tag: "warm" };
  if (pct >= 32) return { fill: "#2e3440", stroke: "rgba(255, 255, 255, 0.45)", textColor: "#ffffff", tag: "neutral" };
  return { fill: "#1e40af", stroke: "rgba(255, 255, 255, 0.55)", textColor: "#ffffff", tag: "cool" };
}

// ---------------------------------------------------------------------------
// SVG Path 및 기하학 정의 (오른쪽 하프코트 x: 375~720, y: 27~384)
// ---------------------------------------------------------------------------

type ZonePathDef = {
  key: NbaZoneKey;
  d: string;
  cx: number;
  cy: number;
};

export const RIGHT_HALF_PATHS: ZonePathDef[] = [
  // 1. 림 구역
  {
    key: "rim",
    d: "M 720,175.2 L 681,175.2 A 30.3 30.3 0 0 0 681,235.8 L 720,235.8 Z",
    cx: 664,
    cy: 205.5,
  },
  // 2. 페인트 상단
  {
    key: "paint_top",
    d: "M 720,146.2 L 579.6,146.2 L 579.6,175.2 L 720,175.2 Z",
    cx: 645,
    cy: 160.7,
  },
  // 3. 페인트 중앙 (플로터 구역)
  {
    key: "paint_center",
    d: "M 681,175.2 L 579.6,175.2 L 579.6,235.8 L 681,235.8 A 30.3 30.3 0 0 1 681,175.2 Z",
    cx: 625,
    cy: 205.5,
  },
  // 4. 페인트 하단
  {
    key: "paint_bottom",
    d: "M 720,235.8 L 579.6,235.8 L 579.6,264.8 L 720,264.8 Z",
    cx: 645,
    cy: 250.3,
  },
  // 5. 미드레인지 상단
  {
    key: "mid_top",
    d: "M 720,48.8 L 720,146.2 L 579.6,146.2 L 534.1,133.9 A 163.4 163.4 0 0 1 634.6,48.8 L 720,48.8 Z",
    cx: 630,
    cy: 100,
  },
  // 6. 미드레인지 중앙
  {
    key: "mid_center",
    d: "M 579.6,146.2 L 534.1,133.9 A 163.4 163.4 0 0 0 534.1,277.1 L 579.6,264.8 Z",
    cx: 552,
    cy: 205.5,
  },
  // 7. 미드레인지 하단
  {
    key: "mid_bottom",
    d: "M 720,264.8 L 579.6,264.8 L 534.1,277.1 A 163.4 163.4 0 0 1 634.6,362.2 L 720,362.2 Z",
    cx: 630,
    cy: 311,
  },
  // 8. 3점 상단 코너
  {
    key: "three_corner_top",
    d: "M 634.6,27 L 720,27 L 720,48.8 L 634.6,48.8 Z",
    cx: 677,
    cy: 38,
  },
  // 9. 3점 상단 윙
  {
    key: "three_wing_top",
    d: "M 375,27 L 634.6,27 L 634.6,48.8 A 163.4 163.4 0 0 0 534.1,133.9 L 375,56.4 Z",
    cx: 485,
    cy: 80,
  },
  // 10. 3점 정면 탑
  {
    key: "three_top",
    d: "M 375,56.4 L 534.1,133.9 A 163.4 163.4 0 0 0 534.1,277.1 L 375,354.6 Z",
    cx: 432,
    cy: 205.5,
  },
  // 11. 3점 하단 윙
  {
    key: "three_wing_bottom",
    d: "M 375,354.6 L 534.1,277.1 A 163.4 163.4 0 0 0 634.6,362.2 L 634.6,384 L 375,384 Z",
    cx: 485,
    cy: 331,
  },
  // 12. 3점 하단 코너
  {
    key: "three_corner_bottom",
    d: "M 634.6,362.2 L 720,362.2 L 720,384 L 634.6,384 Z",
    cx: 677,
    cy: 373,
  },
];

// 왼쪽 하프코트 (Left Half Court: x: 30~375, y: 27~384)
// x좌표를 750 - x로 대칭 반전
export const LEFT_HALF_PATHS: ZonePathDef[] = [
  {
    key: "rim",
    d: "M 30,175.2 L 69,175.2 A 30.3 30.3 0 0 1 69,235.8 L 30,235.8 Z",
    cx: 86,
    cy: 205.5,
  },
  {
    key: "paint_top",
    d: "M 30,146.2 L 170.4,146.2 L 170.4,175.2 L 30,175.2 Z",
    cx: 105,
    cy: 160.7,
  },
  {
    key: "paint_center",
    d: "M 69,175.2 L 170.4,175.2 L 170.4,235.8 L 69,235.8 A 30.3 30.3 0 0 0 69,175.2 Z",
    cx: 125,
    cy: 205.5,
  },
  {
    key: "paint_bottom",
    d: "M 30,235.8 L 170.4,235.8 L 170.4,264.8 L 30,264.8 Z",
    cx: 105,
    cy: 250.3,
  },
  {
    key: "mid_top",
    d: "M 30,48.8 L 30,146.2 L 170.4,146.2 L 215.9,133.9 A 163.4 163.4 0 0 0 115.4,48.8 L 30,48.8 Z",
    cx: 120,
    cy: 100,
  },
  {
    key: "mid_center",
    d: "M 170.4,146.2 L 215.9,133.9 A 163.4 163.4 0 0 1 215.9,277.1 L 170.4,264.8 Z",
    cx: 198,
    cy: 205.5,
  },
  {
    key: "mid_bottom",
    d: "M 30,264.8 L 170.4,264.8 L 215.9,277.1 A 163.4 163.4 0 0 0 115.4,362.2 L 30,362.2 Z",
    cx: 120,
    cy: 311,
  },
  {
    key: "three_corner_top",
    d: "M 115.4,27 L 30,27 L 30,48.8 L 115.4,48.8 Z",
    cx: 73,
    cy: 38,
  },
  {
    key: "three_wing_top",
    d: "M 375,27 L 115.4,27 L 115.4,48.8 A 163.4 163.4 0 0 1 215.9,133.9 L 375,56.4 Z",
    cx: 265,
    cy: 80,
  },
  {
    key: "three_top",
    d: "M 375,56.4 L 215.9,133.9 A 163.4 163.4 0 0 1 215.9,277.1 L 375,354.6 Z",
    cx: 318,
    cy: 205.5,
  },
  {
    key: "three_wing_bottom",
    d: "M 375,354.6 L 215.9,277.1 A 163.4 163.4 0 0 1 115.4,362.2 L 115.4,384 L 375,384 Z",
    cx: 265,
    cy: 331,
  },
  {
    key: "three_corner_bottom",
    d: "M 115.4,362.2 L 30,362.2 L 30,384 L 115.4,384 Z",
    cx: 73,
    cy: 373,
  },
];

/**
 * 하프코트 섹터와 텍스트를 렌더링하는 SVG 조각 생성
 */
export function renderZoneSectors(paths: ZonePathDef[], stats: NbaZoneMap): string {
  let svg = "";

  // 1. 패스 (구역 배경 채움 및 테두리선)
  for (const p of paths) {
    const s = stats[p.key];
    const style = getZoneColorStyle(s, p.key);
    svg += `<path class="nba-zone-path" data-zone="${p.key}" d="${p.d}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.8" stroke-linejoin="round" />`;
  }

  // 2. 텍스트 라벨 (시도-성공 및 성공률)
  for (const p of paths) {
    const s = stats[p.key];
    if (s.att === 0) continue;

    const pct = Math.round((s.made / s.att) * 100);
    // 두 줄 텍스트: 상단 made-att, 하단 pct%
    svg += `<g class="nba-zone-label" pointer-events="none">`;
    svg += `<text x="${p.cx}" y="${p.cy - 4}" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="11.5" font-weight="800" letter-spacing="-0.2px" filter="drop-shadow(0 1px 2px rgba(0,0,0,0.85))">${s.made}-${s.att}</text>`;
    svg += `<text x="${p.cx}" y="${p.cy + 9}" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="10.5" font-weight="700" letter-spacing="-0.2px" filter="drop-shadow(0 1px 2px rgba(0,0,0,0.85))">${pct}%</text>`;
    svg += `</g>`;
  }

  return svg;
}

/** 코트 기본 마킹 선 (센터서클, 하프라인, 림/백보드) */
export function renderCourtCourtLines(view: "full" | "right" | "left"): string {
  let svg = `<g class="nba-court-markings" pointer-events="none" stroke="rgba(255, 255, 255, 0.45)" stroke-width="1.5" fill="none">`;

  // 외곽선
  if (view === "full") {
    svg += `<rect x="30" y="27" width="690" height="357" stroke-width="2.2" />`;
    // 하프라인
    svg += `<line x1="375" y1="27" x2="375" y2="384" stroke-width="2" />`;
    // 센터서클
    svg += `<circle cx="375" cy="205.5" r="43.6" />`;
  } else if (view === "right") {
    svg += `<rect x="375" y="27" width="345" height="357" stroke-width="2.2" />`;
    svg += `<path d="M 375,161.9 A 43.6 43.6 0 0 1 375,249.1" />`;
  } else {
    svg += `<rect x="30" y="27" width="345" height="357" stroke-width="2.2" />`;
    svg += `<path d="M 375,161.9 A 43.6 43.6 0 0 0 375,249.1" />`;
  }

  // 골대 & 백보드
  const drawSingleHoop = (hx: number, isRight: boolean) => {
    const bbX = isRight ? hx + 18 : hx - 18;
    let hSvg = `<line x1="${bbX}" y1="${205.5 - 24}" x2="${bbX}" y2="${205.5 + 24}" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round" />`;
    hSvg += `<circle cx="${hx}" cy="205.5" r="10.5" stroke="#f08c00" stroke-width="3" />`;
    return hSvg;
  };

  if (view === "full" || view === "right") svg += drawSingleHoop(681, true);
  if (view === "full" || view === "left") svg += drawSingleHoop(69, false);

  svg += `</g>`;
  return svg;
}

export const NBA_DUAL_VIEWBOX = "25 20 700 370";
export const NBA_SINGLE_RIGHT_VIEWBOX = "370 20 355 370";
export const NBA_SINGLE_LEFT_VIEWBOX = "25 20 355 370";

/**
 * PC 화면용 듀얼 쇼다운 코트 SVG (왼쪽: 홈팀, 오른쪽: 원정팀)
 */
export function buildNbaDualCourtSvg(homeStats: NbaZoneMap, awayStats: NbaZoneMap): string {
  let svg = `<rect x="30" y="27" width="690" height="357" fill="#14181f" />`;
  // 왼쪽 홈팀 섹터
  svg += renderZoneSectors(LEFT_HALF_PATHS, homeStats);
  // 오른쪽 원정팀 섹터
  svg += renderZoneSectors(RIGHT_HALF_PATHS, awayStats);
  // 코트 라인
  svg += renderCourtCourtLines("full");
  return svg;
}

/**
 * 모바일 화면용 단일 하프코트 SVG
 */
export function buildNbaSingleCourtSvg(stats: NbaZoneMap, isLeft: boolean = false): string {
  if (isLeft) {
    let svg = `<rect x="30" y="27" width="345" height="357" fill="#14181f" />`;
    svg += renderZoneSectors(LEFT_HALF_PATHS, stats);
    svg += renderCourtCourtLines("left");
    return svg;
  }
  let svg = `<rect x="375" y="27" width="345" height="357" fill="#14181f" />`;
  svg += renderZoneSectors(RIGHT_HALF_PATHS, stats);
  svg += renderCourtCourtLines("right");
  return svg;
}

/**
 * 5개 구역 통계(ZoneTotal[])만 있을 때 12개 구역으로 안전하게 폴백 매핑
 */
export function fallbackZoneTotalsToNbaMap(
  zones: { key: string; made: number; att: number }[]
): NbaZoneMap {
  const byKey = new Map(zones.map((z) => [z.key, z]));
  const rim = byKey.get("rim") ?? { made: 0, att: 0 };
  const close = byKey.get("close") ?? { made: 0, att: 0 };
  const midShort = byKey.get("midShort") ?? { made: 0, att: 0 };
  const midLong = byKey.get("midLong") ?? { made: 0, att: 0 };
  const three = byKey.get("three") ?? { made: 0, att: 0 };

  const div3 = (s: { made: number; att: number }) => ({
    made: Math.round(s.made / 3),
    att: Math.round(s.att / 3),
  });
  const div5 = (s: { made: number; att: number }) => ({
    made: Math.round(s.made / 5),
    att: Math.round(s.att / 5),
  });

  const pClose = div3(close);
  const pMid = div3(midShort);
  const pLong = div3(midLong);
  const p3 = div5(three);

  return {
    rim: { made: rim.made, att: rim.att },
    paint_top: pClose,
    paint_center: pClose,
    paint_bottom: pClose,
    mid_top: pMid,
    mid_center: pMid,
    mid_bottom: pLong,
    three_corner_top: p3,
    three_wing_top: p3,
    three_top: p3,
    three_wing_bottom: p3,
    three_corner_bottom: p3,
  };
}

