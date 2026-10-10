import { supabaseServer as supabase } from "./supabaseServer";
import { TAG, TTL, cached } from "./cachePolicy";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { getPlayerCareerGames, type CareerGameRow } from "./playerProfile";
import {
  getCareerShots,
  getClutchProfile,
  getPercentileProfile,
  getSeasonWpaRank,
  DNA_ZONES,
  DNA_ZONE_LABELS,
  DNA_MIN_SEASON_SHOTS,
  PERCENTILE_MIN_GP,
  PERCENTILE_MIN_MINUTES,
  type CareerShot,
  type ClutchProfile,
  type DnaZone,
  type PercentileProfile,
} from "./playerDataScience";
import { classifyShot } from "./formIndex";
import { OPEN_MATCH_CATEGORY, PLAYOFF_CATEGORY } from "./playerPageData";
import { GMKEY_CHUNK, SEASON_CATEGORY_REGULAR, chunk, num } from "./teamSeasonStats";
import { ONOFF_MIN, seasonShort } from "./seasonFocus";
import { getPlayerForm, formatRate, type PlayerForm, type FormRow } from "./playerForm";
import type { CareerGrain } from "./careerGrain";

// 선수 "한눈 카드"(요청: "선수 자세히 보기에서 첫 화면에 한눈에 볼 수 있는 개인별 시각화") -
// 히어로 바로 아래에 깔리는 조밀한 격자 하나로 "이 선수는 어떤 선수인가"에 답하는 데이터 레이어.
// 참고는 DARKO / Thinking-Basketball의 선수 카드(작은 숫자 격자 + 각 숫자 밑의 퍼센타일 바,
// SCORING / PLAYMAKING / DEFENSE 블록).
//
// ── 설계 원칙 ────────────────────────────────────────────────────────────────────────
// (1) 격자의 모양이 선수마다 바뀌면 안 된다. 표본이 없는 지표도 행을 지우지 않고 value=null +
//     dim=true + "왜 없는지"를 적은 sample로 돌려준다. 조은후(로스터 중앙값)와 워니가 같은
//     칸 수의 카드를 갖는다.
// (2) 값과 퍼센타일은 반드시 같은 표본에서 나온다. 퍼센타일이 있는 지표는 RPC 풀
//     (player_season_percentile_pool)의 값 그대로 쓰고, 분 가중 평균으로 다시 계산한 값을
//     그 옆에 놓지 않는다. 두 기준이 섞이면 "22.9점인데 퍼센타일은 다른 22.6점 기준"이 된다.
// (3) 이 DB가 못 하는 것은 만들지 않는다 - notes 배열이 그 목록을 그대로 들고 다닌다.
// (4) 퍼센타일이 순위 정보를 담지 못하는 칸에는 퍼센타일을 그리지 않는다. 축의 바닥값(0)은
//     rankPercentile 정의상 무조건 0을 받아서, 그 값을 가진 전원(실측 25-26 BPG 0.0 = 24명)이
//     "리그 단독 꼴찌"처럼 그려진다 - 그런 칸은 퍼센타일 대신 공동 인원을 인쇄한다(axisMetric).
//
// ── 두 표본의 차이(반드시 화면에 적을 것) ────────────────────────────────────────────
//   퍼센타일 축 8개  : RPC player_season_percentile_pool - 정규시즌+플레이오프, 경기당 단순
//                      평균, gp는 엔트리 행 수(0분 DNP 포함). 실측 워니 25-26 gp 53(정규 50+PO 3).
//   분 가중 고급지표 : 정규시즌만, 경기별 값을 출전 시간으로 가중. 실측 워니 25-26
//                      PER 단순평균 28.97 vs 가중 28.72 / DRtg 103.57 vs 104.06.
//                      (USG%만 예외로 정규+PO 가중값도 함께 만든다 - 퍼센타일 축과 표본을 맞춰
//                       "가중 방식만 다른" 비교값을 적기 위해서다. WeightedAdvanced.usgAllCat)
//   75포제션당       : lib/playerForm.ts(정규시즌, 팀 포제션을 출전 시간으로 배분한 추정).
//   온/오프          : lineup_stints, 정규시즌+플레이오프(라인업 표본이 귀해서 - lib/wowy.ts와 같은 규약).
//   WPA              : player_season_wpa - 원천이 정규시즌 전용.
//   클러치           : RPC player_clutch_profile - 커리어 전체(시즌 인자가 없다).

export type GlanceGroup = "득점" | "플레이메이킹" | "리바운드·수비" | "임팩트";

export const GLANCE_GROUPS: GlanceGroup[] = ["득점", "플레이메이킹", "리바운드·수비", "임팩트"];

export type GlanceMetric = {
  key: string;
  label: string;
  /** 표본이 없으면 null. 그래도 행은 사라지지 않는다(dim=true). */
  value: number | null;
  /** 화면에 그대로 인쇄할 문자열. 값이 없으면 "-". */
  display: string;
  unit: string;
  /** 0~100(높을수록 좋음으로 정규화됨). 리그 풀이 없거나 자격 미달이면 null. */
  percentile: number | null;
  /** 퍼센타일 풀 크기. percentile이 null이면 null. */
  poolN: number | null;
  /** 퍼센타일 자격 규칙 문장. percentile이 null이면 null. */
  poolRule: string | null;
  /**
   * 퍼센타일 풀에서 이 값과 정확히 같은 값을 가진 인원(자신 포함). 1이면 단독이다.
   * 퍼센타일 축이 아니거나 세지 않았으면 null(아래 fetchPercentileTies 주석 - 값이 축의
   * 바닥이라 퍼센타일이 0인 선수에게만 센다).
   */
  tieCount: number | null;
  /** 값 옆에 붙일 표본. 값이 없으면 "왜 없는지"가 여기 들어간다. */
  sample: string;
  /** 이 값이 어느 표본에서 나왔는가("25-26 정규시즌" / "25-26 정규+PO" / "커리어"). */
  basis: string;
  group: GlanceGroup;
  note: string | null;
  higherIsBetter: boolean;
  /** 방향이 없는 스타일 지표(USG·3점 비중) - 좋고나쁨 색을 쓰지 말 것. */
  neutral: boolean;
  /** 리그 기준값(퍼센타일이 없는 지표의 대안). 없으면 null. */
  leagueAvg: number | null;
  leagueLabel: string | null;
  /**
   * 흐리게 그릴 것. 두 경우를 함께 덮는다 - (a) value가 null(표본 자체가 없음),
   * (b) value는 있지만 표본이 하한 미달(75포제션당 540포제션 미만, 온/오프 300분 미만,
   * 슛 구성비 30슛 미만). 어느 쪽인지는 value === null 여부와 sample 문장으로 구분한다.
   * 어느 경우에도 행을 지우지 않는다 - 격자 모양은 선수마다 같아야 한다.
   */
  dim: boolean;
};

export type GlanceHeadline = {
  key: string;
  label: string;
  display: string;
  percentile: number;
  direction: "above" | "below";
  /** |퍼센타일 - 50|. 정렬 근거. */
  distance: number;
  /** "리그 상위 1% · PPG 22.9 (152명 중)" - 그대로 인쇄 가능한 한 줄. */
  sentence: string;
};

/** 분 가중 고급 지표(정규시즌). 값이 없으면 null. */
export type WeightedAdvanced = {
  per: number | null;
  ortg: number | null;
  drtg: number | null;
  usg: number | null;
  pie: number | null;
  gp: number;
  minutes: number;
  sample: string;
  method: string;
  /**
   * USG%만 정규시즌+플레이오프(= 퍼센타일 축과 같은 표본)로 한 번 더 가중한 값.
   * 카드의 USG% 칸은 축 값(정규+PO · 경기당 단순 평균)을 인쇄하는데, 그 옆에 "분 가중은 얼마"를
   * 적을 때 정규시즌 전용 usg를 쓰면 표본과 가중 방식이 동시에 달라져 한 문장 안의 두 숫자가
   * 두 가지 축에서 어긋난다(실측 워니 25-26: 축 36.4% = 정규+PO 53경기 단순 / 정규시즌 50경기
   * 가중 36.2% / 같은 정규+PO 53경기 가중 36.0%). 표본을 붙들고 가중만 바꾼 값이 이것이다.
   */
  usgAllCat: number | null;
  /**
   * usgAllCat의 표본 문장("53경기 · 1,790분 (정규+PO)"). 여기서 세는 "경기"는 출전 경기(0분 제외)라
   * 퍼센타일 축의 gp(엔트리 행 수, 0분 포함)와 숫자가 다를 수 있다 - 0분 행은 가중치가 0이라
   * 값에는 영향이 없다. 카드는 이 문장 대신 "같은 표본"이라고만 적는다(두 세는 법을 한 툴팁에
   * 나란히 두면 표본이 다른 것처럼 읽혀서다). 이 값을 따로 인쇄하는 화면은 이 문장을 함께 쓸 것.
   */
  allCatSample: string;
};

export type GlanceOnOff = {
  seasonName: string;
  tcode: string;
  /** 그가 코트에 있던 시간과 그 사이 팀 마진/40. */
  onMinutes: number;
  onNetPer40: number;
  /** 같은 경기들에서 그가 벤치인 동안 팀의 마진/40. */
  offMinutes: number;
  offNetPer40: number;
  /** on - off. 양수면 "그가 있을 때 팀이 더 좋았다". */
  diff: number;
  stints: number;
  /** 온 300분 & 오프 100분(lib/seasonFocus.ts ONOFF_MIN)을 넘었는가. */
  qualified: boolean;
  sample: string;
  caption: string;
};

export type GlanceCareer = {
  /** 커리어 최다 득점 경기. 기록이 없으면 null. */
  high: { pts: number; date: string; gmkey: string; seasonName: string; tcode: string; oppTcode: string; min: number; reb: number; ast: number } | null;
  /** 출전 경기(0분 엔트리 제외). */
  games: number;
  /** 엔트리 행 수. */
  entries: number;
  seasons: number;
  firstDate: string | null;
  lastDate: string | null;
  /** getCareerGrain을 넘겨줬을 때만 채워진다(결장은 등록 창을 잘라야 정직해서 - lib/careerGrain.ts). */
  absences: number | null;
  teams: string[];
};

export type GlanceShotDiet = {
  seasonName: string | null;
  total: number;
  shares: Record<DnaZone, number>;
  labels: Record<DnaZone, string>;
  /**
   * 참고 카드(DARKO)가 쓰는 세 통(rim / mid / three)으로 다시 묶은 값.
   * rim = 골대 3.0m 이내(저장소 존 rim + close), mid = 3.0m~3점선(midShort + midLong), three = 3점.
   * 아래 슈팅 DNA 패널은 5개 존을 그대로 쓰므로 이 세 통은 한눈 카드 전용 요약이다.
   */
  buckets: { rim: number; mid: number; three: number };
  /** 슛 표본이 DNA_MIN_SEASON_SHOTS 미만이면 true(값은 그대로 들어 있다). */
  thin: boolean;
  sample: string;
};

export type PlayerGlance = {
  pcode: string;
  statSeason: string | null;
  /** 고정 순서·고정 길이. 선수마다 격자 모양이 달라지지 않는다. */
  metrics: GlanceMetric[];
  groups: { group: GlanceGroup; metrics: GlanceMetric[] }[];
  /** 리그 평균에서 가장 멀리 떨어진 2~3개. 퍼센타일이 하나도 없으면 빈 배열. */
  headline: GlanceHeadline[];
  weighted: WeightedAdvanced;
  onOff: GlanceOnOff | null;
  career: GlanceCareer;
  shotDiet: GlanceShotDiet | null;
  /** 퍼센타일 풀 정보(카드 하단 캡션용). */
  percentilePool: { n: number; qualified: boolean; rule: string; basis: string } | null;
  /** 이 카드가 말할 수 없는 것들 - 참고 카드가 암시하는 항목을 여기서 명시적으로 부인한다. */
  notes: string[];
  caption: string;
};

// ---------------------------------------------------------------------------
// 시즌 온/오프 - 주인공이 코트에 있을 때와 없을 때의 팀 마진
// ---------------------------------------------------------------------------

/**
 * lib/wowy.ts는 "주인공이 코트에 있는 스틴트"만 받아서 동료별로 쪼갠다(그래서 팀의 '그 없이'
 * 값을 만들 수 없다). 여기서는 그의 팀이 뛴 경기의 스틴트를 전부 받아 한 번에 온/오프로 가른다.
 *
 * 표본 범위는 wowy.ts와 같은 정규시즌+플레이오프다(라인업 로그는 원래 귀해서 PO를 버리지 않는다).
 * 오픈매치(season_category='OPEN MATCH DAY', 2026-27시즌 신설 전시경기)는 이 스코프에 없다 - 제외.
 * 마진은 언제나 주인공 팀 기준. net/40 = 마진 합 ÷ 분 × 40.
 *
 * 검증(2026-09-04 SQL 직접 대조):
 *   워니 291248 25-26 서울 SK - 온 1,790.4분 +2.37 / 오프 509.7분 +1.33 (온코트 값은 wowy.ts 주석과 일치)
 *   조은후 291499 25-26 고양 소노 - 온 252.1분 -7.14 / 오프 2,153.0분 +4.29 (온 300분 미달 -> qualified=false)
 *   해먼즈 291698 25-26 울산 현대모비스 - 온 1,534.8분 -0.42 / 오프 635.3분 -12.09
 *
 * 비용: 팀-시즌 스틴트 약 1,400~1,700행(실측) = .range 2페이지.
 */
export async function getSeasonOnOff(pcode: string, seasonName: string, tcode: string): Promise<GlanceOnOff | null> {
  const { data: gameRows } = await supabase
    .from("games")
    .select("gmkey, home_tcode, away_tcode")
    .eq("season_name", seasonName)
    .eq("is_ended", true)
    .neq("season_category", OPEN_MATCH_CATEGORY)
    .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`);
  const games = (gameRows ?? []) as { gmkey: string; home_tcode: string; away_tcode: string }[];
  if (!games.length) return null;
  const isHome = new Map(games.map((g) => [g.gmkey, g.home_tcode === tcode]));

  type StintRow = { gmkey: string; home_lineup: string[] | null; away_lineup: string[] | null; duration_sec: number | null; home_pts: number | null; away_pts: number | null };
  const stints: StintRow[] = [];
  for (const part of chunk(games.map((g) => g.gmkey), GMKEY_CHUNK)) {
    const got = await fetchAllPagesBounded<StintRow>((from, to) =>
      supabase
        .from("lineup_stints")
        .select("gmkey, home_lineup, away_lineup, duration_sec, home_pts, away_pts", { count: "exact" })
        .in("gmkey", part)
        .order("stint_id", { ascending: true })
        .range(from, to)
    );
    stints.push(...got);
  }
  if (!stints.length) return null;

  let onSec = 0, onMargin = 0, offSec = 0, offMargin = 0;
  for (const s of stints) {
    const home = isHome.get(s.gmkey);
    if (home == null) continue;
    const lineup = (home ? s.home_lineup : s.away_lineup) ?? [];
    const hp = num(s.home_pts);
    const ap = num(s.away_pts);
    const margin = home ? hp - ap : ap - hp;
    const sec = num(s.duration_sec);
    if (lineup.includes(pcode)) {
      onSec += sec;
      onMargin += margin;
    } else {
      offSec += sec;
      offMargin += margin;
    }
  }
  const onMinutes = onSec / 60;
  const offMinutes = offSec / 60;
  if (onMinutes <= 0) return null;
  const onNetPer40 = (onMargin / onMinutes) * 40;
  const offNetPer40 = offMinutes > 0 ? (offMargin / offMinutes) * 40 : 0;
  const qualified = onMinutes >= ONOFF_MIN.on && offMinutes >= ONOFF_MIN.off;

  return {
    seasonName,
    tcode,
    onMinutes,
    onNetPer40,
    offMinutes,
    offNetPer40,
    diff: onNetPer40 - offNetPer40,
    stints: stints.length,
    qualified,
    sample: `온 ${Math.round(onMinutes).toLocaleString()}분 · 오프 ${Math.round(offMinutes).toLocaleString()}분`,
    caption:
      `${seasonShort(seasonName)} 정규시즌+플레이오프 라인업 스틴트 ${stints.length.toLocaleString()}구간 · ` +
      `보정하지 않은 원값이다(RAPM 아님) - 같이 뛴 동료와 상대가 통제되지 않았다`,
  };
}

// ---------------------------------------------------------------------------
// 분 가중 고급 지표
// ---------------------------------------------------------------------------

/**
 * 한 시즌의 per / off_rtg / def_rtg / usage_rtg / pie를 출전 시간으로 가중 평균한다.
 * 이 다섯 컬럼은 전부 "그 경기의 비율"이라, 경기별 값을 단순 평균하면 5분 뛴 경기가 40분 뛴
 * 경기와 같은 무게를 갖는다(실측 워니 25-26: PER 단순 28.97 vs 가중 28.72, DRtg 103.57 vs 104.06).
 * 15시즌 전 행 NULL 0건(실측)이라 결측 처리는 방어용이다.
 *
 * 표본은 정규시즌(카드의 PER·ORtg·DRtg·PIE 칸이 전부 basisReg다). 다만 USG%만은 정규+PO 가중값을
 * 하나 더 만든다 - 그 칸이 인쇄하는 축 값이 정규+PO 단순 평균이라, 그 옆에 적을 비교값은 같은
 * 표본이어야 "가중 방식의 차이"만 남는다(WeightedAdvanced.usgAllCat 주석).
 * 그래서 쿼리에서 카테고리 필터를 빼고 행을 받은 뒤 여기서 정규시즌만 갈라 쓴다 - 조회 수는 그대로다.
 * (2026-27시즌부터 games.season_category에 'OPEN MATCH DAY'(오픈매치, 전시경기)도 생겼다 - "정규+PO"
 * 표본인 allRows/usgAllCat에서 그 카테고리만 걷어내고, 정규시즌만 쓰는 rows는 원래도 안전하다.)
 */
export async function getWeightedAdvanced(pcode: string, seasonName: string | null): Promise<WeightedAdvanced> {
  const empty: WeightedAdvanced = {
    per: null, ortg: null, drtg: null, usg: null, pie: null,
    gp: 0, minutes: 0,
    sample: seasonName ? "이 시즌 출전 없음" : "기준 시즌 없음",
    method: "경기별 값의 출전 시간 가중 평균(정규시즌)",
    usgAllCat: null,
    allCatSample: seasonName ? "이 시즌 출전 없음" : "기준 시즌 없음",
  };
  if (!seasonName) return empty;

  type Row = {
    min_played: number | string | null;
    per: number | null;
    off_rtg: number | null;
    def_rtg: number | null;
    usage_rtg: number | null;
    pie: number | null;
    // 임베드 결과는 객체로 오지만 배열로 오는 형태도 함께 받는다(lib/playerForm.ts gameMeta와 같은 관례).
    games: { season_category: string | null } | { season_category: string | null }[] | null;
  };
  const categoryOf = (r: Row): string => {
    const g = Array.isArray(r.games) ? r.games[0] : r.games;
    return g?.season_category ?? "";
  };
  const { data } = await supabase
    .from("game_player_stats")
    .select("min_played, per, off_rtg, def_rtg, usage_rtg, pie, games!inner(season_name, season_category, is_ended)")
    .eq("pcode", pcode)
    .eq("games.season_name", seasonName)
    .eq("games.is_ended", true);
  // allRows는 "정규+PO" 표본이라 오픈매치(전시경기)는 걷어낸다(위 함수 주석).
  const allRows = ((data ?? []) as unknown as Row[]).filter((r) => categoryOf(r) !== OPEN_MATCH_CATEGORY);
  const rows = allRows.filter((r) => categoryOf(r) === SEASON_CATEGORY_REGULAR);

  const wavg = (list: Row[], pick: (r: Row) => number | null): number | null => {
    let n = 0;
    let d = 0;
    for (const r of list) {
      const m = num(r.min_played);
      const v = pick(r);
      if (v == null || m <= 0) continue;
      n += v * m;
      d += m;
    }
    return d > 0 ? n / d : null;
  };

  const allMinutes = allRows.reduce((s, r) => s + num(r.min_played), 0);
  const allGp = allRows.filter((r) => num(r.min_played) > 0).length;
  // 정규시즌 출전이 없어도(PO만 뛴 극단) 정규+PO 값은 살려서 돌려준다.
  const allCat = {
    usgAllCat: wavg(allRows, (r) => r.usage_rtg),
    allCatSample: allRows.length ? `${allGp}경기 · ${Math.round(allMinutes).toLocaleString()}분 (정규+PO)` : empty.allCatSample,
  };
  if (!rows.length) return { ...empty, ...allCat };

  const minutes = rows.reduce((s, r) => s + num(r.min_played), 0);
  const gp = rows.filter((r) => num(r.min_played) > 0).length;
  return {
    per: wavg(rows, (r) => r.per),
    ortg: wavg(rows, (r) => r.off_rtg),
    drtg: wavg(rows, (r) => r.def_rtg),
    usg: wavg(rows, (r) => r.usage_rtg),
    pie: wavg(rows, (r) => r.pie),
    gp,
    minutes,
    sample: `${gp}경기 · ${Math.round(minutes).toLocaleString()}분 (정규시즌)`,
    method: "경기별 값의 출전 시간 가중 평균 - 짧게 뛴 경기가 과대 반영되지 않게",
    ...allCat,
  };
}

// ---------------------------------------------------------------------------
// 퍼센타일 풀 정의의 로컬 복제(자격 미달 선수의 '값'을 살리기 위해)
// ---------------------------------------------------------------------------

/**
 * getPercentileProfile은 자격(15경기 또는 300분) 미달이면 axes를 통째로 비워 돌려준다 -
 * 퍼센타일로는 옳지만, 그러면 카드에서 '득점' 칸의 숫자까지 사라져 격자가 빈 칸투성이가 된다.
 * 그래서 같은 정의를 여기서 그대로 다시 계산해 값만 채우고 퍼센타일은 null로 둔다
 * (회색 숫자 + "왜 퍼센타일이 없는지" 문장).
 *
 * RPC player_season_percentile_pool의 정의를 글자 그대로 따른다(2026-09-04 함수 정의 확인):
 *   FROM game_player_stats JOIN games ON season_name = p_season  ← 카테고리·is_ended 필터 없음
 *   gp = count(*)                     ← 0분 엔트리 행 포함
 *   ppg..bpg = avg(...)               ← 경기당 단순 평균
 *   ts_pct   = Σpts / (2 × Σ(fga+tpa+0.44×fta))
 *   usg_avg  = avg(usage_rtg) filter (usage_rtg is not null)   ← 분 가중이 아니다
 *   tov_rate = Σtov / Σ(fga+tpa+0.44×fta+tov)
 * (미종료 경기의 기록 행은 실측 0건이라 careerRows의 is_ended 필터와 결과가 같다.)
 */
type PoolStyle = { gp: number; minTotal: number; ppg: number; rpg: number; apg: number; spg: number; bpg: number; tsPct: number | null; usgAvg: number | null; tovRate: number | null };

function poolStyleSeason(rows: CareerGameRow[], season: string, usgByGmkey: Map<string, number>): PoolStyle | null {
  const list = rows.filter((r) => r.seasonName === season);
  if (!list.length) return null;
  const n = list.length;
  const sum = (fn: (r: CareerGameRow) => number) => list.reduce((s, r) => s + fn(r), 0);
  const tsa = sum((r) => r.fga + r.tpa + 0.44 * r.fta);
  const tov = sum((r) => r.tov);
  const usgVals = list.map((r) => usgByGmkey.get(r.gmkey)).filter((v): v is number => v != null);
  return {
    gp: n,
    minTotal: sum((r) => r.min),
    ppg: sum((r) => r.pts) / n,
    rpg: sum((r) => r.reb) / n,
    apg: sum((r) => r.ast) / n,
    spg: sum((r) => r.stl) / n,
    bpg: sum((r) => r.blk) / n,
    tsPct: tsa > 0 ? sum((r) => r.pts) / (2 * tsa) : null,
    usgAvg: usgVals.length ? usgVals.reduce((s, v) => s + v, 0) / usgVals.length : null,
    tovRate: tsa + tov > 0 ? tov / (tsa + tov) : null,
  };
}

/** 축 key -> 폴백 값과 표시 문자열. 포맷은 lib/playerDataScience.ts axisDefs와 글자 단위로 같아야 한다. */
function poolStyleAxis(p: PoolStyle, axisKey: string): { value: number | null; display: string } {
  switch (axisKey) {
    case "ppg": return { value: p.ppg, display: p.ppg.toFixed(1) };
    case "rpg": return { value: p.rpg, display: p.rpg.toFixed(1) };
    case "apg": return { value: p.apg, display: p.apg.toFixed(1) };
    case "spg": return { value: p.spg, display: p.spg.toFixed(1) };
    case "bpg": return { value: p.bpg, display: p.bpg.toFixed(1) };
    case "ts_pct": return p.tsPct == null ? { value: null, display: "-" } : { value: p.tsPct * 100, display: `${(p.tsPct * 100).toFixed(1)}%` };
    case "usg_avg": return p.usgAvg == null ? { value: null, display: "-" } : { value: p.usgAvg, display: `${p.usgAvg.toFixed(1)}%` };
    case "tov_rate": return p.tovRate == null ? { value: null, display: "-" } : { value: p.tovRate * 100, display: `${(p.tovRate * 100).toFixed(1)}%` };
    default: return { value: null, display: "-" };
  }
}

/** 그 시즌 전 카테고리 행의 usage_rtg(위 폴백 전용, 최대 63행). */
async function fetchSeasonUsage(pcode: string, seasonName: string): Promise<Map<string, number>> {
  const { data } = await supabase
    .from("game_player_stats")
    .select("gmkey, usage_rtg, games!inner(season_name)")
    .eq("pcode", pcode)
    .eq("games.season_name", seasonName);
  const out = new Map<string, number>();
  for (const r of (data ?? []) as unknown as { gmkey: string; usage_rtg: number | null }[]) {
    if (r.usage_rtg != null) out.set(r.gmkey, num(r.usage_rtg));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 동점 인원 - "퍼센타일 0"이 단독 최하위인지 공동 최하위인지
// ---------------------------------------------------------------------------

/**
 * 퍼센타일 축의 동점 인원(자신 포함)을 축 key -> 인원으로 돌려준다.
 *
 * 왜 필요한가: lib/playerDataScience.ts rankPercentile은 "자기보다 '낮은' 선수 수 ÷ (풀-1)"이라,
 * 값이 축의 바닥이면 아래에 아무도 없어 그 값을 가진 전원이 퍼센타일 0을 받는다. 실측 2025-26
 * 자격 풀 152명 중 BPG가 정확히 0.0인 선수가 24명(15.8%) - 조은후도 그중 하나다. 카드가 이 칸을
 * '0' + 폭 0% 막대 + 하위 톤으로 그리면 화면은 "리그 단독 꼴찌"라고 말하지만 사실은 23명과 공동이다.
 * 그 24명을 세서 칸이 실제로 무슨 뜻인지 적기 위한 조회다.
 *
 * 비용: RPC 한 번(시즌 풀 전체, 실측 최대 205행 - 1000행 상한 아래라 페이지 나눔 불필요).
 * 퍼센타일이 0인 축이 하나라도 있는 선수에게만 호출한다 - 워니처럼 바닥 칸이 없는 선수는 조회 0회.
 *
 * 풀 정의(자격 필터·값 컬럼)는 getPercentileProfile과 글자 그대로 같아야 한다. 다르면 여기서 센
 * 동점 인원이 그 함수가 만든 퍼센타일과 다른 모집단을 말하게 된다. 비교도 그 함수와 같은 Number()
 * 변환 뒤에 하므로, 여기서 "같다"고 센 값은 rankPercentile이 "낮지 않다"고 판정한 값과 정확히 일치한다.
 */
const PERCENTILE_AXIS_KEYS = ["ppg", "rpg", "apg", "spg", "bpg", "ts_pct", "usg_avg", "tov_rate"] as const;

async function fetchPercentileTies(pcode: string, seasonName: string): Promise<Map<string, number> | null> {
  const { data, error } = await supabase.rpc("player_season_percentile_pool", { p_season: seasonName });
  if (error || !data) return null;
  const rows = data as Record<string, unknown>[];
  const pool = rows.filter((r) => Number(r.gp) >= PERCENTILE_MIN_GP || Number(r.min_total) >= PERCENTILE_MIN_MINUTES);
  const me = pool.find((r) => r.pcode === pcode);
  if (!me) return null;

  const out = new Map<string, number>();
  for (const key of PERCENTILE_AXIS_KEYS) {
    const mine = me[key];
    if (mine == null) continue;
    const v = Number(mine);
    if (!Number.isFinite(v)) continue;
    out.set(key, pool.filter((r) => r[key] != null && Number(r[key]) === v).length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 지표 조립 헬퍼
// ---------------------------------------------------------------------------

type MetricSeed = {
  key: string;
  label: string;
  group: GlanceGroup;
  unit?: string;
  higherIsBetter?: boolean;
  neutral?: boolean;
  note?: string | null;
};

/**
 * 기준 시즌 정규시즌의 경기당 공격/수비 리바운드. **oreb/dreb가 null인 경기는 통째로 뺀다** -
 * 0으로 접으면 분모(경기 수)는 그대로인데 분자만 줄어 그 선수의 리바운드가 조용히 낮아진다.
 * gp(쓴 경기)와 total(그 시즌 전체 경기)을 같이 돌려주므로 화면이 "몇 경기 기준인지" 밝힐 수 있다.
 */
export function seasonRebSplit(
  rows: Pick<CareerGameRow, "seasonName" | "seasonCategory" | "oreb" | "dreb">[],
  season: string | null
): { gp: number; total: number; oreb: number; dreb: number } | null {
  if (!season) return null;
  const inSeason = rows.filter((r) => r.seasonName === season && r.seasonCategory === SEASON_CATEGORY_REGULAR);
  const usable = inSeason.filter((r) => r.oreb != null && r.dreb != null);
  if (!usable.length) return null;
  return {
    gp: usable.length,
    total: inSeason.length,
    oreb: usable.reduce((acc, r) => acc + (r.oreb ?? 0), 0) / usable.length,
    dreb: usable.reduce((acc, r) => acc + (r.dreb ?? 0), 0) / usable.length,
  };
}

function metric(
  seed: MetricSeed,
  opts: {
    value: number | null;
    display?: string;
    digits?: number;
    percentile?: number | null;
    poolN?: number | null;
    poolRule?: string | null;
    tieCount?: number | null;
    sample: string;
    basis: string;
    leagueAvg?: number | null;
    leagueLabel?: string | null;
    dim?: boolean;
  }
): GlanceMetric {
  const unit = seed.unit ?? "";
  const d = opts.digits ?? 1;
  const display =
    opts.display ?? (opts.value == null || !Number.isFinite(opts.value) ? "-" : `${opts.value.toFixed(d)}${unit === "%" ? "%" : ""}`);
  return {
    key: seed.key,
    label: seed.label,
    value: opts.value,
    display,
    unit,
    percentile: opts.percentile ?? null,
    poolN: opts.percentile == null ? null : opts.poolN ?? null,
    poolRule: opts.percentile == null ? null : opts.poolRule ?? null,
    // tieCount는 percentile과 함께 지워지지 않는다 - 퍼센타일을 뺀 칸(공동 최하위)에서 오히려
    // "몇 명 공동인가"가 그 칸의 유일한 리그 맥락이 된다.
    tieCount: opts.tieCount ?? null,
    sample: opts.sample,
    basis: opts.basis,
    group: seed.group,
    note: seed.note ?? null,
    higherIsBetter: seed.higherIsBetter ?? true,
    neutral: seed.neutral ?? false,
    leagueAvg: opts.leagueAvg ?? null,
    leagueLabel: opts.leagueLabel ?? null,
    dim: opts.dim ?? opts.value == null,
  };
}

const signed = (v: number, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export type PlayerGlanceOptions = {
  /** 페이지가 이미 받아 둔 값들 - 주면 다시 조회하지 않는다(선수 페이지는 전부 갖고 있다). */
  careerRows?: CareerGameRow[];
  form?: PlayerForm;
  careerShots?: CareerShot[];
  percentile?: PercentileProfile | null;
  clutch?: ClutchProfile | null;
  /** lib/careerGrain.ts 결과. 주면 결장 수까지 채운다(안 주면 커리어 하이/경기/시즌만 - 결장은 등록 창을 잘라야 정직해서 여기서 새로 계산하지 않는다). */
  grain?: CareerGrain;
  /** 기준 시즌의 소속 팀(온/오프). 생략하면 그 시즌 가장 오래 뛴 팀으로 정한다. */
  tcode?: string | null;
};

/**
 * 한눈 카드 데이터 한 벌.
 *
 * @param statSeason lib/seasonFocus.ts resolvePlayerSeasons가 정한 기준 시즌. null이면(신입)
 *   시즌 의존 지표는 전부 value=null + dim=true로 오고 커리어 블록만 채워진다.
 *
 * 조회 비용(아무것도 주입하지 않은 최악): 커리어 경기 1 + 퍼센타일 RPC 1 + 커리어 슛 1 +
 * 클러치 RPC 1 + WPA 1 + 고급지표 1 + 온/오프 2~3 + playerForm(팀-경기) 3~9.
 * 선수 페이지는 careerRows/careerShots/percentile/clutch/grain을 이미 갖고 있으므로 실제로는
 * form + 온/오프 + WPA + 고급지표 4갈래만 새로 든다.
 * 여기에 조건부 조회 둘이 더 붙는다 - 퍼센타일 자격 미달이면 usage_rtg 1(fetchSeasonUsage),
 * 퍼센타일이 0인 축이 있으면 동점 인원용 풀 RPC 1(fetchPercentileTies). 둘 다 해당 선수에게만
 * 일어난다(워니는 0회, 조은후는 동점 인원 조회 1회).
 */
/**
 * 키는 (pcode, statSeason). 주입되는 form에서 이 함수가 쓰는 건 form.seasons뿐이라
 * 최근 창(?w=)과 무관하다 - 그래서 창을 키에 넣지 않는다.
 */
export function getPlayerGlance(
  pcode: string,
  statSeason: string | null,
  opts?: PlayerGlanceOptions
): Promise<PlayerGlance> {
  return cached(
    () => computePlayerGlance(pcode, statSeason, opts),
    ["playerGlance", pcode, statSeason ?? "none"],
    TTL.batchDaily,
    [TAG.batch, `player:${pcode}`]
  );
}

async function computePlayerGlance(
  pcode: string,
  statSeason: string | null,
  opts?: PlayerGlanceOptions
): Promise<PlayerGlance> {
  const careerRows = (opts?.careerRows ?? (await getPlayerCareerGames(pcode))).filter((r) => r.isEnded);

  // 기준 시즌 소속 팀 - 그 시즌 가장 오래 뛴 팀(시즌 중 이적 대비. 실측: 조은후 23-24는 정관장 -> 소노).
  let tcode = opts?.tcode ?? null;
  if (!tcode && statSeason) {
    const minByTeam = new Map<string, number>();
    for (const g of careerRows) {
      if (g.seasonName !== statSeason) continue;
      minByTeam.set(g.tcode, (minByTeam.get(g.tcode) ?? 0) + g.min + 0.001);
    }
    let best = -1;
    for (const [tc, m] of minByTeam) if (m > best) { tcode = tc; best = m; }
  }

  const [form, percentile, shots, clutch, wpa, weighted, onOff] = await Promise.all([
    opts?.form ?? getPlayerForm(pcode, { careerRows }),
    opts?.percentile !== undefined ? Promise.resolve(opts.percentile) : statSeason ? getPercentileProfile(pcode, statSeason) : Promise.resolve(null),
    opts?.careerShots ?? getCareerShots(pcode),
    opts?.clutch !== undefined ? Promise.resolve(opts.clutch) : getClutchProfile(pcode),
    statSeason ? getSeasonWpaRank(pcode, statSeason) : Promise.resolve(null),
    getWeightedAdvanced(pcode, statSeason),
    statSeason && tcode ? getSeasonOnOff(pcode, statSeason, tcode) : Promise.resolve(null),
  ]);

  const seasonRow: FormRow | null = statSeason ? form.seasons.find((r) => r.seasonName === statSeason) ?? null : null;
  const seasonLabel = statSeason ? seasonShort(statSeason) : "기준 시즌 없음";
  const basisReg = statSeason ? `${seasonLabel} 정규시즌` : "기준 시즌 없음";
  const basisAll = statSeason ? `${seasonLabel} 정규+PO` : "기준 시즌 없음";

  // ── 퍼센타일 축 ────────────────────────────────────────────────────────────────────
  const poolRule = `${PERCENTILE_MIN_GP}경기 또는 ${PERCENTILE_MIN_MINUTES}분 이상`;
  const poolBasis = "정규시즌+플레이오프 · 경기당 단순 평균 · 엔트리 행 기준(0분 출전 포함)";
  const axisByKey = new Map((percentile?.axes ?? []).map((a) => [a.key, a]));
  const poolN = percentile?.poolN ?? null;
  const poolQualified = !!percentile?.qualified;

  // 축이 비었는데 그 시즌 출전 기록은 있는 선수(= 퍼센타일 자격 미달)만 폴백 값을 계산한다.
  // usage_rtg 조회 한 번이 더 들지만 대상이 드물고(25-26 풀 밖 49명) 최대 63행이다.
  const needFallback = !!statSeason && axisByKey.size === 0 && careerRows.some((r) => r.seasonName === statSeason);
  const fallback = needFallback ? poolStyleSeason(careerRows, statSeason!, await fetchSeasonUsage(pcode, statSeason!)) : null;

  // 퍼센타일이 0인 축이 하나라도 있으면 동점 인원을 센다(fetchPercentileTies 주석 - 25-26 BPG
  // 0.0이 24명 공동이다). 0인 축이 없는 선수(워니 등)에게는 이 조회가 일어나지 않는다.
  const hasFloorAxis = (percentile?.axes ?? []).some((a) => a.percentile === 0);
  const ties = hasFloorAxis && statSeason ? await fetchPercentileTies(pcode, statSeason) : null;

  /** 퍼센타일 축 하나를 지표로. 축이 없으면 값은 살리고(회색) 퍼센타일만 null로 둔다. */
  function axisMetric(seed: MetricSeed, axisKey: string, digits = 1): GlanceMetric {
    const a = axisByKey.get(axisKey);
    if (!a) {
      const why = !statSeason
        ? "기준 시즌 없음"
        : !percentile
        ? "이 시즌 리그 집계 없음"
        : !poolQualified
        ? `퍼센타일 자격 미달 · ${percentile.gp}경기 ${Math.round(percentile.minTotal).toLocaleString()}분 (기준 ${poolRule})`
        : "이 시즌에는 이 축의 원본 컬럼이 없다";
      const fb = fallback ? poolStyleAxis(fallback, axisKey) : null;
      return metric(seed, {
        value: fb?.value ?? null,
        display: fb?.display ?? "-",
        sample: why,
        basis: basisAll,
        dim: true,
      });
    }
    // PercentileAxis는 이미 포맷된 display만 준다(값 컬럼이 없다) - 정렬·색 판정에 쓸 숫자는
    // display에서 되읽는다. 축 포맷은 전부 "22.9" / "49.5%" 꼴이라 parseFloat이 안전하다.
    const v = Number.parseFloat(a.display);
    const value = Number.isFinite(v) ? v : null;
    const tieCount = ties?.get(a.key) ?? null;
    const gpMin = `${percentile!.gp}경기 · ${Math.round(percentile!.minTotal).toLocaleString()}분`;

    // ── 공동 최하위 칸 ──────────────────────────────────────────────────────────────
    // 퍼센타일 0은 "자기보다 낮은 선수가 0명"이라는 뜻일 뿐 단독 꼴찌라는 뜻이 아니다. 실측
    // 25-26 풀 152명 중 BPG 0.0이 24명인데, 그 24명 전원이 0을 받는다(조은후도 그중 하나).
    // 여기서 퍼센타일을 내보내지 않으면 카드는 이 칸을 폭 0% 막대도 큰 '0'도 없이 중립 톤으로
    // 그리고(components/PlayerGlance.tsx: percentile == null -> tone "none", meterKind "none"),
    // 발밑 한 줄에 sample이 그대로 인쇄된다 - 거기에 "24명이 같은 0.0"을 적어 사실을 말한다.
    // 값(0.0)과 격자 칸은 그대로 남는다 - 지우는 것은 오해를 만드는 막대와 퍼센타일 숫자뿐이다.
    // 동점 인원을 못 셌으면(RPC 실패) 값이 0인 칸에만 같은 판단을 한다: 0은 이 축들의 바닥값이라
    // 아래에 아무도 있을 수 없어, 그 0은 순위가 아니라 정의가 만든 숫자다.
    const sharedFloor = a.percentile === 0 && (tieCount == null ? v === 0 : tieCount > 1);
    if (sharedFloor) {
      return metric(
        {
          ...seed,
          note: [
            seed.note,
            // TOV%는 낮을수록 좋음으로 뒤집힌 축이라 "바닥값"이 아니라 "가장 높은 값"이 퍼센타일 0이다.
            a.inverted
              ? `이 축은 낮을수록 좋음으로 뒤집혀 있어 퍼센타일이 "자기보다 높은 선수" 비율이다 - ${a.display}처럼 리그에서 가장 나쁜 값을 여럿이 나눠 가지면 그 전원이 0을 받는다. 단독 최하위가 아니어서 이 칸에는 퍼센타일 막대를 그리지 않는다`
              : `퍼센타일은 "자기보다 낮은 선수" 비율이라 ${a.display}처럼 축의 바닥값이면 같은 값을 가진 전원이 0을 받는다 - 단독 최하위가 아니어서 이 칸에는 퍼센타일 막대를 그리지 않는다`,
          ]
            .filter(Boolean)
            .join(" · "),
        },
        {
          value,
          display: a.display,
          digits,
          percentile: null,
          tieCount,
          sample:
            tieCount != null
              ? `${gpMin} · 풀 ${poolN}명 중 ${tieCount}명이 같은 ${a.display}(공동 최하위)`
              : `${gpMin} · 풀 ${poolN}명의 최하위값 ${a.display} - 공동일 수 있어 퍼센타일은 생략`,
          basis: basisAll,
        }
      );
    }

    return metric(seed, {
      value,
      display: a.display,
      digits,
      percentile: a.percentile,
      poolN,
      poolRule,
      tieCount,
      // 동점은 25-26 실측에서 0 이외에는 최대 3명까지라, 2명 이상일 때만 한마디 붙인다.
      sample: `${gpMin} · 풀 ${poolN}명${tieCount != null && tieCount > 1 ? ` · 같은 값 공동 ${tieCount}명` : ""}`,
      basis: basisAll,
    });
  }

  // ── 75포제션당(추정) ───────────────────────────────────────────────────────────────
  function per75Metric(seed: MetricSeed, key: "pts" | "reb" | "ast"): GlanceMetric {
    if (!seasonRow) {
      return metric(seed, {
        value: null,
        sample: statSeason ? `${seasonLabel} 정규시즌 출전 없음` : "기준 시즌 없음",
        basis: basisReg,
        dim: true,
      });
    }
    const v = seasonRow.rates.per75[key];
    const lg = seasonRow.league?.per75[key] ?? null;
    return metric(seed, {
      value: v,
      display: formatRate(key, v),
      // 75포제션당 값에는 퍼센타일을 붙이지 않는다 - 리그 전 선수의 추정 포제션을 만들려면
      // 시즌마다 선수-경기 6,800행을 다시 받아야 한다. 대신 리그 평균(팀 생산의 1/5)을 준다.
      percentile: null,
      sample: seasonRow.sample + (seasonRow.thin ? " · 표본 얇음" : ""),
      basis: basisReg,
      leagueAvg: lg,
      leagueLabel: lg == null ? null : `리그 평균 ${lg.toFixed(1)}`,
      dim: seasonRow.thin,
    });
  }

  // ── 슛 다이어트 ────────────────────────────────────────────────────────────────────
  const rawShares = (() => {
    // computeShootingDna(lib/playerDataScience.ts)는 DNA_MIN_SEASON_SHOTS(30) 미만 시즌을 아예
    // 잘라낸다 - 슈팅 DNA 밴드에서는 옳지만 이 카드는 칸을 비워둘 수 없다(격자 모양 고정).
    // 그래서 같은 존 경계(classifyShot)로 직접 세고, 30슛 미만이면 thin 플래그만 세운다.
    // 실측: 조은후 291499 25-26은 38슛 - 아슬아슬하게 통과하지만 구성비는 여전히 얇다.
    if (!statSeason) return null;
    const counts = { rim: 0, close: 0, midShort: 0, midLong: 0, three: 0 } as Record<DnaZone, number>;
    let total = 0;
    for (const s of shots) {
      if (s.season !== statSeason) continue;
      const { zone } = classifyShot(s.x, s.y, s.d);
      const z = (DNA_ZONES as readonly string[]).includes(zone) ? (zone as DnaZone) : "three";
      counts[z] += 1;
      total += 1;
    }
    if (!total) return null;
    return { total, shares: Object.fromEntries(DNA_ZONES.map((z) => [z, counts[z] / total])) as Record<DnaZone, number> };
  })();
  const shotDiet: GlanceShotDiet | null = rawShares
    ? {
        seasonName: statSeason,
        total: rawShares.total,
        shares: rawShares.shares,
        labels: DNA_ZONE_LABELS,
        buckets: {
          rim: rawShares.shares.rim + rawShares.shares.close,
          mid: rawShares.shares.midShort + rawShares.shares.midLong,
          three: rawShares.shares.three,
        },
        thin: rawShares.total < DNA_MIN_SEASON_SHOTS,
        sample: `${rawShares.total.toLocaleString()}슛${rawShares.total < DNA_MIN_SEASON_SHOTS ? ` · ${DNA_MIN_SEASON_SHOTS}슛 미만이라 구성비는 노이즈다` : ""}`,
      }
    : null;

  function shareMetric(seed: MetricSeed, zone: DnaZone): GlanceMetric {
    if (!shotDiet) {
      return metric(seed, { value: null, sample: statSeason ? `${seasonLabel} 슛 로그 없음` : "기준 시즌 없음", basis: basisAll, dim: true });
    }
    const v = shotDiet.shares[zone] * 100;
    return metric(seed, {
      value: v,
      display: `${v.toFixed(1)}%`,
      sample: shotDiet.sample,
      basis: `${seasonLabel} 전 카테고리 슛 로그`,
      dim: shotDiet.thin,
    });
  }

  // ── 지표 조립(순서 고정 - 선수마다 격자 모양이 같아야 한다) ────────────────────────
  const metrics: GlanceMetric[] = [];

  // 득점
  metrics.push(axisMetric({ key: "ppg", label: "득점", group: "득점", unit: "PPG" }, "ppg"));
  metrics.push(per75Metric({ key: "pts75", label: "75포제션당 득점", group: "득점", note: "포제션은 팀 포제션을 출전 시간으로 배분한 추정값" }, "pts"));
  metrics.push(axisMetric({ key: "ts", label: "TS%", group: "득점", unit: "%", note: "득점 / (2 × (야투 시도 + 0.44×자유투 시도))" }, "ts_pct"));
  metrics.push(
    axisMetric(
      {
        key: "usg",
        label: "USG%",
        group: "득점",
        unit: "%",
        neutral: true,
        // 비교값은 반드시 "같은 표본 · 다른 가중"이어야 한다. 예전 문장은 정규시즌 전용 가중값을
        // 들고 와서(워니 25-26 36.2%) 이 칸의 값(정규+PO 단순 36.4%)과 표본·가중이 동시에 달랐고,
        // 그러면서 문장은 가중 방식만 지목해 "가중하면 0.2 내려간다"로 읽혔다. 실제로 표본을
        // 고정하고 가중만 바꾸면 36.0%다(2026-09-04 SQL 실측: 정규+PO 53경기 단순 36.383 /
        // 같은 53경기 분 가중 36.040 / 정규시즌 50경기 분 가중 36.179).
        note:
          `퍼센타일은 RPC 풀 기준(${basisAll} · 경기당 단순 평균). ` +
          (weighted.usgAllCat == null
            ? "분 가중 값은 이 시즌에 없다"
            : `같은 표본을 출전 시간으로 가중하면 ${weighted.usgAllCat.toFixed(1)}% - 짧게 뛴 경기의 무게가 줄어든 값이다`),
      },
      "usg_avg"
    )
  );
  metrics.push(
    metric(
      { key: "ortg", label: "ORtg", group: "득점", note: "그가 뛴 경기의 팀 100포제션당 득점(개인 귀속이 아니다)" },
      {
        value: weighted.ortg,
        digits: 1,
        sample: weighted.sample,
        basis: basisReg,
        dim: weighted.ortg == null,
      }
    )
  );
  metrics.push(shareMetric({ key: "rimShare", label: "림 시도 비중", group: "득점", unit: "%", neutral: true, note: "림 = 골대 1.2m 이내(lib/formIndex.ts 존 경계)" }, "rim"));
  metrics.push(shareMetric({ key: "threeShare", label: "3점 시도 비중", group: "득점", unit: "%", neutral: true, note: "많고 적음은 스타일이지 우열이 아니다" }, "three"));

  // 플레이메이킹
  metrics.push(axisMetric({ key: "apg", label: "어시스트", group: "플레이메이킹", unit: "APG" }, "apg"));
  metrics.push(per75Metric({ key: "ast75", label: "75포제션당 어시스트", group: "플레이메이킹" }, "ast"));
  metrics.push(
    axisMetric(
      { key: "tov", label: "TOV%", group: "플레이메이킹", unit: "%", higherIsBetter: false, note: "턴오버 / (야투 시도 + 0.44×자유투 시도 + 턴오버). 퍼센타일은 낮을수록 좋음으로 뒤집혀 있다" },
      "tov_rate"
    )
  );
  {
    const t = seasonRow?.totals;
    const ratio = t && t.tov > 0 ? t.ast / t.tov : null;
    metrics.push(
      metric(
        { key: "astTov", label: "AST/TOV", group: "플레이메이킹", note: "시즌 합계 어시스트 ÷ 턴오버" },
        {
          value: ratio,
          digits: 2,
          sample: t ? `${t.ast}어시스트 / ${t.tov}턴오버` : statSeason ? `${seasonLabel} 정규시즌 출전 없음` : "기준 시즌 없음",
          basis: basisReg,
          dim: ratio == null,
        }
      )
    );
  }

  // 리바운드·수비
  //
  // 공/수 분해는 2026-09-29부터 가능해졌다 - tools/backfill_player_rebound_split.py가 문자중계
  // 이벤트(209 공격/210 수비)로 game_player_stats.oreb/dreb를 채웠다(101,281행 중 100,587행,
  // 99.3%). 공식 팀 기록(team-record.json의 offr/defr)과 8,203 팀-경기를 대조해 99.805% 완전
  // 일치했다. 다만 **못 채운 0.7%가 null로 남아 있다**(리바운드 이벤트가 통째로 없는 경기 +
  // 구시즌 중계 노이즈). null을 0으로 접으면 그 선수의 리바운드가 조용히 줄어드니, 아래
  // rebSplit은 null인 경기를 표본에서 아예 빼고 남은 경기 수를 sample 문구에 밝힌다.
  const rebSplit = seasonRebSplit(careerRows, statSeason);
  const rebSplitMetric = (seed: MetricSeed, key: "oreb" | "dreb") =>
    metric(seed, {
      value: rebSplit ? rebSplit[key] : null,
      digits: 1,
      // 분해가 안 되는 경기가 섞여 있으면 몇 경기 기준인지 반드시 밝힌다.
      sample: rebSplit
        ? rebSplit.gp === rebSplit.total
          ? `${rebSplit.gp}경기`
          : `${rebSplit.gp}경기(분해 가능한 경기만 · 전체 ${rebSplit.total}경기)`
        : statSeason
          ? `${seasonLabel} 정규시즌 분해 가능한 경기 없음`
          : "기준 시즌 없음",
      basis: basisReg,
      dim: !rebSplit,
    });

  metrics.push(axisMetric({ key: "rpg", label: "리바운드", group: "리바운드·수비", unit: "RPG", note: "총 리바운드(공격+수비)" }, "rpg"));
  metrics.push(
    rebSplitMetric(
      { key: "oreb", label: "공격 리바운드", group: "리바운드·수비", unit: "ORPG", note: "문자중계 이벤트(209)로 분해한 값 - 공식 팀 합계와 99.8% 일치" },
      "oreb"
    )
  );
  metrics.push(
    rebSplitMetric(
      { key: "dreb", label: "수비 리바운드", group: "리바운드·수비", unit: "DRPG", note: "문자중계 이벤트(210)로 분해한 값" },
      "dreb"
    )
  );
  metrics.push(per75Metric({ key: "reb75", label: "75포제션당 리바운드", group: "리바운드·수비" }, "reb"));
  metrics.push(axisMetric({ key: "spg", label: "스틸", group: "리바운드·수비", unit: "SPG" }, "spg", 2));
  metrics.push(axisMetric({ key: "bpg", label: "블록", group: "리바운드·수비", unit: "BPG" }, "bpg", 2));
  metrics.push(
    metric(
      { key: "drtg", label: "DRtg", group: "리바운드·수비", higherIsBetter: false, note: "그가 뛴 경기의 팀 100포제션당 실점 - 개인 수비력이 아니라 팀 맥락 값이다" },
      { value: weighted.drtg, digits: 1, sample: weighted.sample, basis: basisReg, dim: weighted.drtg == null }
    )
  );

  // 임팩트
  metrics.push(
    metric(
      { key: "per", label: "PER", group: "임팩트", note: "경기별 per의 출전 시간 가중 평균" },
      { value: weighted.per, digits: 1, sample: weighted.sample, basis: basisReg, dim: weighted.per == null }
    )
  );
  metrics.push(
    metric(
      { key: "pie", label: "PIE", group: "임팩트", note: "경기별 pie의 출전 시간 가중 평균 - 그 경기 총 생산 중 그의 몫" },
      { value: weighted.pie, digits: 1, sample: weighted.sample, basis: basisReg, dim: weighted.pie == null }
    )
  );
  metrics.push(
    metric(
      { key: "wpa", label: "WPA", group: "임팩트", note: "시즌 누적 승리확률 기여 - 원천 player_season_wpa가 정규시즌 전용이다" },
      {
        value: wpa?.totalWpa ?? null,
        digits: 2,
        sample: wpa ? `${wpa.games}경기(정규) · 리그 ${wpa.rank}/${wpa.outOf}` : statSeason ? `${seasonLabel} WPA 집계 없음` : "기준 시즌 없음",
        basis: basisReg,
        dim: wpa == null,
      }
    )
  );
  metrics.push(
    metric(
      { key: "onNet", label: "온코트 net/40", group: "임팩트", note: "그가 코트에 있는 동안 팀 마진 ÷ 분 × 40" },
      {
        value: onOff?.onNetPer40 ?? null,
        display: onOff ? signed(onOff.onNetPer40) : "-",
        sample: onOff
          ? `${onOff.sample}${onOff.qualified ? "" : ` · 표시 하한 미달(온 ${ONOFF_MIN.on}분·오프 ${ONOFF_MIN.off}분)`}`
          : statSeason
          ? "라인업 로그 없음"
          : "기준 시즌 없음",
        basis: basisAll,
        dim: !onOff || !onOff.qualified,
      }
    )
  );
  metrics.push(
    metric(
      {
        key: "onOffDiff",
        label: "온−오프",
        group: "임팩트",
        note: "온코트 net/40 − 그가 벤치일 때 팀 net/40. 보정하지 않은 원값이다(RAPM 아님)",
      },
      {
        value: onOff?.diff ?? null,
        display: onOff ? signed(onOff.diff) : "-",
        sample: onOff
          ? `${onOff.sample}${onOff.qualified ? "" : ` · 표시 하한 미달(온 ${ONOFF_MIN.on}분·오프 ${ONOFF_MIN.off}분)`}`
          : statSeason
          ? "라인업 로그 없음"
          : "기준 시즌 없음",
        basis: basisAll,
        dim: !onOff || !onOff.qualified,
      }
    )
  );
  {
    const t = clutch?.totals ?? null;
    metrics.push(
      metric(
        {
          key: "clutchWpa",
          label: "클러치 WPA",
          group: "임팩트",
          note: "클러치 = 4쿼터·연장 잔여 5:00 이하 & 점수차 5점 이내(RPC player_clutch_profile). 시즌이 아니라 커리어 전체다",
        },
        {
          value: t && t.plays > 0 ? t.wpaTotal : null,
          digits: 2,
          sample: t && t.plays > 0 ? `커리어 ${t.games}경기 · ${t.plays.toLocaleString()}플레이 · ${t.pts}점` : "클러치 표본 없음",
          basis: "커리어",
          dim: !t || t.plays === 0,
        }
      )
    );
  }

  const groups = GLANCE_GROUPS.map((g) => ({ group: g, metrics: metrics.filter((m) => m.group === g) }));

  // ── 헤드라인: 리그 평균에서 가장 멀리 떨어진 지표 ──────────────────────────────────
  // 공동 최하위 값은 후보가 아니다. 퍼센타일 정의(자기보다 '낮은' 선수 비율,
  // lib/playerDataScience.ts rankPercentile)상 축의 바닥값이면 그 값을 가진 전원이 퍼센타일 0을
  // 받는데, 여럿이 공유하는 값은 "그 선수의 특징"이 아니다 - 실측 25-26 풀 152명 중 BPG가 0인
  // 선수가 24명(15.8%)이다. 조은후의 카드가 '블록 0.0 · 리그 하위 1%'로 시작하면 거짓말에 가깝다.
  // 그런 칸은 위 axisMetric에서 이미 percentile을 비웠으므로 첫 조건에서 걸러진다.
  // value === 0 조건은 동점 인원을 못 셌을 때(RPC 실패)를 위한 이중 방어이고, 동점 인원을 세서
  // 단독임을 확인한 0(tieCount === 1)은 진짜 리그 유일 최하위라 헤드라인에 남긴다.
  // 격자에는 어느 경우든 값이 그대로 0으로 남는다(빼는 것은 헤드라인 한 줄뿐이다).
  const headline: GlanceHeadline[] = metrics
    .filter((m): m is GlanceMetric & { percentile: number } => m.percentile != null && (m.value !== 0 || m.tieCount === 1))
    .map((m) => {
      const distance = Math.abs(m.percentile - 50);
      const direction: "above" | "below" = m.percentile >= 50 ? "above" : "below";
      // 100번째/0번째 퍼센타일은 "상위 0%"가 되어버린다 - 그 자리는 리그 맨 끝이라고 쓴다.
      const top = 100 - m.percentile;
      const side = direction === "above" ? (top < 1 ? "최상위" : `상위 ${top}%`) : m.percentile < 1 ? "최하위" : `하위 ${m.percentile}%`;
      return {
        key: m.key,
        label: m.label,
        display: m.display,
        percentile: m.percentile,
        direction,
        distance,
        sentence: `${m.label} ${m.display} · 리그 ${side}${m.poolN ? ` (${m.poolN}명 중)` : ""}`,
      };
    })
    .sort((a, b) => b.distance - a.distance || b.percentile - a.percentile)
    .slice(0, 3);

  // ── 커리어 블록 ────────────────────────────────────────────────────────────────────
  const played = careerRows.filter((r) => r.min > 0);
  let high: GlanceCareer["high"] = null;
  for (const g of played) {
    if (!high || g.pts > high.pts || (g.pts === high.pts && g.gameDate > high.date)) {
      high = { pts: g.pts, date: g.gameDate, gmkey: g.gmkey, seasonName: g.seasonName, tcode: g.tcode, oppTcode: g.oppTcode, min: g.min, reb: g.reb, ast: g.ast };
    }
  }
  const dates = careerRows.map((r) => r.gameDate).sort();
  const teamOrder: string[] = [];
  for (const g of careerRows.slice().sort((a, b) => (a.gameDate < b.gameDate ? -1 : 1))) if (!teamOrder.includes(g.tcode)) teamOrder.push(g.tcode);
  const career: GlanceCareer = {
    high,
    games: played.length,
    entries: careerRows.length,
    seasons: new Set(careerRows.map((r) => r.seasonName)).size,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    absences: opts?.grain ? opts.grain.absenceCount : null,
    teams: teamOrder,
  };

  // ── 이 카드가 말할 수 없는 것 ──────────────────────────────────────────────────────
  // 참고 카드(DARKO)에는 있지만 이 DB에는 없는 항목. 화면이 "왜 수비 블록이 얇은가"를
  // 변명 없이 설명할 수 있도록 문장 그대로 내보낸다.
  const notes = [
    "플레이 타입(픽앤롤·아이솔레이션·포스트업), 어시스트 유무 분해, 샷클락, 수비수 거리, 매치업, 트래킹(속도·터치·드라이브) 데이터가 이 DB에 없다.",
    "수비 정보는 스틸·블록·DRtg·온오프 넷레이팅뿐이다. 수비 블록이 얇은 것은 디자인이 아니라 데이터의 한계다.",
    "DPM·RAPM 같은 보정 지표, 연봉, 부상 기록, 키·몸무게·나이는 이 DB에 없다.",
    "온/오프는 보정하지 않은 원값이다 - 같이 뛴 동료와 상대가 통제되지 않았다.",
    "공/수 리바운드는 문자중계 이벤트로 분해한 값이다 - 리바운드 이벤트가 없는 0.7%의 경기는 표본에서 빠진다.",
    "리바운드율(OREB%/DREB%)은 아직 없다 - 그가 코트에 있던 동안의 팀·상대 리바운드 기회를 세야 해서 라인업 단위 작업이 필요하다.",
  ];

  const percentilePool = percentile
    ? { n: percentile.poolN, qualified: percentile.qualified, rule: poolRule, basis: poolBasis }
    : null;

  const caption = statSeason
    ? `기준 시즌 ${seasonLabel} · 퍼센타일은 ${poolBasis} · 75포제션당은 정규시즌 추정 · 온/오프는 정규+PO 라인업`
    : "기준 시즌 없음 - 커리어 값만 표시한다";

  return {
    pcode,
    statSeason,
    metrics,
    groups,
    headline,
    weighted,
    onOff,
    career,
    shotDiet,
    percentilePool,
    notes,
    caption,
  };
}

/** 카드에 쓰는 퍼센타일 색 판정(선수 페이지 percentileColor와 같은 경계 - 30/70). */
export function glancePercentileTone(p: number | null): "high" | "mid" | "low" | "none" {
  if (p == null) return "none";
  return p >= 70 ? "high" : p <= 30 ? "low" : "mid";
}

/** 플레이오프 표본이 섞였는지 한 줄로 - 카드 캡션에서 두 표본을 구분해 적을 때. */
export function glanceSampleSplit(careerRows: CareerGameRow[], seasonName: string): { reg: number; po: number } {
  const inSeason = careerRows.filter((r) => r.seasonName === seasonName && r.min > 0 && r.seasonCategory !== OPEN_MATCH_CATEGORY);
  return {
    reg: inSeason.filter((r) => r.seasonCategory !== PLAYOFF_CATEGORY).length,
    po: inSeason.filter((r) => r.seasonCategory === PLAYOFF_CATEGORY).length,
  };
}
