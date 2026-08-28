import { supabase } from "./supabase";

// "승리 기여도 리더보드" 아티팩트(claude.ai/code/artifact/97168d9d...) 포팅. 원본은
// Python으로 미리 계산해 정적 HTML에 박아넣은 스냅샷(LB_DATA.bySeason)이었지만, 여기는
// player_season_wpa(Supabase MCP로 새로 만든 사전집계 테이블 - game_events.wpa_home을
// 시즌별로 합산, 실측으로 원본 아티팩트 값과 정확히 일치 확인됨: 크리스 윌리엄스
// 2011-2012 totalWpa=32.994 등)를 라이브로 조회.
export type WpaRow = {
  pcode: string;
  playerName: string;
  tcode: string;
  teamName: string;
  teamAbbr: string;
  teamColor: string;
  teamLogoUrl: string | null;
  games: number;
  plays: number;
  totalWpa: number;
  posWpa: number;
  negWpa: number;
  wpaPerGame: number;
};

export type SortKey = "totalWpa" | "wpaPerGame" | "posWpa" | "negWpa" | "games" | "plays";

// 테이블이 2591행이라 range 없이 select하면 Supabase 기본 max_rows(1000)에 조용히
// 잘림(rarity.ts의 getGameRarity에서 이미 한 번 겪은 버그와 동일 원인) - pcode 오름차순이
// 기본 정렬이라 앞쪽 1000행만 오면 시즌 15개 중 일부만(그것도 무작위로) 보임. 페이지네이션.
export async function getSeasonsWithWpaData(): Promise<string[]> {
  const PAGE = 1000;
  const set = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("player_season_wpa").select("season_name").range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    for (const r of data) set.add(r.season_name as string);
    if (data.length < PAGE) break;
  }
  return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
}

export async function getWinContributionLeaderboard(seasonName: string, sortKey: SortKey = "totalWpa", ascending = false): Promise<WpaRow[]> {
  const { data, error } = await supabase
    .from("player_season_wpa")
    .select(
      `pcode, tcode, games, plays, total_wpa, pos_wpa, neg_wpa, wpa_per_game,
       player:players(name),
       team:teams(name, abbr, color, logo_url)`
    )
    .eq("season_name", seasonName)
    .order(sortKey === "totalWpa" ? "total_wpa" : sortKey === "wpaPerGame" ? "wpa_per_game" : sortKey === "posWpa" ? "pos_wpa" : sortKey === "negWpa" ? "neg_wpa" : sortKey, {
      ascending,
    });
  // 실측 버그: player_season_wpa엔 pcode/tcode가 그냥 컬럼이었지 FK가 아니어서(나중에
  // 추가함) PostgREST의 임베드 조인(player:players(...))이 조용히 실패 - {data} 구조분해만
  // 하고 error를 안 봐서 화면엔 그냥 "0명"으로만 보였음. 앞으로 이런 임베드 select는 꼭
  // error를 확인.
  if (error || !data) return [];
  return data.map((r) => {
    const player = r.player as unknown as { name: string } | null;
    const team = r.team as unknown as { name: string; abbr: string; color: string; logo_url: string | null } | null;
    return {
      pcode: r.pcode,
      playerName: player?.name ?? r.pcode,
      tcode: r.tcode,
      teamName: team?.name ?? r.tcode,
      teamAbbr: team?.abbr ?? r.tcode,
      teamColor: team?.color ?? "#5b5f6e",
      teamLogoUrl: team?.logo_url ?? null,
      games: r.games,
      plays: r.plays,
      totalWpa: r.total_wpa,
      posWpa: r.pos_wpa,
      negWpa: r.neg_wpa,
      wpaPerGame: r.wpa_per_game,
    };
  });
}
