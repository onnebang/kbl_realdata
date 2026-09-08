import Link from "next/link";
import {
  FORM_METRIC_BY_KEY,
  FORM_PCT_DEFS,
  FORM_PCT_KEYS,
  FORM_QUALIFY,
  FORM_RATE_DEFS,
  FORM_THIN_POSS,
  PER_MIN_BASE,
  PER_POSS_BASE,
  deltaTone,
  formatDelta,
  formatRate,
  vsLeague,
  type FormMetricDef,
  type FormPctKey,
  type FormRateKey,
  type FormRow,
  type PlayerForm,
} from "@/lib/playerForm";
import styles from "./PlayerForm.module.css";

// ── 다중 시즌 폼 패널 ────────────────────────────────────────────────────────────────
// 요청: "선수들 폼을, 최근 5경기가 아닌, 많은 시즌을 비교, 그리고 그 이전 시즌을 비교하는
// 느낌으로". 그래서 이 패널의 주인공은 '최근 N경기'가 아니라 '시즌 × 비율' 표이고, 모든
// 시즌 행이 바로 앞 시즌 대비 변화(Δ)를 값 밑에 달고 있다.
//
// 왜 경기당이 아니라 75포제션당이 기본인가: 경기당(PPG/RPG/APG)에는 출전 시간과 팀 페이스가
// 섞여 있어 "역할이 어떻게 바뀌었나"를 못 읽는다. 실측 예 - 조은후 25-26의 APG는 0.5(퍼센타일
// 29)지만 75포제션당 어시스트는 4.7로 리그 평균 3.80의 1.24배다. 같은 선수, 정반대 인상.
//
// 참고 자료(Thinking-Basketball "Per 75 stats")의 75는 경기 수가 아니라 포제션 수다.
// 사용자가 처음 '75경기'로 읽었으므로 이 파일에서 나가는 모든 문자열은 '75포제션당'이라고
// 적는다 - '75경기'라는 문자열은 어디에도 없어야 한다.
//
// 렌더링 규칙(프로젝트 하드 룰):
//   - 클라이언트 컴포넌트 금지. 단위 전환은 쿼리스트링 링크, 접기는 <details>로만.
//   - 차트는 raw SVG 문자열 + dangerouslySetInnerHTML. JSX <svg> 안에 JSX <title> 금지
//     (React 19가 문서 title로 끌어올린다) - 아래 스파크라인은 문자열 안의 native <title>이다.
//   - 애니메이션은 prefers-reduced-motion: no-preference 안에서만. 정지 선언이 완성된 그림.
//   - Big Shoulders Display에는 한글 글리프가 없다 - 한글은 절대 넣지 않는다. 이 파일에서
//     Big Shoulders를 쓰는 곳은 라틴 약어(PTS/REB/AST/TS%)와 숫자뿐이다(.hShort/.tBig).

export type FormRateUnit = "per75" | "per40";
export type FormMetricKey = FormRateKey | FormPctKey;

/** 단위 토글의 두 선택지. label은 한글이므로 Pretendard로만 그린다. */
export const FORM_UNIT_OPTIONS: { unit: FormRateUnit; label: string; head: string; note: string }[] = [
  {
    unit: "per75",
    label: `${PER_POSS_BASE}포제션당`,
    head: `${PER_POSS_BASE}포제션당(추정)`,
    note: `공격 기회 ${PER_POSS_BASE}번당 생산. 팀 페이스와 출전 시간을 함께 걷어낸 값이라 시즌 간 역할 비교에 맞다.`,
  },
  {
    unit: "per40",
    label: `${PER_MIN_BASE}분당`,
    head: `${PER_MIN_BASE}분당`,
    note: `한 경기(${PER_MIN_BASE}분)를 다 뛰었다면. 포제션 추정이 개입하지 않는 대조군이다 - 대신 팀 페이스가 남아 있다.`,
  },
];

export const FORM_DEFAULT_UNIT: FormRateUnit = "per75";

/** searchParams의 원문을 단위로 해석. 모르는 값은 전부 기본값(75포제션당). */
export function resolveFormUnit(raw: string | string[] | undefined | null): FormRateUnit {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "per40" ? "per40" : FORM_DEFAULT_UNIT;
}

/**
 * 표의 열 묶음. 참고 카드(DARKO)처럼 성격이 같은 지표를 붙여 놓아야 12열짜리 표가 읽힌다.
 * columns prop은 이 묶음 안에서 걸러내기만 한다 - 순서를 호출부가 흔들면 묶음 제목이 거짓이 된다.
 */
export const FORM_COLUMN_GROUPS: { label: string; keys: FormMetricKey[] }[] = [
  { label: "생산", keys: ["pts", "reb", "ast"] },
  { label: "수비·실책", keys: ["stl", "blk", "tov"] },
  { label: "슛 시도", keys: ["fga", "tpa", "ftm"] },
  { label: "효율", keys: ["ts", "efg", "usg"] },
];

/** 카드 4장의 기본 지표. 득점·리바운드·어시스트 + 효율 하나면 "어떤 선수인가"가 한 줄로 선다. */
export const FORM_DEFAULT_TREND_KEYS: FormMetricKey[] = ["pts", "reb", "ast", "ts"];

/**
 * 표본 세 열(GP/MIN/POSS)이 무엇인지. 라이브러리의 sample 문장("50경기 · 1,685분 · 추정
 * 2,993포제션")을 세 칸으로 펼친 것이라, 각 행의 title에 그 원문이 그대로 붙어 있다.
 */
const SAMPLE_COLUMN_NOTE =
  "GP는 실제 출전 경기(0분 엔트리 제외), MIN은 출전 분, POSS는 추정 온코트 포제션이다. " +
  "행 이름에 마우스를 올리면 라이브러리가 만든 표본 문장이 그대로 뜬다(0분 엔트리가 있으면 엔트리 수도 함께).";

export type PlayerFormPanelProps = {
  /** lib/playerForm.ts getPlayerForm()의 결과. 이 컴포넌트는 조회를 하지 않는다. */
  form: PlayerForm;
  /** 현재 단위. 보통 resolveFormUnit(searchParams.rate). 기본 "per75". */
  unit?: FormRateUnit;
  /** 단위 토글 링크가 유지해야 할 나머지 쿼리(?w=15&season=...). 페이지의 searchParams를 그대로. */
  query?: Record<string, string | string[] | undefined>;
  /** 단위를 싣는 쿼리 파라미터 이름. 기본 "rate". */
  unitParam?: string;
  /** tcode -> 팀 약칭. 페이지가 이미 만든 teamAbbrs를 그대로 넘기면 된다. 없으면 코드를 그대로 쓴다. */
  teamAbbrs?: Map<string, string>;
  /** 카드로 뽑을 지표. 기본 FORM_DEFAULT_TREND_KEYS. */
  trendKeys?: FormMetricKey[];
  /** 표에 남길 지표(FORM_COLUMN_GROUPS 안에서 걸러짐). 기본 전체 12개. */
  columns?: FormMetricKey[];
  /** 패널 제목. 기본 "시즌별 폼". */
  title?: string;
  /** 제목 옆 칩(페이지의 basisChip/statSeasonChip 결과). */
  chip?: string | null;
  /** 앵커 링크용 id. */
  id?: string;
};

// ---------------------------------------------------------------------------
// 값 꺼내기 - 단위(per75/per40)와 비율(%)의 분기를 한 곳에만 둔다
// ---------------------------------------------------------------------------

function isPctKey(key: FormMetricKey): key is FormPctKey {
  return (FORM_PCT_KEYS as readonly string[]).includes(key);
}

function rateValue(row: FormRow, key: FormMetricKey, unit: FormRateUnit): number | null {
  if (isPctKey(key)) return row.rates.pct[key];
  return row.rates[unit][key];
}

function deltaValue(row: FormRow, key: FormMetricKey, unit: FormRateUnit): number | null {
  if (!row.delta) return null;
  if (isPctKey(key)) return row.delta.pct[key];
  return row.delta[unit][key];
}

function leagueValue(row: FormRow, key: FormMetricKey, unit: FormRateUnit): number | null {
  if (!row.league) return null;
  if (isPctKey(key)) return row.league.pct[key];
  return row.league[unit][key];
}

/**
 * 리그 평균 대비 배수. 75포제션당은 라이브러리의 vsLeague()를 그대로 쓴다 - 같은 정의가
 * 두 벌 생기면 언젠가 한쪽만 고쳐진다.
 */
function leagueMultiple(row: FormRow, key: FormRateKey, unit: FormRateUnit): number | null {
  if (unit === "per75") return vsLeague(row, key);
  const lg = row.league?.per40[key];
  if (lg == null || lg <= 0) return null;
  return row.rates.per40[key] / lg;
}

/**
 * 값을 흐리게 그릴지. 두 가지를 함께 덮는다 - (1) 비율 자격 미달(15경기·300분), (2) 75포제션당을
 * 볼 때 추정 포제션이 얇은 시즌(540 미만). 행을 지우지는 않는다: 조은후의 표와 워니의 표가
 * 같은 모양이어야 두 선수를 같은 눈으로 읽는다.
 */
function isDim(row: FormRow, unit: FormRateUnit): boolean {
  return !row.qualified || (unit === "per75" && row.thin);
}

/**
 * 표의 Δ에 좋고나쁨 색을 붙여도 되는가. 이 패널은 이미 두 곳 - 요약 문장(spanItems)과 카드
 * (prevComparable) - 에서 "양쪽 표본이 모두 하한을 넘겨야 변화를 주장한다"고 정해 두었다.
 * 표만 예외로 두면 같은 숫자를 카드는 "말할 수 없다"고 하고 표는 원색으로 단언하게 된다.
 * 실측: 조은후 22-23은 2경기 6분(추정 11포제션)인데 표가 득점 Δ -8.2를 빨강으로, 스틸 Δ
 * +4.6을 초록으로 찍고 있었다 - 11포제션에서 나온 -8.2는 방향조차 사실이라 보기 어렵다.
 * 값과 +/- 부호는 그대로 인쇄한다: 숨기는 게 아니라 신호라고 주장하지 않는 것이다.
 */
function deltaMuted(row: FormRow, byKey: Map<string, FormRow>, unit: FormRateUnit): boolean {
  if (isDim(row, unit)) return true;
  // 비교 상대(시즌 행은 앞 시즌, 최근 N 행은 최신 시즌, 플레이오프는 앞 플레이오프)도 같은
  // 하한을 넘겨야 한다. 상대를 못 찾으면 Δ 자체가 null이므로 muted 여부는 화면에 안 남는다.
  const base = row.prevKey ? byKey.get(row.prevKey) ?? null : null;
  return !base || isDim(base, unit);
}

function toneClass(tone: "good" | "bad" | "flat" | "neutral"): string {
  if (tone === "good") return styles.dGood;
  if (tone === "bad") return styles.dBad;
  if (tone === "neutral") return styles.dNeutral;
  return styles.dFlat;
}

const fmtInt = (v: number) => Math.round(v).toLocaleString();

/** 지표 헤더의 한글 보조 라벨. TS%/eFG%/USG%처럼 label과 short가 같으면 두 번 쓰지 않는다. */
function subLabel(def: FormMetricDef): string | null {
  return def.label === def.short ? null : def.label;
}

// ---------------------------------------------------------------------------
// 스파크라인(raw SVG 문자열)
// ---------------------------------------------------------------------------
//
// 눈금 없는 스파크라인은 인코딩인 척하는 장식이다. 그래서 도메인 양 끝을 눈금 단위로
// 내림/올림해서 잡고(라벨을 반올림해 인쇄하면 그림과 숫자가 미세하게 어긋난다), 그 두 숫자를
// 그림 밖 캡션(.tAxis "눈금 4.5 ~ 6.2")에, 가로축 양 끝 시즌을 그림 밑 한 줄(.tSpan)에 찍는다.
//
// 왜 글자가 SVG 안에 없는가: <text>의 font-size는 뷰박스 단위라 렌더 배율을 그대로 탄다.
// 이 카드의 그림은 뷰박스 300 폭인데 렌더 폭이 모바일 375px 화면에서 130.5px다(패널 12 +
// 카드 11 패딩을 걷어낸 2열 격자) - 배율 0.435. 예전의 font-size 8.5(눈금)와 8(x축)은 화면에서
// 3.7px · 3.5px로 찍혔다. 배율을 이기려면 font-size 27이 필요한데, 렌더 높이가 38~56px뿐인
// 그림에 12px 글자 두 줄을 얹으면 글자가 그림을 덮는다. 그래서 글자는 전부 HTML로 내렸다
// (숫자는 한 개도 사라지지 않았다 - 자리만 옮겼다).
//
// 도메인은 '선수 값'만으로 잡는다. 리그 기준선까지 넣으면 워니의 득점(27.8~30.0)이 리그
// 평균 16.3까지 늘어난 축 위에서 일직선이 되어 정작 보여야 할 추세가 사라진다. 대신
// 리그 선은 눈금 안에 들어올 때만 점선으로 그리고(조은후처럼 리그 평균 근처인 선수에게
// 딱 필요한 경우), 배수·차이는 카드 밑에 항상 문장으로 적는다.

const SPARK_W = 300;
const SPARK_H = 88;
// 글자가 나갔으니 왼쪽 34(눈금 숫자 자리)와 아래 17(x축 라벨 자리)도 함께 나간다. 남는 여백은
// 마지막 점의 후광 반지름(3.6 + 1.9 = 5.5)만 넘기면 된다 - 와이프 clip이 0..300/0..88이라
// 여기를 넘긴 점은 잘린다.
const SPARK_PAD = { l: 6, r: 8, t: 8, b: 8 };

type SparkPoint = {
  /** 시즌 라벨("19-20"). 툴팁 문장과 그림 밑 .tSpan 한 줄에 쓰인다. */
  label: string;
  value: number | null;
  league: number | null;
  /** 표본이 얇거나 자격 미달인 시즌 - 속 빈 점으로 그린다. */
  dim: boolean;
  /** 툴팁(한글 허용 - 브라우저 UI가 시스템 폰트로 그린다). */
  title: string;
};

type SparkResult = {
  svg: string;
  viewBox: string;
  /** 눈금 양 끝. 점이 하나뿐이면 눈금 자체가 의미 없어 null이다(캡션에서 지운다). */
  hi: string | null;
  lo: string | null;
  leagueInView: boolean;
  single: boolean;
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "") || "x";
}

function n1(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
}

/** null을 만나면 선을 끊는다(없는 시즌을 이어 그리면 없는 값을 주장하게 된다). */
function runs(values: (number | null)[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      if (cur.length) out.push(cur);
      cur = [];
      return;
    }
    cur.push(i);
  });
  if (cur.length) out.push(cur);
  return out;
}

function buildSparkSvg(points: SparkPoint[], opts: { uid: string; digits: number; pct: boolean }): SparkResult | null {
  const n = points.length;
  const vals = points.map((p) => p.value).filter((v): v is number => v != null && Number.isFinite(v));
  if (!vals.length) return null;

  const q = 10 ** opts.digits;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min;
  const pad = span > 0 ? span * 0.16 : Math.max(Math.abs(max) * 0.08, 1 / q);
  // 이 패널의 지표는 전부 음수가 될 수 없다(개수와 비율). 여백 때문에 바닥이 0 아래로
  // 내려가면 '리바운드 -0.9'라는 있을 수 없는 눈금을 인쇄하게 된다 - 조은후에게서 실제로 났다.
  const lo = Math.max(0, Math.floor((min - pad) * q) / q);
  const hi = Math.ceil((max + pad) * q) / q;
  const range = hi - lo || 1;
  // 점이 하나면 눈금은 임의의 여백일 뿐이라 숫자를 찍지 않는다(추세도 없다).
  const single = vals.length < 2;

  const { l: PL, r: PR, t: PT, b: PB } = SPARK_PAD;
  const plotW = SPARK_W - PL - PR;
  const plotH = SPARK_H - PT - PB;
  const xOf = (i: number) => (n === 1 ? PL + plotW / 2 : PL + (i / (n - 1)) * plotW);
  const yOf = (v: number) => PT + (1 - (v - lo) / range) * plotH;
  const axis = (v: number) => `${v.toFixed(opts.digits)}${opts.pct ? "%" : ""}`;

  const uid = safeId(opts.uid);
  const parts: string[] = [];

  // ── 눈금 두 줄(숫자는 캡션이 진다 - 위 주석) ───────────────────────────────────────
  if (!single) {
    for (const y of [PT, PT + plotH]) {
      parts.push(
        `<line x1="${PL}" y1="${n1(y)}" x2="${SPARK_W - PR}" y2="${n1(y)}" stroke="var(--ink-faint)" stroke-width="0.7" stroke-dasharray="2 3"/>`
      );
    }
  }

  // ── 리그 기준선(시즌마다 값이 다르므로 직선이 아니라 꺾은선) ────────────────────────
  const lgVals = points.map((p) => p.league);
  const leagueInView = lgVals.some((v) => v != null && Number.isFinite(v) && v >= lo && v <= hi);
  const lgRuns = runs(lgVals).filter((r) => r.length >= 2);
  if (lgRuns.length) {
    const body = lgRuns
      .map(
        (r) =>
          `<polyline points="${r.map((i) => `${n1(xOf(i))},${n1(yOf(lgVals[i] as number))}`).join(" ")}" fill="none" stroke="var(--ink-faint)" stroke-width="1.2" stroke-dasharray="3 3"/>`
      )
      .join("");
    // 눈금 밖으로 나가는 부분은 잘라 낸다 - 자르지 않으면 카드 밖으로 선이 흘러나간다.
    parts.push(`<g clip-path="url(#pfp-${uid})">${body}</g>`);
  }

  // ── 선수 선 ────────────────────────────────────────────────────────────────────────
  const pVals = points.map((p) => p.value);
  for (const r of runs(pVals).filter((x) => x.length >= 2)) {
    parts.push(
      `<polyline points="${r.map((i) => `${n1(xOf(i))},${n1(yOf(pVals[i] as number))}`).join(" ")}" fill="none" stroke="var(--home)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    );
  }

  // ── 점(시즌 하나 = 점 하나). 마지막 점만 크게 - 눈이 '지금'에 먼저 앉는다. ──────────
  points.forEach((p, i) => {
    if (p.value == null || !Number.isFinite(p.value)) return;
    const cx = n1(xOf(i));
    const cy = n1(yOf(p.value));
    const last = i === n - 1;
    const r = last ? 3.6 : 2.6;
    const halo = last ? `<circle cx="${cx}" cy="${cy}" r="${n1(r + 1.9)}" fill="var(--surface)"/>` : "";
    const dot = p.dim
      ? `<circle cx="${cx}" cy="${cy}" r="${n1(r)}" fill="var(--surface)" stroke="var(--home)" stroke-width="1.3" opacity="0.75"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${n1(r)}" fill="var(--home)"/>`;
    parts.push(`<g><title>${esc(p.title)}</title>${halo}${dot}<circle cx="${cx}" cy="${cy}" r="9" fill="transparent"/></g>`);
  });

  // x축 라벨은 여기서 그리지 않는다 - 그림 밑 .tSpan 한 줄이 양 끝 시즌을 12px로 인쇄한다.
  // (예전에는 시즌이 5개 이하면 다섯 개를 전부 SVG 안에 찍었는데, 12px로 키우면 "25-1226점"
  //  처럼 통째로 겹친다. 겹치는 라벨을 솎느니 두 끝만 남기고 밖으로 내보내는 쪽이 정직하다 -
  //  가운데 시즌 값은 점의 <title>과 아래 표에 그대로 있다.)

  // ── 그리기 애니메이션(왼→오 와이프 1회) ────────────────────────────────────────────
  // 정지 상태의 선언이 곧 완성된 그림이다(clip rect가 처음부터 전체 폭). 움직이는 요소는
  // 카드당 이 rect 하나뿐이고, no-preference 안에서만 존재한다.
  const style =
    `<style>@media (prefers-reduced-motion: no-preference){` +
    `.pfw-${uid}{transform-box:view-box;transform-origin:0 0;animation:pfw-${uid} .9s cubic-bezier(.22,.61,.36,1) both}` +
    `@keyframes pfw-${uid}{from{transform:scaleX(0)}to{transform:scaleX(1)}}}` +
    `</style>`;

  const defs =
    `<defs>` +
    `<clipPath id="pfw-${uid}" clipPathUnits="userSpaceOnUse"><rect class="pfw-${uid}" x="0" y="0" width="${SPARK_W}" height="${SPARK_H}"/></clipPath>` +
    `<clipPath id="pfp-${uid}" clipPathUnits="userSpaceOnUse"><rect x="${PL}" y="${PT}" width="${n1(plotW)}" height="${n1(plotH)}"/></clipPath>` +
    `</defs>`;

  return {
    svg: `${style}${defs}<g clip-path="url(#pfw-${uid})">${parts.join("")}</g>`,
    viewBox: `0 0 ${SPARK_W} ${SPARK_H}`,
    hi: single ? null : axis(hi),
    lo: single ? null : axis(lo),
    leagueInView,
    single,
  };
}

// ---------------------------------------------------------------------------
// 이야기 만들기 - "첫 시즌 대비 무엇이 가장 크게 움직였나"
// ---------------------------------------------------------------------------

type SpanChange = {
  def: FormMetricDef;
  from: number;
  to: number;
  /** 화면에 인쇄되는 두 끝값의 차이. 순위 매기기용 원값과 다를 수 있다 - 아래 주석 참고. */
  diff: number;
  scaled: number;
};

/**
 * 변화의 크기를 무슨 자로 재는가 - 이 패널에서 가장 중요한 판단이라 실측을 남긴다.
 *
 * (1) 절대값으로 줄을 세우면 스케일이 큰 득점·리바운드가 언제나 이기고 스틸·블록은 영영
 *     이야기가 되지 못한다.
 * (2) 리그 평균으로 나누면 정반대로 뒤집힌다. 블록의 리그 평균은 0.52라 +0.3만 움직여도
 *     환산값 0.58이 되어 어시스트 +1.5(리그 3.80 기준 0.39)를 이긴다 - 실제로 이 카드의
 *     첫 판이 워니에게 '가장 많이 오른 항목: 블록 1.0 → 1.3'을 내놓았다. 사실이지만 그의
 *     이야기가 아니다.
 * (3) 그래서 리그 평균의 제곱근으로 나눈다. 개수형 통계의 표준편차는 평균의 제곱근에
 *     비례하므로(포아송 계열의 분산 안정화 변환) 이 값은 "그 지표에서 자연스러운 변동 폭의
 *     몇 배만큼 움직였나"를 묻는 자가 된다.
 *
 * 워니 19-20 → 25-26에 적용한 실측: 어시스트 +0.77 · 리바운드 -0.63 · 자유투 -0.46 ·
 * 블록 +0.42 · 턴오버 -0.40 · 득점 -0.25. 어시스트 4.5 → 6.0과 리바운드 15.3 → 13.6이
 * 제자리를 찾는다 - 브리프가 "한눈에 보여야 한다"고 못 박은 바로 그 두 줄이다.
 */
function changeScore(diff: number, leagueAvg: number | null, fallback: number): number {
  const base = leagueAvg != null && leagueAvg > 0 ? leagueAvg : Math.max(Math.abs(fallback), 1);
  return diff / Math.sqrt(base);
}

/**
 * 이 값보다 작게 움직인 항목은 문장으로 만들지 않는다(잡음을 사건으로 만들지 않기 위해).
 * 실측 기준점: 워니의 25-26 직전 시즌 대비 블록 +0.1은 0.14로 잘려 나가고, 리바운드 -1.2는
 * 0.45로 남는다.
 */
const SPAN_MIN_SCALED = 0.2;

function spanChanges(first: FormRow, last: FormRow, unit: FormRateUnit): SpanChange[] {
  const out: SpanChange[] = [];
  for (const def of FORM_RATE_DEFS) {
    // 시도 수(FGA/3PA)는 많고 적음이 스타일이지 우열이 아니라서 '올랐다/내렸다' 문장에 넣지 않는다.
    if (def.neutral) continue;
    const key = def.key as FormRateKey;
    const a = first.rates[unit][key];
    const b = last.rates[unit][key];
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const lg = last.league ? last.league[unit][key] : null;
    // 한 줄에 '4.5 → 6.0 (+1.4)'처럼 세 숫자가 나란히 서므로, 인쇄되는 변화량은 원값의 차이가
    // 아니라 인쇄되는 두 끝값의 차이여야 한다(워니 실측: 원값 4.54 → 5.98이라 raw는 +1.4지만
    // 화면의 4.5와 6.0을 빼면 +1.5다 - 독자에게는 그냥 계산 오류로 보인다).
    // 순위(scaled)는 반올림 전 원값으로 매긴다.
    const q = 10 ** def.digits;
    const shown = Math.round(b * q) / q - Math.round(a * q) / q;
    out.push({ def, from: a, to: b, diff: shown, scaled: changeScore(b - a, lg, Math.max(Math.abs(a), Math.abs(b))) });
  }
  return out;
}

/** 직전 시즌 대비 변화 중 큰 것부터. 방향 없는 지표는 뺀다(색도 문장도 붙일 수 없다). */
function prevDeltaHighlights(row: FormRow, unit: FormRateUnit, limit: number): { def: FormMetricDef; diff: number }[] {
  if (!row.delta) return [];
  const scored: { def: FormMetricDef; diff: number; scaled: number }[] = [];
  for (const def of FORM_RATE_DEFS) {
    if (def.neutral) continue;
    const key = def.key as FormRateKey;
    const d = row.delta[unit][key];
    if (d == null || !Number.isFinite(d)) continue;
    const lg = row.league ? row.league[unit][key] : null;
    scored.push({ def, diff: d, scaled: Math.abs(changeScore(d, lg, row.rates[unit][key])) });
  }
  scored.sort((a, b) => b.scaled - a.scaled);
  const out = scored.filter((s) => s.scaled >= SPAN_MIN_SCALED).slice(0, limit).map((s) => ({ def: s.def, diff: s.diff }));
  // 효율은 크기와 무관하게 늘 한 칸 붙인다 - 생산이 그대로여도 TS%가 움직이면 다른 선수다.
  const ts = row.delta.pct.ts;
  if (ts != null && Number.isFinite(ts)) out.push({ def: FORM_METRIC_BY_KEY.ts, diff: ts });
  return out;
}

// ---------------------------------------------------------------------------
// 작은 조각들
// ---------------------------------------------------------------------------

/**
 * muted: 값은 그대로 두되 좋고나쁨 색을 쓰지 않는다. 두 시즌 중 한쪽이라도 표본 하한을 못
 * 넘겼을 때 쓴다 - 숫자를 숨기지는 않지만(표에도 같은 값이 있다) 신호라고 주장하지도 않는다.
 */
function DeltaText({ mkey, value, muted }: { mkey: FormMetricKey; value: number | null; muted?: boolean }) {
  if (value == null || !Number.isFinite(value)) {
    // 비교할 직전 시즌이 없는 행(첫 시즌·커리어·리그). '-'는 '값이 0'으로도 읽히므로 em대시.
    return <span className={`${styles.cellD} ${styles.dNone}`}>—</span>;
  }
  const cls = muted ? styles.dFlat : toneClass(deltaTone(mkey, value));
  return <span className={`${styles.cellD} ${cls}`}>{formatDelta(mkey, value)}</span>;
}

function MetricHead({ def }: { def: FormMetricDef }) {
  const sub = subLabel(def);
  return (
    <th scope="col" className={styles.mHead} title={def.note ?? undefined}>
      <span className={styles.hShort}>{def.short}</span>
      {sub && <span className={styles.hLabel}>{sub}</span>}
    </th>
  );
}

function hrefWith(
  query: Record<string, string | string[] | undefined> | undefined,
  param: string,
  value: string
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (k === param || v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, v);
  }
  sp.set(param, value);
  return `?${sp.toString()}`;
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export function PlayerFormPanel({
  form,
  unit = FORM_DEFAULT_UNIT,
  query,
  unitParam = "rate",
  teamAbbrs,
  trendKeys = FORM_DEFAULT_TREND_KEYS,
  columns,
  title = "시즌별 폼",
  chip,
  id,
}: PlayerFormPanelProps) {
  const unitMeta = FORM_UNIT_OPTIONS.find((o) => o.unit === unit) ?? FORM_UNIT_OPTIONS[0];
  const abbr = (tcode: string) => teamAbbrs?.get(tcode) ?? tcode;

  // 표에 실제로 그릴 행: 최근 N -> 시즌(옛->최신) -> 커리어. '최근'을 맨 위에 두는 이유는
  // 이 패널이 최근 폼 읽기를 지우는 게 아니라 시즌 비교를 그 위에 얹는 것이기 때문이다.
  const seasons = form.seasons;
  const bodyRows: FormRow[] = [
    ...(form.recent ? [form.recent] : []),
    ...seasons,
    ...(form.career ? [form.career] : []),
  ];

  if (!bodyRows.length) {
    return (
      <section className={styles.panel} id={id}>
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          {chip && <span className={styles.chip}>{chip}</span>}
        </div>
        {/* 출전이 0이면 캡션(포제션 공식·시즌 수)은 '0시즌 정규시즌 · 추정 온코트 포제션 = ...'이
            되어 문장이 깨진다. 없는 표를 설명하지 않고 왜 비었는지만 적는다. */}
        <div className="empty-note">출전 기록이 없어 시즌 비율을 만들 수 없다</div>
      </section>
    );
  }

  const allow = columns ? new Set<FormMetricKey>(columns) : null;
  const groups = FORM_COLUMN_GROUPS.map((g) => ({
    label: g.label,
    keys: allow ? g.keys.filter((k) => allow.has(k)) : g.keys,
  })).filter((g) => g.keys.length > 0);
  const metricKeys = groups.flatMap((g) => g.keys);

  const latest = seasons.length ? seasons[seasons.length - 1] : null;
  // Δ의 기준 행을 key로 되찾기 위한 색인. 시즌 행과 '최근 N' 행은 시즌 목록을, 플레이오프
  // 행은 플레이오프 목록을 가리킨다(lib/playerForm.ts가 그렇게 엮는다).
  const seasonByKey = new Map(seasons.map((s) => [s.key, s]));
  const playoffByKey = new Map(form.playoffs.map((s) => [s.key, s]));

  // ── 첫 시즌 -> 최근 시즌: 가장 크게 오른 것과 내린 것 ────────────────────────────
  // 요약 문장은 '표본 하한을 넘긴 시즌' 두 개가 있을 때만 만든다. 하한 미달 시즌을 양 끝에
  // 놓으면 잡음이 사건이 된다 - 실측: 조은후의 21-22는 9경기 79분(추정 146포제션)이라
  // 25-26과 이으면 '득점 14.9 → 5.7'이라는 -9.2짜리 헤드라인이 나온다. 그의 5개 시즌은
  // 전부 하한 미달이므로 여기서는 요약을 아예 만들지 않고, 왜 안 만드는지를 문장으로 적는다.
  // (표·카드·리그 배수는 그대로 남는다 - 조은후의 진짜 사실인 '어시스트 4.7 = 리그 1.23배'는
  //  거기서 읽힌다.)
  const solid = seasons.filter((s) => !isDim(s, unit));
  const spanFirst = solid.length >= 2 ? solid[0] : null;
  const spanLast = solid.length >= 2 ? solid[solid.length - 1] : null;
  const spanSkipped = solid.length >= 2 && solid.length < seasons.length;
  const changes = spanFirst && spanLast ? spanChanges(spanFirst, spanLast, unit) : [];
  const riser = changes.length ? changes.reduce((a, b) => (b.scaled > a.scaled ? b : a)) : null;
  const faller = changes.length ? changes.reduce((a, b) => (b.scaled < a.scaled ? b : a)) : null;
  const spanItems = [
    riser && riser.scaled >= SPAN_MIN_SCALED ? { head: "가장 많이 오른 항목", c: riser } : null,
    faller && faller.scaled <= -SPAN_MIN_SCALED ? { head: "가장 많이 내린 항목", c: faller } : null,
  ].filter((x): x is { head: string; c: SpanChange } => x != null);

  // 직전 시즌 대비 칩도 같은 규칙 - 양쪽 시즌이 모두 하한을 넘어야 변화를 주장한다.
  const prevRow = latest?.prevKey ? seasons.find((s) => s.key === latest.prevKey) ?? null : null;
  const prevComparable = !!latest && !!prevRow && !isDim(latest, unit) && !isDim(prevRow, unit);
  const prevHighlights = latest && prevComparable ? prevDeltaHighlights(latest, unit, 3) : [];
  // 요약을 못 만든 이유를 한 줄로. 시즌이 하나뿐인 선수에게는 굳이 말하지 않는다(자명하다).
  const summaryBlocked =
    seasons.length >= 2 && spanItems.length === 0 && prevHighlights.length === 0 && solid.length < 2;
  const noteRows = bodyRows.filter((r) => r.note);

  return (
    <section className={styles.panel} id={id}>
      <div className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        <span className={styles.chip}>{unitMeta.head}</span>
        {form.seasonsPlayed > 0 && <span className={styles.chip}>{form.seasonsPlayed}시즌 정규시즌</span>}
        {chip && <span className={styles.chip}>{chip}</span>}
      </div>

      <p className={styles.lede}>
        최근 몇 경기가 아니라 <b>시즌 전체를 비율로</b> 나란히 놓는다. 값 밑의 작은 숫자는 <b>바로 앞 시즌 대비 변화</b>다.
      </p>

      {/* 단위 토글 - 클라이언트 상태가 아니라 쿼리스트링 링크(나머지 쿼리는 그대로 유지). */}
      <div className={styles.toggleRow} role="group" aria-label="비율 단위">
        {FORM_UNIT_OPTIONS.map((o) => (
          <Link
            key={o.unit}
            href={hrefWith(query, unitParam, o.unit)}
            scroll={false}
            className={`${styles.toggle} ${o.unit === unit ? styles.toggleActive : ""}`}
            aria-current={o.unit === unit ? "true" : undefined}
          >
            {o.label}
          </Link>
        ))}
        <span className={styles.toggleNote}>{unitMeta.note}</span>
      </div>

      {/* ── 커리어 폭의 이야기 한 줄 ────────────────────────────────────────────────
          워니라면 여기서 '어시스트 4.5 → 6.0'과 '리바운드 15.3 → 13.6'이 나란히 선다.
          표를 읽지 않아도 무엇이 달라졌는지가 먼저 보이게 하는 자리다. */}
      {spanFirst && spanLast && spanItems.length > 0 && (
        <div className={styles.spanBox}>
          <div className={styles.spanHead}>
            {spanFirst.label} → {spanLast.label} 사이의 변화
            {spanSkipped && <span className={styles.spanWarn}>표본 하한을 넘긴 시즌끼리만 비교</span>}
          </div>
          <div className={styles.spanGrid}>
            {spanItems.map(({ head, c }) => (
              <div className={styles.spanItem} key={c.def.key}>
                <div className={styles.spanKicker}>{head}</div>
                <div className={styles.spanLine}>
                  <span className={styles.spanName}>{c.def.label}</span>
                  <span className={styles.spanNums}>
                    {formatRate(c.def.key, c.from)} <span className={styles.spanArrow}>→</span> {formatRate(c.def.key, c.to)}
                  </span>
                  <span className={`${styles.spanDelta} ${toneClass(deltaTone(c.def.key, c.diff))}`}>
                    {formatDelta(c.def.key, c.diff)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 요약을 만들 표본이 없을 때는 빈칸으로 두지 않고 왜 없는지를 적는다. 없는 문장을
          지어내지 않는 것이 이 패널의 값이다. */}
      {summaryBlocked && (
        <div className={styles.spanBox}>
          <div className={styles.spanHead}>시즌 간 변화를 한 줄로 요약하지 않는다</div>
          <p className={styles.spanWhy}>
            {seasons.length}개 시즌 중 표본 하한(추정 {FORM_THIN_POSS}포제션 · {FORM_QUALIFY.gp}경기 또는 {FORM_QUALIFY.min}분)을
            넘긴 시즌이 {solid.length === 0 ? "하나도 없다" : `${solid.length}개뿐이다`}. 이 표본으로 &lsquo;무엇이 올랐다&rsquo;를
            문장으로 만들면 잡음을 사건으로 바꾸게 된다. 아래 표의 값과 표본(GP · MIN · POSS)을 함께 볼 것 — 시즌별 값과 리그 평균 대비 위치는 그대로 남아 있다.
          </p>
        </div>
      )}

      {/* ── 직전 시즌 대비(요청의 "그 이전 시즌을 비교하는 느낌") ─────────────────── */}
      {latest && prevHighlights.length > 0 && prevRow && (
        <div className={styles.deltaRow}>
          <span className={styles.deltaHead}>
            {latest.label} · 직전 시즌({prevRow.label}) 대비
          </span>
          {prevHighlights.map((h) => (
            <span key={h.def.key} className={`${styles.deltaChip} ${toneClass(deltaTone(h.def.key, h.diff))}`}>
              {h.def.label} {formatDelta(h.def.key, h.diff)}
            </span>
          ))}
        </div>
      )}

      {/* ── 지표 카드 + 스파크라인 ────────────────────────────────────────────────── */}
      {seasons.length > 0 && (
        <div className={styles.trendGrid}>
          {trendKeys.map((key) => {
            const def = FORM_METRIC_BY_KEY[key];
            if (!def) return null;
            const pct = isPctKey(key);
            const points: SparkPoint[] = seasons.map((s) => {
              const v = rateValue(s, key, unit);
              const d = deltaValue(s, key, unit);
              const dim = isDim(s, unit);
              return {
                label: s.label,
                value: v,
                league: leagueValue(s, key, unit),
                dim,
                title:
                  `${s.label} ${def.label} ${formatRate(key, v)}` +
                  (d != null ? ` (${formatDelta(key, d)})` : "") +
                  ` · ${s.sample}` +
                  (dim ? " · 표본 하한 미달" : ""),
              };
            });
            const spark = buildSparkSvg(points, { uid: `${form.pcode}-${key}-${unit}`, digits: def.digits, pct });
            const last = seasons[seasons.length - 1];
            const lastV = rateValue(last, key, unit);
            const lastD = deltaValue(last, key, unit);
            const lg = leagueValue(last, key, unit);
            const mult = pct ? null : leagueMultiple(last, key as FormRateKey, unit);
            const lgDiff = pct && lg != null && lastV != null ? lastV - lg : null;

            return (
              <figure className={styles.trendCard} key={key}>
                <figcaption className={styles.tHead}>
                  <span className={styles.tShort}>{def.short}</span>
                  {subLabel(def) && <span className={styles.tLabel}>{def.label}</span>}
                </figcaption>
                <div className={styles.tTop}>
                  <span className={`${styles.tBig} ${isDim(last, unit) ? styles.tBigDim : ""}`}>{formatRate(key, lastV)}</span>
                  <span className={styles.tUnit}>{last.label}</span>
                  <DeltaText mkey={key} value={lastD} muted={!prevComparable} />
                </div>
                {spark ? (
                  <>
                    <svg
                      className={styles.tSpark}
                      viewBox={spark.viewBox}
                      preserveAspectRatio="xMidYMid meet"
                      role="img"
                      aria-label={`${def.label} 시즌 추이 ${points.map((p) => `${p.label} ${formatRate(key, p.value)}`).join(", ")}`}
                      dangerouslySetInnerHTML={{ __html: spark.svg }}
                    />
                    {/* 가로축. SVG 안 <text>는 뷰박스 배율을 타서 모바일에서 3.5px이 됐다 -
                        여기 HTML 12px 한 줄이면 배율과 무관하다. 그림 안 시즌은 점의 <title>과
                        svg의 aria-label이 이미 다 부르므로 화면 낭독기에는 감춘다. */}
                    {seasons.length > 1 && (
                      <div className={styles.tSpan} aria-hidden="true">
                        <span>{seasons[0].label}</span>
                        <span>{seasons[seasons.length - 1].label}</span>
                      </div>
                    )}
                    {/* '눈금'은 한글이라 캡션 전체가 본문 폰트다(.tAxis). 숫자만 모노로 되돌려
                        가로축 줄(.tSpan)과 같은 얼굴로 읽히게 한다(.tAxisNum). */}
                    <div className={styles.tAxis}>
                      {spark.single ? (
                        "그릴 수 있는 시즌이 하나라 추세선은 없다"
                      ) : (
                        <>
                          눈금 <span className={styles.tAxisNum}>{spark.lo} ~ {spark.hi}</span>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <div className={styles.tAxis}>이 지표를 그릴 표본이 없다</div>
                )}
                <div className={styles.tFoot}>
                  {lg != null ? (
                    <>
                      리그 평균 {formatRate(key, lg)}
                      {mult != null && ` · 이 선수 ${mult.toFixed(2)}배`}
                      {lgDiff != null && ` · 이 선수 ${formatDelta(key, lgDiff)}`}
                      {spark?.leagueInView ? " (점선)" : " · 눈금 밖"}
                    </>
                  ) : (
                    "리그 기준선 없음"
                  )}
                </div>
              </figure>
            );
          })}
        </div>
      )}

      {/* ── 표 ────────────────────────────────────────────────────────────────────── */}
      {/* 범례는 스크롤 컨테이너 '밖'에 둔다 - <caption>으로 표 안에 넣으면 표를 오른쪽으로
          밀 때 범례도 같이 밀려 나가 정작 필요한 순간에 사라진다(실측). */}
      <p className={styles.tableNote}>
        큰 숫자 = {unitMeta.head} · 작은 숫자 = 직전 시즌 대비 변화(비율 지표는 %p) · 흐린 행은 표본 하한 미달 · 표는 좌우로 스크롤된다
      </p>
      <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={`${title} 표`}>
        <table className={styles.table} aria-label={`시즌별 ${unitMeta.head} 비율표`}>
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className={`${styles.stickyCol} ${styles.headCell}`}>
                <span className={styles.hShort}>SEASON</span>
                <span className={styles.hLabel}>시즌</span>
              </th>
              <th scope="colgroup" colSpan={3} className={styles.groupHead}>
                표본
              </th>
              {groups.map((g) => (
                <th scope="colgroup" colSpan={g.keys.length} className={styles.groupHead} key={g.label}>
                  {g.label}
                </th>
              ))}
            </tr>
            <tr>
              <th scope="col" className={styles.mHead}>
                <span className={styles.hShort}>GP</span>
                <span className={styles.hLabel}>출전</span>
              </th>
              <th scope="col" className={styles.mHead}>
                <span className={styles.hShort}>MIN</span>
                <span className={styles.hLabel}>분</span>
              </th>
              <th scope="col" className={styles.mHead} title={form.possFormula}>
                <span className={styles.hShort}>POSS</span>
                <span className={styles.hLabel}>추정 포제션</span>
              </th>
              {metricKeys.map((k) => (
                <MetricHead def={FORM_METRIC_BY_KEY[k]} key={k} />
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row) => {
              const dim = isDim(row, unit);
              const dMuted = deltaMuted(row, seasonByKey, unit);
              const cls = [
                row.kind === "recent" ? styles.rowRecent : "",
                row.kind === "career" ? styles.rowCareer : "",
                dim ? styles.rowDim : "",
              ]
                .filter(Boolean)
                .join(" ");
              const teams = row.tcodes.map(abbr).join("→");
              // 행마다 '무엇에 대한 표본인가'를 라벨 밑에 한 줄로 - 커리어 행이 정규시즌 합이라는
              // 사실을 안 적으면 커리어 371경기(정규+PO)를 아는 독자가 352를 오류로 읽는다.
              const sub =
                row.kind === "recent" && row.prevKey
                  ? `${seasons.find((s) => s.key === row.prevKey)?.label ?? row.prevKey} 대비`
                  : row.kind === "career"
                    ? `정규시즌 ${form.seasonsPlayed}시즌`
                    : teams;
              return (
                <tr className={cls} key={row.key}>
                  <th scope="row" className={`${styles.stickyCol} ${styles.rowHead}`} title={row.sample}>
                    <span className={styles.rowLabel}>
                      {row.label}
                      {/* 경고가 있는 행에는 표식만 남기고 문장은 표 아래 목록으로 편다. */}
                      {row.note && (
                        <span className={styles.rowFlag} aria-hidden="true">
                          !
                        </span>
                      )}
                    </span>
                    {sub && <span className={styles.rowSub}>{sub}</span>}
                  </th>
                  <td className={styles.numCell}>{row.gp}</td>
                  <td className={styles.numCell}>{fmtInt(row.minutes)}</td>
                  <td className={styles.numCell}>{fmtInt(row.poss)}</td>
                  {metricKeys.map((k) => (
                    <td className={styles.cell} key={k}>
                      <span className={styles.cellV}>{formatRate(k, rateValue(row, k, unit))}</span>
                      <DeltaText mkey={k} value={deltaValue(row, k, unit)} muted={dMuted} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {/* 리그 기준선은 표의 마지막 줄에 한 번만 - 가장 최근 시즌 것이고, 그 사실을 라벨에 적는다.
                (시즌마다 기준선이 다르므로 각 시즌의 기준선은 위 카드의 점선이 진다.) */}
            {latest?.league && (
              <tr className={styles.rowLeague}>
                <th scope="row" className={`${styles.stickyCol} ${styles.rowHead}`} title={form.leagueNote}>
                  <span className={styles.rowLabel}>리그 평균</span>
                  <span className={styles.rowSub}>{latest.label} 정규시즌</span>
                </th>
                <td className={styles.numCell}>—</td>
                <td className={styles.numCell}>—</td>
                <td className={styles.numCell}>—</td>
                {metricKeys.map((k) => (
                  <td className={styles.cell} key={k}>
                    <span className={styles.cellV}>{formatRate(k, leagueValue(latest, k, unit))}</span>
                    <span className={`${styles.cellD} ${styles.dNone}`}>—</span>
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 행별 경고는 표 안에 접어 두지 않고 밖에 문장으로 편다 - 툴팁으로만 두면 터치 기기에서 사라진다. */}
      {noteRows.length > 0 && (
        <ul className={styles.noteList}>
          {noteRows.map((r) => (
            <li key={`note-${r.key}`}>
              <b>{r.label}</b> {r.note}
            </li>
          ))}
        </ul>
      )}

      {/* ── 플레이오프(정규시즌과 표본을 섞지 않으려고 별도 표) ───────────────────── */}
      {form.playoffs.length > 0 && (
        <details className={styles.details}>
          <summary className={styles.summary}>플레이오프 {form.playoffs.length}시즌</summary>
          <p className={styles.tableNote}>
            플레이오프 행의 리그 기준선은 그 시즌 <b>플레이오프</b> 리그다(정규시즌 것이 아니다) · 표본이 작아 대부분 자격 미달로 표시된다
          </p>
          <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="플레이오프 표">
            <table className={styles.table} aria-label={`플레이오프 ${unitMeta.head} 비율표`}>
              <thead>
                <tr>
                  <th scope="col" className={`${styles.stickyCol} ${styles.headCell}`}>
                    <span className={styles.hShort}>SEASON</span>
                    <span className={styles.hLabel}>시즌</span>
                  </th>
                  <th scope="col" className={styles.mHead}>
                    <span className={styles.hShort}>GP</span>
                    <span className={styles.hLabel}>출전</span>
                  </th>
                  <th scope="col" className={styles.mHead}>
                    <span className={styles.hShort}>MIN</span>
                    <span className={styles.hLabel}>분</span>
                  </th>
                  {metricKeys.map((k) => (
                    <MetricHead def={FORM_METRIC_BY_KEY[k]} key={k} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {form.playoffs.map((row) => {
                  // 정규시즌 표와 같은 게이트. 플레이오프는 대부분 5경기 안쪽이라 사실상
                  // 모든 Δ가 회색이 되는데, 그게 맞다 - 4경기 차이에 초록/빨강을 칠하면 안 된다.
                  const dMuted = deltaMuted(row, playoffByKey, unit);
                  return (
                  <tr className={isDim(row, unit) ? styles.rowDim : ""} key={row.key}>
                    <th scope="row" className={`${styles.stickyCol} ${styles.rowHead}`} title={row.sample}>
                      <span className={styles.rowLabel}>{row.label}</span>
                      <span className={styles.rowSub}>{row.tcodes.map(abbr).join("→")}</span>
                    </th>
                    <td className={styles.numCell}>{row.gp}</td>
                    <td className={styles.numCell}>{fmtInt(row.minutes)}</td>
                    {metricKeys.map((k) => (
                      <td className={styles.cell} key={k}>
                        <span className={styles.cellV}>{formatRate(k, rateValue(row, k, unit))}</span>
                        <DeltaText mkey={k} value={deltaValue(row, k, unit)} muted={dMuted} />
                      </td>
                    ))}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* ── 계산 방법(정직성 각주) ────────────────────────────────────────────────── */}
      <details className={styles.details}>
        <summary className={styles.summary}>이 표는 어떻게 계산했나</summary>
        <dl className={styles.methodList}>
          <div>
            <dt>단위</dt>
            <dd>
              {unitMeta.head} — {unitMeta.note} {form.caption}
            </dd>
          </div>
          <div>
            <dt>추정 포제션</dt>
            <dd>
              {form.possFormula}. {form.estimateNote}
            </dd>
          </div>
          <div>
            <dt>표본 자격</dt>
            <dd>{form.qualifyNote}</dd>
          </div>
          <div>
            <dt>리그 기준선</dt>
            <dd>{form.leagueNote}</dd>
          </div>
          <div>
            <dt>변화(Δ)</dt>
            <dd>
              표에 있는 <b>바로 앞 시즌</b>과의 차이다(비율 지표는 %p). 사이에 건너뛴 시즌이 있으면 그 행의 경고에 적힌다. 다만
              &lsquo;{form.recent?.label ?? `최근 ${form.recentN}경기`}&rsquo; 행만은 <b>가장 최신 시즌</b>과 비교한다 — 지금 폼이 그
              시즌의 기준선에서 얼마나 벗어나 있는지가 그 행의 존재 이유이기 때문이다. 비교할 앞 시즌이 없는 행(첫 시즌 · 커리어 ·
              리그)은 —로 둔다.
            </dd>
          </div>
          <div>
            <dt>색</dt>
            <dd>
              방향이 있는 지표만 좋고 나쁨으로 칠한다(턴오버는 줄어야 좋다). 야투 시도 · 3점 시도 · USG%는 많고 적음이 스타일이라
              색을 쓰지 않는다. 비교하는 두 구간 중 <b>한쪽이라도 표본 하한을 못 넘기면</b> 값은 그대로 인쇄하되 색은 쓰지 않는다 —
              카드 · 요약 문장과 같은 기준이다(11포제션에서 나온 −8.2는 방향조차 사실이라 보기 어렵다).
            </dd>
          </div>
          <div>
            <dt>표본 표기</dt>
            <dd>{SAMPLE_COLUMN_NOTE}</dd>
          </div>
          {[...FORM_RATE_DEFS, ...FORM_PCT_DEFS]
            .filter((d) => d.note && metricKeys.includes(d.key))
            .map((d) => (
              <div key={`m-${d.key}`}>
                <dt>{d.short}</dt>
                <dd>{d.note}</dd>
              </div>
            ))}
        </dl>
      </details>
    </section>
  );
}

export default PlayerFormPanel;
