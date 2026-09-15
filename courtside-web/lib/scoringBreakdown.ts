import type { CareerGameRow } from "./playerProfile";
import type { TeamMeta } from "./playerProfile";
import { displayTeamName } from "./teamNames";
import { shortSeason } from "./preseason";
import { BASELINE_TO_RIM_M, FT_CIRCLE_R_M, KEY_LENGTH_M, KEY_WIDTH_M, THREE_PT_M } from "./court3d";

// 선수 프로필 "득점 분석"(요청 - ESPN 르브론 제임스 커리어 득점 인포그래픽 참고: 팀별·시즌별·
// 슛 위치별·상대팀 지역별 득점). 전부 이미 페이지가 들고 있는 careerRows(경기당 pts/fgm/tpm/ftm)
// 하나에서 집계한다 - 새 조회가 없다. SVG는 히어로 별자리·시즌 리본과 같은 관례(raw 문자열,
// dangerouslySetInnerHTML, 뷰박스 단위 font-size + 미디어쿼리로 반응형 - shotValueScatter.ts의
// SVS_STYLE과 같은 이유).

const CB_STYLE =
  `<style>.cb{font-family:"IBM Plex Mono","Pretendard",monospace}` +
  `.cbN{font-family:"Pretendard",sans-serif;font-weight:800}` +
  // 큰 숫자 전용(르브론 인포그래픽 참고 - 굵은 콘덴스트 디스플레이체). 이 사이트의 스코어보드
  // 서체와 같다(globals.css "한글 글리프 없음" 계약) - 숫자에만 쓰고 한글엔 절대 쓰지 않는다.
  `.cbBig{font-family:"Big Shoulders Display",sans-serif;font-weight:800;font-variant-numeric:tabular-nums}` +
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
    svg += `<path d="M${PIE_CX},${PIE_CY} L${x1.toFixed(1)},${y1.toFixed(1)} A${PIE_R},${PIE_R} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${r.teamColor}" stroke="var(--surface)" stroke-width="3"><title>${esc(r.teamName)} · ${r.pts.toLocaleString()}점</title></path>`;
    // 부채꼴이 넓을 때만(20도 이상) 안에 숫자를 적는다 - 좁으면 겹쳐서 못 읽는다(범례가 그 몫을 진다).
    if (sweep >= 20) {
      const [lx, ly] = polar(PIE_CX, PIE_CY, PIE_R * 0.62, angle + sweep / 2);
      svg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" class="cbBig" font-size="18" fill="#fff" ${CB_HALO}>${r.pts.toLocaleString()}</text>`;
    }
    angle += sweep;
  }
  svg += `</svg>`;
  return svg;
}

// ── 시즌별 득점 막대(레퍼런스 - 짙은 막대 + 눈금 격자선) - 라벨은 이 프로젝트 관례대로 가로
// 유지 + 겹치면 건너뛰기(seasonRibbon.ts 월 라벨·koreaMap.ts 팀 라벨과 같은 충돌 박스 검사,
// afe5414 "읽히게 만든 다음" 디자인 정비에서 세운 원칙 - 회전 대신 가독성). ──────────────
function niceStep(max: number): number {
  const rough = max / 3;
  const mag = 10 ** Math.floor(Math.log10(Math.max(1, rough)));
  const n = rough / mag;
  const step = n >= 5 ? 5 : n >= 2 ? 2 : 1;
  return step * mag;
}

export function buildSeasonBarSvg(rows: SeasonPtsRow[]): string {
  if (!rows.length) return "";
  const W = Math.max(320, rows.length * 34 + 40);
  const H = 230,
    padB = 54,
    padT = 16,
    plotH = H - padB - padT;
  const max = Math.max(1, ...rows.map((r) => r.pts));
  const bw = (W - 40) / rows.length;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${CB_STYLE}`;
  // 눈금 격자선(레퍼런스의 "2,000"/"1,000" 가로줄) - 정갈한 간격만.
  const step = niceStep(max);
  for (let v = step; v <= max; v += step) {
    const gy = padT + plotH - (v / max) * plotH;
    svg += `<line x1="20" y1="${gy.toFixed(1)}" x2="${W - 20}" y2="${gy.toFixed(1)}" stroke="rgba(var(--line-rgb),0.14)" stroke-width="1"/>`;
    svg += `<text x="16" y="${(gy - 3).toFixed(1)}" text-anchor="end" class="cb" font-size="9" fill="var(--ink-faint)">${v.toLocaleString()}</text>`;
  }
  svg += `<line x1="20" y1="${padT + plotH}" x2="${W - 20}" y2="${padT + plotH}" stroke="var(--ink-faint)" stroke-width="1"/>`;
  let labelRightEdge = -Infinity;
  rows.forEach((r, i) => {
    const h = (r.pts / max) * plotH;
    const x = 20 + i * bw + bw * 0.15;
    const y = padT + plotH - h;
    const w = bw * 0.7;
    // 마지막(최신) 시즌만 골드로 - 이 저장소의 "지금 보고 있는 대상 강조" 관례.
    const fill = i === rows.length - 1 ? "var(--gold)" : "var(--ink)";
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${fill}"><title>${shortSeason(r.seasonName)} · ${r.pts.toLocaleString()}점</title></rect>`;
    // 라벨은 가로 유지 - 이전에 놓인 라벨과 겹치면 건너뛴다(폭은 간이 추정, koreaMap.ts와 같은 기법).
    const label = shortSeason(r.seasonName);
    const lx = x + w / 2;
    const labelW = label.length * 5.2;
    if (lx - labelW / 2 > labelRightEdge) {
      svg += `<text x="${lx.toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" text-anchor="middle" class="cb" font-size="9" fill="var(--ink-faint)">${label}</text>`;
      labelRightEdge = lx + labelW / 2;
    }
  });
  svg += `</svg>`;
  return svg;
}

// ── 슛 위치별 득점(2점/3점/자유투) - 반코트 위 세 자리 숫자(르브론 인포그래픽 참고) ──────
// 골대를 아래에 두고 위로 열리는 방향(그 인포그래픽과 같은 구도). 코트 선은 실제 치수
// (lib/court3d.ts - 3D 코트와 같은 FIBA 상수)를 그대로 써서 비율이 맞다 - 예전 버전은 반지름을
// 임의의 150px로 잡고 아크를 뷰박스 밖으로(위쪽) 그려서 2점/3점 구역 나눔이 안 보였다(제보:
// "감각적으로 만들어줘" 겸 리뷰에서 발견).
const ZONE_SCALE = 18; // px/m
export function buildZoneSvg(z: ZonePts): string {
  const total = z.twoPt + z.threePt + z.ft;
  if (!total) return "";
  const W = 300,
    H = 250;
  const s = (m: number) => m * ZONE_SCALE;
  const hoopX = W / 2,
    hoopY = H - 10 - s(BASELINE_TO_RIM_M); // 베이스라인이 아래쪽 10px 여백에 오도록 역산.

  // 3점 아크 - φ를 "골대에서 먼 쪽(위)"을 0으로 두고 베이스라인과 만나는 각까지만 sweep한다
  // (3D 코트와 같은 유도 - components/Court3DScene.tsx 주석 참고). 두 발 다 베이스라인 높이라
  // 아크 하나 + Z로 안쪽(2점) 영역이 통째로 닫힌다.
  const R = s(THREE_PT_M);
  const phiMax = Math.acos(Math.max(-1, Math.min(1, -BASELINE_TO_RIM_M / THREE_PT_M)));
  const footX = Math.sin(phiMax) * R;
  const baselineY = hoopY + s(BASELINE_TO_RIM_M);

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${CB_STYLE}`;
  // 배경 전체 = 3점 구역 색, 아크 안쪽만 2점 색으로 덮는다(레퍼런스처럼 더 진하게 - 이전엔
  // 0.55/0.6 반투명이라 흐릿했다).
  svg += `<rect x="0" y="0" width="${W}" height="${H}" rx="16" fill="#d9976f" opacity="0.75"/>`;
  svg += `<path d="M ${(hoopX - footX).toFixed(1)},${baselineY.toFixed(1)} A ${R.toFixed(1)},${R.toFixed(1)} 0 1 1 ${(hoopX + footX).toFixed(1)},${baselineY.toFixed(1)} Z" fill="#6f8bd9" opacity="0.8"/>`;

  // 키(페인트존) + 자유투 서클 + 자유투 라인(대시, 초록 - 르브론 인포그래픽과 같은 포인트 컬러).
  const keyW = s(KEY_WIDTH_M),
    ftY = hoopY - s(KEY_LENGTH_M);
  svg += `<rect x="${(hoopX - keyW / 2).toFixed(1)}" y="${ftY.toFixed(1)}" width="${keyW.toFixed(1)}" height="${(baselineY - ftY).toFixed(1)}" fill="none" stroke="var(--ink)" stroke-width="1.4" opacity="0.55"/>`;
  svg += `<circle cx="${hoopX}" cy="${ftY.toFixed(1)}" r="${s(FT_CIRCLE_R_M).toFixed(1)}" fill="none" stroke="var(--ink)" stroke-width="1.4" opacity="0.4"/>`;
  svg += `<line x1="${(hoopX - keyW / 2).toFixed(1)}" y1="${ftY.toFixed(1)}" x2="${(hoopX + keyW / 2).toFixed(1)}" y2="${ftY.toFixed(1)}" stroke="#2f9e57" stroke-width="2.5" stroke-dasharray="4 4"/>`;
  // 백보드 + 림(주황 - 참고 이미지와 같은 포인트 컬러).
  svg += `<rect x="${(hoopX - 16).toFixed(1)}" y="${(hoopY - 22).toFixed(1)}" width="32" height="4" fill="var(--ink)" opacity="0.5"/>`;
  svg += `<circle cx="${hoopX}" cy="${hoopY.toFixed(1)}" r="6.5" fill="none" stroke="#ff5a1f" stroke-width="3"/>`;

  const big = (x: number, y: number, val: number, sub: string, size: number, anchor: "middle" | "start" | "end" = "middle") =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" class="cbBig" font-size="${size}" fill="var(--ink)" ${CB_HALO}>${val.toLocaleString()}</text>` +
    `<text x="${x}" y="${y + size * 0.42}" text-anchor="${anchor}" class="cb" font-size="10" fill="var(--ink-soft)" ${CB_HALO}>${esc(sub)}</text>`;
  // 3점 - 위쪽 넓은 자리(참고 이미지처럼 오른쪽 위 치우침), 2점 - 페인트존 위, 가장 크게.
  svg += big(W - 16, 44, z.threePt, "3점 득점", 26, "end");
  svg += big(hoopX, ftY - 14, z.ft, "자유투 득점", 15);
  svg += big(hoopX, baselineY - s(KEY_LENGTH_M) * 0.42, z.twoPt, "2점 득점", 32);
  svg += `</svg>`;
  return svg;
}
