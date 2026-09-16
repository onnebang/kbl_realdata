import type { CareerGameRow, TeamMeta } from "./playerProfile";
import { displayTeamName } from "./teamNames";

// KBL 10개 구단 및 과거 연고 도시의 정확한 위경도 좌표
const TEAM_CITY: Record<string, { city: string; lat: number; lng: number }> = {
  "06": { city: "수원", lat: 37.26, lng: 127.03 }, // KT 소닉붐
  "10": { city: "울산", lat: 35.54, lng: 129.31 }, // 현대모비스 피버스
  "16": { city: "원주", lat: 37.34, lng: 127.92 }, // DB 프로미
  "30": { city: "고양", lat: 37.66, lng: 126.83 }, // 오리온스(옛)
  "35": { city: "서울", lat: 37.51, lng: 127.07 }, // 삼성 썬더스(잠실)
  "50": { city: "창원", lat: 35.23, lng: 128.68 }, // LG 세이커스
  "55": { city: "서울", lat: 37.51, lng: 127.07 }, // SK 나이츠(잠실학생)
  "60": { city: "부산", lat: 35.18, lng: 129.08 }, // KCC 이지스
  "64": { city: "대구", lat: 35.87, lng: 128.6 },  // 한국가스공사 페가수스
  "65": { city: "인천", lat: 37.46, lng: 126.7 },  // 전자랜드(옛)
  "66": { city: "고양", lat: 37.66, lng: 126.83 }, // 소노 스카이거너스
  "70": { city: "안양", lat: 37.39, lng: 126.96 }, // 정관장 레드부스터스
  "73": { city: "고양", lat: 37.66, lng: 126.83 }, // 캐롯(옛)
};

// 지도 투영 상수: 16:9 와이드 화면(800x450)에서 남한 지도를 정중앙 우측에 이상적 비율로 배치
const LNG_MIN = 125.7,
  LNG_MAX = 130.1,
  LAT_MIN = 33.1,
  LAT_MAX = 38.65;

// 지도 영역 폭 및 오프셋
const MAP_LEFT = 280;
const MAP_TOP = 65;
const MAP_W = 460;
const MAP_H = 370;

function project(lat: number, lng: number): [number, number] {
  const x = MAP_LEFT + ((lng - LNG_MIN) / (LNG_MAX - LNG_MIN)) * MAP_W;
  const y = MAP_TOP + ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * MAP_H;
  return [x, y];
}

export type OpponentPtsRow = {
  tcode: string;
  teamName: string;
  teamAbbr: string;
  teamColor: string;
  pts: number;
  games: number;
  ppg: number;
  highPts: number;
  city: string;
  x: number;
  y: number;
};

export function aggregateByOpponent(
  rows: CareerGameRow[],
  teams: Map<string, TeamMeta>,
  displaySeason: string
): OpponentPtsRow[] {
  const by = new Map<string, { pts: number; games: number; highPts: number }>();
  for (const r of rows) {
    const cur = by.get(r.oppTcode) ?? { pts: 0, games: 0, highPts: 0 };
    cur.pts += r.pts;
    cur.games += 1;
    if (r.pts > cur.highPts) cur.highPts = r.pts;
    by.set(r.oppTcode, cur);
  }

  const out: OpponentPtsRow[] = [];
  for (const [tcode, stat] of by) {
    const loc = TEAM_CITY[tcode];
    if (!loc) continue;
    const [x, y] = project(loc.lat, loc.lng);
    out.push({
      tcode,
      teamName: displayTeamName(tcode, teams.get(tcode)?.name ?? tcode, displaySeason),
      teamAbbr: teams.get(tcode)?.abbr ?? tcode,
      teamColor: teams.get(tcode)?.color ?? "#888888",
      pts: stat.pts,
      games: stat.games,
      ppg: stat.games > 0 ? stat.pts / stat.games : 0,
      highPts: stat.highPts,
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

// 대한민국 본토 실루엣 지오메트리 (프로젝션과 1:1 일치하는 정밀 벡터 패스)
function getSouthKoreaCoastlinePath(): string {
  const pts: [number, number][] = [
    [38.62, 128.37], // 고성 DMZ
    [38.25, 128.58], // 속초
    [37.78, 128.92], // 강릉
    [37.47, 129.17], // 삼척
    [37.05, 129.41], // 울진
    [36.46, 129.39], // 영덕
    [36.08, 129.56], // 포항 호미곶
    [35.80, 129.28], // 경주 해안
    [35.48, 129.38], // 울산 방어진
    [35.15, 129.18], // 부산 해운대
    [35.04, 128.98], // 부산 낙동강 하구
    [34.88, 128.70], // 거제도 북단
    [34.80, 128.60], // 거제도 남단
    [34.84, 128.35], // 통영
    [34.82, 128.02], // 고성만
    [34.80, 127.88], // 남해도
    [34.73, 127.76], // 여수 돌산도
    [34.80, 127.50], // 순천만
    [34.46, 127.28], // 고흥반도
    [34.40, 126.90], // 완도/장흥
    [34.30, 126.50], // 해남 땅끝마을
    [34.45, 126.26], // 진도
    [34.78, 126.38], // 목포
    [35.25, 126.42], // 영광
    [35.68, 126.50], // 부안 변산반도
    [35.98, 126.68], // 군산 금강하구
    [36.33, 126.52], // 보령 대천
    [36.75, 126.13], // 태안반도 안흥항
    [36.92, 126.35], // 서산 가로림만
    [36.96, 126.85], // 당진 아산만
    [37.18, 126.70], // 화성 남양만
    [37.45, 126.60], // 인천 송도/월미도
    [37.70, 126.45], // 강화도 서단
    [37.82, 126.70], // 한강/임진강 하구
    [37.95, 126.78], // 파주 DMZ
    [38.25, 127.15], // 연천/철원 DMZ
    [38.30, 127.90], // 화천/양구 DMZ
    [38.52, 128.25], // 인제/고성 DMZ
  ];

  const svgCoords = pts.map(([lat, lng]) => project(lat, lng));
  return "M" + svgCoords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L") + " Z";
}

// 수도권 밀집 구단 겹침 방지 오프셋 (지시선 Leader Line 적용)
const CAPITAL_OFFSETS: Record<string, { dx: number; dy: number; line: boolean }> = {
  "66": { dx: -38, dy: -24, line: true }, // 소노 (고양) -> 북서쪽
  "30": { dx: -38, dy: -24, line: true }, // 오리온스 (고양)
  "73": { dx: -38, dy: -24, line: true }, // 캐롯 (고양)
  "55": { dx: 18, dy: -32, line: true },  // SK (서울 잠실) -> 북동쪽
  "35": { dx: 46, dy: -12, line: true },  // 삼성 (서울 잠실) -> 동쪽
  "70": { dx: -34, dy: 14, line: true },  // 정관장 (안양) -> 남서쪽
  "06": { dx: 24, dy: 24, line: true },   // KT (수원) -> 남동쪽
};

export function buildKoreaMapSvg(rows: OpponentPtsRow[], totalPts?: number): string {
  if (!rows.length) return "";
  const total = totalPts ?? rows.reduce((s, r) => s + r.pts, 0);
  const maxPts = Math.max(1, ...rows.map((r) => r.pts));
  const rFor = (pts: number) => 9 + (pts / maxPts) * 17;

  const W = 800;
  const H = 450;

  // 천적 TOP 3 (가장 많은 득점을 뽑아낸 상대팀)
  const top3 = rows.slice(0, 3);

  // 제주도 좌표
  const [jejuX, jejuY] = project(33.38, 126.55);
  // 울릉도 좌표
  const [ulleungX, ulleungY] = project(37.50, 130.85);

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<defs>
    <filter id="mapShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000" flood-opacity="0.18"/>
    </filter>
  </defs>`;
  svg += `<style>
    .espnTitle { font-family: "Big Shoulders Display", "Impact", sans-serif; font-size: 26px; font-weight: 800; letter-spacing: 0.04em; fill: var(--ink); text-anchor: middle; }
    .espnSub { font-family: "IBM Plex Mono", "Pretendard", monospace; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; fill: var(--ink-faint); text-anchor: middle; }
    .sideCardTitle { font-family: "Big Shoulders Display", sans-serif; font-size: 15px; font-weight: 800; letter-spacing: 0.06em; fill: var(--ink); }
    .teamRankText { font-family: "Pretendard", sans-serif; font-size: 12px; font-weight: 700; fill: var(--ink); }
    .teamStatText { font-family: "IBM Plex Mono", monospace; font-size: 11px; fill: var(--ink-soft); }
    .mapBubbleText { font-family: "Pretendard", "IBM Plex Mono", sans-serif; font-size: 10px; font-weight: 800; }
  </style>`;

  // 1. 헤더: ESPN 시그니처 캡션 (38,388 POINTS // BY OPPONENT)
  svg += `<text x="${W / 2}" y="36" class="espnTitle">${total.toLocaleString()} POINTS</text>`;
  svg += `<text x="${W / 2}" y="54" class="espnSub">// BY OPPONENT</text>`;

  // 2. 좌측 천적(Nemesis) 요약 패널
  svg += `<g transform="translate(36, 92)">`;
  svg += `<rect x="0" y="0" width="220" height="310" rx="12" fill="var(--surface-soft)" stroke="rgba(var(--line-rgb),0.18)" stroke-width="1" />`;
  svg += `<text x="16" y="28" class="sideCardTitle">MOST POINTS AGAINST</text>`;
  svg += `<line x1="16" y1="38" x2="204" y2="38" stroke="rgba(var(--line-rgb),0.15)" stroke-width="1" />`;

  top3.forEach((r, idx) => {
    const cardY = 52 + idx * 80;
    const share = ((r.pts / total) * 100).toFixed(1);
    svg += `<g transform="translate(16, ${cardY})">`;
    svg += `<circle cx="14" cy="18" r="12" fill="${r.teamColor}" opacity="0.9" />`;
    svg += `<text x="14" y="22" text-anchor="middle" font-family="Big Shoulders Display" font-weight="800" font-size="13" fill="#fff">${idx + 1}</text>`;
    svg += `<text x="34" y="15" class="teamRankText">${esc(r.teamName)} (${esc(r.city)})</text>`;
    svg += `<text x="34" y="32" class="teamStatText">${r.pts.toLocaleString()}점 · ${r.ppg.toFixed(1)} PPG (${share}%)</text>`;
    svg += `<text x="34" y="46" font-family="Pretendard" font-size="10" fill="var(--ink-faint)">최다 ${r.highPts}점 / ${r.games}경기</text>`;
    svg += `</g>`;
  });
  svg += `</g>`;

  // 3. 지도 실루엣 (남한 본토 + 제주도 + 울릉도)
  svg += `<g filter="url(#mapShadow)">`;
  // 본토
  svg += `<path d="${getSouthKoreaCoastlinePath()}" fill="var(--surface)" stroke="rgba(var(--line-rgb),0.35)" stroke-width="1.8" stroke-linejoin="round"/>`;
  // 제주도
  svg += `<ellipse cx="${jejuX.toFixed(1)}" cy="${jejuY.toFixed(1)}" rx="24" ry="14" fill="var(--surface)" stroke="rgba(var(--line-rgb),0.35)" stroke-width="1.8" />`;
  // 울릉도 / 독도
  svg += `<ellipse cx="${(ulleungX - 30).toFixed(1)}" cy="${ulleungY.toFixed(1)}" rx="7" ry="5" fill="var(--surface)" stroke="rgba(var(--line-rgb),0.35)" stroke-width="1.5" />`;
  svg += `<circle cx="${(ulleungX - 8).toFixed(1)}" cy="${(ulleungY + 6).toFixed(1)}" r="3" fill="var(--surface)" stroke="rgba(var(--line-rgb),0.35)" stroke-width="1.2" />`;
  svg += `</g>`;

  // 4. 구단별 원형 버블 및 지시선(Leader line)
  // 득점 큰 순서대로 정렬하여 중요한 팀이 위에 표시되도록
  const sorted = [...rows].sort((a, b) => a.pts - b.pts);

  for (const r of sorted) {
    const rad = rFor(r.pts);
    const offset = CAPITAL_OFFSETS[r.tcode];
    const bx = offset ? r.x + offset.dx : r.x;
    const by = offset ? r.y + offset.dy : r.y;

    // 수도권 등 겹침 구단 지시선
    if (offset?.line) {
      svg += `<line x1="${r.x.toFixed(1)}" y1="${r.y.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${r.teamColor}" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.8"/>`;
      svg += `<circle cx="${r.x.toFixed(1)}" cy="${r.y.toFixed(1)}" r="3.5" fill="${r.teamColor}"/>`;
    }

    // 메인 팀 버블
    svg += `<g class="teamBubble">`;
    svg += `<title>${esc(r.teamName)} (${esc(r.city)}) · ${r.pts.toLocaleString()}점 (평균 ${r.ppg.toFixed(1)}점 / ${r.games}경기)</title>`;
    svg += `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${rad.toFixed(1)}" fill="${r.teamColor}" opacity="0.94" stroke="#ffffff" stroke-width="2.2" filter="url(#mapShadow)"/>`;

    // 버블 라벨 (버블이 충분히 클 때 버블 내부에 글자 표시, 아니면 바로 밑/옆)
    const label = `${r.teamAbbr} ${r.pts}`;
    if (rad >= 15) {
      svg += `<text x="${bx.toFixed(1)}" y="${(by - 2).toFixed(1)}" text-anchor="middle" font-family="Pretendard, sans-serif" font-size="10" font-weight="800" fill="#ffffff">${esc(r.teamAbbr)}</text>`;
      svg += `<text x="${bx.toFixed(1)}" y="${(by + 11).toFixed(1)}" text-anchor="middle" font-family="Big Shoulders Display" font-size="12" font-weight="800" fill="#ffffff">${r.pts}</text>`;
    } else {
      const ty = by + rad + 11;
      svg += `<text x="${bx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" font-family="Pretendard, sans-serif" font-size="10" font-weight="800" fill="var(--ink)">${esc(label)}</text>`;
    }
    svg += `</g>`;
  }

  svg += `</svg>`;
  return svg;
}
