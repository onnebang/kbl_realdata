import Link from "next/link";
import { getSeasonOpener, daysUntilKst, shortSeason } from "@/lib/preseason";
import styles from "./PreseasonBanner.module.css";

// 홈 상단 개막 배너 - 요청: "시즌 시작전 리포트를 먼저 제공하고... 이렇게 중계가 보일거다라는
// 것을 알려주면". app/page.tsx가 "이 시즌에 종료 경기가 0, 예정 경기는 있음"일 때만 렌더하므로
// 첫 경기가 끝나는 순간 자동으로 사라진다(별도 플래그/날짜 하드코딩 없음).
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
