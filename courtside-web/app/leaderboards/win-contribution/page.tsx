import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getSeasonsWithWpaData, getWinContributionLeaderboard, type SortKey } from "@/lib/winContributionLeaderboard";

const COLUMNS: { key: SortKey; label: string; defaultAsc?: boolean }[] = [
  { key: "totalWpa", label: "WPA" },
  { key: "wpaPerGame", label: "WPA/G" },
  { key: "posWpa", label: "+WPA" },
  { key: "negWpa", label: "-WPA" },
  { key: "games", label: "GP" },
  { key: "plays", label: "PLAYS" },
];

function fmtWpa(v: number) {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
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
  const top10 = rows
    .slice()
    .sort((a, b) => b.totalWpa - a.totalWpa)
    .slice(0, 10);
  const maxAbs = Math.max(1, ...top10.map((r) => Math.abs(r.totalWpa)));

  const sortLink = (key: SortKey) => {
    const nextDir = sortKey === key && !ascending ? "asc" : "desc";
    return `?season=${encodeURIComponent(activeSeason)}&sort=${key}&dir=${nextDir}`;
  };

  return (
    <div className="wrap">
      <div className="title">승리 기여도 리더보드</div>
      <div className="subtitle">
        이 선수의 플레이가 우리 팀 승률을 얼마나 끌어올렸는지 매 이벤트마다 계산해서 시즌 전체로 누적한 값 - 라이브 승률
        모델을 그대로 재사용. 정규시즌만, 시즌당 개인 귀속 플레이 15개 이상인 선수만 표시.
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

      <div className="panel">
        <div className="panel-title">이 시즌 승리 기여도 TOP 10</div>
        {top10.map((r) => (
          <div className="wpa-bar-row" key={r.pcode}>
            <TeamBadge team={{ name: r.teamName, abbr: r.teamAbbr, color: r.teamColor, logoUrl: r.teamLogoUrl }} size={20} />
            <Link href={`/players/${r.pcode}`} className="wpa-bar-name">
              {r.playerName}
            </Link>
            <div className="wpa-bar-track">
              <div
                className={`wpa-bar-fill ${r.totalWpa >= 0 ? "pos" : "neg"}`}
                style={{ width: `${(Math.abs(r.totalWpa) / maxAbs) * 100}%` }}
              />
            </div>
            <span className={`wpa-bar-val ${r.totalWpa >= 0 ? "pos" : "neg"}`}>{fmtWpa(r.totalWpa)}</span>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-title">전체 순위 (열 제목을 클릭하면 정렬)</div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>선수</th>
                <th>팀</th>
                {COLUMNS.map((c) => (
                  <th key={c.key}>
                    <Link href={sortLink(c.key)} style={{ color: sortKey === c.key ? "var(--home)" : undefined }}>
                      {c.label}
                      {sortKey === c.key ? (ascending ? " ▴" : " ▾") : ""}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.pcode}>
                  <td>{i + 1}</td>
                  <td>
                    <Link href={`/players/${r.pcode}`}>{r.playerName}</Link>
                  </td>
                  <td style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <TeamBadge team={{ name: r.teamName, abbr: r.teamAbbr, color: r.teamColor, logoUrl: r.teamLogoUrl }} size={16} />
                    {r.teamName}
                  </td>
                  <td className={r.totalWpa >= 0 ? "wpa-pos" : "wpa-neg"}>{fmtWpa(r.totalWpa)}</td>
                  <td>{fmtWpa(r.wpaPerGame)}</td>
                  <td className="wpa-pos">{fmtWpa(r.posWpa)}</td>
                  <td className="wpa-neg">{fmtWpa(r.negWpa)}</td>
                  <td>{r.games}</td>
                  <td>{r.plays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <footer className="foot">
        {activeSeason} 시즌 · {rows.length}명 · Supabase player_season_wpa에서 실시간 조회
      </footer>
    </div>
  );
}
