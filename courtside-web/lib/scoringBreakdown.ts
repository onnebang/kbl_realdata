import type { CareerGameRow } from "./playerProfile";
import type { TeamMeta } from "./playerProfile";
import { displayTeamName } from "./teamNames";
import { shortSeason } from "./preseason";

// 선수 프로필 "득점 분석"(요청 - ESPN 르브론 제임스 커리어 득점 인포그래픽 참고: 팀별·시즌별·
// 슛 위치별·상대팀 지역별 득점). 전부 이미 페이지가 들고 있는 careerRows(경기당 pts/fgm/tpm/ftm)
// 하나에서 집계한다 - 새 조회가 없다. SVG는 히어로 별자리·시즌 리본과 같은 관례(raw 문자열,
// dangerouslySetInnerHTML, 뷰박스 단위 font-size + 미디어쿼리로 반응형 - shotValueScatter.ts의
// SVS_STYLE과 같은 이유).

const CB_STYLE =
  `<style>.cb{font-family:"IBM Plex Mono","Pretendard",monospace}` +
  `.cbN{font-family:"Pretendard",sans-serif;font-weight:800}` +
  `@media(max-width:999px){.cb{font-size:12px}.cbN{font-size:13px}}` +
  `@media(max-width:619px){.cb{font-size:16px}.cbN{font-size:17px}}` +
  `@media(max-width:479px){.cb{font-size:22px}.cbN{font-size:23px}}</style>`;
const CB_HALO = `paint-order="stroke" stroke="var(--surface)" stroke-width="3" stroke-linejoin="round"`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── 집계(전부 careerRows 하나에서) ──────────────────────────────────────────────
export type TeamPtsRow = { tcode: string; teamName: string; teamAbbr: string; teamColor: string; pts: number; games: number };
export type SeasonPtsRow = { seasonName: string; pts: number };
export type ZonePts = { twoPt: number; threePt: number; ft: number };

export function aggregateByTeam(rows: CareerGameRow[], teams: Map<string, TeamMeta>, displaySeason: string): TeamPtsRow[] {
  const by = new Map<string, TeamPtsRow>();
  for (const r of rows) {
    const cur = by.get(r.tcode) ?? {
      tcode: r.tcode,
      teamName: displayTeamName(r.tcode, teams.get(r.tcode)?.name ?? r.tcode, displaySeason),
      teamAbbr: teams.get(r.tcode)?.abbr ?? r.tcode,
      teamColor: teams.get(r.tcode)?.color ?? "#888888",
      pts: 0,
      games: 0,
    };
    cur.pts += r.pts;
    cur.games += 1;
    by.set(r.tcode, cur);
  }
  return [...by.values()].sort((a, b) => b.pts - a.pts);
}

export function aggregateBySeason(rows: CareerGameRow[]): SeasonPtsRow[] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.seasonName, (by.get(r.seasonName) ?? 0) + r.pts);
  return [...by.entries()].map(([seasonName, pts]) => ({ seasonName, pts })).sort((a, b) => (a.seasonName < b.seasonName ? -1 : 1));
}

/** fgm/tpm/ftm은 이 프로젝트 관례대로 fgm=2점만, tpm=3점 별도(CareerGameRow 주석과 동일). */
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

// ── 팀별 득점 파이 ──────────────────────────────────────────────────────────────
const PIE_R = 118,
  PIE_CX = 140,
  PIE_CY = 140;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** 팀 하나뿐이면 파이가 원 하나라 재미가 없다 - 호출부가 rows.length>1일 때만 부를 것. */
export function buildTeamPieSvg(rows: TeamPtsRow[]): string {
  const total = rows.reduce((s, r) => s + r.pts, 0);
  if (!total) return "";
  let svg = `<svg viewBox="0 0 280 280" xmlns="http://www.w3.org/2000/svg">${CB_STYLE}`;
  let angle = 0;
  for (const r of rows) {
    const share = r.pts / total;
    const sweep = share * 360;
    const [x1, y1] = polar(PIE_CX, PIE_CY, PIE_R, angle);
    const [x2, y2] = polar(PIE_CX, PIE_CY, PIE_R, angle + sweep);
    const large = sweep > 180 ? 1 : 0;
    svg += `<path d="M${PIE_CX},${PIE_CY} L${x1.toFixed(1)},${y1.toFixed(1)} A${PIE_R},${PIE_R} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${r.teamColor}" stroke="var(--surface)" stroke-width="2"><title>${esc(r.teamName)} · ${r.pts.toLocaleString()}점</title></path>`;
    // 부채꼴이 넓을 때만(20도 이상) 안에 숫자를 적는다 - 좁으면 겹쳐서 못 읽는다(범례가 그 몫을 진다).
    if (sweep >= 20) {
      const [lx, ly] = polar(PIE_CX, PIE_CY, PIE_R * 0.62, angle + sweep / 2);
      svg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" class="cb" font-weight="800" font-size="15" fill="#fff" ${CB_HALO}>${r.pts.toLocaleString()}</text>`;
    }
    angle += sweep;
  }
  svg += `</svg>`;
  return svg;
}

// ── 시즌별 득점 막대 ────────────────────────────────────────────────────────────
export function buildSeasonBarSvg(rows: SeasonPtsRow[]): string {
  if (!rows.length) return "";
  const W = Math.max(320, rows.length * 34 + 40);
  const H = 220,
    padB = 46,
    padT = 16,
    plotH = H - padB - padT;
  const max = Math.max(1, ...rows.map((r) => r.pts));
  const bw = (W - 40) / rows.length;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${CB_STYLE}`;
  svg += `<line x1="20" y1="${padT + plotH}" x2="${W - 20}" y2="${padT + plotH}" stroke="var(--ink-faint)" stroke-width="1"/>`;
  rows.forEach((r, i) => {
    const h = (r.pts / max) * plotH;
    const x = 20 + i * bw + bw * 0.15;
    const y = padT + plotH - h;
    const w = bw * 0.7;
    // 마지막(최신) 시즌만 골드로 - 이 저장소의 "지금 보고 있는 대상 강조" 관례.
    const fill = i === rows.length - 1 ? "var(--gold)" : "var(--ink-faint)";
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${fill}"><title>${shortSeason(r.seasonName)} · ${r.pts.toLocaleString()}점</title></rect>`;
    // 라벨은 한 칸 걸러 하나(좁으면 안 겹치게) - 회전 대신 가로 그대로(이 프로젝트는 회전 라벨을 이미 한 번 버렸다).
    const everyN = rows.length > 12 ? 2 : 1;
    if (i % everyN === 0) {
      svg += `<text x="${(x + w / 2).toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" text-anchor="middle" class="cb" font-size="9" fill="var(--ink-faint)">${shortSeason(r.seasonName)}</text>`;
    }
  });
  svg += `</svg>`;
  return svg;
}

// ── 슛 위치별 득점(2점/3점/자유투) - 반코트 배경 위 세 자리 숫자 ──────────────────
export function buildZoneSvg(z: ZonePts): string {
  const total = z.twoPt + z.threePt + z.ft;
  if (!total) return "";
  const W = 300,
    H = 230;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${CB_STYLE}`;
  // 배경 = 3점 구역 색, 그 위에 3점 아크 안쪽을 2점 색으로 덮는다(르브론 인포그래픽과 같은 구성).
  svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="#d9976f" opacity="0.5"/>`;
  const hoopX = W / 2,
    hoopY = 8,
    R = 150;
  svg += `<path d="M ${hoopX - R},${hoopY} A ${R},${R} 0 0 0 ${hoopX + R},${hoopY} L ${hoopX + R},${H} L ${hoopX - R},${H} Z" fill="#6f8bd9" opacity="0.5"/>`;
  // 자유투 라인(대시) + 페인트존 - FT 득점의 시각적 자리.
  const keyW = 74,
    keyY = 118;
  svg += `<line x1="${hoopX - keyW / 2}" y1="${keyY}" x2="${hoopX + keyW / 2}" y2="${keyY}" stroke="var(--ink)" stroke-width="2" stroke-dasharray="4 4" opacity="0.6"/>`;
  svg += `<rect x="${hoopX - keyW / 2}" y="${keyY}" width="${keyW}" height="${H - keyY}" fill="none" stroke="var(--ink)" stroke-width="1.4" opacity="0.5"/>`;
  svg += `<circle cx="${hoopX}" cy="${hoopY}" r="6" fill="var(--ink)"/>`;
  const label = (x: number, y: number, val: number, sub: string, size = 20) =>
    `<text x="${x}" y="${y}" text-anchor="middle" class="cbN" font-size="${size}" fill="var(--ink)" ${CB_HALO}>${val.toLocaleString()}</text>` +
    `<text x="${x}" y="${y + 15}" text-anchor="middle" class="cb" font-size="10" fill="var(--ink-soft)" ${CB_HALO}>${esc(sub)}</text>`;
  svg += label(70, 60, z.threePt, "3점 득점");
  svg += label(hoopX, 92, z.ft, "자유투 득점", 16);
  svg += label(hoopX, 195, z.twoPt, "2점 득점", 24);
  svg += `</svg>`;
  return svg;
}
