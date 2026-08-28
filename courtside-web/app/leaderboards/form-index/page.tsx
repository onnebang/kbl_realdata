import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getSeasonsWithFormData, getFormIndexLeaderboard, type FormSortKey } from "@/lib/formIndex";

const COLUMNS: { key: FormSortKey; label: string }[] = [
  { key: "delta", label: "Δ" },
  { key: "deltaPerGame", label: "Δ/G" },
  { key: "actualPts", label: "실제" },
  { key: "expectedPts", label: "기대" },
  { key: "attempts", label: "시도" },
  { key: "games", label: "경기" },
];

function fmtDelta(v: number) {
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

export default async function FormIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; sort?: string; dir?: string }>;
}) {
  const { season, sort, dir } = await searchParams;
  const seasons = await getSeasonsWithFormData();
  const activeSeason = season ?? seasons[0];
  const sortKey = (COLUMNS.find((c) => c.key === sort)?.key ?? "delta") as FormSortKey;
  const ascending = dir === "asc";

  const rows = await getFormIndexLeaderboard(activeSeason, sortKey, ascending);
  const hottest = rows
    .slice()
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 10);
  const maxAbs = Math.max(1, ...hottest.map((r) => Math.abs(r.delta)));

  const sortLink = (key: FormSortKey) => {
    const nextDir = sortKey === key && !ascending ? "asc" : "desc";
    return `?season=${encodeURIComponent(activeSeason)}&sort=${key}&dir=${nextDir}`;
  };

  return (
    <div className="wrap">
      <div className="title">폼 지수 리더보드</div>
      <div className="subtitle">
        이 시즌 마지막 5경기(최소 3경기, 슛 15회 이상) 동안 실제 득점이 슛 난이도별 리그 평균
        기대득점(xPts)보다 얼마나 높았는지 - 양수면 난이도 대비 잘 넣는 중(핫), 음수면 쉬운
        찬스도 놓치는 중(콜드).
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
        <div className="panel-title">가장 핫한 선수 TOP 10</div>
        {hottest.map((r) => (
          <div className="wpa-bar-row" key={r.pcode}>
            <TeamBadge team={{ name: r.teamName, abbr: r.teamAbbr, color: r.teamColor, logoUrl: r.teamLogoUrl }} size={20} />
            <Link href={`/players/${r.pcode}`} className="wpa-bar-name">
              {r.playerName}
            </Link>
            <div className="wpa-bar-track">
              <div
                className={`wpa-bar-fill ${r.delta >= 0 ? "pos" : "neg"}`}
                style={{ width: `${(Math.abs(r.delta) / maxAbs) * 100}%` }}
              />
            </div>
            <span className={`wpa-bar-val ${r.delta >= 0 ? "pos" : "neg"}`}>{fmtDelta(r.delta)}</span>
          </div>
        ))}
        {!hottest.length && <div className="empty-note">이 시즌은 표본 기준을 충족하는 선수가 없음</div>}
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
                  <td className={r.delta >= 0 ? "wpa-pos" : "wpa-neg"}>{fmtDelta(r.delta)}</td>
                  <td className={r.deltaPerGame >= 0 ? "wpa-pos" : "wpa-neg"}>{fmtDelta(r.deltaPerGame)}</td>
                  <td>{r.actualPts.toFixed(1)}</td>
                  <td>{r.expectedPts.toFixed(1)}</td>
                  <td>{r.attempts}</td>
                  <td>{r.games}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <footer className="foot">
        {activeSeason} 시즌 · {rows.length}명 · 슛차트(shot_log) + xPts 존 테이블에서 실시간 계산
      </footer>
    </div>
  );
}
