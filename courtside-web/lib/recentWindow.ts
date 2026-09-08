import { PLAYOFF_CATEGORY } from "./playerPageData";
import { seasonShort } from "./seasonFocus";
import { WINDOWS, type CareerGameRow } from "./playerProfile";

// 선수 프로필 "최근 N경기" 패널의 계산 레이어(요청: "최근 5,10,15,30경기가 보기가 좀 어려운데,
// 가시성 좋게, 디자인 좋게 변경").
//
// ── 왜 타일 10개를 버리고 '행 + 점 스트립'으로 가는가 ────────────────────────────────
// 옛 패널은 창 평균 하나를 타일에 크게 찍었다. 그런데 이 창 안의 변동이 평균으로 요약될 만큼
// 작지 않다(2026-09-04 실측, 25-26 300분+ 111명 L15 기준):
//   변동계수(sd/평균) 중앙값 - PTS 76.6% · REB 70.8% · AST 84.0% · MIN 40.1% ·
//                              TOV 89.4% · STL 106.2% · BLK 126.0%
//   경기간 sd 중앙값 - PTS 4.45 · REB 1.91 · MIN 6.49. 최대-최소 폭 중앙값 PTS 15.0점.
// 리그에서 가장 안정적인 축에 속하는 자밀 워니(291248)조차 L15 평균 21.5점인데 실제 범위가
// 6~38점(sd 8.62, 2026-09-04 SQL 직접 대조)이다. 평균 한 숫자는 그 32점 폭을 지운다.
// 그래서 이 패널의 주인공은 값이 아니라 '그 창의 경기별 점 분포'이고, 평균은 그 위에 찍히는
// 눈금 하나다.
//
// ── 창 안의 차이를 언제 '변화'라고 부를 것인가 ──────────────────────────────────────
// 커리어 대비 차이가 노이즈로 설명되지 않는 선수는 위 코호트 111명 중 49명(44.1%)뿐이고,
// 22.5%는 |차이| < 1.0점이다. 그래서 |Δ| < 창 내부 표준오차(sd/√n)면 색을 빼고 중립으로 둔다 -
// 숫자와 부호는 그대로 인쇄하되 '올랐다/내렸다'라고 주장하지 않는다(lib/wowy.ts의 diffSe,
// lib/playerForm.ts의 deltaMuted와 같은 태도).
//
// ── 왜 36분당 전환이 이 패널의 필수 기능인가 ────────────────────────────────────────
// 창 차이의 73%가 출전 시간 변화로 설명된다(corr(ΔMIN, ΔPTS) = 0.856, 같은 코호트). 경기당
// |ΔPTS| >= 2인 53명 중 7명은 36분당으로 보면 |Δ| < 1로 사라진다. "최근에 잘한다"가 사실은
// "최근에 많이 뛴다"인지 링크 하나로 갈라낼 수 있어야 한다. 그래서 MIN이 첫 줄이다.

/**
 * 창의 단위를 싣는 쿼리 파라미터 이름.
 *
 * ?rate=는 쓰지 않는다 - 이미 components/PlayerForm.tsx(다중 시즌 폼 패널)가 ?rate=per75/per40으로
 * 점유하고 있고, resolveFormUnit()은 모르는 값을 조용히 per75로 되돌린다. 여기서 ?rate=per36을
 * 쓰면 이 패널을 36분당으로 바꾸는 순간 아래 폼 패널의 40분당 선택이 소리 없이 풀린다.
 */
export const RECENT_RATE_PARAM = "rw";

export type RecentRate = "perGame" | "per36";

/** 36분당의 기준 분. 경기 40분이 아니라 36분인 이유는 이 값이 "풀타임 주전"의 관습적 분모라서다. */
export const PER36_BASE = 36;

/**
 * 창 합계 출전 시간이 이 값 미만이면 36분당을 아예 계산하지 않는다.
 * 실측(2026-09-04): 조은후(291499)의 L5는 5경기 중 4경기가 결장이고 합계 1.2분이다. 1.2분을
 * 36분으로 늘리면 한 번의 슛이 시즌 기록이 된다 - 값을 흐리게 그리는 정도로는 부족하고
 * 아예 만들지 않아야 한다.
 */
export const PER36_MIN_MINUTES = 20;

/**
 * 퍼센트 행을 회색으로 눌러 둘 시도 수 하한.
 * 실측(2026-09-04, 25-26 300분+ 111명): 창 3PA < 10인 선수 비율이 L5 44% · L10 23% · L15 18% ·
 * L30 9%. 즉 L5의 3P%는 절반 가까운 선수에게 숫자놀음이다.
 */
export const PCT_MIN_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// 지표 정의 - 화면은 라벨을 새로 발명하지 말고 이 배열 순서를 그대로 그린다
// ---------------------------------------------------------------------------

export type RecentCountKey = "min" | "pts" | "reb" | "ast" | "stl" | "blk" | "tov";
export type RecentPctKey = "fg" | "tp" | "ft";
export type RecentMetricKey = RecentCountKey | RecentPctKey;

/**
 * Δ에 좋고나쁨 색을 붙일 방향.
 *   up   - 클수록 좋다   down - 작을수록 좋다(턴오버)
 *   role - 좋고나쁨이 아니라 역할의 변화다. 출전 시간이 여기 속한다: 24분이 32분이 된 것은
 *          '잘한 것'이 아니라 '많이 뛴 것'이고, 이 패널의 존재 이유가 바로 그 둘을 가르는 것이라
 *          MIN에 초록/빨강을 칠하면 패널이 스스로 말하려는 바를 배신한다.
 */
export type RecentDirection = "up" | "down" | "role";

export type RecentMetricDef = {
  key: RecentMetricKey;
  /** 한글 라벨. Big Shoulders Display를 절대 쓰지 않는 자리다(한글 글리프 없음). */
  label: string;
  /** 라틴 약어 - 숫자와 함께 Big Shoulders/모노로 그려도 안전한 유일한 문자열. */
  short: string;
  kind: "count" | "pct";
  direction: RecentDirection;
  /** 값·Δ의 소수 자리. */
  digits: number;
  /** 경기별 실제 범위(min~max)의 소수 자리. 박스스코어 카운트는 정수라 0. */
  rangeDigits: number;
  /** 36분당 전환의 대상인가. MIN은 그 자체가 분모라 제외, 퍼센트는 정의상 대상이 아니다. */
  per36: boolean;
};

export const RECENT_METRICS: RecentMetricDef[] = [
  // MIN이 맨 위인 이유는 위 헤더 주석의 corr(ΔMIN, ΔPTS)=0.856이다 - 다른 모든 행을 읽기 전에
  // "표본의 크기가 그대로 달라졌는가"를 먼저 보게 한다.
  { key: "min", label: "출전", short: "MIN", kind: "count", direction: "role", digits: 1, rangeDigits: 1, per36: false },
  { key: "pts", label: "득점", short: "PTS", kind: "count", direction: "up", digits: 1, rangeDigits: 0, per36: true },
  { key: "reb", label: "리바운드", short: "REB", kind: "count", direction: "up", digits: 1, rangeDigits: 0, per36: true },
  { key: "ast", label: "어시스트", short: "AST", kind: "count", direction: "up", digits: 1, rangeDigits: 0, per36: true },
  { key: "stl", label: "스틸", short: "STL", kind: "count", direction: "up", digits: 1, rangeDigits: 0, per36: true },
  { key: "blk", label: "블록", short: "BLK", kind: "count", direction: "up", digits: 1, rangeDigits: 0, per36: true },
  { key: "tov", label: "턴오버", short: "TOV", kind: "count", direction: "down", digits: 1, rangeDigits: 0, per36: true },
  { key: "fg", label: "야투", short: "FG%", kind: "pct", direction: "up", digits: 1, rangeDigits: 1, per36: false },
  { key: "tp", label: "3점", short: "3P%", kind: "pct", direction: "up", digits: 1, rangeDigits: 1, per36: false },
  { key: "ft", label: "자유투", short: "FT%", kind: "pct", direction: "up", digits: 1, rangeDigits: 1, per36: false },
];

/** searchParams 원문 -> 단위. 모르는 값은 전부 경기당(기본값). */
export function resolveRecentRate(raw: string | string[] | undefined | null): RecentRate {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "per36" ? "per36" : "perGame";
}

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

/** 스트립의 점 하나 = 그 창의 경기 하나. */
export type RecentDot = {
  gmkey: string;
  gameDate: string;
  /** 그 경기의 값. 카운팅 행은 경기당 원값, 퍼센트 행은 그 경기의 성공률(0~100). */
  value: number;
  /** 0분 출전 - 속 빈 점으로 그린다. */
  dnp: boolean;
  isPlayoff: boolean;
  /** 네이티브 <title>에 들어갈 문구(한글 허용 - 브라우저 UI가 시스템 폰트로 그린다). */
  title: string;
};

export type RecentRow = {
  def: RecentMetricDef;
  /** 지금 단위 기준의 창 값. 표본이 없으면 null(퍼센트 행의 시도 0). */
  value: number | null;
  /** 같은 단위의 커리어 값. */
  career: number | null;
  /** value - career. 어느 한쪽이 null이면 null. */
  delta: number | null;
  /** 언제나 경기당 값(단위를 36분당으로 바꿔도 함께 인쇄해 둘 대조군). */
  perGame: number | null;
  careerPerGame: number | null;
  /** 36분당 값. 이 행이 36분당 대상이 아니거나 창 출전 시간이 모자라면 null. */
  per36: number | null;
  careerPer36: number | null;
  /**
   * Δ를 '변화'라고 부르기 위한 최소 크기. 카운팅 행은 창 내부 경기간 표준오차(sd/√n),
   * 퍼센트 행은 이항 표준오차 √(p(1-p)/n)×100. 판정할 표본이 없으면 null.
   */
  noise: number | null;
  /** |Δ| >= noise. noise가 null이면 언제나 false(모르면 주장하지 않는다). */
  meaningful: boolean;
  dots: RecentDot[];
  /** 점으로 그린 값들의 실제 최소·최대. 점이 없으면 null. */
  lo: number | null;
  hi: number | null;
  /** 스트립 축의 위쪽 끝(0부터 시작). 퍼센트 행은 언제나 100. */
  domainMax: number;
  /** 퍼센트 행의 성공/시도(창 · 커리어). 카운팅 행은 null. */
  makes: number | null;
  attempts: number | null;
  careerAttempts: number | null;
  /** 퍼센트 행의 시도가 PCT_MIN_ATTEMPTS 미만 - 값을 회색으로. */
  thin: boolean;
  /** 이 행에만 붙는 표본 경고. 없으면 null. */
  note: string | null;
};

export type RecentWindowFacts = {
  /** 요청한 창(L5/L10/L15/L30). */
  requestedN: number;
  /** 실제로 집계한 엔트리 수. 커리어가 짧으면 requestedN보다 작다. */
  n: number;
  /** 그중 실제 출전(0분 초과). */
  played: number;
  /** 결장(0분) 엔트리 수. */
  dnp: number;
  firstDate: string;
  lastDate: string;
  /** 창에 걸친 시즌(옛->최신). "25-26" 꼴. */
  seasonLabels: string[];
  regular: number;
  playoff: number;
  minutes: number;
  /** 커리어 전체 엔트리 수(종료 경기). */
  careerN: number;
  /** 창이 곧 커리어 전체 - 이때 '커리어 대비'는 정의상 전부 0이다. */
  isWholeCareer: boolean;
  /** 커리어가 요청한 창보다 짧다. */
  shortCareer: boolean;
  /** 이 커리어 길이에서 같은 창을 가리키게 되는 다른 토글들(예: 9경기 커리어의 L10/L15/L30). */
  sameAsWindows: number[];
  /** 창 합계 출전 시간이 PER36_MIN_MINUTES 이상 - 36분당을 만들 수 있는가. */
  per36Available: boolean;
  /** "15경기 · 2026-02-17~2026-04-16 · 25-26 · 정규 12 · 플레이오프 3" */
  headline: string;
};

export type RecentWindowData = {
  facts: RecentWindowFacts;
  /** 요청한 단위. 36분당이 불가능하면 perGame으로 되돌린 값이 들어간다. */
  rate: RecentRate;
  /** 요청은 36분당이었으나 표본이 모자라 경기당으로 되돌렸다. */
  rateFellBack: boolean;
  rows: RecentRow[];
  /** 창의 정의(표본·기준)를 한 문장으로. 화면 캡션이 이 문자열을 그대로 쓴다. */
  definition: string;
  /** 화면이 그대로 나열할 경고 문장들(창이 무의미한 경우·결장·표본 부족). */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// 계산
// ---------------------------------------------------------------------------

const countOf = (g: CareerGameRow, key: RecentCountKey): number => g[key];

/** 퍼센트 지표의 성공/시도. fga/fgm은 2점 전용이라 야투는 반드시 3점을 더한다(스키마 함정). */
function pctPair(g: CareerGameRow, key: RecentPctKey): { m: number; a: number } {
  if (key === "fg") return { m: g.fgm + g.tpm, a: g.fga + g.tpa };
  if (key === "tp") return { m: g.tpm, a: g.tpa };
  return { m: g.ftm, a: g.fta };
}

/** 표본 표준편차(n-1). 표본이 2개 미만이면 null - 한 경기로 산포를 말할 수는 없다. */
function sampleSd(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const varr = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(varr);
}

/**
 * 카운팅 지표의 경기간 표준편차 하한.
 *
 * 관측 sd만 쓰면 값이 작은 지표에서 밴드가 비현실적으로 좁아진다 - 블록이 15경기 내내 0/1만
 * 오갔다면 sd는 0.3인데, 그 0.3을 그대로 믿고 "커리어 대비 -0.4는 유의미한 감소"라고 색을 칠하게
 * 된다. 개수형 사건의 분산은 최소한 평균만큼은 된다는 것이 포아송의 기본 성질이므로, √평균을
 * 하한으로 깐다. 실측 대조(2026-09-04): 워니 L15 PTS는 sd 8.62 > √21.5 = 4.64라 값이 바뀌지 않고
 * (밴드 ±2.2 유지), 조은후 L15 REB는 sd 0.35 < √0.13 = 0.37이라 밴드가 아주 조금 넓어진다.
 * 시간(MIN)은 개수가 아니므로 적용하지 않는다.
 */
function countingSd(values: number[], mean: number): number | null {
  const sd = sampleSd(values);
  if (sd == null) return null;
  return Math.max(sd, Math.sqrt(Math.max(0, mean)));
}

/**
 * 축 위쪽 끝을 사람이 읽는 숫자로 올림. 그림의 오른쪽 끝에 인쇄되는 값이므로 반올림이 아니라
 * 올림이어야 한다(내리면 점이 축 밖으로 나간다).
 */
function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  if (v >= 20) return Math.ceil(v / 5) * 5;
  if (v >= 5) return Math.ceil(v);
  return Math.ceil(v * 2) / 2;
}

export type BuildRecentWindowOptions = {
  /** L5/L10/L15/L30 - 페이지의 windowN을 그대로. */
  windowN: number;
  rate?: RecentRate;
  /** tcode -> 팀 약칭(페이지가 이미 만든 teamAbbrs). 점 툴팁의 상대 표기에만 쓴다. */
  teamAbbrs?: Map<string, string>;
};

/**
 * 최근 N경기 패널의 모든 숫자.
 *
 * 입력은 페이지가 이미 갖고 있는 getPlayerCareerGames() 결과다 - 새 DB 왕복을 만들지 않는다.
 * getPlayerRecentGames()의 GameLogRow를 쓰지 않는 이유는 그 타입에 season_name/season_category가
 * 없어서다: 창의 시즌 구성과 정규/PO 구성은 이 패널이 반드시 밝혀야 하는 사실이라 없는 필드로는
 * 만들 수 없다.
 *
 * 창의 단위는 '밤'이 아니라 '엔트리'다(0분 결장 포함) - 옛 computeWindowAverages와 같은 15경기를
 * 가리키게 하려는 것이고, 결장이 평균을 희석한다는 사실 자체가 이 패널이 드러내야 할 것이기도
 * 하다(실측 2026-09-04: 전체 선수 L15의 55.0%가 결장을 포함하고, 창의 평균 17.5%가 결장이다.
 * 조은후 291499의 L15는 15경기 중 9경기가 0분이다).
 */
export function buildRecentWindow(careerRows: CareerGameRow[], opts: BuildRecentWindowOptions): RecentWindowData | null {
  const { windowN, teamAbbrs } = opts;
  // 호출부의 정렬을 믿지 않는다 - getPlayerCareerGames는 날짜 내림차순이지만 이 함수가 그 계약에
  // 묶이면 다른 화면이 정렬을 바꾼 배열을 넘겼을 때 '최근'이 조용히 거짓이 된다.
  const desc = careerRows
    .filter((r) => r.isEnded)
    .slice()
    .sort((a, b) => (a.gameDate !== b.gameDate ? (a.gameDate < b.gameDate ? 1 : -1) : a.gmkey < b.gmkey ? 1 : -1));
  if (!desc.length) return null;

  const win = desc.slice(0, windowN);
  const n = win.length;
  const careerN = desc.length;
  const played = win.filter((g) => g.min > 0).length;
  const minutes = win.reduce((s, g) => s + g.min, 0);
  const careerMinutes = desc.reduce((s, g) => s + g.min, 0);
  const playoff = win.filter((g) => g.seasonCategory === PLAYOFF_CATEGORY).length;
  const seasonsAsc = [...new Set(win.map((g) => g.seasonName))].sort();
  // 창(win)은 날짜 내림차순이므로 마지막 원소가 가장 오래된 경기다.
  const firstDate = win[n - 1].gameDate;
  const lastDate = win[0].gameDate;

  const per36Available = minutes >= PER36_MIN_MINUTES;
  const wanted = opts.rate ?? "perGame";
  const rate: RecentRate = wanted === "per36" && per36Available ? "per36" : "perGame";
  const rateFellBack = wanted === "per36" && !per36Available;

  // 커리어가 창보다 짧으면 L10/L15/L30이 같은 경기를 가리킨다 - 토글 네 칸 중 세 칸이 같은 그림인
  // 것을 화면이 직접 말해야 한다(실측 2026-09-04: 카이린 갤러웨이 291879는 통산 9경기라 L10/L15/L30이
  // 전부 그 9경기이고, 그래서 '커리어 대비'가 10개 지표 전부 정확히 0.0이 된다).
  const sameAsWindows = WINDOWS.filter((w) => w !== windowN && Math.min(w, careerN) === n);

  const abbr = (tcode: string) => teamAbbrs?.get(tcode) ?? tcode;
  const oppText = (g: CareerGameRow) => `${g.isHome ? "vs" : "@"} ${abbr(g.oppTcode)}`;

  const rows: RecentRow[] = RECENT_METRICS.map((def) => {
    if (def.kind === "count") {
      const key = def.key as RecentCountKey;
      const vals = win.map((g) => countOf(g, key));
      const sum = vals.reduce((s, v) => s + v, 0);
      const careerSum = desc.reduce((s, g) => s + countOf(g, key), 0);
      const perGame = sum / n;
      const careerPerGame = careerSum / careerN;
      // 36분당은 "합계 ÷ 합계 분 × 36" - 경기별 36분당의 단순 평균이 아니다(3분 뛴 경기가
      // 32분 뛴 경기와 같은 무게를 갖게 되면 그건 다른 지표다).
      const per36 = def.per36 && per36Available && minutes > 0 ? (sum / minutes) * PER36_BASE : null;
      const careerPer36 = def.per36 && careerMinutes > 0 ? (careerSum / careerMinutes) * PER36_BASE : null;

      const useP36 = rate === "per36" && per36 != null && careerPer36 != null;
      const value = useP36 ? per36 : perGame;
      const career = useP36 ? careerPer36 : careerPerGame;

      // 36분당의 노이즈 폭은 '출전한 경기들의 경기별 36분당'에서 잰다. 짧게 뛴 경기가 극단값을
      // 만들어 sd를 부풀리는데(3분 4점 = 48), 그 방향은 언제나 '변화라고 부르기 어렵게' 만드는
      // 쪽이라 보수적이다. 가중 합계의 정확한 표준오차는 아니고 그 근사다.
      const noise = useP36
        ? (() => {
            const per36Vals = win.filter((g) => g.min > 0).map((g) => (countOf(g, key) / g.min) * PER36_BASE);
            const sd = sampleSd(per36Vals);
            return sd == null || !per36Vals.length ? null : sd / Math.sqrt(per36Vals.length);
          })()
        : (() => {
            // MIN은 개수가 아니라 시간이라 포아송 하한을 씌우지 않는다(countingSd 주석 참고).
            const sd = key === "min" ? sampleSd(vals) : countingSd(vals, perGame);
            return sd == null ? null : sd / Math.sqrt(n);
          })();

      const delta = value - career;
      const dots: RecentDot[] = win
        .slice()
        .reverse() // 옛 경기부터 쌓아 같은 값이 겹칠 때 아래쪽이 언제나 더 오래된 경기가 되게
        .map((g) => ({
          gmkey: g.gmkey,
          gameDate: g.gameDate,
          value: countOf(g, key),
          dnp: g.min <= 0,
          isPlayoff: g.seasonCategory === PLAYOFF_CATEGORY,
          title:
            `${g.gameDate} ${oppText(g)} · ${def.label} ${countOf(g, key).toFixed(def.rangeDigits)}` +
            (g.min > 0 ? ` · ${g.min.toFixed(1)}분` : " · 결장(0분)"),
        }));
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);

      return {
        def,
        value,
        career,
        delta,
        perGame,
        careerPerGame,
        per36,
        careerPer36,
        noise,
        meaningful: noise != null && Math.abs(delta) >= noise,
        dots,
        lo,
        hi,
        // 축은 언제나 0에서 시작한다 - 카운팅 지표에 0 아닌 바닥을 주면 작은 차이가 큰 차이로
        // 보인다. 위쪽 끝은 점·창 평균·커리어 평균을 전부 담아야 한다.
        domainMax: niceCeil(Math.max(hi, perGame, careerPerGame)),
        makes: null,
        attempts: null,
        careerAttempts: null,
        thin: false,
        note: null,
      };
    }

    const key = def.key as RecentPctKey;
    let m = 0;
    let a = 0;
    for (const g of win) {
      const p = pctPair(g, key);
      m += p.m;
      a += p.a;
    }
    let cm = 0;
    let ca = 0;
    for (const g of desc) {
      const p = pctPair(g, key);
      cm += p.m;
      ca += p.a;
    }
    const value = a > 0 ? (m / a) * 100 : null;
    const career = ca > 0 ? (cm / ca) * 100 : null;
    const delta = value != null && career != null ? value - career : null;
    // 이항 표준오차 √(p(1-p)/n) - lib/playerPageData.ts computeZoneTable와 같은 자다. 다만 p를
    // 관측값 그대로 쓰면 안 된다: 3점 0/1이면 p=0이라 표준오차가 정확히 0이 되고, 시도 한 번으로
    // "커리어 대비 -24.2%p"를 유의미한 하락이라고 색칠하게 된다(실측 - 조은후 291499 L15에서
    // 실제로 그렇게 찍혔다). 그래서 p는 라플라스 보정한 (m+1)/(a+2)로 재고, 분모는 실제 시도 수를
    // 그대로 둔다 - 0/1의 밴드는 ±47%p가 되어 어떤 차이도 주장하지 못하게 된다.
    const pTilde = a > 0 ? (m + 1) / (a + 2) : null;
    const noise = pTilde != null && a > 0 ? Math.sqrt((pTilde * (1 - pTilde)) / a) * 100 : null;

    const dots: RecentDot[] = win
      .slice()
      .reverse()
      .map((g) => {
        const p = pctPair(g, key);
        if (p.a <= 0) return null;
        return {
          gmkey: g.gmkey,
          gameDate: g.gameDate,
          value: (p.m / p.a) * 100,
          dnp: false, // 시도가 있었으므로 출전한 경기다
          isPlayoff: g.seasonCategory === PLAYOFF_CATEGORY,
          title: `${g.gameDate} ${oppText(g)} · ${def.label} ${p.m}/${p.a}`,
        };
      })
      .filter((d): d is RecentDot => d !== null);

    const noAttempt = n - dots.length;
    const notes: string[] = [];
    if (a < PCT_MIN_ATTEMPTS) notes.push(`시도 ${a}회 - ${PCT_MIN_ATTEMPTS}회 미만이라 비율로 읽지 않는다`);
    if (noAttempt > 0) notes.push(`시도가 없던 경기 ${noAttempt}개는 점이 없다`);

    return {
      def,
      value,
      career,
      delta,
      perGame: value,
      careerPerGame: career,
      per36: null,
      careerPer36: null,
      noise,
      // 시도 하한을 넘지 못한 행은 밴드와 무관하게 '변화'라고 부르지 않는다 - 값 자체를 회색으로
      // 눌러 놓고 Δ만 원색으로 칠하면 같은 표본을 두 목소리로 말하게 된다.
      meaningful: a >= PCT_MIN_ATTEMPTS && noise != null && delta != null && Math.abs(delta) >= noise,
      dots,
      lo: dots.length ? Math.min(...dots.map((d) => d.value)) : null,
      hi: dots.length ? Math.max(...dots.map((d) => d.value)) : null,
      domainMax: 100,
      makes: m,
      attempts: a,
      careerAttempts: ca,
      thin: a < PCT_MIN_ATTEMPTS,
      note: notes.length ? notes.join(" · ") : null,
    };
  });

  const seasonLabels = seasonsAsc.map(seasonShort);
  const regular = n - playoff;
  const headline =
    `${n}경기 · ${firstDate}~${lastDate} · ${seasonLabels.join("·")} · ` +
    `정규 ${regular} · 플레이오프 ${playoff}` +
    (n - played > 0 ? ` · 결장 ${n - played}` : "");

  const warnings: string[] = [];
  if (n < windowN) {
    warnings.push(
      `요청한 L${windowN}보다 커리어가 짧다 - 이 창은 통산 ${careerN}경기 전부다` +
        (sameAsWindows.length ? `. L${sameAsWindows.join("·L")}도 같은 ${n}경기를 가리킨다` : "")
    );
  }
  if (n === careerN) {
    warnings.push("창이 커리어 전체와 같으므로 '커리어 대비'는 정의상 전부 0이다 - 비교 상대가 자기 자신이다");
  }
  if (n - played > 0) {
    warnings.push(
      `결장(0분) ${n - played}경기가 창에 포함되어 있다. 경기당 값은 그 0을 그대로 나눠 갖는다 - ` +
        "36분당으로 보면 결장이 분모에서 빠진다"
    );
  }
  if (!per36Available) {
    warnings.push(`창 합계 출전 ${minutes.toFixed(1)}분 - ${PER36_MIN_MINUTES}분 미만이라 36분당은 만들지 않는다`);
  }
  if (playoff > 0 && regular > 0) {
    warnings.push(`이 창은 정규시즌 ${regular}경기와 플레이오프 ${playoff}경기가 섞여 있다 - 상대와 강도가 같지 않다`);
  }
  if (seasonLabels.length > 1) {
    warnings.push(`이 창은 ${seasonLabels.join("·")} 두 시즌 이상에 걸쳐 있다`);
  }

  const definition =
    `창은 마지막 ${n}개 엔트리(결장 포함)이고, '커리어 대비'의 기준은 통산 ${careerN}경기 엔트리 평균이다` +
    `(창 자신도 그 안에 들어 있다). Δ가 창 내부 표준오차보다 작으면 색을 빼 중립으로 둔다.`;

  return {
    facts: {
      requestedN: windowN,
      n,
      played,
      dnp: n - played,
      firstDate,
      lastDate,
      seasonLabels,
      regular,
      playoff,
      minutes,
      careerN,
      isWholeCareer: n === careerN,
      shortCareer: n < windowN,
      sameAsWindows,
      per36Available,
      headline,
    },
    rate,
    rateFellBack,
    rows,
    definition,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 점 스트립(raw SVG 문자열)
// ---------------------------------------------------------------------------
//
// React 19에서 JSX <svg> 안의 JSX <title>은 문서 title로 호이스팅돼 하이드레이션이 깨진다
// (이 저장소의 하드 룰). 그래서 저장소 관례대로 문자열로 만들어 dangerouslySetInnerHTML로 넣고,
// 툴팁은 문자열 안의 네이티브 <title>을 쓴다 - components/PlayerForm.tsx 스파크라인과 같은 방식.
//
// 색은 전부 var(--토큰)이라 인라인 SVG에도 테마가 그대로 상속된다.

// ── 게이지 기하 ──────────────────────────────────────────────────────────────────
// 아래가 트인 270도 링. 시작 각 135도(왼쪽 아래)에서 시계방향으로 270도 돌아 45도(오른쪽 아래)
// 에서 끝난다 - 트인 자리가 아래라 값이 0일 때와 100%일 때가 서로 붙어 보이지 않는다.
const G_VB = 100;
const G_CX = 50;
const G_CY = 52;
const G_R = 30;
const G_START = 135;
const G_SWEEP = 270;
/** 링 바깥으로 점을 쌓는다 - 같은 값에 몰린 경기 수가 그대로 둘레의 두께가 된다. */
const G_DOT_R = 2.3;
const G_DOT_R0 = G_R + 5.2;
const G_STACK_STEP = 3.4;
const G_STACK_MAX = 4;

export type RecentGauge = {
  svg: string;
  viewBox: string;
  /** 축 위쪽 끝(라벨용). */
  domainMax: number;
  /** 36분당 축이라 경기별 점을 얹지 않았다. */
  dotsOmitted: boolean;
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 좌표를 소수 한 자리로 - -0이 문자열로 새어 나가지 않게. */
function n1(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
}

/** 링 위의 한 점(0..1) -> 좌표. */
function gaugePt(frac: number, r: number): [number, number] {
  const a = ((G_START + G_SWEEP * Math.max(0, Math.min(1, frac))) * Math.PI) / 180;
  return [G_CX + r * Math.cos(a), G_CY + r * Math.sin(a)];
}

/** 링 호 경로(t0 -> t1, 시계방향). */
function gaugeArc(t0: number, t1: number, r: number): string {
  const [x0, y0] = gaugePt(t0, r);
  const [x1, y1] = gaugePt(t1, r);
  const large = G_SWEEP * (t1 - t0) > 180 ? 1 : 0;
  return `M ${n1(x0)} ${n1(y0)} A ${r} ${r} 0 ${large} 1 ${n1(x1)} ${n1(y1)}`;
}

/**
 * 한 지표의 게이지.
 *
 * 세 가지를 한 그림에 담는다:
 *   채워진 호   = 창 값(지금 단위)            링 위 눈금 = 커리어 평균
 *   링 밖의 점 = 그 창의 경기 하나씩(같은 값이면 바깥으로 쌓인다)
 *
 * 36분당 축에는 점을 얹지 않는다. 3분 뛴 경기를 36분으로 늘린 점(4점 -> 48점)은 실제로
 * 일어난 적 없는 밤이라, 그런 점이 축을 지배하면 그림이 거짓말을 한다. 그래서 그 모드에서는
 * 값과 커리어 눈금만 남기고 화면이 그 사실을 한 줄로 적는다(dotsOmitted).
 */
export function buildRecentGaugeSvg(row: RecentRow, rate: RecentRate): RecentGauge | null {
  const usePer36 = rate === "per36" && row.def.per36 && row.per36 != null;
  const value = row.value;
  const career = row.career;
  if (value == null || !Number.isFinite(value)) return null;

  // 축 위쪽 끝. 경기당은 이미 계산된 domainMax(점·창 평균·커리어 평균을 전부 담는 값)를 쓰고,
  // 36분당은 점이 없으므로 두 값만 담되 끝에 딱 붙지 않게 살짝 여유를 준다.
  const domainMax = row.def.kind === "pct"
    ? 100
    : usePer36
      ? Math.max(1, niceCeil(Math.max(value, career ?? 0) * 1.15))
      : row.domainMax || 1;

  const frac = (v: number) => Math.max(0, Math.min(1, v / domainMax));
  const parts: string[] = [];

  // 트랙(빈 링).
  parts.push(
    `<path d="${gaugeArc(0, 1, G_R)}" fill="none" stroke="var(--surface-soft)" stroke-width="7" stroke-linecap="round"/>`
  );

  // 값 호. 0에 가까우면 호가 사라지므로 최소 길이를 준다 - 값이 0인 것과 그림이 없는 것은 다르다.
  const vf = frac(value);
  parts.push(
    `<path d="${gaugeArc(0, Math.max(vf, 0.012), G_R)}" fill="none" stroke="var(--home)" stroke-width="7" stroke-linecap="round"/>`
  );

  // 커리어 평균 - 링을 가로지르는 눈금. 값 호와 같은 모양이면 둘 중 무엇이 '지금'인지
  // 매번 범례를 봐야 하므로 굳이 다른 형태로 둔다.
  if (career != null && Number.isFinite(career)) {
    const cf = frac(career);
    const [ax, ay] = gaugePt(cf, G_R - 6.4);
    const [bx, by] = gaugePt(cf, G_R + 6.4);
    // 밑선(표면색)을 먼저 굵게 깔고 그 위에 잉크선을 얹는다 - 이 눈금은 링 위에도, 링 바깥에
    // 쌓인 점들 사이에도 놓이므로 테두리가 없으면 배경에 따라 사라진다(실측: 점이 몰린 각도).
    const seg = `x1="${n1(ax)}" y1="${n1(ay)}" x2="${n1(bx)}" y2="${n1(by)}"`;
    parts.push(`<line ${seg} stroke="var(--surface)" stroke-width="4.4" stroke-linecap="round"/>`);
    parts.push(`<line ${seg} stroke="var(--ink)" stroke-width="2" stroke-linecap="round"/>`);
  }

  // 경기별 점 - 링 바깥. 같은 값에 몰리면 바깥으로 쌓아 둘레의 두께가 곧 빈도가 되게.
  let dotsOmitted = false;
  if (usePer36) {
    dotsOmitted = true;
  } else {
    const arcLen = 2 * Math.PI * G_R * (G_SWEEP / 360);
    const bucketFrac = (G_DOT_R * 2 + 0.9) / arcLen;
    const stacks = new Map<number, number>();
    const over = new Map<number, { frac: number; count: number }>();
    for (const d of row.dots) {
      const f = frac(d.value);
      const b = Math.round(f / bucketFrac);
      const k = stacks.get(b) ?? 0;
      stacks.set(b, k + 1);
      if (k >= G_STACK_MAX) {
        const o = over.get(b) ?? { frac: f, count: 0 };
        o.count += 1;
        over.set(b, o);
        continue;
      }
      const [cx, cy] = gaugePt(f, G_DOT_R0 + k * G_STACK_STEP);
      const x = n1(cx);
      const y = n1(cy);
      const shape = d.dnp
        ? // 결장은 속 빈 점 - 0이라는 값이 '못했다'가 아니라 '뛰지 않았다'임을 모양으로 구분한다.
          `<circle cx="${x}" cy="${y}" r="${G_DOT_R}" fill="var(--surface)" stroke="var(--ink-soft)" stroke-width="1"/>`
        : d.isPlayoff
          ? // 플레이오프는 금색 테두리 - 창의 정규/PO 혼재가 헤더 문장뿐 아니라 그림에도 남게.
            `<circle cx="${x}" cy="${y}" r="${G_DOT_R}" fill="var(--home)" stroke="var(--gold)" stroke-width="1.1"/>`
          : `<circle cx="${x}" cy="${y}" r="${G_DOT_R}" fill="var(--home)"/>`;
      parts.push(`<g><title>${esc(d.title)}</title>${shape}<circle cx="${x}" cy="${y}" r="6" fill="transparent"/></g>`);
    }
    for (const o of over.values()) {
      // 쌓을 자리를 넘긴 경기는 숫자로 센다 - 그리지 않고 조용히 버리면 "리바운드 0이 열 경기"가
      // 점 넷으로 보인다(조은후 291499의 L15가 정확히 그 모양이다).
      const [tx, ty] = gaugePt(o.frac, G_DOT_R0 + G_STACK_MAX * G_STACK_STEP + 1.2);
      // font-size는 뷰박스(100) 단위지 픽셀이 아니다. 이 SVG는 .gauge(RecentWindow.module.css,
      // 격자 트랙 최소 136px · max-width 140px)에 폭 100%로 담기므로 배율이 1.36~1.40이고,
      // 옛 6.6은 화면에서 9.0px밖에 되지 않았다(글자 바닥 12px 미달). 9면 12.2~12.6px이다.
      // 그만큼 키우면 글자가 바깥 점 위로 물리므로 표면색 테두리를 글자 밑에 깔아 읽히게
      // 둔다 - 위 커리어 눈금이 밑선을 까는 것과 같은 수법이다.
      parts.push(
        `<text x="${n1(tx)}" y="${n1(ty)}" font-size="9" text-anchor="middle" dominant-baseline="middle" ` +
          `fill="var(--ink-soft)" stroke="var(--surface)" stroke-width="2.6" paint-order="stroke" ` +
          `stroke-linejoin="round" font-family="IBM Plex Mono, monospace">+${o.count}</text>`
      );
    }
  }

  return { svg: parts.join(""), viewBox: `0 0 ${G_VB} ${G_VB}`, domainMax, dotsOmitted };
}

// ---------------------------------------------------------------------------
// 표시 헬퍼 - 화면이 포맷을 새로 발명하지 않도록
// ---------------------------------------------------------------------------

export function formatRecentValue(row: RecentRow, v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return row.def.kind === "pct" ? `${v.toFixed(row.def.digits)}%` : v.toFixed(row.def.digits);
}

/** Δ 표시("+2.3" / "-0.4" / "0.0"). 퍼센트 행은 %포인트라 'p'를 붙인다. */
/** 표시 자리에서 0으로 떨어지는가. 숫자와 색이 같은 기준을 쓰게 하려고 둘 다 이걸 통과한다. */
function snapsToZero(row: RecentRow, v: number): boolean {
  return Math.abs(v) < 0.5 / 10 ** row.def.digits;
}

export function formatRecentDelta(row: RecentRow, v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const d = row.def.digits;
  const snapped = snapsToZero(row, v) ? 0 : v;
  const body = `${snapped > 0 ? "+" : ""}${snapped.toFixed(d)}`;
  return row.def.kind === "pct" ? `${body}p` : body;
}

/**
 * Δ의 색.
 *   "flat"    - 노이즈와 구분되지 않는다(|Δ| < 표준오차) 또는 판정할 표본이 없다
 *   "role"    - 출전 시간처럼 좋고나쁨이 없는 행
 *   good/bad  - 방향이 있는 행에서 노이즈를 넘긴 변화
 */
export function recentDeltaTone(row: RecentRow): "good" | "bad" | "flat" | "role" {
  if (row.delta == null || !row.meaningful) return "flat";
  // 화면에 "0.0"으로 찍히는 값에 좋고나쁨 색을 칠하지 않는다. 창 안 값이 전부 같으면 표준오차가
  // 0이 되어 -0.03 같은 잔여 차이도 meaningful을 통과하는데(실측: 조은후 L15 블록), 그러면
  // 숫자는 "0.0"인데 색은 하락이 된다 - 둘이 다른 말을 하면 색 쪽이 거짓말이다.
  if (snapsToZero(row, row.delta)) return "flat";
  if (row.def.direction === "role") return "role";
  const better = row.def.direction === "up" ? row.delta > 0 : row.delta < 0;
  return better ? "good" : "bad";
}

/** "6~38" / "37.8%~100.0%". 점이 없으면 null. */
export function formatRecentRange(row: RecentRow): string | null {
  if (row.lo == null || row.hi == null) return null;
  const d = row.def.rangeDigits;
  const unit = row.def.kind === "pct" ? "%" : "";
  return `${row.lo.toFixed(d)}${unit}~${row.hi.toFixed(d)}${unit}`;
}
