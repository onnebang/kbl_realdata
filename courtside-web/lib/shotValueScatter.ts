import { supabase } from "./supabase";
import { classifyShot } from "./formIndex";
import { computeTSA, computePSA, computeMoreyPct } from "./shotImpactChart";
import { fetchAllPagesBounded, getSeasonsWithShots, MIN_SAMPLE } from "./scoringExplorer";

// "고효율 슛 선택과 슈팅 효율" 리그 전체 산점도(Morey rate x PSA, 버블 크기 = TSA) - 득점 분포
// 탐색기의 새 탭. lib/shotImpactChart.ts가 이미 세운 TSA/PSA/MOREY% 공식(computeTSA/computePSA/
// computeMoreyPct)과 존 분류(classifyShot)를 그대로 재사용하되, 그 파일은 "선수 1명 x 시즌 1개"
// 규모라 순차 페이지네이션이었던 반면 여기는 "시즌 1개의 전체 로스터"가 한 번에 필요해서
// (선수별로 N+1 조회하면 시즌당 수십~백여 번 왕복하는 폭발) game_player_stats/shot_log를
// 시즌 단위로 한 번씩만 통째로 끌어와 JS에서 pcode별로 집계 - lib/scoringExplorer.ts가 같은
// "시즌 전체(3만행대)를 빠르게" 문제를 병렬 페이지네이션(fetchAllPagesBounded)으로 이미 풀어둬서
// 그대로 재사용(중복 구현 금지, 실측 성능도 이미 검증됨 - 그 파일 상단 주석 참고).
export { MIN_SAMPLE };

export type ScatterPlayerRow = {
  pcode: string;
  name: string;
  tcode: string;
  teamAbbr: string;
  teamColor: string;
  tsa: number;
  psa: number;
  moreyPct: number;
};

export type ShotValueScatterData = {
  season: string;
  players: ScatterPlayerRow[];
  avgPsa: number;
  avgMoreyPct: number;
  tsaMin: number;
  tsaMax: number;
};

export async function getSeasonsForScatter(): Promise<string[]> {
  return getSeasonsWithShots();
}

type BoxAgg = { pts: number; fga: number; fta: number };

// game_player_stats.fga/fgm은 2점 시도만이고 3점은 tpa/tpm에 별도(shotImpactChart.ts에서
// 실측 확정된 이 프로젝트 스키마 관례) - TSA/MOREY%가 요구하는 "총 FGA"는 fga+tpa.
export async function getShotValueScatterData(seasonName: string): Promise<ShotValueScatterData> {
  type BoxRow = { pcode: string; tcode: string; pts: number | null; fga: number | null; tpa: number | null; fta: number | null };
  const boxRows = await fetchAllPagesBounded<BoxRow>(
    (from, to) =>
      supabase
        .from("game_player_stats")
        .select("pcode, tcode, pts, fga, tpa, fta, games!inner(season_name)", { count: "exact" })
        .eq("games.season_name", seasonName)
        .range(from, to) as unknown as PromiseLike<{ data: BoxRow[] | null; error: unknown; count: number | null }>
  );

  const boxByPcode = new Map<string, BoxAgg>();
  // 대표 팀 = 이 시즌 이 선수가 game_player_stats에 가장 많이 등장한 tcode(formIndex.ts의
  // tcodeByPcode와 동일한 mode(tcode) 로직 - 트레이드로 시즌 중 팀이 바뀐 선수도 하나로 귀속).
  const tcodeCounts = new Map<string, Map<string, number>>();
  for (const r of boxRows) {
    const agg = boxByPcode.get(r.pcode) ?? { pts: 0, fga: 0, fta: 0 };
    agg.pts += r.pts ?? 0;
    agg.fga += (r.fga ?? 0) + (r.tpa ?? 0);
    agg.fta += r.fta ?? 0;
    boxByPcode.set(r.pcode, agg);

    const byT = tcodeCounts.get(r.pcode) ?? new Map<string, number>();
    byT.set(r.tcode, (byT.get(r.tcode) ?? 0) + 1);
    tcodeCounts.set(r.pcode, byT);
  }

  type ShotRow = { pcode: string; x: number; y: number; d: string };
  const shotRows = await fetchAllPagesBounded<ShotRow>(
    (from, to) =>
      supabase
        .from("shot_log")
        .select("pcode, x, y, d, games!inner(season_name)", { count: "exact" })
        .eq("games.season_name", seasonName)
        .range(from, to) as unknown as PromiseLike<{ data: ShotRow[] | null; error: unknown; count: number | null }>
  );

  const rimByPcode = new Map<string, number>();
  const threeByPcode = new Map<string, number>();
  for (const s of shotRows) {
    const { zone } = classifyShot(s.x, s.y, s.d);
    if (zone === "rim") rimByPcode.set(s.pcode, (rimByPcode.get(s.pcode) ?? 0) + 1);
    else if (zone === "three") threeByPcode.set(s.pcode, (threeByPcode.get(s.pcode) ?? 0) + 1);
  }

  const pcodes = Array.from(boxByPcode.keys());
  if (!pcodes.length) return { season: seasonName, players: [], avgPsa: 0, avgMoreyPct: 0, tsaMin: 0, tsaMax: 0 };

  const [{ data: players }, { data: teams }] = await Promise.all([
    supabase.from("players").select("pcode, name").in("pcode", pcodes),
    supabase.from("teams").select("tcode, abbr, color"),
  ]);
  const nameByPcode = new Map((players ?? []).map((p) => [p.pcode as string, p.name as string]));
  const teamByTcode = new Map((teams ?? []).map((t) => [t.tcode as string, t as { abbr: string; color: string }]));

  const rows: ScatterPlayerRow[] = [];
  for (const pcode of pcodes) {
    const box = boxByPcode.get(pcode)!;
    const tsa = computeTSA(box.fga, box.fta);
    // 표본 컷오프 - scoringExplorer.ts의 MIN_SAMPLE(30)을 그대로 재사용(spec 지침). 원본
    // 레퍼런스 디자인의 버블 범례 최소값(200회)보다 훨씬 낮은 문턱인데, 저건 "범례 눈금
    // 간격"이지 이 컷오프처럼 "노이즈성 극소표본 제외" 목적이 아니라서 그대로 둠 - MIN_SAMPLE은
    // 정말 몇 경기 안 뛴 선수만 걸러내고, 실제로 표시되는 로테이션 선수 풀의 TSA는 대부분
    // 이보다 훨씬 큼.
    if (tsa < MIN_SAMPLE) continue;
    const psa = computePSA(box.pts, tsa);
    const rimFga = rimByPcode.get(pcode) ?? 0;
    const threeFga = threeByPcode.get(pcode) ?? 0;
    const moreyPct = computeMoreyPct(rimFga, threeFga, box.fta, tsa);
    if (psa == null || moreyPct == null) continue;

    let tcode = "";
    const byT = tcodeCounts.get(pcode);
    if (byT) {
      let best = -1;
      for (const [tc, count] of byT) {
        if (count > best) {
          best = count;
          tcode = tc;
        }
      }
    }
    const team = teamByTcode.get(tcode);

    rows.push({
      pcode,
      name: nameByPcode.get(pcode) ?? pcode,
      tcode,
      teamAbbr: team?.abbr ?? tcode,
      teamColor: team?.color ?? "#888888",
      tsa,
      psa,
      moreyPct,
    });
  }

  // 평균선(가로=PSA, 세로=Morey rate) - 이 필터링된 선수 풀 각자의 값을 단순 평균(리그 전체
  // 슛 합산 가중평균이 아니라 "차트에 찍힌 점들의 평균")한 값. 산점도 위에 그리는 기준선은
  // 화면에 보이는 점들의 분포 중심을 나타내는 게 목적이라, 슛을 더 많이 던진 선수에게 가중치를
  // 더 주는 리그 합산 평균보다 이 편이 차트 해석과 맞아떨어짐.
  const n = rows.length;
  const avgPsa = n ? rows.reduce((s, r) => s + r.psa, 0) / n : 0;
  const avgMoreyPct = n ? rows.reduce((s, r) => s + r.moreyPct, 0) / n : 0;
  const tsaMin = n ? Math.min(...rows.map((r) => r.tsa)) : 0;
  const tsaMax = n ? Math.max(...rows.map((r) => r.tsa)) : 0;

  return { season: seasonName, players: rows, avgPsa, avgMoreyPct, tsaMin, tsaMax };
}

// 버블 반지름 - 넓이가 TSA에 비례하도록 sqrt 스케일(단순 선형 반지름 스케일은 큰 표본 버블이
// 실제 값 차이보다 훨씬 커 보이는 착시를 만듦 - 버블차트의 표준 관례).
export const SCATTER_R_MIN = 3;
export const SCATTER_R_MAX = 14;
export function scatterBubbleRadius(tsa: number, tsaMin: number, tsaMax: number): number {
  if (tsaMax <= tsaMin) return (SCATTER_R_MIN + SCATTER_R_MAX) / 2;
  const t = Math.max(0, Math.min(1, (tsa - tsaMin) / (tsaMax - tsaMin)));
  return SCATTER_R_MIN + Math.sqrt(t) * (SCATTER_R_MAX - SCATTER_R_MIN);
}

// 사분면 티어 - globals.css의 기존 시맨틱 토큰만 재사용(새 팔레트 발명 안 함): 둘 다 평균 이상
// = --positive(가장 좋음), 둘 다 평균 이하 = --negative(가장 나쁨), 나머지 두 "혼합" 조합은
// --gold(슛선택은 나쁜데 넣긴 잘 넣음)/--away(슛선택은 좋은데 효율이 낮음)로 구분.
export type ScatterTier = "both" | "moreyOnly" | "psaOnly" | "neither";
export function scatterTier(p: ScatterPlayerRow, avgMoreyPct: number, avgPsa: number): ScatterTier {
  const goodMorey = p.moreyPct >= avgMoreyPct;
  const goodPsa = p.psa >= avgPsa;
  if (goodMorey && goodPsa) return "both";
  if (!goodMorey && !goodPsa) return "neither";
  return goodPsa ? "psaOnly" : "moreyOnly";
}
export const SCATTER_TIER_COLOR: Record<ScatterTier, string> = {
  both: "var(--positive)",
  neither: "var(--negative)",
  psaOnly: "var(--gold)",
  moreyOnly: "var(--away)",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function niceTicks(min: number, max: number, step: number): number[] {
  const ticks: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

const W = 720,
  H = 480,
  PAD_L = 56,
  PAD_R = 20,
  PAD_T = 20,
  PAD_B = 46;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;
export const SCATTER_VIEWBOX = `0 0 ${W} ${H}`;

// 점 하나하나가 선수 프로필로 연결되는 이 사이트 첫 산점도라(다른 build*Svg는 링크가 없는
// 코트/막대 차트) 다른 곳처럼 <Link>가 아니라 순수 <a href>를 씀 - JSX <Link>는 문자열 템플릿
// 안에 넣을 수 없고, 이 파일의 나머지 차트 함수들(scoringExplorer.ts/zoneCompare.ts)이 전부
// "문자열을 만들어 dangerouslySetInnerHTML로 꽂는" 이 사이트 관례를 따르는 편이 시각적 일관성이
// 더 중요하다고 판단(클릭 시 이동하는 실제 동작은 동일 - App Router는 일반 <a>로도 정상 이동).
//
// 라벨 충돌 처리 - 풀 시즌 로테이션 선수(60~150명 이상) 전원에게 이름을 다 박으면 겹쳐서
// 못 읽으므로: (a) 평균점(avgMoreyPct,avgPsa)에서 정규화 거리가 먼 "튀는" 선수 상위권 +
// (b) TSA(표본량) 최상위 선수는 항상 강제 포함(가장 많이 쏜 선수는 항상 기준점으로 보여야
// 유용) 만 라벨 텍스트를 그리고, 나머지는 옅은 점 + 마우스오버 <title>(buildHeatmapSvg가 이미
// 쓰는 툴팁 관례)로 대체.
const LABEL_BASE = 14;
const LABEL_RATIO = 0.16;
const FORCE_VOLUME_LABELS = 6;

export function buildShotValueScatterSvg(data: ShotValueScatterData): string {
  const { players, avgPsa, avgMoreyPct, tsaMin, tsaMax } = data;
  if (!players.length) return "";

  const dataMinX = Math.min(...players.map((p) => p.moreyPct));
  const dataMaxX = Math.max(...players.map((p) => p.moreyPct));
  const dataMinY = Math.min(...players.map((p) => p.psa));
  const dataMaxY = Math.max(...players.map((p) => p.psa));
  // 기본 축 범위는 레퍼런스 디자인(Morey 40~100%, PSA 0.8~1.6)을 따르되, 실데이터가 그
  // 범위를 벗어나면(자유투를 아주 많이 얻어내는 빅맨은 MOREY%가 100%를 넘을 수 있음 - FTA를
  // 트립 프록시로 쓰는 근사의 알려진 특성, shotImpactChart.ts computeMoreyPct 주석 참고) 점이
  // 캔버스 밖으로 잘리지 않게 자동으로 넓힘.
  const xMin = Math.min(0.4, dataMinX - 0.03);
  const xMax = Math.max(1.0, dataMaxX + 0.03);
  const yMin = Math.min(0.8, dataMinY - 0.05);
  const yMax = Math.max(1.6, dataMaxY + 0.05);

  const xPix = (v: number) => PAD_L + ((v - xMin) / (xMax - xMin)) * PLOT_W;
  const yPix = (v: number) => PAD_T + PLOT_H - ((v - yMin) / (yMax - yMin)) * PLOT_H;

  let svg = "";

  // 그리드 + 축 눈금 - .foot 등 이 사이트가 쓰는 옅은 회색조(var(--ink-faint), 이미 알파
  // 포함된 토큰)를 그대로.
  svg += `<rect x="${PAD_L}" y="${PAD_T}" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="var(--ink-faint)" stroke-width="1"/>`;
  const xStep = xMax - xMin > 0.4 ? 0.2 : 0.1;
  for (const t of niceTicks(xMin, xMax, xStep)) {
    const x = xPix(t);
    svg += `<line x1="${x.toFixed(1)}" y1="${PAD_T}" x2="${x.toFixed(1)}" y2="${PAD_T + PLOT_H}" stroke="var(--ink-faint)" stroke-width="0.6" opacity="0.5"/>`;
    svg += `<text x="${x.toFixed(1)}" y="${PAD_T + PLOT_H + 16}" text-anchor="middle" font-size="9.5" fill="var(--ink-soft)" font-family="IBM Plex Mono, monospace">${Math.round(t * 100)}%</text>`;
  }
  const yStep = yMax - yMin > 1.0 ? 0.2 : 0.1;
  for (const t of niceTicks(yMin, yMax, yStep)) {
    const y = yPix(t);
    svg += `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${PAD_L + PLOT_W}" y2="${y.toFixed(1)}" stroke="var(--ink-faint)" stroke-width="0.6" opacity="0.5"/>`;
    svg += `<text x="${PAD_L - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--ink-soft)" font-family="IBM Plex Mono, monospace">${t.toFixed(2)}</text>`;
  }

  // 축 제목
  svg += `<text x="${PAD_L + PLOT_W / 2}" y="${H - 6}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--ink-soft)" font-family="Pretendard, sans-serif">Morey Rate</text>`;
  svg += `<text x="${14}" y="${PAD_T + PLOT_H / 2}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--ink-soft)" font-family="Pretendard, sans-serif" transform="rotate(-90 14 ${PAD_T + PLOT_H / 2})">Points Per True Shot Attempt</text>`;

  // 평균 기준선(가로=PSA, 세로=Morey rate) - 골드 대시, PerfChart(선수 프로필 페이지)가
  // 보조 지표 오버레이 라인에 이미 쓰는 것과 같은 톤.
  if (avgMoreyPct >= xMin && avgMoreyPct <= xMax) {
    const ax = xPix(avgMoreyPct);
    svg += `<line x1="${ax.toFixed(1)}" y1="${PAD_T}" x2="${ax.toFixed(1)}" y2="${PAD_T + PLOT_H}" stroke="var(--gold)" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.85"/>`;
    svg += `<text x="${ax.toFixed(1)}" y="${PAD_T - 6}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--gold)" font-family="IBM Plex Mono, monospace">평균 Morey Rate ${Math.round(avgMoreyPct * 100)}%</text>`;
  }
  if (avgPsa >= yMin && avgPsa <= yMax) {
    const ay = yPix(avgPsa);
    svg += `<line x1="${PAD_L}" y1="${ay.toFixed(1)}" x2="${PAD_L + PLOT_W}" y2="${ay.toFixed(1)}" stroke="var(--gold)" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.85"/>`;
    svg += `<text x="${PAD_L + PLOT_W - 4}" y="${(ay - 5).toFixed(1)}" text-anchor="end" font-size="10" font-weight="700" fill="var(--gold)" font-family="IBM Plex Mono, monospace">평균 PSA ${avgPsa.toFixed(2)}</text>`;
  }

  // 라벨 대상 선정 - "평균에서 정규화 거리가 먼" 순 + TSA 최상위 강제 포함.
  const dists = players.map((p) => {
    const nx = (p.moreyPct - avgMoreyPct) / (xMax - xMin);
    const ny = (p.psa - avgPsa) / (yMax - yMin);
    return { pcode: p.pcode, dist: Math.hypot(nx, ny) };
  });
  dists.sort((a, b) => b.dist - a.dist);
  const labelCount = Math.min(players.length, Math.max(LABEL_BASE, Math.round(players.length * LABEL_RATIO)));
  const labelSet = new Set(dists.slice(0, labelCount).map((d) => d.pcode));
  players
    .slice()
    .sort((a, b) => b.tsa - a.tsa)
    .slice(0, FORCE_VOLUME_LABELS)
    .forEach((p) => labelSet.add(p.pcode));

  // 점(선수) - TSA 큰 것부터 그려야 작은 점이 큰 버블에 완전히 묻히지 않고 위에 겹쳐 보임.
  const ordered = players.slice().sort((a, b) => b.tsa - a.tsa);
  for (const p of ordered) {
    const cx = xPix(p.moreyPct);
    const cy = yPix(p.psa);
    const r = scatterBubbleRadius(p.tsa, tsaMin, tsaMax);
    const color = SCATTER_TIER_COLOR[scatterTier(p, avgMoreyPct, avgPsa)];
    const title = `${esc(p.name)} (${esc(p.teamAbbr)}) · PSA ${p.psa.toFixed(2)} · Morey ${Math.round(p.moreyPct * 100)}% · TSA ${Math.round(p.tsa)}`;

    svg += `<a href="/players/${encodeURIComponent(p.pcode)}">`;
    svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="0.78" stroke="var(--surface)" stroke-width="1"><title>${title}</title></circle>`;

    if (labelSet.has(p.pcode)) {
      const above = cy - r - 6 > PAD_T + 8;
      const ly = above ? cy - r - 5 : cy + r + 11;
      const lx = Math.min(Math.max(cx, PAD_L + 26), PAD_L + PLOT_W - 26);
      svg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="9" font-weight="600" fill="var(--ink)" font-family="Pretendard, sans-serif" paint-order="stroke" stroke="var(--surface)" stroke-width="3" stroke-linejoin="round">${esc(p.name)}</text>`;
    }
    svg += `</a>`;
  }

  return svg;
}
