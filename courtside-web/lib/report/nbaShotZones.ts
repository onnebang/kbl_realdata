import { mirrorShotX, type ShotRow } from "../zoneCompare";
import type { ReportTeamMeta } from "./renderKit";

// ---------------------------------------------------------------------------
// NBA 2K 스타일 구역별 슈팅 브레이크다운 (NBA-Style Shooting Breakdown)
//
// 12개 기하학적 구역(Rim, Paint 3구역, Mid-range 3구역, 3-Point 5구역)으로
// 코트를 분할하고, 각 구역 안에 성공-시도(made-att) 및 성공률(pct%)과
// 핫(Red) / 콜드(Blue) / 뉴트럴(Dark) 색상을 표시한다.
//
// 마우스 오버레이/터치 시 해당 위치에서 누가 시도를 많이 했고,
// 누가 득점을 주도했으며, 누가 실패가 많았는지 선수별 구성을 실시간으로 확인한다.
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

export type PlayerZoneStat = {
  pcode: string;
  name: string;
  made: number;
  att: number;
  missed: number;
  pct: number;
};

export type ZonePlayerBreakdown = {
  zoneKey: NbaZoneKey;
  zoneName: string;
  teamName: string;
  teamColor: string;
  totalMade: number;
  totalAtt: number;
  totalPct: number;
  players: PlayerZoneStat[];
  topMakers: PlayerZoneStat[];
  topMissers: PlayerZoneStat[];
};

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

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

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
 * 12개 구역별 선수별 슈팅 내역 분석
 * (누가 많이 던졌고, 누가 많이 넣었으며, 누가 실패했는지)
 */
export function computeZonePlayerBreakdowns(
  shots: ShotRow[],
  tcode: string,
  teamName: string,
  teamColor: string,
  playerNames: Record<string, string> = {}
): Record<NbaZoneKey, ZonePlayerBreakdown> {
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

  const mapByZone: Record<string, Map<string, { made: number; att: number }>> = {};
  for (const k of keys) mapByZone[k] = new Map();

  for (const s of shots) {
    if (s.tcode !== tcode) continue;
    const zone = classifyNbaZone(s.x, s.y, s.d);
    const pcode = s.pcode || "unknown";
    const pMap = mapByZone[zone];
    const prev = pMap.get(pcode) || { made: 0, att: 0 };
    prev.att++;
    if (s.made) prev.made++;
    pMap.set(pcode, prev);
  }

  const result: Partial<Record<NbaZoneKey, ZonePlayerBreakdown>> = {};

  for (const key of keys) {
    const pMap = mapByZone[key];
    const players: PlayerZoneStat[] = [];
    let totalMade = 0;
    let totalAtt = 0;

    for (const [pcode, st] of pMap.entries()) {
      const name = playerNames[pcode] || (pcode === "unknown" ? "팀 미상" : `선수(${pcode})`);
      const missed = st.att - st.made;
      const pct = st.att > 0 ? Math.round((st.made / st.att) * 100) : 0;
      players.push({ pcode, name, made: st.made, att: st.att, missed, pct });
      totalMade += st.made;
      totalAtt += st.att;
    }

    // 시도 많은 순 정렬
    players.sort((a, b) => b.att - a.att || b.made - a.made);

    // 많이 넣은 선수 (made > 0, made 많은 순)
    const topMakers = [...players].filter((p) => p.made > 0).sort((a, b) => b.made - a.made || b.pct - a.pct);

    // 실패가 많은 선수 (missed > 0, missed 많은 순)
    const topMissers = [...players].filter((p) => p.missed > 0).sort((a, b) => b.missed - a.missed || a.pct - b.pct);

    const totalPct = totalAtt > 0 ? Math.round((totalMade / totalAtt) * 100) : 0;

    result[key] = {
      zoneKey: key,
      zoneName: NBA_ZONE_LABELS[key],
      teamName,
      teamColor,
      totalMade,
      totalAtt,
      totalPct,
      players,
      topMakers,
      topMissers,
    };
  }

  return result as Record<NbaZoneKey, ZonePlayerBreakdown>;
}

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

  if (pct === 0) {
    return {
      fill: "#1565c0",
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

  if (pct >= 55) return { fill: "#c92a2a", stroke: "rgba(255, 255, 255, 0.65)", textColor: "#ffffff", tag: "hot" };
  if (pct >= 42) return { fill: "#a8383b", stroke: "rgba(255, 255, 255, 0.55)", textColor: "#ffffff", tag: "warm" };
  if (pct >= 32) return { fill: "#2e3440", stroke: "rgba(255, 255, 255, 0.45)", textColor: "#ffffff", tag: "neutral" };
  return { fill: "#1e40af", stroke: "rgba(255, 255, 255, 0.55)", textColor: "#ffffff", tag: "cool" };
}

// ---------------------------------------------------------------------------
// SVG Path 및 기하학 정의 (오른쪽 하프코트 x: 375~720, y: 27~384)
// ---------------------------------------------------------------------------

export type ZonePathDef = {
  key: NbaZoneKey;
  d: string;
  cx: number;
  cy: number;
};

export const RIGHT_HALF_PATHS: ZonePathDef[] = [
  {
    key: "rim",
    d: "M 720,175.2 L 681,175.2 A 30.3 30.3 0 0 0 681,235.8 L 720,235.8 Z",
    cx: 660,
    cy: 205.5,
  },
  {
    key: "paint_top",
    d: "M 720,146.2 L 579.6,146.2 L 579.6,175.2 L 720,175.2 Z",
    cx: 645,
    cy: 160.7,
  },
  {
    key: "paint_center",
    d: "M 681,175.2 L 579.6,175.2 L 579.6,235.8 L 681,235.8 A 30.3 30.3 0 0 1 681,175.2 Z",
    cx: 615,
    cy: 205.5,
  },
  {
    key: "paint_bottom",
    d: "M 720,235.8 L 579.6,235.8 L 579.6,264.8 L 720,264.8 Z",
    cx: 645,
    cy: 250.3,
  },
  {
    key: "mid_top",
    d: "M 720,48.8 L 720,146.2 L 579.6,146.2 L 534.1,133.9 A 163.4 163.4 0 0 1 634.6,48.8 L 720,48.8 Z",
    cx: 630,
    cy: 100,
  },
  {
    key: "mid_center",
    d: "M 579.6,146.2 L 534.1,133.9 A 163.4 163.4 0 0 0 534.1,277.1 L 579.6,264.8 Z",
    cx: 552,
    cy: 205.5,
  },
  {
    key: "mid_bottom",
    d: "M 720,264.8 L 579.6,264.8 L 534.1,277.1 A 163.4 163.4 0 0 0 634.6,362.2 L 720,362.2 Z",
    cx: 630,
    cy: 311,
  },
  {
    key: "three_corner_top",
    d: "M 634.6,27 L 720,27 L 720,48.8 L 634.6,48.8 Z",
    cx: 677,
    cy: 38,
  },
  {
    key: "three_wing_top",
    d: "M 375,27 L 634.6,27 L 634.6,48.8 A 163.4 163.4 0 0 0 534.1,133.9 L 375,56.4 Z",
    cx: 485,
    cy: 80,
  },
  {
    key: "three_top",
    d: "M 375,56.4 L 534.1,133.9 A 163.4 163.4 0 0 0 534.1,277.1 L 375,354.6 Z",
    cx: 432,
    cy: 205.5,
  },
  {
    key: "three_wing_bottom",
    d: "M 375,354.6 L 534.1,277.1 A 163.4 163.4 0 0 0 634.6,362.2 L 634.6,384 L 375,384 Z",
    cx: 485,
    cy: 331,
  },
  {
    key: "three_corner_bottom",
    d: "M 634.6,362.2 L 720,362.2 L 720,384 L 634.6,384 Z",
    cx: 677,
    cy: 373,
  },
];

// 왼쪽 하프코트 (Left Half Court: x: 30~375, y: 27~384)
export const LEFT_HALF_PATHS: ZonePathDef[] = [
  {
    key: "rim",
    d: "M 30,175.2 L 69,175.2 A 30.3 30.3 0 0 1 69,235.8 L 30,235.8 Z",
    cx: 90,
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
    cx: 135,
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
    d: "M 30,264.8 L 170.4,264.8 L 215.9,277.1 A 163.4 163.4 0 0 1 115.4,362.2 L 30,362.2 Z",
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
 * 1. 구역 패스 (배경 채움 및 테두리선) + 선수별 슈팅 내역 data 속성 및 브라우저 title 툴팁
 */
export function renderZonePaths(
  paths: ZonePathDef[],
  stats: NbaZoneMap,
  breakdowns?: Record<NbaZoneKey, ZonePlayerBreakdown>
): string {
  let svg = "";
  for (const p of paths) {
    const s = stats[p.key];
    const style = getZoneColorStyle(s, p.key);
    const bd = breakdowns ? breakdowns[p.key] : null;

    let titleText = "";
    let dataAttrs = `data-zone="${p.key}"`;

    if (bd && bd.totalAtt > 0) {
      const topMakersText = bd.topMakers.slice(0, 3).map((m) => `${m.name} ${m.made}/${m.att}(${m.pct}%)`).join(", ");
      const topMissersText = bd.topMissers.slice(0, 3).map((m) => `${m.name} ${m.missed}개 실패(${m.made}/${m.att})`).join(", ");

      titleText =
        `[${bd.teamName}] ${bd.zoneName} · ${bd.totalMade}/${bd.totalAtt} (${bd.totalPct}%)\n` +
        `────────────────────────────\n` +
        (topMakersText ? `🎯 득점 주도: ${topMakersText}\n` : "") +
        (topMissersText ? `❌ 실패/난조: ${topMissersText}\n` : "") +
        `────────────────────────────\n` +
        `선수별 시도 순:\n` +
        bd.players.map((pl) => `• ${pl.name}: ${pl.made}/${pl.att} (${pl.pct}%)`).join("\n");

      dataAttrs += ` data-team="${escAttr(bd.teamName)}" data-zonename="${escAttr(bd.zoneName)}" data-stat="${bd.totalMade}/${bd.totalAtt} (${bd.totalPct}%)" data-makers="${escAttr(topMakersText || '없음')}" data-missers="${escAttr(topMissersText || '없음')}" data-players="${escAttr(JSON.stringify(bd.players))}"`;
    } else if (bd) {
      titleText = `[${bd.teamName}] ${bd.zoneName} · 시도 없음`;
      dataAttrs += ` data-team="${escAttr(bd.teamName)}" data-zonename="${escAttr(bd.zoneName)}" data-stat="시도 없음" data-makers="" data-missers="" data-players="[]"`;
    }

    svg += `<path class="nba-zone-path" ${dataAttrs} d="${p.d}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.8" stroke-linejoin="round">`;
    if (titleText) {
      svg += `<title>${escHtml(titleText)}</title>`;
    }
    svg += `</path>`;
  }
  return svg;
}

/**
 * 2. 텍스트 라벨 (시도-성공 및 성공률) - 모든 선 위에 최상위 레이어로 얹힘
 */
export function renderZoneLabels(paths: ZonePathDef[], stats: NbaZoneMap): string {
  let svg = "";
  for (const p of paths) {
    const s = stats[p.key];
    if (s.att === 0) continue;

    const pct = Math.round((s.made / s.att) * 100);
    svg += `<g class="nba-zone-label" pointer-events="none">`;
    svg += `<text x="${p.cx}" y="${p.cy - 4}" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="11.5" font-weight="800" letter-spacing="-0.2px" filter="drop-shadow(0 1px 3px rgba(0,0,0,0.9))">${s.made}-${s.att}</text>`;
    svg += `<text x="${p.cx}" y="${p.cy + 9}" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="10.5" font-weight="700" letter-spacing="-0.2px" filter="drop-shadow(0 1px 3px rgba(0,0,0,0.9))">${pct}%</text>`;
    svg += `</g>`;
  }
  return svg;
}

export function renderZoneSectors(paths: ZonePathDef[], stats: NbaZoneMap): string {
  return renderZonePaths(paths, stats) + renderZoneLabels(paths, stats);
}

/**
 * 다크 테마 배경(#14181f)에서 항상 선명하게 읽히도록 색상 휘도 보정
 */
export function ensureReadableColor(hex?: string | null, fallback: string = "#f1f5f9"): string {
  if (!hex) return fallback;
  const cleaned = hex.replace("#", "").trim();
  if (cleaned.length !== 6 && cleaned.length !== 3) return fallback;
  let r: number, g: number, b: number;
  if (cleaned.length === 3) {
    r = parseInt(cleaned[0] + cleaned[0], 16);
    g = parseInt(cleaned[1] + cleaned[1], 16);
    b = parseInt(cleaned[2] + cleaned[2], 16);
  } else {
    r = parseInt(cleaned.substring(0, 2), 16);
    g = parseInt(cleaned.substring(2, 4), 16);
    b = parseInt(cleaned.substring(4, 6), 16);
  }
  const maxC = Math.max(r, g, b);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // 검은색(#000000) 및 극도로 어두운 톤 (최대 채널값 < 45 또는 휘도 < 25)
  if (maxC < 45 || lum < 25) {
    return fallback;
  }
  return hex;
}

/** 코트 바닥에 팀 로고/약어 워터마크 */
function renderTeamWatermark(team: ReportTeamMeta, isRight: boolean): string {
  const cx = isRight ? 550 : 200;
  const cy = 205.5;
  const color = ensureReadableColor(team.color, "#ffffff");
  let svg = `<g class="nba-team-watermark" pointer-events="none">`;

  // 팀 약어 워터마크 (선명하면서도 은은한 불투명도)
  svg += `<text x="${cx}" y="${cy + 6}" text-anchor="middle" dominant-baseline="central" fill="${color}" opacity="0.14" font-size="78" font-weight="900" letter-spacing="-1px" font-family="'Pretendard', sans-serif">${team.abbr}</text>`;

  // 팀 로고 이미지 오버레이
  if (team.logo_url) {
    svg += `<image href="${team.logo_url}" x="${cx - 55}" y="${cy - 55}" width="110" height="110" opacity="0.18" preserveAspectRatio="xMidYMid meet" />`;
  }

  svg += `</g>`;
  return svg;
}

/** 코트 기본 마킹 선 (센터서클, 하프라인, 림/백보드) */
export function renderCourtCourtLines(
  view: "full" | "right" | "left",
  _homeTeam?: ReportTeamMeta,
  _awayTeam?: ReportTeamMeta
): string {
  let svg = `<g class="nba-court-markings" pointer-events="none">`;
  const courtBorder = "rgba(255, 255, 255, 0.4)";

  if (view === "full") {
    // 단일 통일 코트 외곽 직사각형 라인
    svg += `<rect x="30" y="27" width="690" height="357" fill="none" stroke="${courtBorder}" stroke-width="1.8" />`;
    // 하프라인 및 센터서클
    svg += `<line x1="375" y1="27" x2="375" y2="384" stroke="rgba(255, 255, 255, 0.65)" stroke-width="2" />`;
    svg += `<circle cx="375" cy="205.5" r="43.6" fill="none" stroke="rgba(255, 255, 255, 0.65)" stroke-width="1.8" />`;
  } else if (view === "right") {
    svg += `<path d="M 375,27 L 720,27 L 720,384 L 375,384 Z" fill="none" stroke="${courtBorder}" stroke-width="1.8" />`;
    svg += `<line x1="375" y1="27" x2="375" y2="384" stroke="rgba(255, 255, 255, 0.65)" stroke-width="2" />`;
    svg += `<path d="M 375,161.9 A 43.6 43.6 0 0 1 375,249.1" fill="none" stroke="rgba(255, 255, 255, 0.65)" stroke-width="1.8" />`;
  } else {
    svg += `<path d="M 375,27 L 30,27 L 30,384 L 375,384 Z" fill="none" stroke="${courtBorder}" stroke-width="1.8" />`;
    svg += `<line x1="375" y1="27" x2="375" y2="384" stroke="rgba(255, 255, 255, 0.65)" stroke-width="2" />`;
    svg += `<path d="M 375,161.9 A 43.6 43.6 0 0 0 375,249.1" fill="none" stroke="rgba(255, 255, 255, 0.65)" stroke-width="1.8" />`;
  }

  const drawSingleHoop = (hx: number, isRight: boolean) => {
    const bbX = isRight ? hx + 18 : hx - 18;
    let hSvg = `<line x1="${bbX}" y1="${205.5 - 24}" x2="${bbX}" y2="${205.5 + 24}" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round" opacity="0.9" />`;
    hSvg += `<circle cx="${hx}" cy="205.5" r="9.5" fill="none" stroke="#f08c00" stroke-width="2.6" opacity="0.85" />`;
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
export function buildNbaDualCourtSvg(
  homeStats: NbaZoneMap,
  awayStats: NbaZoneMap,
  homeTeam?: ReportTeamMeta,
  awayTeam?: ReportTeamMeta,
  homeBreakdowns?: Record<NbaZoneKey, ZonePlayerBreakdown>,
  awayBreakdowns?: Record<NbaZoneKey, ZonePlayerBreakdown>
): string {
  let svg = `<rect x="30" y="27" width="690" height="357" fill="#12151b" />`;

  if (homeTeam) svg += renderTeamWatermark(homeTeam, false);
  if (awayTeam) svg += renderTeamWatermark(awayTeam, true);

  svg += renderZonePaths(LEFT_HALF_PATHS, homeStats, homeBreakdowns);
  svg += renderZonePaths(RIGHT_HALF_PATHS, awayStats, awayBreakdowns);

  svg += renderCourtCourtLines("full", homeTeam, awayTeam);

  svg += renderZoneLabels(LEFT_HALF_PATHS, homeStats);
  svg += renderZoneLabels(RIGHT_HALF_PATHS, awayStats);

  return svg;
}

/**
 * 모바일 화면용 단일 하프코트 SVG
 */
export function buildNbaSingleCourtSvg(
  stats: NbaZoneMap,
  team?: ReportTeamMeta,
  isLeft: boolean = false,
  breakdowns?: Record<NbaZoneKey, ZonePlayerBreakdown>
): string {
  if (isLeft) {
    let svg = `<rect x="30" y="27" width="345" height="357" fill="#12151b" />`;
    if (team) svg += renderTeamWatermark(team, false);
    svg += renderZonePaths(LEFT_HALF_PATHS, stats, breakdowns);
    svg += renderCourtCourtLines("left", team, undefined);
    svg += renderZoneLabels(LEFT_HALF_PATHS, stats);
    return svg;
  }
  let svg = `<rect x="375" y="27" width="345" height="357" fill="#12151b" />`;
  if (team) svg += renderTeamWatermark(team, true);
  svg += renderZonePaths(RIGHT_HALF_PATHS, stats, breakdowns);
  svg += renderCourtCourtLines("right", undefined, team);
  svg += renderZoneLabels(RIGHT_HALF_PATHS, stats);
  return svg;
}

/**
 * 하단 선수별 슈팅 인스펙터 HTML 생성 (마우스 오버레이 및 모바일 터치 대응)
 */
export function renderZoneInspectorHtml(uid: string): string {
  return (
    `<div class="nba-inspector-panel" id="nba-insp-${uid}">` +
    `<div class="nba-insp-header">` +
    `<div class="nba-insp-title-wrap">` +
    `<span class="nba-insp-badge">SHOT INSPECTOR</span>` +
    `<span class="nba-insp-title" id="nba-insp-title-${uid}">선수별 슈팅 구성률</span>` +
    `</div>` +
    `<span class="nba-insp-hint">💡 구역에 마우스를 올리거나 터치하세요</span>` +
    `</div>` +
    `<div class="nba-insp-body" id="nba-insp-body-${uid}">` +
    `<div class="nba-insp-placeholder">코트의 구역을 마우스로 가리키거나 터치하면, 해당 위치에서 <b>누가 시도를 많이 했고</b>, <b>누가 득점을 주도했는지</b>, 반대로 <b>누가 실패했는지</b> 상세 내역이 표시됩니다.</div>` +
    `</div>` +
    `</div>` +
    `<script>` +
    `(function(){` +
    `var root=document.getElementById("nba-card-${uid}");` +
    `if(!root)return;` +
    `var titleEl=document.getElementById("nba-insp-title-${uid}");` +
    `var bodyEl=document.getElementById("nba-insp-body-${uid}");` +
    `if(!titleEl||!bodyEl)return;` +
    `var paths=root.querySelectorAll(".nba-zone-path");` +
    `function update(p){` +
    `var team=p.getAttribute("data-team");` +
    `var zname=p.getAttribute("data-zonename");` +
    `var stat=p.getAttribute("data-stat");` +
    `var makers=p.getAttribute("data-makers");` +
    `var missers=p.getAttribute("data-missers");` +
    `var playersRaw=p.getAttribute("data-players");` +
    `if(!team||!zname)return;` +
    `titleEl.innerHTML='<span class="nba-insp-team-tag">'+team+'</span> <b>'+zname+'</b> <span class="nba-insp-stat-tag">'+stat+'</span>';` +
    `var players=[];try{players=JSON.parse(playersRaw||"[]");}catch(e){}` +
    `if(!players.length){bodyEl.innerHTML='<div class="nba-insp-empty">해당 구역의 시도 기록이 없습니다.</div>';return;}` +
    `var html='<div class="nba-insp-cards">';` +
    `if(makers&&makers!=="없음"){html+='<div class="nba-insp-group makers"><span class="nba-group-label">🎯 득점/성공 주도</span><span class="nba-group-val">'+makers+'</span></div>';}` +
    `if(missers&&missers!=="없음"){html+='<div class="nba-insp-group missers"><span class="nba-group-label">❌ 실패/난조</span><span class="nba-group-val">'+missers+'</span></div>';}` +
    `html+='</div>';` +
    `html+='<div class="nba-insp-player-list"><span class="nba-list-title">시도 선수 목록:</span>';` +
    `players.forEach(function(pl){` +
    `var pCls=pl.pct>=50?"hot":pl.pct===0?"cold":"neutral";` +
    `html+='<span class="nba-player-chip '+pCls+'"><b>'+pl.name+'</b> '+pl.made+'/'+pl.att+' ('+pl.pct+'%)</span>';` +
    `});` +
    `html+='</div>';` +
    `bodyEl.innerHTML=html;` +
    `}` +
    `paths.forEach(function(p){` +
    `p.addEventListener("mouseenter",function(){update(p);});` +
    `p.addEventListener("click",function(){update(p);});` +
    `});` +
    `})();` +
    `</script>`
  );
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
