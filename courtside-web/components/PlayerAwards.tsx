import { getPlayerAwards } from "../lib/awards";
import styles from "./PlayerAwards.module.css";

interface Props {
  pcode: string;
}

export default function PlayerAwards({ pcode }: Props) {
  const awards = getPlayerAwards(pcode);

  if (!awards || awards.length === 0) {
    return null;
  }

  const getIcon = (id: string, name: string) => {
    if (id === "champ") return "🏆";
    if (id === "runner_up") return "🥈";
    if (id === "mvp") return "⭐";
    if (name.includes("올스타")) return "🌟";
    if (name.includes("수비")) return "🛡️";
    if (name.includes("득점")) return "🔥";
    if (name.includes("어시스트")) return "🏀";
    if (name.includes("리바운드")) return "🧱";
    return "🏅";
  };

  return (
    <div className={styles.awardsContainer}>
      <div className={styles.header}>AWARDS & HONORS</div>
      <div className={styles.list}>
        {awards.map((award, i) => (
          <div key={i} className={styles.awardItem}>
            <div className={styles.icon}>{getIcon(award.id, award.name)}</div>
            <div className={styles.details}>
              <div className={styles.countRow}>
                <span className={styles.count}>{award.count}x</span>
                <span className={styles.name}>{award.name}</span>
              </div>
              {award.years && award.years.length > 0 && (
                <div className={styles.years}>{award.years.join(", ")}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
