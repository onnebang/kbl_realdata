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

// 커리어 FG%/3P%/FT% - careerPpg/Rpg/Apg와 같은 gp 가중평균 패턴을 슈팅 스플릿까지
// 확장한 것뿐, 새 쿼리/필드 없음(SeasonLine.fgPct/tpPct/ftPct는 이미 있음).
function weightedCareerPct(
  seasons: { gp: number; fgPct: number | null; tpPct: number | null; ftPct: number | null }[],
  key: "fgPct" | "tpPct" | "ftPct"
) {
  let wsum = 0,
    gpsum = 0;
  for (const s of seasons) {
    const v = s[key];
    if (v != null) {
      wsum += v * s.gp;
      gpsum += s.gp;
    }
  }
  return gpsum > 0 ? wsum / gpsum : null;
}

// 한글 이름 2줄 스택("Luka"/"Dončić" 모티프의 한글 버전) - 언어학적 성/이름 분리가
// 아니라 순수 타이포그래피 분할. info.name엔 성/이름 구분 필드가 없고 남궁·황보 같은
// 예외 성씨도 있어 "진짜" 분리는 불가능 - 2~4자 이름(KBL 로스터 대다수)만 첫 글자/
// 나머지로 나누고, 범위를 벗어나면(외국 선수 표기 등) 한 줄로 폴백.
function splitDisplayName(name: string): [string, string] {
  const n = name.trim();
  if (n.length < 2 || n.length > 4) return [n, ""];
  return [n.slice(0, 1), n.slice(1)];
}

// 히어로 배경 스파크라인 - 최근 경기 득점(recentGames.pts) 실데이터. TrendChart와 같은
// "오래된 경기가 왼쪽" 정렬을 따르되 히어로의 큰 viewBox에 맞춰 좌표만 다시 계산.
// 게임 수가 2개 미만(신인 등)이면 null(억지 폴백 곡선을 그리지 않음).
function heroSparkPoints(games: GameLogRow[]) {
  const chrono = games.slice(0, 15).slice().reverse();
  if (chrono.length < 2) return null;
  const W = 900,
    H = 220,
    PAD = 10;
  const pts = chrono.map((g) => g.pts);
  const max = Math.max(1, ...pts);
  const min = Math.min(...pts);
  const range = Math.max(1, max - min);
  return chrono
    .map((g, i) => {
      const x = PAD + (i / (chrono.length - 1)) * (W - 2 * PAD);
      const y = H * 0.15 + (H * 0.7 - PAD) * (1 - (g.pts - min) / range);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
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
  const careerFgPct = weightedCareerPct(seasons, "fgPct");
  const careerTpPct = weightedCareerPct(seasons, "tpPct");
  const careerFtPct = weightedCareerPct(seasons, "ftPct");
  const [nameHead, nameTail] = splitDisplayName(info.name);
  const heroSpark = recentGames.length ? heroSparkPoints(recentGames) : null;

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

      <div className="panel player-hero">
        {heroSpark && (
          <svg className="player-hero-wave" viewBox="0 0 900 220" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={heroSpark} fill="none" stroke="var(--home)" strokeWidth={2.5} opacity={0.14} />
          </svg>
        )}

        <div className="player-hero-top">
          <div className="player-photo-frame">
            {info.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={info.photoUrl} alt={info.name} className="player-photo" />
            ) : (
              <div className="player-photo-mono">{nameHead.charAt(0)}</div>
            )}
          </div>

          <div className="player-hero-identity">
            <div className="player-hero-eyebrow">
              {careerGp > 0 ? `통산 ${seasons.length}시즌 · ${careerGp}경기` : "선수 프로필"}
            </div>
            <h1 className="player-name">
              <span className="player-name-line">{nameHead}</span>
              {nameTail && <span className="player-name-line">{nameTail}</span>}
            </h1>
            {info.ename && <span className="player-ename">{info.ename}</span>}
          </div>
        </div>

        {careerGp > 0 && (
          <>
            <div className="player-hero-stats">
              <div className="stat-headline">
                <span className="stat-headline-val">{careerPpg.toFixed(1)}</span>
                <span className="stat-headline-label">
                  PPG
                  <br />
                  커리어 평균
                </span>
              </div>
              <div className="stat-companion">
                <span className="stat-companion-val">{careerRpg.toFixed(1)}</span>
                <span className="stat-companion-label">RPG</span>
              </div>
              <div className="stat-companion">
                <span className="stat-companion-val">{careerApg.toFixed(1)}</span>
                <span className="stat-companion-label">APG</span>
              </div>
            </div>
            <div className="player-hero-pct">
              <span>
                FG <b>{pct(careerFgPct)}</b>
              </span>
              <span>
                3P <b>{pct(careerTpPct)}</b>
              </span>
              <span>
                FT <b>{pct(careerFtPct)}</b>
              </span>
            </div>
          </>
        )}
      </div>

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
                ["MIN", windowAvg.min.toFixed(1), false],
                ["PTS", windowAvg.pts.toFixed(1), careerGp > 0 && windowAvg.pts > careerPpg],
                ["REB", windowAvg.reb.toFixed(1), careerGp > 0 && windowAvg.reb > careerRpg],
                ["AST", windowAvg.ast.toFixed(1), careerGp > 0 && windowAvg.ast > careerApg],
                ["STL", windowAvg.stl.toFixed(1), false],
                ["BLK", windowAvg.blk.toFixed(1), false],
                ["TOV", windowAvg.tov.toFixed(1), false],
                ["FG%", windowAvg.fgPct != null ? `${windowAvg.fgPct.toFixed(1)}%` : "-", false],
                ["3P%", windowAvg.tpPct != null ? `${windowAvg.tpPct.toFixed(1)}%` : "-", false],
                ["FT%", windowAvg.ftPct != null ? `${windowAvg.ftPct.toFixed(1)}%` : "-", false],
              ] as const
            ).map(([label, val, isUp]) => (
              <div className={`stat-tile${isUp ? " is-up" : ""}`} key={label}>
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
