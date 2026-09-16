import type { CareerGameRow, TeamMeta } from "./playerProfile";
import type { CareerShot } from "./playerDataScience";
import { displayTeamName } from "./teamNames";
import { shortSeason } from "./preseason";
import { classifyShot } from "./formIndex";

// ESPN 르브론 제임스 득점 마일스톤 인포그래픽(사진 2, 3, 5 레퍼런스) 스타일 시각화 엔진
// 16:9 와이드(800x450) 시네마틱 뷰박스 기준
const CB_STYLE = `<style>
  .espnTitle { font-family: "Big Shoulders Display", "Impact", sans-serif; font-size: 26px; font-weight: 800; letter-spacing: 0.04em; fill: var(--ink); text-anchor: middle; }
  .espnSub { font-family: "IBM Plex Mono", "Pretendard", monospace; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; fill: var(--ink-faint); text-anchor: middle; }
  .cbBig { font-family: "Big Shoulders Display", sans-serif; font-weight: 800; font-variant-numeric: tabular-nums; }
  .cbMono { font-family: "IBM Plex Mono", monospace; }
  .cbSans { font-family: "Pretendard", sans-serif; }
  .axisText { font-family: "IBM Plex Mono", monospace; font-size: 11px; fill: var(--ink-faint); }
</style>`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── 집계 타입 ──────────────────────────────────────────────────────────────
export type TeamPtsRow = {
  tcode: string;
  teamName: string;
  teamAbbr: string;
  teamColor: string;
  pts: number;
  games: number;
  ppg: number;
  seasons: string[];
};

export type SeasonPtsRow = {
  seasonName: string;
  pts: number;
  games: number;
  ppg: number;
  fgm: number;
  tpm: number;
  ftm: number;
  tcode: string;
  isCareerHigh: boolean;
};

export type ZonePts = {
  twoPt: number;
  threePt: number;
  ft: number;
};

export function aggregateByTeam(rows: CareerGameRow[], teams: Map<string, TeamMeta>, displaySeason: string): TeamPtsRow[] {
  const by = new Map<string, { pts: number; games: number; seasons: Set<string> }>();
  for (const r of rows) {
    const cur = by.get(r.tcode) ?? { pts: 0, games: 0, seasons: new Set<string>() };
    cur.pts += r.pts;
    cur.games += 1;
    cur.seasons.add(r.seasonName);
    by.set(r.tcode, cur);
  }
  const out: TeamPtsRow[] = [];
  for (const [tcode, stat] of by) {
    out.push({
      tcode,
      teamName: displayTeamName(tcode, teams.get(tcode)?.name ?? tcode, displaySeason),
      teamAbbr: teams.get(tcode)?.abbr ?? tcode,
      teamColor: teams.get(tcode)?.color ?? "#888888",
      pts: stat.pts,
      games: stat.games,
      ppg: stat.games > 0 ? stat.pts / stat.games : 0,
      seasons: [...stat.seasons].sort(),
    });
  }
  return out.sort((a, b) => b.pts - a.pts);
}

export function aggregateBySeason(rows: CareerGameRow[]): SeasonPtsRow[] {
  const by = new Map<string, { pts: number; games: number; fgm: number; tpm: number; ftm: number; tcode: string }>();
  for (const r of rows) {
    const cur = by.get(r.seasonName) ?? { pts: 0, games: 0, fgm: 0, tpm: 0, ftm: 0, tcode: r.tcode };
    cur.pts += r.pts;
    cur.games += 1;
    cur.fgm += r.fgm;
    cur.tpm += r.tpm;
    cur.ftm += r.ftm;
    cur.tcode = r.tcode;
    by.set(r.seasonName, cur);
  }
  const maxPts = Math.max(1, ...[...by.values()].map((v) => v.pts));
  return [...by.entries()]
    .map(([seasonName, stat]) => ({
      seasonName,
      pts: stat.pts,
      games: stat.games,
      ppg: stat.games > 0 ? stat.pts / stat.games : 0,
      fgm: stat.fgm,
      tpm: stat.tpm,
      ftm: stat.ftm,
      tcode: stat.tcode,
      isCareerHigh: stat.pts === maxPts,
    }))
    .sort((a, b) => (a.seasonName < b.seasonName ? -1 : 1));
}

export function aggregateZones(rows: CareerGameRow[]): ZonePts {
  let twoPt = 0,
    threePt = 0,
    ft = 0;
  for (const r of rows) {
    twoPt += r.fgm * 2;
    threePt += r.tpm * 3;
    ft += r.ftm;
  }
  return { twoPt, threePt, ft };
}

// ── 1. 시즌별 득점 (BY SEASON · 사진 3 대응) ──────────────────────────────
export function buildSeasonBarSvg(rows: SeasonPtsRow[], totalPts?: number): string {
  if (!rows.length) return "";
  const total = totalPts ?? rows.reduce((s, r) => s + r.pts, 0);
  const W = 800;
  const H = 450;
  const padL = 70;
  const padR = 40;
  const padT = 85;
  const padB = 75;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxPts = Math.max(1, ...rows.map((r) => r.pts));
  // Y축 상한선 (100점 or 500점 단위 올림)
  const yUpper = maxPts > 1000 ? Math.ceil(maxPts / 500) * 500 : Math.ceil(maxPts / 200) * 200;
  const yStep = yUpper >= 1500 ? 500 : yUpper >= 800 ? 250 : 100;

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">${CB_STYLE}`;

  // 헤더 (사진 3)
  svg += `<text x="${W / 2}" y="36" class="espnTitle">${total.toLocaleString()} POINTS</text>`;
  svg += `<text x="${W / 2}" y="54" class="espnSub">// BY SEASON</text>`;

  // Y축 가로 눈금선 및 라벨
  for (let val = yStep; val <= yUpper; val += yStep) {
    const gy = padT + plotH - (val / yUpper) * plotH;
    svg += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="rgba(var(--line-rgb), 0.15)" stroke-width="1"/>`;
    svg += `<text x="${padL - 10}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="axisText">${val.toLocaleString()}</text>`;
  }

  // 바닥 베이스라인
  svg += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--ink)" stroke-width="1.5"/>`;

  // 막대 너비 및 간격 계산
  const bw = plotW / rows.length;
  const barW = Math.min(48, Math.max(16, bw * 0.68));

  rows.forEach((r, i) => {
    const barH = (r.pts / yUpper) * plotH;
    const bx = padL + i * bw + (bw - barW) / 2;
    const by = padT + plotH - barH;

    // 사진 3처럼 커리어 하이 시즌은 와인/골드(#8e2a37)로 강렬하게 하이라이트, 일반 시즌은 차콜(#20252e)
    const fill = r.isCareerHigh ? "#912635" : "var(--ink)";
    const stroke = r.isCareerHigh ? "#bf3b4e" : "transparent";

    svg += `<g class="seasonBarGroup">`;
    svg += `<title>${r.seasonName} 시즌 · ${r.pts.toLocaleString()}점 (평균 ${r.ppg.toFixed(1)}점 / ${r.games}경기)</title>`;
    svg += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, barH).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${r.isCareerHigh ? 2 : 0}" rx="2"/>`;

    // 커리어 하이 마일스톤 뱃지 (사진 3의 2007-08 하이라이트 태그)
    if (r.isCareerHigh) {
      const tagX = bx + barW / 2;
      const tagY = by - 14;
      svg += `<g transform="translate(${tagX.toFixed(1)}, ${tagY.toFixed(1)})">`;
      svg += `<rect x="-56" y="-14" width="112" height="18" rx="4" fill="#912635" stroke="#fff" stroke-width="1"/>`;
      svg += `<text x="0" y="-1" text-anchor="middle" font-family="Big Shoulders Display" font-size="11" font-weight="800" fill="#fff" letter-spacing="0.05em">CAREER HIGH · ${r.pts}P</text>`;
      svg += `<polygon points="-4,4 4,4 0,8" fill="#912635"/>`;
      svg += `</g>`;
    } else if (barW >= 24) {
      // 일반 막대 위 득점 수치 (막대가 충분히 넓을 때)
      svg += `<text x="${(bx + barW / 2).toFixed(1)}" y="${(by - 6).toFixed(1)}" text-anchor="middle" class="cbBig" font-size="12" fill="var(--ink-soft)">${r.pts}</text>`;
    }

    // X축 시즌 레이블 (기울임 표기)
    const lx = bx + barW / 2;
    const ly = padT + plotH + 16;
    const label = shortSeason(r.seasonName);
    svg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" transform="rotate(45, ${lx.toFixed(1)}, ${ly.toFixed(1)})" text-anchor="start" class="axisText" font-weight="${r.isCareerHigh ? "700" : "400"}" fill="${r.isCareerHigh ? "#912635" : "var(--ink-soft)"}">${label}</text>`;

    svg += `</g>`;
  });

  svg += `</svg>`;
  return svg;
}

// ── 2. 구역별 득점 (BY SHOT LOCATION · 사진 5 대응) ────────────────────────
export function buildZoneSvg(z: ZonePts, totalPts?: number): string {
  const total = totalPts ?? z.twoPt + z.threePt + z.ft;
  if (!total) return "";

  const W = 800;
  const H = 450;

  // 코트 치수 및 원점 (FIBA 반코트 비례 재현)
  // 골대 중심 x=400, y=365
  const hoopX = 400;
  const hoopY = 365;
  const rimR = 9;
  const ftY = 175;     // 자유투 라인 Y
  const keyW = 190;    // 페인트존 가로폭
  const arcR = 270;    // 3점 라인 호 반지름 (hoopX, hoopY 중심)

  // 3점 아크가 코트 바닥(y=395)과 만나는 발(feet) 계산
  const baseLineY = 395;
  const dy = baseLineY - hoopY;
  const footX = Math.sqrt(Math.max(0, arcR * arcR - dy * dy));

  const twoPct = ((z.twoPt / total) * 100).toFixed(1);
  const threePct = ((z.threePt / total) * 100).toFixed(1);
  const ftPct = ((z.ft / total) * 100).toFixed(1);

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">${CB_STYLE}`;

  // 헤더 (사진 5)
  svg += `<text x="${W / 2}" y="36" class="espnTitle">${total.toLocaleString()} POINTS</text>`;
  svg += `<text x="${W / 2}" y="54" class="espnSub">// BY SHOT LOCATION</text>`;

  // 코트 바깥 박스 (x: 140 ~ 660, y: 75 ~ 415)
  const courtX = 150;
  const courtY = 75;
  const courtW = 500;
  const courtH = 340;

  svg += `<defs>
    <clipPath id="courtClip">
      <rect x="${courtX}" y="${courtY}" width="${courtW}" height="${courtH}" rx="8"/>
    </clipPath>
  </defs>`;

  svg += `<g clip-path="url(#courtClip)">`;

  // 1. 배경: 살구/테라코타 벽돌색 (3점 구역)
  svg += `<rect x="${courtX}" y="${courtY}" width="${courtW}" height="${courtH}" fill="#c77b6d" opacity="0.95"/>`;

  // 2. 2점 구역 (3점 아크 안쪽): 슬레이트 블루 (#7b8fc7)
  svg += `<path d="M ${hoopX - footX},${baseLineY} A ${arcR},${arcR} 0 0 1 ${hoopX + footX},${baseLineY} Z" fill="#7b8fc7" stroke="#4a5675" stroke-width="2.5" opacity="0.95"/>`;

  // 3. 페인트존 (Key Area)
  const keyX = hoopX - keyW / 2;
  svg += `<rect x="${keyX}" y="${ftY}" width="${keyW}" height="${baseLineY - ftY}" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.75"/>`;

  // 페인트존 사이드 레인 해시마크 (리바운드 자리 표시 눈금 4개씩)
  const tickYList = [230, 275, 320, 360];
  for (const ty of tickYList) {
    svg += `<line x1="${keyX - 6}" y1="${ty}" x2="${keyX}" y2="${ty}" stroke="#ffffff" stroke-width="2" opacity="0.75"/>`;
    svg += `<line x1="${keyX + keyW}" y1="${ty}" x2="${keyX + keyW + 6}" y2="${ty}" stroke="#ffffff" stroke-width="2" opacity="0.75"/>`;
  }

  // 4. 자유투 서클 (위쪽 반원은 실선, 아래쪽 반원은 점선 - 사진 5와 완벽 일치)
  const ftR = keyW / 2;
  svg += `<path d="M ${keyX},${ftY} A ${ftR},${ftR} 0 0 1 ${keyX + keyW},${ftY}" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.75"/>`;
  svg += `<path d="M ${keyX},${ftY} A ${ftR},${ftR} 0 0 0 ${keyX + keyW},${ftY}" fill="none" stroke="#ffffff" stroke-width="2" stroke-dasharray="6 6" opacity="0.6"/>`;

  // 5. 자유투 라인 (형광 연두/초록 하이라이트 선 - 사진 5 포인트 컬러!)
  svg += `<line x1="${keyX}" y1="${ftY}" x2="${keyX + keyW}" y2="${ftY}" stroke="#34c759" stroke-width="4.5" stroke-linecap="round"/>`;

  // 6. 제한 구역 (Restricted Area Arc)
  svg += `<path d="M ${hoopX - 42},${hoopY} A 42,42 0 0 1 ${hoopX + 42},${hoopY}" fill="none" stroke="#ffffff" stroke-width="1.8" opacity="0.7"/>`;

  // 7. 백보드 및 주황색 림 & 네트
  svg += `<rect x="${hoopX - 32}" y="${hoopY + 12}" width="64" height="5" fill="#555555" rx="1"/>`;
  svg += `<line x1="${hoopX}" y1="${hoopY + 12}" x2="${hoopX}" y2="${hoopY + rimR}" stroke="#777" stroke-width="3"/>`;
  svg += `<circle cx="${hoopX}" cy="${hoopY}" r="${rimR}" fill="none" stroke="#ff5722" stroke-width="3"/>`;
  // 그물 네트
  svg += `<path d="M ${hoopX - rimR},${hoopY} L ${hoopX - 4},${hoopY + 14} L ${hoopX + 4},${hoopY + 14} L ${hoopX + rimR},${hoopY}" fill="none" stroke="#ffffff" stroke-width="1.2" opacity="0.8"/>`;
  svg += `<line x1="${hoopX - 4}" y1="${hoopY}" x2="${hoopX}" y2="${hoopY + 14}" stroke="#ffffff" stroke-width="1" opacity="0.7"/>`;
  svg += `<line x1="${hoopX + 4}" y1="${hoopY}" x2="${hoopX}" y2="${hoopY + 14}" stroke="#ffffff" stroke-width="1" opacity="0.7"/>`;

  // 8. 코트 외곽선 테두리
  svg += `<rect x="${courtX}" y="${courtY}" width="${courtW}" height="${courtH}" rx="8" fill="none" stroke="#444444" stroke-width="3"/>`;
  svg += `</g>`;

  // ── 득점 수치 및 라벨 (사진 5 1:1 재현) ──────────────────────────────
  // 1) 2점 득점 (좌측 2점 구역)
  svg += `<g transform="translate(${courtX + 85}, 240)">`;
  svg += `<text x="0" y="0" text-anchor="middle" class="cbBig" font-size="38" fill="#111111">${z.twoPt.toLocaleString()}</text>`;
  svg += `<text x="0" y="22" text-anchor="middle" class="cbBig" font-size="15" fill="#222222" letter-spacing="0.05em">POINTS FROM 2-POINTERS</text>`;
  svg += `<text x="0" y="40" text-anchor="middle" class="cbMono" font-size="12" font-weight="700" fill="#333333">(${twoPct}%)</text>`;
  svg += `</g>`;

  // 2) 자유투 득점 (중앙 상단 자유투 라인 바로 위)
  svg += `<g transform="translate(${hoopX}, 138)">`;
  svg += `<text x="0" y="0" text-anchor="middle" class="cbBig" font-size="30" fill="#111111">${z.ft.toLocaleString()}</text>`;
  svg += `<text x="0" y="18" text-anchor="middle" class="cbBig" font-size="13" fill="#222222" letter-spacing="0.05em">POINTS FROM FREE THROWS</text>`;
  svg += `<text x="0" y="32" text-anchor="middle" class="cbMono" font-size="11" font-weight="700" fill="#2e7d32">(${ftPct}%)</text>`;
  svg += `</g>`;

  // 3) 3점 득점 (우측 상단 3점 구역)
  svg += `<g transform="translate(${courtX + courtW - 95}, 125)">`;
  svg += `<text x="0" y="0" text-anchor="middle" class="cbBig" font-size="34" fill="#111111">${z.threePt.toLocaleString()}</text>`;
  svg += `<text x="0" y="20" text-anchor="middle" class="cbBig" font-size="14" fill="#222222" letter-spacing="0.05em">POINTS FROM 3-POINTERS</text>`;
  svg += `<text x="0" y="36" text-anchor="middle" class="cbMono" font-size="12" font-weight="700" fill="#333333">(${threePct}%)</text>`;
  svg += `</g>`;

  svg += `</svg>`;
  return svg;
}

// ── 2-B. 정밀 5구역 슛 분석 (확장 뷰: 림 / 페인트 / 미드레인지 / 3점 / 자유투) ──
export type Zone5Stats = {
  name: string;
  enName: string;
  pts: number;
  fgm: number;
  fga: number;
  pct: number | null;
  share: number;
};

export function computeDetailed5Zones(shots: CareerShot[], zonePts: ZonePts, totalPts: number): Zone5Stats[] {
  let rimM = 0, rimA = 0;
  let closeM = 0, closeA = 0;
  let midM = 0, midA = 0;
  let threeM = 0, threeA = 0;

  for (const s of shots) {
    const { zone } = classifyShot(s.x, s.y, s.d);
    if (zone === "rim") {
      rimA++;
      if (s.made) rimM++;
    } else if (zone === "close") {
      closeA++;
      if (s.made) closeM++;
    } else if (zone === "three") {
      threeA++;
      if (s.made) threeM++;
    } else {
      midA++;
      if (s.made) midM++;
    }
  }

  const rimPts = rimM * 2;
  const paintPts = closeM * 2;
  const midPts = midM * 2;
  const threePts = threeM * 3;

  const validTotal = totalPts > 0 ? totalPts : 1;

  return [
    {
      name: "림 어택 (0~1.2m)",
      enName: "RESTRICTED AREA",
      pts: rimPts,
      fgm: rimM,
      fga: rimA,
      pct: rimA > 0 ? (rimM / rimA) * 100 : null,
      share: (rimPts / validTotal) * 100,
    },
    {
      name: "페인트존 플로터 (1.2~3m)",
      enName: "IN THE PAINT (NON-RA)",
      pts: paintPts,
      fgm: closeM,
      fga: closeA,
      pct: closeA > 0 ? (closeM / closeA) * 100 : null,
      share: (paintPts / validTotal) * 100,
    },
    {
      name: "미드레인지 (3~6.75m)",
      enName: "MID-RANGE",
      pts: midPts,
      fgm: midM,
      fga: midA,
      pct: midA > 0 ? (midM / midA) * 100 : null,
      share: (midPts / validTotal) * 100,
    },
    {
      name: "3점 슛 (6.75m+)",
      enName: "3-POINTERS",
      pts: threePts,
      fgm: threeM,
      fga: threeA,
      pct: threeA > 0 ? (threeM / threeA) * 100 : null,
      share: (threePts / validTotal) * 100,
    },
    {
      name: "자유투",
      enName: "FREE THROWS",
      pts: zonePts.ft,
      fgm: zonePts.ft,
      fga: zonePts.ft,
      pct: 100,
      share: (zonePts.ft / validTotal) * 100,
    },
  ];
}

export function buildDetailed5ZoneSvg(stats: Zone5Stats[], totalPts: number): string {
  const W = 800;
  const H = 450;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">${CB_STYLE}`;

  // 헤더
  svg += `<text x="${W / 2}" y="36" class="espnTitle">${totalPts.toLocaleString()} POINTS</text>`;
  svg += `<text x="${W / 2}" y="54" class="espnSub">// 5-ZONE DETAILED EFFICIENCY</text>`;

  // 5개 구역 가로 카드 목록
  const startY = 85;
  const rowH = 62;

  stats.forEach((st, idx) => {
    const y = startY + idx * (rowH + 8);
    const pctStr = st.pct != null ? `${st.pct.toFixed(1)}%` : "-";
    const shareW = Math.max(4, (st.share / 100) * 220);

    svg += `<g transform="translate(60, ${y})">`;
    svg += `<rect x="0" y="0" width="680" height="${rowH}" rx="8" fill="var(--surface-soft)" stroke="rgba(var(--line-rgb), 0.16)" stroke-width="1"/>`;

    // 구역 이름 & 영어 이름
    svg += `<text x="24" y="26" class="cbSans" font-size="14" font-weight="700" fill="var(--ink)">${esc(st.name)}</text>`;
    svg += `<text x="24" y="46" class="cbMono" font-size="11" fill="var(--ink-faint)">${st.enName}</text>`;

    // 득점 및 비중 바
    svg += `<g transform="translate(230, 20)">`;
    svg += `<text x="0" y="0" class="cbBig" font-size="18" fill="var(--ink)">${st.pts.toLocaleString()}점 <tspan font-size="12" fill="var(--ink-soft)">(${st.share.toFixed(1)}%)</tspan></text>`;
    svg += `<rect x="0" y="10" width="220" height="8" rx="4" fill="rgba(var(--line-rgb), 0.1)"/>`;
    svg += `<rect x="0" y="10" width="${shareW}" height="8" rx="4" fill="#912635"/>`;
    svg += `</g>`;

    // 시도 및 성공률 (FG%)
    svg += `<g transform="translate(520, 20)">`;
    if (st.enName !== "FREE THROWS") {
      svg += `<text x="0" y="0" class="cbMono" font-size="12" fill="var(--ink-soft)">${st.fgm}/${st.fga} 성공</text>`;
      svg += `<text x="0" y="20" class="cbBig" font-size="20" fill="var(--ink)" font-weight="800">FG ${pctStr}</text>`;
    } else {
      svg += `<text x="0" y="10" class="cbBig" font-size="18" fill="var(--ink)">FT ${st.pts}점 성공</text>`;
    }
    svg += `</g>`;

    svg += `</g>`;
  });

  svg += `</svg>`;
  return svg;
}

// ── 3. 소속팀별 득점 (BY TEAM · 사진 2 대응) ──────────────────────────────
export function buildTeamPieSvg(rows: TeamPtsRow[], totalPts?: number): string {
  const total = totalPts ?? rows.reduce((s, r) => s + r.pts, 0);
  if (!total) return "";

  const W = 800;
  const H = 450;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">${CB_STYLE}`;

  // 헤더 (사진 2)
  svg += `<text x="${W / 2}" y="36" class="espnTitle">${total.toLocaleString()} POINTS</text>`;
  svg += `<text x="${W / 2}" y="54" class="espnSub">// BY TEAM</text>`;

  // 1. 좌측: 팀별 통산 득점 리더보드 테이블 (사진 2의 CAVALIERS SCORING LEADERS 스타일)
  svg += `<g transform="translate(60, 85)">`;
  svg += `<rect x="0" y="0" width="310" height="320" rx="8" fill="var(--surface-soft)" stroke="rgba(var(--line-rgb), 0.2)" stroke-width="1.2"/>`;
  svg += `<rect x="0" y="0" width="310" height="34" rx="8" fill="var(--ink)"/>`;
  svg += `<text x="16" y="22" font-family="Big Shoulders Display" font-size="15" font-weight="800" fill="var(--surface)" letter-spacing="0.06em">CAREER SCORING BY FRANCHISE</text>`;

  rows.forEach((r, idx) => {
    const ry = 42 + idx * 54;
    const share = ((r.pts / total) * 100).toFixed(1);
    const seasonText = r.seasons.length > 0 ? `${shortSeason(r.seasons[0])}~${shortSeason(r.seasons[r.seasons.length - 1])}` : "";

    svg += `<g transform="translate(0, ${ry})">`;
    svg += `<circle cx="20" cy="18" r="8" fill="${r.teamColor}" stroke="#fff" stroke-width="1.5"/>`;
    svg += `<text x="36" y="16" class="cbSans" font-size="13" font-weight="700" fill="var(--ink)">${esc(r.teamName)}</text>`;
    svg += `<text x="36" y="32" class="cbMono" font-size="11" fill="var(--ink-faint)">${seasonText} · ${r.games}경기 (${r.ppg.toFixed(1)} PPG)</text>`;
    svg += `<text x="294" y="24" text-anchor="end" class="cbBig" font-size="18" fill="var(--ink)">${r.pts.toLocaleString()}P <tspan font-size="11" fill="var(--ink-faint)">(${share}%)</tspan></text>`;
    svg += `<line x1="16" y1="44" x2="294" y2="44" stroke="rgba(var(--line-rgb), 0.08)" stroke-width="1"/>`;
    svg += `</g>`;
  });
  svg += `</g>`;

  // 2. 우측: 대형 원형 파이/도넛 차트
  const cx = 560;
  const cy = 245;
  const R = 135;
  const innerR = 45;

  let angle = 0;
  rows.forEach((r) => {
    const sweep = (r.pts / total) * 360;
    const rad1 = ((angle - 90) * Math.PI) / 180;
    const rad2 = ((angle + sweep - 90) * Math.PI) / 180;

    const x1 = cx + R * Math.cos(rad1);
    const y1 = cy + R * Math.sin(rad1);
    const x2 = cx + R * Math.cos(rad2);
    const y2 = cy + R * Math.sin(rad2);

    const ix1 = cx + innerR * Math.cos(rad2);
    const iy1 = cy + innerR * Math.sin(rad2);
    const ix2 = cx + innerR * Math.cos(rad1);
    const iy2 = cy + innerR * Math.sin(rad1);

    const large = sweep > 180 ? 1 : 0;

    // 도넛 조각
    svg += `<path d="M ${x1.toFixed(1)},${y1.toFixed(1)} A ${R},${R} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} L ${ix1.toFixed(1)},${iy1.toFixed(1)} A ${innerR},${innerR} 0 ${large} 0 ${ix2.toFixed(1)},${iy2.toFixed(1)} Z" fill="${r.teamColor}" stroke="var(--surface)" stroke-width="3">`;
    svg += `<title>${esc(r.teamName)} · ${r.pts.toLocaleString()}점 (${((r.pts / total) * 100).toFixed(1)}%)</title>`;
    svg += `</path>`;

    // 조각 내부 텍스트 (조각이 30도 이상일 때)
    if (sweep >= 25) {
      const midRad = ((angle + sweep / 2 - 90) * Math.PI) / 180;
      const lx = cx + (R * 0.72) * Math.cos(midRad);
      const ly = cy + (R * 0.72) * Math.cos(midRad);
      svg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" class="cbBig" font-size="16" fill="#ffffff" paint-order="stroke" stroke="#000000" stroke-width="2.5">${r.pts.toLocaleString()}P</text>`;
    }

    angle += sweep;
  });

  svg += `</svg>`;
  return svg;
}
