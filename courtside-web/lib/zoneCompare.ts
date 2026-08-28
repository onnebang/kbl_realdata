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
    const x = s.d === "2" ? 750 - s.x : s.x;
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
