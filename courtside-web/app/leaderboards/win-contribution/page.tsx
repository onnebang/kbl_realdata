import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getSeasonsWithWpaData, getWinContributionLeaderboard, type SortKey } from "@/lib/winContributionLeaderboard";
import styles from "./win-contribution.module.css";

// wpa_leaderboard_template.html 포팅. 컬럼 순서/시맨틱 컬러(--pos/--neg)/explain-box 문구는
// 템플릿 그대로, 데이터만 player_season_wpa 라이브 쿼리(lib/winContributionLeaderboard.ts)로
// 유지. 템플릿과 다르게 판단한 부분은 이 파일 하단 주석/함수 옆 주석 참고.
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "games", label: "GP" },
  { key: "totalWpa", label: "WPA" },
  { key: "wpaPerGame", label: "WPA/G" },
  { key: "posWpa", label: "+WPA" },
  { key: "negWpa", label: "-WPA" },
];

function fmtWpa(v: number, decimals = 2) {
  return `${v > 0 ? "+" : ""}${v.toFixed(decimals)}`;
}

export default async function WinContributionPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; sort?: string; dir?: string }>;
}) {
  const { season, sort, dir } = await searchParams;
  const seasons = await getSeasonsWithWpaData();
  const activeSeason = season ?? seasons[0];
  const sortKey = (COLUMNS.find((c) => c.key === sort)?.key ?? "totalWpa") as SortKey;
  const ascending = dir === "asc";

  const rows = await getWinContributionLeaderboard(activeSeason, sortKey, ascending);
  // 템플릿 renderBars(): 정렬 기준과 무관하게 TOP10은 항상 totalWpa 내림차순.
  const top10 = rows
    .slice()
    .sort((a, b) => b.totalWpa - a.totalWpa)
    .slice(0, 10);
  const maxAbs = Math.max(0.1, ...top10.map((r) => Math.abs(r.totalWpa)));

  const sortLink = (key: SortKey) => {
    const nextDir = sortKey === key && !ascending ? "asc" : "desc";
    return `?season=${encodeURIComponent(activeSeason)}&sort=${key}&dir=${nextDir}`;
  };

  return (
    <div className={styles.pageRoot}>
      <div className="wrap">
        <div className={styles.headerRow}>
          <div>
            <div className={`title ${styles.titleSize}`}>승리 기여도 리더보드</div>
            <div className={`subtitle ${styles.subtitleWidth}`}>
              Win Probability Added(WPA) - 이 선수의 플레이가 우리 팀 승률을 얼마나 끌어올렸는지 매 이벤트마다
              계산해서 시즌 전체로 누적한 값. 라이브 승률 모델(HistGradientBoosting, 홀드아웃 정확도 74.7%)을
              그대로 재사용.
            </div>
          </div>
          <form className={styles.seasonForm}>
            <select name="season" defaultValue={activeSeason}>
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

        <div className="panel">
          <div className={`panel-title ${styles.panelTitle}`}>{activeSeason} 시즌 승리 기여도 TOP 10</div>
          {top10.map((r, i) => {
            const pct = Math.max(4, (Math.abs(r.totalWpa) / maxAbs) * 100);
            const sign = r.totalWpa >= 0 ? styles.pos : styles.neg;
            return (
              <div className={styles.barRow} key={r.pcode}>
                <div className={styles.barRank}>{i + 1}</div>
                <div className={styles.barNameWrap}>
                  <Link href={`/players/${r.pcode}`} className={styles.barName}>
                    {r.playerName}
                  </Link>
                  <div className={styles.barTeam}>{r.teamName}</div>
                </div>
                <div className={styles.barTrack}>
                  <div className={`${styles.barFill} ${sign}`} style={{ width: `${pct}%` }} />
                </div>
                <div className={`${styles.barVal} ${sign}`}>{fmtWpa(r.totalWpa)}</div>
              </div>
            );
          })}
        </div>

        <div className="panel">
          <div className={`panel-title ${styles.panelTitle}`}>전체 순위 (열 제목을 클릭하면 정렬)</div>
          <div className="table-scroll">
            <table className={`data-table ${styles.table}`}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>선수</th>
                  <th>팀</th>
                  {COLUMNS.map((c) => {
                    const active = sortKey === c.key;
                    return (
                      <th key={c.key} className={active ? styles.activeHeader : undefined}>
                        <Link href={sortLink(c.key)} className={styles.sortLink}>
                          {c.label}
                          {active && <span className={styles.arrow}>{ascending ? "▴" : "▾"}</span>}
                        </Link>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.pcode}>
                    <td className={styles.rankCell}>{i + 1}</td>
                    <td className={styles.playerCell}>
                      <Link href={`/players/${r.pcode}`}>{r.playerName}</Link>
                    </td>
                    <td>
                      <TeamBadge team={{ name: r.teamName, abbr: r.teamAbbr, color: r.teamColor, logoUrl: r.teamLogoUrl }} size={20} />
                    </td>
                    <td>{r.games}</td>
                    <td className={r.totalWpa >= 0 ? styles.totalPos : styles.totalNeg}>{fmtWpa(r.totalWpa)}</td>
                    <td>{fmtWpa(r.wpaPerGame, 3)}</td>
                    <td>{fmtWpa(r.posWpa)}</td>
                    <td>{fmtWpa(r.negWpa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.explainBox}>
            <b>WPA(Win Probability Added)</b>란 - 그 플레이 직전 승률과 직후 승률의 차이를 그 선수에게
            귀속시킨 값. 원정팀 플레이는 부호를 뒤집어 &quot;자기 팀 입장에서 얼마나 도움이 됐는가&quot;로
            통일했음. <span className={styles.term}>+WPA</span>는 승률을 끌어올린 플레이만 합산,{" "}
            <span className={styles.term}>-WPA</span>는 끌어내린 플레이(턴오버, 실책성 파울 등 개인 귀속
            가능한 것)만 합산한 값. 정규시즌 경기만 포함(플레이오프는 팀마다 경기수가 달라 같은 잣대로 순위
            매기기 어려워 제외), 한 시즌 15개 이상 개인 귀속 플레이가 있는 선수만 표시.
          </div>
        </div>

        <footer className="foot">
          {activeSeason} 시즌 · {rows.length}명 · Supabase player_season_wpa에서 실시간 조회
        </footer>
      </div>
    </div>
  );
}
