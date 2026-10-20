import { supabaseServer as supabase } from "./supabaseServer";
import { GAME_SELECT, getGameMvps, kstToday, type GameRow } from "./homeGames";
import { currentTeamName } from "./teamNames";
import { buildHeroPayload, type HeroPayload, type HeroRow } from "./fansiteHeroPayload";

// 팬사이트 메인 히어로용 조회 - 한 팀의 진행 중 / 지난 / 다가오는 경기. 변환은 lib/fansiteHeroPayload.ts.
// 쓰기 경로가 없고 읽는 값은 모두 이미 공개 화면에 나가는 것이다. 응답 전체는 CDN(s-maxage)과 팬사이트의
// 30초 캐시가 받아 주므로 여기서는 따로 캐시하지 않는다(getGameMvps만 자체 캐시를 갖는다).
const HERO_SELECT = `${GAME_SELECT}, stadium`;

const rows = (r: { data: unknown[] | null }) => (r.data ?? []) as unknown as HeroRow[];

/** 팀 코드의 경기 3종. 없는 팀 코드면 null, DB 오류는 그대로 던진다(라우트가 502로 바꾼다). */
export async function getHeroPayload(tcode: string): Promise<HeroPayload | null> {
  const today = kstToday();
  // 라이브는 자정을 넘길 수 있어 어제까지만 본다. 그보다 오래된 "진행 중" 행은 적재 누락이라 LIVE로 내보내지 않는다.
  const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
  const games = () => supabase.from("games").select(HERO_SELECT).or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`);

  const [team, live, last, upcoming] = await Promise.all([
    supabase.from("teams").select("tcode, name").eq("tcode", tcode).maybeSingle(),
    // 진행 중 = 점수가 있고 아직 안 끝남(lib/gameStatus.ts). 점수가 지금 바뀌고 있어 캐시하지 않는다.
    games()
      .not("home_score", "is", null)
      .eq("is_ended", false)
      .gte("game_date", yesterday)
      .order("game_date", { ascending: false })
      .order("gmkey", { ascending: false })
      .limit(1),
    games()
      .not("home_score", "is", null)
      .eq("is_ended", true)
      .order("game_date", { ascending: false })
      .order("gmkey", { ascending: false })
      .limit(1),
    // 기간 제한을 두지 않는다 - 휴식기에도 다음 경기가 나와야 한다(홈 목록의 14일 창과 다르다).
    games()
      .is("home_score", null)
      .gte("game_date", today)
      .order("game_date", { ascending: true })
      .order("game_start", { ascending: true })
      .order("gmkey", { ascending: true })
      .limit(2),
  ]);

  const teamRow = team.data as { tcode: string; name: string } | null;
  if (!teamRow) return null;

  const lastRow = rows(last)[0] ?? null;
  // getGameMvps는 종료 경기 하나의 박스스코어만 읽고 자체로 캐시한다(정산 전이면 빈 값 -> mvp null).
  const mvps = lastRow ? await getGameMvps([lastRow as unknown as GameRow]) : new Map();

  return buildHeroPayload({
    team: { tcode, name: currentTeamName(tcode, teamRow.name) },
    live: rows(live)[0] ?? null,
    last: lastRow,
    upcoming: rows(upcoming),
    mvps,
    now: new Date(),
  });
}
