import { supabase } from "./supabase";
import type { GameRarity } from "./postgameReport";

// PostgREST는 abs(home_score-away_score) 같은 계산식 필터를 지원하지 않아서(컬럼 값
// 비교만 가능) - 완료된 경기(4207행, 가벼움) 점수만 통째로 가져와 마진 백분위를 서버에서
// 직접 계산. courtside_template.html의 historical_rarity()가 하던 것과 같은 계산이지만,
// 거기는 Python 빌드 타임에 한 번 계산해 JSON에 박아 넣었던 것과 달리 여기는 요청마다
// 라이브로 계산(4207행이라 비용이 작아 괜찮음 - game_events 240만행 집계가 필요한
// wpaSwingRank와는 다름, 그건 이번 포팅 범위 밖).
export async function getGameRarity(homeScore: number, awayScore: number): Promise<GameRarity | null> {
  // PostgREST/supabase-js는 명시적 range 없이 select하면 프로젝트 기본 max_rows(1000)에서
  // 조용히 잘림 - games가 4207행이라 range 없이 그냥 fetch하면 1000행만 받고도 에러 없이
  // 성공한 것처럼 보여서(실측 중 발견 - "1000경기 중 14%"로 나와야 할 게 다른 값으로 나옴)
  // 페이지네이션으로 전부 받아야 함.
  const PAGE = 1000;
  const rows: { home_score: number; away_score: number }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("games")
      .select("home_score, away_score")
      .not("home_score", "is", null)
      .not("away_score", "is", null)
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    rows.push(...(data as { home_score: number; away_score: number }[]));
    if (data.length < PAGE) break;
  }
  if (!rows.length) return null;
  const margin = Math.abs(homeScore - awayScore);
  const total = rows.length;
  const atOrCloser = rows.filter((g) => Math.abs(g.home_score - g.away_score) <= margin).length;
  return { marginTotalGames: total, marginPercentile: atOrCloser / total };
}
