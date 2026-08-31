import { supabase } from "./supabase";
import { displayTeamName } from "./teamNames";

// courtside_template.html의 renderMatchups()/renderStandings()가 쓰던 pregameDetail(h2h/
// seasonStats/schedule/standings)을 courtside-web에도 - 그쪽은 Python 빌드타임에 미리
// 계산해 JSON에 박아넣었지만(load_pregame_detail() 안 team_averages_asof/team_schedule_
// around 등), 여기는 전부 games/game_team_stats에서 라이브로 계산 가능해서(새 마이그레이션
// 불필요) 매 요청마다 그때그때 쿼리. 정규시즌만(플레이오프 표본 섞으면 왜곡) - 원본
// renderStandings() 주석("리크프리 스탠딩, 정규시즌만")과 동일 원칙.

export type SeasonStats = {
  gp: number;
  ppg: number;
  oppPpg: number;
  threePg: number;
  astPg: number;
  rebPg: number;
  stlPg: number;
  blkPg: number;
  tovPg: number;
};

export type ScheduleGame = {
  gmkey: string;
  gameDate: string;
  oppTcode: string;
  oppName: string;
  isHome: boolean;
  teamScore: number;
  oppScore: number;
};

export type H2H = {
  meetings: number;
  homeWins: number;
  awayWins: number;
  recentMeetings: { gmkey: string; gameDate: string; homeTcode: string; awayTcode: string; homeScore: number; awayScore: number }[];
};

export type StandingsRow = { tcode: string; wins: number; losses: number; pct: number };

// 이 팀의 이 시즌, 이 날짜 이전(리크프리) 정규시즌 경기들의 팀 평균 스탯. game_team_stats엔
// 상대 득점이 없어서(자기 팀 stat만) games 테이블의 home_score/away_score에서 상대 득점을
// 따로 매칭.
export async function getSeasonStatsAsOf(tcode: string, seasonName: string, beforeDate: string): Promise<SeasonStats | null> {
  const { data: games } = await supabase
    .from("games")
    .select("gmkey, home_tcode, away_tcode, home_score, away_score")
    .eq("season_name", seasonName)
    .eq("season_category", "정규시즌")
    .lt("game_date", beforeDate)
    .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`)
    .not("home_score", "is", null);
  if (!games || !games.length) return null;

  const gmkeys = games.map((g) => g.gmkey);
  const { data: stats } = await supabase
    .from("game_team_stats")
    .select("gmkey, tpm, ast, reb, stl, blk, turnovers")
    .eq("tcode", tcode)
    .in("gmkey", gmkeys);
  if (!stats || !stats.length) return null;
  // stats는 위 가드로 non-null이 됐지만 "typeof stats"로 만든 타입 별칭은 그 좁혀진 타입을
  // 못 따라가서(TS2537 - null을 인덱싱하려 함) 새 const로 다시 받아 좁혀진 타입을 고정.
  const rows = stats;

  const oppScoreByGmkey = new Map(
    games.map((g) => [g.gmkey, g.home_tcode === tcode ? (g.away_score as number) : (g.home_score as number)])
  );
  const teamScoreByGmkey = new Map(
    games.map((g) => [g.gmkey, g.home_tcode === tcode ? (g.home_score as number) : (g.away_score as number)])
  );

  const gp = rows.length;
  const sum = (fn: (s: (typeof rows)[number]) => number) => rows.reduce((s, row) => s + fn(row), 0);
  return {
    gp,
    ppg: sum((s) => teamScoreByGmkey.get(s.gmkey) ?? 0) / gp,
    oppPpg: sum((s) => oppScoreByGmkey.get(s.gmkey) ?? 0) / gp,
    threePg: sum((s) => s.tpm ?? 0) / gp,
    astPg: sum((s) => s.ast ?? 0) / gp,
    rebPg: sum((s) => s.reb ?? 0) / gp,
    stlPg: sum((s) => s.stl ?? 0) / gp,
    blkPg: sum((s) => s.blk ?? 0) / gp,
    tovPg: sum((s) => s.turnovers ?? 0) / gp,
  };
}

// 최근 결과만(예정 경기는 DB에 없음 - 완료된 경기만 이관됐음, README 28차 참고).
export async function getRecentSchedule(tcode: string, beforeDate: string, limit = 5): Promise<ScheduleGame[]> {
  const { data } = await supabase
    .from("games")
    .select(
      `gmkey, game_date, season_name, home_tcode, away_tcode, home_score, away_score,
       home_team:teams!games_home_tcode_fkey(tcode, name),
       away_team:teams!games_away_tcode_fkey(tcode, name)`
    )
    .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`)
    .lt("game_date", beforeDate)
    .not("home_score", "is", null)
    .order("game_date", { ascending: false })
    .limit(limit);
  if (!data) return [];
  return data.map((g) => {
    const isHome = g.home_tcode === tcode;
    const homeTeam = g.home_team as unknown as { tcode: string; name: string } | null;
    const awayTeam = g.away_team as unknown as { tcode: string; name: string } | null;
    const oppTcode = isHome ? (g.away_tcode as string) : (g.home_tcode as string);
    const oppRawName = (isHome ? awayTeam?.name : homeTeam?.name) ?? oppTcode;
    return {
      gmkey: g.gmkey as string,
      gameDate: g.game_date as string,
      oppTcode,
      // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 이 경기 자체의
      // season_name 기준(조회 중인 경기의 시즌이 아니라, 이 상대전적이 실제로 열린
      // 그 시즌 기준이라야 정확함).
      oppName: displayTeamName(oppTcode, oppRawName, g.season_name as string),
      isHome,
      teamScore: (isHome ? g.home_score : g.away_score) as number,
      oppScore: (isHome ? g.away_score : g.home_score) as number,
    };
  });
}

// 팀 시즌 일정(요청: "팀별, 시즌별 보기를 좀더 세분화" - ESPN 팀 스케줄 페이지 참고,
// /teams/[tcode]) - getRecentSchedule과 달리 날짜 컷오프 없이 이 시즌 전체(정규시즌+
// 플레이오프 다 포함, KBL 한 시즌 최대 60여 경기라 1000행 cap 걱정 없음).
export type TeamSeasonGame = ScheduleGame & { seasonCategory: string };
export async function getTeamSeasonSchedule(tcode: string, seasonName: string): Promise<TeamSeasonGame[]> {
  const { data } = await supabase
    .from("games")
    .select(
      `gmkey, game_date, season_category, home_tcode, away_tcode, home_score, away_score,
       home_team:teams!games_home_tcode_fkey(tcode, name),
       away_team:teams!games_away_tcode_fkey(tcode, name)`
    )
    .eq("season_name", seasonName)
    .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`)
    .not("home_score", "is", null)
    .order("game_date", { ascending: true });
  if (!data) return [];
  return data.map((g) => {
    const isHome = g.home_tcode === tcode;
    const homeTeam = g.home_team as unknown as { tcode: string; name: string } | null;
    const awayTeam = g.away_team as unknown as { tcode: string; name: string } | null;
    const oppTcode = isHome ? (g.away_tcode as string) : (g.home_tcode as string);
    const oppRawName = (isHome ? awayTeam?.name : homeTeam?.name) ?? oppTcode;
    return {
      gmkey: g.gmkey as string,
      gameDate: g.game_date as string,
      seasonCategory: g.season_category as string,
      oppTcode,
      // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 이 함수는 seasonName을
      // 인자로 이미 받고 있어서 그대로 재사용.
      oppName: displayTeamName(oppTcode, oppRawName, seasonName),
      isHome,
      teamScore: (isHome ? g.home_score : g.away_score) as number,
      oppScore: (isHome ? g.away_score : g.home_score) as number,
    };
  });
}

export async function getHeadToHead(homeTcode: string, awayTcode: string, beforeDate: string): Promise<H2H> {
  const { data } = await supabase
    .from("games")
    .select("gmkey, game_date, home_tcode, away_tcode, home_score, away_score")
    .or(
      `and(home_tcode.eq.${homeTcode},away_tcode.eq.${awayTcode}),and(home_tcode.eq.${awayTcode},away_tcode.eq.${homeTcode})`
    )
    .lt("game_date", beforeDate)
    .not("home_score", "is", null)
    .order("game_date", { ascending: false });
  const rows = data ?? [];
  const homeWins = rows.filter((r) =>
    r.home_tcode === homeTcode ? (r.home_score as number) > (r.away_score as number) : (r.away_score as number) > (r.home_score as number)
  ).length;
  return {
    meetings: rows.length,
    homeWins,
    awayWins: rows.length - homeWins,
    recentMeetings: rows.slice(0, 5).map((r) => ({
      gmkey: r.gmkey as string,
      gameDate: r.game_date as string,
      homeTcode: r.home_tcode as string,
      awayTcode: r.away_tcode as string,
      homeScore: r.home_score as number,
      awayScore: r.away_score as number,
    })),
  };
}

// 리그 순위 - 이 시즌 정규시즌 경기 중 이 날짜 이전 것만으로 승/패 집계(리크프리).
export async function getStandingsAsOf(seasonName: string, beforeDate: string): Promise<StandingsRow[]> {
  const { data } = await supabase
    .from("games")
    .select("home_tcode, away_tcode, home_score, away_score")
    .eq("season_name", seasonName)
    .eq("season_category", "정규시즌")
    .lte("game_date", beforeDate)
    .not("home_score", "is", null);
  if (!data || !data.length) return [];
  const record = new Map<string, { wins: number; losses: number }>();
  const bump = (tcode: string, won: boolean) => {
    const r = record.get(tcode) ?? { wins: 0, losses: 0 };
    if (won) r.wins++;
    else r.losses++;
    record.set(tcode, r);
  };
  for (const g of data) {
    const homeWon = (g.home_score as number) > (g.away_score as number);
    bump(g.home_tcode as string, homeWon);
    bump(g.away_tcode as string, !homeWon);
  }
  return Array.from(record.entries())
    .map(([tcode, r]) => ({ tcode, wins: r.wins, losses: r.losses, pct: r.wins / (r.wins + r.losses) }))
    .sort((a, b) => b.pct - a.pct);
}
