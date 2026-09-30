import { eunNeun, iGa } from "./josa";
import { shotXPTS, type ShotRow } from "./zoneCompare";
import type { H2H, SeasonStats } from "./matchups";
// 섹션별 분석은 report/ 아래로 하나씩 옮기는 중이다(계산/문장 분리, report/renderKit.ts 주석 참고).
// 의존 방향은 여기 -> report/* 한쪽뿐. 옮겨간 타입·함수는 하위호환을 위해 그대로 re-export한다.
import { createReportTags, escHtml, fmtDuration, type ReportSection, type ReportSectionData, type ReportTags, type ReportTeamMeta } from "./report/renderKit";
import { fmtProbPct, gradePrediction } from "./predictionVerdict";
import { computeLineupSynergy, renderLineupSynergySection, type FiveManUnit } from "./report/lineupSynergy";
import { computeHotZoneEdge, renderHotZoneSection } from "./report/shotHotZone";
import { computeAceDuel, type AceDuel } from "./report/aceDuel";
import { computeUnsungHeroes } from "./report/unsungHero";
import { computeStockWatch } from "./report/stockWatch";
import { computeFourFactors, type TeamStatLine } from "./report/fourFactors";
import { computePredictionAudit, type PregameExpectation } from "./report/predictionAudit";

export { fmtDuration };
export type { ReportSection, ReportSectionData, ReportTeamMeta };
export type { AceDuel };
export type { TeamStatLine };
export type { PregameExpectation };

// courtside_template.html(35차, "경기가 종료되면 주요 이벤트들을 하나의 보고서로")의
// A1-A8 분석 엔진을 TypeScript로 포팅 - 원본은 클라이언트에 미리 구운 JSON(timeline 배열)을
// 스크럽하며 매 프레임 재계산했지만, 여기서는 Supabase game_events를 그대로 서버에서 한 번에
// 불러와 같은 로직을 돌림(경기당 event_order 기준 정렬된 500~800행 정도라 매 요청 한 번
// 훑는 건 전혀 무겁지 않음).
//
// Supabase game_events에는 원본 timeline row에 있던 runHome/runAway(진행 중인 득점런)가
// 없음(정적 페이지 빌드 시 Python 쪽에서만 계산해 JSON에 박아 넣던 필드) - attachDerivedFields()가
// 연속된 이벤트의 점수 델타를 보고 직접 재계산.

export type GameEvent = {
  event_order: number;
  quarter: string;
  clock_min: number | null;
  clock_sec: number | null;
  action_code: string | null;
  action_label: string | null;
  pcode: string | null;
  player_name: string | null;
  tcode: string | null;
  home_score: number;
  away_score: number;
  home_win_prob: number | null;
  wpa_home: number | null;
  objective_prob: number | null;
  elapsed: number;
  runHome: number;
  runAway: number;
  /** 지금 진행 중인 "몰아치기" - 상대 무득점이 아니어도 잡는다. 없으면 null. 아래 SURGE_* 참고. */
  surge: Surge | null;
};

/**
 * 상대 무득점을 요구하지 않는 런.
 *
 * 왜 필요한가(사용자 지적): 기존 runHome/runAway는 상대가 1점만 넣어도 0으로 리셋된다.
 * "10-0 런을 하고 있어도 상대 득점이 나오면 바로 끝나는데, 0득점이 아니더라도 큰 점수로
 * 지고 있으면(5분동안 23-3) 이런식으로도 표현" - 그 요청을 그대로 구현한 것.
 */
export type Surge = {
  side: "home" | "away";
  /** 몰아친 쪽이 그 구간에 넣은 점수. */
  lead: number;
  /** 같은 구간에 상대가 넣은 점수. 0이면 기존 런과 같은 사건이다. */
  opp: number;
  /** 구간 길이(초). */
  seconds: number;
};

type RawGameEvent = Omit<GameEvent, "elapsed" | "runHome" | "runAway" | "surge">;

// 주의: game_player_stats.fgm/fga는(원본 KBL 소스 자체가 그렇게 나뉘어 있어서) 2점슛
// 전용이고, 3점은 tpm/tpa에 따로 있음 - courtside_template.html의 event-replay 기반
// computeBoxScore()가 만드는 fgm/fga(2점+3점 합산, gameScore() 공식이 기대하는 값)와
// 의미가 다름. 이 타입에 들어오는 fgm/fga는 반드시 (2점+3점) 합산값으로 채워서 넘겨야 함
// (실측 - 이광재 예시: game_player_stats로는 fgm2/fga5 + tpm4/tpa5인데, 합쳐야 정적
// 페이지가 보여주던 "6/10"과 일치). oreb/dreb는 game_player_stats에 컬럼만 있고 실제 값은
// 전부 NULL(리바운드 종류 분리가 "추후 이벤트 기반 작업으로 보류"된 상태 - 프로젝트 기존
// 기록) - 합산 reb만 실제로 채워져 있어서 그것만 받음.
export type PlayerBox = {
  pcode: string;
  tcode: string;
  name: string;
  is_starter: boolean | null;
  pts: number;
  fgm: number; // 2점+3점 합산으로 채워서 전달할 것
  fga: number; // 2점+3점 합산으로 채워서 전달할 것
  ftm: number;
  fta: number;
  reb: number; // oreb/dreb 분리 데이터가 없어 합산값만
  ast: number;
  stl: number;
  blk: number;
  fouls: number;
  turnovers: number;
};

// wpaSwingRank/wpaSwingSampleSize는 courtside_template.html에도 있지만 이 리포트(경기결과
// 섹션)가 아니라 게임피커/공유카드 등 다른 곳에서만 쓰여서 이번 포팅 범위 밖 - 전체
// 2,425,147개 game_events를 매 페이지 로드마다 집계해야 해서 비용도 큼(games 테이블
// 4207행짜리 marginPercentile과 달리 라이브 계산에 안 맞음, 나중에 필요해지면 사전 집계
// 테이블/materialized view로 별도 처리).
export type GameRarity = {
  marginTotalGames: number;
  marginPercentile: number;
};

// export - Phase 2의 진행중 경기 승률 차트(components/GameReplay.tsx의 WinProbLiveChart)가
// "경과 시간축 + 남은 시간은 빈 칸"으로 그리려면 쿼터 길이 규칙이 필요한데, 그 표를 저쪽에
// 복사하면 두 벌이 서로 어긋날 수 있어서 여기 하나만 공개한다(값/동작 변화 없음).
export const QUARTER_ORDER = ["Q1", "Q2", "Q3", "Q4", "X1", "X2", "X3", "X4", "EQ1", "EQ2", "EQ3", "EQ4"];
export function quarterLenSec(q: string) {
  return q === "Q1" || q === "Q2" || q === "Q3" || q === "Q4" ? 600 : 300;
}
/**
 * PRE·정규 4쿼터를 뺀 나머지는 전부 연장전이다(X1~X4든 EQ1~EQ4든, 앞으로 붙을 다른 태그든).
 * 화이트리스트(`quarter.startsWith("X")` 같은 접두사 매칭)로 판정하면 연장 태그가 하나라도
 * 다르게 들어오는 순간 그 경기의 연장전 전체가 조용히 누락된다 - 실측(2026-09):
 * S23G01N219·S37G01N5·S41G01N171 세 경기가 3차 연장(X3)까지 갔는데, 아래 8.7절이
 * `quarter.startsWith("OT")`로 판정하던 탓에(이 데이터셋엔 "OT"로 시작하는 태그가 아예 없음)
 * 세 경기 모두 연장전 이벤트가 클러치 리포트에서 통째로 빠졌었다.
 */
export function isOvertimeQuarter(q: string): boolean {
  return q !== "PRE" && q !== "Q1" && q !== "Q2" && q !== "Q3" && q !== "Q4";
}
export function cumulativeElapsed(q: string, m: number, s: number): number {
  const idx = QUARTER_ORDER.indexOf(q);
  let prior = 0;
  for (let i = 0; i < (idx === -1 ? QUARTER_ORDER.length : idx); i++) prior += quarterLenSec(QUARTER_ORDER[i]);
  return prior + (quarterLenSec(q) - (m * 60 + s));
}

export function clockStr(e: Pick<GameEvent, "quarter" | "clock_min" | "clock_sec">): string {
  // clock_min/clock_sec는 DB에서 nullable이다(PRE 행은 항상 null이고, 드물게 실시간 피드가
  // 흔들리며 실제 이벤트에도 null이 들어올 수 있음) - 그대로 문자열로 이으면 "Q3 null:null"처럼
  // 깨진 문구가 리포트/점프링크 텍스트에 그대로 노출된다. 시간 정보가 없으면 쿼터 이름만 보여준다.
  if (e.clock_min == null || e.clock_sec == null) return e.quarter;
  return `${e.quarter} ${e.clock_min}:${String(e.clock_sec).padStart(2, "0")}`;
}

// Feature("AI 코트사이드 리포트에서 시간 언급을 클릭하면 리플레이가 그 순간으로 이동") - 이
// 파일이 만드는 문장은 거의 전부 특정 game_events 행(row)에서 나온 것이라(호출부가 이미 그
// 행/인덱스를 들고 있음), clockStr()로 시간 텍스트를 만드는 자리마다 이 헬퍼로 감싸기만 하면
// 됨. 결과는 순수 HTML 문자열(이 파일 전체가 dangerouslySetInnerHTML로 렌더되는 문자열 빌더라
// React 이벤트를 못 붙임) - components/GameReplay.tsx가 document 클릭 위임으로 이 idx를
// 읽어 setIdx()를 호출(zoneCompare.ts의 buildCourtDotsSvg가 슛 차트 점에 붙이는
// data-jump-idx와 동일한 컨벤션을 공유 - 리스너 하나로 두 기능 다 처리).
function jumpLink(idx: number, text: string): string {
  return `<a href="#" class="report-jump-link" data-jump-idx="${idx}">${text}</a>`;
}
export function fmtRating(r: number): string {
  return `${r > 0 ? "+" : ""}${r.toFixed(1)}`;
}

// PRE 행(quarter='PRE', clock_min/sec=null)은 elapsed=0 고정 - courtside_template.html에서
// cumulativeElapsedJs가 'PRE' 같은 미지의 쿼터 태그를 처리 못 해 경기 막판인 것처럼
// 잘못 계산되던 실측 버그를 이미 겪었음(35차 M3). 여기서는 애초에 안전한 값을 직접 넣고,
// 원본과 동일하게 시간 스캔 함수들에서는 PRE 행을 명시적으로 건너뜀(둘 다 같은 동작
// 유지 - 정적 페이지와 이 사이트 사이의 결과 차이를 만들지 않기 위해).
/**
 * 시간 스캔용 인덱스. PRE가 아닌 행만, events 인덱스 오름차순으로 담고, 각 자리마다
 * **그 자리까지의 elapsed 누적 최대값**을 같이 들고 있다.
 *
 * 왜 최대값이냐: elapsed는 단조증가가 **아니다**(아래 computeSurgeAt 주석의 실측 - 시계가
 * 뒤로 가는 행이 49/270경기에 있다). 그래서 "이 행의 elapsed가 창 밖이니 더 볼 필요 없다"로
 * 스캔을 끊으면 창이 잘려 조용히 틀린 숫자가 나온다. 반면 누적 최대값은 정의상 단조증가라
 * `maxEl[p] < 하한`이면 **p와 그 앞 전부가** 창 밖임이 증명된다 - 결과를 한 건도 바꾸지 않고
 * 스캔 범위만 줄이는 근거가 이것이다(창 밖 판정은 아래에서 행마다 다시 하므로, 흔들린 행이
 * 창 안에 있으면 여전히 정확히 잡힌다).
 */
type ElapsedIndex = { at: number[]; maxEl: number[] };

function buildElapsedIndex(events: GameEvent[]): ElapsedIndex {
  const ix: ElapsedIndex = { at: [], maxEl: [] };
  let running = -Infinity;
  for (let i = 0; i < events.length; i++) {
    if (events[i].quarter === "PRE") continue;
    running = Math.max(running, events[i].elapsed);
    ix.at.push(i);
    ix.maxEl.push(running);
  }
  return ix;
}

export function attachDerivedFields(rawEvents: RawGameEvent[]): GameEvent[] {
  const events: GameEvent[] = rawEvents.map((e) => ({ ...e, elapsed: 0, runHome: 0, runAway: 0, surge: null }));
  let homeRun = 0,
    awayRun = 0;
  // 인덱스를 훑으면서 같이 키운다 - computeSurgeAt(i)는 i보다 앞선 행만 보므로, i를 넣기
  // **전에** 부르면 예전 코드의 `for (j = i-1; j >= 0; j--)` 범위와 정확히 같다.
  const ix: ElapsedIndex = { at: [], maxEl: [] };
  let runningMaxEl = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    e.elapsed = e.quarter === "PRE" ? 0 : cumulativeElapsed(e.quarter, e.clock_min ?? 0, e.clock_sec ?? 0);
    if (i > 0) {
      const prev = events[i - 1];
      const dHome = e.home_score - prev.home_score;
      const dAway = e.away_score - prev.away_score;
      if (dHome > 0 && dAway === 0) {
        homeRun += dHome;
        awayRun = 0;
      } else if (dAway > 0 && dHome === 0) {
        awayRun += dAway;
        homeRun = 0;
      }
    }
    e.runHome = homeRun;
    e.runAway = awayRun;
    e.surge = computeSurgeAt(events, i, ix);
    if (e.quarter !== "PRE") {
      runningMaxEl = Math.max(runningMaxEl, e.elapsed);
      ix.at.push(i);
      ix.maxEl.push(runningMaxEl);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// 서지(상대 무득점을 요구하지 않는 런)
// ---------------------------------------------------------------------------
//
// 정의: 최근 SURGE_WINDOW_SEC 안에서 **점수차가 가장 나빴던 시점** 이후로 벌린 폭.
//     m[i] = home[i] - away[i]
//     홈의 서지 = m[i] - min{ m[j] : 0 <= elapsed[i] - elapsed[j] <= W }
// 상대가 0점이면 기존 런과 정확히 같은 값이 나오므로(하위호환), 새 규칙이 옛 규칙을 포함한다.
//
// 창을 W로 자르는 이유: 자르지 않으면 시작부터 앞서간 팀의 "런"이 최종 점수차와 같아진다.
// 그건 런이 아니라 그냥 경기 결과다.
//
// ── 임계값을 이렇게 정한 근거 (25-26 정규시즌 270경기 전수 실측) ──────────────────
// 창/임계를 8가지로 돌려 "경기당 발동 횟수"와 "그중 상대가 득점한 비율"(= 기존 0-런
// 규칙이었다면 아예 안 떴을 구간)을 쟀다:
//     300초/12점  1.97회/경기   상대 1점+ 88%
//     300초/14점  0.73회/경기   상대 1점+ 85%,  상대 3점+ 60%   <- 채택
//     300초/16점  0.21회/경기   상대 1점+ 71%
//     360초/16점  0.48회/경기   상대 1점+ 90%
//     480초/16점  0.97회/경기   상대 1점+ 97%
// 300초/14점을 고른 이유: (1) 경기당 0.73회라 "가끔 뜨는 진짜 사건"이고, 12점은 2회 가까이
// 떠서 흔해진다. (2) 발동의 85%가 상대 득점을 포함하므로 기존 0-런이 못 잡던 것을 실제로
// 잡는다. (3) 5분이라는 창이 사용자가 든 예시("5분동안 23-3")와 같다.
// 실제로 잡힌 구간 예: 25-11(4분47초), 23-9(5분00초), 22-6(4분59초).
// 같은 구간 안의 기존 0-런 최댓값은 10~14점이라, 옛 규칙으로는 훨씬 약하게 보이거나 안 보였다.
export const SURGE_WINDOW_SEC = 300;
export const SURGE_MIN_DIFF = 14;

/**
 * events[0..i]까지 elapsed/점수가 채워져 있다는 전제. i 시점에 진행 중인 서지.
 * ix는 [0, i) 구간의 PRE 아닌 행 인덱스(ElapsedIndex 주석 참고).
 */
function computeSurgeAt(events: GameEvent[], i: number, ix: ElapsedIndex): Surge | null {
  const cur = events[i];
  if (cur.quarter === "PRE") return null;
  const mNow = cur.home_score - cur.away_score;

  // 창 안에서 마진이 가장 낮았던 곳(홈 관점 바닥)과 가장 높았던 곳(원정 관점 바닥)을 찾는다.
  //
  // **break가 아니라 continue인 이유**: elapsed가 단조증가라는 보장이 없다. 25-26 정규시즌
  // 270경기를 훑어보니 **49경기에서 51번 시계가 뒤로 간다**(같은 쿼터 안에서 대부분 1~3초,
  // 최대 240초 - KBL 원본 피드의 흔들림이다). break는 첫 창밖 행에서 스캔을 끝내므로 그
  // 지점에서 창이 잘린다.
  //
  // 정직하게 적자면 **이 시즌에서는 두 방식의 결과가 완전히 같았다**(164,501행 전수 대조,
  // 서지가 켜진 1,999행 포함해 차이 0건). 흔들림이 1~3초라 300초 창의 최소/최대를 바꾸지
  // 못했기 때문이다. 그래도 continue로 두는 이유는, break가 **데이터에서 이미 거짓인 가정**에
  // 기대고 있어서다 - 다음 시즌 피드가 조금만 더 흔들려도 조용히 틀린 숫자가 나온다.
  //
  // 다만 "그래서 전수 스캔한다"까지 갈 필요는 없었다. 전수 스캔은 이 함수를 매 행마다 부르는
  // attachDerivedFields 때문에 O(N²)이 되고(880행 경기 = 38만 회 비교), 이게 서버 리포트만의
  // 문제가 아니다 - components/GameReplay.tsx가 **라이브 폴링마다** 클라이언트에서 같은 함수를
  // 다시 돌린다(useMemo의 attachDerivedFields(merged)).
  // 그래서 창 밖 판정(위의 개별 continue)은 그대로 두고, **더 볼 필요가 없음이 증명되는**
  // 지점에서만 끊는다: ix.maxEl은 단조증가라 `maxEl[p] < floor`면 p 이하 전부가 창 밖이다
  // (ElapsedIndex 주석). 흔들린 행은 여전히 개별 검사를 거치므로 결과가 바뀌지 않는다
  // (실경기 26건 전수 대조로 확인 - 파생 필드 바이트 단위 동일).
  let lowIdx = i,
    highIdx = i;
  // 마진을 값으로 들고 간다 - 예전엔 비교마다 events[lowIdx]를 다시 읽어 뺐다.
  let lowM = mNow,
    highM = mNow;
  const floor = cur.elapsed - SURGE_WINDOW_SEC;
  for (let p = ix.at.length - 1; p >= 0; p--) {
    if (ix.maxEl[p] < floor) break;
    const j = ix.at[p];
    const q = events[j];
    if (cur.elapsed - q.elapsed > SURGE_WINDOW_SEC) continue;
    const m = q.home_score - q.away_score;
    if (m < lowM) {
      lowM = m;
      lowIdx = j;
    }
    if (m > highM) {
      highM = m;
      highIdx = j;
    }
  }

  const homeSurge = mNow - (events[lowIdx].home_score - events[lowIdx].away_score);
  const awaySurge = events[highIdx].home_score - events[highIdx].away_score - mNow;
  const homeSide = homeSurge >= awaySurge;
  const diff = homeSide ? homeSurge : awaySurge;
  if (diff < SURGE_MIN_DIFF) return null;

  const start = events[homeSide ? lowIdx : highIdx];
  const dHome = cur.home_score - start.home_score;
  const dAway = cur.away_score - start.away_score;
  return {
    side: homeSide ? "home" : "away",
    lead: homeSide ? dHome : dAway,
    opp: homeSide ? dAway : dHome,
    seconds: Math.max(0, cur.elapsed - start.elapsed),
  };
}

/** "25-11" 또는 "14-0" - 화면 어디서든 같은 모양으로. */
export function surgeScoreText(s: Surge): string {
  return `${s.lead}-${s.opp}`;
}

/** "4분 47초" / "58초" */
export function fmtSurgeDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

/**
 * targetElapsed 시점의 기준 행. 예전엔 매번 배열 앞에서부터 훑었는데(첫 초과 행에서 break),
 * 그게 곧 "PRE 아닌 행 중 elapsed가 target을 처음 넘는 자리 직전"이다. ix.maxEl이 단조증가라
 * 그 자리는 이진탐색으로 정확히 같은 값을 준다(ElapsedIndex 주석).
 *
 * 왜 고쳤나: computeSubSpark가 교체 한 건당 이걸 3번 부르고, 교체는 경기당 평균 84건이다
 * (게다가 예전엔 식스맨/결정적교체 두 섹션이 각자 전체를 훑어 같은 값을 두 번 계산했다) -
 * O(교체수 × N)이라 실측 프로파일에서 서지 다음으로 큰 덩어리였다.
 */
function marginRefAt(
  events: GameEvent[],
  targetElapsed: number,
  ix: ElapsedIndex
): { margin: number; elapsed: number; homeScore: number; awayScore: number } {
  // maxEl[p] > target인 첫 p. 그 앞자리(p-1)가 예전 루프의 best와 같다.
  let lo = 0,
    hi = ix.at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ix.maxEl[mid] > targetElapsed) hi = mid;
    else lo = mid + 1;
  }
  if (lo === 0) return { margin: 0, elapsed: 0, homeScore: 0, awayScore: 0 };
  const best = events[ix.at[lo - 1]];
  return { margin: best.home_score - best.away_score, elapsed: best.elapsed, homeScore: best.home_score, awayScore: best.away_score };
}

function computeSubSpark(
  events: GameEvent[],
  row: GameEvent,
  homeTcode: string,
  ix: ElapsedIndex
): { delta: number; beforeDur: number; afterDur: number; homeGain: number; awayGain: number } | null {
  const t0 = row.elapsed;
  const lastElapsed = events[events.length - 1].elapsed;
  if (t0 >= lastElapsed) return null;
  const beforeRef = marginRefAt(events, Math.max(0, t0 - 180), ix);
  const atSub = marginRefAt(events, t0, ix);
  const afterRef = marginRefAt(events, Math.min(t0 + 180, lastElapsed), ix);
  const beforeDur = atSub.elapsed - beforeRef.elapsed;
  const afterDur = afterRef.elapsed - atSub.elapsed;
  if (beforeDur < 30 || afterDur < 30) return null;
  const netRtg = (marginChange: number, durSec: number) => (marginChange / durSec) * 2400;
  const sign = row.tcode === homeTcode ? 1 : -1;
  const before = sign * netRtg(atSub.margin - beforeRef.margin, beforeDur);
  const after = sign * netRtg(afterRef.margin - atSub.margin, afterDur);
  // 요청: "이 투입 이후 상황이 어떻게 흘러갔는지" - 넷레이팅 델타 숫자 하나만으론 실감이 안 나서,
  // 교체 후 3분(afterDur초) 동안 실제로 각 팀이 몇 점을 냈는지도 같이 반환.
  return {
    delta: after - before,
    beforeDur,
    afterDur,
    homeGain: afterRef.homeScore - atSub.homeScore,
    awayGain: afterRef.awayScore - atSub.awayScore,
  };
}

const MAKE_CODES = new Set(["201", "205", "207"]);
const MISS_CODES = new Set(["202", "206", "208"]);
const REB_CODES = new Set(["209", "210"]);
const PERSONAL_FOUL_CODES = new Set(["215", "216", "224"]);
const SUB_IN_CODE = "101";

export type Burst = { key: string; count: number; startIdx: number; endIdx: number; startRow: GameEvent; endRow: GameEvent; durationSec: number };

export function findStatBursts(events: GameEvent[], codes: Set<string>, windowSec: number, minCount: number): Burst[] {
  const queues: Record<string, { elapsed: number; idx: number; row: GameEvent }[]> = {};
  const active: Record<string, boolean> = {};
  const bursts: Burst[] = [];
  for (let i = 1; i < events.length; i++) {
    const row = events[i];
    if (!row.pcode || !row.action_code || !codes.has(row.action_code)) continue;
    const key = row.pcode;
    const q = queues[key] || (queues[key] = []);
    q.push({ elapsed: row.elapsed, idx: i, row });
    while (q.length && row.elapsed - q[0].elapsed > windowSec) q.shift();
    if (q.length >= minCount) {
      if (!active[key]) {
        active[key] = true;
        bursts.push({
          key,
          count: q.length,
          startIdx: q[0].idx,
          endIdx: i,
          startRow: q[0].row,
          endRow: row,
          durationSec: row.elapsed - q[0].elapsed,
        });
      }
    } else {
      active[key] = false;
    }
  }
  return bursts;
}

const STAT_BURST_DEFS = [
  { key: "rebound", label: "리바운드", codes: REB_CODES, minCount: 5, windowSec: 240 },
  { key: "assist", label: "어시스트", codes: new Set(["211"]), minCount: 4, windowSec: 300 },
  { key: "block", label: "블록", codes: new Set(["213"]), minCount: 3, windowSec: 300 },
];
export function computeStatBursts(events: GameEvent[]): (Burst & { label: string })[] {
  const out: (Burst & { label: string })[] = [];
  for (const def of STAT_BURST_DEFS) {
    for (const b of findStatBursts(events, def.codes, def.windowSec, def.minCount)) out.push({ ...b, label: def.label });
  }
  return out;
}

// 요청: "핫/콜드 스트릭" - 슛 성공/실패가 연속되는 구간 감지(참고 아티팩트의
// computeHotStreakEvents 포팅, 임계값 3연속). findStatBursts는 "N초 윈도우 안에 N개"가
// 기준이라 여기 안 맞음(그 사이 다른 게 껴도 됨) - 이건 "연속으로"(중간에 반대 결과가
// 끼면 리셋)가 기준이라 별도 로직. 양수=연속 성공, 음수=연속 실패.
const HOT_STREAK_THRESHOLD = 3;
export type StreakEvent = { pcode: string; idx: number; len: number; row: GameEvent };
export function findShootingStreaks(events: GameEvent[]): StreakEvent[] {
  const streaks: Record<string, number> = {};
  const out: StreakEvent[] = [];
  for (let i = 1; i < events.length; i++) {
    const row = events[i];
    if (!row.pcode || !row.action_code) continue;
    if (!MAKE_CODES.has(row.action_code) && !MISS_CODES.has(row.action_code)) continue;
    const prev = streaks[row.pcode] || 0;
    const cur = MAKE_CODES.has(row.action_code) ? (prev >= 0 ? prev + 1 : 1) : prev <= 0 ? prev - 1 : -1;
    streaks[row.pcode] = cur;
    if (Math.abs(prev) < HOT_STREAK_THRESHOLD && Math.abs(cur) >= HOT_STREAK_THRESHOLD) {
      out.push({ pcode: row.pcode, idx: i, len: cur, row });
    }
  }
  return out;
}

// 요청: "팀 전체 무득점 기간" - 각 팀이 마지막으로 득점한 시점부터 지금(넘겨받은 events의
// 마지막 행)까지 몇 초 지났는지. 호출 쪽에서 events.slice(0, idx+1)을 넘기면 "현재 스크럽
// 시점 기준" 드라우트가 됨.
export function computeCurrentDroughts(events: GameEvent[]): { homeSec: number; awaySec: number } {
  if (!events.length) return { homeSec: 0, awaySec: 0 };
  const last = events[events.length - 1];
  let lastHomeScoreElapsed = 0,
    lastAwayScoreElapsed = 0;
  let prevHome = events[0].home_score,
    prevAway = events[0].away_score;
  for (const row of events) {
    if (row.home_score > prevHome) lastHomeScoreElapsed = row.elapsed;
    if (row.away_score > prevAway) lastAwayScoreElapsed = row.elapsed;
    prevHome = row.home_score;
    prevAway = row.away_score;
  }
  return { homeSec: last.elapsed - lastHomeScoreElapsed, awaySec: last.elapsed - lastAwayScoreElapsed };
}

const FOUL_TROUBLE_WINDOW_SEC = 360,
  FOUL_TROUBLE_QUICK_COUNT = 3;
function findFoulTroubleEvents(events: GameEvent[]): Burst[] {
  return findStatBursts(events, PERSONAL_FOUL_CODES, FOUL_TROUBLE_WINDOW_SEC, FOUL_TROUBLE_QUICK_COUNT);
}

function checkOpponentRunAfterFoulTrouble(
  events: GameEvent[],
  foulEvent: Burst,
  homeTcode: string
): { maxOppRun: number } | null {
  const pcode = foulEvent.key;
  const team = foulEvent.endRow.tcode;
  let scanEnd = Math.min(events.length - 1, foulEvent.endIdx + 40);
  for (let i = foulEvent.endIdx + 1; i < events.length; i++) {
    if (events[i].action_code === "102" && events[i].pcode === pcode) {
      scanEnd = i;
      break;
    }
  }
  let maxOppRun = 0;
  for (let i = foulEvent.endIdx; i <= scanEnd; i++) {
    const r = events[i];
    const oppRun = team === homeTcode ? r.runAway : r.runHome;
    if (oppRun > maxOppRun) maxOppRun = oppRun;
  }
  return maxOppRun >= 6 ? { maxOppRun } : null;
}

function findTopWpaSwings(events: GameEvent[], k = 3): { idx: number; row: GameEvent }[] {
  const candidates: { idx: number; row: GameEvent; absWpa: number }[] = [];
  for (let i = 1; i < events.length; i++) {
    const row = events[i];
    if (row.wpa_home == null || !row.player_name) continue;
    candidates.push({ idx: i, row, absWpa: Math.abs(row.wpa_home) });
  }
  candidates.sort((x, y) => y.absWpa - x.absWpa);
  const picked: { idx: number; row: GameEvent }[] = [];
  for (const c of candidates) {
    if (picked.length >= k) break;
    if (picked.some((p) => Math.abs(p.row.elapsed - c.row.elapsed) < 30)) continue;
    picked.push({ idx: c.idx, row: c.row });
  }
  return picked;
}

const HIGHLIGHT_ACTION_BONUS: Record<string, number> = { "205": 0.15, "207": 0.2, "213": 0.1, "212": 0.05 };
function computeHighlightScore(row: GameEvent): number {
  const wpa = Math.abs(row.wpa_home || 0);
  const isLateClutch = (row.quarter === "Q4" || isOvertimeQuarter(row.quarter)) && (row.clock_min ?? 99) < 3;
  return wpa + (isLateClutch ? 0.1 : 0) + (row.action_code ? HIGHLIGHT_ACTION_BONUS[row.action_code] || 0 : 0);
}
function findAiPickBestScene(events: GameEvent[], excludeIdx: Set<number>): { idx: number; row: GameEvent } | null {
  let best: { idx: number; row: GameEvent } | null = null;
  let bestScore = -1;
  for (let i = 1; i < events.length; i++) {
    const row = events[i];
    if (!row.player_name || excludeIdx.has(i)) continue;
    const score = computeHighlightScore(row);
    if (score > bestScore) {
      bestScore = score;
      best = { idx: i, row };
    }
  }
  return best;
}

const DRAMATIC_SWING_WINDOW_SEC = 600,
  DRAMATIC_SWING_MIN_DELTA = 0.2;
function findDramaticProbSwing(events: GameEvent[]): { startIdx: number; endIdx: number; delta: number; durationSec: number } | null {
  let best: { startIdx: number; endIdx: number; delta: number; durationSec: number } | null = null;
  let j = 1;
  for (let i = 1; i < events.length; i++) {
    const ei = events[i].elapsed;
    while (j < i && events[j].elapsed < ei - DRAMATIC_SWING_WINDOW_SEC) j++;
    if (j >= i) continue;
    const hp = events[i].home_win_prob,
      jp = events[j].home_win_prob;
    if (hp == null || jp == null) continue;
    const delta = hp - jp;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { startIdx: j, endIdx: i, delta, durationSec: ei - events[j].elapsed };
    }
  }
  return best && Math.abs(best.delta) >= DRAMATIC_SWING_MIN_DELTA ? best : null;
}

// 원본 gameScore()는 오펜시브/디펜시브 리바운드를 0.7/0.3으로 다르게 가중치를 주는데(Hollinger
// Game Score 공식), Supabase엔 그 분리가 없어서(위 PlayerBox 주석 참고) 합산 reb에 단일
// 가중치를 씀 - 실제 리그 평균 오펜시브 리바운드 비중(전체 리바운드의 대략 1/4)을 반영해
// 0.7*0.25 + 0.3*0.75 ≈ 0.4로 블렌딩(완전히 동일하진 않지만, 순위를 크게 뒤집을 만큼
// 큰 항도 아니라서 - 득점/슈팅효율이 이 공식을 지배함).
// 인자를 PlayerBox 전체가 아니라 실제로 쓰는 스탯 칸만 받는다 - lib/matchupInsights.ts가
// game_player_stats 원본 행에서 시즌 누적 게임스코어를 만들 때 pcode/tcode/name 같은
// 신원 필드까지 지어내지 않아도 되게. 기존 호출부(PlayerBox를 넘기는 곳)는 그대로 통과한다.
export type GameScoreStats = Pick<
  PlayerBox,
  "pts" | "fgm" | "fga" | "ftm" | "fta" | "reb" | "ast" | "stl" | "blk" | "fouls" | "turnovers"
>;
export function gameScore(b: GameScoreStats): number {
  return (
    b.pts + 0.4 * b.fgm - 0.7 * b.fga - 0.4 * (b.fta - b.ftm) + 0.4 * b.reb +
    b.stl + 0.7 * b.ast + 0.7 * b.blk - 0.4 * b.fouls - b.turnovers
  );
}

function involved(b: PlayerBox): boolean {
  return b.fga + b.fta + b.ast + b.reb > 0;
}

// export - 홈 화면(app/page.tsx)의 "이긴팀 선수와 진팀의 선수" 요청에서도 그대로 재사용.
export function teamTopPerformer(box: PlayerBox[], tcode: string): PlayerBox | null {
  let top: PlayerBox | null = null;
  let topScore = 0;
  for (const b of box) {
    if (b.tcode !== tcode || !involved(b)) continue;
    // 점수를 들고 간다 - `gameScore(b) > gameScore(top)`은 이미 정한 top의 점수를 매 행마다
    // 다시 계산했다(홈 화면이 경기 목록 200건에 이 함수를 돌리는 자리라 공짜로 줄일 만하다).
    const s = gameScore(b);
    if (!top || s > topScore) {
      top = b;
      topScore = s;
    }
  }
  return top;
}

// 홈 화면 "식스맨 조커" 표시(요청: "식스맨 조커 선수까지 표시") - 경기상세 페이지의
// findBestSixthManSpark(교체 후 3분간 넷레이팅 변화)는 game_events 전체를 훑어야 해서
// (경기당 500~800행) 200경기짜리 홈 목록에 쓰기엔 너무 무거움. 대신 홈 화면이 이미
// 불러오는 박스스코어만으로 계산되는 약식 지표(벤치 선수 중 gameScore 최고)로 대체 -
// 정확히 같은 정의는 아니지만(넷레이팅 스윙이 아니라 순수 활약도) "이 경기 벤치에서
// 제일 잘한 선수"라는 취지는 동일. winnerTop/loserTop과 겹치지 않도록 exclude로 제외.
export function bestBenchPerformer(box: PlayerBox[], excludePcodes: Set<string>): PlayerBox | null {
  let top: PlayerBox | null = null;
  let topScore = 0;
  for (const b of box) {
    if (b.is_starter !== false || excludePcodes.has(b.pcode) || !involved(b)) continue;
    const s = gameScore(b);
    if (!top || s > topScore) {
      top = b;
      topScore = s;
    }
  }
  return top;
}

// 블로아웃(마진 15+)일 땐 이기는 팀 안에서만 - courtside_template.html의 gameWideTopPerformer
// 가드(과거 "50점차로 지는 팀 선수가 MVP로 표시됨" 버그를 막기 위한 것)를 그대로 포팅.
// export - 홈 화면 경기 목록(app/page.tsx)의 "MVP 표시" 요청에서도 그대로 재사용(중복 구현
// 방지, 블로아웃 가드까지 같이 재사용됨).
export function gameWideTopPerformer(box: PlayerBox[], homeScore: number, awayScore: number, homeTcode: string, awayTcode: string): PlayerBox | null {
  const margin = homeScore - awayScore;
  const blowout = Math.abs(margin) >= 15;
  const leaderTcode = margin > 0 ? homeTcode : awayTcode;
  let top: PlayerBox | null = null;
  let topScore = 0;
  for (const b of box) {
    if (!involved(b)) continue;
    if (blowout && b.tcode !== leaderTcode) continue;
    const s = gameScore(b);
    if (!top || s > topScore) {
      top = b;
      topScore = s;
    }
  }
  return top;
}

function sumTeam(box: PlayerBox[], tcode: string, fn: (b: PlayerBox) => number): number {
  let s = 0;
  for (const b of box) if (b.tcode === tcode) s += fn(b);
  return s;
}

/**
 * 팀 포제션 추정 - KBL 공식 박스스코어(team-record.json의 `poss`/`pace`)가 실제로 쓰는 식과
 * 같은 것, 즉 Basketball-Reference의 Pace 공식이다.
 *
 *   측면값 = FGA + 0.4·FTA − 1.07·(OREB / (OREB + 상대 DREB))·(FGA − FGM) + TOV
 *   포제션 = (홈 측면값 + 원정 측면값) / 2
 *
 * **검증**: 최근 4시즌 568경기(1,136 팀-경기)에 이 식을 먹여 KBL 공식 `poss`와 비교하니
 * RMSE 0.03 - 반올림 오차 수준으로 정확히 재현된다. 반면 이 자리에 있던 예전 식
 * (FGA + 0.44·FTA + TOV − 0.25·(FGA−FGM), "공격 리바운드를 못 구하니 야투 실패의 25%로
 * 가정")은 같은 표본에서 팀당 +3.46 포제션 과대(RMSE 4.93)였다.
 *
 * 왜 예전 식이 틀렸나 - 두 가지다.
 *  1) 공격 리바운드는 추정할 필요가 없다. game_player_stats.oreb/dreb 컬럼은 전 행 NULL이지만
 *     game_events의 action_code 209(공격리바운드)/210(수비리바운드)는 채워져 있고, 최근 4시즌
 *     전수 대조에서 공식 박스스코어의 offr/defr와 **100% 일치**한다. 실제값이 있는데 상수
 *     25%를 쓰면 리바운드를 잘/못 잡은 팀의 차이가 통째로 사라진다.
 *  2) 한 경기에서 두 팀의 포제션은 1회 넘게 벌어질 수 없다(공은 번갈아 가지므로). 팀별로 따로
 *     추정하면 그 제약이 깨진다 - 예전 식은 홈/원정 추정치가 평균 4.0, 상위 10%에서 8.0,
 *     최대 15.2회까지 벌어졌다. 그래서 두 측면값을 평균 내는 것이 공식의 핵심이다.
 *
 * 0.44가 아니라 0.4인 것도 의도된 것 - 1.07 항과 짝을 이루는 BBRef Pace 공식의 계수다
 * (0.44는 OREB 항이 없는 Dean Oliver 단순식 쪽 계수). 섞어 쓰면 위 재현 정확도가 깨진다.
 *
 * pacePer40: 연장전 보정. 포제션 자체는 경기 길이에 비례해 늘어나므로(3차 연장 = 55분)
 * 원시값을 그대로 템포 임계값에 넣으면 연장 경기는 자동으로 "빠름"이 된다 - 실측으로 최근
 * 4시즌 연장 19경기가 19/19 전부 "빠름"으로 찍혔다. 페이스는 40분 환산으로만 비교할 것.
 */
export function estimatePossessions(
  box: PlayerBox[],
  events: Pick<GameEvent, "quarter" | "action_code" | "tcode">[],
  homeTcode: string,
  awayTcode: string
): { raw: number; playedMin: number; pacePer40: number } {
  let hOreb = 0,
    aOreb = 0,
    hDreb = 0,
    aDreb = 0;
  const quarters = new Set<string>();
  for (const e of events) {
    if (e.quarter && e.quarter !== "PRE") quarters.add(e.quarter);
    if (e.action_code === "209") {
      if (e.tcode === homeTcode) hOreb++;
      else if (e.tcode === awayTcode) aOreb++;
    } else if (e.action_code === "210") {
      if (e.tcode === homeTcode) hDreb++;
      else if (e.tcode === awayTcode) aDreb++;
    }
  }
  const side = (tcode: string, oreb: number, oppDreb: number) => {
    const fga = sumTeam(box, tcode, (b) => b.fga);
    const fgm = sumTeam(box, tcode, (b) => b.fgm);
    const fta = sumTeam(box, tcode, (b) => b.fta);
    const to = sumTeam(box, tcode, (b) => b.turnovers);
    // 리바운드 이벤트가 하나도 없는 경기(수집 실패/진행 초반)면 OREB% 0 - 보정 항이 죽고
    // 단순 FGA+0.4FTA+TOV로 떨어진다. 25% 같은 상수를 몰래 끼워 넣지 않는다.
    const orebPct = oreb + oppDreb > 0 ? oreb / (oreb + oppDreb) : 0;
    return fga + 0.4 * fta - 1.07 * orebPct * Math.max(0, fga - fgm) + to;
  };
  const raw = 0.5 * (side(homeTcode, hOreb, aDreb) + side(awayTcode, aOreb, hDreb));
  let playedSec = 0;
  for (const q of quarters) playedSec += quarterLenSec(q);
  const playedMin = playedSec / 60;
  return { raw, playedMin, pacePer40: playedMin > 0 ? (raw * 40) / playedMin : raw };
}

function quarterBoundaries(events: GameEvent[]): { i: number; q: string }[] {
  const bounds: { i: number; q: string }[] = [];
  let lastQ: string | null = null;
  events.forEach((r, i) => {
    if (r.quarter !== lastQ && r.quarter !== "PRE") {
      bounds.push({ i, q: r.quarter });
      lastQ = r.quarter;
    }
  });
  return bounds;
}

/**
 * 쿼터별 득실 막대(홈 기준). 위로 자라면 홈이 그 쿼터를 이겼다는 뜻이고, 막대 높이의 합이
 * 정확히 최종 마진이다 - 독자가 그림만 보고 검산할 수 있다.
 *
 * SVG 안에 글자를 넣지 않는다(viewBox 스케일에 따라 글자 크기가 달라지는 문제를 이 프로젝트가
 * 이미 겪었다 - components/GameReplay.tsx의 WinProbLiveChart 주석). 쿼터 이름과 점수는 아래
 * HTML 축에 둔다.
 */
function renderQuarterMargins(
  events: GameEvent[],
  homeTeam: ReportTeamMeta,
  awayTeam: ReportTeamMeta,
  tags: ReportTags
): string | null {
  const bounds = quarterBoundaries(events);
  if (bounds.length < 2) return null;
  const rows: { q: string; delta: number }[] = [];
  for (let qi = 0; qi < bounds.length; qi++) {
    const startI = bounds[qi].i;
    const endI = qi + 1 < bounds.length ? bounds[qi + 1].i - 1 : events.length - 1;
    const s = events[startI],
      e = events[endI];
    // 쿼터 첫 행은 그 쿼터 **시작 시점**의 누적 점수다(그 행의 득점은 아직 반영 전) - 직전
    // 쿼터 마지막 행과 같은 값이라 경계에서 점수가 새거나 겹치지 않는다.
    rows.push({ q: bounds[qi].q, delta: e.home_score - s.home_score - (e.away_score - s.away_score) });
  }
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.delta)));
  const W = 320,
    H = 96,
    mid = H / 2;
  const slot = W / rows.length;
  const barW = Math.min(34, slot * 0.6);
  const hColor = homeTeam.color ?? "#888888";
  const aColor = awayTeam.color ?? "#888888";
  const bars = rows
    .map((r, i) => {
      const cx = slot * (i + 0.5);
      const h = (Math.abs(r.delta) / maxAbs) * (mid - 6);
      const up = r.delta > 0; // 홈 우세는 위로
      const y = up ? mid - h : mid;
      return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${up ? hColor : aColor}" opacity="0.85" rx="2"/>`;
    })
    .join("");
  const svg = `<svg class="qm-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="쿼터별 득실 마진"><line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="var(--ink-faint)" stroke-width="1"/>${bars}</svg>`;
  const axis = rows
    .map((r) => {
      const t = r.delta > 0 ? homeTeam : r.delta < 0 ? awayTeam : null;
      const label = `${r.delta > 0 ? "+" : r.delta < 0 ? "−" : ""}${Math.abs(r.delta)}`;
      return `<span><b>${escHtml(r.q)}</b>${t ? tags.teamTag(t.tcode, label) : label}</span>`;
    })
    .join("");
  const total = rows.reduce((s, r) => s + r.delta, 0);
  const winner = total > 0 ? homeTeam : awayTeam;
  return (
    `<div class="qm-wrap">${svg}<div class="qm-axis">${axis}</div></div>` +
    `<p class="report-caveat">위로 자란 막대는 ${escHtml(homeTeam.abbr)}(홈)가 그 쿼터를 이겼다는 뜻입니다. 막대 합 = 최종 마진 ${tags.teamTag(winner.tcode, `${Math.abs(total)}점`)}.</p>`
  );
}

function explainLosingDespiteTopPerformer(
  events: GameEvent[],
  box: PlayerBox[],
  winnerTcode: string,
  loserTcode: string,
  homeTcode: string,
  awayTcode: string
): string[] {
  const reasons: string[] = [];

  const wFgm = sumTeam(box, winnerTcode, (b) => b.fgm),
    wFga = sumTeam(box, winnerTcode, (b) => b.fga);
  const lFgm = sumTeam(box, loserTcode, (b) => b.fgm),
    lFga = sumTeam(box, loserTcode, (b) => b.fga);
  const wPct = wFga ? (wFgm / wFga) * 100 : 0,
    lPct = lFga ? (lFgm / lFga) * 100 : 0;
  if (wPct - lPct >= 8) reasons.push(`팀 전체 야투율 격차(${wPct.toFixed(1)}% vs ${lPct.toFixed(1)}%)`);

  const wTo = sumTeam(box, winnerTcode, (b) => b.turnovers),
    lTo = sumTeam(box, loserTcode, (b) => b.turnovers);
  if (lTo - wTo >= 5) reasons.push(`턴오버 열세(${lTo}개 vs ${wTo}개)`);

  const qBounds = quarterBoundaries(events);
  let worstQ: string | null = null,
    worstDelta = 0;
  for (let qi = 0; qi < qBounds.length; qi++) {
    const startI = qBounds[qi].i;
    const endI = qi + 1 < qBounds.length ? qBounds[qi + 1].i - 1 : events.length - 1;
    const startRow = events[startI],
      endRow = events[endI];
    const loserStart = loserTcode === homeTcode ? startRow.home_score : startRow.away_score;
    const loserEnd = loserTcode === homeTcode ? endRow.home_score : endRow.away_score;
    const winnerStart = winnerTcode === homeTcode ? startRow.home_score : startRow.away_score;
    const winnerEnd = winnerTcode === homeTcode ? endRow.home_score : endRow.away_score;
    const qDelta = loserEnd - loserStart - (winnerEnd - winnerStart);
    if (qDelta < worstDelta) {
      worstDelta = qDelta;
      worstQ = qBounds[qi].q;
    }
  }
  // "Q1 쿼터"는 "1쿼터 쿼터"다 - 쿼터 태그(Q1~Q4/X1~)를 그대로 쓰고 '쿼터'를 덧붙이지 않는다.
  if (worstQ && worstDelta <= -8) reasons.push(`${worstQ}에서만 ${Math.abs(worstDelta)}점 열세`);

  const benchPts = (tcode: string) => box.filter((b) => b.tcode === tcode && b.is_starter === false).reduce((s, b) => s + b.pts, 0);
  const wBench = benchPts(winnerTcode),
    lBench = benchPts(loserTcode);
  if (wBench - lBench >= 10) reasons.push(`벤치 득점 격차(${wBench}점 vs ${lBench}점)`);

  void awayTcode;
  return reasons;
}

const SUB_SPARK_MIN_SAMPLE_SEC = 120;
const SUB_SPARK_NOTABLE_THRESHOLD = 120; // courtside_template.html 실측(120초+ 표본 784건 중앙값 52, 상위10% 148)과 동일 기준

type SubSpark = NonNullable<ReturnType<typeof computeSubSpark>>;

type SubSparkHit = { idx: number; row: GameEvent; pcode: string; spark: SubSpark };

/**
 * 투입(101) 행마다 스파크를 **한 번만** 계산한다. 예전엔 findBestSixthManSpark와
 * findNotableSubSparks가 각자 events 전체를 훑으며 같은 computeSubSpark를 두 번씩 돌렸다
 * (경기당 교체 84건 × marginRefAt 3회 × 2벌). 표본 길이 하한은 두 소비자가 공통으로
 * 요구하던 조건이라 여기서 한 번 걸러 둔다 - 그 뒤 조건만 각자 다르다.
 */
function computeSubSparks(events: GameEvent[], homeTcode: string, ix: ElapsedIndex): SubSparkHit[] {
  const out: SubSparkHit[] = [];
  for (let i = 1; i < events.length; i++) {
    const row = events[i];
    if (row.action_code !== SUB_IN_CODE || !row.pcode) continue;
    const spark = computeSubSpark(events, row, homeTcode, ix);
    if (!spark) continue;
    if (spark.beforeDur < SUB_SPARK_MIN_SAMPLE_SEC || spark.afterDur < SUB_SPARK_MIN_SAMPLE_SEC) continue;
    out.push({ idx: i, row, pcode: row.pcode, spark });
  }
  return out;
}

/** 벤치 출신(is_starter === false)이 투입된 뒤 흐름이 가장 좋아진 한 건. */
function findBestSixthManSpark(hits: SubSparkHit[], boxByPcode: Map<string, PlayerBox>): SubSparkHit | null {
  let best: SubSparkHit | null = null;
  for (const h of hits) {
    const p = boxByPcode.get(h.pcode);
    if (!p || p.is_starter !== false) continue;
    if (h.spark.delta <= 0) continue;
    if (!best || h.spark.delta > best.spark.delta) best = h;
  }
  return best;
}

function findNotableSubSparks(hits: SubSparkHit[]): SubSparkHit[] {
  return hits.filter((h) => Math.abs(h.spark.delta) >= SUB_SPARK_NOTABLE_THRESHOLD);
}

export type BuildReportInput = {
  events: GameEvent[]; // event_order 오름차순, attachDerivedFields() 이미 적용된 것
  box: PlayerBox[]; // game_player_stats(이 경기 최종 박스스코어)
  homeTeam: ReportTeamMeta;
  awayTeam: ReportTeamMeta;
  homeScore: number;
  awayScore: number;
  rarity: GameRarity | null;
  // ── 아래는 전부 선택 - 없으면 해당 섹션만 조용히 생략된다 (새 왕복 0회: page.tsx가 이미 들고 있던 것들) ──
  /** 이 경기 슛 로그(page.tsx getShots) - '경기를 가른 구역'. */
  shots?: ShotRow[];
  /**
   * game_team_stats 팀별 두 행. page.tsx가 화면 아래 '팀 스탯' 바용으로 이미 받아 둔 것을
   * 그대로 넘긴다(새 왕복 0회). 예전엔 여기서 3점(tpm/tpa)만 떼어 받았는데, 그 탓에 자유투와
   * 파울이 리포트에 아예 들어오지 못했다 - lib/report/fourFactors.ts 머리주석 참고.
   *
   * 쓰는 곳:
   *  - 3점 공식 기록: 좌표로 역산한 3점 판정은 팀-경기 단위로 공식 tpa와 |차이|<=1이 73%뿐
   *    이라(정확히 일치 51.3%) 3점 구역만은 이걸 쓴다. 2점 4개 구역은 좌표.
   *  - 네 가지 요인 / 예측 오차 진단 / 공식 페이스.
   */
  teamStats?: TeamStatLine[];
  /** 이 경기 이전 역대 맞대결 - '맞대결의 매듭'. */
  h2h?: H2H | null;
  /** 이 경기 이전 정규시즌 누적(리크프리) - '평소의 그 팀이 아니었다'. */
  homeSeason?: SeasonStats | null;
  awaySeason?: SeasonStats | null;
  /** pregame_features에서 모델이 경기 전에 본 입력값 - '예측 오차 진단'. 없으면 그 표만 빠진다. */
  expectation?: PregameExpectation | null;
};

// ---------------------------------------------------------------------------
// 추가 섹션 6개의 임계값 - 전부 25-26 정규시즌 270경기 전수 실측으로 정했다.
// 원칙: '가끔 뜨는 진짜 사건'(대략 경기의 15~40%)이어야 리포트다. 60%를 넘으면 배경 소음이고
// 5% 밑이면 만들 가치가 없다. 각 줄의 숫자가 그 근거다.
// ---------------------------------------------------------------------------
/** 승자의 최저 승률. 분포 p10=0.125 / p25=0.216 / p50=0.353 - 30%면 41%(흔함), 10%면 7.8%(희귀). 20%에서 21.5%. */
const CRISIS_MAX_PROB = 0.2;
/** '극적인 흐름'(98.5%에서 뜬다)의 시작점과 이 안이면 같은 사건이라 생략 - 58건 중 11건. */
const CRISIS_DEDUP_SEC = 60;
/**
 * '극적인 흐름'에 "단 N분 만에"를 붙일 상한. 40분 경기의 10%(4분)까지가 "단"이라 부를 만한
 * 길이다 - 예전엔 조건 없이 붙어서 9분 38초(경기의 24%)에도 "단"이 붙었다.
 */
const DRAMATIC_BRIEF_SEC = 240;
/** 최다 사용 5인의 함께 뛴 시간 - 중앙 618초, 10%분위 388초. 300초는 하위 5%만 자른다. */
const CORE_FIVE_MIN_SEC = 300;
/** 그 5인이 있을 때의 득실차 - ±10이면 30%, ±12면 23%, ±14면 16%. */
const CORE_FIVE_MIN_DIFF = 12;
/** 에이스 오프코트 시간 - 중앙 509초, 25%분위 326초. */
const ONOFF_MIN_OFF_SEC = 300;
/** 오프코트 득실차 - >=6이면 40%, >=8이면 29%, >=10이면 19%. */
const ONOFF_MIN_DIFF = 8;
// 최대 구역 득점차(ZONE_MIN_DIFF)는 report/shotHotZone.ts로 같이 옮겼다.
/** 맞대결 연승 - >=3이면 31%, >=4면 21%, >=5면 14%. 시즌에 6번 만나므로 4연승이면 '한 시즌 내내'가 사실인 최소. */
const H2H_MIN_STREAK = 4;
/** 5경기 미만의 '시즌 최다'는 의미가 없다. */
const SEASON_EXTREME_MIN_GP = 5;
/**
 * 클러치 요약에서 "끝까지 맞섰다"고 부를 최종 점수차. isClutchGame 판정(마지막 5분 중
 * **한 순간이라도** 5점 이내)은 진입 조건이라 느슨해도 되지만, 요약 문구는 경기가 실제로 어떻게
 * 끝났는지를 봐야 한다 - 안 그러면 9점 차로 끝난 경기를 "한 치의 양보도 없는 혈투"라고 쓴다.
 */
const CLUTCH_TIGHT_MARGIN = 5;

// ---------------------------------------------------------------------------
// 라인업 세그먼트 - '주력 5인'과 '그가 코트에 없던 시간'이 나눠 쓴다.
//
// 교체(101 IN / 102 OUT)마다 구간을 끊고, 각 구간에 (양 팀 온코트 5인, 초, 양 팀 득점)을 붙인다.
// 모든 초와 모든 점수가 정확히 한 구간에 들어가므로 어떻게 나눠 더해도 최종 스코어와 맞는다 -
// lineup_stints 테이블은 그렇지 않다(실측: S47G01N53에서 76점≠78점, S47G01N157에서 94≠95).
// 그래서 테이블을 조회하지 않고 이벤트에서 다시 만든다(왕복 0, 라이브 경기에도 안전).
// ---------------------------------------------------------------------------
export type LineupSegment = { homeOn: string[]; awayOn: string[]; seconds: number; homePts: number; awayPts: number };

export function buildLineupSegments(events: GameEvent[], box: PlayerBox[], homeTcode: string, awayTcode: string): LineupSegment[] {
  const homeOn = new Set(box.filter((b) => b.tcode === homeTcode && b.is_starter).map((b) => b.pcode));
  const awayOn = new Set(box.filter((b) => b.tcode === awayTcode && b.is_starter).map((b) => b.pcode));
  const segs: LineupSegment[] = [];
  let cur: LineupSegment = { homeOn: [...homeOn], awayOn: [...awayOn], seconds: 0, homePts: 0, awayPts: 0 };
  let prevT = 0;
  let prevH = events.length ? events[0].home_score : 0;
  let prevA = events.length ? events[0].away_score : 0;
  for (const row of events) {
    const t = row.quarter === "PRE" ? 0 : row.elapsed;
    // 시계가 뒤로 가는 행(49/270경기)은 시간을 더하지 않는다 - 음수를 더하면 합계가 틀어진다.
    if (t > prevT) {
      cur.seconds += t - prevT;
      prevT = t;
    }
    cur.homePts += row.home_score - prevH;
    cur.awayPts += row.away_score - prevA;
    prevH = row.home_score;
    prevA = row.away_score;
    if (row.pcode && (row.action_code === "101" || row.action_code === "102")) {
      segs.push(cur);
      const set = row.tcode === homeTcode ? homeOn : row.tcode === awayTcode ? awayOn : null;
      if (set) {
        if (row.action_code === "101") set.add(row.pcode);
        else set.delete(row.pcode);
      }
      cur = { homeOn: [...homeOn], awayOn: [...awayOn], seconds: 0, homePts: 0, awayPts: 0 };
    }
  }
  segs.push(cur);
  return segs;
}

type Split = { seconds: number; my: number; opp: number };

const ZERO_SPLIT: Split = Object.freeze({ seconds: 0, my: 0, opp: 0 });

/**
 * 한 팀 쪽 세그먼트를 **한 번** 훑어 만드는 집계. 주력5인(6-1)·그가없던시간(6-2)·
 * 스탯에보이지않은선수·라인업시너지·에이스맞대결이 전부 이걸 나눠 쓴다.
 *
 * 예전 구조가 왜 비쌌나: 선수 한 명의 온/오프를 알려면 splitSegments()가 세그먼트 전체를
 * 다시 훑었다. '스탯에 보이지 않은 선수'는 그걸 팀당 12명에게 돌리고(경기당 세그먼트는
 * 평균 169개, 최대 305개), 그 위에 주력5인 선택·주력5인 온오프·시너지가 각자 또
 * `[...lu].sort().join(",")`을 세그먼트마다 다시 만들었다(경기당 1,000회 넘는 배열 복사).
 * 전부 같은 한 번의 순회에서 나오는 값이다.
 */
type SideRollup = {
  /** 그 팀의 경기 전체 합계. 개별 온코트 합계를 빼면 그게 오프코트다(모든 초·점수가 정확히
   *  한 구간에 들어간다는 buildLineupSegments의 불변식 - 그래서 뺄셈이 정확하다). */
  total: Split;
  /** pcode -> 그 선수가 코트에 있던 구간 합계. */
  onByPcode: Map<string, Split>;
  /** 5인 조합별 합계. 온코트가 5명이 아닌 구간(교체 누락·퇴장 등)은 버린다 - 기존 규칙 그대로. */
  units: FiveManUnit[];
  unitByKey: Map<string, FiveManUnit>;
};

function rollupSide(segs: LineupSegment[], side: "home" | "away"): SideRollup {
  const total: Split = { seconds: 0, my: 0, opp: 0 };
  const onByPcode = new Map<string, Split>();
  const unitByKey = new Map<string, FiveManUnit>();
  for (const s of segs) {
    const lu = side === "home" ? s.homeOn : s.awayOn;
    const my = side === "home" ? s.homePts : s.awayPts;
    const opp = side === "home" ? s.awayPts : s.homePts;
    total.seconds += s.seconds;
    total.my += my;
    total.opp += opp;
    for (const pc of lu) {
      let acc = onByPcode.get(pc);
      if (!acc) {
        acc = { seconds: 0, my: 0, opp: 0 };
        onByPcode.set(pc, acc);
      }
      acc.seconds += s.seconds;
      acc.my += my;
      acc.opp += opp;
    }
    if (lu.length !== 5) continue;
    const sorted = [...lu].sort();
    const key = sorted.join(",");
    let u = unitByKey.get(key);
    if (!u) {
      u = { key, pcodes: sorted, seconds: 0, my: 0, opp: 0 };
      unitByKey.set(key, u);
    }
    u.seconds += s.seconds;
    u.my += my;
    u.opp += opp;
  }
  return { total, onByPcode, units: [...unitByKey.values()], unitByKey };
}

/** 전체 - 온코트 = 오프코트. splitSegments()가 세그먼트를 다시 훑던 자리를 대체한다. */
function onOffOf(r: SideRollup, pcode: string): { on: Split; off: Split } {
  const on = r.onByPcode.get(pcode) ?? ZERO_SPLIT;
  return {
    on,
    off: { seconds: r.total.seconds - on.seconds, my: r.total.my - on.my, opp: r.total.opp - on.opp },
  };
}

/** 함께 뛴 시간이 가장 긴 5인 - **결과가 아니라 시간으로** 고른다(결과로 고르면 선택편향으로 94%에서 뜬다). */
function mostUsedFive(r: SideRollup): FiveManUnit | null {
  let best: FiveManUnit | null = null;
  for (const u of r.units) if (!best || u.seconds > best.seconds) best = u;
  return best;
}

const sign = (v: number) => (v > 0 ? `+${v}` : `${v}`);

export function buildPostgameReport(input: BuildReportInput): ReportSection[] {
  const { events, box, homeTeam, awayTeam, homeScore, awayScore, rarity } = input;
  const homeTcode = homeTeam.tcode;
  const awayTcode = awayTeam.tcode;
  const homeTname = homeTeam.name;
  const awayTname = awayTeam.name;

  // 팀 색 태그 - 정의는 report/renderKit.ts(섹션 모듈들과 같은 것을 써야 해서 밖으로 나갔다).
  const tags = createReportTags(homeTeam, awayTeam);
  const { metaOf, playerTag, teamTag, liOpen } = tags;

  // ── 섹션들이 나눠 쓰는 조회용 자료구조 ────────────────────────────────────────
  // 예전엔 pcode->선수를 쓰는 섹션마다 `new Map(box.map(...))`를 따로 만들거나(3곳)
  // `box.find(...)`로 매번 훑었다(라인업 이름 5명 × 팀 2 × 섹션 2). 한 번만 만든다.
  const boxByPcode = new Map(box.map((b) => [b.pcode, b]));
  const nameOf = (pcode: string) => boxByPcode.get(pcode)?.name ?? pcode;
  // 시간 스캔 인덱스 - marginRefAt(교체 섹션)이 쓴다. ElapsedIndex 주석 참고.
  const elapsedIx = buildElapsedIndex(events);
  // 팀 에이스는 스포트라이트·온오프·에이스맞대결 세 섹션이 같은 정의로 쓴다(주체를 결과로
  // 고르지 않는 게 설계였으니 세 곳이 같은 사람이어야 한다) - 팀당 한 번만 고른다.
  const topByTcode = new Map<string, PlayerBox | null>();
  const topOf = (tcode: string): PlayerBox | null => {
    if (!topByTcode.has(tcode)) topByTcode.set(tcode, teamTopPerformer(box, tcode));
    return topByTcode.get(tcode) ?? null;
  };
  // 교체 스파크 - 식스맨(6절)과 결정적 교체(8절)가 같은 계산을 나눠 쓴다.
  const subSparkHits = computeSubSparks(events, homeTcode, elapsedIx);
  // 라인업 세그먼트와 팀별 집계 - 6-1/6-2/스탯에보이지않은선수/시너지/에이스맞대결 공용.
  // 예전엔 buildLineupSegments()를 6-1절과 8.9절이 각자 한 번씩 돌렸다(같은 결과 두 벌).
  const segs = buildLineupSegments(events, box, homeTcode, awayTcode);
  const rollupBySide = { home: rollupSide(segs, "home"), away: rollupSide(segs, "away") } as const;
  const homeWon = homeScore > awayScore;
  const winnerTcode = homeWon ? homeTcode : awayTcode;
  const loserTcode = homeWon ? awayTcode : homeTcode;
  const winnerTname = homeWon ? homeTname : awayTname;
  const loserTname = homeWon ? awayTname : homeTname;
  const winnerScore = homeWon ? homeScore : awayScore;
  const loserScore = homeWon ? awayScore : homeScore;
  // 원값을 그대로 들고 있는다 - 채점에 반올림한 정수를 쓰면 49.5~49.99%가 "홈 우세"로
  // 뒤집힌다(lib/predictionVerdict.ts 주석의 실측 버그). preActPct는 표시·3절 폴백 전용.
  const preProb = events[0]?.home_win_prob ?? 0.5;
  const preActPct = Math.round(preProb * 100);

  const sections: ReportSection[] = [];

  // 1. 경기 결과 + 예측 채점 + 마진 희귀도
  // 채점 규칙은 lib/predictionVerdict.ts 한 곳에만 있다(여기와 matchupInsights.ts의
  // gradeMatchupInsights가 같은 예측을 정반대로 채점해 같은 페이지에 내보낸 버그 때문).
  {
    const verdict = gradePrediction(preProb, homeWon);
    const coinflip = verdict === "coinflip";
    const favHome = preProb >= 0.5;
    const favTname = favHome ? homeTname : awayTname;
    const favTcode = favHome ? homeTcode : awayTcode;
    const favPct = fmtProbPct(favHome ? preProb : 1 - preProb, coinflip);
    let html =
      `<p class="report-text">최종 스코어 ${teamTag(winnerTcode, winnerTname)} <b>${winnerScore} : ${loserScore}</b> ${teamTag(loserTcode, loserTname)}. ` +
      (coinflip
        ? // 표시값이 양쪽 다 50%인 구간 - '우세한 쪽'이 없으므로 적중/빗나감을 매기지 않는다.
          `예측은 <b>반반</b> - 경기 전 승률이 ${teamTag(homeTcode, homeTname)} ${fmtProbPct(preProb, true)}% : ${teamTag(awayTcode, awayTname)} ${fmtProbPct(1 - preProb, true)}%로, 어느 쪽도 우세라고 부를 수 없는 차이였음(사실상 동전 던지기). 실제로는 ${teamTag(winnerTcode, winnerTname)}${iGa(winnerTname)} 이김.`
        : verdict === "hit"
          ? `예측은 <b>적중</b> - 경기 전 ${teamTag(favTcode, favTname)}${iGa(favTname)} 이길 확률을 ${favPct}%로 더 높게 봤고, 실제로 그대로 됨.`
          : `예측은 <b>빗나감</b> - 경기 전엔 ${teamTag(favTcode, favTname)}${iGa(favTname)} 더 유력했지만(${favPct}%), 실제로는 ${teamTag(winnerTcode, winnerTname)}${iGa(winnerTname)} 이김. 확률 예측은 100% 확신이 아니라 "이 정도 비율로 이런 결과가 나온다"는 뜻이라, 이런 이변도 정상적인 범위임.`) +
      `</p>`;
    if (rarity) {
      const marginPct = Math.round((rarity.marginPercentile || 0) * 100);
      const margin = winnerScore - loserScore;
      html +=
        marginPct >= 70
          ? `<p class="report-text">최종 마진은 ${margin}점 - 15시즌 ${rarity.marginTotalGames}경기 중 이보다 더 크게 벌어진 경기는 ${100 - marginPct}%뿐 - 압도적인 승리였음.</p>`
          : `<p class="report-text">최종 마진은 ${margin}점 - 15시즌 ${rarity.marginTotalGames}경기 중 ${marginPct}%가 이 정도로 접전이었음.</p>`;
    }
    sections.push({ title: "경기 결과", html });
  }

  // 1.5 네 가지 요인 & 득점 출처 - "무엇이 승부를 갈랐나". 계산은 report/fourFactors.ts,
  // 문장·막대는 components/report/FourFactorsSection.tsx.
  //
  // 오펜스/디펜스 리바운드는 중계 이벤트로 직접 센다: game_team_stats.oreb/dreb는 8,444행
  // 전부 NULL이고(2026-09-30 실측), 209=공격리바운드 / 210=수비리바운드가 정확한 소스다.
  // 이 파일이 이미 events를 한 번 훑고 있으니 그 안에서 같이 센다(추가 순회 1회, 새 쿼리 0회).
  const homeStatLine = input.teamStats?.find((t) => t.tcode === homeTcode) ?? null;
  const awayStatLine = input.teamStats?.find((t) => t.tcode === awayTcode) ?? null;
  if (homeStatLine && awayStatLine) {
    let homeOreb = 0,
      homeDreb = 0,
      awayOreb = 0,
      awayDreb = 0;
    for (const e of events) {
      if (!e.tcode || (e.action_code !== "209" && e.action_code !== "210")) continue;
      const off = e.action_code === "209";
      if (e.tcode === homeTcode) {
        if (off) homeOreb++;
        else homeDreb++;
      } else if (e.tcode === awayTcode) {
        if (off) awayOreb++;
        else awayDreb++;
      }
    }
    const ff = computeFourFactors({
      home: homeTeam,
      away: awayTeam,
      homeStats: homeStatLine,
      awayStats: awayStatLine,
      homeOreb,
      homeDreb,
      awayOreb,
      awayDreb,
      homeScore,
      awayScore,
    });
    if (ff) sections.push({ title: "무엇이 승부를 갈랐나 (Four Factors)", data: ff });
  }

  // 1.6 예측 오차 진단 - 요청: "예상이 틀렸다면 왜 틀렸는지에 대한 분석". 계산은
  // report/predictionAudit.ts(그 파일 머리주석에 근거), 차트·표는
  // components/report/PredictionAuditSection.tsx.
  {
    const audit = computePredictionAudit({
      home: homeTeam,
      away: awayTeam,
      events,
      homeScore,
      awayScore,
      homeStats: homeStatLine,
      awayStats: awayStatLine,
      expectation: input.expectation ?? null,
    });
    if (audit) sections.push({ title: "예측 오차 진단 (Prediction Audit)", data: audit });
  }

  // 2. 팀별 스포트라이트 + 최고 활약이 패배로 이어진 이유 - 요청: "팀별 스포트라이트 선수를
  // 더 자세히(나노분석)" - gameScore 계산엔 이미 쓰이지만 화면엔 안 보여주던 필드(자유투/
  // 스틸/블록/턴오버/파울)까지 한 줄에 담음.
  const spotlightLine = (p: PlayerBox) =>
    `${p.pts}점 (FG ${p.fgm}/${p.fga}, FT ${p.ftm}/${p.fta}) · ${p.ast}AST ${p.reb}REB ${p.stl}STL ${p.blk}BLK ${p.turnovers}TO ${p.fouls}PF`;
  {
    const winnerTop = topOf(winnerTcode);
    const loserTop = topOf(loserTcode);
    let html = "";
    if (winnerTop) {
      html += `<p class="report-text">🏆 ${teamTag(winnerTcode, winnerTname)} 스포트라이트 - ${playerTag(winnerTop.name, winnerTop.tcode)} ${spotlightLine(winnerTop)}.</p>`;
    }
    if (loserTop) {
      html += `<p class="report-text">🥈 ${teamTag(loserTcode, loserTname)} 스포트라이트 - ${playerTag(loserTop.name, loserTop.tcode)} ${spotlightLine(loserTop)}.</p>`;
    }
    const overallMvp = gameWideTopPerformer(box, homeScore, awayScore, homeTcode, awayTcode);
    if (overallMvp && overallMvp.tcode === loserTcode) {
      const reasons = explainLosingDespiteTopPerformer(events, box, winnerTcode, loserTcode, homeTcode, awayTcode);
      if (reasons.length) {
        html += `<p class="report-text">최고 활약(${playerTag(overallMvp.name, overallMvp.tcode)})에도 ${teamTag(loserTcode, loserTname)}${eunNeun(loserTname)} 진 이유 - ${reasons.join(", ")}.</p>`;
      }
    }
    if (html) sections.push({ title: "팀별 스포트라이트", html });
  }

  // 2-0.5 쿼터별 마진 - '팀별 스포트라이트'가 문장으로 "OO에서만 N점 열세"라고 한 줄 말하는
  // 그 구조를 그림으로 한 번에 보여준다. 쿼터 득실은 이미 explainLosingDespiteTopPerformer가
  // 계산하던 것과 같은 값이고(quarterBoundaries), 막대 합이 정확히 최종 마진이라 검산이 된다.
  {
    const html = renderQuarterMargins(events, homeTeam, awayTeam, tags);
    if (html) sections.push({ title: "쿼터별 마진 (합 = 최종 마진)", html });
  }

  // 2-1. 경기를 가른 구역 - 계산·문장 전부 report/shotHotZone.ts.
  if (input.shots && input.shots.length) {
    const zoneEdge = computeHotZoneEdge({
      shots: input.shots,
      teamThrees: input.teamStats,
      homeTcode,
      awayTcode,
      homeScore,
      awayScore,
    });
    if (zoneEdge) sections.push(renderHotZoneSection(zoneEdge, { homeTeam, awayTeam, tags }));
  }

  // 2-1.5 슛 퀄리티 결산 (xPTS vs Actual PTS)
  if (input.shots && input.shots.length > 0) {
    let homeXPTS = 0;
    let awayXPTS = 0;
    for (const s of input.shots) {
      if (!s.tcode) continue;
      const xp = shotXPTS(s.x, s.y, s.d);
      if (s.tcode === homeTcode) homeXPTS += xp;
      else if (s.tcode === awayTcode) awayXPTS += xp;
    }
    
    // 비교 대상은 "야투로 낸 득점"이어야 한다 - xPTS는 슛로그(필드골) 좌표만 더한 값이라
    // 자유투가 한 점도 안 들어있는데, 예전엔 여기서 팀 총득점(homeScore/awayScore)과 비교했다.
    // KBL 팀은 경기당 자유투로만 평균 15.4점을 넣으므로 그 차이가 통째로 "기대 대비 초과득점"
    // 으로 새서(실측 - 최근 4시즌 1,136 팀-경기의 델타 평균 +15.44점, 93%가 양수) 이 섹션이
    // 팀-경기의 77.5%에서 "득점 폭발"을 찍고 있었다. pts - ftm이 곧 야투 득점(2점+3점)이다.
    const fgPtsOf = (tcode: string) => sumTeam(box, tcode, (b) => b.pts - b.ftm);
    const items: string[] = [];
    for (const [tcode, tname, xpts, pts] of [
      [homeTcode, homeTname, homeXPTS, fgPtsOf(homeTcode)],
      [awayTcode, awayTname, awayXPTS, fgPtsOf(awayTcode)],
    ] as const) {
      const diff = pts - xpts;
      // 임계값 12점 - 위 보정을 하고 나면 델타 분포가 평균 -0.17점 / 표준편차 10.0점이라
      // 예전 임계값 8점(0.8σ)은 여전히 42%에서 걸린다. 12점(약 1.2σ)이면 23%(양/음 대칭).
      if (Math.abs(diff) >= 12) {
        if (diff > 0) {
          items.push(`${liOpen(tcode)}🎯 ${teamTag(tcode, tname)} 슛 퀄리티 대비 <b>득점 폭발</b> - 시도한 슛의 위치만 보면 야투 기대득점은 <b>${xpts.toFixed(1)}점</b>이었으나, 어려운 터프샷을 다수 꽂아 넣으며 실제 야투 득점은 <b>${pts}점</b>이었습니다.</li>`);
        } else {
          items.push(`${liOpen(tcode)}🎯 ${teamTag(tcode, tname)} 슛 퀄리티 대비 <b>득점 빈곤</b> - 오픈 찬스 등 좋은 슛 기회를 만들어내어 야투 기대득점은 <b>${xpts.toFixed(1)}점</b>에 달했으나, 실제 야투 득점은 <b>${pts}점</b>에 그치며 마무리가 아쉬웠습니다.</li>`);
        }
      }
    }
    if (items.length > 0) {
      sections.push({ title: "슛 퀄리티 결산 (xPTS vs Actual)", html: `<ul class="report-list">${items.join("")}</ul><p class="report-caveat">기대득점(xPTS)은 슛 좌표(위치/거리)별 리그 15시즌 평균 성공률로 산출한 슛 기회의 질적 지표입니다. 자유투는 양쪽 모두에서 제외하고 야투 득점끼리만 비교합니다.</p>` });
    }
  }


  // 2-2. 평소의 그 팀이 아니었다 - 이 경기 팀 기록이 그 팀 자신의 시즌 기록(이 경기 이전, 정규시즌)을
  // 깼을 때만. '평균 대비 차이' 임계로 하면 아무 경기나 걸린다 - 실측에서 최다득점 5.9% / 최소실점
  // 4.5% / 최다3점 4.5%라 셋을 합쳐도 경기의 21%에서만 뜬다.
  {
    const lines: string[] = [];
    for (const [tcode, tname, season, pts, oppPts] of [
      [homeTcode, homeTname, input.homeSeason, homeScore, awayScore],
      [awayTcode, awayTname, input.awaySeason, awayScore, homeScore],
    ] as const) {
      if (!season || season.gp < SEASON_EXTREME_MIN_GP) continue;
      const tpm = input.teamStats?.find((t) => t.tcode === tcode)?.tpm;
      if (pts > season.maxPts) {
        lines.push(`${liOpen(tcode)}${teamTag(tcode, tname)} ${pts}점 - 이 경기 전까지 ${season.gp}경기 평균 ${season.ppg.toFixed(1)}점이던 팀이 시즌 최다 득점을 새로 씀(종전 ${season.maxPts}점).</li>`);
      }
      if (oppPts < season.minOppPts) {
        lines.push(`${liOpen(tcode)}${teamTag(tcode, tname)}${iGa(tname)} 내준 ${oppPts}점은 이 경기 전까지 ${season.gp}경기 평균 ${season.oppPpg.toFixed(1)}점이던 이 팀의 시즌 최소 실점(종전 ${season.minOppPts}점).</li>`);
      }
      if (tpm != null && tpm > season.maxTpm) {
        lines.push(`${liOpen(tcode)}${teamTag(tcode, tname)} 3점 ${tpm}개 - 시즌 평균 ${season.threePg.toFixed(1)}개의 ${(tpm / Math.max(0.1, season.threePg)).toFixed(1)}배, 시즌 최다(종전 ${season.maxTpm}개).</li>`);
      }
    }
    if (lines.length) {
      sections.push({
        title: "평소의 그 팀이 아니었다",
        html: `<ul class="report-list">${lines.join("")}</ul><p class="report-caveat">이 경기 이전 정규시즌 누적 기준.</p>`,
      });
    }
  }

  // 3. 결정적 장면들 - 요청: "승률 60%→48%인데 정관장이 유리해졌다는 표현이 이상하다" -
  // 항상 홈팀 승률만 보여주면서 "유리해짐" 문구를 붙이면, 원정팀이 유리해질 때 숫자가
  // 거꾸로 떨어지는 것처럼 읽힘. 유리해지는 팀 자신의 승률(원정팀이면 100-확률)로 보여줘서
  // 숫자가 항상 그 팀 쪽으로 오르게 함.
  const topSwings = findTopWpaSwings(events, 3);
  if (topSwings.length) {
    const items = topSwings
      .map((s) => {
        const row = s.row;
        const beforeHomeProb = s.idx > 0 ? (events[s.idx - 1].home_win_prob ?? 0.5) : preActPct / 100;
        const afterHomeProb = row.home_win_prob ?? 0.5;
        const homeBenefits = (row.wpa_home ?? 0) > 0;
        const beneficiary = homeBenefits ? homeTname : awayTname;
        const beforeProb = Math.round((homeBenefits ? beforeHomeProb : 1 - beforeHomeProb) * 100);
        const afterProb = Math.round((homeBenefits ? afterHomeProb : 1 - afterHomeProb) * 100);
        // 득점한 선수와 승률이 오른 팀이 다를 수 있다(자책성 상황·자유투 유도 등). 그래서
        // 두 조각을 각자의 tcode로 따로 칠한다. li 마커는 득점한 선수 쪽 팀 색.
        const benefitTcode = homeBenefits ? homeTcode : awayTcode;
        // action_label은 DB 컬럼이 아니라 action_code로 참조 맵을 찾아 호출부가 붙여준 값이다 -
        // 맵에 없는(신설/미등록) action_code면 null로 들어와 문장에 그대로 "null"이 새는 걸 막는다.
        return `${liOpen(row.tcode)}${jumpLink(s.idx, clockStr(row))}, ${row.home_score}-${row.away_score} 상황 ${playerTag(row.player_name ?? "", row.tcode)}의 ${row.action_label ?? "결정적 장면"} - ${teamTag(benefitTcode, beneficiary)} 승률 ${beforeProb}%→${afterProb}%로 상승.</li>`;
      })
      .join("");
    sections.push({ title: "승패의 분수령 (WPA Swing Analysis)", html: `<ul class="report-list">${items}</ul>` });
  }

  // 4. AI 선정 베스트 장면
  {
    const excludeIdx = new Set(topSwings.map((s) => s.idx));
    const best = findAiPickBestScene(events, excludeIdx);
    if (best) {
      sections.push({
        title: "AI 선정 베스트 장면",
        html: `<p class="report-text">✨ ${jumpLink(best.idx, clockStr(best.row))}, ${playerTag(best.row.player_name ?? "", best.row.tcode)}의 ${best.row.action_label ?? "결정적 장면"} - 이 경기에서 가장 짜릿했던 순간.</p>`,
      });
    }
  }

  // 5. 극적인 흐름 - 요청: "왜 요동치게 되었는지, 승률 상승 포인트와 실제 스탯을 제공" - 이
  // 구간에 각 팀이 실제로 몇 점을 냈는지(누적 home_score/away_score 델타, 새 쿼리 불필요)를
  // 같이 보여줌. 승률 표기도 위 3번과 같은 이유로 유리해지는 팀 기준으로.
  // 5-1절('승자의 최대 위기')도 같은 값으로 중복 판정을 하므로 한 번만 구한다.
  const dramatic = findDramaticProbSwing(events);
  {
    if (dramatic) {
      const fromRow = events[dramatic.startIdx],
        toRow = events[dramatic.endIdx];
      const homeBenefits = dramatic.delta > 0;
      const beneficiary = homeBenefits ? homeTname : awayTname;
      const fromPct = Math.round((homeBenefits ? (fromRow.home_win_prob ?? 0.5) : 1 - (fromRow.home_win_prob ?? 0.5)) * 100);
      const toPct = Math.round((homeBenefits ? (toRow.home_win_prob ?? 0.5) : 1 - (toRow.home_win_prob ?? 0.5)) * 100);
      const homeGain = toRow.home_score - fromRow.home_score;
      const awayGain = toRow.away_score - fromRow.away_score;
      // 실측 버그(S49G14N4): "완전히 뒤집어놓음"이 스윙 크기만 보고 무조건 붙었다. 그 경기에서
      // KCC 승률은 8%→41%까지만 올랐고 **경기 내내 한 번도 50%를 넘지 못했다**(628개 이벤트
      // 전수 확인) - 뒤집힌 적이 없는데 뒤집었다고 쓰고 있었다. 실제로 역전선(50%)을 넘었을
      // 때만 '뒤집었다'고 한다.
      const flipped = fromPct < 50 && toPct >= 50;
      // "단 N분 만에"도 무조건 붙었다 - 40분 경기의 24%(9분 38초)를 "단"이라고 불렀다.
      const brief = dramatic.durationSec < DRAMATIC_BRIEF_SEC;
      sections.push({
        title: "극적인 흐름",
        html:
          `<p class="report-text">⚡ ${jumpLink(dramatic.startIdx, clockStr(fromRow))}부터 ${jumpLink(dramatic.endIdx, clockStr(toRow))}까지 ${brief ? "단 " : ""}${fmtDuration(dramatic.durationSec)} 만에 ${teamTag(homeBenefits ? homeTcode : awayTcode, beneficiary)} 승률이 ${fromPct}%에서 ${toPct}%로 요동침` +
          `(이 구간 ${teamTag(homeTcode, homeTname)} ${homeGain}점, ${teamTag(awayTcode, awayTname)} ${awayGain}점) - ` +
          (flipped
            ? `${teamTag(homeBenefits ? homeTcode : awayTcode, beneficiary)}${iGa(beneficiary)} 이 구간에 경기 흐름을 뒤집어놓음.</p>`
            : `${teamTag(homeBenefits ? homeTcode : awayTcode, beneficiary)}${iGa(beneficiary)} 맹렬히 따라붙었지만 역전선(50%)까지는 닿지 못함.</p>`),
      });
    }
  }

  // 5-1. 승자의 최대 위기 - 이긴 팀의 승률이 경기 중 가장 낮게 떨어진 지점. '극적인 흐름'은
  // 승률 스윙의 크기를, 이건 바닥의 깊이를 말한다. 그래도 그 스윙의 시작점과 60초 이내면 같은
  // 사건이라 생략한다.
  {
    const winnerTcode = homeWon ? homeTcode : awayTcode;
    const winnerName = homeWon ? homeTname : awayTname;
    let lowIdx = -1;
    let low = 1;
    events.forEach((e, i) => {
      if (e.quarter === "PRE" || e.home_win_prob == null) return;
      const pr = homeWon ? e.home_win_prob : 1 - e.home_win_prob;
      if (pr < low) {
        low = pr;
        lowIdx = i;
      }
    });
    if (lowIdx >= 0 && low <= CRISIS_MAX_PROB) {
      const dup = !!dramatic && Math.abs(events[lowIdx].elapsed - events[dramatic.startIdx].elapsed) <= CRISIS_DEDUP_SEC;
      if (!dup) {
        const row = events[lowIdx];
        let deficit = 0;
        for (const e of events) {
          if (e.quarter === "PRE") continue;
          const d = homeWon ? e.away_score - e.home_score : e.home_score - e.away_score;
          if (d > deficit) deficit = d;
        }
        const ws = homeWon ? homeScore : awayScore;
        const ls = homeWon ? awayScore : homeScore;
        sections.push({
          title: "승자의 최대 위기",
          html:
            `<p class="report-text">🌡️ ${jumpLink(lowIdx, clockStr(row))}, ${row.home_score}-${row.away_score} - ${teamTag(winnerTcode, winnerName)} 승률이 ` +
            `<b>${(low * 100).toFixed(1)}%</b>까지 떨어진 순간${deficit > 0 ? `(이 경기 최대 열세 ${deficit}점)` : ""}. 거기서 ${ws}-${ls}로 이김.</p>`,
        });
      }
    }
  }

  // 6. 이 경기의 식스맨 - 요청: "그래서 이 투입 이후 상황이 어떻게 흘러갔는지" - 투입 후 실제
  // 관찰 구간 동안 양 팀이 각각 몇 점을 냈는지 표시.
  //
  // 식스맨으로 뽑힌 교체는 8절('결정적 교체 타이밍')에서 제외한다 - 두 절이 같은
  // subSparkHits를 보므로 최고 스파크가 양쪽에 다 걸려, 같은 사건이 거의 같은 문장으로 두 번
  // 나왔다(실측: 장민국 Q2 4:20 건이 식스맨·결정적 교체·라인업 시너지 세 절에 중복 노출).
  let sixthManIdx: number | null = null;
  {
    const sixthMan = findBestSixthManSpark(subSparkHits, boxByPcode);
    if (sixthMan) {
      const p = boxByPcode.get(sixthMan.pcode);
      // delta(넷레이팅 환산)는 순위를 정하는 데만 쓰고 문장에는 안 낸다 - 아래 주석 참고.
      const { afterDur, homeGain, awayGain } = sixthMan.spark;
      sixthManIdx = sixthMan.idx;
      sections.push({
        title: "이 경기의 식스맨",
        // 넷레이팅 변화 숫자(delta)를 문장에서 뺐다: 관찰 구간이 2~3분인 경우가 흔해 100포제션
        // 환산이 +167.2처럼 읽을 수 없는 값으로 찍혔다(2026-09-30 실측, 장민국 2분 43초).
        // 바로 뒤에 있는 "이후 N분간 몇 점 대 몇 점"이 같은 사실을 표본 크기까지 드러내며
        // 말하므로, 환산값은 순위를 정하는 데만 쓰고(findBestSixthManSpark) 화면에는 안 낸다.
        html: `<p class="report-text">🔋 ${playerTag(p?.name ?? "", p?.tcode ?? null)}${iGa(p?.name ?? "")} ${jumpLink(sixthMan.idx, clockStr(sixthMan.row))} 투입된 뒤 팀 흐름이 좋아짐(이후 ${fmtDuration(afterDur)}간 ${teamTag(homeTcode, homeTname)} ${homeGain}점 · ${teamTag(awayTcode, awayTname)} ${awayGain}점) - 이 경기 최고의 벤치 임팩트.</p>`,
      });
    }
  }

  // 6-1. 이 경기의 주력 5인 / 6-2. 그가 코트에 없던 시간 - 같은 세그먼트를 나눠 쓴다.
  // 둘 다 문장은 "있을 때 이랬고 없을 때 저랬다"까지만. 상대 라인업을 통제하지 않은 한 경기
  // 스플릿이라 "이 조합이 잘했다"는 인과로 쓰지 않는다. 원시 점수만 쓰고 per-40 환산은 하지
  // 않는다 - 300~600초 표본을 2400초로 늘리면 노이즈가 4~8배가 된다.
  {
    const fmtSplit = (s: Split) => `${fmtDuration(s.seconds)} 동안 ${s.my}-${s.opp}(${sign(s.my - s.opp)})`;

    const coreItems: string[] = [];
    const onoffItems: string[] = [];
    for (const [side, tcode, tname] of [
      ["home", homeTcode, homeTname],
      ["away", awayTcode, awayTname],
    ] as const) {
      const roll = rollupBySide[side];
      // 주력 5인 - 시간으로 사전 선택(결과로 고르면 94%에서 뜬다).
      const top = mostUsedFive(roll);
      if (top && top.seconds >= CORE_FIVE_MIN_SEC) {
        // 그 조합이 코트에 있던 구간 = 그 조합의 유닛 합계. 나머지가 오프다.
        const on: Split = { seconds: top.seconds, my: top.my, opp: top.opp };
        const off: Split = {
          seconds: roll.total.seconds - on.seconds,
          my: roll.total.my - on.my,
          opp: roll.total.opp - on.opp,
        };
        const onD = on.my - on.opp;
        const offD = off.my - off.opp;
        if (Math.abs(onD) >= CORE_FIVE_MIN_DIFF && onD * offD <= 0) {
          const names = top.pcodes.map((pc) => playerTag(nameOf(pc), tcode)).join(" · ");
          coreItems.push(
            `${liOpen(tcode)}${teamTag(tcode, tname)}${iGa(tname)} 이 경기에 가장 오래 붙인 5인 - ${names}. ` +
              `이 다섯이 함께 있던 ${fmtSplit(on)}, 조합이 깨져 있던 ${fmtSplit(off)}.</li>`
          );
        }
      }
      // 온/오프 - 주체는 스포트라이트와 같은 사람(teamTopPerformer). 팀 전원에서 |온-오프| 최댓값을
      // 고르면 다중비교로 80~91%에서 뜬다. 주체를 결과로 고르지 않는 게 이 섹션의 핵심 설계.
      const star = topOf(tcode);
      if (star) {
        const { on, off } = onOffOf(roll, star.pcode);
        const onD = on.my - on.opp;
        const offD = off.my - off.opp;
        if (off.seconds >= ONOFF_MIN_OFF_SEC && Math.abs(offD) >= ONOFF_MIN_DIFF && onD * offD <= 0) {
          onoffItems.push(
            `${liOpen(tcode)}${playerTag(star.name, tcode)}(${star.pts}점)${iGa(star.name)} 코트에 있던 ${fmtSplit(on)}, 벤치에 있던 ${fmtSplit(off)}.</li>`
          );
        }
      }
    }
    if (coreItems.length) sections.push({ title: "이 경기의 주력 5인", html: `<ul class="report-list">${coreItems.join("")}</ul>` });
    if (onoffItems.length) sections.push({ title: "그가 코트에 없던 시간", html: `<ul class="report-list">${onoffItems.join("")}</ul>` });

    // 2.5 스탯에 보이지 않은 선수 - 선택 로직은 report/unsungHero.ts, 문장은
    // components/report/UnsungHeroSection.tsx. 여기서는 후보의 온/오프만 채워 넘긴다
    // (rollupBySide로 이미 만들어 둔 집계에서 꺼내니 추가 순회 없음).
    const unsung = computeUnsungHeroes(
      ([
        ["home", homeTeam],
        ["away", awayTeam],
      ] as const).map(([side, team]) => ({
        team,
        candidates: box
          .filter((p) => p.tcode === team.tcode)
          .map((p) => {
            const { on, off } = onOffOf(rollupBySide[side], p.pcode);
            return {
              name: p.name,
              pts: p.pts,
              reb: p.reb,
              ast: p.ast,
              stl: p.stl,
              blk: p.blk,
              onSec: on.seconds,
              onMargin: on.my - on.opp,
              offSec: off.seconds,
              offMargin: off.my - off.opp,
            };
          }),
      }))
    );
    if (unsung) sections.push({ title: "스탯에 보이지 않은 선수", data: unsung });

    // 2.6 라인업 시너지 흥망성쇠 - 계산·문장 전부 report/lineupSynergy.ts.
    const synergySection = renderLineupSynergySection(
      [
        { team: homeTeam, synergy: computeLineupSynergy(segs, "home", rollupBySide.home.units) },
        { team: awayTeam, synergy: computeLineupSynergy(segs, "away", rollupBySide.away.units) },
      ],
      { tags, nameOf }
    );
    if (synergySection) sections.push(synergySection);
  }

  // 7. 스탯 폭발
  {
    const bursts = computeStatBursts(events);
    if (bursts.length) {
      const items = bursts
        .map((b) => {
          const p = boxByPcode.get(b.key);
          const name = p?.name ?? b.key;
          return `${liOpen(p?.tcode ?? null)}${playerTag(name, p?.tcode ?? null)}${iGa(name)} ${b.label} ${b.count}개를 ${fmtDuration(b.durationSec)} 만에 몰아침(${jumpLink(b.startIdx, clockStr(b.startRow))}~${jumpLink(b.endIdx, clockStr(b.endRow))}).</li>`;
        })
        .join("");
      sections.push({ title: "스탯 폭발", html: `<ul class="report-list">${items}</ul>` });
    }
  }

  // 8. 결정적 교체 타이밍
  {
    const subItems: string[] = [];
    const notableSubs = findNotableSubSparks(subSparkHits)
      // 6절에서 이미 말한 교체는 뺀다(위 sixthManIdx 주석 - 같은 사건 중복 노출).
      .filter((s) => s.idx !== sixthManIdx)
      .sort((a, b) => Math.abs(b.spark.delta) - Math.abs(a.spark.delta))
      .slice(0, 2);
    for (const s of notableSubs) {
      const name = boxByPcode.get(s.pcode)?.name ?? "";
      const dir = s.spark.delta > 0 ? "좋아짐" : "나빠짐";
      const { afterDur, homeGain, awayGain } = s.spark;
      const sTcode = boxByPcode.get(s.pcode)?.tcode ?? null;
      // 넷레이팅 환산값은 안 찍는다 - 6절과 같은 이유(소표본 100포제션 환산이 +167.2로 나온다).
      subItems.push(
        `${liOpen(sTcode)}🔄 ${playerTag(name, sTcode)}${iGa(name)} ${jumpLink(s.idx, clockStr(s.row))} 투입된 뒤 팀 흐름이 ${dir}(이후 ${fmtDuration(afterDur)}간 ${teamTag(homeTcode, homeTname)} ${homeGain}점 · ${teamTag(awayTcode, awayTname)} ${awayGain}점).</li>`
      );
    }
    if (subItems.length) sections.push({ title: "결정적 교체 타이밍", html: `<ul class="report-list">${subItems.join("")}</ul>` });
    
    // 8.5 파울 트러블 스노우볼 효과 (Foul Trouble Snowball)
    const foulItems: string[] = [];
    for (const fe of findFoulTroubleEvents(events)) {
      const runInfo = checkOpponentRunAfterFoulTrouble(events, fe, homeTcode);
      if (!runInfo) continue;
      const name = boxByPcode.get(fe.key)?.name ?? "";
      const feTcode = boxByPcode.get(fe.key)?.tcode ?? null;
      const t = metaOf(feTcode);
      if (!t) continue;
      const oppTname = feTcode === homeTcode ? awayTname : homeTname;
      const oppTcode = feTcode === homeTcode ? awayTcode : homeTcode;
      
      foulItems.push(`${liOpen(feTcode)}⚠️ ${playerTag(name, feTcode)}${iGa(name)} ${jumpLink(fe.endIdx, clockStr(fe.endRow))} 무렵 파울트러블(${fmtDuration(fe.durationSec)} 만에 반칙 ${fe.count}개 누적)에 걸려 코트를 비운 사이, <b>${teamTag(oppTcode, oppTname)}에게 ${runInfo.maxOppRun}점 연속 득점(런)</b>을 허용하며 뼈아픈 스노우볼이 되었습니다.</li>`);
    }
    if (foulItems.length) sections.push({ title: "파울 트러블 스노우볼 효과", html: `<ul class="report-list">${foulItems.join("")}</ul>` });
  }

  // 8.7 클러치 타임 현미경 (Clutch Time Anatomy) - 4쿼터 마지막 5분(elapsed>=2100) + 연장전
  // 전체(연장은 한 절이 5분뿐이라 "마지막 5분"이 곧 절 전체). 버그였던 지점: 예전엔
  // `quarter.startsWith('OT')`로 판정했는데 이 데이터셋의 연장 태그는 X1~X4/EQ1~EQ4라
  // "OT"로 시작하는 게 하나도 없다 - 실제로 3차 연장까지 간 경기 세 건(위 isOvertimeQuarter
  // 주석 참고)에서 연장전 전체가 이 절에서 빠지고 있었다.
  {
    const last5Events = events.filter((e) => (e.quarter === "Q4" && e.elapsed >= 2100) || isOvertimeQuarter(e.quarter));
    
    // Check if it was a clutch game (margin <= 5 at any point in last 5 mins)
    const isClutchGame = last5Events.some(e => Math.abs(e.home_score - e.away_score) <= 5);
    
    if (isClutchGame && last5Events.length > 0) {
       let hPts = 0, aPts = 0;
       let hFGA = 0, hFGM = 0, aFGA = 0, aFGM = 0;
       let hTO = 0, aTO = 0;
       
       for (const e of last5Events) {
         if (!e.tcode) continue;
         const isHome = e.tcode === homeTcode;
         const lbl = e.action_label || "";
         
         if (lbl.includes("성공")) {
            if (lbl.includes("3점슛")) { if (isHome) hPts += 3; else aPts += 3; }
            else if (lbl.includes("자유투")) { if (isHome) hPts += 1; else aPts += 1; }
            else if (lbl.includes("슛") || lbl.includes("팁인") || lbl.includes("덩크")) { if (isHome) hPts += 2; else aPts += 2; }
         }
         
         if (lbl.includes("슛") && !lbl.includes("자유투")) {
            if (isHome) hFGA++; else aFGA++;
            if (lbl.includes("성공")) { if (isHome) hFGM++; else aFGM++; }
         } else if (lbl.includes("팁인") || lbl.includes("덩크")) {
            if (isHome) hFGA++; else aFGA++;
            if (lbl.includes("성공")) { if (isHome) hFGM++; else aFGM++; }
         }
         
         if (lbl.includes("턴오버")) {
            if (isHome) hTO++; else aTO++;
         }
       }
       
       const hPct = hFGA > 0 ? Math.round((hFGM / hFGA) * 100) : 0;
       const aPct = aFGA > 0 ? Math.round((aFGM / aFGA) * 100) : 0;
       
       const items: string[] = [];
       items.push(`${liOpen(homeTcode)}${teamTag(homeTcode, homeTname)} - 클러치 구간 득점 <b>${hPts}점</b> (야투 ${hFGM}/${hFGA} <b>${hPct}%</b>), 턴오버 <b>${hTO}개</b></li>`);
       items.push(`${liOpen(awayTcode)}${teamTag(awayTcode, awayTname)} - 클러치 구간 득점 <b>${aPts}점</b> (야투 ${aFGM}/${aFGA} <b>${aPct}%</b>), 턴오버 <b>${aTO}개</b></li>`);
       
       // 요약 문구를 **클러치 구간 득점차만** 보고 골랐던 자리. 실측(S49G14N4): 8 대 10점이라
       // 세 번째 갈래로 떨어져 "한 치의 양보도 없는 팽팽한 혈투"가 나갔는데, 실제로는 종료
       // 49초 전 9점 차였고 야투 성공률이 33% 대 80%였다. 구간 득점이 비슷한 것과 승부가
       // 접전이었던 것은 다른 얘기라서, **끝날 때 실제로 몇 점 차였는지**를 같이 본다.
       const lastRow = last5Events[last5Events.length - 1];
       const finalGap = Math.abs(lastRow.home_score - lastRow.away_score);
       const tight = finalGap <= CLUTCH_TIGHT_MARGIN;
       let summary = "";
       if (hPts > aPts + 3) {
         summary = `${teamTag(homeTcode, homeTname)}${iGa(homeTname)} 승부처 득점에서 앞서며 경기를 가져갔습니다.`;
       } else if (aPts > hPts + 3) {
         summary = `${teamTag(awayTcode, awayTname)}${iGa(awayTname)} 승부처 득점에서 앞서며 경기를 가져갔습니다.`;
       } else if (tight) {
         summary = `양 팀이 승부처 득점(${hPts} 대 ${aPts})에서도, 최종 점수차(${finalGap}점)에서도 끝까지 맞섰습니다.`;
       } else {
         // 구간 득점은 비슷했지만 점수차가 이미 벌어져 있던 경우 - 접전이라고 부르지 않는다.
         // 숫자 바로 뒤에 조사를 붙이지 않는다(josa()는 한글이 아닌 글자에 받침 없는 쪽으로
         // 폴백해서 "10로"처럼 틀린 조사가 나온다 - 10은 '십'이라 '으로'여야 한다).
         summary = `승부처 득점(${hPts} 대 ${aPts})은 비슷했지만, 점수차가 이미 ${finalGap}점으로 벌어진 뒤라 흐름이 뒤집히지는 않았습니다.`;
       }
       
       sections.push({ 
         title: "클러치 타임 현미경 (종료 5분 전)", 
         html: `<p class="report-text">🔍 ${summary}</p><ul class="report-list">${items.join("")}</ul>` 
       });
    }
  }

  // 8.8 템포와 페이스 진단 (Pace & Transition Diagnostics)
  {
    // 포제션 추정식과 그 검증은 estimatePossessions()의 주석 참고. 임계값(75/67)은 그대로
    // 두되 40분 환산 페이스에만 적용한다 - 최근 4시즌 568경기의 공식 페이스로 재보면
    // 빠름 26% / 보통 60% / 느림 14%로 갈려 라벨이 실제로 구실을 한다(예전 원시 추정치
    // 기준으로는 빠름 58% / 느림 2.3%로 사실상 "빠름" 고정이었다).
    // game_team_stats.pace가 있으면 그걸 쓴다(8,444행 중 8,434행에 있음 - 2026-09-30 실측).
    // 추정은 아직 정산 전인 경기(방금 끝난 경기는 pace=0으로 들어온다 - S49 개막전들이 그랬다)
    // 폴백으로만 남긴다. 리포트가 "추정"이라고 쓰면서 옆 테이블은 공식값을 쓰는 상태를 없앤다.
    const officialPace = input.teamStats?.find((t) => (t.pace ?? 0) > 0)?.pace ?? null;
    const possEst = estimatePossessions(box, events, homeTcode, awayTcode);
    const avgPoss = Math.round(officialPace ?? possEst.pacePer40);
    const source = officialPace != null ? "공식 기록" : "추정";
    const otNote = officialPace == null && possEst.playedMin > 40 ? ` (연장 포함 ${Math.round(possEst.playedMin)}분 → 40분 환산)` : "";

    let paceLabel = "보통 (Average)";
    if (avgPoss >= 75) paceLabel = "빠름 (Up-Tempo)";
    else if (avgPoss <= 67) paceLabel = "느림 (Slow Pace)";

    // 예전엔 "끈적한 늪 농구" / "쉴 새 없이 달리는 난타전"처럼 임계값 한 개에 과장된 수사를
    // 붙였다. 75포제션은 최근 4시즌 기준 상위 26%지 '난타전'이 아니고, 이 경기는 78포제션에
    // 합계 170점·6점 차였다. 분포상 어디쯤인지만 말한다(위 임계값 주석의 실측 비율).
    const summary =
      avgPoss <= 67
        ? `최근 4시즌 기준 느린 쪽 14%에 해당하는 템포로, 하프코트 공격 비중이 컸습니다.`
        : avgPoss >= 75
          ? `최근 4시즌 기준 빠른 쪽 26%에 해당하는 템포였습니다.`
          : `최근 4시즌 경기의 60%가 속하는 보통 템포였습니다.`;

    sections.push({
      title: "템포와 페이스 진단 (Pace & Transition)",
      html: `<p class="report-text">🏃 <b>경기 페이스: 40분당 ${avgPoss} 포제션 (템포 ${paceLabel})</b>${otNote}<br/>${summary}</p><p class="report-caveat">${source} 기준.</p>`,
    });
  }

  // 8.9 에이스 정면승부 성적표 (Head-to-Head Duel)
  // 이 섹션만 문자열 HTML이 아니라 타입 있는 data로 내려보낸다(renderKit.ts의 ReportSection
  // 주석 참고) - 문장은 components/report/AceDuelSection.tsx가 JSX로 만든다. 계산은
  // report/aceDuel.ts.
  {
    const duel = computeAceDuel(
      segs,
      { team: homeTeam, star: topOf(homeTcode) },
      { team: awayTeam, star: topOf(awayTcode) }
    );
    if (duel) sections.push({ title: "에이스 정면승부 성적표 (Head-to-Head Duel)", data: duel });
  }

  // 8.10 주가 변동 리포트 (Player Stock Up & Down) - 선택 로직은 report/stockWatch.ts,
  // 문장은 components/report/StockWatchSection.tsx. 여기서는 후보만 채워 넘긴다.
  {
    // 게임스코어는 정렬 비교자 안에서 부르면 한 명의 점수가 O(log n)번 다시 계산된다 -
    // 한 번 재서 들고 간다(넘기기 전에 여기서 끝낸다).
    const stock = computeStockWatch(
      box.map((p) => ({
        pcode: p.pcode,
        team: metaOf(p.tcode),
        name: p.name,
        pts: p.pts,
        reb: p.reb,
        ast: p.ast,
        fgm: p.fgm,
        fga: p.fga,
        turnovers: p.turnovers,
        fouls: p.fouls,
        gameScore: gameScore(p),
      }))
    );
    if (stock) sections.push({ title: "주가 변동 리포트 (Stock Up & Down)", data: stock });
  }

  // 9. 역대 맞대결의 매듭 - 이 경기 이전까지 이어지던 맞대결 연승이 끊겼는지 이어졌는지.
  // getHeadToHead는 원래 전 맞대결을 받아 놓고 5경기만 쓰고 버렸다 - 그 행에서 연승만 더 센다.
  if (input.h2h?.streak && input.h2h.streak.length >= H2H_MIN_STREAK) {
    const st = input.h2h.streak;
    const nth = input.h2h.meetings + 1;
    const winnerTcode = homeWon ? homeTcode : awayTcode;
    const winnerName = homeWon ? homeTname : awayTname;
    const loserTcode = homeWon ? awayTcode : homeTcode;
    const loserName = homeWon ? awayTname : homeTname;
    const ws = homeWon ? homeScore : awayScore;
    const ls = homeWon ? awayScore : homeScore;
    let html: string;
    if (winnerTcode === st.winnerTcode) {
      html = `<p class="report-text">🔗 ${teamTag(winnerTcode, winnerName)}${iGa(winnerName)} ${ws}-${ls} 승리로 ${teamTag(loserTcode, loserName)} 상대 맞대결 연승을 <b>${st.length + 1}</b>로 늘림(역대 ${nth}번째 만남).</p>`;
    } else {
      const lastWin = input.h2h.lastWinDate[winnerTcode];
      html =
        `<p class="report-text">✂️ ${teamTag(winnerTcode, winnerName)}${iGa(winnerName)} ${ws}-${ls} 승리로 ${teamTag(loserTcode, loserName)} 상대 맞대결 <b>${st.length}연패</b>를 끊음` +
        (lastWin ? ` - 이 카드에서 ${teamTag(winnerTcode, winnerName)}${iGa(winnerName)} 마지막으로 이긴 건 ${lastWin}` : ` - 이 카드에서 ${teamTag(winnerTcode, winnerName)}의 첫 승`) +
        `(역대 ${nth}번째 만남).</p>`;
    }
    html += `<p class="report-caveat">정규시즌·플레이오프 전체 맞대결 기준.</p>`;
    sections.push({ title: "역대 맞대결의 매듭", html });
  }

  return sections;
}
