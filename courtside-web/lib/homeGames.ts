import { supabase } from "./supabase";
import { gameWideTopPerformer, type PlayerBox } from "./postgameReport";

// 홈 화면 경기 목록(app/page.tsx) 데이터 레이어 - 원래 page.tsx 안에 다 있었는데, 사용자
// 요청("예상 승률/MVP/AI 분석 배지 추가, 팀 목록은 시즌에 맞게")으로 쿼리가 늘어나서 분리.

export type TeamRef = { tcode: string; name: string; abbr: string; color: string; logo_url: string | null } | null;
export type GameRow = {
  gmkey: string;
  game_date: string;
  home_score: number | null;
  away_score: number | null;
  season_category: string;
  season_name: string;
  home_team: TeamRef;
  away_team: TeamRef;
};

export async function getSeasons(): Promise<string[]> {
  const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

// 요청: "25-26 시즌에 없던 팀은 안보이게, 각 시즌에 맞는 팀만" - 예전엔 teams 전체(13개,
// 고양 캐롯/오리온스처럼 개명·해체된 옛 이름 포함)를 항상 보여줬는데, 이 시즌에 실제로
// 뛴 팀만. home_tcode/away_tcode 양쪽 다 훑어야 해서 두 쿼리 UNION.
export async function getTeamsForSeason(seasonName: string): Promise<{ tcode: string; name: string }[]> {
  const { data } = await supabase
    .from("games")
    .select("home_tcode, away_tcode, home_team:teams!games_home_tcode_fkey(tcode, name), away_team:teams!games_away_tcode_fkey(tcode, name)")
    .eq("season_name", seasonName)
    .not("home_score", "is", null);
  const seen = new Map<string, string>();
  for (const g of data ?? []) {
    const h = g.home_team as unknown as { tcode: string; name: string } | null;
    const a = g.away_team as unknown as { tcode: string; name: string } | null;
    if (h) seen.set(h.tcode, h.name);
    if (a) seen.set(a.tcode, a.name);
  }
  return Array.from(seen.entries())
    .map(([tcode, name]) => ({ tcode, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

export async function getGames(seasonName: string | undefined, tcode: string | undefined): Promise<GameRow[]> {
  let query = supabase
    .from("games")
    .select(
      `gmkey, game_date, home_score, away_score, season_category, season_name,
       home_team:teams!games_home_tcode_fkey(tcode, name, abbr, color, logo_url),
       away_team:teams!games_away_tcode_fkey(tcode, name, abbr, color, logo_url)`
    )
    .not("home_score", "is", null)
    .order("game_date", { ascending: false })
    .limit(200);

  if (seasonName) query = query.eq("season_name", seasonName);
  if (tcode) query = query.or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as GameRow[];
}

// 예상 승률(요청: "양 팀의 예상 승률도 제공") - game_events의 첫 행(event_order=0,
// quarter='PRE', 0-0 스코어)이 바로 그 경기 시작 전 모델 예측값. 라이브 승률(경기 중
// 매 플레이마다 갱신되는 home_win_prob와 같은 컬럼이지만, 첫 행만 걸러서 "경기 전
// 예측"으로 씀 - 별도 예측 모델을 새로 만들 필요 없음.
export async function getPregameWinProbs(gmkeys: string[]): Promise<Map<string, number>> {
  if (!gmkeys.length) return new Map();
  const map = new Map<string, number>();
  for (let i = 0; i < gmkeys.length; i += 200) {
    const chunk = gmkeys.slice(i, i + 200);
    const { data } = await supabase.from("game_events").select("gmkey, home_win_prob").eq("event_order", 0).in("gmkey", chunk);
    for (const r of data ?? []) {
      if (r.home_win_prob != null) map.set(r.gmkey, r.home_win_prob);
    }
  }
  return map;
}

// MVP(요청: "MVP도 같이 표시") - lib/postgameReport.ts의 gameWideTopPerformer를 그대로
// 재사용(블로아웃 가드 포함, 새로 만들지 않음). game_player_stats.fgm/fga는 2점 전용이라
// (3점은 tpm/tpa) games/[gmkey]/page.tsx와 같은 방식으로 합산해서 넘김.
// 실측 버그(이 세션에서 다섯 번째로 걸림 - rarity/winContribution/scoringExplorer/
// formIndex에 이어) - 200경기 x 선수당 ~24행 ≈ 4800행인데 gmkey를 200개씩 묶기만 하고
// 응답 자체는 페이지네이션 안 해서 Supabase 기본 1000행 cap에 조용히 잘림(MVP가 200경기
// 중 42경기에서만 나타남). PAGE 단위로 .range() 페이지네이션 필수.
const PAGE = 1000;
export type GameMvp = { pcode: string; name: string; pts: number };
export async function getGameMvps(games: GameRow[]): Promise<Map<string, GameMvp>> {
  const gmkeys = games.map((g) => g.gmkey);
  if (!gmkeys.length) return new Map();

  const rowsByGmkey = new Map<string, PlayerBox[]>();
  for (let i = 0; i < gmkeys.length; i += 40) {
    const chunk = gmkeys.slice(i, i + 40);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("game_player_stats")
        .select(
          "gmkey, pcode, tcode, pts, reb, ast, stl, blk, turnovers, fouls, fgm, fga, tpm, tpa, ftm, fta, player:players(name)"
        )
        .in("gmkey", chunk)
        .range(from, from + PAGE - 1);
      if (error || !data || !data.length) break;
      for (const p of data) {
        const box: PlayerBox = {
          pcode: p.pcode,
          tcode: p.tcode,
          name: (p.player as unknown as { name: string } | null)?.name ?? p.pcode,
          is_starter: null,
          pts: p.pts ?? 0,
          fgm: (p.fgm ?? 0) + (p.tpm ?? 0),
          fga: (p.fga ?? 0) + (p.tpa ?? 0),
          ftm: p.ftm ?? 0,
          fta: p.fta ?? 0,
          reb: p.reb ?? 0,
          ast: p.ast ?? 0,
          stl: p.stl ?? 0,
          blk: p.blk ?? 0,
          fouls: p.fouls ?? 0,
          turnovers: p.turnovers ?? 0,
        };
        const list = rowsByGmkey.get(p.gmkey) ?? [];
        list.push(box);
        rowsByGmkey.set(p.gmkey, list);
      }
      if (data.length < PAGE) break;
    }
  }

  const result = new Map<string, GameMvp>();
  for (const g of games) {
    if (!g.home_team || !g.away_team || g.home_score == null || g.away_score == null) continue;
    const box = rowsByGmkey.get(g.gmkey);
    if (!box || !box.length) continue;
    const top = gameWideTopPerformer(box, g.home_score, g.away_score, g.home_team.tcode, g.away_team.tcode);
    if (top) result.set(g.gmkey, { pcode: top.pcode, name: top.name, pts: top.pts });
  }
  return result;
}

// AI 분석 배지(요청: "짜릿한 역전승, 압도적 승리, 통한의 패배 등등") - 라이브로 계산하면
// game_events(242만행) 전체를 매 홈 화면 로드마다 훑어야 해서(200경기 × 수백 이벤트)
// 너무 무거움 - Supabase 마이그레이션으로 한 번만 미리 계산해둔 game_summary_tags 테이블
// (경기당 "이 경기 도중 최대 몇 점 차까지 뒤집혔는지" vs "최종 스코어"를 시즌별로 집계)
// 에서 그냥 조회만.
export type GameTag = { key: string; label: string };
export async function getGameTags(gmkeys: string[]): Promise<Map<string, GameTag>> {
  if (!gmkeys.length) return new Map();
  const map = new Map<string, GameTag>();
  for (let i = 0; i < gmkeys.length; i += 200) {
    const chunk = gmkeys.slice(i, i + 200);
    const { data } = await supabase.from("game_summary_tags").select("gmkey, tag_key, tag_label").in("gmkey", chunk);
    for (const r of data ?? []) map.set(r.gmkey, { key: r.tag_key, label: r.tag_label });
  }
  return map;
}
