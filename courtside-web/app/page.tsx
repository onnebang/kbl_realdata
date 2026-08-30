import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getSeasons, getTeamsForSeason, getGames, getPregameWinProbs, getGameMvps, getGameTags } from "@/lib/homeGames";

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
  const seasons = await getSeasons();
  const activeSeason = season ?? seasons[0];
  const [teamOptions, games] = await Promise.all([getTeamsForSeason(activeSeason), getGames(activeSeason, team)]);

  const gmkeys = games.map((g) => g.gmkey);
  const [winProbs, mvps, tags] = await Promise.all([getPregameWinProbs(gmkeys), getGameMvps(games), getGameTags(gmkeys)]);

  return (
    <div className="wrap">
      <div className="title">코트사이드</div>
      <div className="subtitle">
        Supabase에 실제로 적재된 KBL 경기 데이터를 직접 조회합니다 - 경기를 선택하면
        승률 그래프와 박스스코어를 볼 수 있어요. 팀 이름을 누르면 그 팀의 시즌 일정으로
        이동합니다.
      </div>

      <form className="filter-form">
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
        <button type="submit" className="btn-primary">
          보기
        </button>
      </form>

      <div className="game-list">
        {games.length === 0 && (
          <div className="empty-note">조건에 맞는 경기 데이터가 없음(마이그레이션 진행 중일 수 있음)</div>
        )}
        {games.map((g) => {
          const homeWon = (g.home_score ?? 0) > (g.away_score ?? 0);
          const homeProb = winProbs.get(g.gmkey);
          const mvp = mvps.get(g.gmkey);
          const tag = tags.get(g.gmkey);
          return (
            <div key={g.gmkey} className="game-card">
              <div className="game-card-row">
                <span className="game-card-date">{fmtDate(g.game_date)}</span>

                <span className={`result-badge ${homeWon ? "win" : "loss"}`} style={homeWon ? { background: g.home_team?.color } : undefined}>
                  {homeWon ? "W" : "L"}
                </span>
                <Link
                  href={`/teams/${g.home_team?.tcode}?season=${activeSeason}`}
                  className={`team-name home ${homeWon ? "win" : ""}`}
                  style={{ color: g.home_team?.color }}
                >
                  {g.home_team?.name ?? g.gmkey}
                </Link>
                <Link href={`/teams/${g.home_team?.tcode}?season=${activeSeason}`}>
                  <TeamBadge
                    team={g.home_team ? { name: g.home_team.name, abbr: g.home_team.abbr, color: g.home_team.color, logoUrl: g.home_team.logo_url } : null}
                  />
                </Link>

                <Link href={`/games/${g.gmkey}`} className="game-card-score">
                  <span className={homeWon ? "win" : "lose"}>{g.home_score}</span>
                  <span className="score-sep">-</span>
                  <span className={!homeWon ? "win" : "lose"}>{g.away_score}</span>
                </Link>

                <Link href={`/teams/${g.away_team?.tcode}?season=${activeSeason}`}>
                  <TeamBadge
                    team={g.away_team ? { name: g.away_team.name, abbr: g.away_team.abbr, color: g.away_team.color, logoUrl: g.away_team.logo_url } : null}
                  />
                </Link>
                <Link
                  href={`/teams/${g.away_team?.tcode}?season=${activeSeason}`}
                  className={`team-name away ${!homeWon ? "win" : ""}`}
                  style={{ color: g.away_team?.color }}
                >
                  {g.away_team?.name ?? ""}
                </Link>
                <span className={`result-badge ${!homeWon ? "win" : "loss"}`} style={!homeWon ? { background: g.away_team?.color } : undefined}>
                  {!homeWon ? "W" : "L"}
                </span>

                <span className="game-card-category-col">
                  <Link href={`/games/${g.gmkey}`} className="game-card-category">
                    {g.season_category}
                  </Link>
                  {tag && <span className={`ai-tag ai-tag-${tag.key}`}>{tag.label}</span>}
                </span>
              </div>

              <div className="game-card-meta">
                {homeProb != null && (
                  <span className="game-card-meta-item">
                    예상 승률 {g.home_team?.abbr} {Math.round(homeProb * 100)}% · {g.away_team?.abbr} {Math.round((1 - homeProb) * 100)}%
                  </span>
                )}
                {mvp && (
                  <span className="game-card-meta-item">
                    <Link href={`/players/${mvp.pcode}`} className="game-card-mvp">
                      MVP {mvp.name} {mvp.pts}점
                    </Link>
                  </span>
                )}
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
