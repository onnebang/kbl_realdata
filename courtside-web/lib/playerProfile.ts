import { supabase } from "./supabase";

// 선수 프로필(README "다음 단계" 세 번째, 새 /players/[pcode] 라우트) - 커리어 스탯을
// 시즌별로 집계. PostgREST가 GROUP BY 집계를 직접 지원하지 않아서(단순 select라)
// game_player_stats를 이 선수 pcode로 전부 받아 시즌별로 JS에서 묶음 - idx_gps_pcode
// 인덱스가 있어서 필터 자체는 빠름. 커리어가 긴 선수(15시즌치)는 1000행 기본 제한을 넘을
// 수 있어 rarity.ts와 같은 방식으로 페이지네이션.

export type PlayerInfo = { pcode: string; name: string; ename: string | null; photoUrl: string | null };

export type SeasonLine = {
  seasonName: string;
  tcode: string;
  teamName: string;
  gp: number;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  fgPct: number | null;
  tpPct: number | null;
  ftPct: number | null;
};

export type GameLogRow = {
  gmkey: string;
  gameDate: string;
  oppTcode: string;
  oppName: string;
  isHome: boolean;
  min: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
  teamScore: number;
  oppScore: number;
  win: boolean;
};

export async function getPlayerInfo(pcode: string): Promise<PlayerInfo | null> {
  const { data } = await supabase.from("players").select("pcode, name, ename, photo_url").eq("pcode", pcode).maybeSingle();
  if (!data) return null;
  return { pcode: data.pcode, name: data.name, ename: data.ename, photoUrl: data.photo_url };
}

type RawStatRow = {
  gmkey: string;
  tcode: string;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  fgm: number | null;
  fga: number | null;
  tpm: number | null;
  tpa: number | null;
  ftm: number | null;
  fta: number | null;
};

async function fetchAllPlayerStats(pcode: string): Promise<RawStatRow[]> {
  const PAGE = 1000;
  const rows: RawStatRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("game_player_stats")
      .select("gmkey, tcode, pts, reb, ast, stl, blk, fgm, fga, tpm, tpa, ftm, fta")
      .eq("pcode", pcode)
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    rows.push(...(data as RawStatRow[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

export async function getPlayerCareerBySeason(pcode: string): Promise<{ seasons: SeasonLine[]; careerGp: number }> {
  const statRows = await fetchAllPlayerStats(pcode);
  if (!statRows.length) return { seasons: [], careerGp: 0 };

  const gmkeys = statRows.map((r) => r.gmkey);
  const gameMeta = new Map<string, { seasonName: string; homeTcode: string; awayTcode: string }>();
  for (let i = 0; i < gmkeys.length; i += 1000) {
    const { data } = await supabase
      .from("games")
      .select("gmkey, season_name, home_tcode, away_tcode")
      .in("gmkey", gmkeys.slice(i, i + 1000));
    for (const g of data ?? []) gameMeta.set(g.gmkey, { seasonName: g.season_name, homeTcode: g.home_tcode, awayTcode: g.away_tcode });
  }

  const { data: teams } = await supabase.from("teams").select("tcode, name");
  const teamNameByTcode = new Map((teams ?? []).map((t) => [t.tcode, t.name]));

  const bySeasonTeam = new Map<string, RawStatRow[]>();
  for (const r of statRows) {
    const meta = gameMeta.get(r.gmkey);
    if (!meta) continue;
    const key = `${meta.seasonName}__${r.tcode}`;
    (bySeasonTeam.get(key) ?? bySeasonTeam.set(key, []).get(key)!).push(r);
  }

  const seasons: SeasonLine[] = Array.from(bySeasonTeam.entries())
    .map(([key, rows]) => {
      const [seasonName, tcode] = key.split("__");
      const gp = rows.length;
      const sum = (fn: (r: RawStatRow) => number) => rows.reduce((s, r) => s + fn(r), 0);
      const fgm = sum((r) => r.fgm ?? 0),
        fga = sum((r) => r.fga ?? 0);
      const tpm = sum((r) => r.tpm ?? 0),
        tpa = sum((r) => r.tpa ?? 0);
      const ftm = sum((r) => r.ftm ?? 0),
        fta = sum((r) => r.fta ?? 0);
      return {
        seasonName,
        tcode,
        teamName: teamNameByTcode.get(tcode) ?? tcode,
        gp,
        ppg: sum((r) => r.pts ?? 0) / gp,
        rpg: sum((r) => r.reb ?? 0) / gp,
        apg: sum((r) => r.ast ?? 0) / gp,
        spg: sum((r) => r.stl ?? 0) / gp,
        bpg: sum((r) => r.blk ?? 0) / gp,
        fgPct: fga > 0 ? fgm / fga : null,
        tpPct: tpa > 0 ? tpm / tpa : null,
        ftPct: fta > 0 ? ftm / fta : null,
      };
    })
    .sort((a, b) => (a.seasonName < b.seasonName ? 1 : -1));

  return { seasons, careerGp: statRows.length };
}

// 주의: PostgREST의 .order(col, {referencedTable})는 "임베드된 1:N 배열 안의 순서"만
// 정렬함 - game_player_stats(N) -> games(1) 같은 N:1 관계에서 "부모(game_player_stats)
// 행 자체를 자식(games) 컬럼 기준으로 정렬"하는 용도가 아님(실측 - 이 순서로 짜서 처음엔
// 최근 경기가 아니라 사실상 무작위/삽입 순서가 나왔음). games를 FROM으로 두고
// game_player_stats를 N:1의 반대 방향(1:N, 이 선수 pcode로 필터한 임베드)으로 붙이면
// game_date가 games 테이블 자체의 네이티브 컬럼이라 정상적으로 정렬됨.
export async function getPlayerRecentGames(pcode: string, limit = 15): Promise<GameLogRow[]> {
  const { data } = await supabase
    .from("games")
    .select(
      `gmkey, game_date, home_tcode, away_tcode, home_score, away_score,
       home_team:teams!games_home_tcode_fkey(tcode, name),
       away_team:teams!games_away_tcode_fkey(tcode, name),
       game_player_stats!inner(pcode, tcode, min_played, pts, reb, ast, stl, blk, fgm, fga, tpm, tpa, ftm, fta)`
    )
    .eq("game_player_stats.pcode", pcode)
    .order("game_date", { ascending: false })
    .limit(limit);
  if (!data) return [];
  return data.map((row) => {
    const stat = (row.game_player_stats as unknown as { tcode: string; min_played: number | null; pts: number | null; reb: number | null; ast: number | null; stl: number | null; blk: number | null; fgm: number | null; fga: number | null; tpm: number | null; tpa: number | null; ftm: number | null; fta: number | null }[])[0];
    const homeTeam = row.home_team as unknown as { tcode: string; name: string } | null;
    const awayTeam = row.away_team as unknown as { tcode: string; name: string } | null;
    const isHome = stat.tcode === row.home_tcode;
    return {
      gmkey: row.gmkey as string,
      gameDate: row.game_date as string,
      oppTcode: isHome ? (row.away_tcode as string) : (row.home_tcode as string),
      oppName: (isHome ? awayTeam?.name : homeTeam?.name) ?? (isHome ? (row.away_tcode as string) : (row.home_tcode as string)),
      isHome,
      min: stat.min_played ?? 0,
      pts: stat.pts ?? 0,
      reb: stat.reb ?? 0,
      ast: stat.ast ?? 0,
      stl: stat.stl ?? 0,
      blk: stat.blk ?? 0,
      fgm: stat.fgm ?? 0,
      fga: stat.fga ?? 0,
      tpm: stat.tpm ?? 0,
      tpa: stat.tpa ?? 0,
      ftm: stat.ftm ?? 0,
      fta: stat.fta ?? 0,
      teamScore: (isHome ? row.home_score : row.away_score) as number,
      oppScore: (isHome ? row.away_score : row.home_score) as number,
      win: ((isHome ? row.home_score : row.away_score) as number) > ((isHome ? row.away_score : row.home_score) as number),
    };
  });
}
