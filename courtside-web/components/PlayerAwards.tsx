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

  // To display them cleanly, sort by count descending? 
  // Let's keep the existing order (from the Python script).
  
  return (
    <div className={styles.awardsContainer}>
      <h2 className={styles.header}>AWARDS AND HONORS</h2>
      <div className={styles.list}>
        {awards.map((award, i) => (
          <div key={i} className={styles.awardItem}>
            <span className={styles.count}>{award.count}</span>
            <span className={styles.name}>{award.name}</span>
            {award.years && award.years.length > 0 && (
              <span className={styles.years}>({award.years.join(", ")})</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
