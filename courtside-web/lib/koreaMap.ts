import type { CareerGameRow, TeamMeta } from "./playerProfile";
import { displayTeamName } from "./teamNames";

// 상대팀 연고지 지도(요청 - "대한민국 지도로 어디서 넣었는지"). 정확한 좌표계 지도가 아니라
// 구단 연고 도시의 상대 위치(위경도 투영)만 맞춘 약식 지도다 - 실제 해안선을 그리지 않는다
// (틀린 해안선을 그리느니 "약식"이라고 정직하게 말하는 편이 낫다는 이 프로젝트의 원칙).
// 좌표 대상은 "그 상대가 지금 어느 도시 연고인가"이지 그 경기 당시 실제 연고가 아니다(전주→부산
// 이전 같은 경우도 전부 현재 연고로 - displayTeamName과 같은 태도).
const TEAM_CITY: Record<string, { city: string; lat: number; lng: number }> = {
  "06": { city: "수원", lat: 37.26, lng: 127.03 }, // KT
  "10": { city: "울산", lat: 35.54, lng: 129.31 }, // 현대모비스
  "16": { city: "원주", lat: 37.34, lng: 127.92 }, // DB
  "30": { city: "고양", lat: 37.66, lng: 126.83 }, // 오리온스(옛)
  "35": { city: "서울", lat: 37.57, lng: 126.98 }, // 삼성
  "50": { city: "창원", lat: 35.23, lng: 128.68 }, // LG
  "55": { city: "서울", lat: 37.57, lng: 126.98 }, // SK
  "60": { city: "부산", lat: 35.18, lng: 129.08 }, // KCC(현 연고)
  "64": { city: "대구", lat: 35.87, lng: 128.6 }, // 한국가스공사
  "65": { city: "인천", lat: 37.46, lng: 126.7 }, // 전자랜드(옛)
  "66": { city: "고양", lat: 37.66, lng: 126.83 }, // 소노
  "70": { city: "안양", lat: 37.39, lng: 126.96 }, // 정관장
  "73": { city: "고양", lat: 37.66, lng: 126.83 }, // 캐롯(옛)
};

const LNG0 = 126.0,
  LNG1 = 129.6,
  LAT0 = 34.0,
  LAT1 = 38.8;
const MAP_W = 240,
  MAP_H = 320;
function project(lat: number, lng: number): [number, number] {
  return [((lng - LNG0) / (LNG1 - LNG0)) * MAP_W, ((LAT1 - lat) / (LAT1 - LAT0)) * MAP_H];
}

export type OpponentPtsRow = { tcode: string; teamName: string; teamAbbr: string; teamColor: string; pts: number; city: string; x: number; y: number };

export function aggregateByOpponent(rows: CareerGameRow[], teams: Map<string, TeamMeta>, displaySeason: string): OpponentPtsRow[] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.oppTcode, (by.get(r.oppTcode) ?? 0) + r.pts);
  const out: OpponentPtsRow[] = [];
  for (const [tcode, pts] of by) {
    const loc = TEAM_CITY[tcode];
    if (!loc) continue; // 팀 표에 없는 코드(합병 이전 등) - 지도엔 자리가 없어 건너뛴다.
    const [x, y] = project(loc.lat, loc.lng);
    out.push({
      tcode,
      teamName: displayTeamName(tcode, teams.get(tcode)?.name ?? tcode, displaySeason),
      teamAbbr: teams.get(tcode)?.abbr ?? tcode,
      teamColor: teams.get(tcode)?.color ?? "#888888",
      pts,
      city: loc.city,
      x,
      y,
    });
  }
  return out.sort((a, b) => b.pts - a.pts);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 정확한 해안선이 아니라 부드러운 윤곽 하나로 "이 근방"만 표시(위 주석 참고).
const LANDMASS =
  "M85,10 C120,6 155,10 175,35 C190,55 198,75 195,90 C190,115 182,128 185,140 C192,160 205,175 200,190 " +
  "C215,205 232,215 230,230 C226,250 212,265 205,275 C190,292 178,300 165,305 C145,310 130,306 120,300 " +
  "C105,296 95,282 90,270 C78,260 62,248 55,235 C42,220 37,200 35,180 C32,160 30,140 30,120 " +
  "C30,95 36,75 45,60 C55,42 68,25 85,10 Z";

export function buildKoreaMapSvg(rows: OpponentPtsRow[]): string {
  if (!rows.length) return "";
  const maxPts = Math.max(...rows.map((r) => r.pts));
  const rFor = (pts: number) => 8 + (pts / maxPts) * 20;
  let svg = `<svg viewBox="0 0 ${MAP_W} ${MAP_H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<style>.km{font-family:"Pretendard","IBM Plex Mono",sans-serif;font-size:9px}` +
    `@media(max-width:619px){.km{font-size:12px}}@media(max-width:479px){.km{font-size:15px}}</style>`;
  svg += `<path d="${LANDMASS}" fill="var(--surface-soft)" stroke="rgba(var(--line-rgb),0.3)" stroke-width="1.5"/>`;
  // 원은 전부 그린다(겹쳐도 정보는 안 잃는다 - 서울·고양은 실제로 구단이 여럿이라 좌표가 같거나
  // 가깝다). 라벨만 득점 큰 팀부터 놓고 겹치면 건너뛴다(제보: 라벨이 뭉쳐서 안 읽힘 - 겹침 회피는
  // shotValueScatter.ts와 같은 기법).
  for (const r of rows) {
    const rad = rFor(r.pts);
    svg += `<circle cx="${r.x.toFixed(1)}" cy="${r.y.toFixed(1)}" r="${rad.toFixed(1)}" fill="${r.teamColor}" opacity="0.82" stroke="var(--surface)" stroke-width="1.5"><title>${esc(r.teamName)}(${esc(r.city)}) · ${r.pts.toLocaleString()}점</title></circle>`;
  }
  const placed: [number, number, number, number][] = [];
  for (const r of [...rows].sort((a, b) => b.pts - a.pts)) {
    const rad = rFor(r.pts);
    const label = `${r.teamAbbr} ${r.pts.toLocaleString()}`;
    const w = label.length * 5.4 + 4; // 실측 폭 대신 간이 추정(이 프로젝트 다른 SVG 빌더도 각자 자기 폭 함수를 둔다).
    const tx = r.x,
      ty = r.y + rad + 11;
    const box: [number, number, number, number] = [tx - w / 2, ty - 9, tx + w / 2, ty + 3];
    if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    svg += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" class="km" font-weight="700" fill="var(--ink)" paint-order="stroke" stroke="var(--surface)" stroke-width="3">${esc(label)}</text>`;
  }
  svg += `</svg>`;
  return svg;
}
