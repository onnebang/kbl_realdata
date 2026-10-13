import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { SeasonNav } from "@/components/SeasonNav";
import { TeamPlate } from "@/components/TeamPlate";
import { getTeams, shortSeason } from "@/lib/preseason";
import { getLeaderboardSeasons, getSeasonLeaderboards } from "@/lib/seasonLeaders";
import { getStandingsAsOfCached } from "@/lib/teamPageData";
import { getRoundAwards } from "@/lib/roundAwards";
import { getSeasonSchedule, type SeasonScheduleRow, type SeasonTeamRef } from "@/lib/seasonBrowser";
import { signed, signTone } from "@/lib/format";
import { teamBarStyle } from "@/lib/teamAccent";
import hub from "./season-hub.module.css";

export const dynamic = "force-dynamic";

function diffClass(value: number): string | undefined {
  const tone = signTone(value, 1);
  return tone === "pos" ? hub.pos : tone === "neg" ? hub.neg : undefined;
}

function kstToday(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shortDate(date: string): string {
  return date.slice(5).replace("-", ".");
}

function teamBadge(team: SeasonTeamRef) {
  if (!team) return null;
  return { name: team.name, abbr: team.abbr, color: team.color, logoUrl: team.logo_url };
}

function GameLine({ game, mode }: { game: SeasonScheduleRow; mode: "upcoming" | "result" }) {
  const score = game.home_score != null && game.away_score != null ? `${game.away_score} : ${game.home_score}` : null;
  return (
    <Link href={`/games/${game.gmkey}`} className={hub.gameLine}>
      <div className={hub.gameWhen}>
        <strong>{shortDate(game.game_date)}</strong>
        <span>{mode === "result" ? "종료" : game.game_start?.slice(0, 5) ?? "시간 미정"}</span>
      </div>
      <div className={hub.gameMatchup}>
        <span><TeamPlate team={teamBadge(game.away_team)} size={20} />{game.away_team?.abbr ?? "원정"}</span>
        <b>{score ?? "vs"}</b>
        <span>{game.home_team?.abbr ?? "홈"}<TeamPlate team={teamBadge(game.home_team)} size={20} /></span>
      </div>
      <span className={hub.gameArrow}>→</span>
    </Link>
  );
}

export default async function SeasonHubPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season } = await searchParams;
  const seasons = await getLeaderboardSeasons();
  if (!seasons.length) {
    return (
      <div className="wrap">
        <div className="title">시즌 홈</div>
        <div className="empty-note">종료된 정규시즌 경기가 아직 없어 시즌 현황을 만들 수 없습니다.</div>
      </div>
    );
  }

  const requested = (season ?? "").trim();
  const activeSeason = seasons.includes(requested) ? requested : seasons[0];
  const fellBack = requested && requested !== activeSeason ? requested : null;
  const qs = `season=${encodeURIComponent(activeSeason)}`;

  const [dbStandings, teams, leaders, awards, schedule] = await Promise.all([
    getStandingsAsOfCached(activeSeason, "9999-12-31"),
    getTeams(activeSeason),
    getSeasonLeaderboards(activeSeason, { categories: ["totalPts", "totalReb", "totalAst"], topN: 5 }),
    getRoundAwards(activeSeason),
    getSeasonSchedule(activeSeason),
  ]);

  const activeTeams = [...teams.values()].filter((team) => !["30", "65", "73"].includes(team.tcode));
  const standings = activeTeams
    .map((team) => dbStandings.find((row) => row.tcode === team.tcode) ?? {
      tcode: team.tcode,
      wins: 0,
      losses: 0,
      pct: 0,
      gb: 0,
      streak: null,
      last10: { wins: 0, losses: 0 },
      home: { wins: 0, losses: 0 },
      away: { wins: 0, losses: 0 },
      diff: 0,
    })
    .sort((a, b) => {
      const aPlayed = a.wins + a.losses > 0;
      const bPlayed = b.wins + b.losses > 0;
      if (aPlayed !== bPlayed) return aPlayed ? -1 : 1;
      return b.pct - a.pct || b.diff - a.diff;
    });

  const leader = standings.find((row) => row.wins + row.losses > 0) ?? standings[0];
  const completed = schedule.filter((game) => game.is_ended && game.home_score != null && game.away_score != null);
  const recentGames = completed.slice(-3).reverse();
  const today = kstToday();
  const upcomingGames = schedule.filter((game) => !game.is_ended && game.game_date >= today).slice(0, 3);
  const closeGames = completed.filter((game) => Math.abs((game.home_score ?? 0) - (game.away_score ?? 0)) <= 5).length;
  const scoringLeader = leaders?.boards.find((board) => board.key === "totalPts")?.rows[0] ?? null;

  return (
    <div className="wrap">
      <SeasonNav
        active="overview"
        activeSeason={activeSeason}
        seasons={seasons}
        action="/season"
        kicker="SEASON CENTER"
        title="시즌 홈"
        description={`${shortSeason(activeSeason)} 시즌의 순위 경쟁, 다음 경기, 주요 리더와 라운드 MVP를 한 번에 확인합니다.`}
      />

      {fellBack && (
        <div className={hub.fallback}>
          {fellBack} 시즌에는 종료된 정규시즌 경기가 없어, 최근 시즌 <strong>{activeSeason}</strong>을 보여드립니다.
        </div>
      )}

      <section className={hub.snapshot} aria-label="시즌 핵심 현황">
        <article>
          <span>진행된 경기</span>
          <strong>{completed.length}</strong>
          <small>정규시즌 종료 경기</small>
        </article>
        <article>
          <span>현재 선두</span>
          <strong>{leader ? teams.get(leader.tcode)?.abbr ?? leader.tcode : "-"}</strong>
          <small>{leader ? `${leader.wins}승 ${leader.losses}패 · ${(leader.pct * 100).toFixed(1)}%` : "기록 없음"}</small>
        </article>
        <article>
          <span>5점 차 이내</span>
          <strong>{completed.length ? Math.round((closeGames / completed.length) * 100) : 0}%</strong>
          <small>{closeGames}경기 · 접전 비율</small>
        </article>
        <article>
          <span>득점 선두</span>
          <strong>{scoringLeader?.name ?? "-"}</strong>
          <small>{scoringLeader ? `${scoringLeader.display}점 · ${scoringLeader.teamAbbr}` : "기록 없음"}</small>
        </article>
      </section>

      <div className={hub.dashboardGrid}>
        <section className={hub.panel}>
          <header className={hub.panelHead}>
            <div>
              <span className={hub.eyebrow}>STANDINGS</span>
              <h2>순위 경쟁</h2>
            </div>
            <Link href={`/rankings/teams?${qs}`}>전체 순위·최근 5경기 →</Link>
          </header>
          <div className={hub.standingsList}>
            {standings.map((row, index) => {
              const team = teams.get(row.tcode);
              const badge = team ? { name: team.name, abbr: team.abbr, color: team.color, logoUrl: team.logoUrl } : null;
              const played = row.wins + row.losses;
              return (
                <Link
                  key={row.tcode}
                  href={`/teams/${row.tcode}`}
                  className={hub.standingRow}
                  style={{ ...teamBarStyle(team?.color), "--w": `${(played ? row.pct : 0) * 100}%`, "--i": index } as CSSProperties}
                >
                  <span className={`${hub.rank} ${index < 2 ? hub.rankDirect : index < 6 ? hub.rankPlayoff : ""}`}>{index + 1}</span>
                  <span className={hub.teamName}><TeamPlate team={badge} size={22} />{team?.name ?? row.tcode}</span>
                  <span className={hub.record}>{row.wins}-{row.losses}</span>
                  <strong>{played ? (row.pct * 100).toFixed(1) : "0.0"}%</strong>
                  <span className={diffClass(row.diff)}>{played ? signed(row.diff, 1) : "-"}</span>
                </Link>
              );
            })}
          </div>
          <div className={hub.panelLegend}><span className={hub.directKey} />4강 직행 <span className={hub.playoffKey} />6강 PO</div>
        </section>

        <section className={hub.panel}>
          <header className={hub.panelHead}>
            <div>
              <span className={hub.eyebrow}>GAMES</span>
              <h2>다음 경기와 최근 결과</h2>
            </div>
            <Link href={`/season-browser?${qs}`}>전체 일정·결과 →</Link>
          </header>
          <div className={hub.gameGroup}>
            <h3>다음 경기</h3>
            {upcomingGames.length ? upcomingGames.map((game) => <GameLine key={game.gmkey} game={game} mode="upcoming" />) : <p className={hub.empty}>남은 정규시즌 일정이 없습니다.</p>}
          </div>
          <div className={hub.gameGroup}>
            <h3>최근 결과</h3>
            {recentGames.length ? recentGames.map((game) => <GameLine key={game.gmkey} game={game} mode="result" />) : <p className={hub.empty}>아직 종료된 경기가 없습니다.</p>}
          </div>
        </section>
      </div>

      <section className={hub.section}>
        <header className={hub.sectionHead}>
          <div>
            <span className={hub.eyebrow}>SEASON LEADERS</span>
            <h2>시즌을 만드는 선수들</h2>
            <p>시즌 초반 왜곡이 적은 누적 총량 기준입니다. 경기당 평균·슈팅 효율·고급 지표도 별도 제공합니다.</p>
          </div>
          <Link href={`/leaderboards/season?${qs}`}>모든 부문 보기 →</Link>
        </header>
        {!leaders ? (
          <div className="empty-note">아직 리더보드를 만들 수 없습니다.</div>
        ) : (
          <div className={hub.leaderGrid}>
            {leaders.boards.map((board) => {
              const top = board.rows[0];
              return (
                <article key={board.key} className={hub.leaderCard}>
                  <header><h3>{board.label}</h3><span>{board.unit}</span></header>
                  {top ? (
                    <>
                      <Link href={top.href} className={hub.leaderHero}>
                        <span className={hub.leaderValue}>{top.display}</span>
                        <span><strong>{top.name}</strong><small>{top.teamAbbr} · {top.posLabel} · {top.sample}</small></span>
                      </Link>
                      <div className={hub.leaderRows}>
                        {board.rows.slice(1, 5).map((row) => (
                          <Link key={row.pcode} href={row.href}><span>{row.rank}</span><strong>{row.name}</strong><b>{row.display}</b></Link>
                        ))}
                      </div>
                    </>
                  ) : <p className={hub.empty}>아직 기록이 없습니다.</p>}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className={hub.section}>
        <header className={hub.sectionHead}>
          <div>
            <span className={hub.eyebrow}>ROUND MVP</span>
            <h2>{awards.round}라운드 퍼포머</h2>
            <p>종료 경기 {awards.gamesEnded}/{awards.gamesTotal} · 국내·용병·아시아쿼터를 같은 화면에서 비교합니다.</p>
          </div>
          <Link href={`/awards/round?${qs}`}>라운드 전체 보기 →</Link>
        </header>
        {awards.gamesEnded === 0 ? (
          <div className="empty-note">이 라운드는 아직 끝난 경기가 없습니다.</div>
        ) : (
          <div className={hub.mvpGrid}>
            {awards.mvpBoards.map((board) => {
              const player = board.rows[0];
              return (
                <article key={board.role} className={hub.mvpCard}>
                  <span>{board.label} MVP</span>
                  {player ? (
                    <Link href={`/players/${player.pcode}`}>
                      <strong>{player.name}</strong>
                      <small>{player.team?.abbr} · {player.posLabel}</small>
                      <b>{player.perW.toFixed(1)} <em>PER</em></b>
                    </Link>
                  ) : <p className={hub.empty}>자격을 통과한 선수가 없습니다.</p>}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export const metadata: Metadata = {
  title: "시즌 홈",
  description: "KBL 시즌 순위, 일정과 결과, 시즌 리더, 라운드 MVP를 한 화면에서 확인",
};
