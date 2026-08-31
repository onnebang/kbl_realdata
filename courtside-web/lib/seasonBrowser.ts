import { supabase } from "./supabase";
import { displayTeamName } from "./teamNames";

// 시즌 브라우저(app/season-browser) 데이터 레이어 - web/season_browser_template.html 포팅.
// 원본 정적 템플릿은 한 시즌(283경기) 전체의 게임목록+박스스코어를 미리 구운 JSON
// (SEASON.gameList/SEASON.games)으로 통째로 박아넣었지만, 여기서는 라이브 Supabase가
// 원칙이라 두 단계로 나눔:
//  1) 이 파일의 getSeasonGames() - 목록 화면에 필요한 가벼운 경기 목록만 서버에서 미리
//     로드(최대 ~290행, 팀 조인 포함해도 가벼움).
//  2) 박스스코어(쿼터별 스코어+팀스탯+양팀 전체 선수 기록)는 모달을 열 때만
//     app/api/season-browser/box-score/route.ts에서 그 경기 하나만 조회.
// 쿼터별 스코어는 game_team_stats에 쿼터 컬럼이 없어서(컬럼 목록 확인 완료) game_events
// 쿼터 경계 이벤트로 계산해야 하는데, 시즌 전체(경기당 평균 580행 x ~283경기 ≈ 16만행)를
// 목록 로드 시점에 다 끌어오면 초기 페이지가 너무 무거워짐 - 경기 1개당 event가 항상
// 1000행 미만(실측 최대 880행)이라 모달을 열 때 그 경기만 조회하면 페이지네이션 없이
// 안전하고, 목록 화면은 최초 로드 때 계속 가벼운 채로 유지됨. (courtside-web README의
// "1000행 cap" 함정과 별개로, 여기선 조회 단위를 경기 1개로 좁혀서 애초에 cap에 걸릴
// 일이 없게 설계.)

export type SeasonTeamRef = {
  tcode: string;
  name: string;
  abbr: string;
  color: string;
  logo_url: string | null;
} | null;

export type SeasonGameRow = {
  gmkey: string;
  game_date: string;
  home_score: number | null;
  away_score: number | null;
  season_category: string;
  home_team: SeasonTeamRef;
  away_team: SeasonTeamRef;
};

export async function getSeasons(): Promise<string[]> {
  const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

export async function getSeasonGames(seasonName: string): Promise<SeasonGameRow[]> {
  const { data, error } = await supabase
    .from("games")
    .select(
      `gmkey, game_date, home_score, away_score, season_category,
       home_team:teams!games_home_tcode_fkey(tcode, name, abbr, color, logo_url),
       away_team:teams!games_away_tcode_fkey(tcode, name, abbr, color, logo_url)`
    )
    .eq("season_name", seasonName)
    .not("home_score", "is", null)
    .order("game_date", { ascending: true })
    .order("gmkey", { ascending: true })
    .limit(1000);
  if (error) throw error;
  const rows = (data ?? []) as unknown as SeasonGameRow[];
  // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - seasonName은 이미 이 함수의
  // 인자로 알고 있으니 그대로 덮어씀.
  for (const g of rows) {
    if (g.home_team) g.home_team.name = displayTeamName(g.home_team.tcode, g.home_team.name, seasonName);
    if (g.away_team) g.away_team.name = displayTeamName(g.away_team.tcode, g.away_team.name, seasonName);
  }
  return rows;
}

// "2025-2026" -> "2025-26" (템플릿 타이틀 "2025-26 시즌 브라우저" 형식 그대로).
export function formatSeasonShort(seasonName: string): string {
  const [y1, y2] = seasonName.split("-");
  if (!y2) return seasonName;
  return `${y1}-${y2.slice(2)}`;
}
