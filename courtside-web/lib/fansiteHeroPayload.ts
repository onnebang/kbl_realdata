import { deriveGameStatus, type GameStatus } from "./gameStatus";
import { displayTeamName } from "./teamNames";
import { SITE_URL } from "./site";

// 팬사이트(Green Light) 메인 히어로가 읽는 JSON의 모양과, DB 행을 그 모양으로 바꾸는 순수 함수.
// DB·Next에 의존하지 않아 vitest가 환경변수 없이 import한다(조회는 lib/fansiteHero.ts).
// 팬사이트의 lib/courtside-parse.ts가 이 모양을 검증한다 - 필드를 바꾸면 version을 올리고 팬사이트도 같이 고칠 것.
// 여기 나가는 값은 전부 이미 Courtside 화면에 공개된 것이다(pcode 같은 내부 식별자는 일부러 뺐다).

export type HeroGame = {
  gmkey: string;
  date: string; // "2026-10-25" (KST)
  time: string | null; // "15:00"
  stadium: string | null;
  home: boolean; // 요청 팀이 홈이면 true
  opponent: { tcode: string; name: string };
  us: number | null; // 요청 팀 점수. 예정이면 null
  them: number | null;
  status: GameStatus;
  url: string;
};
export type HeroPlayer = { name: string; pts: number };
export type HeroLast = HeroGame & { mvp: HeroPlayer | null; ourTop: HeroPlayer | null };
export type HeroPayload = {
  version: 1;
  team: { tcode: string; name: string };
  generatedAt: string; // ISO - 캐시가 얼마나 묵었는지 볼 때 쓴다
  live: HeroGame | null;
  last: HeroLast | null;
  upcoming: HeroGame[]; // 최대 2, live 제외
};

/** buildHeroPayload가 읽는 경기 행. lib/homeGames.ts의 GameRow에 stadium을 더한 모양이라 구조만 맞으면 그대로 넘겨도 된다. */
export type HeroRow = {
  gmkey: string;
  game_date: string;
  game_start: string | null; // "HH:MM:SS"
  stadium: string | null;
  home_score: number | null;
  away_score: number | null;
  is_ended: boolean;
  season_name: string;
  home_team: { tcode: string; name: string } | null;
  away_team: { tcode: string; name: string } | null;
};
type Top = { name: string; pts: number } | null;
/** gmkey -> 승리 팀/패배 팀 최고 활약. lib/homeGames.ts의 getGameMvps가 주는 값의 부분집합. */
export type HeroMvps = ReadonlyMap<string, { winnerTop: Top; loserTop: Top }>;

/** `?team=`은 두 자리 팀 코드만 받는다(season-browser/box-score 라우트의 tcode 검증과 같다). */
export function parseTeamParam(v: string | null): string | null {
  return v !== null && /^\d{2}$/.test(v) ? v : null;
}

const player = (p: Top): HeroPlayer | null => (p ? { name: p.name, pts: p.pts } : null);

// 홈/원정을 요청 팀 기준(us/them)으로 뒤집는다. 팀 조인이 비어 있으면 상대를 알 수 없어 null.
function toGame(row: HeroRow, tcode: string): HeroGame | null {
  const { home_team: h, away_team: a } = row;
  if (!h || !a) return null;
  const home = h.tcode === tcode;
  const opp = home ? a : h;
  return {
    gmkey: row.gmkey,
    date: row.game_date,
    time: row.game_start && /^\d{2}:\d{2}/.test(row.game_start) ? row.game_start.slice(0, 5) : null,
    stadium: row.stadium?.trim() || null,
    home,
    opponent: { tcode: opp.tcode, name: displayTeamName(opp.tcode, opp.name, row.season_name) },
    us: home ? row.home_score : row.away_score,
    them: home ? row.away_score : row.home_score,
    status: deriveGameStatus(row),
    url: `${SITE_URL}/games/${encodeURIComponent(row.gmkey)}`,
  };
}

export function buildHeroPayload(input: {
  team: { tcode: string; name: string };
  live: HeroRow | null;
  last: HeroRow | null;
  upcoming: HeroRow[];
  mvps: HeroMvps;
  now: Date;
}): HeroPayload {
  const { team } = input;
  const live = input.live ? toGame(input.live, team.tcode) : null;

  let last: HeroLast | null = null;
  const lastGame = input.last ? toGame(input.last, team.tcode) : null;
  if (lastGame) {
    const m = input.mvps.get(lastGame.gmkey);
    const won = lastGame.us != null && lastGame.them != null && lastGame.us > lastGame.them;
    // MVP는 승리 팀 최고 활약. 졌을 때는 상대 선수라서, 우리 쪽 최고 활약을 따로 준다.
    last = { ...lastGame, mvp: player(m?.winnerTop ?? null), ourTop: player((won ? m?.winnerTop : m?.loserTop) ?? null) };
  }

  const upcoming = input.upcoming
    .flatMap((r) => toGame(r, team.tcode) ?? [])
    .filter((g) => g.status === "scheduled")
    .slice(0, 2);

  return { version: 1, team, generatedAt: input.now.toISOString(), live, last, upcoming };
}
