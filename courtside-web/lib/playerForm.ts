import { supabaseServer as supabase } from "./supabaseServer";
import { TAG, TTL, cached } from "./cachePolicy";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { getPlayerCareerGames, type CareerGameRow } from "./playerProfile";
import { OPEN_MATCH_CATEGORY, PLAYOFF_CATEGORY, seasonStartYear } from "./playerPageData";
import { SEASON_CATEGORY_REGULAR, num } from "./teamSeasonStats";
import { PERCENTILE_FINAL, seasonShort } from "./seasonFocus";

// 다중 시즌 폼(요청: "선수들 폼을, 최근 5경기가 아닌, 많은 시즌을 비교, 그리고 그 이전 시즌을
// 비교하는 느낌으로") - 한 선수의 모든 시즌을 "비율"로 나란히 놓고, 직전 시즌 대비 변화를
// 명시하는 표의 데이터 레이어.
//
// ── 왜 경기당이 아니라 75포제션당인가 ────────────────────────────────────────────────
// 선수 페이지에 이미 있는 모든 시즌 수치는 경기당(PPG/RPG/APG)이다. 경기당은 출전 시간과
// 팀 페이스가 섞여 있어서 "역할이 바뀌었는가"를 못 읽는다. 참고 이미지(Thinking-Basketball의
// "Per 75 stats")의 75는 경기 수가 아니라 포제션 수다 - 이 파일은 그 정의를 따르고, 화면
// 라벨은 반드시 '75포제션당'이라고 적어 오해를 막는다(사용자가 처음 '75경기'로 읽었다).
//
// 실측 근거(자밀 워니 291248 정규시즌, 2026-09-04 SQL 대조):
//   19-20 30.0점 4.5AST 15.3REB(추정 2,196포제션) … 25-26 29.0 / 6.0 / 13.6(2,993포제션)
//   어시스트 4.5 -> 6.0, 리바운드 15.3 -> 13.6. 경기당 뷰에서는 보이지 않던 역할 이동이다.
//
// ── 온코트 포제션 "추정" ─────────────────────────────────────────────────────────────
// 이 DB에는 선수별 온코트 포제션 로그가 없다. 그래서 경기마다
//     추정 포제션 = game_team_stats.poss × (선수 출전 분 / 40)
// 으로 배분한다. poss는 15시즌 8,554개 팀-경기 행 전부 채워져 있고(실측 NULL 0건, 리그 평균
// 71.8/경기), 40은 정규 경기 시간이다.
//
// 이 추정의 알려진 오차 두 가지 - 캡션에 그대로 싣는다:
//   (1) 연장 경기에서는 분모 40이 실제 경기 길이보다 짧아 포제션을 과대 추정한다. 팀-경기
//       8,414개 중 연장은 376개(4.5%). 실제 경기 길이(팀 총 출전분/5)로 바꿔 재보면 워니의
//       시즌 포제션이 최대 2.6% 줄고(22-23 3,297 -> 3,215) 75포제션당 득점은 29.75 -> 30.51로
//       올라간다. 즉 이 방식은 "덜 유리한 쪽"으로 치우친 보수적 추정이다.
//   (2) 실제 온코트 포제션은 그가 뛴 구간의 페이스에 좌우되는데 여기서는 경기 평균 페이스를
//       쓴다. 벤치 유닛이 유난히 빠르거나 느린 팀에서 오차가 커진다.
// 두 오차 모두 "추정"이라는 라벨 없이 내보내면 안 된다.

/** 정규 경기 시간(분). 포제션 배분의 분모. */
export const REGULATION_MINUTES = 40;

/** 비율의 기준 포제션 수. 참고 자료(DARKO/Thinking-Basketball)와 같은 75. */
export const PER_POSS_BASE = 75;

/** 분당 비율의 기준(경기 하나 = 40분). */
export const PER_MIN_BASE = 40;

/** 비율 지표 자격 - 저장소 선례 그대로(lib/seasonFocus.ts PERCENTILE_FINAL): 15경기 또는 300분. */
export const FORM_QUALIFY = PERCENTILE_FINAL;

/**
 * "표본이 얇다"고 표시할 추정 포제션 하한.
 * 근거: 자격선 300분을 리그 평균 페이스(약 72포제션/40분)로 환산하면 300/40×72 ≈ 540포제션.
 * 자격(경기 수 OR 분)을 통과해도 포제션이 이보다 적으면 75포제션당 값은 노이즈다
 * (실측: 조은후 291499 25-26 = 42경기로 자격 통과, 그러나 추정 434포제션).
 */
export const FORM_THIN_POSS = 540;

/** 최근 구간의 기본 경기 수 - 선수 페이지 §9 토글(lib/playerProfile.ts WINDOWS)의 기본값과 같은 15. */
export const FORM_DEFAULT_RECENT_N = 15;

// ---------------------------------------------------------------------------
// 지표 정의 - 화면은 리터럴 라벨을 만들지 말고 이 배열을 쓴다.
// ---------------------------------------------------------------------------

export const FORM_RATE_KEYS = ["pts", "reb", "ast", "stl", "blk", "tov", "fga", "tpa", "ftm"] as const;
export type FormRateKey = (typeof FORM_RATE_KEYS)[number];

export const FORM_PCT_KEYS = ["ts", "efg", "usg"] as const;
export type FormPctKey = (typeof FORM_PCT_KEYS)[number];

export type FormMetricDef = {
  key: FormRateKey | FormPctKey;
  label: string;
  /** 표 헤더용 짧은 표기(전부 Latin/숫자 - 한글은 label만 쓴다). */
  short: string;
  /** 소수 자리. */
  digits: number;
  /** 낮을수록 좋은 지표(턴오버)면 false. */
  higherIsBetter: boolean;
  /** 방향이 없는 스타일 지표(시도 수·USG) - 좋고나쁨 색을 쓰지 말 것. */
  neutral: boolean;
  note: string | null;
};

export const FORM_RATE_DEFS: FormMetricDef[] = [
  { key: "pts", label: "득점", short: "PTS", digits: 1, higherIsBetter: true, neutral: false, note: null },
  { key: "reb", label: "리바운드", short: "REB", digits: 1, higherIsBetter: true, neutral: false, note: "총 리바운드 - 이 DB의 game_player_stats.oreb/dreb는 15시즌 전 행 NULL이라 공/수 분해가 불가능하다" },
  { key: "ast", label: "어시스트", short: "AST", digits: 1, higherIsBetter: true, neutral: false, note: null },
  { key: "stl", label: "스틸", short: "STL", digits: 1, higherIsBetter: true, neutral: false, note: null },
  { key: "blk", label: "블록", short: "BLK", digits: 1, higherIsBetter: true, neutral: false, note: null },
  { key: "tov", label: "턴오버", short: "TOV", digits: 1, higherIsBetter: false, neutral: false, note: null },
  { key: "fga", label: "야투 시도", short: "FGA", digits: 1, higherIsBetter: true, neutral: true, note: "2점+3점 합계. 이 DB의 fga는 2점 전용이라 반드시 tpa를 더해야 한다" },
  { key: "tpa", label: "3점 시도", short: "3PA", digits: 1, higherIsBetter: true, neutral: true, note: "많고 적음은 스타일이지 우열이 아니다" },
  { key: "ftm", label: "자유투 성공", short: "FTM", digits: 1, higherIsBetter: true, neutral: false, note: null },
];

export const FORM_PCT_DEFS: FormMetricDef[] = [
  { key: "ts", label: "TS%", short: "TS%", digits: 1, higherIsBetter: true, neutral: false, note: "득점 / (2 × (야투 시도 + 0.44×자유투 시도))" },
  { key: "efg", label: "eFG%", short: "eFG%", digits: 1, higherIsBetter: true, neutral: false, note: "(2점 성공 + 1.5×3점 성공) / (2점 시도 + 3점 시도)" },
  { key: "usg", label: "USG%", short: "USG%", digits: 1, higherIsBetter: true, neutral: true, note: "경기별 usage_rtg의 출전 시간 가중 평균(짧게 뛴 경기가 과대 반영되지 않게). 리그 평균은 정의상 20%" },
];

/** key -> 정의(화면이 매번 find 하지 않도록). */
export const FORM_METRIC_BY_KEY: Record<string, FormMetricDef> = Object.fromEntries(
  [...FORM_RATE_DEFS, ...FORM_PCT_DEFS].map((d) => [d.key, d])
);

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

/** 원자료 합계 - 화면에 쓰지 않아도 검산에 필요해서 그대로 내보낸다. fga/fgm은 2점 전용. */
export type FormTotals = {
  pts: number; reb: number; ast: number; stl: number; blk: number; tov: number;
  fgm: number; fga: number; tpm: number; tpa: number; ftm: number; fta: number;
};

export type FormRates = {
  /** 75포제션당(추정). */
  per75: Record<FormRateKey, number>;
  /** 40분당. 포제션 추정이 개입하지 않는 값 - 추정이 불편한 독자를 위한 대조군. */
  per40: Record<FormRateKey, number>;
  /** 비율 지표. 표본이 0이면 null. */
  pct: Record<FormPctKey, number | null>;
};

/** 직전 시즌 대비 변화(같은 키). 직전 시즌이 없으면 행 전체가 null. */
export type FormDelta = {
  per75: Record<FormRateKey, number>;
  per40: Record<FormRateKey, number>;
  pct: Record<FormPctKey, number | null>;
};

export type FormRowKind = "season" | "career" | "recent";

export type FormRow = {
  kind: FormRowKind;
  /** "2025-2026" | "career" | "recent" - React key로 쓸 수 있는 고유값. */
  key: string;
  /** "25-26" | "커리어" | "최근 15경기". */
  label: string;
  seasonName: string | null;
  /** "정규시즌" | "플레이오프" | "혼합"(최근 구간이 두 카테고리에 걸칠 때). */
  seasonCategory: string;
  /** 그 구간에 뛴 팀(먼저 뛴 순). 2개면 시즌 중 이적. */
  tcodes: string[];
  /** 출전 경기(0분 엔트리 제외). */
  gp: number;
  /** 엔트리 행 수(0분 DNP 포함) - gp와 다르면 결장/미출전이 있었다는 뜻. */
  entries: number;
  minutes: number;
  /** 추정 온코트 포제션. */
  poss: number;
  /** poss / minutes × 40 = 그가 뛴 경기들의 평균 페이스(참고값). */
  possPer40: number;
  totals: FormTotals;
  rates: FormRates;
  /** 같은 표 안에서 바로 앞 시즌 대비 변화. 첫 시즌·커리어·최근 행은 null. */
  delta: FormDelta | null;
  /** delta의 기준이 된 행 key. */
  prevKey: string | null;
  /** 직전 시즌과의 사이에 건너뛴 시즌 수(부상·해외·미계약). 0이면 연속. */
  gapSeasons: number;
  /** 비율 지표 자격(15경기 또는 300분). */
  qualified: boolean;
  /** 추정 포제션이 FORM_THIN_POSS 미만 - 자격을 통과해도 75포제션당 값은 흐리게 그린다. */
  thin: boolean;
  /** "50경기 · 1,685분 · 추정 2,993포제션" - 값 옆에 반드시 붙일 표본. */
  sample: string;
  /** 이 행에만 해당하는 경고(표본·이적·공백). 없으면 null. */
  note: string | null;
  /** 같은 시즌 리그 기준선(평균 선수 1명 몫). 리그 집계가 없으면 null. */
  league: FormRates | null;
};

export type PlayerForm = {
  pcode: string;
  /** 정규시즌, 오름차순(옛 시즌 -> 최신). 표는 이 순서 그대로 그리면 된다. */
  seasons: FormRow[];
  /** 플레이오프, 오름차순. 없으면 빈 배열. */
  playoffs: FormRow[];
  /** 정규시즌 커리어 합. */
  career: FormRow | null;
  /** 정규+플레이오프 커리어 합(라인업·온오프 패널과 표본을 맞출 때). */
  careerAll: FormRow | null;
  /** 최근 N "출전"(카테고리 무관). 출전 기록이 없으면 null. */
  recent: FormRow | null;
  recentN: number;
  seasonsPlayed: number;
  /** 시즌별 리그 기준선(리그 평균 선수 1명 몫) - seasons에 이미 붙어 있지만 별도 조회용. */
  /**
   * 시즌 -> 리그 평균. Map이 아니라 객체인 이유: 이 값은 unstable_cache 경계를 넘는데
   * Map은 직렬화되지 않는다(lib/cachePolicy.ts). 조회는 leagueBySeason[season]으로 같다.
   */
  leagueBySeason: Record<string, FormRates>;
  possFormula: string;
  estimateNote: string;
  qualifyNote: string;
  leagueNote: string;
  caption: string;
};

// ---------------------------------------------------------------------------
// 리그 팀-경기 원본(포제션 배분 + 리그 기준선을 한 번의 조회로 함께 조달)
// ---------------------------------------------------------------------------

type TeamGameRow = {
  gmkey: string;
  tcode: string;
  score: number | null;
  reb: number | null; ast: number | null; stl: number | null; blk: number | null; turnovers: number | null;
  fgm: number | null; fga: number | null; tpm: number | null; tpa: number | null; ftm: number | null; fta: number | null;
  poss: number | null;
  games: { season_name: string; season_category: string } | { season_name: string; season_category: string }[];
};

const TEAM_SELECT =
  "gmkey, tcode, score, reb, ast, stl, blk, turnovers, fgm, fga, tpm, tpa, ftm, fta, poss, games!inner(season_name, season_category)";

/**
 * 선수가 뛴 시즌 전체의 팀-경기 행.
 *
 * game_team_stats에는 시즌 컬럼이 없어서 gmkey로 좁히는 게 저장소 관례지만(lib/teamSeasonStats.ts
 * GMKEY_CHUNK), 15시즌이면 gmkey가 4,300개라 IN 청크가 36번이 된다. 대신 games!inner 임베드에
 * 필터를 걸면(PostgREST가 지원 - 2026-09-04 실측 확인) 한 질의를 .range로 나눠 받는 것으로 끝난다.
 * 실측 행 수: 2시즌 1,136행 / 15시즌 약 8,554행(= 페이지 9장, fetchAllPagesBounded가 병렬로 받음).
 */
async function fetchSeasonTeamGames(seasons: string[]): Promise<TeamGameRow[]> {
  if (!seasons.length) return [];
  return fetchAllPagesBounded<TeamGameRow>((from, to) =>
    supabase
      .from("game_team_stats")
      .select(TEAM_SELECT, { count: "exact" })
      .in("games.season_name", seasons)
      .eq("games.is_ended", true)
      .order("gmkey", { ascending: true })
      .order("tcode", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: TeamGameRow[] | null; error: unknown; count: number | null }>
  );
}

function gameMeta(r: TeamGameRow): { season: string; category: string } {
  const g = Array.isArray(r.games) ? r.games[0] : r.games;
  return { season: g?.season_name ?? "", category: g?.season_category ?? "" };
}

// ---------------------------------------------------------------------------
// 집계
// ---------------------------------------------------------------------------

const ZERO_TOTALS = (): FormTotals => ({
  pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0,
  fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
});

function addGame(t: FormTotals, g: CareerGameRow): void {
  t.pts += g.pts; t.reb += g.reb; t.ast += g.ast; t.stl += g.stl; t.blk += g.blk; t.tov += g.tov;
  t.fgm += g.fgm; t.fga += g.fga; t.tpm += g.tpm; t.tpa += g.tpa; t.ftm += g.ftm; t.fta += g.fta;
}

/** 카운팅 지표 하나를 꺼내는 함수. fga만 "2점+3점 합계"로 합쳐서 돌려준다(이 DB의 함정). */
function counting(t: FormTotals, key: FormRateKey): number {
  switch (key) {
    case "fga":
      return t.fga + t.tpa;
    default:
      return t[key];
  }
}

function makeRates(t: FormTotals, poss: number, minutes: number, usgWeighted: number | null): FormRates {
  const per75 = {} as Record<FormRateKey, number>;
  const per40 = {} as Record<FormRateKey, number>;
  for (const k of FORM_RATE_KEYS) {
    const v = counting(t, k);
    per75[k] = poss > 0 ? (v / poss) * PER_POSS_BASE : 0;
    per40[k] = minutes > 0 ? (v / minutes) * PER_MIN_BASE : 0;
  }
  const fgaTotal = t.fga + t.tpa;
  const tsa = fgaTotal + 0.44 * t.fta;
  return {
    per75,
    per40,
    pct: {
      ts: tsa > 0 ? (t.pts / (2 * tsa)) * 100 : null,
      efg: fgaTotal > 0 ? ((t.fgm + 1.5 * t.tpm) / fgaTotal) * 100 : null,
      usg: usgWeighted,
    },
  };
}

function makeDelta(cur: FormRates, prev: FormRates): FormDelta {
  const per75 = {} as Record<FormRateKey, number>;
  const per40 = {} as Record<FormRateKey, number>;
  for (const k of FORM_RATE_KEYS) {
    per75[k] = cur.per75[k] - prev.per75[k];
    per40[k] = cur.per40[k] - prev.per40[k];
  }
  const pct = {} as Record<FormPctKey, number | null>;
  for (const k of FORM_PCT_KEYS) {
    const a = cur.pct[k];
    const b = prev.pct[k];
    pct[k] = a == null || b == null ? null : a - b;
  }
  return { per75, per40, pct };
}

const fmtInt = (v: number) => Math.round(v).toLocaleString();

function sampleText(gp: number, entries: number, minutes: number, poss: number): string {
  const dnp = entries - gp;
  const head = dnp > 0 ? `${gp}경기(엔트리 ${entries})` : `${gp}경기`;
  return `${head} · ${fmtInt(minutes)}분 · 추정 ${fmtInt(poss)}포제션`;
}

type Bucket = {
  rows: CareerGameRow[];
  totals: FormTotals;
  minutes: number;
  poss: number;
  gp: number;
  entries: number;
  tcodes: string[];
  /** 포제션을 못 구한 경기 수(실측 0건이지만 방어). */
  possMissing: number;
  /** 포제션을 구한 경기들만의 합계 - 분자/분모 표본을 어긋나게 두지 않기 위해 따로 센다. */
  possTotals: FormTotals;
};

function newBucket(): Bucket {
  return { rows: [], totals: ZERO_TOTALS(), minutes: 0, poss: 0, gp: 0, entries: 0, tcodes: [], possMissing: 0, possTotals: ZERO_TOTALS() };
}

function pushGame(b: Bucket, g: CareerGameRow, poss: number | null): void {
  b.rows.push(g);
  b.entries += 1;
  if (g.min > 0) b.gp += 1;
  b.minutes += g.min;
  addGame(b.totals, g);
  if (!b.tcodes.includes(g.tcode)) b.tcodes.push(g.tcode);
  if (poss == null) {
    if (g.min > 0) b.possMissing += 1;
    return;
  }
  b.poss += poss;
  addGame(b.possTotals, g);
}

/** 출전 시간 가중 USG%. usage_rtg가 없는 경기는 분모에서도 뺀다. */
function weightedUsg(rows: { min: number; usg: number | null }[]): number | null {
  let num_ = 0;
  let den = 0;
  for (const r of rows) {
    if (r.usg == null || r.min <= 0) continue;
    num_ += r.usg * r.min;
    den += r.min;
  }
  return den > 0 ? num_ / den : null;
}

// ---------------------------------------------------------------------------
// 리그 기준선
// ---------------------------------------------------------------------------

/**
 * 리그 "평균 선수 1명" 기준선.
 *
 * 왜 중앙값이 아니라 평균인가(브리프의 요청은 자격 선수들의 중앙값이었다):
 * 중앙값을 내려면 그 시즌 선수-경기 행 전부(시즌당 6,800행)를 시즌마다 다시 받아 선수별
 * 포제션을 추정해야 한다 - 15시즌 커리어면 10만 행이다. 반면 평균은 팀 합계만으로 정확히
 * 나온다: 코트 위에는 항상 5명이 있으므로 "평균 선수"의 생산은 정의상 팀 생산의 1/5다.
 *     리그 기준 75포제션당 X = (Σ 팀 X / Σ 팀 포제션) × 75 ÷ 5
 * 즉 이 값은 근사가 아니라 항등식이고, 팀-경기 행(시즌당 570행)만 읽으면 된다.
 * 화면 문구는 '리그 평균(팀 생산의 1/5)'으로 쓰고 '중앙값'이라고 쓰지 않는다.
 *
 * 실측(2025-2026 정규시즌 540행): 16.32점 / 7.26REB / 3.80AST / TS 53.3% / eFG 50.4%.
 * (같은 시즌 워니 29.0점은 리그 평균의 1.78배, 조은후 4.7AST는 평균 3.80의 1.24배다.)
 */
function leagueRates(rows: TeamGameRow[]): FormRates | null {
  if (!rows.length) return null;
  const t = ZERO_TOTALS();
  let poss = 0;
  let n = 0;
  for (const r of rows) {
    t.pts += num(r.score); t.reb += num(r.reb); t.ast += num(r.ast); t.stl += num(r.stl);
    t.blk += num(r.blk); t.tov += num(r.turnovers);
    t.fgm += num(r.fgm); t.fga += num(r.fga); t.tpm += num(r.tpm); t.tpa += num(r.tpa);
    t.ftm += num(r.ftm); t.fta += num(r.fta);
    poss += num(r.poss);
    n += 1;
  }
  if (poss <= 0 || n <= 0) return null;

  const per75 = {} as Record<FormRateKey, number>;
  const per40 = {} as Record<FormRateKey, number>;
  for (const k of FORM_RATE_KEYS) {
    const v = counting(t, k);
    // 75포제션당: 팀 값 ÷ 팀 포제션 × 75 ÷ 5(코트 위 5명).
    per75[k] = (v / poss) * PER_POSS_BASE / 5;
    // 40분당: 선수 쪽과 같은 40분 규약을 쓰면 팀-경기의 선수-분은 200분이므로
    //   (v / (200×n)) × 40 = v / (5×n). 선수 쪽 분모와 정확히 같은 규약이다.
    per40[k] = v / (5 * n);
  }
  const fgaTotal = t.fga + t.tpa;
  const tsa = fgaTotal + 0.44 * t.fta;
  return {
    per75,
    per40,
    pct: {
      ts: tsa > 0 ? (t.pts / (2 * tsa)) * 100 : null,
      efg: fgaTotal > 0 ? ((t.fgm + 1.5 * t.tpm) / fgaTotal) * 100 : null,
      // USG%는 정의상 코트 위 5명이 100%를 나눠 갖는다 - 리그 평균은 언제나 20%.
      usg: 20,
    },
  };
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export type PlayerFormOptions = {
  /** 페이지가 이미 받아 둔 getPlayerCareerGames 결과. 주면 재조회하지 않는다. */
  careerRows?: CareerGameRow[];
  /** "최근 N경기" 행의 N(페이지 §9 토글 값). 기본 FORM_DEFAULT_RECENT_N. */
  recentN?: number;
};

/**
 * 다중 시즌 폼 표.
 *
 * 조회 비용(실측): 커리어 경기 1회(페이지가 이미 갖고 있으면 0회) + 팀-경기 1회(시즌 수에
 * 비례, 4시즌이면 약 2,280행/3페이지, 15시즌이면 약 8,554행/9페이지 병렬).
 * 출전 기록이 하나도 없으면 seasons가 빈 배열인 PlayerForm을 돌려준다(null이 아님 - 화면이
 * 캡션과 빈 상태를 그대로 그릴 수 있게).
 */
/**
 * 캐시 키는 (pcode, recentN). careerRows는 pcode에서 파생된 값이라 키에 넣을 필요가 없고,
 * recentN(?w=)은 결과를 바꾸므로 반드시 들어가야 한다.
 * 캐시 히트에서는 주입한 careerRows가 쓰이지 않는다 - 같은 pcode면 같은 값이라 문제없다.
 */
export function getPlayerForm(pcode: string, opts?: PlayerFormOptions): Promise<PlayerForm> {
  const recentN = opts?.recentN ?? FORM_DEFAULT_RECENT_N;
  return cached(
    () => computePlayerForm(pcode, opts),
    ["playerForm", pcode, String(recentN)],
    TTL.batchDaily,
    [TAG.batch, `player:${pcode}`]
  );
}

async function computePlayerForm(pcode: string, opts?: PlayerFormOptions): Promise<PlayerForm> {
  const recentN = opts?.recentN ?? FORM_DEFAULT_RECENT_N;
  const all = (opts?.careerRows ?? (await getPlayerCareerGames(pcode))).filter((r) => r.isEnded);
  // 날짜 오름차순(같은 날이면 gmkey) - 시즌 순서와 "최근 N"이 같은 정렬을 쓰게.
  const rows = all.slice().sort((a, b) => (a.gameDate !== b.gameDate ? (a.gameDate < b.gameDate ? -1 : 1) : a.gmkey < b.gmkey ? -1 : 1));

  const seasons = [...new Set(rows.map((r) => r.seasonName))].sort();
  const teamRows = seasons.length ? await fetchSeasonTeamGames(seasons) : [];

  // (gmkey, tcode) -> 그 경기 그 팀의 포제션.
  const possByGameTeam = new Map<string, number>();
  // 시즌 -> 카테고리 -> 팀-경기 행(리그 기준선).
  const leagueRows = new Map<string, Map<string, TeamGameRow[]>>();
  for (const r of teamRows) {
    if (r.poss != null) possByGameTeam.set(`${r.gmkey}|${r.tcode}`, num(r.poss));
    const { season, category } = gameMeta(r);
    const byCat = leagueRows.get(season) ?? new Map<string, TeamGameRow[]>();
    (byCat.get(category) ?? byCat.set(category, []).get(category)!).push(r);
    leagueRows.set(season, byCat);
  }

  // 카테고리별로 따로 만든다 - 플레이오프 행 옆에 정규시즌 리그 평균을 놓으면 표본이 어긋난다
  // (PO는 리그 페이스·효율이 정규시즌과 다르다).
  const leagueByKey = new Map<string, FormRates>();
  const leagueBySeason: Record<string, FormRates> = {};
  for (const [season, byCat] of leagueRows) {
    for (const [category, list] of byCat) {
      const r = leagueRates(list);
      if (!r) continue;
      leagueByKey.set(`${season}|${category}`, r);
      if (category === SEASON_CATEGORY_REGULAR) leagueBySeason[season] = r;
    }
  }

  const possOf = (g: CareerGameRow): number | null => {
    const p = possByGameTeam.get(`${g.gmkey}|${g.tcode}`);
    if (p == null) return null;
    return (p * g.min) / REGULATION_MINUTES;
  };

  // usage_rtg는 CareerGameRow에 없다(getPlayerCareerGames가 안 뽑는다) - 시즌별 가중 USG%만
  // 따로 조회한다. 선수 한 명의 커리어 전체라도 최대 639행이라 한 번이면 끝난다.
  const usgByGmkey = await fetchUsage(pcode);
  const usgRows = (list: CareerGameRow[]) => list.map((g) => ({ min: g.min, usg: usgByGmkey.get(g.gmkey) ?? null }));

  function buildRow(
    kind: FormRowKind,
    key: string,
    label: string,
    seasonName: string | null,
    seasonCategory: string,
    list: CareerGameRow[]
  ): FormRow | null {
    if (!list.length) return null;
    const b = newBucket();
    for (const g of list) pushGame(b, g, possOf(g));
    if (b.gp === 0) return null; // 0분 엔트리만 있는 구간은 비율을 만들 수 없다

    const rates = makeRates(b.possTotals, b.poss, b.minutes, weightedUsg(usgRows(list)));
    const qualified = b.gp >= FORM_QUALIFY.gp || b.minutes >= FORM_QUALIFY.min;
    const thin = b.poss < FORM_THIN_POSS;
    const notes: string[] = [];
    if (!qualified) notes.push(`비율 자격 미달(${FORM_QUALIFY.gp}경기 또는 ${FORM_QUALIFY.min}분)`);
    else if (thin) notes.push(`추정 ${fmtInt(b.poss)}포제션 - 75포제션당 값은 표본이 얇다(${FORM_THIN_POSS} 미만)`);
    // 이적 경고는 시즌 행에만. 커리어 행에서 "팀이 둘 이상"은 이적한 선수라면 언제나 참이라
    // 정보가 되지 않는다(김선형 SK->KT, 해먼즈 KT->모비스에서 매번 뜬다).
    if (kind === "season" && b.tcodes.length > 1) notes.push("이 구간에 소속 팀이 둘 이상이다");
    if (b.possMissing > 0) notes.push(`포제션을 못 구한 경기 ${b.possMissing}개는 75포제션당 계산에서 제외했다`);

    return {
      kind,
      key,
      label,
      seasonName,
      seasonCategory,
      tcodes: b.tcodes,
      gp: b.gp,
      entries: b.entries,
      minutes: b.minutes,
      poss: b.poss,
      possPer40: b.minutes > 0 ? (b.poss / b.minutes) * PER_MIN_BASE : 0,
      totals: b.totals,
      rates,
      delta: null,
      prevKey: null,
      gapSeasons: 0,
      qualified,
      thin,
      sample: sampleText(b.gp, b.entries, b.minutes, b.poss),
      note: notes.length ? notes.join(" · ") : null,
      league: seasonName ? leagueByKey.get(`${seasonName}|${seasonCategory}`) ?? null : null,
    };
  }

  // ── 시즌 행(정규시즌) ──────────────────────────────────────────────────────────────
  // 시즌/커리어 행은 "정규시즌"·"정규+PO" 라벨을 달고 나가므로 오픈매치(전시경기)를 걷어낸다.
  // "최근 N경기"(recentList, 아래)는 카테고리 무관이 설계 의도라 이 필터를 타지 않는다.
  const seasonScopedRows = rows.filter((g) => g.seasonCategory !== OPEN_MATCH_CATEGORY);
  const bySeasonReg = new Map<string, CareerGameRow[]>();
  const bySeasonPo = new Map<string, CareerGameRow[]>();
  for (const g of seasonScopedRows) {
    const target = g.seasonCategory === PLAYOFF_CATEGORY ? bySeasonPo : bySeasonReg;
    (target.get(g.seasonName) ?? target.set(g.seasonName, []).get(g.seasonName)!).push(g);
  }

  const seasonRows: FormRow[] = [];
  for (const s of seasons) {
    const r = buildRow("season", s, seasonShort(s), s, SEASON_CATEGORY_REGULAR, bySeasonReg.get(s) ?? []);
    if (r) seasonRows.push(r);
  }
  // 직전 "표에 있는" 시즌과의 차이. 공백 시즌(부상·해외)은 건너뛴 시즌 수를 따로 표기한다 -
  // 리그는 2011-12부터 2025-26까지 한 시즌도 거르지 않고 열렸으므로(실측) 연도 차 - 1이 곧 공백 수다.
  for (let i = 1; i < seasonRows.length; i++) {
    const cur = seasonRows[i];
    const prev = seasonRows[i - 1];
    cur.delta = makeDelta(cur.rates, prev.rates);
    cur.prevKey = prev.key;
    cur.gapSeasons = Math.max(0, seasonStartYear(cur.seasonName!) - seasonStartYear(prev.seasonName!) - 1);
    if (cur.gapSeasons > 0) {
      cur.note = [cur.note, `직전 출전 시즌은 ${seasonShort(prev.seasonName!)} - ${cur.gapSeasons}시즌 공백 뒤의 비교다`]
        .filter(Boolean)
        .join(" · ");
    }
  }

  const playoffRows: FormRow[] = [];
  for (const s of seasons) {
    const r = buildRow("season", `${s}__po`, seasonShort(s), s, PLAYOFF_CATEGORY, bySeasonPo.get(s) ?? []);
    if (r) playoffRows.push(r);
  }
  for (let i = 1; i < playoffRows.length; i++) {
    playoffRows[i].delta = makeDelta(playoffRows[i].rates, playoffRows[i - 1].rates);
    playoffRows[i].prevKey = playoffRows[i - 1].key;
  }

  const regAll = seasonScopedRows.filter((g) => g.seasonCategory !== PLAYOFF_CATEGORY);
  const career = buildRow("career", "career", "커리어", null, SEASON_CATEGORY_REGULAR, regAll);
  const careerAll = buildRow("career", "careerAll", "커리어(정규+PO)", null, "혼합", seasonScopedRows);

  // ── 최근 N "출전" ─────────────────────────────────────────────────────────────────
  // 창의 단위를 "밤"이 아니라 "출전"으로 잡는 이유는 페이지 §9와 같다(0분 엔트리를 한 칸으로
  // 세면 L15가 바로 아래 '최근 15경기 평균'과 다른 15개를 가리키게 된다).
  const appearances = rows.filter((g) => g.min > 0);
  const recentList = appearances.slice(Math.max(0, appearances.length - recentN));
  const recentCats = [...new Set(recentList.map((g) => g.seasonCategory))];
  const recent = buildRow(
    "recent",
    "recent",
    `최근 ${recentList.length}경기`,
    null,
    recentCats.length === 1 ? recentCats[0] : "혼합",
    recentList
  );
  if (recent) {
    // 최근 구간의 비교 상대는 "직전 시즌"이 아니라 "그 선수의 최신 시즌"이다 - 폼이 시즌
    // 기준선에서 얼마나 벗어나 있는지가 이 행의 존재 이유다.
    const base = seasonRows[seasonRows.length - 1];
    if (base) {
      recent.delta = makeDelta(recent.rates, base.rates);
      recent.prevKey = base.key;
    }
    const seasonsInWindow = [...new Set(recentList.map((g) => g.seasonName))];
    if (seasonsInWindow.length > 1) {
      recent.note = [recent.note, `이 구간은 ${seasonsInWindow.map(seasonShort).join("·")} 시즌에 걸쳐 있다`].filter(Boolean).join(" · ");
    }
    if (recentCats.length > 1) {
      recent.note = [recent.note, "정규시즌과 플레이오프가 섞인 구간이다"].filter(Boolean).join(" · ");
    }
    // 최근 구간의 리그 기준선은 그 구간 마지막 시즌의 정규시즌 값이다 - 구간이 두 시즌이나
    // 정규/PO에 걸치면 근사이고, 그 사실은 바로 위 note에 이미 적혀 있다.
    const lastSeason = recentList[recentList.length - 1]?.seasonName;
    recent.league = lastSeason ? leagueBySeason[lastSeason] ?? null : null;
  }

  const possFormula = `추정 온코트 포제션 = Σ(그 경기 팀 포제션 × 출전 분 ÷ ${REGULATION_MINUTES})`;
  const estimateNote =
    "선수별 온코트 포제션 로그가 없어 팀 포제션을 출전 시간으로 배분한 추정값이다. " +
    `연장 경기(팀-경기의 4.5%)에서는 분모 ${REGULATION_MINUTES}분이 실제 경기 길이보다 짧아 포제션을 조금 과대 추정한다` +
    "(실측 최대 편차 2.6%, 방향은 75포제션당 값을 낮추는 쪽).";
  const qualifyNote = `비율 자격: ${FORM_QUALIFY.gp}경기 또는 ${FORM_QUALIFY.min}분 · 추정 ${FORM_THIN_POSS}포제션 미만은 '표본 얇음'으로 표시`;
  const leagueNote =
    "리그 기준선은 '평균 선수 1명 몫' = 팀 합계 ÷ 팀 포제션 × 75 ÷ 5(코트 위 5명). " +
    "자격 선수들의 중앙값이 아니다 - 중앙값은 시즌마다 선수-경기 6,800행을 다시 받아야 해서 이 표에서는 내지 않는다.";

  const caption =
    `${seasonRows.length}시즌 정규시즌 · ${possFormula} · ` +
    `기준 75포제션 = 대략 한 경기 팀 포제션(리그 평균 71.8)에 가까운 양`;

  return {
    pcode,
    seasons: seasonRows,
    playoffs: playoffRows,
    career,
    careerAll,
    recent,
    recentN,
    seasonsPlayed: seasonRows.length,
    leagueBySeason,
    possFormula,
    estimateNote,
    qualifyNote,
    leagueNote,
    caption,
  };
}

/**
 * 선수 커리어 전 경기의 usage_rtg(가중 USG% 계산용).
 * game_player_stats를 pcode로 직접 읽는다 - idx_gps_pcode가 있어 빠르고, 커리어 최대 639행이다.
 */
async function fetchUsage(pcode: string): Promise<Map<string, number>> {
  const rows = await fetchAllPagesBounded<{ gmkey: string; usage_rtg: number | null }>((from, to) =>
    supabase
      .from("game_player_stats")
      .select("gmkey, usage_rtg", { count: "exact" })
      .eq("pcode", pcode)
      .order("gmkey", { ascending: true })
      .range(from, to)
  );
  const out = new Map<string, number>();
  for (const r of rows) if (r.usage_rtg != null) out.set(r.gmkey, num(r.usage_rtg));
  return out;
}

// ---------------------------------------------------------------------------
// 표시 헬퍼 - 화면이 포맷을 새로 발명하지 않도록
// ---------------------------------------------------------------------------

/** 비율 값 표시("29.0" / "53.3%"). 값이 없으면 "-". */
export function formatRate(key: FormRateKey | FormPctKey, v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const def = FORM_METRIC_BY_KEY[key];
  const d = def?.digits ?? 1;
  return FORM_PCT_KEYS.includes(key as FormPctKey) ? `${v.toFixed(d)}%` : v.toFixed(d);
}

/** 변화량 표시("+1.5" / "-0.4" / "0.0"). 0은 부호를 붙이지 않는다(기준선 그 자체). */
export function formatDelta(key: FormRateKey | FormPctKey, v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const d = FORM_METRIC_BY_KEY[key]?.digits ?? 1;
  const snapped = Math.abs(v) < 0.5 / 10 ** d ? 0 : v;
  const body = `${snapped > 0 ? "+" : ""}${snapped.toFixed(d)}`;
  return FORM_PCT_KEYS.includes(key as FormPctKey) ? `${body}p` : body;
}

/**
 * 변화의 '좋고 나쁨'. 방향 없는 지표(시도 수·USG)는 항상 "neutral" - 색을 쓰지 말라는 신호다.
 * 턴오버는 낮을수록 좋으므로 감소가 "good"이다.
 */
export function deltaTone(key: FormRateKey | FormPctKey, v: number | null): "good" | "bad" | "flat" | "neutral" {
  const def = FORM_METRIC_BY_KEY[key];
  if (!def || def.neutral) return "neutral";
  if (v == null || !Number.isFinite(v)) return "flat";
  const d = def.digits;
  if (Math.abs(v) < 0.5 / 10 ** d) return "flat";
  const better = def.higherIsBetter ? v > 0 : v < 0;
  return better ? "good" : "bad";
}

/** 리그 기준선 대비 배수("리그 평균의 1.78배"). 기준선이 0이거나 없으면 null. */
export function vsLeague(row: FormRow, key: FormRateKey): number | null {
  const lg = row.league?.per75[key];
  if (lg == null || lg <= 0) return null;
  return row.rates.per75[key] / lg;
}
