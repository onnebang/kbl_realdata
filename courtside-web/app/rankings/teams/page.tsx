import type { Metadata } from "next";
import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getTeams, shortSeason } from "@/lib/preseason";
import { getLeaderboardSeasons } from "@/lib/seasonLeaders";
import { getStandingsAsOfCached } from "@/lib/teamPageData";
import { getTeamSeasonStats, getTeamQuarterSplits, REGULATION_QUARTERS, type TeamStatKey } from "@/lib/teamSeasonStats";
import { signed, signTone } from "@/lib/format";
import styles from "./standings.module.css";
import overview from "./team-overview.module.css";

// 팀 전체 개요 그리드에 쓸 축약 지표 - 전체 24개 지표(lib/teamSeasonStats.ts TEAM_STAT_DEFS)
// 중 "팀 색깔"을 한눈에 보여줄 6개만 고른다. 전체 표는 각 팀 상세 페이지(/teams/[tcode])에
// 이미 있으니 여기서 중복으로 다 보여줄 필요 없음.
const OVERVIEW_STAT_KEYS: TeamStatKey[] = ["net", "efg", "tpPct", "reb", "ast", "tov"];

// 팀 순위 테이블(승-패 기반 실제 스탠딩). 기존 "TEAM POWER RANKINGS"(OVR 전력 평가)는 전혀
// 다른 개념이라 /rankings/power로 옮겼고, 이 자리는 이제 진짜 순위표다.
//
// 2026-10-06(사용자 요청, "팀 순위 고도화 - 쿼터별 팀 분위기, 슈팅 구성비율 등 10개구단이
// 전체적으로 보이게, 팀 자세히 보기로 유도") - 순위표 아래에 10개 팀 카드 그리드를 더했다.
// 슈팅·리바운드·소유 지표는 getTeamSeasonStats(팀 상세 페이지와 같은 데이터 - 이미 전체
// 24개 지표에 리그 순위까지 계산해 둔다, 여기선 6개만 추림)를 그대로 재사용. 쿼터별 분위기는
// 기존 데이터에 없어 새로 추가(getTeamQuarterSplits, game_events의 쿼터 종료 시점 점수차를
// 집계). 각 카드는 그 팀 상세 페이지로 링크해 "자세히 보기"로 자연스럽게 넘어가게 했다.
export const dynamic = "force-dynamic";

function diffClass(v: number): string | undefined {
  const t = signTone(v, 1);
  return t === "pos" ? styles.pos : t === "neg" ? styles.neg : undefined;
}

function streakText(streak: { result: "W" | "L"; length: number } | null): string {
  if (!streak) return "-";
  return `${streak.length}${streak.result === "W" ? "연승" : "연패"}`;
}

function streakClass(streak: { result: "W" | "L"; length: number } | null): string | undefined {
  if (!streak) return undefined;
  return streak.result === "W" ? styles.pos : styles.neg;
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

  const [dbRows, teams, teamStats, quarterSplits] = await Promise.all([
    getStandingsAsOfCached(activeSeason, "9999-12-31"),
    getTeams(activeSeason),
    getTeamSeasonStats(activeSeason),
    getTeamQuarterSplits(activeSeason),
  ]);

  const activeTeams = [...teams.values()].filter((tm) => !["30", "65", "73"].includes(tm.tcode));
  const rows = activeTeams
    .map((tm) => {
      const r = dbRows.find((row) => row.tcode === tm.tcode);
      if (r) return { ...r };
      return {
        tcode: tm.tcode,
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
      if (b.pct !== a.pct) return b.pct - a.pct;
      return b.diff - a.diff;
    });

  if (rows.length > 0) {
    const firstMargin = rows[0].wins - rows[0].losses;
    for (const r of rows) {
      r.gb = Math.max(0, (firstMargin - (r.wins - r.losses)) / 2);
    }
  }

  return (
    <div className="wrap">
      <div className={styles.headRow}>
        <div>
          <span className={styles.kicker}>LEAGUE STANDINGS</span>
          <div className="title">팀 순위</div>
        </div>
        <form className={styles.seasonForm} action="/rankings/teams">
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

      <p className="lede">
        {shortSeason(activeSeason)} 정규시즌 전적입니다. 동률 시 공식 타이브레이커(상대 전적
        등)는 반영하지 않고 승률 → 득실마진 순으로만 정렬했습니다.
      </p>



      {!rows.length ? (
        <div className="empty-note">{activeSeason} 시즌 정규시즌 기록을 찾지 못했습니다.</div>
      ) : (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>팀</th>
                  <th>경기</th>
                  <th>승</th>
                  <th>패</th>
                  <th>승률</th>
                  <th>게임차</th>
                  <th>연속</th>
                  <th>최근10경기</th>
                  <th>홈</th>
                  <th>원정</th>
                  <th>득실마진</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const tm = teams.get(r.tcode);
                  const badge = tm ? { name: tm.name, abbr: tm.abbr, color: tm.color, logoUrl: tm.logoUrl } : null;
                  return (
                    <tr key={r.tcode}>
                      <td>{i + 1}</td>
                      <td className={styles.teamCell}>
                        <TeamBadge team={badge} size={20} />
                        <Link href={`/teams/${r.tcode}`}>{tm?.name ?? r.tcode}</Link>
                      </td>
                      <td>{r.wins + r.losses}</td>
                      <td>{r.wins}</td>
                      <td>{r.losses}</td>
                      <td>{(r.pct * 100).toFixed(1)}%</td>
                      <td>{r.gb === 0 ? "-" : r.gb.toFixed(1)}</td>
                      <td className={streakClass(r.streak)}>{streakText(r.streak)}</td>
                      <td>
                        {r.last10.wins}승 {r.last10.losses}패
                      </td>
                      <td>
                        {r.home.wins}-{r.home.losses}
                      </td>
                      <td>
                        {r.away.wins}-{r.away.losses}
                      </td>
                      <td className={diffClass(r.diff)}>{signed(r.diff, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className={`${styles.foot} empty-note`} style={{ textAlign: "left" }}>
            <p>
              <strong>게임차</strong> 1위와의 승·패 차이를 (승수차 + 패수차) / 2로 계산합니다.
            </p>
            <p>
              <strong>득실마진</strong> 경기당 평균 득점-실점 차입니다.
            </p>
            <p>{shortSeason(activeSeason)} 정규시즌 기준 · 플레이오프 제외</p>
          </div>

          <div className={overview.sectionHead}>
            <h2 className="title" style={{ fontSize: "1.1rem" }}>
              팀 전체 개요
            </h2>
            <span className="empty-note">종합·슈팅·리바운드·소유 6개 지표 + 쿼터별 분위기 · 전체 지표는 팀 상세에서</span>
          </div>
          <div className={overview.grid}>
            {/* rows(승-패 기록)만 돌면 아직 치른 경기가 0인 팀(예: 개막 전 SK)이 빠진다 -
                요청("SK까지 10팀 전부") - 팀 목록은 teams(시즌 로스터 10개 전체)를 기준으로
                돌고, 기록이 없으면 "아직 기록 없음"으로 빈 카드를 보여준다. */}
            {activeTeams
              .sort((a, b) => {
                const ai = rows.findIndex((row) => row.tcode === a.tcode);
                const bi = rows.findIndex((row) => row.tcode === b.tcode);
                // 기록 있는 팀은 순위표 순서 그대로, 0경기 팀(순위표에 없음)은 맨 뒤로.
                return (ai === -1 ? rows.length : ai) - (bi === -1 ? rows.length : bi);
              })
              .map((tm) => {
              const r = rows.find((row) => row.tcode === tm.tcode);
              const stat = teamStats?.byTcode[tm.tcode];
              const badge = { name: tm.name, abbr: tm.abbr, color: tm.color, logoUrl: tm.logoUrl };
              const qs = quarterSplits?.[tm.tcode];
              return (
                <Link key={tm.tcode} href={`/teams/${tm.tcode}`} className={overview.card}>
                  <div className={overview.cardHead}>
                    <TeamBadge team={badge} size={28} />
                    <div>
                      <div className={overview.cardName}>{tm.name}</div>
                      <div className={overview.cardRecord}>
                        {r ? `${r.wins}승 ${r.losses}패 · ${(r.pct * 100).toFixed(1)}%` : "아직 치른 경기 없음"}
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
                            <span className={cell.better === null ? undefined : cell.better ? overview.pos : overview.neg}>
                              {cell.display}
                            </span>
                            <span className={overview.statRank}>{cell.rankLabel}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="empty-note">경기 기록이 쌓이면 여기에 지표가 표시됩니다.</div>
                  )}

                  {qs && (
                    <div className={overview.quarters}>
                      <span className={overview.quarterCaption}>쿼터별 분위기(그 쿼터 평균 득실차)</span>
                      <div className={overview.quarterBars}>
                        {REGULATION_QUARTERS.map((q) => {
                          const v = qs.quarters[q];
                          const tone = v > 0.1 ? overview.pos : v < -0.1 ? overview.neg : undefined;
                          return (
                            <div key={q} className={overview.quarterBar}>
                              <span className={overview.quarterLabel}>{q}</span>
                              <span className={tone}>{signed(v, 1)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <span className={overview.cta}>팀 자세히 보기 →</span>
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
  description: "KBL 정규시즌 팀 순위 + 10개 구단 전체 개요(슈팅 구성, 쿼터별 분위기) - 팀 상세로 이동",
};
