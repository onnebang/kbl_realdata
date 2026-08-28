import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlayerInfo, getPlayerCareerBySeason, getPlayerRecentGames } from "@/lib/playerProfile";

function pct(v: number | null) {
  return v == null ? "-" : `${(v * 100).toFixed(1)}%`;
}

export default async function PlayerPage({ params }: { params: Promise<{ pcode: string }> }) {
  const { pcode } = await params;
  const info = await getPlayerInfo(pcode);
  if (!info) notFound();

  const [{ seasons, careerGp }, recentGames] = await Promise.all([
    getPlayerCareerBySeason(pcode),
    getPlayerRecentGames(pcode, 15),
  ]);

  const careerPpg = seasons.length ? seasons.reduce((s, sn) => s + sn.ppg * sn.gp, 0) / careerGp : 0;
  const careerRpg = seasons.length ? seasons.reduce((s, sn) => s + sn.rpg * sn.gp, 0) / careerGp : 0;
  const careerApg = seasons.length ? seasons.reduce((s, sn) => s + sn.apg * sn.gp, 0) / careerGp : 0;

  return (
    <div className="wrap">
      <Link href="/" className="back-link">
        ← 경기 목록
      </Link>

      <div className="player-header">
        {info.photoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={info.photoUrl} alt={info.name} className="player-photo" />
        )}
        <div>
          <div className="title">{info.name}</div>
          {info.ename && <div className="subtitle">{info.ename}</div>}
        </div>
      </div>

      {careerGp > 0 && (
        <div className="panel">
          <div className="panel-title">커리어 평균 ({careerGp}경기, {seasons.length}시즌)</div>
          <div className="career-stat-row">
            <div className="career-stat">
              <span className="career-stat-val">{careerPpg.toFixed(1)}</span>
              <span className="career-stat-label">PPG</span>
            </div>
            <div className="career-stat">
              <span className="career-stat-val">{careerRpg.toFixed(1)}</span>
              <span className="career-stat-label">RPG</span>
            </div>
            <div className="career-stat">
              <span className="career-stat-val">{careerApg.toFixed(1)}</span>
              <span className="career-stat-label">APG</span>
            </div>
          </div>
        </div>
      )}

      {seasons.length > 0 && (
        <div className="panel">
          <div className="panel-title">시즌별 기록</div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>시즌</th>
                  <th>팀</th>
                  <th>GP</th>
                  <th>PPG</th>
                  <th>RPG</th>
                  <th>APG</th>
                  <th>SPG</th>
                  <th>BPG</th>
                  <th>FG%</th>
                  <th>3P%</th>
                  <th>FT%</th>
                </tr>
              </thead>
              <tbody>
                {seasons.map((s) => (
                  <tr key={`${s.seasonName}-${s.tcode}`}>
                    <td>{s.seasonName}</td>
                    <td>{s.teamName}</td>
                    <td>{s.gp}</td>
                    <td>{s.ppg.toFixed(1)}</td>
                    <td>{s.rpg.toFixed(1)}</td>
                    <td>{s.apg.toFixed(1)}</td>
                    <td>{s.spg.toFixed(1)}</td>
                    <td>{s.bpg.toFixed(1)}</td>
                    <td>{pct(s.fgPct)}</td>
                    <td>{pct(s.tpPct)}</td>
                    <td>{pct(s.ftPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {recentGames.length > 0 && (
        <div className="panel">
          <div className="panel-title">최근 경기</div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>상대</th>
                  <th>결과</th>
                  <th>MIN</th>
                  <th>PTS</th>
                  <th>REB</th>
                  <th>AST</th>
                  <th>FG</th>
                  <th>3P</th>
                  <th>FT</th>
                </tr>
              </thead>
              <tbody>
                {recentGames.map((g) => (
                  <tr key={g.gmkey}>
                    <td>
                      <Link href={`/games/${g.gmkey}`}>{g.gameDate}</Link>
                    </td>
                    <td>
                      {g.isHome ? "vs" : "@"} {g.oppName}
                    </td>
                    <td>
                      <span className={`sched-result ${g.win ? "win" : "loss"}`}>{g.win ? "W" : "L"}</span> {g.teamScore}-{g.oppScore}
                    </td>
                    <td>{g.min.toFixed(1)}</td>
                    <td>{g.pts}</td>
                    <td>{g.reb}</td>
                    <td>{g.ast}</td>
                    <td>
                      {g.fgm}/{g.fga}
                    </td>
                    <td>
                      {g.tpm}/{g.tpa}
                    </td>
                    <td>
                      {g.ftm}/{g.fta}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <footer className="foot">Supabase에서 실시간 조회 · {pcode}</footer>
    </div>
  );
}
