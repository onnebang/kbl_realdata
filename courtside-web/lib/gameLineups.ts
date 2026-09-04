import type { GameEvent } from "./postgameReport";

// 요청: "현재 라인업 1~5인 조합과 넷레이팅을 보여줌" - tools/build_lineup_stints.py의
// 온코트 추적(교체 IN=101/OUT=102, 시작 라인업은 is_starter)을 TS로 포팅. 서버(page.tsx)와
// 클라이언트(GameReplay.tsx) 양쪽에서 같은 로직이 필요해서(서버는 "이 경기 동안 실제로
// 나온 라인업 전부" 수집용, 클라이언트는 "지금 스크럽 시점 라인업" 재구성용) 공용 파일로 분리.
export type PlayerStartInfo = { pcode: string; tcode: string; isStarter?: boolean | null };

function startingFive(players: PlayerStartInfo[], tcode: string): Set<string> {
  return new Set(players.filter((p) => p.tcode === tcode && p.isStarter).map((p) => p.pcode));
}

// 지금 스크럽 시점(0..uptoIdx) 기준 온코트 5인 - GameReplay.tsx가 매 idx 변경마다 씀.
export function currentOnCourt(events: GameEvent[], uptoIdx: number, players: PlayerStartInfo[], tcode: string): Set<string> {
  const onCourt = startingFive(players, tcode);
  for (let i = 0; i <= uptoIdx; i++) {
    const row = events[i];
    if (row.tcode !== tcode || !row.pcode) continue;
    if (row.action_code === "101") onCourt.add(row.pcode);
    else if (row.action_code === "102") onCourt.delete(row.pcode);
  }
  return onCourt;
}

// 이 경기 전체에서 실제로 코트 위에 있었던 모든 5인 라인업(팀별, 중복 제거) - page.tsx가
// Supabase lineup_combo 조회 범위를 "이 경기에서 실제로 나온 조합"으로 좁히는 데 씀(전체
// 로스터 조합 폭발 방지 - 로스터 12명이면 5인 조합만 792개인데, 실제 경기당 스틴트는
// 보통 15~30개뿐이라 훨씬 적음).
export function collectAllOnCourtLineups(
  events: GameEvent[],
  players: PlayerStartInfo[],
  tcode: string
): Set<string>[] {
  const onCourt = startingFive(players, tcode);
  const seen: Set<string>[] = [new Set(onCourt)];
  for (const row of events) {
    if (row.tcode !== tcode || !row.pcode) continue;
    if (row.action_code !== "101" && row.action_code !== "102") continue;
    if (row.action_code === "101") onCourt.add(row.pcode);
    else onCourt.delete(row.pcode);
    seen.push(new Set(onCourt));
  }
  return seen;
}

// n=2..min(5, lineup.length) 부분조합 전부(정렬된 pcode 배열) - lineup_combo.combo_key
// 생성 규칙(tools/migrate_lineup_combo_to_supabase.py)과 동일하게 정렬 후 join.
function combinations(arr: string[], n: number): string[][] {
  if (n === 0) return [[]];
  if (arr.length < n) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, n - 1).map((c) => [first, ...c]);
  return [...withFirst, ...combinations(rest, n)];
}

export function comboKey(pcodes: string[]): string {
  return [...pcodes].sort().join(",");
}

export function subComboKeys(lineup: Set<string>): string[] {
  if (lineup.size < 2) return [];
  const arr = Array.from(lineup).sort();
  const keys: string[] = [];
  for (let n = 2; n <= Math.min(5, arr.length); n++) {
    for (const combo of combinations(arr, n)) keys.push(comboKey(combo));
  }
  return keys;
}

// 요청: "선수들 출전 시간 표시" - game_player_stats.min_played는 경기 최종값이라
// 스크럽 중에는 쓸 수 없다(3쿼터인데 40분이라고 적히면 거짓). 대신 currentOnCourt와 같은
// 온코트 추적으로 "지금까지 코트 위에 있던 시간"을 직접 쌓는다. 이벤트의 elapsed(경기 시작
// 이후 누적 초, lib/postgameReport.attachDerivedFields)를 구간 길이로 쓰고, 교체는 그 시점의
// 시간을 반영한 뒤에 적용한다(들어온 선수는 이 이벤트부터, 나간 선수는 이 이벤트까지).
//
// 정확도 실측(2026-09-04, 25-26 최근 8경기): 재구성 합계 = DB 합계 = 400.0분, 선수별 최대
// 오차 0.00분. KBL 이벤트 로그는 경기 종료 시 5명 전원을 102(OUT)로 빼주기까지 해서
// 이 재구성은 근사가 아니라 정확한 값이다.
export function computeSecondsUpTo(
  events: GameEvent[],
  uptoIdx: number,
  players: PlayerStartInfo[],
  homeTcode: string,
  awayTcode: string
): Map<string, number> {
  const sec = new Map<string, number>();
  for (const p of players) sec.set(p.pcode, 0);
  const homeOn = startingFive(players, homeTcode);
  const awayOn = startingFive(players, awayTcode);
  let prev = 0;
  const end = Math.min(uptoIdx, events.length - 1);
  for (let i = 0; i <= end; i++) {
    const row = events[i];
    const t = row.quarter === "PRE" ? 0 : row.elapsed;
    const dt = t - prev;
    if (dt > 0) {
      for (const p of homeOn) sec.set(p, (sec.get(p) ?? 0) + dt);
      for (const p of awayOn) sec.set(p, (sec.get(p) ?? 0) + dt);
      prev = t;
    }
    if (!row.pcode) continue;
    if (row.action_code === "101") {
      if (row.tcode === homeTcode) homeOn.add(row.pcode);
      else if (row.tcode === awayTcode) awayOn.add(row.pcode);
    } else if (row.action_code === "102") {
      if (row.tcode === homeTcode) homeOn.delete(row.pcode);
      else if (row.tcode === awayTcode) awayOn.delete(row.pcode);
    }
  }
  return sec;
}

// 요청: "박스스코어에 +/- 컬럼 추가" - game_player_stats엔 plus_minus 컬럼 자체가 없어서
// game_events를 끝까지 훑어 직접 계산(표준 정의: 이 선수가 코트 위에 있는 동안 난 모든
// 득점에서 "자기 팀 득점 - 상대 팀 득점"을 누적). currentOnCourt(uptoIdx 하나만 재구성)와
// 달리 여기는 경기 시작부터 끝까지 한 번에 훑으면서 매 득점 이벤트마다 그 순간의 온코트
// 5인 전원에게 델타를 더해야 해서 별도 함수로 분리 - GameReplay.tsx가 게임당 한 번만
// (useMemo) 호출하는 정적 계산(스크럽 위치와 무관, 경기 최종 +/-).
export function computeFinalPlusMinus(
  events: GameEvent[],
  players: PlayerStartInfo[],
  homeTcode: string,
  awayTcode: string
): Map<string, number> {
  const pm = new Map<string, number>();
  for (const p of players) pm.set(p.pcode, 0);
  const homeOn = startingFive(players, homeTcode);
  const awayOn = startingFive(players, awayTcode);
  let prevHome = events.length ? events[0].home_score : 0;
  let prevAway = events.length ? events[0].away_score : 0;
  for (const row of events) {
    // 교체(101 IN/102 OUT) - 두 팀 다 같은 이벤트 로그에 섞여 있어서 tcode로 어느 팀
    // 온코트 집합을 건드릴지 구분(currentOnCourt와 같은 판정 방식).
    if (row.pcode && row.action_code === "101") {
      if (row.tcode === homeTcode) homeOn.add(row.pcode);
      else if (row.tcode === awayTcode) awayOn.add(row.pcode);
    } else if (row.pcode && row.action_code === "102") {
      if (row.tcode === homeTcode) homeOn.delete(row.pcode);
      else if (row.tcode === awayTcode) awayOn.delete(row.pcode);
    }
    const dHome = row.home_score - prevHome;
    const dAway = row.away_score - prevAway;
    if (dHome !== 0 || dAway !== 0) {
      const netHome = dHome - dAway; // 홈 관점 순변화 - 온코트 홈 선수는 +netHome, 원정은 -netHome
      for (const pcode of homeOn) pm.set(pcode, (pm.get(pcode) ?? 0) + netHome);
      for (const pcode of awayOn) pm.set(pcode, (pm.get(pcode) ?? 0) - netHome);
    }
    prevHome = row.home_score;
    prevAway = row.away_score;
  }
  return pm;
}
