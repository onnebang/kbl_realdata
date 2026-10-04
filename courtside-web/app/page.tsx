import Link from "next/link";
import { Fragment, type CSSProperties } from "react";
import { CourtsideHero } from "@/components/CourtsideHero";
import { TeamBadge } from "@/components/TeamBadge";
import { teamBarStyle, teamInkStyle } from "@/lib/teamAccent";
import {
  getSeasons,
  getTeamsForSeason,
  getGames,
  getPregameWinProbs,
  getLiveWinProbs,
  getLineupWinProbs,
  getGameMvps,
  getGameTags,
  getSeasonWinPcts,
  HOME_PAGE_SIZE,
} from "@/lib/homeGames";
import { deriveGameStatus } from "@/lib/gameStatus";
import { absenceText } from "@/lib/lineupText";
import HomeLiveRefresher from "@/components/HomeLiveRefresher";
import { PreseasonBanner } from "@/components/PreseasonBanner";

// 실측(라이브 검증 중 발견) - 기본 진입(팀 필터 없음, 최근 시즌)이 예전엔 최대 200경기 x
// 선수당 ~24행짜리 MVP 조회까지 겹쳐서 병렬화 전엔 20~30초 가까이 걸림(lib/homeGames.ts의
// getGameMvps 청크 병렬화로 크게 줄였고, 지금은 한 페이지 HOME_PAGE_SIZE(30)경기만 조회한다.
// 그래도 Vercel 기본 서버리스 제한을 넘기지 않도록 leaderboards/scoring-explorer와 같은
// 안전장치는 그대로 둠).
export const maxDuration = 60;

function fmtDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${y.slice(2)}.${m}.${day}`;
}

// 제보: "날짜가 잘 안 보인다" - 카드 하나당 12.5px 회색 글자 하나뿐이라 하루에 여러 경기가
// 있어도 날짜가 카드 수만큼 반복될 뿐 눈에 띄는 구분이 없었다. 카드 자체(폭 계산이 촘촘히
// 맞춰진 9열 그리드)는 그대로 두고, 날짜가 바뀔 때만 그 위에 굵은 헤더 한 줄을 끼워 넣는다
// (달력 그리드는 하루 1~3경기뿐인 이 목록에 과하다 - 30경기/페이지면 보통 열흘 안팎이라
// 헤더로도 하루 단위가 충분히 갈린다).
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;
function fmtDateHeader(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, day).getDay()];
  return `${y}년 ${m}월 ${day}일 (${wd})`;
}

// 보조 조회 전용 soft 폴백(감사 지적: MVP·태그·승률 중 하나만 실패해도 랜딩 전체가 error.tsx가
// 되고, 라이브 중엔 HomeLiveRefresher가 30초마다 그 오류 화면을 다시 만든다). 카드 장식이
// 빠진 채로라도 일정은 보여야 하므로 여기서만 삼키되, 조용히 삼키지는 않는다 - 반드시
// console.error로 남긴다. 본체(getSeasons / getTeamsForSeason / getGames)는 이 헬퍼로 감싸지
// 않는다: 그쪽 실패는 그대로 throw → app/error.tsx.
// NoInfer: T는 조회 함수의 반환 타입에서만 정해진다 - `new Map()`(Map<any, any>)이 T를 넓혀
// 아래 .get() 결과를 any로 만드는 일이 없게.
function soft<T>(label: string, p: Promise<T>, fallback: NoInfer<T>): Promise<T> {
  return p.catch((e: unknown) => {
    console.error("[home]", label, e);
    return fallback;
  });
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; team?: string; page?: string }>;
}) {
  const { season, team, page: pageParam } = await searchParams;
  const seasons = await getSeasons();
  const activeSeason = season ?? seasons[0];
  // ?page=abc / ?page=-3 은 1페이지로. 범위를 넘긴 값은 getGames가 마지막 페이지로 클램프해
  // 실제 페이지를 돌려준다(빈 화면 대신 마지막 장을 보여준다).
  const requestedPage = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const [teamOptions, { games, page, pageCount, total, offset, counts }] = await Promise.all([
    getTeamsForSeason(activeSeason),
    getGames(activeSeason, team, requestedPage),
  ]);

  // lib/homeGames.ts getGames와 같은 KST 기준 오늘 - 오늘 헤더에 배지를 단다.
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const gmkeys = games.map((g) => g.gmkey);
  // MVP는 승패가 확정된 종료 경기만(진행중 경기는 스코어가 있어도 승자가 아직 없음),
  // 진행중 경기는 "현재" 승률(최신 이벤트)을 따로 조회.
  const finalGames = games.filter((g) => deriveGameStatus(g) === "final");
  // **이 페이지에 실제로 그려지는** 라이브 경기만. 라이브는 목록 맨 앞 구간이라 사실상
  // 1페이지에만 나오고, 2페이지 이후에서는 이 배열이 비어 자동 갱신 타이머가 아예 안 붙는다.
  const liveGmkeys = games.filter((g) => deriveGameStatus(g) === "live").map((g) => g.gmkey);
  // 다섯 조회 전부 선택적 장식이라 각각 soft 폴백(빈 Map) - 어느 하나가 죽어도 카드의 그 칸만
  // 비고 일정은 그대로 그려진다. 폴백은 위 soft()가 console.error를 남긴 뒤에만 돌아온다.
  const [winProbs, liveProbs, mvps, lineupWinProbs, tags, seasonWinPcts] = await Promise.all([
    soft("pregameWinProbs", getPregameWinProbs(gmkeys), new Map()),
    soft("liveWinProbs", getLiveWinProbs(liveGmkeys), new Map()),
    soft("gameMvps", getGameMvps(finalGames), new Map()),
    soft("lineupWinProbs", getLineupWinProbs(gmkeys), new Map()),
    // 태그(짜릿한 역전승 등)는 game_summary_tags에 종료 경기만 들어있다 - 예정/진행중
    // gmkey까지 같이 넘기면 어차피 못 찾을 키로 IN 절만 불린다. 라이브 자동 갱신이
    // 30초마다 이 쿼리를 다시 때리므로 넘기는 키 수를 줄여둔다.
    soft("gameTags", getGameTags(finalGames.map((g) => g.gmkey)), new Map()),
    soft("seasonWinPcts", getSeasonWinPcts(activeSeason), new Map()),
  ]);

  // 페이지 이동 링크 - **클라이언트 JS 없이** 쿼리스트링만 바꾼다(이 사이트 관례).
  // 사용자가 고른 필터(시즌·팀)는 그대로 유지하고, 고르지 않은 값은 URL에 넣지 않는다
  // (기본 진입 URL을 더럽히지 않기 위해). 1페이지는 ?page를 아예 안 붙인다.
  const pageHref = (p: number) => {
    const qs = new URLSearchParams();
    if (season) qs.set("season", season);
    if (team) qs.set("team", team);
    if (p > 1) qs.set("page", String(p));
    const q = qs.toString();
    return q ? `/?${q}` : "/";
  };
  const pagerLabel = { display: "inline-block", padding: "7px 6px", fontSize: "12px", color: "var(--ink-faint)" } as const;
  const pagerDisabled = { opacity: 0.35 } as const;

  return (
    <>
      {/* 요청: "첫 화면이 trailer가 되어서 메인에서 압도 할 수 있도록". /trailer의 첫 절과 같은
          어법(딥다크 무대·워드마크·코트 배경)을 홈 맨 위 전면에 낸다 - .wrap의 1180px 제약
          밖에서 화면 끝까지 번져야 "압도"가 되므로 .wrap 바깥, NavBar 바로 아래에 둔다
          (app/trailer/page.tsx가 .stage를 .wrap 밖에 두는 것과 같은 구조). 예전엔 여기가
          그냥 <div className="title">코트사이드</div> 한 줄이었다 - 페이지에 유일한 <h1>도
          없었는데, 히어로의 워드마크가 그 자리를 겸한다. */}
      <CourtsideHero />
      <div className="wrap">
        {/* 개막 전(이 시즌 종료 경기 0, 예정 경기 있음)에만 - 첫 경기가 끝나면 자동으로 사라짐.
            판정은 시즌 전체 개수(counts)로 한다 - finalGames는 이제 "이 페이지의" 종료 경기라,
            예정 경기가 많은 시즌에서는 1페이지에 종료 경기가 한 건도 안 걸릴 수 있다. */}
        {counts.final === 0 && total > 0 && <PreseasonBanner season={activeSeason} />}

        {/* id="games" - 히어로의 "오늘 경기 보기" 버튼이 여기로 스크롤한다. NavBar가
            sticky가 아니라서 scroll-margin-top 보정은 필요 없다(실측). */}
        <form id="games" className="filter-form">
        <select name="season" aria-label="시즌 선택" defaultValue={activeSeason}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s} 시즌
            </option>
          ))}
        </select>
        <select name="team" aria-label="팀 선택" defaultValue={team ?? ""}>
          <option value="">전체 팀</option>
          {teamOptions.map((t) => (
            <option key={t.tcode} value={t.tcode}>
              {t.name}
            </option>
          ))}
        </select>
        {/* GET 폼은 현재 쿼리스트링을 이 필드들로 통째로 갈아끼운다 - 필터를 바꾸면 page가
            자동으로 떨어져 1페이지부터 다시 본다(원하는 동작). */}
        <button type="submit" className="btn-primary">
          보기
        </button>
      </form>

      <div className="game-list">
        {games.length === 0 && (
          <div className="empty-note">이 조건에 맞는 경기가 없습니다. 시즌이나 팀을 바꿔 보세요.</div>
        )}
        {games.map((g, i) => {
          // 같은 날짜 경기가 몇 개인지는 헤더 옆 카운트로 쓴다(정렬이 game_date순이라
          // 같은 날짜는 항상 붙어 있다 - lib/homeGames.ts).
          const showDateHeader = i === 0 || games[i - 1].game_date !== g.game_date;
          const dayCount = showDateHeader ? games.filter((x) => x.game_date === g.game_date).length : 0;
          // 상태(예정/진행중/종료)는 lib/gameStatus.ts 단일 정의로 판정 - 경기 페이지와
          // 같은 규칙. 예정: 배지/스코어 없이 "예정"+시각, 진행중: LIVE 배지+진행 스코어,
          // 종료: 기존 그대로.
          const status = deriveGameStatus(g);
          const homeWon = status === "final" && (g.home_score ?? 0) > (g.away_score ?? 0);
          const seasonProb = winProbs.get(g.gmkey);
          const liveProb = status === "live" ? liveProbs.get(g.gmkey) : undefined;
          // 엔트리 반영 승률 - 원래 "예정" 상태에만 보여줬으나, 경기 종료 후에도
          // 엔트리에 따른 승률 차이를 보여달라는 요청에 따라 항상 표시한다.
          const lineupInfo = lineupWinProbs.get(g.gmkey);
          const mvp = mvps.get(g.gmkey);
          const tag = tags.get(g.gmkey);
          const homeWinPct = g.home_team ? seasonWinPcts.get(g.home_team.tcode) : undefined;
          const awayWinPct = g.away_team ? seasonWinPcts.get(g.away_team.tcode) : undefined;
          // 화살표는 붙이지 않는다 - 링크라는 사실은 이미 자리와 색이 말한다.
          const detailLabel = status === "scheduled" ? "미리보기" : status === "live" ? "라이브 보기" : "경기 상세보기";
          return (
            <Fragment key={g.gmkey}>
              {showDateHeader && (
                <div className="game-date-header">
                  <span className="game-date-header-main">
                    {g.game_date === todayKst && <span className="game-date-header-today">오늘</span>}
                    {fmtDateHeader(g.game_date)}
                  </span>
                  <span className="game-date-header-count">{dayCount}경기</span>
                </div>
              )}
              <div className="game-card">
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
                  // --ti-* = 글자색(안 쓰지만 .team-ink 규약 공유), --tb-* = 이름 옆 3px 팀 색 바.
                  // 막대는 글자가 아니라 표식이라 3:1 기준(teamBarPair)이다 - 4.5:1로 보정하면
                  // 원색에서 필요 이상으로 멀어지고, accentFor를 쓰면 라이트 테마에서 밝은 팀 색이
                  // 사라진다(실측: 고양 소노 #3FA9F5가 흰 카드 위 2.30:1).
                  style={{ ...teamInkStyle(g.home_team?.color), ...teamBarStyle(g.home_team?.color) } as CSSProperties}
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
                  style={{ ...teamInkStyle(g.away_team?.color), ...teamBarStyle(g.away_team?.color) } as CSSProperties}
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
                {seasonProb != null && (
                  <span className="game-card-meta-item">
                    {/* 원정 쪽은 100에서 홈 반올림값을 빼서 합이 항상 100 - 각자 반올림하면
                        50%·51%처럼 101%가 되는 경우가 실제로 관측됨(검증 지적). 엔트리 반영
                        값이 따로 있으면(아래 줄) 이 줄이 "시즌 기준"임을 밝혀 혼동을 막는다. */}
                    예상 승률(시즌 기준) {g.home_team?.abbr} {Math.round(seasonProb * 100)}% ·{" "}
                    {g.away_team?.abbr} {100 - Math.round(seasonProb * 100)}%
                    {/* OPEN MATCH DAY(오픈매치, 2026-27시즌 신설)는 모델이 학습 때 한 번도 못
                        본 경기 유형이라 일반 경기와 신뢰도가 다름 - 제거하지 않고 문구로만
                        명시(사용자 결정, 2026-09-24). */}
                    {g.season_category === "OPEN MATCH DAY" && (
                      <span className="prob-caveat"> · 오픈매치(참고용)</span>
                    )}
                  </span>
                )}
                {lineupInfo && (
                  <span className="game-card-meta-item">
                    {/* 요청(2026-09-25): "승률을 2개를 적어야할것 같아... 어느 부분에서
                        변동이 있었는지" - 이정현 결장으로 소노 승률이 크게 내려간 사례가
                        계기. 결장자가 있을 때만 사유를 덧붙인다(핵심 로테이션 전원 출전이면
                        그냥 "엔트리 기준"이라고만 쓴다). */}
                    예상 승률(엔트리 기준) {g.home_team?.abbr} {Math.round(lineupInfo.lineupProb * 100)}% ·{" "}
                    {g.away_team?.abbr} {100 - Math.round(lineupInfo.lineupProb * 100)}%
                    {(lineupInfo.absentHome.length > 0 || lineupInfo.absentAway.length > 0) && (
                      <span className="prob-caveat">
                        {" "}
                        ·{" "}
                        {absenceText(g.home_team?.abbr ?? "", g.away_team?.abbr ?? "", lineupInfo)} 결장
                      </span>
                    )}
                  </span>
                )}
                {liveProb != null && (
                  <span className="game-card-meta-item live-prob">
                    실시간 예측 승률 {g.home_team?.abbr} {Math.round(liveProb * 100)}% ·{" "}
                    {g.away_team?.abbr} {100 - Math.round(liveProb * 100)}%
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
            </Fragment>
          );
        })}
      </div>

      {/* 이전/다음 - 링크 두 개와 현재 위치뿐이다("더 보기"처럼 목록을 계속 이어 붙이면
          라이브 갱신이 다시 그 전체를 내려받게 되므로 쓰지 않는다).
          prefetch={false}: Next의 기본 프리페치는 다음 페이지 페이로드를 미리 당겨와서,
          페이지네이션으로 아낀 바이트를 사용자가 누르지도 않은 채 도로 쓴다. */}
      {pageCount > 1 && (
        <nav className="filter-form" aria-label="경기 목록 페이지 이동">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="btn-primary" rel="prev" prefetch={false}>
              ← 이전 {HOME_PAGE_SIZE}경기
            </Link>
          ) : (
            <span className="btn-primary" style={pagerDisabled} aria-disabled="true">
              ← 이전 {HOME_PAGE_SIZE}경기
            </span>
          )}
          <span style={pagerLabel} aria-current="page">
            {page} / {pageCount} 페이지
          </span>
          {page < pageCount ? (
            <Link href={pageHref(page + 1)} className="btn-primary" rel="next" prefetch={false}>
              다음 {HOME_PAGE_SIZE}경기 →
            </Link>
          ) : (
            <span className="btn-primary" style={pagerDisabled} aria-disabled="true">
              다음 {HOME_PAGE_SIZE}경기 →
            </span>
          )}
        </nav>
      )}

      {/* D. 진행중 경기가 하나라도 있을 때만 자동 갱신 타이머를 붙인다 - 없으면 이
          컴포넌트 자체가 렌더되지 않아 타이머도, 네트워크 요청도 0이다. liveGmkeys는
          **지금 보고 있는 페이지**의 라이브 경기라, 라이브가 없는 2페이지 이후에서는
          30초마다 아무것도 오가지 않는다. */}
      {liveGmkeys.length > 0 && <HomeLiveRefresher />}

      {/* 요청: "경기 목록에 시즌 브라우저와 시즌 리더를 노출시켜서 자연스럽게 유도" - 목록을
          다 보고 난 자리(페이지네이션 바로 다음)에 다음 볼거리 세 장을 둔다. 시즌을 유지해서
          "지금 보던 그 시즌"으로 바로 넘어가게 한다. */}
      <div className="related-row">
        <Link href={`/season-browser?season=${encodeURIComponent(activeSeason)}`} className="related-card">
          <span className="related-kicker">시즌 브라우저</span>
          <span className="related-main">{activeSeason} 팀·선수 기록 한눈에</span>
          <span className="related-sub">경기별 박스스코어를 팀·선수 단위로 훑어보기</span>
        </Link>
        <Link href={`/leaderboards/season?season=${encodeURIComponent(activeSeason)}`} className="related-card">
          <span className="related-kicker">시즌 리더보드</span>
          <span className="related-main">부문별 순위 보기</span>
          <span className="related-sub">득점·리바운드부터 4팩터까지 {activeSeason} 랭킹</span>
        </Link>
        <Link href={`/leaderboards/win-contribution?season=${encodeURIComponent(activeSeason)}`} className="related-card">
          <span className="related-kicker">승부를 가른 순간</span>
          <span className="related-main">시즌 최고의 한 방·역전 모음</span>
          <span className="related-sub">경기 중 승률을 가장 크게 움직인 장면들</span>
        </Link>
      </div>

      <footer className="foot">
        {activeSeason} 시즌 · 전체 {total}경기 중{" "}
        {games.length > 0 ? `${offset + 1}-${offset + games.length}번째` : "0번째"} 표시(
        {page}/{pageCount} 페이지)
        {liveGmkeys.length > 0 && ` · 라이브 ${liveGmkeys.length}경기 진행중(30초마다 자동 갱신)`}
      </footer>
      </div>
    </>
  );
}
