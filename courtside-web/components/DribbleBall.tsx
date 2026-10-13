import styles from "./DribbleBall.module.css";

// 드리블하는 농구공 - 페이지에서 유일한 상시 모션이다(줄이기 설정이면 가만히 서 있는다).
// 색은 사이트 토큰(--home 공 / --ink 이음선)이라 라이트·다크가 알아서 바뀐다.
export function DribbleBall() {
  return (
    <span className={styles.ball} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22">
        <circle cx="12" cy="12" r="10.5" fill="var(--home)" stroke="var(--ink)" strokeWidth="1.5" />
        <path
          d="M12 1.5v21M1.5 12h21M4.3 4.6c3.3 2.9 3.3 11.9 0 14.8M19.7 4.6c-3.3 2.9-3.3 11.9 0 14.8"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="1.4"
        />
      </svg>
    </span>
  );
}
