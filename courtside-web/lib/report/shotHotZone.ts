import { eunNeun } from "../josa";
import { teamZoneStats, type ShotRow } from "../zoneCompare";
import { buildZoneHeatmapSvg, HEATMAP_VIEWBOX } from "./zoneHeatmap";
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

const ZONE_LABEL: Record<string, string> = { rim: "림", close: "근거리", midShort: "중거리", midLong: "롱2", three: "3점" };

/** 최대 구역 득점차 - p50 12 / p75 18 / p90 24. '최종 마진보다 크다' 조건과 함께 15면 33.7%. */
export const ZONE_MIN_DIFF = 15;
/** 역설(구역을 이기고도 패배)일 때 "대신 여기서 밀렸다"로 같이 보여줄 구역의 최소 격차. */
const MADE_UP_MIN_DIFF = 6;

/** 좌표(2점 4구역) 기준. 3점만 공식 기록을 쓴다 - 아래 teamThrees 주석 참고. */
const COORD_ZONE_KEYS = ["rim", "close", "midShort", "midLong"] as const;

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

/** 말할 만한 구역 격차가 없으면 null. */
export function computeHotZoneEdge(input: HotZoneInput): HotZoneEdge | null {
  const { shots, homeTcode, awayTcode, homeScore, awayScore } = input;
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

  return { zones, top, diff, margin, zoneWinner, paradox, madeUp };
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
function renderZoneHeatmap(edge: HotZoneEdge, homeTeam: ReportTeamMeta, awayTeam: ReportTeamMeta): string {
  const shares = (side: "home" | "away") =>
    edge.zones.map((z) => ({ key: z.key, made: z[side].made, att: z[side].att }));
  const court = (team: ReportTeamMeta, side: "home" | "away") => {
    // 합계에 '구역 합계'라고 붙이는 이유: 3점만 공식 기록이고 2점 4구역은 좌표라, 이 합이
    // 페이지 아래 '팀 스탯'의 공식 야투 시도와 1~2개 어긋날 수 있다(실측 LG 60 vs 공식 61).
    // 라벨 없이 숫자만 두면 같은 화면의 두 값이 다른 것처럼 보인다.
    const total = edge.zones.reduce((s, z) => ({ made: s.made + z[side].made, att: s.att + z[side].att }), { made: 0, att: 0 });
    return (
      `<div class="zone-heat-col"><div class="zone-heat-cap">${escHtml(team.abbr)} · 구역 합계 ${total.made}/${total.att}</div>` +
      `<svg class="zone-heat-court" viewBox="${HEATMAP_VIEWBOX}" role="img" aria-label="${escHtml(team.name)} 구역별 성공률">${buildZoneHeatmapSvg(shares(side), team.color ?? "#888888")}</svg></div>`
    );
  };
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
    `<div class="zone-heat">${court(homeTeam, "home")}${court(awayTeam, "away")}</div>` +
    `<p class="report-caveat">진한 쪽이 성공률이 높은 구역입니다. 밴드는 골대로부터의 거리로만 갈립니다(림 1.2m · 근거리 3m · 중거리 5m · 롱2 6.75m · 그 밖은 3점).</p>` +
    `<table class="zone-table"><thead><tr><th scope="col">구역</th><th scope="col">${escHtml(homeTeam.abbr)}</th><th scope="col">${escHtml(awayTeam.abbr)}</th><th scope="col">득점차</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}
