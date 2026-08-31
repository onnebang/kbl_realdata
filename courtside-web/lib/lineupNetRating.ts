import { supabase } from "./supabase";

// tools/build_synergy_matchup.py가 15시즌 전체 라인업 스틴트를 미리 집계해둔
// lineup_combo/player_onoff 테이블 조회. 조회 범위는 lib/gameLineups.ts의 subComboKeys로
// "이 경기에서 실제로 나온 조합"만 좁혀서 넘겨받음(전체 로스터 조합 폭발 방지).
export type LineupRating = { pcodes: string[]; n: number; minutes: number; stints: number; netRatingPer40: number };

export async function getLineupRatings(comboKeys: string[]): Promise<Map<string, LineupRating>> {
  if (!comboKeys.length) return new Map();
  const map = new Map<string, LineupRating>();
  // Supabase 1000행 cap - 이 경기 하나에서 나온 조합 수는 보통 수백 개뿐이라 청크 1개로도
  // 충분하지만, 만약을 대비해 다른 페이지들과 같은 관례(200개씩)로 청크.
  for (let i = 0; i < comboKeys.length; i += 200) {
    const chunk = comboKeys.slice(i, i + 200);
    const { data } = await supabase
      .from("lineup_combo")
      .select("combo_key, pcodes, n, minutes, stints, net_rating_per40")
      .in("combo_key", chunk);
    for (const r of data ?? []) {
      map.set(r.combo_key, { pcodes: r.pcodes, n: r.n, minutes: r.minutes, stints: r.stints, netRatingPer40: r.net_rating_per40 });
    }
  }
  return map;
}

// player_onoff - "코트 위" 패널의 선수별 온/오프 넷레이팅(요청, GameReplay.tsx). lineup_combo와
// 달리 조합이 아니라 선수 1인당 한 행(스키마는 Supabase MCP로 직접 확인: pcode, seconds,
// minutes, stints, pts_for, pts_against, net_rating_per40 - combo_key/n/pcodes 배열 없음).
// 스크럽 위치와 무관한 정적 값이라 page.tsx가 한 번만 조회해 prop으로 내려줌.
export type PlayerOnOff = { seconds: number; minutes: number; stints: number; ptsFor: number; ptsAgainst: number; netRatingPer40: number };

export async function getPlayerOnOffRatings(pcodes: string[]): Promise<Map<string, PlayerOnOff>> {
  if (!pcodes.length) return new Map();
  const map = new Map<string, PlayerOnOff>();
  for (let i = 0; i < pcodes.length; i += 200) {
    const chunk = pcodes.slice(i, i + 200);
    const { data } = await supabase
      .from("player_onoff")
      .select("pcode, seconds, minutes, stints, pts_for, pts_against, net_rating_per40")
      .in("pcode", chunk);
    for (const r of data ?? []) {
      map.set(r.pcode, {
        seconds: r.seconds,
        minutes: r.minutes,
        stints: r.stints,
        ptsFor: r.pts_for,
        ptsAgainst: r.pts_against,
        netRatingPer40: r.net_rating_per40,
      });
    }
  }
  return map;
}
