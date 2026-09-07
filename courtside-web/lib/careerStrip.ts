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
   * 글자 배율(1 = 9단위). 뷰박스가 화면 폭보다 넓게 그려지는 곳에서만 키운다 - 확대판(1.5),
   * 모바일 행(2). 히어로 한 줄 띠는 1로 둔다(800단위를 900px에 그리므로 9단위 ≈ 10px).
   */
  fontScale?: number;
  /**
   * 칸 위에 그날 득점을, 이동평균선 끝에 창 평균을 적는다. 칸 폭 7단위 이상·칸 40개 이하일 때만
   * 실제로 찍힌다(그보다 촘촘하면 숫자가 서로를 덮는다). 확대판(L5~L30) 전용.
   */
  valueLabels?: boolean;
  /** 캡션 머리말 덮어쓰기 - 행 모드가 "21-22 시즌 54경기"처럼 시즌을 적는 데 쓴다. */
  captionHead?: string;
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
  const H = Math.max(48, opts.height ?? STRIP_DEFAULT_HEIGHT);
  // 글자 배율. 라벨 줄(PAD_T)도 같이 키워야 커진 글자가 막대를 덮지 않는다.
  const FS = Math.max(1, opts.fontScale ?? 1);
  const f9 = n1(9 * FS);

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
  const MONO = "IBM Plex Mono, monospace";

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
  const BASE = H - PAD_B;
  const TOP = Math.round(PAD_T * FS);
  const bandH = BASE - TOP;
  const x0 = (i: number) => PAD_L + i * cw;
  const xc = (i: number) => PAD_L + i * cw + cw / 2;

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
  const showValues = !!opts.valueLabels && mode === "cell" && cw >= 7 && N <= 40;
  if (showValues) {
    const fv = n1(8 * FS);
    parts.push(`<g pointer-events="none" font-family="${MONO}" font-size="${fv}" font-weight="700" text-anchor="middle" fill="${ink(0.85)}">`);
    for (let i = 0; i < N; i++) {
      const n = nights[i];
      if (n.kind !== "played" || n.pts <= 0) continue;
      const y = Math.max(TOP + 7 * FS, yOf(n.pts) - 2.5);
      parts.push(`<text x="${n1(xc(i))}" y="${n1(y)}">${n.pts}</text>`);
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
    // 확대판에서는 선의 끝에 창 평균을 적어 "지금 흐름이 몇 점인지"를 숫자로 닫는다.
    if (showValues) {
      let lastIdx = -1;
      for (let i = N - 1; i >= 0; i--) if (nights[i].kind === "played" && ma[i] != null) { lastIdx = i; break; }
      if (lastIdx >= 0) {
        const v = ma[lastIdx] as number;
        const px = xc(lastIdx);
        const py = BASE - (v / denom) * bandH;
        const fv = n1(8.5 * FS);
        const label = `${maWindow}경기 평균 ${v.toFixed(1)}`;
        const anchor = px > W * 0.6 ? "end" : "start";
        const tx = anchor === "end" ? px - 6 : px + 6;
        const ty = Math.max(TOP + 8 * FS, py - 6);
        parts.push(
          `<g pointer-events="none" font-family="${MONO}" font-size="${fv}" font-weight="700" text-anchor="${anchor}">` +
            `<text x="${n1(tx)}" y="${n1(ty)}" fill="${haloColor}" stroke="${haloColor}" stroke-width="3" stroke-linejoin="round">${esc(label)}</text>` +
            `<text x="${n1(tx)}" y="${n1(ty)}" fill="${lineColor}">${esc(label)}</text></g>`
        );
      }
    }
  }

  // ── 9. 축 라벨(연도 또는 월) + 득점 축 상한 ────────────────────────────────────────
  const scaleLabel = `${maxPts}점`;
  const scaleX = Math.min(W - 2, PAD_L + N * cw + reserve);
  parts.push(`<text x="${n1(scaleX)}" y="${n1(TOP - 4)}" font-size="${f9}" text-anchor="end" fill="${ink(0.55)}" font-family="${MONO}">${esc(scaleLabel)}</text>`);
  // 9px 모노 기준 대략폭(한글 글리프는 두 배 가까이 넓다) - 연도 라벨이 축 상한 라벨을 밟지 않게.
  const textW = (s: string) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 127 ? 9 : 5.4) * FS, 0);
  const labelGuard = scaleX - textW(scaleLabel) - 8;

  let lastLabelX = -99;
  const pushLabel = (x: number, text: string, alpha: number) => {
    if (x - lastLabelX < 22 * FS || x > labelGuard) return;
    parts.push(`<text x="${n1(x + 2)}" y="${n1(TOP - 4)}" font-size="${f9}" fill="${ink(alpha)}" font-family="${MONO}">${esc(text)}</text>`);
    lastLabelX = x;
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
  // 실측: 패리스 배스(291671)는 23-24만 뛰고 26-27 명단에 있다 - 24-25·25-26이 공백이다.
  const gapGroups = new Map<number, string[]>();
  for (const s of grain.gapSeasons) {
    const y = Number(s.slice(0, 4));
    const at = blocks.findIndex((b) => Number(b.seasonName.slice(0, 4)) > y);
    if (at < 0) {
      if (!reachesEnd) continue; // 잘린 구간 뒤의 공백은 이 화면의 사실이 아니다
      const arr = gapGroups.get(N) ?? [];
      arr.push(s);
      gapGroups.set(N, arr);
      continue;
    }
    if (blocks[at].start === 0) continue; // 자른 구간보다 앞 - 화면 밖
    const arr = gapGroups.get(blocks[at].start) ?? [];
    arr.push(s);
    gapGroups.set(blocks[at].start, arr);
  }
  for (const [idx, list] of gapGroups) {
    const trailing = idx === N;
    const x = trailing ? PAD_L + N * cw + 9 : x0(idx);
    const label = list.length <= 2 ? list.map(shortSeason).join("·") : `${shortSeason(list[0])}~${shortSeason(list[list.length - 1])}`;
    const anchor = trailing ? "start" : "middle";
    const tx = trailing ? x + 4 : x;
    parts.push(
      `<g><title>${esc(`${list.join(" · ")} KBL 출전 기록 없음`)}</title>` +
        `<line x1="${n1(x)}" y1="${n1(TOP - 4)}" x2="${n1(x)}" y2="${n1(BASE + 8)}" stroke="${ink(0.34)}" stroke-width="1" stroke-dasharray="2 3"/>` +
        `<text x="${n1(tx)}" y="${n1(TOP + 9 * FS)}" font-size="${f9}" text-anchor="${anchor}" fill="${ink(0.6)}" font-family="${MONO}">${esc(label)}</text>` +
        `<text x="${n1(tx)}" y="${n1(TOP + 20 * FS)}" font-size="${f9}" text-anchor="${anchor}" fill="${ink(0.42)}" font-family="${MONO}">기록 없음</text></g>`
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
      // 글자 배율 2면 라벨 줄(PAD_T)이 26단위가 된다 - 40으로 두면 막대 띠(bandH)가 2단위만 남아
      // 아무것도 안 보인다(초안의 실수). 80 = 라벨 26 + 막대 42 + 레일 12.
      height: opts.rowHeight ?? 80,
      detail: "season",
      fontScale: opts.fontScale ?? 2,
      captionHead: `${shortSeason(b.seasonName)} 시즌 ${b.played}경기`,
    });
    if (r) rows.push({ seasonName: b.seasonName, result: r });
  }
  const gaps = grain.gapSeasons.length ? ` · 공백 시즌 ${grain.gapSeasons.map(shortSeason).join("·")}(기록 없음)` : "";
  const note = `${rows.length}시즌을 행으로 나눠 그림 · 행 하나 = 한 시즌, 칸 하나 = 한 경기 · 행을 누르면 그 시즌 기록${gaps}`;
  return { rows, note };
}
