import Link from "next/link";
import styles from "./SeasonNav.module.css";

export type SeasonNavKey = "overview" | "teams" | "leaders" | "games";

const SEASON_LINKS: { key: SeasonNavKey; href: string; label: string; hint: string }[] = [
  { key: "overview", href: "/season", label: "시즌 홈", hint: "한눈에 보기" },
  { key: "teams", href: "/rankings/teams", label: "팀 순위", hint: "순위·팀 비교" },
  { key: "leaders", href: "/leaderboards/season", label: "선수 리더", hint: "부문별 순위" },
  { key: "games", href: "/season-browser", label: "경기 기록", hint: "일정·결과" },
];

export function SeasonNav({
  active,
  activeSeason,
  seasons,
  action,
  kicker,
  title,
  description,
  hiddenFields,
}: {
  active: SeasonNavKey;
  activeSeason: string;
  seasons: string[];
  action: string;
  kicker: string;
  title: string;
  description: string;
  hiddenFields?: Record<string, string>;
}) {
  const seasonQuery = `season=${encodeURIComponent(activeSeason)}`;

  return (
    <header className={styles.header}>
      <div className={styles.topRow}>
        <div className={styles.copy}>
          <span className={styles.kicker}>{kicker}</span>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.description}>{description}</p>
        </div>
        <form className={styles.seasonForm} action={action}>
          {Object.entries(hiddenFields ?? {}).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <label className={styles.seasonLabel} htmlFor={`season-${active}`}>
            시즌
          </label>
          <select id={`season-${active}`} name="season" defaultValue={activeSeason} aria-label="시즌 선택">
            {seasons.map((season) => (
              <option key={season} value={season}>
                {season}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-primary">
            보기
          </button>
        </form>
      </div>

      <nav className={styles.tabs} aria-label="시즌 메뉴">
        {SEASON_LINKS.map((item) => (
          <Link
            key={item.key}
            href={`${item.href}?${seasonQuery}`}
            className={`${styles.tab} ${item.key === active ? styles.tabActive : ""}`}
            aria-current={item.key === active ? "page" : undefined}
          >
            <span className={styles.tabLabel}>{item.label}</span>
            <span className={styles.tabHint}>{item.hint}</span>
          </Link>
        ))}
      </nav>
    </header>
  );
}
