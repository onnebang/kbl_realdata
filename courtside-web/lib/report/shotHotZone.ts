import { eunNeun } from "../josa";
import { teamZoneStats, type ShotRow } from "../zoneCompare";
import {
  computeNbaZoneStats,
  fallbackZoneTotalsToNbaMap,
  buildNbaDualCourtSvg,
  buildNbaSingleCourtSvg,
  NBA_DUAL_VIEWBOX,
  NBA_SINGLE_RIGHT_VIEWBOX,
} from "./nbaShotZones";
import { escHtml, type HtmlSection, type ReportTags, type ReportTeamMeta } from "./renderKit";

// ---------------------------------------------------------------------------
// 슈팅 핫존 & 콜드존 (Spatial Shot Analysis)
//
// 5개 구역 중 두 팀 득점차가 가장 컸던 한 곳. 그 구역 한 곳의 차이가 최종 마진보다 클 때만
// 말한다('마진보다 크다'가 서술을 주장으로 바꿔주는 조건이고, 없이는 79.6%에서 떠서 아무 말도
// 아니게 된다). 그 구역을 이기고도 진 경기면 그 역설을 그대로 보여준다.
//
// computeHotZoneEdge()는 HTML을 모르는 순수 계산, renderHotZoneSection()은 문장만 만든다.
// ---------------------------------------------------------------------------

export const ZONE_LABEL: Record<string, string> = { rim: "림", close: "근거리", midShort: "중거리", midLong: "롱2", three: "3점" };

/** 최대 구역 득점차 - p50 12 / p75 18 / p90 24. '최종 마진보다 크다' 조건과 함께 15면 33.7%. */
export const ZONE_MIN_DIFF = 15;
/** 역설(구역을 이기고도 패배)일 때 "대신 여기서 밀렸다"로 같이 보여줄 구역의 최소 격차. */
const MADE_UP_MIN_DIFF = 6;

/** 좌표(2점 4구역) 기준. 3점만 공식 기록을 쓴다 - 아래 teamThrees 주석 참고. */
export const COORD_ZONE_KEYS = ["rim", "close", "midShort", "midLong"] as const;

export type ZoneSide = { att: number; made: number; pts: number };
export type ZoneTotal = { key: string; home: ZoneSide; away: ZoneSide };

export type HotZoneEdge = {
  zones: ZoneTotal[];
  /** 두 팀 득점차가 가장 컸던 구역. */
  top: ZoneTotal;
  /** top 구역의 홈-원정 득점차(부호 유지). */
  diff: number;
  /** 최종 마진(홈-원정). 부호로 경기 승자를 알 수 있다. */
  margin: number;
  zoneWinner: "home" | "away";
  /** 그 구역을 이기고도 경기를 졌다. */
  paradox: boolean;
  /** paradox일 때만: 경기 승자가 MADE_UP_MIN_DIFF 이상 더 넣은 다른 구역 상위 2개. */
  madeUp: ZoneTotal[];
  /** 12구역 NBA 브레이크다운 렌더링용 */
  shots?: ShotRow[];
  homeTcode?: string;
  awayTcode?: string;
};

export type HotZoneInput = {
  shots: ShotRow[];
  /**
   * game_team_stats의 3점 공식 기록. 좌표로 역산한 3점 판정은 팀-경기 단위로 공식 tpa와
   * |차이|<=1이 73%뿐이라(정확히 일치 51.3%) 3점 구역만은 이걸 쓴다. 2점 4개 구역은 좌표.
   */
  teamThrees?: { tcode: string; tpm: number; tpa: number }[];
  homeTcode: string;
  awayTcode: string;
  homeScore: number;
  awayScore: number;
};

/**
 * 5개 구역(림/근거리/중거리/롱2/3점)의 팀별 성공·시도·득점. 슛이 없으면 null.
 *
 * computeHotZoneEdge()에서 뽑아냈다 - '득점 출처' 차트(report/fourFactors.ts)가 같은 숫자를
 * 써야 한다. 두 곳이 각자 집계하면 같은 화면에서 같은 구역이 다른 수치로 나올 수 있다.
 *
 * 2점 4구역은 좌표, 3점은 공식 기록(teamThrees가 있으면)이다. 좌표 쪽은 공식 2점 득점과
 * **정확히 일치하지 않는다** - 실측(2026-09-30, 8,444 팀-경기): 일치 71.4%, 슛 2개(4점) 이내
 * 93.2%, 최근 시즌은 2025-26 97.7% / 2026-27 100%(20 팀-경기). 이 함수는 좌표 그대로 돌려주고,
 * 공식 기록과의 대조는 쓰는 쪽이 한다(fourFactors.ts의 ZONE_MAX_GAP_PTS).
 */
export function computeZoneTotals(input: Pick<HotZoneInput, "shots" | "teamThrees" | "homeTcode" | "awayTcode">): ZoneTotal[] | null {
  const { shots, homeTcode, awayTcode } = input;
  if (!shots.length) return null;

  const zh = teamZoneStats(shots, homeTcode);
  const za = teamZoneStats(shots, awayTcode);
  const th = input.teamThrees?.find((t) => t.tcode === homeTcode);
  const ta = input.teamThrees?.find((t) => t.tcode === awayTcode);

  const zones: ZoneTotal[] = COORD_ZONE_KEYS.map((key) => ({
    key,
    home: { att: zh[key].att, made: zh[key].made, pts: zh[key].made * 2 },
    away: { att: za[key].att, made: za[key].made, pts: za[key].made * 2 },
  }));
  zones.push(
    th && ta
      ? { key: "three", home: { att: th.tpa, made: th.tpm, pts: th.tpm * 3 }, away: { att: ta.tpa, made: ta.tpm, pts: ta.tpm * 3 } }
      : {
          key: "three",
          home: { att: zh.three.att, made: zh.three.made, pts: zh.three.made * 3 },
          away: { att: za.three.att, made: za.three.made, pts: za.three.made * 3 },
        }
  );
  return zones;
}

/** 말할 만한 구역 격차가 없으면 null. */
export function computeHotZoneEdge(input: HotZoneInput): HotZoneEdge | null {
  const { homeScore, awayScore, homeTcode, awayTcode, shots } = input;
  const zones = computeZoneTotals(input);
  if (!zones) return null;

  const top = zones.reduce((b, z) => (Math.abs(z.home.pts - z.away.pts) > Math.abs(b.home.pts - b.away.pts) ? z : b));
  const diff = top.home.pts - top.away.pts;
  const margin = homeScore - awayScore;
  if (Math.abs(diff) < ZONE_MIN_DIFF || Math.abs(diff) <= Math.abs(margin)) return null;

  const zoneWinner: "home" | "away" = diff > 0 ? "home" : "away";
  const gameWinner: "home" | "away" = margin > 0 ? "home" : "away";
  const paradox = zoneWinner !== gameWinner;
  const madeUp = paradox
    ? zones
        .filter((z) => z.key !== top.key)
        .map((z) => ({ z, d: gameWinner === "home" ? z.home.pts - z.away.pts : z.away.pts - z.home.pts }))
        .filter((x) => x.d >= MADE_UP_MIN_DIFF)
        .sort((x, y) => y.d - x.d)
        .slice(0, 2)
        .map((x) => x.z)
    : [];

  return { zones, top, diff, margin, zoneWinner, paradox, madeUp, shots, homeTcode, awayTcode };
}

export function renderHotZoneSection(
  edge: HotZoneEdge,
  ctx: { homeTeam: ReportTeamMeta; awayTeam: ReportTeamMeta; tags: ReportTags }
): HtmlSection {
  const { homeTeam, awayTeam, tags } = ctx;
  const metaOf = (side: "home" | "away") => (side === "home" ? homeTeam : awayTeam);
  const statOf = (z: ZoneTotal, side: "home" | "away") => (side === "home" ? z.home : z.away);
  const loserSide: "home" | "away" = edge.zoneWinner === "home" ? "away" : "home";
  const zw = { team: metaOf(edge.zoneWinner), s: statOf(edge.top, edge.zoneWinner) };
  const zl = { team: metaOf(loserSide), s: statOf(edge.top, loserSide) };
  const label = ZONE_LABEL[edge.top.key];
  const absDiff = Math.abs(edge.diff);
  const absMargin = Math.abs(edge.margin);

  let html: string;
  if (!edge.paradox) {
    // "구역 격차가 최종 마진보다 컸다"는 수사를 뺐다: 접전 경기에서 최대 구역 격차는 거의 항상
    // 마진보다 크다(구역 격차의 합이 마진이므로 한 구역이 마진을 넘는 건 평범한 일이다).
    // 항상 참인 비교라 정보가 없고, 아래 paradox 갈래가 그 반례를 스스로 보여준다.
    // 대신 실제로 말할 거리인 **시도 수 차이와 성공률**을 쓴다(실측 S49G14N4: 림 구역 17회 대
    // 6회 - 성공률보다 '그 구역에서 몇 번 던졌나'가 격차의 주된 원인이었다).
    const pctOf = (s: { made: number; att: number }) => (s.att > 0 ? Math.round((s.made / s.att) * 100) : 0);
    const attGap = zw.s.att - zl.s.att;
    const volumeLed = attGap >= zl.s.att; // 시도 수가 두 배 이상이면 볼륨이 주된 원인
    html =
      `<ul class="report-list">${tags.liOpen(zw.team.tcode)}🔥 <b>${label} 핫존 지배</b> - ${tags.teamTag(zw.team.tcode, zw.team.name)}${eunNeun(zw.team.name)} 이 구역에서 ${zw.s.made}/${zw.s.att}(${pctOf(zw.s)}%), 상대 ${tags.teamTag(zl.team.tcode, zl.team.name)}${eunNeun(zl.team.name)} ${zl.s.made}/${zl.s.att}(${pctOf(zl.s)}%)를 기록해 <b>${absDiff}점</b> 차가 났습니다. ` +
      (volumeLed
        ? `성공률보다 <b>시도 수</b>(${zw.s.att}회 대 ${zl.s.att}회)가 이 격차의 주된 원인입니다 - 이 구역에서 슛을 만들어낸 횟수 자체가 달랐습니다.`
        : `시도 수는 ${zw.s.att}회 대 ${zl.s.att}회로 비슷했고, 성공률에서 갈렸습니다.`) +
      ` (최종 마진 ${absMargin}점)</li></ul>`;
  } else {
    // 그 구역을 이기고도 진 경기 - 승자가 그보다 더 크게 벌린 구역을 같이 보여준다.
    const gameWinner: "home" | "away" = edge.margin > 0 ? "home" : "away";
    const gameLoser: "home" | "away" = gameWinner === "home" ? "away" : "home";
    const madeUp = edge.madeUp.map((z) => {
      const ws = statOf(z, gameWinner);
      const ls = statOf(z, gameLoser);
      return `<b>${ZONE_LABEL[z.key]}</b>(${ls.made}/${ls.att} vs ${ws.made}/${ws.att})`;
    });
    html =
      `<ul class="report-list">${tags.liOpen(zw.team.tcode)}🧊 <b>${label} 핫존의 역설</b> - ${tags.teamTag(zw.team.tcode, zw.team.name)}${eunNeun(zw.team.name)} 이 구역에서 ${zw.s.made}/${zw.s.att}를 기록하며 상대(${tags.teamTag(zl.team.tcode, zl.team.name)} ${zl.s.made}/${zl.s.att})보다 <b>${absDiff}점</b>을 더 넣고도 오히려 패배했습니다` +
      (madeUp.length ? `. 반대로 ${madeUp.join("과 ")}에서 치명적인 콜드존을 형성하며 더 크게 밀렸기 때문입니다.` : ".") +
      `</li></ul>`;
  }
  html += renderZoneHeatmap(edge, homeTeam, awayTeam);
  html += `<p class="report-caveat">구역은 슛 좌표에서 거리로 역산한 것이라 100% 공식 기록과 일치하지 않을 수 있습니다 (3점만 공식 기록 반영). 자유투는 제외.</p>`;
  return { title: "슈팅 핫존 & 콜드존 (Spatial Shot Analysis)", html };
}

/**
 * 구역 히트맵 두 장(홈·원정) + 5구역 전체 비교 표.
 *
 * 왜 이 절에 붙였나: 이 절은 5개 구역을 다 계산해 두고도 **그중 한 곳**만 문장으로 말하고
 * 나머지 네 곳은 버렸다. 버리는 대신 보여준다 - 계산이 이미 끝나 있어서 추가 비용이 없다.
 * 숫자는 SVG 밖 표에 둔다(lib/report/zoneHeatmap.ts 주석 - SVG 글자 크기 문제).
 */
/**
 * NBA 2K 스타일 구역별 슈팅 브레이크다운 (Spatial Shot Analysis)
 *
 * 12개 기하학적 구역(림, 페인트 3구역, 미드레인지 3구역, 3점 5구역) 안에
 * 시도-성공(made-att) 및 성공률(pct%)을 직접 표시하고,
 * 핫(Red) / 콜드(Blue) / 뉴트럴(Dark) 색상으로 한눈에 파악할 수 있는 디자인.
 *
 * - PC: 중앙선을 맞대고 있는 가로 대칭 듀얼 코트 (좌: 홈팀, 우: 원정팀)
 * - 모바일: 반응형 단일 하프코트 및 팀 탭 토글로 글자 시인성 100% 보장
 */
function renderZoneHeatmap(edge: HotZoneEdge, homeTeam: ReportTeamMeta, awayTeam: ReportTeamMeta): string {
  const shares = (side: "home" | "away") =>
    edge.zones.map((z) => ({ key: z.key, made: z[side].made, att: z[side].att }));

  // 12구역 통계 집계 (슛 로그가 있으면 정밀 집계, 없으면 5구역 분할 폴백)
  const homeStats = edge.shots
    ? computeNbaZoneStats(edge.shots, homeTeam.tcode)
    : fallbackZoneTotalsToNbaMap(shares("home"));
  const awayStats = edge.shots
    ? computeNbaZoneStats(edge.shots, awayTeam.tcode)
    : fallbackZoneTotalsToNbaMap(shares("away"));

  const homeTotal = edge.zones.reduce((s, z) => ({ made: s.made + z.home.made, att: s.att + z.home.att }), { made: 0, att: 0 });
  const awayTotal = edge.zones.reduce((s, z) => ({ made: s.made + z.away.made, att: s.att + z.away.att }), { made: 0, att: 0 });

  const homePct = homeTotal.att > 0 ? Math.round((homeTotal.made / homeTotal.att) * 100) : 0;
  const awayPct = awayTotal.att > 0 ? Math.round((awayTotal.made / awayTotal.att) * 100) : 0;

  const uid = Math.random().toString(36).substring(2, 7);

  const pctOf = (s: { made: number; att: number }) => (s.att > 0 ? `${Math.round((s.made / s.att) * 100)}%` : "-");
  const rows = edge.zones
    .map((z) => {
      const d = z.home.pts - z.away.pts;
      return (
        `<tr${z.key === edge.top.key ? ' class="zone-row-top"' : ""}><th scope="row">${ZONE_LABEL[z.key]}</th>` +
        `<td>${z.home.made}/${z.home.att} <span class="zone-pct">${pctOf(z.home)}</span></td>` +
        `<td>${z.away.made}/${z.away.att} <span class="zone-pct">${pctOf(z.away)}</span></td>` +
        `<td>${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)}점</td></tr>`
      );
    })
    .join("");

  return (
    `<div class="nba-shot-card">` +
    // 카드 헤더 (팀 메타 및 2K 브레이크다운 타이틀)
    `<div class="nba-card-header">` +
    `<div class="nba-team-box home">` +
    `<span class="nba-team-badge" style="background:${escHtml(homeTeam.color || '#3b82f6')}">${escHtml(homeTeam.abbr)}</span>` +
    `<div class="nba-team-meta">` +
    `<span class="nba-team-name">${escHtml(homeTeam.name)}</span>` +
    `<span class="nba-team-stat">야투 <b>${homeTotal.made}/${homeTotal.att}</b> (${homePct}%)</span>` +
    `</div>` +
    `</div>` +
    `<div class="nba-center-badge">` +
    `<span class="nba-badge-top">SPATIAL BREAKDOWN</span>` +
    `<span class="nba-badge-title">SHOOTING CHART</span>` +
    `</div>` +
    `<div class="nba-team-box away">` +
    `<div class="nba-team-meta away">` +
    `<span class="nba-team-name">${escHtml(awayTeam.name)}</span>` +
    `<span class="nba-team-stat">야투 <b>${awayTotal.made}/${awayTotal.att}</b> (${awayPct}%)</span>` +
    `</div>` +
    `<span class="nba-team-badge" style="background:${escHtml(awayTeam.color || '#ef4444')}">${escHtml(awayTeam.abbr)}</span>` +
    `</div>` +
    `</div>` +

    // 모바일 전용 네이티브 라디오 탭 컨트롤 (JS 불필요)
    `<input type="radio" id="nba-tab-dual-${uid}" name="nba-tab-${uid}" class="nba-tab-input-dual" checked>` +
    `<input type="radio" id="nba-tab-home-${uid}" name="nba-tab-${uid}" class="nba-tab-input-home">` +
    `<input type="radio" id="nba-tab-away-${uid}" name="nba-tab-${uid}" class="nba-tab-input-away">` +
    `<div class="nba-mobile-nav">` +
    `<label for="nba-tab-dual-${uid}" class="nba-nav-btn dual-btn">양팀 비교</label>` +
    `<label for="nba-tab-home-${uid}" class="nba-nav-btn home-btn">${escHtml(homeTeam.abbr)}</label>` +
    `<label for="nba-tab-away-${uid}" class="nba-nav-btn away-btn">${escHtml(awayTeam.abbr)}</label>` +
    `</div>` +

    // PC 듀얼 대칭 쇼다운 코트 (풀코트 뷰)
    `<div class="nba-dual-court-section">` +
    `<div class="nba-court-sublabels">` +
    `<span class="nba-sublabel home">◀ ${escHtml(homeTeam.name)}</span>` +
    `<span class="nba-sublabel away">${escHtml(awayTeam.name)} ▶</span>` +
    `</div>` +
    `<svg class="nba-court-svg nba-dual-svg" viewBox="${NBA_DUAL_VIEWBOX}" role="img" aria-label="${escHtml(homeTeam.name)} 대 ${escHtml(awayTeam.name)} 슛 브레이크다운">` +
    buildNbaDualCourtSvg(homeStats, awayStats) +
    `</svg>` +
    `</div>` +

    // 모바일 단일 하프코트 뷰 (탭에 따라 전환 또는 상하 스택)
    `<div class="nba-mobile-courts-section">` +
    `<div class="nba-mobile-single-panel home-panel">` +
    `<div class="nba-panel-head"><span class="nba-panel-chip" style="background:${escHtml(homeTeam.color || '#3b82f6')}">${escHtml(homeTeam.abbr)}</span> ${escHtml(homeTeam.name)} · <b>${homeTotal.made}/${homeTotal.att}</b> (${homePct}%)</div>` +
    `<svg class="nba-court-svg nba-single-svg" viewBox="${NBA_SINGLE_RIGHT_VIEWBOX}" role="img" aria-label="${escHtml(homeTeam.name)} 슛 차트">` +
    buildNbaSingleCourtSvg(homeStats, false) +
    `</svg>` +
    `</div>` +
    `<div class="nba-mobile-single-panel away-panel">` +
    `<div class="nba-panel-head"><span class="nba-panel-chip" style="background:${escHtml(awayTeam.color || '#ef4444')}">${escHtml(awayTeam.abbr)}</span> ${escHtml(awayTeam.name)} · <b>${awayTotal.made}/${awayTotal.att}</b> (${awayPct}%)</div>` +
    `<svg class="nba-court-svg nba-single-svg" viewBox="${NBA_SINGLE_RIGHT_VIEWBOX}" role="img" aria-label="${escHtml(awayTeam.name)} 슛 차트">` +
    buildNbaSingleCourtSvg(awayStats, false) +
    `</svg>` +
    `</div>` +
    `</div>` +

    // 핫 & 콜드 컬러 범례 바
    `<div class="nba-legend-bar">` +
    `<div class="nba-legend-scale">` +
    `<span class="nba-legend-item"><i class="nba-dot" style="background:#c92a2a"></i> <b>핫존</b> (50%+)</span>` +
    `<span class="nba-legend-item"><i class="nba-dot" style="background:#a8383b"></i> <b>보통</b> (40~49%)</span>` +
    `<span class="nba-legend-item"><i class="nba-dot" style="background:#2e3440"></i> <b>평균</b> (30~39%)</span>` +
    `<span class="nba-legend-item"><i class="nba-dot" style="background:#1565c0"></i> <b>콜드존</b> (0~29%)</span>` +
    `</div>` +
    `<div class="nba-legend-note">구역 수치: [성공-시도] / [성공률%]</div>` +
    `</div>` +
    `</div>` +

    // 설명 및 5개 구역 상세 비교 표
    `<p class="report-caveat">NBA 2K 스타일 12구역 슛 차트입니다. 🔥 붉은색은 고성공률 핫존(50%+), 🧊 푸른색은 저성공률 콜드존(30% 미만 및 0%)을 나타냅니다. 구역 안의 숫자는 [성공-시도] 및 [성공률%]입니다.</p>` +
    `<table class="zone-table"><thead><tr><th scope="col">구역</th><th scope="col">${escHtml(homeTeam.abbr)}</th><th scope="col">${escHtml(awayTeam.abbr)}</th><th scope="col">득점차</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}
