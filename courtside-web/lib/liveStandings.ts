// 실시간 리그 순위표(요청 2026-10-19: "지금 경기 중인 두 팀이 몇 등이고, 지금 결과면 몇 등까지 가는지") - 이 경기 전 순위에 지금 스코어를
// 결과로 더해 다시 줄 세운다. 정렬·게임차 규칙은 사이트 순위표(lib/matchups.ts computeStandings)가 이 파일의 standingsOrder/gamesBehind를
// 같이 써서 한 곳에만 있다. 순수 함수 - matchups.ts는 서버 전용 Supabase 클라이언트를 import하므로 클라이언트는 이 파일만 쓴다.

/** 순위 정렬 - 승률, 같으면 경기당 평균 득실마진. */
export const standingsOrder = (a: { pct: number; diff: number }, b: { pct: number; diff: number }) => b.pct - a.pct || b.diff - a.diff;

/**
 * 1위와의 게임차. 표시 순서는 승률로 정하지만 게임차 공식((승수차+패수차)/2)은 경기 수가 다르면 "2승0패"가 "1승0패"보다 공식상
 * 반게임 앞서는 역전이 생길 수 있다(둘 다 승률 100%) - 그 경우 음수가 나오므로 0으로 바닥을 깐다.
 */
export const gamesBehind = (leader: { wins: number; losses: number } | undefined, r: { wins: number; losses: number }) =>
  leader ? Math.max(0, (leader.wins - r.wins + (r.losses - leader.losses)) / 2) : 0;

/** 이 경기 전 한 팀의 순위표 재료(StandingsRow에서 투영에 필요한 것만 - 클라이언트로 보내는 양을 줄인다). */
export type BaseStanding = { tcode: string; wins: number; losses: number; pct: number; diff: number };

export type ProjectedStanding = BaseStanding & { rank: number; /** 이 경기 전 순위. 이 경기 전까지 경기가 없던 팀은 null. */ prevRank: number | null; gb: number };

/**
 * base(이 경기 전 순위, 정렬된 상태)에 이 경기 결과를 더한 순위. margin = 홈 득점 - 원정 득점이고, 0(동점·경기 전)이면 결과를 더하지 않는다.
 * 평균 득실마진(diff)도 이 경기 마진을 넣어 다시 평균 낸다. base에 없는 홈/원정 팀(시즌 첫 경기)은 0승 0패로 넣는다.
 */
export function projectStandings(base: BaseStanding[], home: string, away: string, margin: number): ProjectedStanding[] {
  const prev = new Map(base.map((r, i) => [r.tcode, i + 1]));
  const rows = base.map((r) => ({ ...r }));
  for (const t of [home, away]) if (!prev.has(t)) rows.push({ tcode: t, wins: 0, losses: 0, pct: 0, diff: 0 });
  if (margin !== 0) {
    for (const r of rows) {
      if (r.tcode !== home && r.tcode !== away) continue;
      const m = r.tcode === home ? margin : -margin;
      const n = r.wins + r.losses;
      if (m > 0) r.wins += 1;
      else r.losses += 1;
      r.diff = (r.diff * n + m) / (n + 1);
      r.pct = r.wins / (r.wins + r.losses);
    }
  }
  rows.sort(standingsOrder);
  return rows.map((r, i) => ({ ...r, rank: i + 1, prevRank: prev.get(r.tcode) ?? null, gb: gamesBehind(rows[0], r) }));
}
