import type { Metadata } from "next";
import Link from "next/link";
import { SeasonNav } from "@/components/SeasonNav";
import { TeamBadge } from "@/components/TeamBadge";
import { getTeams, shortSeason } from "@/lib/preseason";
import { getLeaderboardSeasons } from "@/lib/seasonLeaders";
import { getSeasonSchedule, type SeasonScheduleRow, type SeasonTeamRef } from "@/lib/seasonBrowser";
import { getStandingsAsOfCached } from "@/lib/teamPageData";
import { getTeamSeasonStats, getTeamQuarterSplits, REGULATION_QUARTERS, type TeamStatKey } from "@/lib/teamSeasonStats";
import { signed, signTone } from "@/lib/format";
import styles from "./standings.module.css";
import overview from "./team-overview.module.css";

const OVERVIEW_STAT_KEYS: TeamStatKey[] = ["net", "efg", "tpPct", "reb", "ast", "tov"];

export const dynamic = "force-dynamic";

type FormGame = {
  gmkey: string;
  result: "W" | "L";
  label: string;
};

type TeamPulse = {
  form: FormGame[];
  next: {
    gmkey: string;
    opponent: SeasonTeamRef;
    when: string;
    live: boolean;
  } | null;
};

function diffClass(value: number): string | undefined {
  const tone = signTone(value, 1);
  return tone === "pos" ? styles.pos : tone === "neg" ? styles.neg : undefined;
}

function streakText(streak: { result: "W" | "L"; length: number } | null): string {
  if (!streak) return "-";
  return `${streak.length}${streak.result === "W" ? "연승" : "연패"}`;
}

function streakClass(streak: { result: "W" | "L"; length: number } | null): string | undefined {
  if (!streak) return undefined;
  return streak.result === "W" ? styles.pos : styles.neg;
}

function kstToday(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shortDate(date: string): string {
  return date.slice(5).replace("-", ".");
}

function teamInGame(game: SeasonScheduleRow, tcode: string): boolean {
  return game.home_team?.tcode === tcode || game.away_team?.tcode === tcode;
}

function opponentInGame(game: SeasonScheduleRow, tcode: string): SeasonTeamRef {
  return game.home_team?.tcode === tcode ? game.away_team : game.home_team;
}

function buildTeamPulse(schedule: SeasonScheduleRow[], tcode: string): TeamPulse {
  const fixtures = schedule.filter((game) => teamInGame(game, tcode));
  const completed = fixtures.filter(
    (game) => game.is_ended && game.home_score != null && game.away_score != null
  );
  const form = completed.slice(-5).map((game) => {
    const isHome = game.home_team?.tcode === tcode;
    const teamScore = isHome ? game.home_score! : game.away_score!;
    const opponentScore = isHome ? game.away_score! : game.home_score!;
    const opponent = opponentInGame(game, tcode);
    const result: FormGame["result"] = teamScore > opponentScore ? "W" : "L";
    return {
      gmkey: game.gmkey,
      result,
      label: `${shortDate(game.game_date)} ${opponent?.name ?? "상대"}전 ${teamScore}-${opponentScore} ${result === "W" ? "승" : "패"}`,
    };
  });

  const today = kstToday();
  const nextGame = fixtures.find((game) => !game.is_ended && game.game_date >= today) ?? null;
  if (!nextGame) return { form, next: null };
  const opponent = opponentInGame(nextGame, tcode);
  const isHome = nextGame.home_team?.tcode === tcode;
  const live = nextGame.home_score != null;
  return {
    form,
    next: {
      gmkey: nextGame.gmkey,
      opponent,
      when: live
        ? "진행 중"
        : `${shortDate(nextGame.game_date)}${nextGame.game_start ? ` ${nextGame.game_start.slice(0, 5)}` : ""} · ${isHome ? "홈" : "원정"}`,
      live,
    },
  };
}

function RecentForm({ games }: { games: FormGame[] }) {
  if (!games.length) return <span className={styles.noData}>-</span>;
  return (
    <span className={styles.formChips} aria-label={`최근 ${games.length}경기`}>
      {games.map((game, index) => (
        <Link
          key={game.gmkey}
          href={`/games/${game.gmkey}`}
          className={`${styles.formChip} ${game.result === "W" ? styles.formWin : styles.formLoss} ${index === games.length - 1 ? styles.formLatest : ""}`}
          title={game.label}
          aria-label={game.label}
        >
          {game.result === "W" ? "승" : "패"}
        </Link>
      ))}
    </span>
  );
}

function NextGame({ pulse }: { pulse: TeamPulse }) {
  if (!pulse.next) return <span className={styles.noData}>일정 없음</span>;
  const opponent = pulse.next.opponent;
  const badge = opponent
    ? { name: opponent.name, abbr: opponent.abbr, color: opponent.color, logoUrl: opponent.logo_url }
    : null;
  return (
    <Link href={`/games/${pulse.next.gmkey}`} className={styles.nextGame}>
      <TeamBadge team={badge} size={20} />
      <span>
        <strong>{opponent?.abbr ?? opponent?.name ?? "상대"}</strong>
        <small className={pulse.next.live ? styles.live : undefined}>{pulse.next.when}</small>
      </span>
    </Link>
  );
}

export default async function TeamStandingsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season } = await searchParams;
  const seasons = await getLeaderboardSeasons();
  if (!seasons.length) {
    return (
      <div className="wrap">
        <div className="title">팀 순위</div>
        <div className="empty-note">종료된 정규시즌 경기가 아직 없어 순위표를 만들 수 없습니다.</div>
      </div>
    );
  }

  const requested = (season ?? "").trim();
  const activeSeason = seasons.includes(requested) ? requested : seasons[0];
  const [dbRows, teams, teamStats, quarterSplits, schedule] = await Promise.all([
    getStandingsAsOfCached(activeSeason, "9999-12-31"),
    getTeams(activeSeason),
    getTeamSeasonStats(activeSeason),
    getTeamQuarterSplits(activeSeason),
    getSeasonSchedule(activeSeason),
  ]);

  const activeTeams = [...teams.values()].filter((team) => !["30", "65", "73"].includes(team.tcode));
  const rows = activeTeams
    .map((team) => {
      const row = dbRows.find((item) => item.tcode === team.tcode);
      if (row) return { ...row };
      return {
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
      };
    })
    .sort((a, b) => {
      const aPlayed = a.wins + a.losses > 0;
      const bPlayed = b.wins + b.losses > 0;
      if (aPlayed !== bPlayed) return aPlayed ? -1 : 1;
      return b.pct - a.pct || b.diff - a.diff;
    });

  const leader = rows.find((row) => row.wins + row.losses > 0) ?? rows[0];
  if (leader) {
    const firstMargin = leader.wins - leader.losses;
    for (const row of rows) {
      row.gb = row.wins + row.losses === 0 ? 0 : Math.max(0, (firstMargin - (row.wins - row.losses)) / 2);
    }
  }

  const pulseByTeam = new Map(activeTeams.map((team) => [team.tcode, buildTeamPulse(schedule, team.tcode)]));
  const playedRows = rows.filter((row) => row.wins + row.losses > 0);
  const hottest = [...playedRows].sort((a, b) => {
    const aWins = pulseByTeam.get(a.tcode)?.form.filter((game) => game.result === "W").length ?? 0;
    const bWins = pulseByTeam.get(b.tcode)?.form.filter((game) => game.result === "W").length ?? 0;
    return bWins - aWins || (b.streak?.result === "W" ? b.streak.length : 0) - (a.streak?.result === "W" ? a.streak.length : 0);
  })[0];
  const marginLeader = [...playedRows].sort((a, b) => b.diff - a.diff)[0];
  const raceCount = leader ? playedRows.filter((row) => row.gb <= 2).length : 0;
  const rankedTeams = [...activeTeams].sort((a, b) => rows.findIndex((row) => row.tcode === a.tcode) - rows.findIndex((row) => row.tcode === b.tcode));

  return (
    <div className="wrap">
      <SeasonNav
        active="teams"
        activeSeason={activeSeason}
        seasons={seasons}
        action="/rankings/teams"
        kicker="LEAGUE STANDINGS"
        title="팀 순위"
        description={`${shortSeason(activeSeason)} 정규시즌 순위와 최근 흐름, 다음 경기, 팀 스타일을 한 화면에서 비교합니다.`}
      />

      {playedRows.length > 0 && (
        <section className={styles.pulseGrid} aria-label="리그 현황 요약">
          <article className={styles.pulseCard}>
            <span>현재 1위</span>
            <strong>{teams.get(leader.tcode)?.name ?? leader.tcode}</strong>
            <small>{leader.wins}승 {leader.losses}패 · {(leader.pct * 100).toFixed(1)}%</small>
          </article>
          <article className={styles.pulseCard}>
            <span>최근 흐름</span>
            <strong>{hottest ? teams.get(hottest.tcode)?.name ?? hottest.tcode : "-"}</strong>
            <small>{hottest ? `${pulseByTeam.get(hottest.tcode)?.form.filter((game) => game.result === "W").length ?? 0}승 / 최근 5경기` : "기록 없음"}</small>
          </article>
          <article className={styles.pulseCard}>
            <span>최고 득실마진</span>
            <strong>{marginLeader ? teams.get(marginLeader.tcode)?.name ?? marginLeader.tcode : "-"}</strong>
            <small>{marginLeader ? `${signed(marginLeader.diff, 1)}점 / 경기` : "기록 없음"}</small>
          </article>
          <article className={styles.pulseCard}>
            <span>선두 경쟁</span>
            <strong>{raceCount}팀</strong>
            <small>1위와 2경기 이내</small>
          </article>
        </section>
      )}

      {!rows.length ? (
        <div className="empty-note">{activeSeason} 시즌 정규시즌 기록을 찾지 못했습니다.</div>
      ) : (
        <>
          <section className={styles.standingsSection} aria-labelledby="standings-title">
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.sectionKicker}>STANDINGS &amp; FORM</span>
                <h2 id="standings-title">순위와 최근 흐름</h2>
              </div>
              <div className={styles.zoneLegend} aria-label="플레이오프 구간">
                <span><i className={styles.directDot} />1–2위 4강 직행</span>
                <span><i className={styles.playoffDot} />3–6위 6강 PO</span>
              </div>
            </div>

            <div className={styles.desktopStandings}>
              <table className={styles.standingsTable}>
                <thead>
                  <tr>
                    <th>순위</th>
                    <th>팀</th>
                    <th>경기</th>
                    <th>승-패</th>
                    <th>승률</th>
                    <th>게임차</th>
                    <th>연속</th>
                    <th>최근 5경기</th>
                    <th>득실</th>
                    <th>다음 경기</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => {
                    const team = teams.get(row.tcode);
                    const badge = team ? { name: team.name, abbr: team.abbr, color: team.color, logoUrl: team.logoUrl } : null;
                    const gamesPlayed = row.wins + row.losses;
                    const pulse = pulseByTeam.get(row.tcode) ?? { form: [], next: null };
                    return (
                      <tr key={row.tcode} className={index < 2 ? styles.directRow : index < 6 ? styles.playoffRow : undefined}>
                        <td className={styles.rankCell}>{index + 1}</td>
                        <td className={styles.teamCell}>
                          <TeamBadge team={badge} size={28} />
                          <Link href={`/teams/${row.tcode}`}>{team?.name ?? row.tcode}</Link>
                        </td>
                        <td>{gamesPlayed}</td>
                        <td><strong>{row.wins}-{row.losses}</strong></td>
                        <td className={styles.pct}>{gamesPlayed ? (row.pct * 100).toFixed(1) : "0.0"}%</td>
                        <td>{gamesPlayed === 0 || row.gb === 0 ? "-" : row.gb.toFixed(1)}</td>
                        <td className={streakClass(row.streak)}>{streakText(row.streak)}</td>
                        <td><RecentForm games={pulse.form} /></td>
                        <td className={diffClass(row.diff)}>{gamesPlayed ? signed(row.diff, 1) : "-"}</td>
                        <td><NextGame pulse={pulse} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className={styles.mobileStandings}>
              {rows.map((row, index) => {
                const team = teams.get(row.tcode);
                const badge = team ? { name: team.name, abbr: team.abbr, color: team.color, logoUrl: team.logoUrl } : null;
                const gamesPlayed = row.wins + row.losses;
                const pulse = pulseByTeam.get(row.tcode) ?? { form: [], next: null };
                return (
                  <article key={row.tcode} className={`${styles.mobileRow} ${index < 2 ? styles.directRow : index < 6 ? styles.playoffRow : ""}`}>
                    <span className={styles.mobileRank}>{index + 1}</span>
                    <div className={styles.mobileTeam}>
                      <div className={styles.mobileTeamHead}>
                        <TeamBadge team={badge} size={28} />
                        <Link href={`/teams/${row.tcode}`}>{team?.name ?? row.tcode}</Link>
                      </div>
                      <div className={styles.mobileMeta}>
                        <strong>{row.wins}승 {row.losses}패</strong>
                        <span>{gamesPlayed ? (row.pct * 100).toFixed(1) : "0.0"}%</span>
                        <span className={streakClass(row.streak)}>{streakText(row.streak)}</span>
                      </div>
                    </div>
                    <div className={styles.mobileForm}>
                      <RecentForm games={pulse.form} />
                      <NextGame pulse={pulse} />
                    </div>
                  </article>
                );
              })}
            </div>

            <div className={styles.methodNote}>
              <strong>순위 기준</strong> 승률 → 득실마진 순. 공식 동률 타이브레이커(상대 전적 등)는 반영하지 않습니다.
              게임차는 (승수 차 + 패수 차) ÷ 2, 득실은 경기당 평균입니다.
            </div>
          </section>

          <div className={overview.sectionHead}>
            <div>
              <span className={styles.sectionKicker}>TEAM STYLE MATRIX</span>
              <h2 className={styles.overviewTitle}>10개 팀 스타일 비교</h2>
            </div>
            <span className={styles.sectionDescription}>공격 효율·슈팅·리바운드·소유 지표와 쿼터별 득실 흐름</span>
          </div>
          <div className={overview.grid}>
            {rankedTeams.map((team) => {
              const row = rows.find((item) => item.tcode === team.tcode);
              const stat = teamStats?.byTcode[team.tcode];
              const badge = { name: team.name, abbr: team.abbr, color: team.color, logoUrl: team.logoUrl };
              const quarter = quarterSplits?.[team.tcode];
              const rank = rows.findIndex((item) => item.tcode === team.tcode) + 1;
              return (
                <Link key={team.tcode} href={`/teams/${team.tcode}`} className={overview.card}>
                  <div className={overview.cardHead}>
                    <span className={overview.rankBadge}>{rank}</span>
                    <TeamBadge team={badge} size={30} />
                    <div>
                      <div className={overview.cardName}>{team.name}</div>
                      <div className={overview.cardRecord}>
                        {row && row.wins + row.losses > 0 ? `${row.wins}승 ${row.losses}패 · ${(row.pct * 100).toFixed(1)}%` : "아직 치른 경기 없음"}
                      </div>
                    </div>
                  </div>

                  {stat ? (
                    <div className={overview.statGrid}>
                      {OVERVIEW_STAT_KEYS.map((key) => {
                        const cell = stat.cellByKey[key];
                        if (!cell) return null;
                        return (
                          <div key={key} className={overview.statCell}>
                            <span className={overview.statLabel}>{cell.label}</span>
                            <strong className={cell.better === null ? undefined : cell.better ? overview.pos : overview.neg}>{cell.display}</strong>
                            <span className={overview.statRank}>{cell.rankLabel}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="empty-note">경기 기록이 쌓이면 지표가 표시됩니다.</div>
                  )}

                  {quarter && (
                    <div className={overview.quarters}>
                      <span className={overview.quarterCaption}>쿼터별 평균 득실차</span>
                      <div className={overview.quarterBars}>
                        {REGULATION_QUARTERS.map((q) => {
                          const value = quarter.quarters[q];
                          const tone = value > 0.1 ? overview.pos : value < -0.1 ? overview.neg : undefined;
                          return (
                            <div key={q} className={overview.quarterBar}>
                              <span className={overview.quarterLabel}>{q}</span>
                              <span className={tone}>{signed(value, 1)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <span className={overview.cta}>24개 팀 지표 자세히 보기 →</span>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export const metadata: Metadata = {
  title: "팀 순위",
  description: "KBL 정규시즌 팀 순위, 최근 5경기, 다음 경기, 10개 구단 스타일 비교",
};
