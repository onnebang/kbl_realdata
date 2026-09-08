import { accentFor } from "./teamAccent";
import { shortSeason } from "./preseason";
import { careerMovingAverage, MOVING_AVERAGE_WINDOW, type CareerGrain, type CareerNight } from "./careerGrain";

// 커리어 결 띠(career grain strip) - raw SVG 문자열 빌더. 히어로 발치에 커리어 전체를 가로 띠
// 하나로 그린다. 칸 하나 = 하룻밤, 왼쪽부터 날짜순. 높이 = 그날 득점, 색 = 그날의 소속팀
// (이적하면 띠 중간에서 색이 바뀐다 - 별도 코드 없이 데이터가 그렇게 만든다).
// 데이터 정의는 전부 lib/careerGrain.ts에 있고 이 파일은 "그리기"만 한다.
//
// lib/seasonRibbon.ts와 같은 규약:
//   - JSX가 아니라 문자열(React 19가 JSX <svg> 안의 JSX <title>을 <head>로 끌어올려 툴팁이
//     사라진다. raw 문자열 안의 <title>은 안전하고, 이 저장소의 확립된 툴팁 패턴이다).
//   - 조각(fragment)을 돌려준다. 페이지가 <svg viewBox={r.viewBox} dangerouslySetInnerHTML>로 감싼다.
//   - 클라이언트 JS 0. 상호작용은 <a> 링크와 CSS :hover/:focus-visible뿐.
//
// ── 이 파일이 내리는 그림 결정 4가지(전부 실측 근거) ───────────────────────────────────
// (1) 결장(빈칸)과 0점 출전을 반대 방향으로 그린다.
//     0점 출전 = 기준선 '위' 팀 색 바닥 눈금 / 결장 = 기준선 '아래' 회색 눈금.
//     두 사실이 같은 모양이면 안 된다. 실제로 조은후(291499)는 119출전 중 33밤이 0분이라
//     '높이 0'인 칸이 1/3이다 - 방향과 색이 다르지 않으면 그 3분의 1이 전부 결장으로 읽힌다.
// (2) 칸 폭에 따라 상호작용의 결이 바뀐다(detail 모드).
//     칸이 4.5 단위 이상이면 칸마다 <a href="/games/..."> + <title>(경기 단위).
//     그 아래로 내려가면 1.6px 칸은 애초에 포인터로 집을 수 없으므로 시즌 단위 히트존
//     (<a href="/players/{pcode}?season=...">)으로 바꾼다. 칸당 바이트도 여기서 갈린다
//     (실측, 해먼즈 291698 히어로: 경기 단위 ~248B/칸 = 링크·툴팁 159B + 히트존 rect 90B,
//     시즌 단위 ~26B/칸 - 설계 문서의 56B/칸 예산은 후자에서만 성립).
//     recentN으로 자른 §9 패널은 자연히 경기 단위가 되므로 "띠는 질감, 패널은 개별 경기"가 된다.
// (3) 칸이 상한(9)에 닿는 짧은 커리어는 축 라벨을 연도 → 월로 바꾸고 이동평균 창을 15 → 5로
//     줄인다. 35경기짜리 커리어에 15경기 이동평균을 그리면 선이 커리어의 3분의 1을 잡아먹는다.
//     캡션이 그때그때 실제 창 수를 적는다(고정 문구로 15를 박지 않는다).
// (4) 이적 지점에는 색 변화 위에 작은 ◆를 얹는다. 실측(해먼즈 291698: 수원 KT → 울산 현대모비스)
//     처럼 이적이 시즌 경계와 같은 픽셀에 떨어질 수 있어서, 시즌 헤어라인만으로는 "색이 바뀌었다"가
//     경계선에 묻힌다.
// (5) 글자 크기는 상수가 아니라 **뷰포트 구간마다 다른 값**이다(CareerStripFit / fitBands).
//     같은 9단위가 히어로 띠에서 621px에 5.95px·1180px에 9px로 그려진다 - 배율이 3배 가까이
//     달라지므로 한 값으로는 "어디서나 12px 이상"을 만족시킬 수 없다. lib/seasonRibbon.ts가
//     먼저 쓴 수법(SVG 안 <style> + 미디어쿼리)을 그대로 쓴다.
//
// 정직성: 빈칸은 '등록 기간 안에서 그의 팀이 뛴 날, 그가 뛰지 않았다'까지만 뜻한다. 원인은 이 DB에
// 없으므로 화면 문구는 '결장'까지만 - '부상'은 어디에도 쓰지 않는다.

export type CareerStripTone = "hero" | "surface";

export type CareerStripOptions = {
  /** SVG 내부 id·클래스 충돌 방지(한 페이지에 띠가 둘 이상 뜬다 - 히어로 발치 + §9 패널). */
  uid: string;
  /** tcode -> teams.color 원본. 색은 accentFor로 통과시킨다(KT #1A1A1A는 검은 히어로에서 사라진다). */
  teamColors: Map<string, string | null | undefined>;
  /** tcode -> 약어(툴팁용). 없으면 tcode를 그대로 쓴다. */
  teamAbbrs?: Map<string, string>;
  /** 요청 폭(뷰박스 단위). 칸이 최소 폭에 걸리면 결과 폭이 이보다 넓어진다(result.width 확인). */
  width?: number;
  height?: number;
  /** 마지막 N밤만(§9 패널 - 같은 문법의 확대판). 이동평균의 앞부분은 잘리기 전 이력으로 채운다. */
  recentN?: number;
  /** 히어로(딥다크 위) = 흰 계열 잉크 / 표면 패널 = 테마 토큰. 기본 hero. */
  tone?: CareerStripTone;
  /** 상호작용 단위. auto = 칸 폭으로 결정(기본). */
  detail?: "auto" | "cell" | "season";
  /** 시즌 히트존을 링크로 만들지(기본 true - /players/{pcode}?season=은 페이지가 이미 받는 쿼리). */
  seasonLinks?: boolean;
  /**
   * 그릴 구간 [start, end) - grain.nights 인덱스. recentN보다 우선한다.
   * 모바일에서 띠를 시즌별 행으로 접을 때(buildCareerStripRowsSvg) 쓴다.
   */
  range?: { start: number; end: number };
  /**
   * 이 SVG가 화면에서 실제로 어떻게 그려지는지(CSS 높이·가로 크롬·보이는 뷰포트 범위).
   * 빌더는 W와 뷰박스 높이를 알지만 배율의 나머지 절반(CSS 상자)은 호출부만 안다 - 받아서
   * 뷰포트 구간마다 정확한 font-size를 계산해 SVG 안 <style>에 박는다.
   */
  fit: CareerStripFit;
  /**
   * 칸 위에 그날 득점을, 이동평균선 끝에 창 평균을 적는다. 칸 폭 7단위 이상·칸 40개 이하일 때만
   * 실제로 찍힌다(그보다 촘촘하면 숫자가 서로를 덮는다). 확대판(L5~L30) 전용.
   */
  valueLabels?: boolean;
  /** 캡션 머리말 덮어쓰기 - 행 모드가 "21-22 시즌 54경기"처럼 시즌을 적는 데 쓴다. */
  captionHead?: string;
  /**
   * §10 공백 시즌 표식(두 줄: 시즌 · '기록 없음')을 띠 안에 그릴지. 기본 true.
   * 행 모드는 false다 - 12px을 지키면 그 두 줄이 56px 행의 절반을 덮는데(320px 실측),
   * 같은 사실을 행 묶음 바로 아래 note가 이미 문장으로 인쇄한다("공백 시즌 24-25·25-26(기록 없음)").
   * 사실을 지우는 게 아니라 같은 사실의 중복을 지우는 것이다.
   */
  gapMarkers?: boolean;
};

export type CareerStripResult = {
  /** <svg> 안에 넣을 조각. 바깥 <svg>는 페이지가 쓴다. */
  svg: string;
  /** value + sample + basis를 한 줄로(요구된 고정 문형). */
  caption: string;
  /** 실제로 그린 칸 수(recentN으로 잘렸으면 잘린 수). */
  cells: number;
  /** svg의 UTF-8 바이트 수(예산 감시용). */
  bytes: number;
  viewBox: string;
  width: number;
  height: number;
  /** 실제 칸 폭(뷰박스 단위) - 호출부가 컨테이너 폭을 정할 때 쓴다. */
  cellWidth: number;
  /** 실제로 그린 이동평균 창(15 또는 5). 선을 못 그렸으면 0. */
  maWindow: number;
  /** 상호작용 단위 - 'cell'이면 칸마다 경기 링크, 'season'이면 시즌 히트존. */
  mode: "cell" | "season";
  /** 축 라벨이 월 단위인가(짧은 커리어). */
  compact: boolean;
  /** 캡션에 담지 못한 나머지 사실(결장·0분·잘라낸 가짜 결장). 호출부가 원하면 덧붙인다. */
  note: string;
};

export const STRIP_DEFAULT_WIDTH = 760;
export const STRIP_DEFAULT_HEIGHT = 92;
/** 짧은 커리어(칸이 상한에 닿음)에서 쓰는 이동평균 창. */
export const STRIP_COMPACT_MA_WINDOW = 5;
/** 칸 폭 하한·상한(뷰박스 단위). 하한에 걸리면 띠가 요청 폭보다 넓어진다. */
export const CELL_MIN_W = 1.6;
export const CELL_MAX_W = 9;
/** 이보다 좁은 칸은 포인터로 집을 수 없다 - 경기 링크 대신 시즌 히트존으로 바꾸는 경계. */
export const DETAIL_MIN_CELL_W = 4.5;

const PAD_L = 3;
const PAD_R = 3;
const PAD_T = 13; // 연/월 라벨 줄
const PAD_B = 12; // 기준선 아래(결장 레일 + 플레이오프 레일)
/**
 * 커리어 끝에 붙는 공백 시즌 표식이 쓸 오른쪽 여백.
 * 공개하는 이유: §9 패널처럼 "칸 폭이 상한에 딱 맞는" 폭을 요청하는 호출부는 빌더가 얼마를 미리
 * 빼는지 알아야 한다. 숫자를 호출부에 복사해 두면 여기만 바뀌었을 때 조용히 어긋난다.
 */
export const GAP_RESERVE = 68;

// ── 뷰포트 구간별 글자(lib/seasonRibbon.ts RB_STYLE과 같은 수법) ─────────────────────
// 렌더 픽셀 = font-size(뷰박스 단위) × 배율, 배율 = min(렌더폭/W, CSS높이/뷰박스높이)(meet).
// 이 배율이 뷰포트마다 3배 가까이 달라지므로(히어로 띠 621px 0.66 → 1180px 1.0) 크기 상수
// 하나로는 "어디서나 12px 이상"을 만족시킬 수 없다. 그래서 SVG 안 <style>의 미디어쿼리로
// 구간마다 font-size를 갈아끼운다 - SVG에서 CSS px = 사용자 단위이고, 인라인 DOM이라
// 미디어쿼리는 문서 뷰포트로 평가된다.
export type CareerStripFit = {
  /** 이 SVG가 보이는 구간에서 가장 작은 CSS 높이(px). 작게 잡으면 글자가 커지는 쪽으로만 틀린다. */
  cssHeight: number;
  /** 뷰포트에서 빼는 가로 크롬(px) - .wrap 좌우 패딩 + 컨테이너 좌우 패딩·테두리. */
  chrome: number;
  /** 이 SVG가 보이는 가장 좁은 뷰포트(기본 320) / 가장 넓은 뷰포트(기본 제한 없음). */
  minVp?: number;
  maxVp?: number;
};

/** 저장소 계약: SVG 글자는 어느 뷰포트에서도 12px 이상. 반올림 여유를 두고 12.2를 겨냥한다. */
const FIT_MIN_PX = 12;
const FIT_TARGET_PX = 12.2;
/** .wrap의 max-width(globals.css --measure-wide). 이보다 넓은 화면에서 지면은 더 안 넓어진다. */
const FIT_MEASURE_WIDE = 1180;
/** 구간 경계 후보(내림차순). 앞 구간 글자로도 12px가 나오면 아래에서 솎아낸다. */
const FIT_BPS = [1000, 714, 620, 430, 375, 360];

/** bp=null이 미디어쿼리 없는 기본 규칙. 목록은 내림차순이라 좁은 구간이 뒤에서 이긴다. */
type FitBand = { bp: number | null; fs: number };

/**
 * 구간마다 "그 구간에서 가장 불리한 뷰포트"를 잡아 12.2px이 나오는 font-size를 계산한다.
 * 어떤 구간이 이기는 범위의 **아래쪽 끝**이 그 구간의 최악이다(위로 갈수록 배율이 커진다).
 */
function fitBands(W: number, H: number, fit: CareerStripFit): FitBand[] {
  const minVp = fit.minVp ?? 320;
  const maxVp = fit.maxVp ?? Infinity;
  const hRatio = fit.cssHeight / H;
  const scaleAt = (vp: number) => Math.min((Math.min(vp, FIT_MEASURE_WIDE) - fit.chrome) / W, hRatio);
  const fsAt = (vp: number) => Math.ceil((FIT_TARGET_PX / scaleAt(vp)) * 10) / 10;
  const bps = FIT_BPS.filter((b) => b >= minVp && b < maxVp);
  const out: FitBand[] = [{ bp: null, fs: fsAt(bps.length ? bps[0] + 1 : minVp) }];
  for (let i = 0; i < bps.length; i++) {
    const worst = i + 1 < bps.length ? bps[i + 1] + 1 : minVp;
    // 앞 구간 글자로도 이 구간 바닥에서 12px를 넘으면 규칙을 더 두지 않는다(바이트·복잡도).
    if (out[out.length - 1].fs * scaleAt(worst) >= FIT_MIN_PX) continue;
    out.push({ bp: bps[i], fs: fsAt(worst) });
  }
  return out;
}

/**
 * 라벨 줄 높이. 라벨 베이스라인이 TOP−4에 있고 글자 위끝이 대략 0.82em이므로 그만큼은 있어야
 * 글자가 클립 rect(뷰박스) 위로 잘리지 않는다. PAD_T가 하한 - 작은 글자에서는 예전 그대로다.
 */
const fitLabelRow = (fs: number) => Math.max(PAD_T, Math.ceil(0.82 * fs + 4));
/** 같은 식을 높이 계산 중에도 써야 해서 이름만 따로 둔다(TOP은 fsMax가 정해진 뒤에야 상수가 된다). */
const TOP_AT = fitLabelRow;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 소수 1자리, 불필요한 0 제거(칸이 수백 개라 좌표 문자열이 곧 바이트다). */
function n1(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
}

function safeId(uid: string): string {
  return uid.replace(/[^A-Za-z0-9_-]/g, "") || "x";
}

function byteLen(s: string): number {
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : s.length;
}

type Block = { seasonName: string; start: number; end: number; tcodes: string[]; played: number; absent: number; pts: number; maxPts: number };

/** 잘린(또는 전체) nights 위에서 시즌 구간을 다시 잡는다 - recentN이면 grain.seasons를 못 쓴다. */
function blocksOf(nights: CareerNight[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < nights.length; i++) {
    const n = nights[i];
    let cur = out[out.length - 1];
    if (!cur || cur.seasonName !== n.seasonName) {
      cur = { seasonName: n.seasonName, start: i, end: i, tcodes: [n.tcode], played: 0, absent: 0, pts: 0, maxPts: 0 };
      out.push(cur);
    } else {
      cur.end = i;
      if (!cur.tcodes.includes(n.tcode)) cur.tcodes.push(n.tcode);
    }
    if (n.kind === "played") {
      cur.played += 1;
      cur.pts += n.pts;
      if (n.pts > cur.maxPts) cur.maxPts = n.pts;
    } else cur.absent += 1;
  }
  return out;
}

/** 연속한 같은 조건의 칸을 하나의 rect로 합친다(결장 레일·플레이오프 레일). */
function runs(nights: CareerNight[], hit: (n: CareerNight) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = -1;
  for (let i = 0; i <= nights.length; i++) {
    const on = i < nights.length && hit(nights[i]);
    if (on && s < 0) s = i;
    if (!on && s >= 0) {
      out.push([s, i - 1]);
      s = -1;
    }
  }
  return out;
}

/**
 * 커리어 결 띠 SVG.
 *
 * 밤이 하나도 없으면 null(lib/seasonRibbon.ts와 같은 규약 - 호출부가 반드시 분기하게 한다).
 */
export function buildCareerStripSvg(grain: CareerGrain, opts: CareerStripOptions): CareerStripResult | null {
  const all = grain.nights;
  if (!all.length) return null;

  const uid = safeId(opts.uid);
  const tone: CareerStripTone = opts.tone ?? "hero";
  const W0 = opts.width ?? STRIP_DEFAULT_WIDTH;
  const H0 = Math.max(48, opts.height ?? STRIP_DEFAULT_HEIGHT);

  // 잉크(중립색)는 톤에 따라 다르다. 히어로는 라이트/다크 양쪽에서 딥다크라 테마 토큰
  // (--line-rgb는 라이트에서 '어두운 잉크')을 쓰면 검은 배경 위에서 사라진다 - 직접 칠한다.
  const ink = (a: number) => (tone === "hero" ? `rgba(255,255,255,${a})` : `rgba(var(--line-rgb),${a})`);
  const lineColor = tone === "hero" ? "#ffffff" : "var(--ink)";
  const haloColor = tone === "hero" ? "rgba(0,0,0,0.5)" : "var(--surface)";
  // 플레이오프 레일의 금색도 같은 이유로 톤을 탄다. --gold는 테마를 따라가서(라이트 #9a6b00 /
  // 다크 #ffd166) 라이트 테마에서 히어로(고정 #0b0d12) 위에 얹으면 대비가 ~3.3:1까지 떨어진다
  // - 높이 2.2단위짜리 레일에서는 사실상 안 보인다. 히어로에는 다크 쪽 금색을 직접 칠하고,
  // 테마 토큰은 표면 패널(§9)에서만 쓴다(잉크·팀 색이 이미 따르는 규칙 그대로).
  const goldColor = tone === "hero" ? "#ffd166" : "var(--gold)";
  // IBM Plex Mono에는 한글 글리프가 없다. 이 띠가 찍는 글자 중 셋이 한글이다 -
  // 득점 축 상한 `${maxPts}점`, 짧은 커리어의 월 라벨 `${N}월`, 공백 시즌의 '기록 없음'.
  // 스택에 Pretendard를 이름 지어 두지 않으면 그 글자만 이름 없는 시스템 모노로 떨어져서
  // 바로 옆 라틴 시즌 라벨("21-22")과 얼굴이 어긋난다(저장소가 세 번 쫓은 그 버그).
  // 글리프 단위 폴백이라 숫자·라틴은 계속 Plex Mono로 남는다.
  const MONO = '"IBM Plex Mono", "Pretendard", monospace';

  // ── 잘라내기(§9 패널) ───────────────────────────────────────────────────────────────
  // range가 있으면 그 구간, 없으면 recentN(끝에서 자르기), 둘 다 없으면 전체.
  const rangeStart = opts.range
    ? Math.max(0, Math.min(all.length - 1, opts.range.start))
    : opts.recentN != null && opts.recentN > 0 && opts.recentN < all.length
      ? all.length - opts.recentN
      : 0;
  const rangeEnd = opts.range ? Math.max(rangeStart + 1, Math.min(all.length, opts.range.end)) : all.length;
  const crop = rangeStart; // 이름 유지 - 아래 이동평균 slice·§10이 쓴다
  const nights = all.slice(rangeStart, rangeEnd);
  const N = nights.length;
  const cropped = rangeStart > 0 || rangeEnd < all.length;

  const blocks = blocksOf(nights);
  const played = nights.filter((n) => n.kind === "played");
  const playedCount = played.length;
  const absentCount = N - playedCount;
  const maxPts = played.reduce((m, n) => (n.pts > m ? n.pts : m), 0);
  const denom = Math.max(1, maxPts);
  const firstDate = nights[0].date;
  const lastDate = nights[N - 1].date;

  // ── 축(칸 폭 → 모드) ───────────────────────────────────────────────────────────────
  // 공백 시즌 표식이 커리어 끝에 붙으면 오른쪽에 자리를 미리 뺀다(라벨이 잘리지 않게).
  const lastBlockYear = Number(blocks[blocks.length - 1].seasonName.slice(0, 4));
  const reachesEnd = rangeEnd === all.length;
  const trailingGaps = reachesEnd ? grain.gapSeasons.filter((s) => Number(s.slice(0, 4)) > lastBlockYear) : [];
  const reserve = trailingGaps.length ? GAP_RESERVE : 0;

  const avail = Math.max(40, W0 - PAD_L - PAD_R - reserve);
  const raw = avail / N;
  const cw = raw < CELL_MIN_W ? CELL_MIN_W : raw > CELL_MAX_W ? CELL_MAX_W : raw;
  // 짧은 커리어의 두 가지 조정은 서로 다른 이유를 가지므로 따로 판단한다.
  //  - 월 축: 칸이 상한에 닿고(= 한 시즌이 띠를 다 못 채운다) 시즌이 1~2개일 때만. 네 시즌짜리
  //    띠에 연도 없이 '11월'만 찍으면 어느 해의 11월인지 알 수 없다.
  //  - 짧은 이동평균 창: 칸이 상한에 닿았거나, 보이는 출전이 창의 3배(45)에 못 미칠 때. 후자가
  //    없으면 recentN 패널(40밤·출전 21)이 15경기 창을 써서 선이 패널 전체를 평평하게 덮는다.
  const monthAxis = raw >= CELL_MAX_W && blocks.length <= 2;
  const shortWindow = raw >= CELL_MAX_W || playedCount < 3 * MOVING_AVERAGE_WINDOW;
  const compact = monthAxis;
  const mode: "cell" | "season" = opts.detail === "cell" ? "cell" : opts.detail === "season" ? "season" : cw >= DETAIL_MIN_CELL_W ? "cell" : "season";

  const W = Math.max(W0, PAD_L + N * cw + reserve + PAD_R);

  // ── 공백 시즌 묶음(§10) - 높이 계산이 이 결과를 쓴다 ────────────────────────────────
  // 실측: 패리스 배스(291671)는 23-24만 뛰고 26-27 명단에 있다 - 24-25·25-26이 공백이다.
  // 두 줄(시즌 · '기록 없음')이 차지할 세로 자리를 뷰박스 높이에 미리 반영해야 하므로
  // 그리기 직전이 아니라 여기서 묶는다.
  const gapGroups = new Map<number, string[]>();
  for (const sName of opts.gapMarkers === false ? [] : grain.gapSeasons) {
    const y = Number(sName.slice(0, 4));
    const at = blocks.findIndex((b) => Number(b.seasonName.slice(0, 4)) > y);
    if (at < 0) {
      if (!reachesEnd) continue; // 잘린 구간 뒤의 공백은 이 화면의 사실이 아니다
      const arr = gapGroups.get(N) ?? [];
      arr.push(sName);
      gapGroups.set(N, arr);
      continue;
    }
    if (blocks[at].start === 0) continue; // 자른 구간보다 앞 - 화면 밖
    const arr = gapGroups.get(blocks[at].start) ?? [];
    arr.push(sName);
    gapGroups.set(blocks[at].start, arr);
  }
  // §4-1의 조건과 같아야 한다(그쪽은 fsMax가 정해진 뒤라 다시 쓰지 않고 이 값을 쓴다).
  const showValues = !!opts.valueLabels && mode === "cell" && cw >= 8 && N <= 40;
  /** 공백 두 줄의 윗줄 y. 축 라벨 줄(TOP-4)과 값 라벨 줄(valTop) **아래**로 내려 둔다. */
  const gapTopAt = (fs: number) => Math.max(TOP_AT(fs) + 0.9 * fs, showValues ? TOP_AT(fs) + 1.93 * fs : 0);
  /** 두 줄 + 아랫줄 디센더까지 담는 데 필요한 높이. */
  const gapNeedAt = (fs: number) => gapTopAt(fs) + 1.5 * fs;

  // ── 글자 구간 → 라벨 줄 → 뷰박스 높이 ───────────────────────────────────────────
  // 가장 좁은 구간의 글자(fsMax)가 라벨 줄에 들어가야 하고, 막대 띠(bandH)는 얇아지면 안 된다.
  // 그래서 라벨 줄이 커진 만큼 **뷰박스 높이를 키운다**(예전에는 라벨 줄이 막대를 먹었다).
  // 높이가 커지면 높이 배율(CSS높이/H)이 작아져 글자가 다시 커지므로 두어 번 되돌린다 -
  // 라벨 줄은 글자의 0.82배라 계수가 1보다 작고, 실측 두 번이면 멈춘다.
  const bandH0 = H0 - PAD_T - PAD_B;
  let H = H0;
  let bands = fitBands(W, H, opts.fit);
  // 공백 시즌 두 줄도 같은 이유로 높이를 요구한다 - 예전에는 이 줄들을 H 안으로 '클램프'해서
  // 위로 밀었고, 그 결과 축 라벨·값 라벨 줄을 밟았다(검증자 실측 29쌍). 라벨을 미는 대신 키운다.
  for (let i = 0; i < 6; i++) {
    const fs = Math.max(...bands.map((b) => b.fs));
    const need = Math.max(fitLabelRow(fs) + bandH0 + PAD_B, gapGroups.size ? Math.ceil(gapNeedAt(fs)) : 0);
    if (need <= H) break;
    H = need;
    bands = fitBands(W, H, opts.fit);
  }
  // 겹침 검사는 언제나 가장 큰 구간 글자로 돈다(구간마다 다른 라벨 집합을 만들 수 없다).
  // 다만 넓은 구간 글자(fsWide)로만 자리가 나는 라벨은 지우지 않고 .cgn-uid를 달아
  // 좁은 구간에서만 숨긴다 - seasonRibbon의 .rbbWide와 같은 두 단 솎기.
  // (이름 주의: .cgw-uid는 이미 §12 와이프 애니메이션의 클립 rect다. 거기에 display:none을
  //  걸면 클립 모양이 사라져 띠가 통째로 안 보인다 - 실제로 한 번 그렇게 짰다가 하네스에서 잡았다.)
  const fsMax = Math.max(...bands.map((b) => b.fs));
  const fsWide = bands[0].fs;
  const wideOnlyBp = bands.find((b) => b.fs > fsWide + 0.05)?.bp ?? null;
  const BASE = H - PAD_B;
  const TOP = fitLabelRow(fsMax);
  const bandH = BASE - TOP;
  const x0 = (i: number) => PAD_L + i * cw;
  const xc = (i: number) => PAD_L + i * cw + cw / 2;

  // 대략폭(한글 글리프 1em · 라틴 0.62em). §9 축 라벨 가드가 쓰지만 §4-1 값 라벨의 공백 구간
  // 가드가 더 먼저 부르므로 여기서 선언한다(아래에 두면 TDZ로 런타임에 터진다 - 하네스가 잡았다).
  const textW = (s: string, fs: number) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 127 ? 1 : 0.6) * fs, 0);

  // 공백 시즌 두 줄의 최종 자리(위에서 H가 이미 이만큼을 담도록 커졌다).
  const gapY1 = gapTopAt(fsMax);
  const gapY2 = gapY1 + 1.25 * fsMax;
  const gapLabelOf = (list: string[]) =>
    list.length <= 2 ? list.map(shortSeason).join("·") : `${shortSeason(list[0])}~${shortSeason(list[list.length - 1])}`;
  /** 그 라벨이 실제로 덮는 x 구간(값 라벨이 피해야 하는 자리). 앵커까지 반영한다. */
  const gapSpanOf = (idx: number, label: string): [number, number] => {
    const trailing = idx === N;
    const gx = trailing ? PAD_L + N * cw + 9 : PAD_L + idx * cw;
    const gw = Math.max(textW(label, fsMax), textW("기록 없음", fsMax));
    if (!trailing) return [gx - gw / 2, gx + gw / 2];
    // 커리어 끝 표식은 GAP_RESERVE(68단위)만큼만 예약돼 있다. 좁은 구간에서 글자가 커져 넘치면
    // 오른쪽 끝에 붙여 문장을 온전히 남긴다 - 사실이 반쯤 잘리느니 막대 몇 개를 덮는 쪽이 낫다.
    const wide = gx + 4 + gw > W - 2;
    return wide ? [W - 2 - 0.06 * fsMax - gw, W - 2 - 0.06 * fsMax] : [gx + 4, gx + 4 + gw];
  };
  const gapSpans: Array<[number, number]> = [...gapGroups].map(([idx, list]) => gapSpanOf(idx, gapLabelOf(list)));

  const gap = cw >= 6 ? 1.2 : cw >= 3.5 ? 0.7 : cw >= 2.2 ? 0.35 : 0;
  const barW = Math.max(0.9, cw - gap);
  // 0점 출전(득점 0 또는 0분 DNP)도 반드시 보이는 바닥 눈금. 기준선(0.8)보다 확실히 두꺼워야
  // "칸이 있다"가 읽힌다 - 조은후(291499)는 출전 119밤 중 33밤이 0분이라 이 눈금이 커리어의
  // 3분의 1을 말한다. 결장과는 방향(위/아래)과 색(팀 색/회색)이 둘 다 다르다.
  const MIN_BAR = 2.4;
  // 포인터 히트존의 세로 범위(칸 전체 + 결장 레일까지). 보이는 막대는 그날 득점만큼만 높지만
  // 집을 수 있는 넓이까지 득점에 비례하면 안 된다 - 0점/0분 밤의 막대는 MIN_BAR(2.4단위 ≈ 2px,
  // 모바일 --strip-h:56px에서는 1.9px)뿐이라 그 자체를 링크로 쓰면 사실상 누를 수 없다.
  // 조은후(291499)는 119출전 중 33밤이 0분이라, 막대를 링크로 쓰면 §9 패널에서 그 3분의 1이
  // 통째로 닿지 않았다. 그래서 링크·툴팁은 항상 칸 폭 × 이 높이의 투명 사각형이 받고, 막대는
  // 그 위에 그리기만 한다(결장 칸의 툴팁이 이미 쓰던 방법과 같다. 실측: 그 패널의 4.4px 막대도
  // 이제 130px 기둥 전체가 링크다).
  const hitY = n1(TOP);
  const hitH = n1(BASE + 4 - TOP);

  const parts: string[] = [];

  // ── 1. 기준선 ──────────────────────────────────────────────────────────────────────
  parts.push(`<line x1="${PAD_L}" y1="${n1(BASE)}" x2="${n1(PAD_L + N * cw)}" y2="${n1(BASE)}" stroke="${ink(0.26)}" stroke-width="0.8"/>`);

  // ── 2. 시즌 경계 헤어라인 + 월 구분선 ──────────────────────────────────────────────
  // 칸 사이 틈이 1 이상이면 선이 틈 한가운데로 떨어져 칸 뒤에 그려도 온전히 보인다. 촘촘한 띠
  // (틈 0)에서는 다음 칸이 선의 절반을 덮으므로 칸 '위'에 그린다 - 경계가 사라지면 안 된다.
  const axisLines: string[] = [];
  for (const b of blocks) {
    if (b.start === 0) continue;
    axisLines.push(`<line x1="${n1(x0(b.start))}" y1="${TOP - 4}" x2="${n1(x0(b.start))}" y2="${n1(BASE + 8)}" stroke="${ink(0.3)}" stroke-width="1"/>`);
  }
  if (compact) {
    for (let i = 1; i < N; i++) {
      if (nights[i].date.slice(0, 7) === nights[i - 1].date.slice(0, 7)) continue;
      if (nights[i].seasonName !== nights[i - 1].seasonName) continue; // 시즌 경계가 이미 그렸다
      axisLines.push(`<line x1="${n1(x0(i))}" y1="${TOP - 2}" x2="${n1(x0(i))}" y2="${n1(BASE)}" stroke="${ink(0.13)}" stroke-width="1" stroke-dasharray="2 3"/>`);
    }
  }
  const linesOnTop = gap < 1;
  if (!linesOnTop) parts.push(...axisLines);

  // ── 4. 칸 ──────────────────────────────────────────────────────────────────────────
  // 출전 칸은 팀별 <g fill>로 묶는다 - 칸마다 fill을 쓰면 칸당 14~20B가 그대로 늘어난다.
  const colorOf = (tcode: string) => accentFor(tcode, opts.teamColors.get(tcode));
  const abbrOf = (tcode: string) => opts.teamAbbrs?.get(tcode) ?? tcode;
  const yOf = (pts: number) => BASE - Math.max(MIN_BAR, (pts / denom) * bandH);
  const hOf = (pts: number) => Math.max(MIN_BAR, (pts / denom) * bandH);

  // 이적한 밤(색이 바뀌는 칸)의 인덱스 → 직전 팀. §7의 ◆는 포인터를 받지 않으므로(칸 링크를
  // 가로막지 않게) "여기서 팀이 바뀌었다"는 사실은 그 칸의 툴팁이 진다. 시즌 단위 모드에서는
  // §11 히트존 제목이 이미 'A→B'를 적는다.
  const transferFrom = new Map<number, string>();
  for (let i = 1; i < N; i++) if (nights[i].tcode !== nights[i - 1].tcode) transferFrom.set(i, nights[i - 1].tcode);

  const nightTitle = (n: CareerNight, i: number): string => {
    const vs = `${n.isHome ? "vs" : "@"} ${abbrOf(n.oppTcode)}`;
    const score = n.teamScore != null && n.oppScore != null ? ` ${n.teamScore}-${n.oppScore}` : "";
    const wl = n.won == null ? "" : n.won ? " 승" : " 패";
    const po = n.isPlayoff ? " · 플레이오프" : "";
    const from = transferFrom.get(i);
    const move = from ? ` · ${abbrOf(from)}→${abbrOf(n.tcode)} 이적` : "";
    if (n.kind === "absent") return `${n.date} ${vs}${score}${wl}${po} · 결장${move}`;
    return `${n.date} ${vs}${score}${wl}${po} · ${n.pts}점 ${n1(n.min)}분 ${n.reb}리바 ${n.ast}어시${move}`;
  };

  if (mode === "cell") {
    // 경기 단위: 칸마다 <a> + <title>. 팀이 바뀔 때만 <g fill>을 새로 연다.
    let openTeam: string | null = null;
    for (let i = 0; i < N; i++) {
      const n = nights[i];
      if (n.kind !== "played") continue;
      if (n.tcode !== openTeam) {
        if (openTeam != null) parts.push("</g>");
        parts.push(`<g fill="${colorOf(n.tcode)}">`);
        openTeam = n.tcode;
      }
      parts.push(
        `<a href="/games/${esc(n.gmkey)}"><title>${esc(nightTitle(n, i))}</title>` +
          `<rect class="cgh-${uid}" x="${n1(x0(i))}" y="${hitY}" width="${n1(cw)}" height="${hitH}" fill="transparent"/>` +
          `<rect x="${n1(x0(i) + gap / 2)}" y="${n1(yOf(n.pts))}" width="${n1(barW)}" height="${n1(hOf(n.pts))}"/></a>`
      );
    }
    if (openTeam != null) parts.push("</g>");
  } else {
    // 시즌 단위: 같은 팀 칸을 <path> 하나로 합친다(칸당 ~22B). 상호작용은 시즌 히트존이 맡는다.
    const byTeam = new Map<string, string[]>();
    const lastX = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const n = nights[i];
      if (n.kind !== "played") continue;
      const x = x0(i) + gap / 2;
      const h = hOf(n.pts);
      let d = byTeam.get(n.tcode);
      if (!d) {
        d = [];
        byTeam.set(n.tcode, d);
        d.push(`M${n1(x)} ${n1(BASE)}v-${n1(h)}h${n1(barW)}v${n1(h)}z`);
      } else {
        d.push(`m${n1(x - (lastX.get(n.tcode) as number))} 0v-${n1(h)}h${n1(barW)}v${n1(h)}z`);
      }
      lastX.set(n.tcode, x);
    }
    for (const [tcode, d] of byTeam) parts.push(`<path fill="${colorOf(tcode)}" d="${d.join("")}"/>`);
  }

  // ── 4-1. 값 라벨(확대판) ─────────────────────────────────────────────────────────
  // 제보: "L15·L30 가시성" - 막대 높이만으로는 그날 몇 점인지 읽히지 않는다. 칸이 충분히 넓을
  // 때만(7단위+, 40칸 이하) 칸 위에 득점을 적는다. 0점은 적지 않는다(바닥 눈금이 이미 말한다).
  // 칸 폭 하한 8: 6.5단위 모노 두 자리가 7.8단위라 그보다 좁은 칸에서는 이웃을 밟는다
  // (실측 - 8단위로 찍었더니 9단위 칸에서 9.6단위가 되어 겹쳤다).
  if (showValues) {
    // 글자 크기는 .cg-uid가 준다(구간마다 다르다) - 여기서 font-size를 박으면 상속을 덮는다.
    parts.push(`<g pointer-events="none" font-weight="700" text-anchor="middle" fill="${ink(0.85)}">`);
    // 이웃과 겹칠 것 같으면 건너뛴다. 두 자리 숫자가 붙은 칸에 연달아 오면 "14"와 "16"이 "1416"으로
    // 읽힌다(375px 실측). 막대 높이가 이미 값을 말하므로, 겹치느니 몇 개를 안 적는 쪽이 낫다.
    // 좁은 구간 글자로 자리가 나면 늘 그리고, 넓은 구간 글자로만 나면 좁은 구간에서 숨긴다
    // (한 값으로 솎으면 12px을 맞추는 대가로 넓은 화면의 라벨 절반을 잃는다).
    let valNarrowEnd = -Infinity;
    let valWideEnd = -Infinity;
    const valTop = TOP + 0.78 * fsMax; // 라벨 위끝이 라벨 줄을 넘지 않는 가장 높은 자리
    for (let i = 0; i < N; i++) {
      const n = nights[i];
      if (n.kind !== "played" || n.pts <= 0) continue;
      const digits = String(n.pts).length;
      const halfN = digits * 0.31 * fsMax; // 0.62em/2
      const halfW = digits * 0.31 * fsWide;
      // 첫·마지막 칸의 라벨은 칸 중앙에 두면 절반이 뷰박스 밖이라 클립 rect가 자른다
      // (320px 실측: 첫 칸 "30"의 왼쪽 획이 −1.5단위). 가장자리 여백은 겹침 검사(0.62em =
      // Plex Mono 실폭)보다 넉넉히 잡는다 - 웹폰트가 오기 전 시스템 모노는 0.73em까지 넓다.
      const edge = digits * 0.38 * fsMax;
      const x = Math.min(Math.max(xc(i), edge), W - edge);
      // 짧은 막대의 값 라벨은 y가 아래로 내려가 공백 시즌 두 줄과 같은 높이에 올 수 있다.
      // 세로로 피할 방법이 없으므로 그 x 구간에서는 안 적는다(막대 높이가 이미 값을 말한다).
      if (gapSpans.some(([ga, gb]) => x + halfN >= ga && x - halfN <= gb)) continue;
      if (x - halfW < valWideEnd) continue; // 넓은 구간에서도 자리가 없으면 안 그린다
      const narrowOk = x - halfN >= valNarrowEnd;
      valWideEnd = x + halfW + 0.18 * fsWide;
      if (narrowOk) valNarrowEnd = x + halfN + 0.18 * fsMax;
      const y = Math.max(valTop, yOf(n.pts) - 2.5);
      parts.push(`<text ${narrowOk ? "" : `class="cgn-${uid}" `}x="${n1(x)}" y="${n1(y)}">${n.pts}</text>`);
    }
    parts.push("</g>");
  }

  // ── 5. 결장 레일(기준선 아래) ──────────────────────────────────────────────────────
  // 연속 결장은 한 rect로 합쳐 "구멍"이 길이로 읽히게 한다(실측 최장 45칸 - 김선형 17-18).
  // 방향(아래)과 색(회색)이 0점 출전(위·팀 색)과 달라서 두 사실이 절대 섞이지 않는다.
  const absRuns = runs(nights, (n) => n.kind === "absent");
  if (absRuns.length) {
    parts.push(`<g fill="${ink(0.28)}">`);
    for (const [s, e] of absRuns) parts.push(`<rect x="${n1(x0(s))}" y="${n1(BASE + 1.2)}" width="${n1((e - s + 1) * cw)}" height="2.4"/>`);
    parts.push("</g>");
  }
  // 경기 단위 모드에서는 빈칸에도 툴팁을 준다(링크는 없다 - 그가 뛴 경기가 아니다).
  if (mode === "cell" && absentCount) {
    parts.push(`<g fill="transparent">`);
    for (let i = 0; i < N; i++) {
      const n = nights[i];
      if (n.kind !== "absent") continue;
      parts.push(`<g><title>${esc(nightTitle(n, i))}</title><rect x="${n1(x0(i))}" y="${hitY}" width="${n1(cw)}" height="${hitH}"/></g>`);
    }
    parts.push("</g>");
  }

  // ── 6. 플레이오프 레일 ─────────────────────────────────────────────────────────────
  const poRuns = runs(nights, (n) => n.isPlayoff);
  if (poRuns.length) {
    parts.push(`<g fill="${goldColor}" opacity="0.85">`);
    for (const [s, e] of poRuns) parts.push(`<rect x="${n1(x0(s))}" y="${n1(BASE + 5.4)}" width="${n1((e - s + 1) * cw)}" height="2.2" rx="1"/>`);
    parts.push("</g>");
  }

  if (linesOnTop) parts.push(...axisLines);

  // ── 7. 이적 표식 ───────────────────────────────────────────────────────────────────
  // 색만으로는 부족하다: 실측(해먼즈 291698)에서 이적이 시즌 경계와 같은 x에 떨어져 헤어라인에
  // 묻힌다. 기준선 위에 새 팀 색 ◆를 얹어 "여기서 바뀌었다"를 경계와 따로 보이게 한다.
  // ◆ 자신은 포인터를 받지 않는다(pointer-events="none"). 기준선 근처 6.4×6.4단위를 덮기 때문에
  // 포인터를 받으면 그 자리의 경기 링크를 대신 먹는다. 이적 사실은 그 칸의 툴팁이 진다
  // (nightTitle의 'A→B 이적' 절, 시즌 단위 모드에서는 §11 히트존 제목의 'A→B').
  if (transferFrom.size) {
    parts.push(`<g pointer-events="none">`);
    for (const i of transferFrom.keys()) {
      parts.push(
        `<path d="M${n1(x0(i))} ${n1(BASE - 4.6)}l3.2 3.2-3.2 3.2-3.2-3.2z" fill="${colorOf(nights[i].tcode)}" stroke="${ink(0.75)}" stroke-width="0.8"/>`
      );
    }
    parts.push("</g>");
  }

  // ── 8. 이동평균선 ──────────────────────────────────────────────────────────────────
  // 창은 짧은 커리어에서 5로 줄인다(35경기에 15경기 창을 대면 선이 커리어의 3분의 1을 먹는다).
  // 값은 자르기 전 전체 이력으로 계산한 뒤 같은 구간을 잘라 쓴다 - §9 패널도 첫 칸부터 선이 산다.
  const maWindow = shortWindow ? STRIP_COMPACT_MA_WINDOW : MOVING_AVERAGE_WINDOW;
  const maAll = careerMovingAverage(all, maWindow);
  const ma = maAll.slice(rangeStart, rangeEnd);
  // 선은 '출전한 밤' 위에만 점을 찍는다. careerGrain은 결장 칸에서 직전 값을 이어 주지만(선이
  // 끊기지 않게), 그 값을 그대로 그리면 45칸짜리 결장 구간(김선형 17-18 실측)이 평평한 직선이
  // 되어 "그 기간에도 꾸준했다"로 읽힌다 - 뛰지 않은 밤에 대한 주장이라 그릴 수 없다.
  // 그래서 평균의 정의는 건드리지 않고(결장은 0점으로 세지 않는다) 그리기에서만 끊는다:
  //   - 결장 1~2칸은 이어 그린다(양 끝이 실제 출전이라 두 실측값 사이의 직선일 뿐이다)
  //   - 결장 3칸 이상은 끊는다(구멍으로 읽히는 길이. 그 위를 가로지르면 주장이 된다)
  //   - 연속하지 않은 시즌 사이(공백 시즌)도 끊는다
  // 서브패스로 끊으므로 <path>는 여전히 하나다.
  //
  // 점 솎아내기: 이동평균은 천천히 움직여서 칸마다 점을 찍으면 path 하나가 10KB를 넘는다
  // (807칸 실측). 마지막으로 '찍은' 점을 기준(anchor)으로 삼아 세로로 MA_EPS 이상 벗어날 때만
  // 새로 찍는다 - 기준을 매 칸 갱신하면 완만한 상승이 통째로 직선이 되어 모양이 거짓이 된다.
  const MA_EPS = 0.35;
  const MA_BREAK_RUN = 3;
  const segs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  let anchorY = NaN;
  let pending: [number, number] | null = null;
  let absRun = 0;
  const closeSeg = () => {
    if (pending) cur.push(pending); // 구간의 마지막 밤은 항상 선의 끝이어야 한다
    pending = null;
    if (cur.length > 1) segs.push(cur);
    cur = [];
    anchorY = NaN;
  };
  for (let i = 0; i < N; i++) {
    if (nights[i].kind === "absent") {
      absRun += 1;
      if (absRun === MA_BREAK_RUN) closeSeg();
      continue;
    }
    if (i > 0 && Number(nights[i].seasonName.slice(0, 4)) - Number(nights[i - 1].seasonName.slice(0, 4)) > 1) closeSeg();
    absRun = 0;
    const v = ma[i];
    if (v == null) continue;
    const p: [number, number] = [xc(i), BASE - (v / denom) * bandH];
    if (!cur.length) {
      cur.push(p);
      anchorY = p[1];
    } else if (Math.abs(p[1] - anchorY) >= MA_EPS) {
      cur.push(p);
      anchorY = p[1];
      pending = null;
    } else pending = p;
  }
  closeSeg();
  let maDrawn = 0;
  if (segs.length) {
    const d = segs.map((s) => s.map(([x, y], i) => `${i ? "L" : "M"}${n1(x)} ${n1(y)}`).join("")).join("");
    // 선(과 3단위짜리 후광)은 칸 위를 가로지르므로 포인터를 받으면 안 된다. SVG 획은 기본적으로
    // 히트 테스트에 걸려서, 선이 지나가는 자리에서는 아래 칸의 <a> 대신 이 path가 잡힌다
    // (실측: 해먼즈 291698 히어로에서 112칸 중 56칸에 죽은 띠가 생겼다 - 그 자리에서는 툴팁도
    // 안 뜨고 클릭해도 경기 페이지로 가지 않는다). 선은 읽는 것이지 집는 것이 아니다.
    parts.push(`<path d="${d}" fill="none" stroke="${haloColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.55" pointer-events="none"/>`);
    parts.push(`<path d="${d}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.92" pointer-events="none"/>`);
    maDrawn = maWindow;
    // 선 끝에 "N경기 평균 12.0"을 적어 봤다가 지웠다(2026-09-08, 375px 실측): 그 한 줄이 L15에서
    // 차트 절반을 가로질러 칸 위 득점 라벨과 겹쳤다. 캡션이 이미 "굵은 선 = N경기 이동평균"을 말한다.
  }

  // ── 9. 축 라벨(연도 또는 월) + 득점 축 상한 ────────────────────────────────────────
  const scaleLabel = `${maxPts}점`;
  const scaleX = Math.min(W - 2, PAD_L + N * cw + reserve);
  parts.push(`<text x="${n1(scaleX)}" y="${n1(TOP - 4)}" text-anchor="end" fill="${ink(0.55)}">${esc(scaleLabel)}</text>`);
  const labelGuard = (fs: number) => scaleX - textW(scaleLabel, fs) - 8;

  // 가드는 라벨의 '끝'까지 본다. 시작 x만 보면 글자가 커진 구간에서 라벨 꼬리가 오른쪽 득점 축
  // 라벨을 밟는다 - 실측으로 "23-2411월"·"4월25점"이 나왔다. 값 라벨과 같은 두 단 솎기.
  let labelNarrowEnd = -99;
  let labelWideEnd = -99;
  const pushLabel = (x: number, text: string, alpha: number) => {
    const wW = textW(text, fsWide);
    if (x < labelWideEnd + 0.67 * fsWide || x + 2 + wW > labelGuard(fsWide)) return;
    const wN = textW(text, fsMax);
    const narrowOk = x >= labelNarrowEnd + 0.67 * fsMax && x + 2 + wN <= labelGuard(fsMax);
    labelWideEnd = x + 2 + wW;
    if (narrowOk) labelNarrowEnd = x + 2 + wN;
    parts.push(`<text ${narrowOk ? "" : `class="cgn-${uid}" `}x="${n1(x + 2)}" y="${n1(TOP - 4)}" fill="${ink(alpha)}">${esc(text)}</text>`);
  };
  if (compact) {
    for (let i = 0; i < N; i++) {
      const newSeason = i === 0 || nights[i].seasonName !== nights[i - 1].seasonName;
      const newMonth = i === 0 || nights[i].date.slice(0, 7) !== nights[i - 1].date.slice(0, 7);
      if (!newMonth && !newSeason) continue;
      pushLabel(x0(i), newSeason ? shortSeason(nights[i].seasonName) : `${Number(nights[i].date.slice(5, 7))}월`, newSeason ? 0.62 : 0.42);
    }
  } else {
    for (const b of blocks) pushLabel(x0(b.start), shortSeason(b.seasonName), 0.62);
  }

  // ── 10. 공백 시즌(칸이 없는 시즌) - 조용히 빼먹지 않고 끊김으로 그린다 ─────────────
  // 묶기(gapGroups)와 자리(gapY1/gapY2/gapSpanOf)는 위에서 이미 정했다 - 높이 계산이 그 값을
  // 써야 두 줄이 축·값 라벨 줄로 밀려 올라가지 않는다.
  // 이 두 줄은 막대 위에 얹히므로 후광을 두른다(seasonRibbon의 RB_HALO와 같은 이유).
  const gapHalo = `paint-order="stroke" stroke="${haloColor}" stroke-width="${n1(0.12 * fsMax)}" stroke-linejoin="round"`;
  for (const [idx, list] of gapGroups) {
    const trailing = idx === N;
    const x = trailing ? PAD_L + N * cw + 9 : x0(idx);
    const label = gapLabelOf(list);
    const [spanA, spanB] = gapSpanOf(idx, label);
    const anchor = !trailing ? "middle" : spanB < W - 2.5 ? "start" : "end";
    const tx = !trailing ? x : anchor === "end" ? spanB : spanA;
    parts.push(
      `<g><title>${esc(`${list.join(" · ")} KBL 출전 기록 없음`)}</title>` +
        `<line x1="${n1(x)}" y1="${n1(TOP - 4)}" x2="${n1(x)}" y2="${n1(BASE + 8)}" stroke="${ink(0.34)}" stroke-width="1" stroke-dasharray="2 3"/>` +
        `<text x="${n1(tx)}" y="${n1(gapY1)}" text-anchor="${anchor}" fill="${ink(0.6)}" ${gapHalo}>${esc(label)}</text>` +
        `<text x="${n1(tx)}" y="${n1(gapY2)}" text-anchor="${anchor}" fill="${ink(0.42)}" ${gapHalo}>기록 없음</text></g>`
    );
  }

  // ── 11. 시즌 히트존(칸이 너무 좁아 개별 경기를 집을 수 없을 때의 상호작용) ─────────
  if (mode === "season") {
    const linked = opts.seasonLinks !== false;
    for (const b of blocks) {
      const avg = b.played ? b.pts / b.played : 0;
      const teamLabel = b.tcodes.map(abbrOf).join("→");
      const title =
        `${b.seasonName} ${teamLabel} · ${b.played}경기 출전` +
        (b.absent ? ` · ${b.absent}경기 결장` : "") +
        (b.played ? ` · 평균 ${avg.toFixed(1)}점 · 최고 ${b.maxPts}점` : "");
      const rect = `<rect x="${n1(x0(b.start))}" y="0" width="${n1((b.end - b.start + 1) * cw)}" height="${n1(H)}" fill="transparent"/>`;
      parts.push(
        linked
          ? `<a href="/players/${esc(grain.pcode)}?season=${esc(b.seasonName)}"><title>${esc(title)}</title>${rect}</a>`
          : `<g><title>${esc(title)}</title>${rect}</g>`
      );
    }
  }

  // ── 12. 그리기 애니메이션(왼→오 와이프 1회) ────────────────────────────────────────
  // 정지 상태의 선언이 곧 완성된 그림이다(clipPath rect가 처음부터 전체 폭). 애니메이션은
  // prefers-reduced-motion: no-preference 안에서만 존재하고, 칸이 800개여도 움직이는 요소는
  // 이 rect 하나뿐이다(app/globals.css의 live-pulse와 같은 정책, 더 엄격한 쪽으로).
  const style =
    `<style>` +
    // 글자는 뿌리 <g>에 한 번만 걸고 모든 <text>가 상속받는다(라벨마다 font-family를 적으면
    // 라벨당 45B가 그대로 늘어난다 - 칸이 800개인 띠에서는 그게 곧 응답 크기다).
    // 구간 규칙은 내림차순이라 좁은 구간이 뒤에서 이긴다(같은 명세도 = 나중 규칙 승).
    `.cg-${uid}{font-family:${MONO};font-size:${n1(fsWide)}px}` +
    bands
      .slice(1)
      .map((b) => `@media(max-width:${b.bp}px){.cg-${uid}{font-size:${n1(b.fs)}px}}`)
      .join("") +
    (wideOnlyBp ? `@media(max-width:${wideOnlyBp}px){.cgn-${uid}{display:none}}` : "") +
    `.cgz-${uid} a:hover rect,.cgz-${uid} a:focus-visible rect{fill:${ink(0.09)}}` +
    `.cgc-${uid} a:hover rect,.cgc-${uid} a:focus-visible rect{fill:${tone === "hero" ? "#ffffff" : "var(--ink)"}}` +
    // 히트존은 하얗게 칠하지 않는다 - 칸 하나가 통째로 흰 기둥이 되면 막대의 높이가 사라진다.
    // 대신 시즌 히트존과 같은 옅은 칠로 "이 칸이 대상"만 알린다(막대는 그 위에서 흰색이 된다).
    // 명세도: .cgc + :hover + .cgh = 클래스 3 > 위 규칙(클래스 2)이라 이쪽이 이긴다.
    `.cgc-${uid} a:hover .cgh-${uid},.cgc-${uid} a:focus-visible .cgh-${uid}{fill:${ink(0.09)}}` +
    `@media (prefers-reduced-motion: no-preference){` +
    `.cgw-${uid}{transform-box:view-box;transform-origin:0 0;animation:cgw-${uid} 1.1s cubic-bezier(.22,.61,.36,1) both}` +
    `@keyframes cgw-${uid}{from{transform:scaleX(0)}to{transform:scaleX(1)}}` +
    `}</style>`;

  const svg =
    style +
    `<defs><clipPath id="cgw-${uid}" clipPathUnits="userSpaceOnUse"><rect class="cgw-${uid}" x="0" y="0" width="${n1(W)}" height="${n1(H)}"/></clipPath></defs>` +
    `<g class="cg-${uid} ${mode === "cell" ? `cgc-${uid}` : `cgz-${uid}`}" clip-path="url(#cgw-${uid})">${parts.join("")}</g>`;

  // ── 캡션(고정 문형) ────────────────────────────────────────────────────────────────
  // 이동평균선을 못 그린 경우(표본 미달)에는 마지막 절을 뺀다 - 없는 선을 설명하면 거짓말이다.
  const head = opts.captionHead ?? (cropped ? `최근 ${playedCount}경기` : `커리어 ${playedCount}경기`);
  const caption =
    `${head} (${firstDate} ~ ${lastDate}) · 칸 하나 = 한 경기 득점 · 색 = 그날의 소속팀 · ` +
    `빈칸 = 등록 기간 중 결장(미등록·이적 전후 기간은 그리지 않음)` +
    (maDrawn ? ` · 굵은 선 = ${maDrawn}경기 이동평균` : "");

  const dnp = played.filter((n) => n.min === 0).length;
  const fake = grain.absenceUnclippedCount - grain.absenceCount;
  const note =
    `${playedCount}경기 출전 · ${absentCount}경기 결장 · ${blocks.length}시즌 구간` +
    (dnp ? ` · 0분 출전 ${dnp}밤(기준선 위 바닥 눈금)` : "") +
    (!cropped && fake > 0 ? ` · 등록 기간 밖 ${fake}칸은 그리지 않음` : "");

  return {
    svg,
    caption,
    cells: N,
    bytes: byteLen(svg),
    viewBox: `0 0 ${n1(W)} ${n1(H)}`,
    width: W,
    height: H,
    cellWidth: cw,
    maWindow: maDrawn,
    mode,
    compact,
    note,
  };
}

// ── 모바일: 시즌별 행 ───────────────────────────────────────────────────────────────
//
// 제보(2026-09-06 실기기): 히어로 발치 띠가 375px에서 "너무 작아서 안 보임". 실측으로 이유가 분명하다 -
// 26-27 명단 198명의 커리어 총 경기 p50 122·max 739라, 한 줄 띠를 303px에 넣으면 칸 하나가
// 2.5px(p50)·0.41px(max)이고 9단위 글자는 3px가 된다. 크기를 키워서 될 일이 아니다.
//
// 시즌별로 한 행씩 접으면 최장 시즌(64경기)도 칸이 4.7px 이상이고 시즌 라벨이 행마다 붙는다
// (시즌 수 p50 4·p90 11·max 15). 각 행의 뷰박스 폭을 칸 수에 딱 맞춰(칸 상한 9 × 칸 수 + 여백)
// 페이지가 행을 100% 폭으로 늘리면 칸이 화면 폭을 다 쓴다. 행은 시즌 히트존 모드로 고정한다 -
// 5px짜리 칸은 손가락으로 집을 수 없다.
export type CareerStripRow = { seasonName: string; result: CareerStripResult };
export type CareerStripRowsResult = { rows: CareerStripRow[]; note: string };

export function buildCareerStripRowsSvg(
  grain: CareerGrain,
  opts: Omit<CareerStripOptions, "range" | "recentN" | "width" | "detail"> & { rowHeight?: number }
): CareerStripRowsResult | null {
  const all = grain.nights;
  if (!all.length) return null;
  const blocks = blocksOf(all);
  const lastYear = Number(blocks[blocks.length - 1].seasonName.slice(0, 4));
  const trailingGap = grain.gapSeasons.some((s) => Number(s.slice(0, 4)) > lastYear);
  const rows: CareerStripRow[] = [];
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    const len = b.end - b.start + 1;
    const isLast = k === blocks.length - 1;
    const r = buildCareerStripSvg(grain, {
      ...opts,
      uid: `${opts.uid}r${b.seasonName.slice(0, 4)}`,
      range: { start: b.start, end: b.end + 1 },
      width: len * CELL_MAX_W + PAD_L + PAD_R + (isLast && trailingGap ? GAP_RESERVE : 0),
      // 75 = 라벨 줄 13 + 막대 50 + 레일 12. 여기서 정하는 건 **막대 띠 50**뿐이다(라벨 줄과
      // 최종 뷰박스 높이는 빌더가 구간별 글자에서 거꾸로 잡는다 - 행은 W가 시즌마다 달라
      // 320px에서 필요한 글자가 27~32단위로 갈린다). 예전 고정값(높이 100·글자 2.9배)은
      // 320px에서 최장 시즌+공백 표식이 9.96px로 바닥을 못 넘었다(검증자 실측).
      height: opts.rowHeight ?? 75,
      detail: "season",
      // 공백 시즌 표식은 행 안에 그리지 않는다 - 아래 note가 같은 사실을 문장으로 진다.
      gapMarkers: false,
      captionHead: `${shortSeason(b.seasonName)} 시즌 ${b.played}경기`,
    });
    if (r) rows.push({ seasonName: b.seasonName, result: r });
  }
  const gaps = grain.gapSeasons.length ? ` · 공백 시즌 ${grain.gapSeasons.map(shortSeason).join("·")}(기록 없음)` : "";
  const note = `${rows.length}시즌을 행으로 나눠 그림 · 행 하나 = 한 시즌, 칸 하나 = 한 경기 · 행을 누르면 그 시즌 기록${gaps}`;
  return { rows, note };
}
