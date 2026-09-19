import type { Metadata } from "next";
import { getSeasons, getSeasonGames, formatSeasonShort } from "@/lib/seasonBrowser";
import { getLeaderboardSeasons } from "@/lib/seasonLeaders";
import SeasonBrowserBoard from "@/components/SeasonBrowserBoard";
import { WidgetBoundary } from "@/components/WidgetBoundary";
import styles from "./season-browser.module.css";

// web/season_browser_template.html 포팅 - 홈 화면(app/page.tsx)이 "최근 경기 훑어보기"라면
// 이 페이지는 "한 시즌 전체를 검색+필터하며 박스스코어까지 파고들기"가 목적(courtside-web
// CLAUDE.md 지침). 기본 시즌은 seasons 테이블에서 가장 최근 시즌.

export default async function SeasonBrowserPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season } = await searchParams;
  const [seasons, playedSeasons] = await Promise.all([getSeasons(), getLeaderboardSeasons()]);
  // 기본 시즌은 경기가 끝난 가장 최근 시즌. seasons(전체 목록, 드롭다운용)에는 아직 경기가
  // 0개인 개막 전 시즌도 들어있어서, ?season=으로 그 시즌을 직접 가리키면(홈 화면의 "시즌
  // 브라우저" 유도 카드가 지금 보던 시즌 그대로 링크한다) 예전엔 seasons.includes만 봐서
  // 빈 화면으로 떨어졌다. playedSeasons(경기 있는 시즌)에 있을 때만 그대로 받는다.
  const requested = season?.trim() || null;
  const activeSeason = requested && playedSeasons.includes(requested) ? requested : (playedSeasons[0] ?? seasons[0]);
  const fellBack = requested && requested !== activeSeason ? requested : null;
  const games = activeSeason ? await getSeasonGames(activeSeason) : [];

  const regularCount = games.filter((g) => g.season_category === "정규시즌").length;
  const playoffCount = games.filter((g) => g.season_category === "플레이오프").length;

  return (
    <div className={styles.pageRoot}>
      <div className={styles.wrap}>
        <div className={styles.headerRow}>
          <div className={styles.title}>{activeSeason ? formatSeasonShort(activeSeason) : ""} 시즌 브라우저</div>
          <div className={styles.subtitle}>
            {fellBack && `${fellBack} 시즌은 아직 경기 기록이 없어 ${formatSeasonShort(activeSeason)} 시즌을 보여드립니다. `}
            {regularCount > 0 || playoffCount > 0
              ? `정규시즌 ${regularCount}경기 + 플레이오프 ${playoffCount}경기 - 전체 박스스코어. 문자중계 재생/승률그래프는 없고 최종 기록만.`
              : "이 시즌 경기 데이터가 아직 없습니다."}
          </div>

          <form className={styles.seasonForm}>
            <select name="season" aria-label="시즌 선택" defaultValue={activeSeason}>
              {seasons.map((s) => (
                <option key={s} value={s}>
                  {formatSeasonShort(s)} 시즌
                </option>
              ))}
            </select>
            <button type="submit" className={styles.btnPrimary}>
              보기
            </button>
          </form>
        </div>

        <WidgetBoundary name="시즌 경기 목록">
          <SeasonBrowserBoard games={games} />
        </WidgetBoundary>
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  title: "시즌 브라우저",
  description: "한 시즌 전체 경기를 검색·필터하고 박스스코어까지",
};
