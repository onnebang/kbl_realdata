import { supabase } from "./supabase";
import { displayTeamName } from "./teamNames";

// 선수 프로필(README "다음 단계" 세 번째, 새 /players/[pcode] 라우트) - 커리어 스탯을
// 시즌별로 집계. PostgREST가 GROUP BY 집계를 직접 지원하지 않아서(단순 select라)
// game_player_stats를 이 선수 pcode로 전부 받아 시즌별로 JS에서 묶음 - idx_gps_pcode
// 인덱스가 있어서 필터 자체는 빠름. 커리어가 긴 선수(15시즌치)는 1000행 기본 제한을 넘을
// 수 있어 rarity.ts와 같은 방식으로 페이지네이션.

export type PlayerInfo = { pcode: string; name: string; ename: string | null; photoUrl: string | null };

// 템플릿 player_profile_template.html의 teamBadgeHtml()/teamBadgeStyle() 대응 - 이 프로젝트는
// components/TeamBadge.tsx가 이미 그 역할을 하므로, 여기서는 tcode -> 배지에 필요한 필드
// (name/abbr/color/logo_url)만 한 번에 가져와 Map으로 반환. teams 테이블이 30행 미만이라
// 페이지네이션 불필요.
export type TeamMeta = { tcode: string; name: string; abbr: string; color: string; logoUrl: string | null };

export async function getAllTeams(): Promise<Map<string, TeamMeta>> {
  const { data } = await supabase.from("teams").select("tcode, name, abbr, color, logo_url");
  const map = new Map<string, TeamMeta>();
  for (const t of data ?? []) {
    map.set(t.tcode, { tcode: t.tcode, name: t.name, abbr: t.abbr, color: t.color, logoUrl: t.logo_url });
  }
  return map;
}

export type SeasonLine = {
  seasonName: string;
  tcode: string;
  teamName: string;
  gp: number;
  minPg: number;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  tovPg: number;
  fgPct: number | null;
  tpPct: number | null;
  ftPct: number | null;
  // 히어로 헤드라인 TS% 계산용 - TS% = PPG / (2*(FGA/G + TPA/G + 0.44*FTA/G)). 이 DB의
  // fga는 "2점 시도만"(프로젝트 관례, lib/shotImpactChart.ts 주석)이라 3점(tpa)을 따로 합산.
  fgaPg: number;
  tpaPg: number;
  ftaPg: number;
};

export type GameLogRow = {
  gmkey: string;
  gameDate: string;
  tcode: string;
  backNum: string | null;
  pos: string | null;
  oppTcode: string;
  oppName: string;
  isHome: boolean;
  min: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
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
  min_played: number | null;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  turnovers: number | null;
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
      .select("gmkey, tcode, min_played, pts, reb, ast, stl, blk, turnovers, fgm, fga, tpm, tpa, ftm, fta")
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
        // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 이 시즌 라인 자체의
        // seasonName 기준으로 표시 이름을 덮어씀.
        teamName: displayTeamName(tcode, teamNameByTcode.get(tcode) ?? tcode, seasonName),
        gp,
        minPg: sum((r) => r.min_played ?? 0) / gp,
        ppg: sum((r) => r.pts ?? 0) / gp,
        rpg: sum((r) => r.reb ?? 0) / gp,
        apg: sum((r) => r.ast ?? 0) / gp,
        spg: sum((r) => r.stl ?? 0) / gp,
        bpg: sum((r) => r.blk ?? 0) / gp,
        tovPg: sum((r) => r.turnovers ?? 0) / gp,
        fgPct: fga > 0 ? fgm / fga : null,
        tpPct: tpa > 0 ? tpm / tpa : null,
        ftPct: fta > 0 ? ftm / fta : null,
        fgaPg: fga / gp,
        tpaPg: tpa / gp,
        ftaPg: fta / gp,
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
// "선수 프로필" 아티팩트(claude.ai/code/artifact/725944e9...) 참고 - L5/L10/L15/L30
// 토글이 있어서 최소 30경기는 미리 받아둠(윈도우 슬라이싱은 페이지에서).
export const MAX_GAME_LOG = 30;
export const WINDOWS = [5, 10, 15, 30] as const;

export function computeWindowAverages(games: GameLogRow[], windowN: number) {
  const slice = games.slice(0, windowN);
  const gp = slice.length;
  if (!gp) return null;
  const sum = (fn: (g: GameLogRow) => number) => slice.reduce((s, g) => s + fn(g), 0);
  const fgm = sum((g) => g.fgm),
    fga = sum((g) => g.fga);
  const tpm = sum((g) => g.tpm),
    tpa = sum((g) => g.tpa);
  const ftm = sum((g) => g.ftm),
    fta = sum((g) => g.fta);
  return {
    gp,
    min: sum((g) => g.min) / gp,
    pts: sum((g) => g.pts) / gp,
    reb: sum((g) => g.reb) / gp,
    ast: sum((g) => g.ast) / gp,
    stl: sum((g) => g.stl) / gp,
    blk: sum((g) => g.blk) / gp,
    tov: sum((g) => g.tov) / gp,
    fgPct: fga > 0 ? (fgm / fga) * 100 : null,
    tpPct: tpa > 0 ? (tpm / tpa) * 100 : null,
    ftPct: fta > 0 ? (ftm / fta) * 100 : null,
  };
}

export async function getPlayerRecentGames(pcode: string, limit = MAX_GAME_LOG): Promise<GameLogRow[]> {
  const { data } = await supabase
    .from("games")
    .select(
      `gmkey, game_date, season_name, home_tcode, away_tcode, home_score, away_score,
       home_team:teams!games_home_tcode_fkey(tcode, name),
       away_team:teams!games_away_tcode_fkey(tcode, name),
       game_player_stats!inner(pcode, tcode, back_num, pos, min_played, pts, reb, ast, stl, blk, turnovers, fgm, fga, tpm, tpa, ftm, fta)`
    )
    .eq("game_player_stats.pcode", pcode)
    .order("game_date", { ascending: false })
    .limit(limit);
  if (!data) return [];
  return data.map((row) => {
    const stat = (row.game_player_stats as unknown as { tcode: string; back_num: string | null; pos: string | null; min_played: number | null; pts: number | null; reb: number | null; ast: number | null; stl: number | null; blk: number | null; turnovers: number | null; fgm: number | null; fga: number | null; tpm: number | null; tpa: number | null; ftm: number | null; fta: number | null }[])[0];
    const homeTeam = row.home_team as unknown as { tcode: string; name: string } | null;
    const awayTeam = row.away_team as unknown as { tcode: string; name: string } | null;
    const isHome = stat.tcode === row.home_tcode;
    const oppTcode = isHome ? (row.away_tcode as string) : (row.home_tcode as string);
    const oppRawName = (isHome ? awayTeam?.name : homeTeam?.name) ?? oppTcode;
    return {
      gmkey: row.gmkey as string,
      gameDate: row.game_date as string,
      tcode: stat.tcode,
      backNum: stat.back_num,
      pos: stat.pos,
      oppTcode,
      // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 이 경기 자체의
      // season_name 기준.
      oppName: displayTeamName(oppTcode, oppRawName, row.season_name as string),
      isHome,
      min: stat.min_played ?? 0,
      pts: stat.pts ?? 0,
      reb: stat.reb ?? 0,
      ast: stat.ast ?? 0,
      stl: stat.stl ?? 0,
      blk: stat.blk ?? 0,
      tov: stat.turnovers ?? 0,
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

// ── 커리어 전 경기 행(프로필 개편 1단계) ─────────────────────────────────────────────
// 상태 스트립(lib/playerStatus.ts: 뛴 시즌 수·마지막 경기), 상대별 통산(lib/preseason.ts
// getPlayerVsOpponentCareer), 마지막 장면 카드, 2단계 커리어 리본이 전부 같은 행을 쓰므로 한 번만
// 받아 넘겨 쓴다(각 함수는 careerRows 인자를 받으면 재조회하지 않음). getPlayerRecentGames와 같은
// 방향(games FROM + game_player_stats!inner 임베드)이라 game_date 정렬이 실제로 먹고, 커리어가
// 긴 선수(김선형 639경기)도 1000행 cap을 넘길 수 있어 .range 페이지네이션.
//
// 주의: game_player_stats에는 출전 0분(DNP) 행도 있다(실측 25-26 6,792행 중 654행이 0분). 기존
// getPlayerCareerBySeason의 GP가 행 수 기준이라 여기서도 걸러내지 않는다 - GP를 "출전"으로만
// 세고 싶은 화면은 min > 0으로 직접 거른다.
export type CareerGameRow = {
  gmkey: string;
  gameDate: string;
  seasonName: string;
  seasonCategory: string; // 정규시즌 / 플레이오프
  tcode: string; // 이 경기에서 선수가 속한 팀
  oppTcode: string;
  isHome: boolean;
  teamScore: number | null; // 예정·진행 중이면 null(lib/gameStatus.ts 규칙과 동일)
  oppScore: number | null;
  isEnded: boolean;
  backNum: string | null;
  pos: string | null; // 원문(C/FD/GD) - 표시 전 lib/playerStatus.ts normalizePos로 G/F/C 정규화
  isStarter: boolean | null;
  min: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  fgm: number;
  fga: number; // 2점 시도만(프로젝트 관례)
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
};

export async function getPlayerCareerGames(pcode: string): Promise<CareerGameRow[]> {
  type Stat = {
    tcode: string;
    back_num: string | null;
    pos: string | null;
    is_starter: boolean | null;
    min_played: number | string | null;
    pts: number | null;
    reb: number | null;
    ast: number | null;
    stl: number | null;
    blk: number | null;
    turnovers: number | null;
    fgm: number | null;
    fga: number | null;
    tpm: number | null;
    tpa: number | null;
    ftm: number | null;
    fta: number | null;
  };
  const PAGE = 1000;
  const rows: CareerGameRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("games")
      .select(
        `gmkey, game_date, season_name, season_category, home_tcode, away_tcode, home_score, away_score, is_ended,
         game_player_stats!inner(tcode, back_num, pos, is_starter, min_played, pts, reb, ast, stl, blk, turnovers, fgm, fga, tpm, tpa, ftm, fta)`
      )
      .eq("game_player_stats.pcode", pcode)
      .order("game_date", { ascending: false })
      .order("gmkey", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    for (const row of data) {
      const stat = (row.game_player_stats as unknown as Stat[])[0];
      if (!stat) continue;
      const isHome = stat.tcode === row.home_tcode;
      const homeScore = (row.home_score as number | null) ?? null;
      const awayScore = (row.away_score as number | null) ?? null;
      rows.push({
        gmkey: row.gmkey as string,
        gameDate: row.game_date as string,
        seasonName: row.season_name as string,
        seasonCategory: row.season_category as string,
        tcode: stat.tcode,
        oppTcode: isHome ? (row.away_tcode as string) : (row.home_tcode as string),
        isHome,
        teamScore: isHome ? homeScore : awayScore,
        oppScore: isHome ? awayScore : homeScore,
        isEnded: !!row.is_ended,
        backNum: stat.back_num ?? null,
        pos: stat.pos ?? null,
        isStarter: stat.is_starter ?? null,
        min: Number(stat.min_played ?? 0),
        pts: stat.pts ?? 0,
        reb: stat.reb ?? 0,
        ast: stat.ast ?? 0,
        stl: stat.stl ?? 0,
        blk: stat.blk ?? 0,
        tov: stat.turnovers ?? 0,
        fgm: stat.fgm ?? 0,
        fga: stat.fga ?? 0,
        tpm: stat.tpm ?? 0,
        tpa: stat.tpa ?? 0,
        ftm: stat.ftm ?? 0,
        fta: stat.fta ?? 0,
      });
    }
    if (data.length < PAGE) break;
  }
  return rows;
}
