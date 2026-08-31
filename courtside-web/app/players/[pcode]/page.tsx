import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPlayerInfo,
  getPlayerCareerBySeason,
  getPlayerRecentGames,
  getAllTeams,
  computeWindowAverages,
  WINDOWS,
  type GameLogRow,
} from "@/lib/playerProfile";
import {
  fetchPlayerSeasonShots,
  getZoneExpectedPts,
  getPlayerSeasonBoxTotals,
  countRimAndThreeFga,
  buildHeaderStats,
  buildImpactDots,
  buildImpactCourtSvg,
  computeDrawnFoulProxy,
} from "@/lib/shotImpactChart";
import { displayTeamName } from "@/lib/teamNames";
import { TeamBadge } from "@/components/TeamBadge";
import styles from "./player-profile.module.css";

// web/player_profile_template.html 포팅. 템플릿은 "검색창 하나로 아무 선수나 골라 같은
// 페이지 안에서 보여주는" SPA(URL 불변)이지만, 이 프로젝트는 /players/[pcode] 라우팅 기반
// (다른 페이지들이 이 라우트로 직접 링크를 걺 - 팀 페이지/리더보드 등)이라 라우팅 구조는
// 그대로 유지하고, 템플릿의 패널 구성/순서/스타일만 그대로 옮김(검색 드롭다운은 이식하지
// 않음 - 링크 가능성을 잃으면 사이트 전체 링크가 깨짐).

function pct(v: number | null) {
  return v == null ? "-" : `${(v * 100).toFixed(1)}%`;
}

// 템플릿 renderPerfChart() 포팅 - 막대=득점(홈 컬러), 선=출전시간(골드), viewBox 640x160.
// 템플릿의 원본 데이터는 시간순 오름차순으로 저장돼있어 그대로 그렸지만, 우리 windowGames는
// 최신이 먼저(DESC)라 차트에서는 왼쪽이 과거/오른쪽이 최근이 되도록 뒤집어서 그림.
function PerfChart({ games }: { games: GameLogRow[] }) {
  const chrono = games.slice().reverse();
  const W = 640,
    H = 160,
    PAD_L = 24,
    PAD_R = 8,
    PAD_T = 10,
    PAD_B = 18;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = chrono.length;
  if (!n) return <svg className={styles.perfChartSvg} viewBox={`0 0 ${W} ${H}`} />;
  const maxPts = Math.max(10, ...chrono.map((g) => g.pts));
  const maxMin = Math.max(20, ...chrono.map((g) => g.min));
  const bw = plotW / n;
  const linePts = chrono
    .map((g, i) => {
      const x = PAD_L + i * bw + bw / 2;
      const y = PAD_T + plotH - (g.min / maxMin) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className={styles.perfChartSvg} viewBox={`0 0 ${W} ${H}`}>
      {chrono.map((g, i) => {
        const bh = (g.pts / maxPts) * plotH;
        const x = PAD_L + i * bw;
        return (
          <rect
            key={g.gmkey}
            x={x + bw * 0.14}
            y={PAD_T + plotH - bh}
            width={bw * 0.72}
            height={bh}
            fill="var(--home)"
            rx={2}
          />
        );
      })}
      <polyline points={linePts} fill="none" stroke="var(--gold)" strokeWidth={2} />
      <line x1={PAD_L} y1={PAD_T + plotH} x2={W - PAD_R} y2={PAD_T + plotH} stroke="var(--ink-faint)" strokeWidth={1} />
      <text x={2} y={PAD_T + 8} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
        {maxPts}
      </text>
      <text x={2} y={PAD_T + plotH} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
        0
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

  const [{ seasons, careerGp }, recentGames, teamByTcode] = await Promise.all([
    getPlayerCareerBySeason(pcode),
    getPlayerRecentGames(pcode),
    getAllTeams(),
  ]);

  const windowN = WINDOWS.includes(Number(w) as (typeof WINDOWS)[number]) ? Number(w) : 15;
  const windowGames = recentGames.slice(0, windowN);
  const windowAvg = computeWindowAverages(recentGames, windowN);

  const latest = recentGames[0];
  const headerTcode = latest?.tcode ?? seasons[0]?.tcode;
  const headerTeam = headerTcode ? teamByTcode.get(headerTcode) : undefined;
  const latestSeason = seasons.length ? seasons[0].seasonName : null;
  // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - headerTeam은 배지용 정적
  // 색상/로고 조회라 그대로 두고, 표시 텍스트만 최신 시즌 기준으로 덮어씀.
  const headerTeamName = headerTeam ? displayTeamName(headerTeam.tcode, headerTeam.name, latestSeason) : null;

  const shotSeason = season ?? seasons[0]?.seasonName;
  let seasonShots: Awaited<ReturnType<typeof fetchPlayerSeasonShots>> = [];
  let zoneExpectedPts: Awaited<ReturnType<typeof getZoneExpectedPts>> = new Map();
  let boxTotals: Awaited<ReturnType<typeof getPlayerSeasonBoxTotals>> | null = null;
  if (shotSeason) {
    [seasonShots, zoneExpectedPts, boxTotals] = await Promise.all([
      fetchPlayerSeasonShots(pcode, shotSeason),
      getZoneExpectedPts(),
      getPlayerSeasonBoxTotals(pcode, shotSeason),
    ]);
  }
  const { rimFga, threeFga } = countRimAndThreeFga(seasonShots);
  const headerStats = boxTotals ? buildHeaderStats(boxTotals, rimFga, threeFga) : null;
  const impactDots = buildImpactDots(seasonShots, zoneExpectedPts);
  const impactSvg = impactDots.length > 0 ? buildImpactCourtSvg(impactDots) : null;
  const totalMade = seasonShots.filter((s) => s.made).length;
  const drawnFoulProxy = boxTotals ? computeDrawnFoulProxy(boxTotals.fta, boxTotals.fga) : null;
  const astPerGame = boxTotals && boxTotals.gp > 0 ? boxTotals.ast / boxTotals.gp : null;
  const tovPerGame = boxTotals && boxTotals.gp > 0 ? boxTotals.tov / boxTotals.gp : null;

  return (
    <div className={`wrap ${styles.pageRoot}`}>
      <Link href="/" className="back-link">
        ← 경기 목록
      </Link>

      <div className={styles.header}>
        <div className={styles.numBox}>{latest?.backNum ? `#${latest.backNum}` : "?"}</div>
        <div className={styles.nameBlock}>
          <div className={styles.name}>{info.name}</div>
          <div className={styles.meta}>
            <TeamBadge team={headerTeam ?? null} size={20} />
            <span>{headerTeamName ?? "-"}</span>
            <span>·</span>
            <span>{latest?.pos ?? "-"}</span>
          </div>
        </div>
        <div className={styles.gp}>커리어 {careerGp}경기</div>
      </div>

      {recentGames.length > 0 && (
        <div className={styles.windowRow}>
          {WINDOWS.map((wn) => (
            <Link
              key={wn}
              href={`?w=${wn}`}
              className={`${styles.wtoggle} ${windowN === wn ? styles.wtoggleActive : ""}`}
            >
              L{wn}
            </Link>
          ))}
        </div>
      )}

      <div className={styles.panel}>
        <div className={styles.panelTitle}>최근 경기 득점 · 출전시간</div>
        <PerfChart games={windowGames} />
        <div className={styles.perfLegend}>
          <span>
            <span className={styles.sw} style={{ background: "var(--home)" }} />
            득점(PTS)
          </span>
          <span>
            <span className={styles.sw} style={{ background: "var(--gold)" }} />
            출전시간(MIN)
          </span>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>{windowAvg ? `최근 ${windowAvg.gp}경기 평균` : "선택 구간 평균"}</div>
        {windowAvg ? (
          <div className={styles.statGrid}>
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
              <div className={styles.statTile} key={label}>
                <div className={styles.sv}>{val}</div>
                <div className={styles.sl}>{label}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-note">경기 기록 없음</div>
        )}
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>게임 로그</div>
        {windowGames.length ? (
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
                  <th>STL</th>
                  <th>BLK</th>
                  <th>TOV</th>
                  <th>FG</th>
                  <th>3P</th>
                  <th>FT</th>
                </tr>
              </thead>
              <tbody>
                {windowGames.map((g) => {
                  const oppTeam = teamByTcode.get(g.oppTcode);
                  return (
                    <tr key={g.gmkey}>
                      <td>
                        <Link href={`/games/${g.gmkey}`}>{g.gameDate}</Link>
                      </td>
                      <td>
                        <span className={styles.glOpp}>
                          {g.isHome ? "vs" : "@"}
                          <TeamBadge team={oppTeam ?? null} size={16} />
                          {g.oppName}
                        </span>
                      </td>
                      <td>
                        <span className={`${styles.glResult} ${g.win ? styles.glResultWin : styles.glResultLoss}`}>
                          {g.win ? "W" : "L"}
                        </span>
                      </td>
                      <td>{g.min.toFixed(1)}</td>
                      <td>{g.pts}</td>
                      <td>{g.reb}</td>
                      <td>{g.ast}</td>
                      <td>{g.stl}</td>
                      <td>{g.blk}</td>
                      <td>{g.tov}</td>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-note">게임 로그 없음</div>
        )}
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>시즌별 기록</div>
        {seasons.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>시즌</th>
                  <th>팀</th>
                  <th>GP</th>
                  <th>MIN</th>
                  <th>PTS</th>
                  <th>REB</th>
                  <th>AST</th>
                  <th>STL</th>
                  <th>BLK</th>
                  <th>TOV</th>
                  <th>FG%</th>
                  <th>3P%</th>
                  <th>FT%</th>
                </tr>
              </thead>
              <tbody>
                {seasons.map((s) => {
                  const team = teamByTcode.get(s.tcode);
                  return (
                    <tr key={`${s.seasonName}-${s.tcode}`} className={s.seasonName === latestSeason ? styles.curSeason : ""}>
                      <td>{s.seasonName}</td>
                      <td>
                        <span className={styles.glOpp}>
                          <TeamBadge team={team ?? null} size={16} />
                          {s.teamName}
                        </span>
                      </td>
                      <td>{s.gp}</td>
                      <td>{s.minPg.toFixed(1)}</td>
                      <td>{s.ppg.toFixed(1)}</td>
                      <td>{s.rpg.toFixed(1)}</td>
                      <td>{s.apg.toFixed(1)}</td>
                      <td>{s.spg.toFixed(1)}</td>
                      <td>{s.bpg.toFixed(1)}</td>
                      <td>{s.tovPg.toFixed(1)}</td>
                      <td>{pct(s.fgPct)}</td>
                      <td>{pct(s.tpPct)}</td>
                      <td>{pct(s.ftPct)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-note">시즌 기록 없음</div>
        )}
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>슛 임팩트 리포트</div>
        <form className={styles.heatRow}>
          <label>시즌</label>
          <select name="season" defaultValue={shotSeason} className={styles.heatSelect} disabled={!seasons.length}>
            {seasons.length ? (
              seasons.map((s) => (
                <option key={s.seasonName} value={s.seasonName}>
                  {s.seasonName}
                </option>
              ))
            ) : (
              <option>데이터 없음</option>
            )}
          </select>
          <button type="submit" className="btn-primary">
            조회
          </button>
        </form>
        {headerStats && (
          <div className={`${styles.statGrid} ${styles.impactHeaderRow}`}>
            {(
              [
                ["PTS", headerStats.pts.toLocaleString()],
                ["TSA", headerStats.tsa.toFixed(1)],
                ["PSA", headerStats.psa != null ? headerStats.psa.toFixed(2) : "-"],
                ["USG%", headerStats.usgPct != null ? `${headerStats.usgPct.toFixed(1)}%` : "-"],
                ["MOREY%", headerStats.moreyPct != null ? `${(headerStats.moreyPct * 100).toFixed(1)}%` : "-"],
              ] as const
            ).map(([label, val]) => (
              <div className={styles.statTile} key={label}>
                <div className={styles.sv}>{val}</div>
                <div className={styles.sl}>{label}</div>
              </div>
            ))}
          </div>
        )}
        <div className={styles.courtTilt}>
          {/* 점 하나 = 슛 하나(성공=채운 원/실패=테두리만, zoneCompare.ts 관례), 색은 그 슛이
              존 기대값보다 이득(--positive)인지 손해(--negative)인지, 크기·불투명도는 그
              잔차 크기 - lib/shotImpactChart.ts 참고. */}
          <svg
            className={styles.courtSvg}
            viewBox="345 27 375 357"
            dangerouslySetInnerHTML={{ __html: impactSvg ?? "" }}
          />
        </div>
        <div className={styles.heatStat}>
          {impactSvg
            ? `${seasonShots.length.toLocaleString()}회 시도 · ${totalMade.toLocaleString()}회 성공 (${Math.round(
                (totalMade / seasonShots.length) * 100
              )}%)`
            : "이 시즌 슛 데이터 없음"}
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>유발 파울 · 어시스트 · 턴오버</div>
        {boxTotals ? (
          <div className={styles.miniStatGrid}>
            <div className={styles.miniStatCard}>
              <div className={styles.miniStatLabel}>유발 파울(추정)</div>
              <div className={styles.miniStatMain}>{drawnFoulProxy!.fta.toLocaleString()}</div>
              <div className={styles.miniStatSub}>
                FTr {drawnFoulProxy!.ftr != null ? drawnFoulProxy!.ftr.toFixed(2) : "-"}
              </div>
              <div className={styles.miniStatNote}>
                이벤트 로그(파울자유투)에는 "파울을 당한" 선수가 아니라 "파울을 범한" 선수만 기록돼
                있어, 정확한 유발 파울 횟수 대신 자유투 시도 수(FTA)를 근사치로 표시 · FTr = FTA/FGA
              </div>
            </div>
            <div className={styles.miniStatCard}>
              <div className={styles.miniStatLabel}>어시스트</div>
              <div className={styles.miniStatMain}>{boxTotals.ast.toLocaleString()}</div>
              <div className={styles.miniStatSub}>{astPerGame != null ? `${astPerGame.toFixed(1)} / 경기` : "-"}</div>
            </div>
            <div className={styles.miniStatCard}>
              <div className={styles.miniStatLabel}>턴오버</div>
              <div className={styles.miniStatMain}>{boxTotals.tov.toLocaleString()}</div>
              <div className={styles.miniStatSub}>{tovPerGame != null ? `${tovPerGame.toFixed(1)} / 경기` : "-"}</div>
            </div>
          </div>
        ) : (
          <div className="empty-note">이 시즌 기록 없음</div>
        )}
      </div>

      <footer className="foot">
        2011-12~2025-26 시즌 전체 경기 기준 · 게임로그는 최근 30경기까지만 보관 · Supabase에서 실시간 조회
      </footer>
    </div>
  );
}
