import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPlayerInfo,
  getPlayerCareerBySeason,
  getPlayerRecentGames,
  computeWindowAverages,
  WINDOWS,
  type GameLogRow,
} from "@/lib/playerProfile";
import { getShotGrid, buildHeatmapSvg } from "@/lib/scoringExplorer";

function pct(v: number | null) {
  return v == null ? "-" : `${(v * 100).toFixed(1)}%`;
}

// 트렌드 차트(득점=막대, 출전시간=선) - 원본 "선수 프로필" 아티팩트 참고. 오래된 경기가
// 왼쪽에 오도록(시간순) recentGames(최신이 먼저)를 뒤집어서 그림. game/[gmkey]/page.tsx의
// WinProbChart와 같은 스타일(차트 라이브러리 없이 직접 SVG). 주의: rect 자식으로 JSX
// <title>(툴팁)을 쓰면 React 19가 이걸 문서 메타데이터용 <title>로 취급해 hoist를
// 시도하면서 하이드레이션 에러가 남(실측) - SVG 안에서 <title>은 쓰지 않음.
function TrendChart({ games, homeColor }: { games: GameLogRow[]; homeColor: string }) {
  const chrono = games.slice().reverse();
  const W = 400,
    H = 140,
    PAD = 14;
  const maxPts = Math.max(1, ...chrono.map((g) => g.pts));
  const maxMin = Math.max(1, ...chrono.map((g) => g.min));
  const n = chrono.length;
  const barW = Math.min(24, (W - 2 * PAD) / Math.max(1, n) - 4);
  const xAt = (i: number) => PAD + (i / Math.max(1, n - 1)) * (W - 2 * PAD) - barW / 2;
  const points = chrono
    .map((g, i) => {
      const x = PAD + (i / Math.max(1, n - 1)) * (W - 2 * PAD);
      const y = H - PAD - (g.min / maxMin) * (H - 2 * PAD) * 0.9;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 140, display: "block" }}>
      {chrono.map((g, i) => {
        const barH = (g.pts / maxPts) * (H - 2 * PAD) * 0.75;
        return (
          <rect
            key={g.gmkey}
            x={xAt(i)}
            y={H - PAD - barH}
            width={Math.max(2, barW)}
            height={barH}
            fill={homeColor}
            opacity={0.35}
            rx={1.5}
          />
        );
      })}
      <polyline points={points} fill="none" stroke="var(--ink)" strokeWidth={1.6} />
      <text x={PAD} y={12} fontSize={9} fill={homeColor} fontFamily="IBM Plex Mono, monospace">
        ■ 득점
      </text>
      <text x={PAD + 50} y={12} fontSize={9} fill="var(--ink)" fontFamily="IBM Plex Mono, monospace">
        — 출전시간
      </text>
    </svg>
  );
}

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ pcode: string }>;
  searchParams: Promise<{ w?: string; season?: string }>;
}) {
  const { pcode } = await params;
  const { w, season } = await searchParams;
  const info = await getPlayerInfo(pcode);
  if (!info) notFound();

  const [{ seasons, careerGp }, recentGames] = await Promise.all([
    getPlayerCareerBySeason(pcode),
    getPlayerRecentGames(pcode),
  ]);

  const careerPpg = seasons.length ? seasons.reduce((s, sn) => s + sn.ppg * sn.gp, 0) / careerGp : 0;
  const careerRpg = seasons.length ? seasons.reduce((s, sn) => s + sn.rpg * sn.gp, 0) / careerGp : 0;
  const careerApg = seasons.length ? seasons.reduce((s, sn) => s + sn.apg * sn.gp, 0) / careerGp : 0;

  const windowN = WINDOWS.includes(Number(w) as (typeof WINDOWS)[number]) ? Number(w) : 10;
  const windowAvg = computeWindowAverages(recentGames, windowN);
  const homeColor = seasons[0]?.tcode ? "var(--home)" : "var(--home)";

  const shotSeason = season ?? seasons[0]?.seasonName;
  const shotGrid = shotSeason ? await getShotGrid("player", pcode, shotSeason) : null;
  const shotSvg = shotGrid && shotGrid.totalAtt > 0 ? buildHeatmapSvg(shotGrid) : null;

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
          <div className="panel-title">
            커리어 평균 ({careerGp}경기, {seasons.length}시즌)
          </div>
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

      {recentGames.length > 0 && windowAvg && (
        <div className="panel">
          <div className="panel-title-row">
            <div className="panel-title" style={{ marginBottom: 0 }}>
              최근 폼
            </div>
            <div className="window-toggle">
              {WINDOWS.map((wn) => (
                <Link key={wn} href={`?w=${wn}`} className={`window-btn ${windowN === wn ? "active" : ""}`}>
                  L{wn}
                </Link>
              ))}
            </div>
          </div>
          <TrendChart games={recentGames.slice(0, windowN)} homeColor={homeColor} />
          <div className="stat-grid">
            {(
              [
                ["MIN", windowAvg.min.toFixed(1)],
                ["PTS", windowAvg.pts.toFixed(1)],
                ["REB", windowAvg.reb.toFixed(1)],
                ["AST", windowAvg.ast.toFixed(1)],
                ["STL", windowAvg.stl.toFixed(1)],
                ["BLK", windowAvg.blk.toFixed(1)],
                ["TOV", windowAvg.tov.toFixed(1)],
                ["FG%", windowAvg.fgPct != null ? `${windowAvg.fgPct.toFixed(1)}%` : "-"],
                ["3P%", windowAvg.tpPct != null ? `${windowAvg.tpPct.toFixed(1)}%` : "-"],
                ["FT%", windowAvg.ftPct != null ? `${windowAvg.ftPct.toFixed(1)}%` : "-"],
              ] as const
            ).map(([label, val]) => (
              <div className="stat-tile" key={label}>
                <span className="stat-tile-val">{val}</span>
                <span className="stat-tile-label">{label}</span>
              </div>
            ))}
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

      {seasons.length > 0 && (
        <div className="panel">
          <div className="panel-title">슛 차트</div>
          <form style={{ marginBottom: 10 }}>
            <select name="season" defaultValue={shotSeason}>
              {seasons.map((s) => (
                <option key={s.seasonName} value={s.seasonName}>
                  {s.seasonName} 시즌
                </option>
              ))}
            </select>{" "}
            <button type="submit" className="back-link" style={{ cursor: "pointer", display: "inline" }}>
              조회
            </button>
          </form>
          {shotSvg ? (
            <>
              <div className="explorer-stat-line">
                {shotGrid!.totalAtt.toLocaleString()}회 시도 · {shotGrid!.totalMade.toLocaleString()}회 성공 (
                {Math.round((shotGrid!.totalMade / shotGrid!.totalAtt) * 100)}%)
              </div>
              <div className="zc-court-tilt">
                <svg className="zc-court" viewBox="345 27 375 357" dangerouslySetInnerHTML={{ __html: shotSvg }} />
              </div>
            </>
          ) : (
            <div className="empty-note">이 시즌 슛 기록 없음</div>
          )}
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
