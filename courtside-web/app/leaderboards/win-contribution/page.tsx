import type { Metadata } from "next";
import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { PlayerPhoto } from "@/components/PlayerPhoto";
import { getSeasonsWithWpaData, getWinContributionLeaderboard, type SortKey } from "@/lib/winContributionLeaderboard";
import { curvePath, curvePos, getWinMoments, REGULATION_SEC, type BigPlay, type Comeback, type CurvePoint, type WeightPoint } from "@/lib/winMoments";
import { getAllTeams } from "@/lib/playerProfile";
import { teamBarStyle } from "@/lib/teamAccent";
import styles from "./win-contribution.module.css";

// "승부를 가른 순간"(2026-09-15 개편, 옛 "승리 기여도 리더보드").
// 옛 화면은 선수 시즌 WPA 순위표였는데, 그 값은 시즌 득점과 r=0.991이라 사실상 득점 순위였다
// (WPA가 넣은 슛에만 붙는다 - tools/rpc_win_moments.sql 머리 주석의 실측). 이 데이터가 확실히 말하는
// '순간'을 앞에 둔다: 한 경기에서 승률을 가장 크게 움직인 장면, 이긴 팀이 거의 졌던 경기, 그리고 득점 대비
// 무게(재현성이 약하다는 캡션과 함께, 순위 없이). 선수별 표는 맨 아래 접어 둔다.

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "games", label: "GP" },
  { key: "totalWpa", label: "WPA" },
  { key: "wpaPerGame", label: "WPA/G" },
  { key: "posWpa", label: "+WPA" },
  { key: "negWpa", label: "-WPA" },
];

const fmtWpa = (v: number, decimals = 2) => `${v > 0 ? "+" : ""}${v.toFixed(decimals)}`;
const pctInt = (p: number) => `${Math.round(p * 100)}%`;
/** 최저 승률은 10% 아래에서 소수 한 자리 - 1%와 4%는 같은 '한 자리'가 아니다. */
const pctLow = (p: number) => (p < 0.1 ? `${(p * 100).toFixed(1)}%` : pctInt(p));
const shortDate = (d: string) => `${d.slice(2, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}`;

const CURVE_W = 300;
const CURVE_H = 80;

function Curve({ curve, elapsed, prob, tall }: { curve: CurvePoint[]; elapsed: number; prob: number; tall?: boolean }) {
  const xMax = Math.max(REGULATION_SEC, curve.length ? curve[curve.length - 1][0] : 0);
  return (
    <div className={`${styles.curve} ${tall ? styles.curveTall : ""}`} aria-hidden="true">
      <svg viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} preserveAspectRatio="none">
        {[600, 1200, 1800].map((t) => (
          <line key={t} x1={(t / xMax) * CURVE_W} x2={(t / xMax) * CURVE_W} y1={0} y2={CURVE_H} className={styles.curveQuarter} vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={0} x2={CURVE_W} y1={CURVE_H / 2} y2={CURVE_H / 2} className={styles.curveMid} vectorEffect="non-scaling-stroke" />
        <path d={curvePath(curve, CURVE_W, CURVE_H)} className={styles.curveLine} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className={styles.curveDot} style={curvePos(curve, elapsed, prob)} />
    </div>
  );
}

function resultLine(p: BigPlay) {
  return `최종 ${p.finalTeam}-${p.finalOpp} ${p.won ? "승리" : "패배"}`;
}

function HeroPlay({ p }: { p: BigPlay }) {
  return (
    <article className={styles.hero} style={teamBarStyle(p.team.color)}>
      {/* 요청("팀 로고를 은은하게") - 장식이라 aria-hidden, 카드 배경에 아주 낮은 불투명도로만.
          TeamBadge는 원형 클립·테두리·패딩이 있어(작은 배지용) 이 워터마크엔 맞지 않는다 - 로고를
          그대로, TeamBadge.tsx와 같은 이유로 next/image 우회(외부 kbl.or.kr 호스팅, 배경 장식이라
          최적화 이득 없음). */}
      {p.team.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.team.logoUrl} alt="" aria-hidden="true" className={styles.heroLogoWatermark} />
      )}
      <div className={styles.heroNum}>
        <span className={styles.swing}>+{Math.round(p.wpa * 100)}</span>
        <span className={styles.swingUnit}>%p</span>
        <div className={styles.numLabel}>승률 상승</div>
      </div>
      <div className={styles.heroText}>
        <div className={styles.kicker}>
          {shortDate(p.gameDate)} · {p.period} {p.clock} · {p.shot}
        </div>
        <div className={styles.heroPlayerRow}>
          {p.photoUrl && (
            <span className={styles.heroAvatar}>
              <PlayerPhoto src={p.photoUrl} size={40} />
            </span>
          )}
          <Link href={`/players/${p.pcode}`} className={styles.heroName}>
            {p.playerName}
          </Link>
        </div>
        <div className={styles.context}>
          {p.team.name} {p.teamScore}-{p.oppScore} {p.opp.name}
        </div>
        <div className={styles.result}>
          직전 승률 {pctInt(p.probBefore)} · {resultLine(p)}
        </div>
        <Link href={`/games/${p.gmkey}`} className={styles.gameLink}>
          이 경기 보기
        </Link>
      </div>
      <Curve curve={p.curve} elapsed={p.elapsed} prob={Math.min(1, p.probBefore + p.wpa)} tall />
    </article>
  );
}

function PlayCard({ p, rank }: { p: BigPlay; rank: number }) {
  return (
    <article className={styles.card} style={teamBarStyle(p.team.color)}>
      {p.team.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.team.logoUrl} alt="" aria-hidden="true" className={styles.cardLogoWatermark} />
      )}
      <div className={styles.cardTop}>
        <span className={styles.rank}>{rank}</span>
        <span className={styles.cardSwing}>+{Math.round(p.wpa * 100)}%p</span>
      </div>
      <div className={styles.cardNameRow}>
        {p.photoUrl && (
          <span className={styles.cardAvatar}>
            <PlayerPhoto src={p.photoUrl} size={24} />
          </span>
        )}
        <Link href={`/players/${p.pcode}`} className={styles.cardName}>
          {p.playerName}
        </Link>
      </div>
      <div className={styles.cardLine}>
        {p.period} {p.clock} · {p.shot} · {p.team.name} {p.teamScore}-{p.oppScore} {p.opp.name}
      </div>
      <Curve curve={p.curve} elapsed={p.elapsed} prob={Math.min(1, p.probBefore + p.wpa)} />
      <div className={styles.cardFoot}>
        <span>
          {shortDate(p.gameDate)} · 직전 {pctInt(p.probBefore)} · {resultLine(p)}
        </span>
        <Link href={`/games/${p.gmkey}`}>경기 보기</Link>
      </div>
    </article>
  );
}

function ComebackCard({ c }: { c: Comeback }) {
  const trailing = c.winnerScoreAtMin < c.loserScoreAtMin;
  return (
    <article className={styles.card} style={teamBarStyle(c.winner.color)}>
      <div className={styles.cardTop}>
        <span className={styles.lowProb}>{pctLow(c.minProb)}</span>
        <span className={styles.numLabel}>이긴 팀의 최저 승률</span>
      </div>
      <div className={styles.cardName}>
        {c.winner.name} {c.finalWinner}-{c.finalLoser} {c.loser.name}
      </div>
      <div className={styles.cardLine}>
        {c.period} {c.clock}, {c.winnerScoreAtMin}-{c.loserScoreAtMin}
        {trailing ? `로 ${c.loserScoreAtMin - c.winnerScoreAtMin}점 뒤질 때` : "일 때"}
      </div>
      <Curve curve={c.curve} elapsed={c.elapsed} prob={c.minProb} />
      <div className={styles.cardFoot}>
        <span>{shortDate(c.gameDate)}</span>
        <Link href={`/games/${c.gmkey}`}>경기 보기</Link>
      </div>
    </article>
  );
}

function WeightScatter({ players, perPoint, r }: { players: WeightPoint[]; perPoint: number; r: number }) {
  const xMax = Math.ceil(Math.max(100, ...players.map((p) => p.pts)) / 100) * 100;
  const yMax = Math.ceil(Math.max(1, ...players.map((p) => p.wpa)) / 2) * 2;
  // 선 위/아래로 가장 멀리 떨어진 선수(득점 대비 비율)만 이름을 단다 - 순위가 아니라 읽을 거리.
  const byRatio = players.filter((p) => p.pts >= 400).map((p) => ({ p, ratio: p.wpa / (p.pts * perPoint) - 1 })).sort((a, b) => b.ratio - a.ratio);
  const labeled = new Set([...byRatio.slice(0, 3), ...byRatio.slice(-3)].map((x) => x.p.pcode));
  // 좁은 화면에서는 위·아래 끝 한 명씩만 - 이름표가 점을 덮는다.
  const primary = new Set([byRatio[0]?.p.pcode, byRatio[byRatio.length - 1]?.p.pcode]);
  const lineEnd = Math.min(yMax, xMax * perPoint);
  return (
    <div className={styles.scatterWrap}>
      <div className={styles.axisRow}>
        <span>↑ 시즌 WPA 합계</span>
        <span>위 끝 {yMax}</span>
      </div>
      <div className={styles.scatter}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {[25, 50, 75].map((g) => (
            <g key={g}>
              <line x1={g} x2={g} y1={0} y2={100} className={styles.grid} vectorEffect="non-scaling-stroke" />
              <line x1={0} x2={100} y1={g} y2={g} className={styles.grid} vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          <line x1={0} y1={100} x2={(lineEnd / perPoint / xMax) * 100} y2={100 - (lineEnd / yMax) * 100} className={styles.leagueLine} vectorEffect="non-scaling-stroke" />
        </svg>
        {players.map((p) => {
          const left = (p.pts / xMax) * 100;
          const bottom = (Math.max(0, p.wpa) / yMax) * 100;
          const above = p.wpa >= p.pts * perPoint;
          const label = `${p.playerName} (${p.team.name}) · ${p.pts}점 · WPA ${p.wpa.toFixed(2)}`;
          // 요청("무리에서 떨어진 선수는 프로필 사진으로") - 이름표를 다는 선수(labeled)만, 그리고
          // 사진이 있을 때만(773명 중 130명) 점 대신 원형 사진. 나머지는 기존 점 그대로.
          if (labeled.has(p.pcode) && p.photoUrl) {
            return (
              <Link
                key={p.pcode}
                href={`/players/${p.pcode}`}
                className={`${styles.dotPhoto} ${above ? styles.dotPhotoAbove : styles.dotPhotoBelow}`}
                style={{ left: `${left}%`, bottom: `${bottom}%` }}
                aria-label={label}
                title={label}
              >
                <PlayerPhoto src={p.photoUrl} size={22} />
              </Link>
            );
          }
          return (
            <Link
              key={p.pcode}
              href={`/players/${p.pcode}`}
              className={`${styles.dot} ${above ? styles.dotAbove : styles.dotBelow}`}
              style={{ left: `${left}%`, bottom: `${bottom}%` }}
              aria-label={label}
              title={label}
            />
          );
        })}
        {players
          .filter((p) => labeled.has(p.pcode))
          .map((p) => {
            const left = (p.pts / xMax) * 100;
            const isPhoto = Boolean(p.photoUrl);
            const wideCls = isPhoto ? (left > 70 ? styles.dotLabelWideLeft : styles.dotLabelWide) : left > 70 ? styles.dotLabelLeft : "";
            return (
              <span
                key={`l-${p.pcode}`}
                className={`${styles.dotLabel} ${wideCls} ${primary.has(p.pcode) ? "" : styles.dotLabelMinor}`}
                style={{ left: `${left}%`, bottom: `${(Math.max(0, p.wpa) / yMax) * 100}%` }}
              >
                {p.playerName}
              </span>
            );
          })}
      </div>
      <div className={styles.axisRow}>
        <span>0</span>
        <span>시즌 득점 →</span>
        <span>{xMax}점</span>
      </div>
      <div className={styles.legend}>
        <span>
          <i className={styles.legendLine} /> 리그 평균 무게(1점당 WPA {perPoint.toFixed(4)})
        </span>
        <span>
          <i className={`${styles.legendDot} ${styles.dotAbove}`} /> 선 위: 같은 득점을 더 큰 순간에
        </span>
        <span>
          <i className={`${styles.legendDot} ${styles.dotBelow}`} /> 선 아래
        </span>
        <span className={styles.legendR}>득점과 WPA의 상관 r = {r.toFixed(2)}</span>
      </div>
    </div>
  );
}

export default async function WinContributionPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; sort?: string; dir?: string; team?: string }>;
}) {
  const { season, sort, dir, team } = await searchParams;
  const [seasons, teams] = await Promise.all([getSeasonsWithWpaData(), getAllTeams()]);
  const activeSeason = season && seasons.includes(season) ? season : seasons[0];
  const activeTeam = team && teams.has(team) ? teams.get(team)! : null;
  const sortKey = (COLUMNS.find((c) => c.key === sort)?.key ?? "totalWpa") as SortKey;
  const ascending = dir === "asc";

  // 팀 필터는 team_coach_season처럼 이미 있는 값을 다시 세는 게 아니라, 두 조회 모두 팀
  // 단위로 다시 부른다(team 페이지에서 넘어온 링크는 "그 팀의 top-12"를 기대한다 - 리그
  // top-12를 클라이언트에서 걸러내면 대부분 0~1개만 남는다. tools/rpc_win_moments_team_filter.sql).
  const [moments, rows] = await Promise.all([
    getWinMoments(activeSeason, activeTeam?.tcode),
    getWinContributionLeaderboard(activeSeason, sortKey, ascending),
  ]);
  const teamRows = activeTeam ? rows.filter((r) => r.tcode === activeTeam.tcode) : rows;
  const [hero, ...restPlays] = moments.plays;
  const sortLink = (key: SortKey) =>
    `?season=${encodeURIComponent(activeSeason)}${activeTeam ? `&team=${activeTeam.tcode}` : ""}&sort=${key}&dir=${sortKey === key && !ascending ? "asc" : "desc"}#table`;

  return (
    <div className={styles.pageRoot}>
      <div className="wrap">
        <header className={styles.headerRow}>
          <div>
            <h1 className={`title ${styles.title}`}>승부를 가른 순간</h1>
            <p className={`subtitle ${styles.lede}`}>
              같은 3점도 언제 넣었느냐에 따라 무게가 다릅니다. {activeSeason} 정규시즌{activeTeam ? ` ${activeTeam.name} 경기` : ""}에서
              경기 중 승률을 한 번에 가장 크게 움직인 장면과, 거의 진 경기를 뒤집은 역전을 모았습니다.
            </p>
          </div>
          <form className={styles.seasonForm}>
            {activeTeam && <input type="hidden" name="team" value={activeTeam.tcode} />}
            <select name="season" defaultValue={activeSeason} aria-label="시즌">
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
        </header>

        {/* 팀 페이지 "이 팀의 결정적 순간" 카드를 타고 들어온 경우 - 어떤 필터가 걸렸는지,
            어떻게 풀지를 첫 화면에서 바로 보여준다. */}
        {activeTeam && (
          <div className={styles.teamFilterBar} style={teamBarStyle(activeTeam.color)}>
            <TeamBadge team={{ name: activeTeam.name, abbr: activeTeam.abbr, color: activeTeam.color, logoUrl: activeTeam.logoUrl }} size={22} />
            <span>
              <Link href={`/teams/${activeTeam.tcode}?season=${encodeURIComponent(activeSeason)}`}>{activeTeam.name}</Link>의 장면만 보는 중
            </span>
            <Link href={`?season=${encodeURIComponent(activeSeason)}`} className={styles.teamFilterClear}>
              전체 리그 보기
            </Link>
          </div>
        )}

        {hero && (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>{activeTeam ? `${activeTeam.name} 최고의 한 방` : "시즌 최고의 한 방"}</h2>
              <span className={styles.sectionNote}>한 경기에서 가장 큰 장면 하나씩 · 득점한 팀의 승률이 오른 폭</span>
            </div>
            <HeroPlay p={hero} />
            <div className={styles.grid3}>
              {restPlays.map((p, i) => (
                <PlayCard key={p.gmkey} p={p} rank={i + 2} />
              ))}
            </div>
            <p className={styles.note}>
              곡선은 그 팀의 경기 중 승률(가운데 선 50%, 세로 줄은 쿼터), 금색 점이 그 장면입니다. 승률 모델은 점수와 남은 시간만 보기
              때문에 경기 종료 버저 순간의 승률을 100%로 올리지 못합니다 - 곡선 끝은 실제 결과로 닫았습니다.
            </p>
          </section>
        )}

        {moments.comebacks.length > 0 && (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>{activeTeam ? `${activeTeam.name}의 가장 극적인 역전` : "가장 극적인 역전"}</h2>
              <span className={styles.sectionNote}>이긴 팀의 경기 중 최저 승률이 낮았던 순</span>
            </div>
            <div className={styles.grid3}>
              {moments.comebacks.map((c) => (
                <ComebackCard key={c.gmkey} c={c} />
              ))}
            </div>
          </section>
        )}

        {moments.weight.players.length > 0 && (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>득점의 무게</h2>
              <span className={styles.sectionNote}>점 하나가 선수 한 명 · 시즌 200점 이상 {moments.weight.players.length}명</span>
            </div>
            <div className={styles.panelBox}>
              <WeightScatter players={moments.weight.players} perPoint={moments.weight.perPoint} r={moments.weight.r} />
              <ul className={styles.captions}>
                <li>
                  WPA는 넣은 슛에 거의 전부 붙습니다(실패한 슛·턴오버·리바운드는 승률 모델이 점수와 시간만 보기 때문에 거의 0). 그래서
                  세로 위치는 득점과 함께 움직입니다(r = {moments.weight.r.toFixed(2)}).
                </li>
                <li>
                  선에서 벗어난 만큼이 &ldquo;같은 득점을 얼마나 승부가 걸린 순간에 넣었나&rdquo;입니다. 다만 한 시즌을 홀·짝 경기로 나눠
                  보면 이 차이는 약하게만 재현되고(r 0.36, 최근 3시즌), 소속 팀이 접전을 얼마나 치르는지에도 좌우됩니다 - 순위로 읽지
                  마세요.
                </li>
              </ul>
            </div>
          </section>
        )}

        <details className={styles.tableDetails} id="table" open={Boolean(sort)}>
          <summary className={styles.tableSummary}>
            선수별 WPA 표{activeTeam ? ` · ${activeTeam.name}` : " 전체"} ({teamRows.length}명)
          </summary>
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
                {teamRows.map((r, i) => (
                  <tr key={r.pcode}>
                    <td className={styles.rankCell}>{i + 1}</td>
                    <td className={styles.playerCell}>
                      <Link href={`/players/${r.pcode}`}>{r.playerName}</Link>
                    </td>
                    <td>
                      <TeamBadge team={{ name: r.teamName, abbr: r.teamAbbr, color: r.teamColor, logoUrl: r.teamLogoUrl }} size={20} />
                    </td>
                    <td>{r.games}</td>
                    <td className={styles.totalCell}>{fmtWpa(r.totalWpa)}</td>
                    <td>{fmtWpa(r.wpaPerGame, 3)}</td>
                    <td>{fmtWpa(r.posWpa)}</td>
                    <td>{fmtWpa(r.negWpa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.explainBox}>
            <b>WPA(Win Probability Added)</b> - 플레이 직전과 직후의 승률 차이를 그 선수에게 붙인 값(원정팀은 부호를 뒤집어 자기 팀
            기준). +WPA는 올린 플레이만, -WPA는 내린 플레이만 합산. 실측상 값은 거의 넣은 슛에만 붙어서 -WPA가 작고 합계는 득점과
            함께 움직입니다. 정규시즌만 포함.
          </div>
        </details>

        <footer className="foot">{activeSeason} 정규시즌 · 경기 이벤트 승률 모델 기준</footer>
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  title: "승부를 가른 순간",
  description: "경기 중 승률을 한 번에 가장 크게 움직인 장면, 이긴 팀이 거의 졌던 역전 경기, 득점의 무게",
};
