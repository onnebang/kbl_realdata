import { supabaseServer as supabase } from "./supabaseServer";
import { displayTeamName } from "./teamNames";
import { deriveGameStatus, type GameStatus } from "./gameStatus";
import { PRESEASON_SEASON, isRealGmkey } from "./preseason";
import { cachedFn, TTL } from "./cachePolicy";

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
  // 프리뷰 인사이트("오펜스 리바운드 조심") - game_team_stats.oreb(원시 리바운드 개수)는
  // 전량 NULL이지만(실측 - lib/postgameReport.ts의 PlayerBox 주석과 같은 결측), oreb_pct
  // (공격리바운드율, 0~100 스케일)는 100% 채워져 있어서 그걸로 대체. lib/matchupInsights.ts가
  // 리그 평균과 비교해 "genuinely notable"할 때만 오펜스 리바운드 인사이트를 띄우는 데 씀.
  orebPct: number;
  /**
   * 시즌 최다 득점 / 최소 실점 / 최다 3점 - '평소의 그 팀이 아니었다' 리포트 섹션용.
   * 이미 받아 오는 같은 행에서 나오므로 왕복이 늘지 않는다. 이 경기 이전(리크프리) 정규시즌만.
   */
  maxPts: number;
  minOppPts: number;
  maxTpm: number;
};

export type ScheduleGame = {
  gmkey: string;
  gameDate: string;
  seasonName?: string; // 이 경기가 열린 시즌 - 개막 전 프리뷰가 지난 시즌 경기를 "직전 경기"로 쓸 때 문구에 명시하기 위해
  oppTcode: string;
  oppName: string;
  isHome: boolean;
  teamScore: number;
  oppScore: number;
};

export type H2H = {
  /** 이 경기 **이전** 맞대결 횟수. 이 경기는 meetings + 1 번째다. */
  meetings: number;
  homeWins: number;
  awayWins: number;
  recentMeetings: { gmkey: string; gameDate: string; homeTcode: string; awayTcode: string; homeScore: number; awayScore: number }[];
  /** 직전까지 이어지던 맞대결 연승 - 누가 몇 연승 중이었나. 맞대결 0회면 null. */
  streak: { winnerTcode: string; length: number } | null;
  /** 각 팀이 마지막으로 이 상대를 이긴 날짜. 한 번도 못 이겼으면 null. */
  lastWinDate: Record<string, string | null>;
};

export type StandingsRow = {
  tcode: string;
  wins: number;
  losses: number;
  pct: number;
  /** 1위와의 게임차. 1위 본인은 0. */
  gb: number;
  /** 현재 연승/연패. 경기가 없으면 null. */
  streak: { result: "W" | "L"; length: number } | null;
  /** 최근 10경기(그보다 적으면 치른 만큼) 승-패. */
  last10: { wins: number; losses: number };
  home: { wins: number; losses: number };
  away: { wins: number; losses: number };
  /** 경기당 평균 득실마진. */
  diff: number;
};

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
    .select("gmkey, tpm, ast, reb, stl, blk, turnovers, oreb_pct")
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
    maxPts: Math.max(...rows.map((s) => teamScoreByGmkey.get(s.gmkey) ?? 0)),
    minOppPts: Math.min(...rows.map((s) => oppScoreByGmkey.get(s.gmkey) ?? Number.POSITIVE_INFINITY)),
    maxTpm: Math.max(...rows.map((s) => s.tpm ?? 0)),
    orebPct: sum((s) => s.oreb_pct ?? 0) / gp,
  };
}

// 프리뷰 인사이트("오펜스 리바운드 조심") 임계값 기준 - 이 시즌, 이 날짜 이전(리크프리)
// 정규시즌 전체 팀-경기의 oreb_pct 단순 평균(팀별 평균의 평균이 아니라 경기 단위 평균 -
// 표본이 큰 팀에 가중치가 실리는 걸 피하려 게임 단위로 통일, getStandingsAsOf와 같은 로우
// 레벨 집계 관례). lib/matchupInsights.ts가 이 값 + 몇 %p 이상인 팀에게만 인사이트를 띄움.
export async function getLeagueAvgOrebPct(seasonName: string, beforeDate: string): Promise<number | null> {
  const { data: games } = await supabase
    .from("games")
    .select("gmkey")
    .eq("season_name", seasonName)
    .eq("season_category", "정규시즌")
    .lt("game_date", beforeDate)
    .not("home_score", "is", null);
  if (!games || !games.length) return null;
  const gmkeys = games.map((g) => g.gmkey);
  const { data: stats } = await supabase.from("game_team_stats").select("oreb_pct").in("gmkey", gmkeys);
  if (!stats || !stats.length) return null;
  return stats.reduce((s, r) => s + (r.oreb_pct ?? 0), 0) / stats.length;
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
      seasonName: g.season_name as string,
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
      seasonName,
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
  // rows는 날짜 내림차순이라 앞에서부터 같은 승자가 이어지는 길이가 곧 '직전 연승'이다.
  // 이 함수는 예전부터 전 맞대결을 통째로 받아 놓고 5경기만 쓰고 버렸다 - 여기서 마저 쓴다.
  const winnerOf = (r: (typeof rows)[number]) =>
    (r.home_score as number) > (r.away_score as number) ? (r.home_tcode as string) : (r.away_tcode as string);
  let streak: H2H["streak"] = null;
  for (const r of rows) {
    const w = winnerOf(r);
    if (!streak) streak = { winnerTcode: w, length: 1 };
    else if (streak.winnerTcode === w) streak.length += 1;
    else break;
  }
  const lastWinDate: Record<string, string | null> = { [homeTcode]: null, [awayTcode]: null };
  for (const r of rows) {
    const w = winnerOf(r);
    if (lastWinDate[w] == null) lastWinDate[w] = r.game_date as string;
    if (lastWinDate[homeTcode] && lastWinDate[awayTcode]) break;
  }
  return {
    meetings: rows.length,
    homeWins,
    awayWins: rows.length - homeWins,
    streak,
    lastWinDate,
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

export type StandingsGameRow = {
  home_tcode: string;
  away_tcode: string;
  home_score: number;
  away_score: number;
  game_date: string;
  game_start: string | null;
};

// 순수 계산부만 분리(Supabase 없이 단위 테스트 가능 - lib/matchups.test.ts).
// 연승연패/최근10경기/홈원정/득실마진/게임차까지 한 번에 계산한다(팀 순위 테이블용 확장 -
// 기존 호출부는 wins/losses/pct만 쓰므로 필드 추가는 그쪽을 깨지 않는다).
export function computeStandings(games: StandingsGameRow[]): StandingsRow[] {
  if (!games.length) return [];
  const sorted = [...games].sort(
    (a, b) => a.game_date.localeCompare(b.game_date) || (a.game_start ?? "").localeCompare(b.game_start ?? "")
  );
  type Result = { won: boolean; isHome: boolean; diff: number };
  const byTeam = new Map<string, Result[]>();
  const push = (tcode: string, r: Result) => {
    const list = byTeam.get(tcode) ?? [];
    list.push(r);
    byTeam.set(tcode, list);
  };
  for (const g of sorted) {
    const homeWon = g.home_score > g.away_score;
    push(g.home_tcode, { won: homeWon, isHome: true, diff: g.home_score - g.away_score });
    push(g.away_tcode, { won: !homeWon, isHome: false, diff: g.away_score - g.home_score });
  }
  const splitWL = (results: Result[]) => ({
    wins: results.filter((r) => r.won).length,
    losses: results.filter((r) => !r.won).length,
  });
  const rows = Array.from(byTeam.entries()).map(([tcode, results]) => {
    const { wins, losses } = splitWL(results);
    const last = results[results.length - 1] ?? null;
    let streak: StandingsRow["streak"] = null;
    if (last) {
      let length = 0;
      for (let i = results.length - 1; i >= 0 && results[i].won === last.won; i--) length++;
      streak = { result: last.won ? "W" : "L", length };
    }
    return {
      tcode,
      wins,
      losses,
      pct: wins / (wins + losses),
      gb: 0, // 1위 확정 후 아래서 채움
      streak,
      last10: splitWL(results.slice(-10)),
      home: splitWL(results.filter((r) => r.isHome)),
      away: splitWL(results.filter((r) => !r.isHome)),
      diff: results.reduce((sum, r) => sum + r.diff, 0) / results.length,
    };
  });
  rows.sort((a, b) => b.pct - a.pct || b.diff - a.diff);
  const leader = rows[0];
  for (const r of rows) {
    // 표시 순서는 승률(동률이면 득실마진)로 정하지만, 게임차 공식((승수차+패수차)/2)은
    // 경기 수가 다르면 "2승0패"가 "1승0패"보다 공식상 반게임 앞서는 역전이 생길 수 있다
    // (둘 다 승률 100%인데 그렇게 됨) - 그 경우 음수 게임차가 나오므로 0으로 바닥을 깐다.
    r.gb = leader ? Math.max(0, (leader.wins - r.wins + (r.losses - leader.losses)) / 2) : 0;
  }
  return rows;
}

// 리그 순위 - 이 시즌 정규시즌 경기 중 이 날짜 이전 것만으로 승/패 집계(리크프리).
export async function getStandingsAsOf(seasonName: string, beforeDate: string): Promise<StandingsRow[]> {
  const { data } = await supabase
    .from("games")
    .select("home_tcode, away_tcode, home_score, away_score, game_date, game_start")
    .eq("season_name", seasonName)
    .eq("season_category", "정규시즌")
    .lte("game_date", beforeDate)
    .not("home_score", "is", null);
  return computeStandings((data ?? []) as StandingsGameRow[]);
}

// ── 팀 시즌 일정: 결과 + 예정 한 표(프로필 개편 1단계) ─────────────────────────────────
// getTeamSeasonSchedule은 home_score가 있는(치른) 경기만 돌려주고 다른 페이지가 그 계약에
// 의존하므로 손대지 않는다. 상태 스트립·고스트 리본·일정표는 예정 경기(home_score null)까지
// 필요해서 이 함수를 따로 둔다. tools/sync_upcoming_games.py가 넣는 예정 행은 stadium·
// game_start가 채워져 있고(실측 26-27 127경기 전부), 라이브 드라이런의 합성 gmkey(P2LIVE-/
// DRYRUN-)는 isRealGmkey로 걸러 실제 경기처럼 보이지 않게 한다.
export type TeamFixture = {
  gmkey: string;
  gameDate: string; // "2026-10-03"
  gameStart: string | null; // "14:00:00" (time without time zone 원문)
  stadium: string | null;
  seasonName: string;
  seasonCategory: string;
  oppTcode: string;
  oppName: string; // 그 시즌 기준 표기(displayTeamName)
  isHome: boolean;
  teamScore: number | null; // 예정이면 null
  oppScore: number | null;
  isEnded: boolean;
  status: GameStatus; // scheduled / live / final (lib/gameStatus.ts 단일 정의)
};

const FIXTURE_SELECT = `gmkey, game_date, game_start, stadium, season_name, season_category, home_tcode, away_tcode, home_score, away_score, is_ended,
       home_team:teams!games_home_tcode_fkey(tcode, name),
       away_team:teams!games_away_tcode_fkey(tcode, name)`;

function toFixture(g: Record<string, unknown>, tcode: string): TeamFixture {
  const isHome = g.home_tcode === tcode;
  const homeTeam = g.home_team as { tcode: string; name: string } | null;
  const awayTeam = g.away_team as { tcode: string; name: string } | null;
  const oppTcode = isHome ? (g.away_tcode as string) : (g.home_tcode as string);
  const oppRawName = (isHome ? awayTeam?.name : homeTeam?.name) ?? oppTcode;
  const homeScore = (g.home_score as number | null) ?? null;
  const awayScore = (g.away_score as number | null) ?? null;
  const seasonName = g.season_name as string;
  return {
    gmkey: g.gmkey as string,
    gameDate: g.game_date as string,
    gameStart: (g.game_start as string | null) ?? null,
    stadium: (g.stadium as string | null) ?? null,
    seasonName,
    seasonCategory: g.season_category as string,
    oppTcode,
    oppName: displayTeamName(oppTcode, oppRawName, seasonName),
    isHome,
    teamScore: isHome ? homeScore : awayScore,
    oppScore: isHome ? awayScore : homeScore,
    isEnded: !!g.is_ended,
    status: deriveGameStatus({ home_score: homeScore, is_ended: !!g.is_ended }),
  };
}

/** 이 시즌 이 팀의 실제 경기 전부(치른 + 예정, 정규+PO), 날짜·시각 오름차순. */
export async function getTeamSeasonFixtures(tcode: string, seasonName: string): Promise<TeamFixture[]> {
  const { data } = await supabase
    .from("games")
    .select(FIXTURE_SELECT)
    .eq("season_name", seasonName)
    .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`)
    .order("game_date", { ascending: true })
    .order("game_start", { ascending: true, nullsFirst: false });
  if (!data) return [];
  return (data as unknown as Record<string, unknown>[]).filter((g) => isRealGmkey(g.gmkey as string)).map((g) => toFixture(g, tcode));
}

/** 이 팀의 아직 끝나지 않은(예정 또는 진행 중) 가장 이른 실제 경기. 없으면 null(시즌 종료·일정 미수록). */
export async function getTeamNextGame(tcode: string, seasonName = PRESEASON_SEASON): Promise<TeamFixture | null> {
  const { data } = await supabase
    .from("games")
    .select(FIXTURE_SELECT)
    .eq("season_name", seasonName)
    .eq("is_ended", false)
    .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`)
    .order("game_date", { ascending: true })
    .order("game_start", { ascending: true, nullsFirst: false })
    .limit(10); // 합성 gmkey가 앞에 섞여도 실제 경기 하나는 남도록 여유
  const real = ((data ?? []) as unknown as Record<string, unknown>[]).filter((g) => isRealGmkey(g.gmkey as string));
  return real.length ? toFixture(real[0], tcode) : null;
}

/** 이 시즌 이 팀이 치른(종료된) 정규시즌 실제 경기 수 - lib/seasonFocus.ts resolveTeamSeasons의 입력. */
// 캐시(2026-09-15): 팀 페이지가 요청마다 읽고 있었다(프로덕션 로그). 경기가 끝날 때 바뀌는 값이라 예정
// 경기와 같은 10분 - 기준 시즌 전환(5경기)이 최대 10분 늦는 정도는 괜찮다.
export const getTeamPlayedRegCount = cachedFn(computeTeamPlayedRegCount, { name: "teamPlayedRegCount", ttl: TTL.scheduled });

async function computeTeamPlayedRegCount(tcode: string, seasonName: string): Promise<number> {
  const { data } = await supabase
    .from("games")
    .select("gmkey")
    .eq("season_name", seasonName)
    .eq("season_category", "정규시즌")
    .eq("is_ended", true)
    .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`);
  return (data ?? []).filter((g) => isRealGmkey(g.gmkey as string)).length;
}
