// courtside_template.html의 teamZoneStats()/renderZoneCompare()/drawCourtMarkings()/
// drawHoop() 포팅 - 구역별(림/근거리/중거리/롱2/3점) 슛 시도·성공 비교를 나무색 코트 위에
// 좌우 막대로. shot_log(이미 마이그레이션됨: gmkey/pcode/tcode/quarter/shot_order/x/y/d/
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
const SCALE_M_PER_UNIT = 0.0413;
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

export function buildZoneCompareSvg(home: ZoneStats, away: ZoneStats): string {
  const zones = ZONE_BOUNDS_M.map(([key]) => key);
  const zoneLabels = Object.fromEntries(ZONE_BOUNDS_M.map(([key, , , label]) => [key, label]));
  const zoneMidM: Record<string, number> = { rim: 0.6, close: 2.1, midShort: 4.0, midLong: 5.875, three: 7.6 };
  const maxAtt = Math.max(1, ...zones.map((z) => Math.max(home[z].att, away[z].att)));

  const HX = HOOP_RIGHT[0],
    HY = HOOP_RIGHT[1];
  let svg = `<rect x="${COURT_X[0]}" y="${COURT_Y[0]}" width="${COURT_X[1] - COURT_X[0]}" height="${COURT_Y[1] - COURT_Y[0]}" fill="#d9b98a" stroke="var(--ink-faint)" stroke-width="2"/>`;
  svg += drawCourtMarkings(HX, COURT_X[1], -1, "#fff", 1.6);
  svg += drawHoop(HOOP_RIGHT[0], HOOP_RIGHT[1], false);

  const BAR_W = 6,
    GAP = 3,
    BAR_MAX = 58;
  zones.forEach((z) => {
    const x = HX - zoneMidM[z] / SCALE_M_PER_UNIT;
    const hLen = maxAtt ? (home[z].att / maxAtt) * BAR_MAX : 0;
    const aLen = maxAtt ? (away[z].att / maxAtt) * BAR_MAX : 0;
    const hPct = home[z].att ? Math.round((home[z].made / home[z].att) * 100) : 0;
    const aPct = away[z].att ? Math.round((away[z].made / away[z].att) * 100) : 0;
    const hx0 = x - GAP / 2 - BAR_W,
      ax0 = x + GAP / 2;
    svg += `<rect x="${hx0}" y="${HY - hLen}" width="${BAR_W}" height="${hLen}" fill="var(--home)" rx="1.5"/>`;
    svg += `<rect x="${ax0}" y="${HY - aLen}" width="${BAR_W}" height="${aLen}" fill="var(--away)" rx="1.5"/>`;
    const labelY = HY - Math.max(hLen, aLen, 14) - 38;
    svg += `<text x="${x}" y="${labelY}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--ink)" font-family="Pretendard, sans-serif">${zoneLabels[z]}</text>`;
    const hvx = hx0 + BAR_W / 2,
      hvy = HY - hLen - 4;
    const avx = ax0 + BAR_W / 2,
      avy = HY - aLen - 4;
    svg += `<text x="${hvx}" y="${hvy}" text-anchor="start" font-size="10" font-weight="700" fill="var(--home)" font-family="IBM Plex Mono, monospace" transform="rotate(-90 ${hvx} ${hvy})">${hPct}%</text>`;
    svg += `<text x="${avx}" y="${avy}" text-anchor="start" font-size="10" font-weight="700" fill="var(--away)" font-family="IBM Plex Mono, monospace" transform="rotate(-90 ${avx} ${avy})">${aPct}%</text>`;
  });

  return svg;
}

// 실제 슛 위치 점 차트 - perthirtysix.com(NBA 데이터 저널리즘 사이트) 레퍼런스로 사용자가
// 요청("우리가 만든 팀 그래프를, 위 사이트와 같이 비교")한 리디자인. 그 사이트는 시즌
// 전체(수천 개) 슛을 다루니 hexbin 밀도가 맞지만, 여기는 한 경기 한 팀(대개 60~90개)
// 수준이라 hexbin으로 뭉개는 것보다 슛 하나하나를 점으로 찍는 게 더 정보량이 많고
// 구현도 단순함 - "Make/Miss" 뷰를 팀별로 분리한 버전. 성공=팀컬러 채운 원,
// 실패=옅은 링(테두리만). 2점/3점 반지름 차이로 살짝 구분.
export function buildCourtDotsSvg(shots: ShotRow[], color: string): string {
  const HX = HOOP_RIGHT[0],
    HY = HOOP_RIGHT[1];
  let svg = `<rect x="${COURT_X[0]}" y="${COURT_Y[0]}" width="${COURT_X[1] - COURT_X[0]}" height="${COURT_Y[1] - COURT_Y[0]}" fill="#d9b98a" stroke="var(--ink-faint)" stroke-width="2"/>`;
  svg += drawCourtMarkings(HX, COURT_X[1], -1, "#fff", 1.6);

  for (const s of shots) {
    const x = mirrorShotX(s.x, s.d);
    const r = shotValue(s.x, s.y, s.d) === 3 ? 4.2 : 3.4;
    if (s.made) {
      svg += `<circle cx="${x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${r}" fill="${color}" opacity="0.88"/>`;
    } else {
      svg += `<circle cx="${x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${r}" fill="none" stroke="${color}" stroke-width="1.3" opacity="0.4"/>`;
    }
  }

  svg += drawHoop(HOOP_RIGHT[0], HOOP_RIGHT[1], false);
  return svg;
}
