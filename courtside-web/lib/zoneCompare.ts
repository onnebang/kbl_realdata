// courtside_template.html의 teamZoneStats()/drawCourtMarkings()/drawHoop() 포팅 - 구역별
// (림/근거리/중거리/롱2/3점) 슛 시도·성공 집계와 나무색 코트 그리기. shot_log(이미
// 마이그레이션됨: gmkey/pcode/tcode/quarter/shot_order/x/y/d/
// made)에서 직접 계산 - 원본처럼 미리 구운 GAME.shotChart가 아니라 매 요청마다 이 경기의
// 슛 로그(보통 100~200건)를 훑는 정도라 가벼움.
//
// "구역 지배력"(renderZoneDominance - 리그 평균 대비 이 팀의 구역별 성공률)은 이번 포팅
// 범위 밖 - 리그 평균 자체가 shot_log 전체(55만 행)를 구역 분류하며 훑어야 나오는 값이라
// 매 페이지 요청마다 라이브로 계산하기엔 무거움(rarity.ts의 wpaSwingRank를 범위 밖으로 뺀
// 것과 같은 이유 - 나중에 필요하면 사전 집계 테이블로).

export const HOOP_RIGHT: [number, number] = [681, 205];
export const COURT_X: [number, number] = [30, 720];
export const COURT_Y: [number, number] = [27, 384];
// 풀코트 미니 슛맵(components/GameReplay.tsx의 포제션 카드, lib/possessionFeed.ts)이 양쪽
// 골대를 다 그려야 해서 추가 - 기존엔 항상 오른쪽 골대로 미러링해서 그리는 반코트 뷰만
// 있었음(mirrorShotX). COURT_X[1]에서 HOOP_RIGHT까지의 여백을 그대로 반대쪽에 대칭 적용.
export const HOOP_LEFT: [number, number] = [COURT_X[0] + (COURT_X[1] - HOOP_RIGHT[0]), HOOP_RIGHT[1]];
export const SCALE_M_PER_UNIT = 0.0413;
const ZONE_BOUNDS_M: [string, number, number, string][] = [
  ["rim", 0, 1.2, "림"],
  ["close", 1.2, 3.0, "근거리"],
  ["midShort", 3.0, 5.0, "중거리"],
  ["midLong", 5.0, 6.75, "롱2"],
  ["three", 6.75, 999, "3점"],
];
const THREE_PT_M = 6.75,
  FT_LINE_M = 5.8,
  LANE_HALF_M = 2.45,
  FT_CIRCLE_R_M = 1.8,
  RESTRICTED_R_M = 1.25,
  THREE_SIDE_MARGIN_M = 0.9;

function shotDistM(x: number, y: number): number {
  return Math.hypot(x - HOOP_RIGHT[0], y - HOOP_RIGHT[1]) * SCALE_M_PER_UNIT;
}
function classifyZone(distM: number): [string, number, number, string] {
  return ZONE_BOUNDS_M.find((z) => distM >= z[1] && distM < z[2]) ?? ZONE_BOUNDS_M[ZONE_BOUNDS_M.length - 1];
}

// d 필드는 "어느 골대 쪽인지"(전반/후반 코트 스위치) - 항상 오른쪽 골대 기준으로 미러링해서
// 그리는 컨벤션이 이 파일 전체(teamZoneStats)와 scoringExplorer.ts/formIndex.ts에서
// 일관되게 쓰임. 이 파일 밖에서도 필요해서(app/games/[gmkey]/page.tsx의 슛 필터) export.
export function mirrorShotX(x: number, d: string): number {
  return d === "2" ? 750 - x : x;
}

// 2점/3점 판정 - build_xpts_shot_quality.py에서 검증한 것과 같은 THREE_PT_M(6.75m)
// 거리 기준. shot_log엔 값(2/3)을 직접 담은 컬럼이 없어서(x/y/d로 매번 역산) 여기서
// 한 번만 export해두고 슛 종류 필터에서 재사용.
export function shotValue(x: number, y: number, d: string): 2 | 3 {
  const mx = mirrorShotX(x, d);
  return shotDistM(mx, y) >= THREE_PT_M ? 3 : 2;
}

// 슛 퀄리티 분석(xPTS)용 룩업. 각 구역별 리그 평균 슛 성공률 기준 기대득점.
export function shotXPTS(x: number, y: number, d: string): number {
  const mx = mirrorShotX(x, d);
  const distM = shotDistM(mx, y);
  const zone = classifyZone(distM)[0];
  switch (zone) {
    case "rim": return 1.20;       // 60% * 2점
    case "close": return 0.90;     // 45% * 2점
    case "midShort": return 0.80;  // 40% * 2점
    case "midLong": return 0.76;   // 38% * 2점
    case "three": return 0.99;     // 33% * 3점
    default: return 0.80;
  }
}

export function drawCourtMarkings(hoopX: number, baselineX: number, dir: 1 | -1, stroke: string, sw: number): string {
  const u = (v: number) => v / SCALE_M_PER_UNIT;
  const midY = (COURT_Y[0] + COURT_Y[1]) / 2;
  const laneFar = baselineX + dir * u(FT_LINE_M);
  const laneTop = midY - u(LANE_HALF_M),
    laneBot = midY + u(LANE_HALF_M);
  let svg = `<rect x="${Math.min(baselineX, laneFar)}" y="${laneTop}" width="${Math.abs(laneFar - baselineX)}" height="${laneBot - laneTop}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
  svg += `<circle cx="${laneFar}" cy="${midY}" r="${u(FT_CIRCLE_R_M)}" fill="none" stroke="${stroke}" stroke-width="${sw}" opacity="0.75"/>`;
  const rr = u(RESTRICTED_R_M);
  const sweep = dir > 0 ? 1 : 0;
  svg += `<path d="M ${hoopX} ${midY - rr} A ${rr} ${rr} 0 0 ${sweep} ${hoopX} ${midY + rr}" fill="none" stroke="${stroke}" stroke-width="${sw}" opacity="0.85"/>`;
  const topY = COURT_Y[0] + u(THREE_SIDE_MARGIN_M),
    botY = COURT_Y[1] - u(THREE_SIDE_MARGIN_M);
  const R = u(THREE_PT_M);
  const dy = midY - topY;
  const dx = Math.sqrt(Math.max(0, R * R - dy * dy));
  const archX = hoopX + dir * dx;
  svg += `<path d="M ${baselineX} ${topY} L ${archX} ${topY} A ${R} ${R} 0 0 ${sweep} ${archX} ${botY} L ${baselineX} ${botY}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
  return svg;
}

export function drawHoop(hx: number, hy: number, onLeftSide: boolean): string {
  const bbX = onLeftSide ? hx - 18 : hx + 18;
  let svg = `<line x1="${bbX}" y1="${hy - 24}" x2="${bbX}" y2="${hy + 24}" stroke="var(--ink-soft)" stroke-width="5.5" stroke-linecap="round"/>`;
  svg += `<circle cx="${hx}" cy="${hy}" r="13" fill="none" stroke="#e8590c" stroke-width="4"/>`;
  for (const dx of [-9, -4, 0, 4, 9]) {
    svg += `<line x1="${hx + dx}" y1="${hy + 4}" x2="${hx + dx * 0.4}" y2="${hy + 22}" stroke="var(--ink-faint)" stroke-width="1.3"/>`;
  }
  return svg;
}

// 프리뷰 인사이트("코너 3점을 막을 것") - "코너 3"은 3점 중에서도 베이스라인 옆(사이드라인
// 근처)에서 직선 구간으로 쏘는 슛만 가리킴(그 바깥쪽 호(arc) 구간은 코너가 아니라 윙/탑).
// 새 좌표를 임의로 추측하지 않고, drawCourtMarkings()가 3점 라인을 그릴 때 실제로 쓰는 것과
// 정확히 같은 기하학(THREE_SIDE_MARGIN_M로 정한 topY/botY 사이드라인 밴드, 그 지점에서
// 골대까지의 반지름 R=THREE_PT_M로 구한 호(arc) 시작 x좌표 archX)을 그대로 재계산해서 판정 -
// 화면에 그려지는 라인과 항상 같은 기준을 공유(이중 정의 금지).
const topY = COURT_Y[0] + THREE_SIDE_MARGIN_M / SCALE_M_PER_UNIT;
const botY = COURT_Y[1] - THREE_SIDE_MARGIN_M / SCALE_M_PER_UNIT;
const cornerArchX = (() => {
  const midY = (COURT_Y[0] + COURT_Y[1]) / 2;
  const dy = midY - topY;
  const R = THREE_PT_M / SCALE_M_PER_UNIT;
  const dx = Math.sqrt(Math.max(0, R * R - dy * dy));
  return HOOP_RIGHT[0] - dx; // dir=-1(오른쪽 골대 기준, baselineX=COURT_X[1])과 동일한 부호
})();

export function isCornerThree(x: number, y: number, d: string): boolean {
  const mx = mirrorShotX(x, d);
  const inSideBand = y <= topY || y >= botY; // 사이드라인에서 THREE_SIDE_MARGIN_M 안쪽
  const inStraightSeg = mx >= cornerArchX; // 호가 아니라 베이스라인까지 이어지는 직선 구간
  return inSideBand && inStraightSeg && shotValue(x, y, d) === 3;
}

export type ShotRow = { x: number; y: number; d: string; made: boolean; tcode: string };
export type ZoneStats = Record<string, { att: number; made: number }>;

export function teamZoneStats(shots: ShotRow[], tcode: string): ZoneStats {
  const stats: ZoneStats = {};
  for (const [key] of ZONE_BOUNDS_M) stats[key] = { att: 0, made: 0 };
  for (const s of shots) {
    if (s.tcode !== tcode) continue;
    const x = mirrorShotX(s.x, s.d);
    const [zoneKey] = classifyZone(shotDistM(x, s.y));
    stats[zoneKey].att++;
    if (s.made) stats[zoneKey].made++;
  }
  return stats;
}

// 실제 슛 위치 점 차트 - perthirtysix.com(NBA 데이터 저널리즘 사이트) 레퍼런스로 사용자가
// 요청("우리가 만든 팀 그래프를, 위 사이트와 같이 비교")한 리디자인. 그 사이트는 시즌
// 전체(수천 개) 슛을 다루니 hexbin 밀도가 맞지만, 여기는 한 경기 한 팀(대개 60~90개)
// 수준이라 hexbin으로 뭉개는 것보다 슛 하나하나를 점으로 찍는 게 더 정보량이 많고
// 구현도 단순함 - "Make/Miss" 뷰를 팀별로 분리한 버전. 성공=팀컬러 채운 원,
// 실패=옅은 링(테두리만). 2점/3점 반지름 차이로 살짝 구분.
//
// getMeta(요청 - "슛 차트 호버로 누가/언제, 클릭하면 그 순간으로 이동") - 이 함수의 기존
// 호출부(components/GameReplay.tsx 하나뿐, 실측 확인됨)를 깨지 않도록 3번째 인자를
// 완전히 선택적으로 추가: 안 넘기면 예전과 바이트 단위로 동일한 <circle .../> 자체닫힘
// 태그만 나옴. 넘기면 각 점에 네이티브 <title>(호버 툴팁, 클라이언트 JS 불필요 - 이
// 프로젝트 컨벤션)과 data-jump-idx(components/GameReplay.tsx의 document 클릭 위임
// 리스너가 읽음 - lib/postgameReport.ts의 report-jump-link와 같은 컨벤션 공유)를 얹음.
export type ShotDotMeta = { title: string; jumpIdx: number | null };

function escapeSvgText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildCourtDotsSvg<T extends ShotRow>(shots: T[], color: string, getMeta?: (shot: T) => ShotDotMeta | null): string {
  const HX = HOOP_RIGHT[0];
  let svg = `<rect x="${COURT_X[0]}" y="${COURT_Y[0]}" width="${COURT_X[1] - COURT_X[0]}" height="${COURT_Y[1] - COURT_Y[0]}" fill="#d9b98a" stroke="var(--ink-faint)" stroke-width="2"/>`;
  svg += drawCourtMarkings(HX, COURT_X[1], -1, "#fff", 1.6);

  for (const s of shots) {
    const x = mirrorShotX(s.x, s.d);
    const r = shotValue(s.x, s.y, s.d) === 3 ? 4.2 : 3.4;
    const meta = getMeta ? getMeta(s) : null;
    const extraAttrs = meta?.jumpIdx != null ? ` class="zc-dot-jump" data-jump-idx="${meta.jumpIdx}"` : "";
    const titleEl = meta?.title ? `<title>${escapeSvgText(meta.title)}</title>` : "";
    const fillAttrs = s.made ? `fill="${color}" opacity="0.88"` : `fill="none" stroke="${color}" stroke-width="1.3" opacity="0.4"`;
    if (titleEl || extraAttrs) {
      svg += `<circle cx="${x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${r}" ${fillAttrs}${extraAttrs}>${titleEl}</circle>`;
    } else {
      svg += `<circle cx="${x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${r}" ${fillAttrs}/>`;
    }
  }

  svg += drawHoop(HOOP_RIGHT[0], HOOP_RIGHT[1], false);
  return svg;
}
