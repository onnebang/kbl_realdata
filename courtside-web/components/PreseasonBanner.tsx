import Link from "next/link";
import { getSeasonOpener, daysUntilKst, shortSeason } from "@/lib/preseason";
import styles from "./PreseasonBanner.module.css";

// 홈 상단 개막 배너 - 요청: "시즌 시작전 리포트를 먼저 제공하고... 이렇게 중계가 보일거다라는
// 것을 알려주면". 개막 여부 판정은 getSeasonOpener 안에 있다(리그 전체에 치른 경기가 하나라도
// 있으면 null을 돌려주고 배너는 렌더되지 않음) - 홈 화면의 렌더 조건은 팀 필터가 걸린 목록을
// 보기 때문에 그것만으로는 "그 팀만 아직 안 뛴 시즌 중반"과 개막 전을 구분하지 못한다.
export async function PreseasonBanner({ season }: { season: string }) {
  const opener = await getSeasonOpener(season);
  if (!opener) return null;
  const d = daysUntilKst(opener.firstGameDate);
  const [y, m, day] = opener.firstGameDate.split("-");
  const when = d > 0 ? `D-${d}` : d === 0 ? "오늘 개막" : `개막 ${-d}일째`;
  return (
    <Link href="/preseason" className={styles.banner}>
      <span className={styles.kicker}>PRESEASON</span>
      <span className={styles.main}>
        <b>{shortSeason(season)} 시즌 개막까지 {when}</b>
        <span className={styles.sub}>
          {y}.{m}.{day} 개막 · 예정 {opener.nGames}경기 반영 · 로스터 변화와 시즌 전망, 그리고 개막 후 중계가 어떻게 보일지 미리 확인
        </span>
      </span>
      <span className={styles.cta}>개막 리포트 →</span>
    </Link>
  );
}
