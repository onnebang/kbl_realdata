import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { teamInkStyle } from "@/lib/teamAccent";
import { getSeasons, getTeamsForSeason, getGames, getPregameWinProbs, getLiveWinProbs, getGameMvps, getGameTags, getSeasonWinPcts } from "@/lib/homeGames";
import { deriveGameStatus } from "@/lib/gameStatus";
import HomeLiveRefresher from "@/components/HomeLiveRefresher";
import { PreseasonBanner } from "@/components/PreseasonBanner";

// 실측(라이브 검증 중 발견) - 기본 진입(팀 필터 없음, 최근 시즌)이 최대 200경기 x
// 선수당 ~24행짜리 MVP 조회까지 겹쳐서 병렬화 전엔 20~30초 가까이 걸림(lib/homeGames.ts의
// getGameMvps 청크 병렬화로 크게 줄였지만, Vercel 기본 서버리스 제한을 넘기지 않도록
// leaderboards/scoring-explorer와 같은 안전장치를 여기도 둠).
export const maxDuration = 60;

function fmtDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${y.slice(2)}.${m}.${day}`;
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; team?: string }>;
}) {
  const { season, team } = await searchParams;
  const seasons = await getSeasons();
  const activeSeason = season ?? seasons[0];
  const [teamOptions, games] = await Promise.all([getTeamsForSeason(activeSeason), getGames(activeSeason, team)]);

  const gmkeys = games.map((g) => g.gmkey);
  // MVP는 승패가 확정된 종료 경기만(진행중 경기는 스코어가 있어도 승자가 아직 없음),
  // 진행중 경기는 "현재" 승률(최신 이벤트)을 따로 조회.
  const finalGames = games.filter((g) => deriveGameStatus(g) === "final");
  const liveGmkeys = games.filter((g) => deriveGameStatus(g) === "live").map((g) => g.gmkey);
  const [winProbs, liveProbs, mvps, tags, seasonWinPcts] = await Promise.all([
    getPregameWinProbs(gmkeys),
    getLiveWinProbs(liveGmkeys),
    getGameMvps(finalGames),
    // 태그(짜릿한 역전승 등)는 game_summary_tags에 종료 경기만 들어있다 - 예정/진행중
    // gmkey까지 같이 넘기면 어차피 못 찾을 키로 IN 절만 불린다. 라이브 자동 갱신이
    // 30초마다 이 쿼리를 다시 때리므로 넘기는 키 수를 줄여둔다.
    getGameTags(finalGames.map((g) => g.gmkey)),
    getSeasonWinPcts(activeSeason),
  ]);

  return (
    <div className="wrap">
      <div className="title">코트사이드</div>
      <div className="subtitle">
        Supabase에 실제로 적재된 KBL 경기 데이터를 직접 조회합니다 - 경기를 선택하면
        승률 그래프와 박스스코어를 볼 수 있어요. 팀 이름을 누르면 그 팀의 시즌 일정으로
        이동합니다.
      </div>

      {/* 개막 전(이 시즌 종료 경기 0, 예정 경기 있음)에만 - 첫 경기가 끝나면 자동으로 사라짐. */}
      {finalGames.length === 0 && games.length > 0 && <PreseasonBanner season={activeSeason} />}

      <form className="filter-form">
        <select name="season" defaultValue={activeSeason}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s} 시즌
            </option>
          ))}
        </select>
        <select name="team" defaultValue={team ?? ""}>
          <option value="">전체 팀</option>
          {teamOptions.map((t) => (
            <option key={t.tcode} value={t.tcode}>
              {t.name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn-primary">
          보기
        </button>
      </form>

      <div className="game-list">
        {games.length === 0 && (
          <div className="empty-note">조건에 맞는 경기 데이터가 없음(마이그레이션 진행 중일 수 있음)</div>
        )}
        {games.map((g) => {
          // 상태(예정/진행중/종료)는 lib/gameStatus.ts 단일 정의로 판정 - 경기 페이지와
          // 같은 규칙. 예정: 배지/스코어 없이 "예정"+시각, 진행중: LIVE 배지+진행 스코어,
          // 종료: 기존 그대로.
          const status = deriveGameStatus(g);
          const homeWon = status === "final" && (g.home_score ?? 0) > (g.away_score ?? 0);
          const homeProb = status === "live" ? liveProbs.get(g.gmkey) ?? winProbs.get(g.gmkey) : winProbs.get(g.gmkey);
          const mvp = mvps.get(g.gmkey);
          const tag = tags.get(g.gmkey);
          const homeWinPct = g.home_team ? seasonWinPcts.get(g.home_team.tcode) : undefined;
          const awayWinPct = g.away_team ? seasonWinPcts.get(g.away_team.tcode) : undefined;
          const detailLabel = status === "scheduled" ? "미리보기 →" : status === "live" ? "라이브 보기 →" : "경기 상세보기 →";
          return (
            <div key={g.gmkey} className="game-card">
              <div className="game-card-row">
                <span className="game-card-date">{fmtDate(g.game_date)}</span>

                {status === "final" ? (
                  <span className={`result-badge ${homeWon ? "win" : "loss"}`} style={homeWon ? { background: g.home_team?.color } : undefined}>
                    {homeWon ? "W" : "L"}
                  </span>
                ) : (
                  <span className="result-badge-placeholder" />
                )}
                <Link
                  href={`/teams/${g.home_team?.tcode}?season=${activeSeason}`}
                  className={`team-name home ${homeWon ? "win" : ""}`}
                  style={teamInkStyle(g.home_team?.color)}
                >
                  {g.home_team?.name ?? g.gmkey}
                </Link>
                <Link href={`/teams/${g.home_team?.tcode}?season=${activeSeason}`}>
                  <TeamBadge
                    team={g.home_team ? { name: g.home_team.name, abbr: g.home_team.abbr, color: g.home_team.color, logoUrl: g.home_team.logo_url } : null}
                  />
                </Link>

                {status === "scheduled" ? (
                  // 예정 - 스코어 대신 "예정"(0-0처럼 빈 스코어로 보이는 것 방지)
                  <Link href={`/games/${g.gmkey}`} className="game-card-score">
                    <span className="status-chip status-scheduled">예정</span>
                  </Link>
                ) : (
                  <Link href={`/games/${g.gmkey}`} className="game-card-score">
                    <span className={status === "final" ? (homeWon ? "win" : "lose") : undefined}>{g.home_score}</span>
                    <span className="score-sep">-</span>
                    <span className={status === "final" ? (!homeWon ? "win" : "lose") : undefined}>{g.away_score}</span>
                  </Link>
                )}

                <Link href={`/teams/${g.away_team?.tcode}?season=${activeSeason}`}>
                  <TeamBadge
                    team={g.away_team ? { name: g.away_team.name, abbr: g.away_team.abbr, color: g.away_team.color, logoUrl: g.away_team.logo_url } : null}
                  />
                </Link>
                <Link
                  href={`/teams/${g.away_team?.tcode}?season=${activeSeason}`}
                  className={`team-name away ${status === "final" && !homeWon ? "win" : ""}`}
                  style={teamInkStyle(g.away_team?.color)}
                >
                  {g.away_team?.name ?? ""}
                </Link>
                {status === "final" ? (
                  <span className={`result-badge ${!homeWon ? "win" : "loss"}`} style={!homeWon ? { background: g.away_team?.color } : undefined}>
                    {!homeWon ? "W" : "L"}
                  </span>
                ) : (
                  <span className="result-badge-placeholder" />
                )}

                <span className="game-card-category-col">
                  {status === "live" && (
                    <span className="live-badge">
                      <span className="live-dot" />
                      LIVE
                    </span>
                  )}
                  <Link href={`/games/${g.gmkey}`} className="game-card-category">
                    {g.season_category}
                  </Link>
                  {tag && <span className={`ai-tag ai-tag-${tag.key}`}>{tag.label}</span>}
                </span>
              </div>

              <div className="game-card-meta">
                {status === "scheduled" && (
                  <span className="game-card-meta-item">
                    {fmtDate(g.game_date)}
                    {g.game_start ? ` ${g.game_start.slice(0, 5)}` : ""} 경기 예정
                  </span>
                )}
                {homeProb != null && (
                  <span className="game-card-meta-item">
                    {/* 원정 쪽은 100에서 홈 반올림값을 빼서 합이 항상 100 - 각자 반올림하면
                        50%·51%처럼 101%가 되는 경우가 실제로 관측됨(검증 지적). */}
                    예상 승률 {g.home_team?.abbr} {Math.round(homeProb * 100)}% · {g.away_team?.abbr} {100 - Math.round(homeProb * 100)}%
                  </span>
                )}
                {(homeWinPct || awayWinPct) && (
                  <span className="game-card-meta-item">
                    실제 시즌 승률 {g.home_team?.abbr} {homeWinPct ? `${Math.round(homeWinPct.pct * 100)}%` : "-"} ·{" "}
                    {g.away_team?.abbr} {awayWinPct ? `${Math.round(awayWinPct.pct * 100)}%` : "-"}
                  </span>
                )}
                <Link href={`/games/${g.gmkey}`} className="game-card-detail-btn">
                  {detailLabel}
                </Link>
                {(mvp?.winnerTop || mvp?.loserTop || mvp?.sixthMan) && (
                  <span className="game-card-meta-item game-card-meta-mvps">
                    {mvp?.winnerTop && (
                      <Link href={`/players/${mvp.winnerTop.pcode}`} className="game-card-mvp game-card-mvp-winner">
                        MVP {mvp.winnerTop.name} {mvp.winnerTop.pts}점
                      </Link>
                    )}
                    {mvp?.loserTop && (
                      <Link href={`/players/${mvp.loserTop.pcode}`} className="game-card-mvp game-card-mvp-loser">
                        분전 {mvp.loserTop.name} {mvp.loserTop.pts}점
                      </Link>
                    )}
                    {mvp?.sixthMan && (
                      <Link href={`/players/${mvp.sixthMan.pcode}`} className="game-card-mvp game-card-mvp-sixthman">
                        🔋 {mvp.sixthMan.name} {mvp.sixthMan.pts}점
                      </Link>
                    )}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* D. 진행중 경기가 하나라도 있을 때만 자동 갱신 타이머를 붙인다 - 없으면 이
          컴포넌트 자체가 렌더되지 않아 타이머도, 네트워크 요청도 0이다. */}
      {liveGmkeys.length > 0 && <HomeLiveRefresher />}

      <footer className="foot">
        {activeSeason} 시즌 · {games.length}경기 표시(최대 200경기) · Supabase 프로젝트
        &quot;who are u_kbl&quot;에서 실시간 조회
        {liveGmkeys.length > 0 && ` · 라이브 ${liveGmkeys.length}경기 진행중(30초마다 자동 갱신)`}
      </footer>
    </div>
  );
}
