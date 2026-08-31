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
