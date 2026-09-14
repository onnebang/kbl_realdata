import { supabaseServer as supabase } from "./supabaseServer";
import { cachedFn, TTL, TAG } from "./cachePolicy";
import { classifyShot } from "./formIndex";
import { computeTSA, computePSA, computeMoreyPct } from "./shotImpactChart";
import { fetchAllPagesBounded, MIN_SAMPLE } from "./scoringExplorer";
import { getLeaderboardSeasons } from "./seasonLeaders";

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

/**
 * 예전엔 seasons 테이블 전체(getSeasonsWithShots)를 줘서 맨 앞이 개막 전 2026-27이었고, 기본 진입이
 * "표본 기준을 충족하는 선수가 없음" 빈 화면이었다(2026-09-15 확인). 정규시즌 경기가 끝난 시즌만.
 */
export async function getSeasonsForScatter(): Promise<string[]> {
  return getLeaderboardSeasons();
}

type BoxAgg = { pts: number; fga: number; fta: number };

// game_player_stats.fga/fgm은 2점 시도만이고 3점은 tpa/tpm에 별도(shotImpactChart.ts에서
// 실측 확정된 이 프로젝트 스키마 관례) - TSA/MOREY%가 요구하는 "총 FGA"는 fga+tpa.
async function computeShotValueScatterData(seasonName: string): Promise<ShotValueScatterData> {
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

// ── 글자: 뷰박스 단위가 아니라 '렌더 픽셀'을 맞춘다 ────────────────────────────────
// .scatterSvg는 width:100%이고 지면 폭 = 뷰포트 − 74(.wrap 좌우 36 + .panel 테두리·패딩 38)라
// 렌더 배율 = (뷰포트 − 74)/720이다. 데스크톱(1108px)은 1.54, 375px 모바일은 0.42 - 3.7배
// 차이라 font-size 한 값으로 양쪽을 만족시킬 수 없다(예전 9.5단위 = 데스크톱 14.6px·모바일
// 4.0px). seasonRibbon.ts와 같은 수법으로 SVG 안 <style>에서 뷰포트 폭 구간마다 글자를 갈아
// 끼운다(SVG에서 CSS px = 사용자 단위). 각 구간 하단의 렌더 픽셀: 1000px→12.9 / 800px→12.1 /
// 620px→12.1 / 480px→12.4 / 401px→14.1 / 320px→12.3. 마지막 ≤400px 구간(36단위)이 iPhone SE
// 1세대(320px)를 위한 것 - 31단위로는 (246/720)×31 = 10.6px, 36단위면 12.3px.
// 한글이 섞이는 라벨(평균 …·선수 이름)이 있어 스택 뒤에 Pretendard를 둔다 - IBM Plex Mono에는
// 한글 글리프가 없다. 이름표·세로축 제목은 아예 Pretendard(.svsN).
// 글자가 3.3배가 되면 라벨은 반드시 부딪히므로 크기를 되돌리는 대신 라벨 수를 줄인다:
// 선수 이름표와 세로축 제목(27자 = 좁은 화면에서 519단위 > 플롯 높이 414)은 .svsW로 넓은 화면
// 전용(좁은 화면은 점 + 툴팁 + 호출부 캡션), 축 눈금은 32단위 폭으로 재서 두 개 중 하나만 남긴다.
const SVS_FS_MAX = 36; // 가장 좁은 구간의 글자. 겹침 검사는 언제나 이 최댓값으로 한다.
const SVS_STYLE =
  `<style>.svs{font-family:"IBM Plex Mono","Pretendard",monospace;font-size:10px}` +
  `.svsN{font-family:"Pretendard",sans-serif}` +
  `@media(max-width:999px){.svs{font-size:12px}.svsW{display:none}}` +
  `@media(max-width:799px){.svs{font-size:16px}}` +
  `@media(max-width:619px){.svs{font-size:22px}}` +
  `@media(max-width:479px){.svs{font-size:31px}}` +
  `@media(max-width:400px){.svs{font-size:36px}}</style>`;
const SVS_HALO = `paint-order="stroke" stroke="var(--surface)" stroke-width="3" stroke-linejoin="round"`;

/** 대략 폭 - 한글 글리프 1em, 라틴·숫자 0.62em(careerStrip.ts/seasonRibbon.ts와 같은 근사). */
function svsTextW(s: string, fs: number = SVS_FS_MAX): number {
  return [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 127 ? 1 : 0.62) * fs, 0);
}

// 여백은 '가장 큰 글자'가 기준이다(≤400px 구간의 36단위): 세로 눈금 "1.20"이 89.3단위 + 축까지
// 10 + 여백 2라 PAD_L 56 → 88 → 102, 가로 끝 눈금 "100%"가 반폭 44.6단위라 PAD_R 20 → 40 → 46,
// 가로 눈금 + 축 제목 두 줄이 각각 36단위라 PAD_B 46 → 76(눈금 아래끝 485 · 제목 위끝 493),
// 평균선 라벨(한글 포함 - 베이스라인 위로 0.8em = 28.8)이 플롯 위 PAD_T-8에 앉아 PAD_T 20 → 34
// → 40. H를 480 → 524 → 530으로 늘려 플롯 높이 414는 그대로 둔다.
const W = 720,
  H = 530,
  PAD_L = 102,
  PAD_R = 46,
  PAD_T = 40,
  PAD_B = 76;
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

  let svg = SVS_STYLE;

  // 그리드 + 축 눈금 - .foot 등 이 사이트가 쓰는 옅은 회색조(var(--ink-faint), 이미 알파
  // 포함된 토큰)를 그대로. 격자선은 전부 남기고 '라벨만' 솎는다: 가장 큰 글자(31단위)로 잰
  // 폭이 눈금 간격을 넘으면 두 개 중 하나만 그린다.
  svg += `<rect x="${PAD_L}" y="${PAD_T}" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="var(--ink-faint)" stroke-width="1"/>`;
  const xStep = xMax - xMin > 0.4 ? 0.2 : 0.1;
  const xTicks = niceTicks(xMin, xMax, xStep);
  const xEvery = xTicks.length > 1 && Math.abs(xPix(xTicks[1]) - xPix(xTicks[0])) < svsTextW("100%") + 8 ? 2 : 1;
  xTicks.forEach((t, i) => {
    const x = xPix(t);
    svg += `<line x1="${x.toFixed(1)}" y1="${PAD_T}" x2="${x.toFixed(1)}" y2="${PAD_T + PLOT_H}" stroke="var(--ink-faint)" stroke-width="0.6" opacity="0.5"/>`;
    if (i % xEvery) return;
    svg += `<text x="${x.toFixed(1)}" y="${PAD_T + PLOT_H + 24}" text-anchor="middle" class="svs" fill="var(--ink-soft)">${Math.round(t * 100)}%</text>`;
  });
  const yStep = yMax - yMin > 1.0 ? 0.2 : 0.1;
  const yTicks = niceTicks(yMin, yMax, yStep);
  const yEvery = yTicks.length > 1 && Math.abs(yPix(yTicks[1]) - yPix(yTicks[0])) < SVS_FS_MAX + 4 ? 2 : 1;
  yTicks.forEach((t, i) => {
    const y = yPix(t);
    svg += `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${PAD_L + PLOT_W}" y2="${y.toFixed(1)}" stroke="var(--ink-faint)" stroke-width="0.6" opacity="0.5"/>`;
    if (i % yEvery) return;
    svg += `<text x="${PAD_L - 10}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="svs" fill="var(--ink-soft)">${t.toFixed(2)}</text>`;
  });

  // 축 제목 - 세로 제목은 27자라 좁은 화면(31단위 = 519단위)에서 플롯 높이(414)를 넘는다.
  // 넓은 화면 전용으로 두고, 좁은 화면에서는 호출부 소제목("세로축은 PSA(시도 하나당 실제
  // 득점)")이 같은 사실을 진다.
  svg += `<text x="${PAD_L + PLOT_W / 2}" y="${H - 8}" text-anchor="middle" class="svs svsN" font-weight="700" fill="var(--ink-soft)">Morey Rate</text>`;
  svg += `<text x="26" y="${PAD_T + PLOT_H / 2}" text-anchor="middle" class="svs svsN svsW" font-weight="700" fill="var(--ink-soft)" transform="rotate(-90 26 ${PAD_T + PLOT_H / 2})">Points Per True Shot Attempt</text>`;

  // 평균 기준선(가로=PSA, 세로=Morey rate) - 골드 대시. 이 사이트에서 "기준선"은 항상 골드
  // 대시다(커리어 결 띠의 이동평균, 시즌 리본의 누적 승수와 같은 톤).
  // 두 라벨은 헤드라인 숫자라 좁은 화면에서도 남긴다 - 대신 31단위 반폭만큼은 캔버스 안으로
  // 밀어 넣고(세로 평균선 라벨), 데이터 위에 얹히므로 후광을 두른다.
  if (avgMoreyPct >= xMin && avgMoreyPct <= xMax) {
    const ax = xPix(avgMoreyPct);
    const lab = `평균 Morey Rate ${Math.round(avgMoreyPct * 100)}%`;
    const half = svsTextW(lab) / 2;
    const tx = Math.min(Math.max(ax, half + 2), W - half - 2);
    svg += `<line x1="${ax.toFixed(1)}" y1="${PAD_T}" x2="${ax.toFixed(1)}" y2="${PAD_T + PLOT_H}" stroke="var(--gold)" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.85"/>`;
    svg += `<text x="${tx.toFixed(1)}" y="${PAD_T - 8}" text-anchor="middle" class="svs" font-weight="700" fill="var(--gold)" ${SVS_HALO}>${lab}</text>`;
  }
  if (avgPsa >= yMin && avgPsa <= yMax) {
    const ay = yPix(avgPsa);
    svg += `<line x1="${PAD_L}" y1="${ay.toFixed(1)}" x2="${PAD_L + PLOT_W}" y2="${ay.toFixed(1)}" stroke="var(--gold)" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.85"/>`;
    svg += `<text x="${PAD_L + PLOT_W - 4}" y="${(ay - 6).toFixed(1)}" text-anchor="end" class="svs" font-weight="700" fill="var(--gold)" ${SVS_HALO}>평균 PSA ${avgPsa.toFixed(2)}</text>`;
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
  // 이름표도 이 순서로 자리를 잡아(표본 큰 선수 우선) 앞서 놓인 이름표와 겹치면 건너뛴다
  // (careerStrip.ts의 lastLabelEnd 패턴을 2차원으로 - 겹치면 크기가 아니라 개수를 줄인다).
  const ordered = players.slice().sort((a, b) => b.tsa - a.tsa);
  const placed: [number, number, number, number][] = [];
  for (const p of ordered) {
    const cx = xPix(p.moreyPct);
    const cy = yPix(p.psa);
    const r = scatterBubbleRadius(p.tsa, tsaMin, tsaMax);
    const color = SCATTER_TIER_COLOR[scatterTier(p, avgMoreyPct, avgPsa)];
    const title = `${esc(p.name)} (${esc(p.teamAbbr)}) · PSA ${p.psa.toFixed(2)} · Morey ${Math.round(p.moreyPct * 100)}% · TSA ${Math.round(p.tsa)}`;

    svg += `<a href="/players/${encodeURIComponent(p.pcode)}">`;
    svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="0.78" stroke="var(--surface)" stroke-width="1"><title>${title}</title></circle>`;

    // 이름표는 넓은 화면(10단위 = 12.9px) 전용 - 좁은 화면은 300px 폭에 3글자 이름 14개를
    // 12px로 놓을 자리 자체가 없다(툴팁 + 호출부 캡션이 그 몫을 진다). 겹침 검사도 10단위로.
    if (labelSet.has(p.pcode)) {
      const w = svsTextW(p.name, 10);
      const above = cy - r - 6 > PAD_T + 8;
      const ly = above ? cy - r - 5 : cy + r + 11;
      const lx = Math.min(Math.max(cx, PAD_L + w / 2), PAD_L + PLOT_W - w / 2);
      const box: [number, number, number, number] = [lx - w / 2 - 2, ly - 10, lx + w / 2 + 2, ly + 3];
      if (!placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) {
        placed.push(box);
        svg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" class="svs svsN svsW" font-weight="600" fill="var(--ink)" ${SVS_HALO}>${esc(p.name)}</text>`;
      }
    }
    svg += `</a>`;
  }

  return svg;
}

/**
 * 시즌 하나의 슛 가치 산점도. 시즌 전체 game_player_stats + shot_log를 통째로 받아 JS에서 뭉치는
 * 함수라(약 4.3만 행, 왕복 44회) 요청마다 다시 하면 안 된다 - 종료된 시즌 값은 불변이다.
 * 반환 ShotValueScatterData는 숫자·문자열·배열뿐이라 직렬화가 안전하다.
 */
export const getShotValueScatterData = cachedFn(computeShotValueScatterData, {
  name: "shotValueScatter",
  ttl: TTL.batchDaily,
  tags: (season) => [TAG.batch, TAG.season(String(season))],
});
