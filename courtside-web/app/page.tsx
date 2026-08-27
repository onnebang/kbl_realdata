import Link from "next/link";
import { supabase } from "@/lib/supabase";

type TeamRef = {
  tcode: string;
  name: string;
  abbr: string;
  color: string;
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

async function getSeasons() {
  const { data } = await supabase
    .from("seasons")
    .select("season_name")
    .order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

async function getGames(seasonName: string | undefined) {
  let query = supabase
    .from("games")
    .select(
      `gmkey, game_date, home_score, away_score, season_category, season_name,
       home_team:teams!games_home_tcode_fkey(tcode, name, abbr, color),
       away_team:teams!games_away_tcode_fkey(tcode, name, abbr, color)`
    )
    .not("home_score", "is", null)
    .order("game_date", { ascending: false })
    .limit(200);

  if (seasonName) query = query.eq("season_name", seasonName);

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
  searchParams: Promise<{ season?: string }>;
}) {
  const { season } = await searchParams;
  const seasons = await getSeasons();
  const activeSeason = season ?? seasons[0];
  const games = await getGames(activeSeason);

  return (
    <div className="wrap">
      <div className="title">코트사이드</div>
      <div className="subtitle">
        Supabase에 실제로 적재된 KBL 경기 데이터를 직접 조회합니다 - 경기를 선택하면
        승률 그래프와 박스스코어를 볼 수 있어요.
      </div>

      <form style={{ marginTop: 18, display: "flex", gap: 8 }}>
        <select name="season" defaultValue={activeSeason}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s} 시즌
            </option>
          ))}
        </select>
        <button type="submit" className="back-link" style={{ cursor: "pointer" }}>
          시즌 보기
        </button>
      </form>

      <div className="game-list">
        {games.length === 0 && (
          <div className="empty-note">이 시즌 경기 데이터가 아직 없음(마이그레이션 진행 중일 수 있음)</div>
        )}
        {games.map((g) => (
          <Link key={g.gmkey} href={`/games/${g.gmkey}`} className="game-card">
            <div className="game-card-row">
              <span className="game-card-date">{fmtDate(g.game_date)}</span>
              <span className="game-card-teams">
                <span className="team-name home">{g.home_team?.name ?? g.gmkey}</span>
                <span className="game-card-score">
                  {g.home_score} - {g.away_score}
                </span>
                <span className="team-name away">{g.away_team?.name ?? ""}</span>
              </span>
              <span className="game-card-category">{g.season_category}</span>
            </div>
          </Link>
        ))}
      </div>

      <footer className="foot">
        {activeSeason} 시즌 · {games.length}경기 표시(최대 200경기) · Supabase 프로젝트
        &quot;who are u_kbl&quot;에서 실시간 조회
      </footer>
    </div>
  );
}
