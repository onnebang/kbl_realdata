import Link from "next/link";
import { daysUntilKst } from "@/lib/preseason";
import { COURT_X, HOOP_RIGHT, drawCourtMarkings } from "@/lib/zoneCompare";
import styles from "./CourtsideHero.module.css";

// 홈(/) 첫 화면의 히어로 - 요청: "첫 화면이 trailer가 되어서 메인에서 압도 할 수 있도록".
// /trailer의 첫 절과 같은 어법(딥다크 무대·워드마크·코트 배경)을 홈 맨 위에 그대로 낸다.
// DB를 보지 않는 동기 컴포넌트다 - 홈 화면은 이미 여러 조회를 기다리는 페이지라, 이 히어로
// 하나 때문에 왕복을 하나 더 늘리지 않는다(날짜 계산과 고정 문구뿐).
//
// 코트 SVG는 lib/zoneCompare.ts의 좌표계를 그대로 쓴다(app/trailer/page.tsx와 동일 - 손으로
// 다시 그리지 않는다). 숫자는 이 저장소가 DB로 확인해 이미 /trailer에 쓰고 있는 값 그대로다.

const COURT_SVG = drawCourtMarkings(HOOP_RIGHT[0], COURT_X[1], -1, "currentColor", 0.7);
const OPENING_DATE = "2026-10-03";

export function CourtsideHero() {
  const d = daysUntilKst(OPENING_DATE);
  // 개막이 지난 뒤에는 D-day 칩을 아예 접는다 - 안 그러면 시즌이 시작된 뒤에도 영원히
  // "D-DAY"라고 우기게 된다(PreseasonBanner와 같은 3단 분기, 다만 지난 뒤엔 표시하지 않는다).
  const dday = d > 0 ? `D-${d}` : d === 0 ? "오늘 개막" : null;

  return (
    <section className={styles.hero}>
      <svg className={styles.court} viewBox="375 27 345 357" preserveAspectRatio="xMidYMid meet" aria-hidden="true" dangerouslySetInnerHTML={{ __html: COURT_SVG }} />
      <div className={styles.inner}>
        <div className={styles.tag}>KBL PLAY-BY-PLAY ANALYTICS</div>
        <h1 className={styles.wordmark}>코트사이드</h1>
        <p className={styles.lede}>경기를 누르면 그날의 승률 흐름과 박스스코어를, 팀 이름을 누르면 그 팀의 시즌을 봅니다.</p>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <div className={styles.statV}>15</div>
            <div className={styles.statK}>시즌</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statV}>3,993</div>
            <div className={styles.statK}>정규시즌 경기</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statV}>270</div>
            <div className={styles.statK}>26-27 일정</div>
          </div>
        </div>
        {dday && (
          <div className={styles.dday}>
            <span className={styles.ddayN}>{dday}</span>
            <span className={styles.ddayT}>2026.10.03 개막까지</span>
          </div>
        )}
        <div className={styles.ctaRow}>
          <a href="#games" className={styles.ctaPrimary}>
            오늘 경기 보기
          </a>
          <Link href="/trailer" className={styles.ctaSecondary}>
            코트사이드 자세히 보기
          </Link>
        </div>
      </div>
    </section>
  );
}
