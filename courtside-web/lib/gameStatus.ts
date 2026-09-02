// 경기 상태 3분류(Phase 0, 라이브 대비) - 홈 목록(lib/homeGames.ts + app/page.tsx)과
// 경기 페이지(app/games/[gmkey]/page.tsx)가 반드시 이 하나의 정의만 쓰도록 분리.
// 규칙(DB games 테이블과 1:1):
//   예정(scheduled)  = home_score IS NULL          (스코어 자체가 아직 없음)
//   진행중(live)     = 스코어 있음 + is_ended=false (라이브 적재가 스코어를 갱신 중)
//   종료(final)      = is_ended = true
// 스코어부터 보고 is_ended는 그 다음 - 예정 행도 is_ended=false로 들어오므로
// (tools/sync_upcoming_games.py) is_ended만으로는 예정/진행중을 구분할 수 없음.
export type GameStatus = "scheduled" | "live" | "final";

export function deriveGameStatus(game: { home_score: number | null; is_ended: boolean }): GameStatus {
  if (game.home_score == null) return "scheduled";
  if (!game.is_ended) return "live";
  return "final";
}
