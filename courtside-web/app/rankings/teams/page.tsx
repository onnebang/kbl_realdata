import type { Metadata } from "next";
import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getTeams, shortSeason } from "@/lib/preseason";
import { getLeaderboardSeasons } from "@/lib/seasonLeaders";
import { getStandingsAsOfCached } from "@/lib/teamPageData";
import { signed, signTone } from "@/lib/format";
import styles from "./standings.module.css";

// 팀 순위 테이블(승-패 기반 실제 스탠딩). 기존 "TEAM POWER RANKINGS"(OVR 전력 평가)는 전혀
// 다른 개념이라 /rankings/power로 옮겼고, 이 자리는 이제 진짜 순위표다.
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
  const fellBack = requested && requested !== activeSeason ? requested : null;

  const [rows, teams] = await Promise.all([
    getStandingsAsOfCached(activeSeason, "9999-12-31"),
    getTeams(activeSeason),
  ]);

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

      {fellBack && (
        <div className={styles.fallback}>
          {fellBack} 시즌은 아직 종료된 정규시즌 경기가 없어 순위표를 만들 수 없습니다. 대신
          가장 최근 시즌인 <strong>{activeSeason}</strong> 기록을 보여줍니다.
        </div>
      )}

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
        </>
      )}
    </div>
  );
}

export const metadata: Metadata = {
  title: "팀 순위",
  description: "KBL 정규시즌 팀 순위 - 승패, 승률, 게임차, 연속, 최근 10경기, 홈/원정 성적, 득실마진",
};
