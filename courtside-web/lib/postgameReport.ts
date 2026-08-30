import { eunNeun, iGa } from "./josa";

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
};

type RawGameEvent = Omit<GameEvent, "elapsed" | "runHome" | "runAway">;

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

export type ReportSection = { title: string; html: string };

const QUARTER_ORDER = ["Q1", "Q2", "Q3", "Q4", "X1", "X2", "X3", "X4", "EQ1", "EQ2", "EQ3", "EQ4"];
function quarterLenSec(q: string) {
  return q === "Q1" || q === "Q2" || q === "Q3" || q === "Q4" ? 600 : 300;
}
function cumulativeElapsed(q: string, m: number, s: number): number {
  const idx = QUARTER_ORDER.indexOf(q);
  let prior = 0;
  for (let i = 0; i < (idx === -1 ? QUARTER_ORDER.length : idx); i++) prior += quarterLenSec(QUARTER_ORDER[i]);
  return prior + (quarterLenSec(q) - (m * 60 + s));
}

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60),
    s = Math.round(sec % 60);
  return `${m}분${s > 0 ? " " + s + "초" : ""}`;
}
export function clockStr(e: Pick<GameEvent, "quarter" | "clock_min" | "clock_sec">): string {
  return `${e.quarter} ${e.clock_min}:${String(e.clock_sec).padStart(2, "0")}`;
}
export function fmtRating(r: number): string {
  return `${r > 0 ? "+" : ""}${r.toFixed(1)}`;
}

// PRE 행(quarter='PRE', clock_min/sec=null)은 elapsed=0 고정 - courtside_template.html에서
// cumulativeElapsedJs가 'PRE' 같은 미지의 쿼터 태그를 처리 못 해 경기 막판인 것처럼
// 잘못 계산되던 실측 버그를 이미 겪었음(35차 M3). 여기서는 애초에 안전한 값을 직접 넣고,
// 원본과 동일하게 시간 스캔 함수들에서는 PRE 행을 명시적으로 건너뜀(둘 다 같은 동작
// 유지 - 정적 페이지와 이 사이트 사이의 결과 차이를 만들지 않기 위해).
export function attachDerivedFields(rawEvents: RawGameEvent[]): GameEvent[] {
  const events: GameEvent[] = rawEvents.map((e) => ({ ...e, elapsed: 0, runHome: 0, runAway: 0 }));
  let homeRun = 0,
    awayRun = 0;
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
  }
  return events;
}

function marginRefAt(events: GameEvent[], targetElapsed: number): { margin: number; elapsed: number } {
  let best: GameEvent | null = null;
  for (const row of events) {
    if (row.quarter === "PRE") continue;
    if (row.elapsed <= targetElapsed) best = row;
    else break;
  }
  if (!best) return { margin: 0, elapsed: 0 };
  return { margin: best.home_score - best.away_score, elapsed: best.elapsed };
}

function computeSubSpark(
  events: GameEvent[],
  row: GameEvent,
  homeTcode: string
): { delta: number; beforeDur: number; afterDur: number } | null {
  const t0 = row.elapsed;
  const lastElapsed = events[events.length - 1].elapsed;
  if (t0 >= lastElapsed) return null;
  const beforeRef = marginRefAt(events, Math.max(0, t0 - 180));
  const atSub = marginRefAt(events, t0);
  const afterRef = marginRefAt(events, Math.min(t0 + 180, lastElapsed));
  const beforeDur = atSub.elapsed - beforeRef.elapsed;
  const afterDur = afterRef.elapsed - atSub.elapsed;
  if (beforeDur < 30 || afterDur < 30) return null;
  const netRtg = (marginChange: number, durSec: number) => (marginChange / durSec) * 2400;
  const sign = row.tcode === homeTcode ? 1 : -1;
  const before = sign * netRtg(atSub.margin - beforeRef.margin, beforeDur);
  const after = sign * netRtg(afterRef.margin - atSub.margin, afterDur);
  return { delta: after - before, beforeDur, afterDur };
}

const MAKE_CODES = new Set(["201", "205", "207"]);
const REB_CODES = new Set(["209", "210"]);
const PERSONAL_FOUL_CODES = new Set(["215", "216", "224"]);
const SUB_IN_CODE = "101";

type Burst = { key: string; count: number; startIdx: number; endIdx: number; startRow: GameEvent; endRow: GameEvent; durationSec: number };

function findStatBursts(events: GameEvent[], codes: Set<string>, windowSec: number, minCount: number): Burst[] {
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
function computeStatBursts(events: GameEvent[]): (Burst & { label: string })[] {
  const out: (Burst & { label: string })[] = [];
  for (const def of STAT_BURST_DEFS) {
    for (const b of findStatBursts(events, def.codes, def.windowSec, def.minCount)) out.push({ ...b, label: def.label });
  }
  return out;
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
  const isLateClutch = (row.quarter === "Q4" || row.quarter.startsWith("X")) && (row.clock_min ?? 99) < 3;
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
function gameScore(b: PlayerBox): number {
  return (
    b.pts + 0.4 * b.fgm - 0.7 * b.fga - 0.4 * (b.fta - b.ftm) + 0.4 * b.reb +
    b.stl + 0.7 * b.ast + 0.7 * b.blk - 0.4 * b.fouls - b.turnovers
  );
}

function involved(b: PlayerBox): boolean {
  return b.fga + b.fta + b.ast + b.reb > 0;
}

function teamTopPerformer(box: PlayerBox[], tcode: string): PlayerBox | null {
  let top: PlayerBox | null = null;
  for (const b of box) {
    if (b.tcode !== tcode || !involved(b)) continue;
    if (!top || gameScore(b) > gameScore(top)) top = b;
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
  for (const b of box) {
    if (!involved(b)) continue;
    if (blowout && b.tcode !== leaderTcode) continue;
    if (!top || gameScore(b) > gameScore(top)) top = b;
  }
  return top;
}

function sumTeam(box: PlayerBox[], tcode: string, fn: (b: PlayerBox) => number): number {
  let s = 0;
  for (const b of box) if (b.tcode === tcode) s += fn(b);
  return s;
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
  if (worstQ && worstDelta <= -8) reasons.push(`${worstQ} 쿼터에서만 ${Math.abs(worstDelta)}점 열세`);

  const benchPts = (tcode: string) => box.filter((b) => b.tcode === tcode && b.is_starter === false).reduce((s, b) => s + b.pts, 0);
  const wBench = benchPts(winnerTcode),
    lBench = benchPts(loserTcode);
  if (wBench - lBench >= 10) reasons.push(`벤치 득점 격차(${wBench}점 vs ${lBench}점)`);

  void awayTcode;
  return reasons;
}

const SUB_SPARK_MIN_SAMPLE_SEC = 120;
const SUB_SPARK_NOTABLE_THRESHOLD = 120; // courtside_template.html 실측(120초+ 표본 784건 중앙값 52, 상위10% 148)과 동일 기준

function findBestSixthManSpark(
  events: GameEvent[],
  box: PlayerBox[],
  homeTcode: string
): { row: GameEvent; pcode: string; spark: { delta: number } } | null {
  const boxByPcode = new Map(box.map((b) => [b.pcode, b]));
  let best: { row: GameEvent; pcode: string; spark: { delta: number } } | null = null;
  for (let i = 1; i < events.length; i++) {
    const row = events[i];
    if (row.action_code !== SUB_IN_CODE || !row.pcode) continue;
    const p = boxByPcode.get(row.pcode);
    if (!p || p.is_starter !== false) continue;
    const spark = computeSubSpark(events, row, homeTcode);
    if (!spark || spark.delta <= 0) continue;
    if (spark.beforeDur < SUB_SPARK_MIN_SAMPLE_SEC || spark.afterDur < SUB_SPARK_MIN_SAMPLE_SEC) continue;
    if (!best || spark.delta > best.spark.delta) best = { row, pcode: row.pcode, spark };
  }
  return best;
}

function findNotableSubSparks(events: GameEvent[], homeTcode: string): { row: GameEvent; pcode: string; spark: { delta: number } }[] {
  const out: { row: GameEvent; pcode: string; spark: { delta: number } }[] = [];
  for (let i = 1; i < events.length; i++) {
    const row = events[i];
    if (row.action_code !== SUB_IN_CODE || !row.pcode) continue;
    const spark = computeSubSpark(events, row, homeTcode);
    if (!spark) continue;
    if (spark.beforeDur < SUB_SPARK_MIN_SAMPLE_SEC || spark.afterDur < SUB_SPARK_MIN_SAMPLE_SEC) continue;
    if (Math.abs(spark.delta) >= SUB_SPARK_NOTABLE_THRESHOLD) out.push({ row, pcode: row.pcode, spark });
  }
  return out;
}

export type BuildReportInput = {
  events: GameEvent[]; // event_order 오름차순, attachDerivedFields() 이미 적용된 것
  box: PlayerBox[]; // game_player_stats(이 경기 최종 박스스코어)
  homeTcode: string;
  awayTcode: string;
  homeTname: string;
  awayTname: string;
  homeScore: number;
  awayScore: number;
  rarity: GameRarity | null;
};

export function buildPostgameReport(input: BuildReportInput): ReportSection[] {
  const { events, box, homeTcode, awayTcode, homeTname, awayTname, homeScore, awayScore, rarity } = input;
  const homeWon = homeScore > awayScore;
  const winnerTcode = homeWon ? homeTcode : awayTcode;
  const loserTcode = homeWon ? awayTcode : homeTcode;
  const winnerTname = homeWon ? homeTname : awayTname;
  const loserTname = homeWon ? awayTname : homeTname;
  const winnerScore = homeWon ? homeScore : awayScore;
  const loserScore = homeWon ? awayScore : homeScore;
  const preActPct = Math.round((events[0]?.home_win_prob ?? 0.5) * 100);

  const sections: ReportSection[] = [];

  // 1. 경기 결과 + 예측 적중/실패 + 마진 희귀도
  {
    const predictedWinner = preActPct >= 50 ? homeTname : awayTname;
    const predictionCorrect = predictedWinner === winnerTname;
    const predictedWinnerPct = predictedWinner === homeTname ? preActPct : 100 - preActPct;
    let html =
      `<p class="report-text">최종 스코어 <b>${winnerTname} ${winnerScore} : ${loserScore} ${loserTname}</b>. 예측은 <b>${predictionCorrect ? "적중" : "빗나감"}</b>` +
      (predictionCorrect
        ? ` - 경기 전 ${predictedWinner}${iGa(predictedWinner)} 이길 확률을 ${predictedWinnerPct}%로 더 높게 봤고, 실제로 그대로 됨.`
        : ` - 경기 전엔 ${predictedWinner}${iGa(predictedWinner)} 더 유력했지만(${predictedWinnerPct}%), 실제로는 ${winnerTname}${iGa(winnerTname)} 이김. 확률 예측은 100% 확신이 아니라 "이 정도 비율로 이런 결과가 나온다"는 뜻이라, 이런 이변도 정상적인 범위임.`) +
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

  // 2. 팀별 스포트라이트 + 최고 활약이 패배로 이어진 이유
  {
    const winnerTop = teamTopPerformer(box, winnerTcode);
    const loserTop = teamTopPerformer(box, loserTcode);
    let html = "";
    if (winnerTop) {
      html += `<p class="report-text">🏆 <b>${winnerTname}</b> 스포트라이트 - ${winnerTop.name} ${winnerTop.pts}점 ${winnerTop.fgm}/${winnerTop.fga}, ${winnerTop.ast}AST ${winnerTop.reb}REB.</p>`;
    }
    if (loserTop) {
      html += `<p class="report-text">🥈 <b>${loserTname}</b> 스포트라이트 - ${loserTop.name} ${loserTop.pts}점 ${loserTop.fgm}/${loserTop.fga}, ${loserTop.ast}AST ${loserTop.reb}REB.</p>`;
    }
    const overallMvp = gameWideTopPerformer(box, homeScore, awayScore, homeTcode, awayTcode);
    if (overallMvp && overallMvp.tcode === loserTcode) {
      const reasons = explainLosingDespiteTopPerformer(events, box, winnerTcode, loserTcode, homeTcode, awayTcode);
      if (reasons.length) {
        html += `<p class="report-text">최고 활약(${overallMvp.name})에도 <b>${loserTname}</b>${eunNeun(loserTname)} 진 이유 - ${reasons.join(", ")}.</p>`;
      }
    }
    if (html) sections.push({ title: "팀별 스포트라이트", html });
  }

  // 3. 결정적 장면들
  const topSwings = findTopWpaSwings(events, 3);
  if (topSwings.length) {
    const items = topSwings
      .map((s) => {
        const row = s.row;
        const beforeProb = s.idx > 0 ? Math.round((events[s.idx - 1].home_win_prob ?? 0.5) * 100) : preActPct;
        const afterProb = Math.round((row.home_win_prob ?? 0.5) * 100);
        const beneficiary = (row.wpa_home ?? 0) > 0 ? homeTname : awayTname;
        return `<li>${clockStr(row)}, ${row.home_score}-${row.away_score} 상황 ${row.player_name}의 ${row.action_label} - 승률 ${beforeProb}%→${afterProb}%, ${beneficiary}${eunNeun(beneficiary)} 유리해짐.</li>`;
      })
      .join("");
    sections.push({ title: "결정적 장면들", html: `<ul class="report-list">${items}</ul>` });
  }

  // 4. AI 선정 베스트 장면
  {
    const excludeIdx = new Set(topSwings.map((s) => s.idx));
    const best = findAiPickBestScene(events, excludeIdx);
    if (best) {
      sections.push({
        title: "AI 선정 베스트 장면",
        html: `<p class="report-text">✨ ${clockStr(best.row)}, ${best.row.player_name}의 ${best.row.action_label} - 이 경기에서 가장 짜릿했던 순간.</p>`,
      });
    }
  }

  // 5. 극적인 흐름
  {
    const dramatic = findDramaticProbSwing(events);
    if (dramatic) {
      const fromRow = events[dramatic.startIdx],
        toRow = events[dramatic.endIdx];
      const fromPct = Math.round((fromRow.home_win_prob ?? 0.5) * 100),
        toPct = Math.round((toRow.home_win_prob ?? 0.5) * 100);
      const beneficiary = dramatic.delta > 0 ? homeTname : awayTname;
      sections.push({
        title: "극적인 흐름",
        html:
          `<p class="report-text">⚡ ${clockStr(fromRow)}부터 ${clockStr(toRow)}까지, 단 ${fmtDuration(dramatic.durationSec)} 만에 승률이 ${fromPct}%에서 ${toPct}%로 요동침 - ` +
          `${beneficiary}${iGa(beneficiary)} 이 짧은 구간에 경기 흐름을 완전히 뒤집어놓음.</p>`,
      });
    }
  }

  // 6. 이 경기의 식스맨
  {
    const sixthMan = findBestSixthManSpark(events, box, homeTcode);
    if (sixthMan) {
      const p = box.find((b) => b.pcode === sixthMan.pcode);
      sections.push({
        title: "이 경기의 식스맨",
        html: `<p class="report-text">🔋 <b>${p?.name ?? ""}</b>${iGa(p?.name ?? "")} ${clockStr(sixthMan.row)} 투입된 뒤 팀 흐름이 확실히 좋아짐(넷레이팅 변화 ${fmtRating(sixthMan.spark.delta)}) - 이 경기 최고의 벤치 임팩트.</p>`,
      });
    }
  }

  // 7. 스탯 폭발
  {
    const bursts = computeStatBursts(events);
    if (bursts.length) {
      const boxByPcode = new Map(box.map((b) => [b.pcode, b]));
      const items = bursts
        .map((b) => {
          const p = boxByPcode.get(b.key);
          const name = p?.name ?? b.key;
          return `<li>${name}${iGa(name)} ${b.label} ${b.count}개를 ${fmtDuration(b.durationSec)} 만에 몰아침(${clockStr(b.startRow)}~${clockStr(b.endRow)}).</li>`;
        })
        .join("");
      sections.push({ title: "스탯 폭발", html: `<ul class="report-list">${items}</ul>` });
    }
  }

  // 8. 교체·파울트러블 연관 분석
  {
    const boxByPcode = new Map(box.map((b) => [b.pcode, b]));
    const items: string[] = [];
    const notableSubs = findNotableSubSparks(events, homeTcode)
      .sort((a, b) => Math.abs(b.spark.delta) - Math.abs(a.spark.delta))
      .slice(0, 2);
    for (const s of notableSubs) {
      const name = boxByPcode.get(s.pcode)?.name ?? "";
      const dir = s.spark.delta > 0 ? "좋아짐" : "나빠짐";
      items.push(`<li>${name}${iGa(name)} ${clockStr(s.row)} 투입된 뒤 팀 흐름이 뚜렷하게 ${dir}(넷레이팅 변화 ${fmtRating(s.spark.delta)}).</li>`);
    }
    for (const fe of findFoulTroubleEvents(events)) {
      const runInfo = checkOpponentRunAfterFoulTrouble(events, fe, homeTcode);
      if (!runInfo) continue;
      const name = boxByPcode.get(fe.key)?.name ?? "";
      items.push(`<li>${name}${iGa(name)} ${clockStr(fe.endRow)} 무렵 파울트러블(${fmtDuration(fe.durationSec)} 만에 파울 ${fe.count}개)에 걸린 뒤, 상대가 ${runInfo.maxOppRun}점 런을 탐.</li>`);
    }
    if (items.length) sections.push({ title: "교체·파울트러블 연관 분석", html: `<ul class="report-list">${items.join("")}</ul>` });
  }

  return sections;
}
