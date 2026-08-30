import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { TeamBadge } from "@/components/TeamBadge";

type TeamRef = {
  tcode: string;
  name: string;
  abbr: string;
  color: string;
  logo_url: string | null;
} | null;

type GameRow = {
  gmkey: string;
  game_date: string;
  home_score: number | null;
  away_score: number | null;
  season_category: string;
  season_name: string;
  home_team: TeamRef;
  away_team: TeamRef;
};

type TeamOption = { tcode: string; name: string };

async function getSeasons() {
  const { data } = await supabase
    .from("seasons")
    .select("season_name")
    .order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

async function getTeamOptions(): Promise<TeamOption[]> {
  const { data } = await supabase.from("teams").select("tcode, name").order("name");
  return (data ?? []) as TeamOption[];
}

async function getGames(seasonName: string | undefined, tcode: string | undefined) {
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
  // 팀 필터(요청: "팀별, 시즌별 보기를 좀더 세분화") - home_tcode/away_tcode 어느 쪽이든
  // 이 팀이 나온 경기. Supabase는 or()에 컬럼명을 직접 나열하는 문법이라 .eq() 두 번
  // 대신 or() 하나로.
  if (tcode) query = query.or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as GameRow[];
}

function fmtDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${y.slice(2)}.${m}.${day}`;
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; team?: string }>;
}) {
  const { season, team } = await searchParams;
  const [seasons, teamOptions] = await Promise.all([getSeasons(), getTeamOptions()]);
  const activeSeason = season ?? seasons[0];
  const games = await getGames(activeSeason, team);

  return (
    <div className="wrap">
      <div className="title">코트사이드</div>
      <div className="subtitle">
        Supabase에 실제로 적재된 KBL 경기 데이터를 직접 조회합니다 - 경기를 선택하면
        승률 그래프와 박스스코어를 볼 수 있어요. 팀 이름을 누르면 그 팀의 시즌 일정으로
        이동합니다.
      </div>

      <form style={{ marginTop: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select name="season" defaultValue={activeSeason}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s} 시즌
            </option>
          ))}
        </select>
        <select name="team" defaultValue={team ?? ""}>
          <option value="">전체 팀</option>
          {teamOptions.map((t) => (
            <option key={t.tcode} value={t.tcode}>
              {t.name}
            </option>
          ))}
        </select>
        <button type="submit" className="back-link" style={{ cursor: "pointer" }}>
          보기
        </button>
      </form>

      <div className="game-list">
        {games.length === 0 && (
          <div className="empty-note">조건에 맞는 경기 데이터가 없음(마이그레이션 진행 중일 수 있음)</div>
        )}
        {games.map((g) => {
          const homeWon = (g.home_score ?? 0) > (g.away_score ?? 0);
          return (
            <div key={g.gmkey} className="game-card">
              <div className="game-card-row">
                <span className="game-card-date">{fmtDate(g.game_date)}</span>
                <span className="game-card-teams">
                  <span className="team-side home">
                    <Link href={`/teams/${g.home_team?.tcode}?season=${activeSeason}`}>
                      <TeamBadge
                        team={g.home_team ? { name: g.home_team.name, abbr: g.home_team.abbr, color: g.home_team.color, logoUrl: g.home_team.logo_url } : null}
                      />
                    </Link>
                    <Link
                      href={`/teams/${g.home_team?.tcode}?season=${activeSeason}`}
                      className={`team-name home ${homeWon ? "win" : ""}`}
                      style={{ color: g.home_team?.color }}
                    >
                      {g.home_team?.name ?? g.gmkey}
                    </Link>
                    {homeWon && (
                      <span className="win-pill" style={{ background: g.home_team?.color ?? "var(--home)" }}>
                        W
                      </span>
                    )}
                  </span>
                  <Link href={`/games/${g.gmkey}`} className="game-card-score">
                    <span className={homeWon ? "win" : "lose"}>{g.home_score}</span>
                    <span className="score-sep">-</span>
                    <span className={!homeWon ? "win" : "lose"}>{g.away_score}</span>
                  </Link>
                  <span className="team-side away">
                    {!homeWon && (
                      <span className="win-pill" style={{ background: g.away_team?.color ?? "var(--away)" }}>
                        W
                      </span>
                    )}
                    <Link
                      href={`/teams/${g.away_team?.tcode}?season=${activeSeason}`}
                      className={`team-name away ${!homeWon ? "win" : ""}`}
                      style={{ color: g.away_team?.color }}
                    >
                      {g.away_team?.name ?? ""}
                    </Link>
                    <Link href={`/teams/${g.away_team?.tcode}?season=${activeSeason}`}>
                      <TeamBadge
                        team={g.away_team ? { name: g.away_team.name, abbr: g.away_team.abbr, color: g.away_team.color, logoUrl: g.away_team.logo_url } : null}
                      />
                    </Link>
                  </span>
                </span>
                <Link href={`/games/${g.gmkey}`} className="game-card-category">
                  {g.season_category}
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      <footer className="foot">
        {activeSeason} 시즌 · {games.length}경기 표시(최대 200경기) · Supabase 프로젝트
        &quot;who are u_kbl&quot;에서 실시간 조회
      </footer>
    </div>
  );
}
