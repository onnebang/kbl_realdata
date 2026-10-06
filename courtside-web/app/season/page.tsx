import type { Metadata } from "next";
import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getTeams, shortSeason } from "@/lib/preseason";
import { getLeaderboardSeasons, getSeasonLeaderboards } from "@/lib/seasonLeaders";
import { getStandingsAsOfCached } from "@/lib/teamPageData";
import { getRoundAwards } from "@/lib/roundAwards";
import { getSeasonGames } from "@/lib/seasonBrowser";
import { signed, signTone } from "@/lib/format";
import styles from "@/app/leaderboards/season/season-leaders.module.css";
import hub from "./season-hub.module.css";

// 시즌 허브(2026-10-06, 사용자 요청) - 팀 순위/시즌 리더보드/라운드 MVP/최근 경기를 한 화면에
// 요약해서 모아 보여준다. 각 섹션은 기존 전용 페이지(/rankings/teams, /leaderboards/season,
// /awards/round, /season-browser)가 쓰는 lib 함수를 그대로 재사용한 "미리보기"이고, 전체
// 표/필터는 "전체 보기" 링크로 기존 페이지에 그대로 넘긴다 - 안정적으로 돌고 있는 4개 페이지의
// 로직을 복제하거나 바꾸지 않는다.
export const dynamic = "force-dynamic";

function diffClass(v: number): string | undefined {
  const t = signTone(v, 1);
  return t === "pos" ? hub.pos : t === "neg" ? hub.neg : undefined;
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
        <div className="title">시즌 허브</div>
        <div className="empty-note">종료된 정규시즌 경기가 아직 없어 시즌 허브를 만들 수 없습니다.</div>
      </div>
    );
  }
  const requested = (season ?? "").trim();
  const activeSeason = seasons.includes(requested) ? requested : seasons[0];
  const fellBack = requested && requested !== activeSeason ? requested : null;
  const qs = `season=${encodeURIComponent(activeSeason)}`;

  const [standings, teams, leaders, awards, games] = await Promise.all([
    getStandingsAsOfCached(activeSeason, "9999-12-31"),
    getTeams(activeSeason),
    getSeasonLeaderboards(activeSeason, { categories: ["pts", "reb", "ast"], topN: 3 }),
    getRoundAwards(activeSeason),
    getSeasonGames(activeSeason),
  ]);

  const recentGames = [...games].reverse().slice(0, 6);

  return (
    <div className="wrap">
      <div className={styles.headRow}>
        <div>
          <span className={styles.kicker}>SEASON HUB</span>
          <div className="title">시즌 허브</div>
        </div>
        <form className={styles.seasonForm} action="/season">
          <select name="season" defaultValue={activeSeason} aria-label="시즌 선택">
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s} 시즌
              </option>
            ))}
          </select>
          <button type="submit" className="btn-primary">
            시즌 보기
          </button>
        </form>
      </div>

      <p className="lede">{shortSeason(activeSeason)} 시즌 요약입니다. 각 섹션의 &ldquo;전체 보기&rdquo;에서 상세 페이지로 이동합니다.</p>

      {fellBack && (
        <div className={styles.fallback}>
          {fellBack} 시즌은 아직 종료된 정규시즌 경기가 없어 가장 최근 시즌인 <strong>{activeSeason}</strong> 기록을 보여줍니다.
        </div>
      )}

      <div className={hub.sectionHead}>
        <h2 className={styles.groupName}>팀 순위</h2>
        <Link href={`/rankings/teams?${qs}`} className={hub.seeAll}>
          전체 보기 →
        </Link>
      </div>
      {!standings.length ? (
        <div className="empty-note">아직 순위표를 만들 수 없습니다.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>팀</th>
                <th>승</th>
                <th>패</th>
                <th>승률</th>
                <th>연속</th>
                <th>득실마진</th>
              </tr>
            </thead>
            <tbody>
              {standings.slice(0, 6).map((r, i) => {
                const tm = teams.get(r.tcode);
                const badge = tm ? { name: tm.name, abbr: tm.abbr, color: tm.color, logoUrl: tm.logoUrl } : null;
                return (
                  <tr key={r.tcode}>
                    <td>{i + 1}</td>
                    <td className={hub.teamCell}>
                      <TeamBadge team={badge} size={18} />
                      <Link href={`/teams/${r.tcode}`}>{tm?.name ?? r.tcode}</Link>
                    </td>
                    <td>{r.wins}</td>
                    <td>{r.losses}</td>
                    <td>{(r.pct * 100).toFixed(1)}%</td>
                    <td>{r.streak ? `${r.streak.length}${r.streak.result === "W" ? "연승" : "연패"}` : "-"}</td>
                    <td className={diffClass(r.diff)}>{signed(r.diff, 1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className={hub.sectionHead}>
        <h2 className={styles.groupName}>시즌 리더보드</h2>
        <Link href={`/leaderboards/season?${qs}`} className={hub.seeAll}>
          전체 보기 →
        </Link>
      </div>
      {!leaders ? (
        <div className="empty-note">아직 리더보드를 만들 수 없습니다.</div>
      ) : (
        <div className={styles.grid}>
          {leaders.boards.map((b) => (
            <section key={b.key} className={styles.card}>
              <header className={styles.cardHead}>
                <h3 className={styles.cardTitle}>{b.label}</h3>
                <span className={styles.cardPool}>{b.unit}</span>
              </header>
              {b.rows.length === 0 ? (
                <div className={styles.note}>자격을 통과한 선수가 없습니다.</div>
              ) : (
                <div className={styles.rows}>
                  {b.rows.map((r, i) => (
                    <Link key={r.pcode} href={`/players/${r.pcode}`} className={styles.row}>
                      <div className={styles.rank}>{i + 1}</div>
                      <div className={styles.rowBody}>
                        <div className={styles.rowName}>{r.name}</div>
                        <div className={styles.rowSub}>{[r.teamAbbr, r.posLabel || null].filter(Boolean).join(" · ")}</div>
                      </div>
                      <div className={styles.rowValue}>{b.unit === "%" ? `${r.display}%` : r.display}</div>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      <div className={hub.sectionHead}>
        <h2 className={styles.groupName}>라운드 MVP</h2>
        <Link href={`/awards/round?${qs}`} className={hub.seeAll}>
          전체 보기 →
        </Link>
      </div>
      {awards.gamesEnded === 0 ? (
        <div className="empty-note">이 라운드는 아직 끝난 경기가 없습니다.</div>
      ) : (
        <>
          <div className={hub.roundMeta}>
            {awards.round}라운드 ({awards.roundCount}라운드 중) · 종료 경기 {awards.gamesEnded}/{awards.gamesTotal}
          </div>
          <div className={styles.grid}>
            {awards.mvpBoards.map((b) => (
              <section key={b.role} className={styles.card}>
                <header className={styles.cardHead}>
                  <h3 className={styles.cardTitle}>{b.label} MVP</h3>
                </header>
                {b.rows.length === 0 ? (
                  <div className={styles.note}>자격을 통과한 선수가 없습니다.</div>
                ) : (
                  <Link href={`/players/${b.rows[0].pcode}`} className={hub.mvpLine}>
                    <strong>{b.rows[0].name}</strong>
                    <span>{[b.rows[0].team?.abbr, b.rows[0].posLabel || null].filter(Boolean).join(" · ")}</span>
                    <span className={hub.mvpValue}>{b.rows[0].perW.toFixed(1)} PER</span>
                  </Link>
                )}
              </section>
            ))}
          </div>
        </>
      )}

      <div className={hub.sectionHead}>
        <h2 className={styles.groupName}>최근 경기</h2>
        <Link href={`/season-browser?${qs}`} className={hub.seeAll}>
          시즌 브라우저 전체 보기 →
        </Link>
      </div>
      {!recentGames.length ? (
        <div className="empty-note">아직 끝난 경기가 없습니다.</div>
      ) : (
        <div className={hub.gameList}>
          {recentGames.map((g) => (
            <Link key={g.gmkey} href={`/games/${g.gmkey}`} className={hub.gameRow}>
              <span className={hub.gameDate}>{g.game_date.slice(5)}</span>
              <span className={hub.gameTeams}>
                {g.away_team?.name ?? g.away_team?.tcode} {g.away_score} : {g.home_score} {g.home_team?.name ?? g.home_team?.tcode}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export const metadata: Metadata = {
  title: "시즌 허브",
  description: "팀 순위, 시즌 리더보드, 라운드 MVP, 최근 경기를 한 화면에 모아 보기",
};
