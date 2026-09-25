import Link from "next/link";
import { getOvrHistoryCache } from "@/lib/ovr";
import { styleDescriptionByLabel } from "@/lib/playStyles";
import styles from "../rankings.module.css";
import Image from "next/image";

export const maxDuration = 60;

function tierClass(rating: number): string {
  if (rating >= 95) return styles.tierGold;
  if (rating >= 85) return styles.tierSilver;
  if (rating >= 75) return styles.tierBronze;
  return styles.tierDefault;
}

export default async function PlayerRankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ pos?: string }>;
}) {
  const { pos } = await searchParams;
  const history = getOvrHistoryCache();
  
  // Find the latest season
  const seasons = Array.from(new Set(history.map(r => r.season))).sort();
  const latestSeason = seasons[seasons.length - 1];
  
  // Filter by latest season and position
  let players = history.filter(r => r.season === latestSeason);
  if (pos && pos !== "ALL") {
    players = players.filter(r => r.position === pos);
  }
  
  // Sort by OVR descending
  players.sort((a, b) => b.OVR - a.OVR);
  
  const positions = ["ALL", "G", "F", "C"]; // KBL data usually uses G, F, C. If it uses PG, SG, we can adapt.
  // Actually let's just extract unique positions from the latest season
  const uniquePositions = ["ALL", ...Array.from(new Set(history.filter(r => r.season === latestSeason && r.position && r.position !== "Unknown").map(r => r.position))).sort()];

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>PLAYER OVR RANKINGS</h1>
      <p className={styles.subtitle}>{latestSeason} 시즌 KBL 오버롤 랭킹</p>
      
      <div className={styles.tabs}>
        {uniquePositions.map(p => {
          const isActive = (pos || "ALL") === p;
          return (
            <Link 
              key={p} 
              href={`/rankings/ovr${p === "ALL" ? "" : `?pos=${p}`}`}
              className={`${styles.tab} ${isActive ? styles.tabActive : ""}`}
            >
              {p}
            </Link>
          );
        })}
      </div>
      
      <div className={styles.list}>
        {players.map((p, index) => (
          <Link href={`/players/${p.pcode}`} key={p.pcode} style={{ textDecoration: 'none' }}>
            <div className={styles.card}>
              <div className={styles.rank}>{index + 1}</div>
              <div className={styles.ovrBlock}>
                <span className={`${styles.ovrValue} ${tierClass(p.OVR)}`}>{p.OVR}</span>
              </div>
              <div className={styles.info}>
                <div className={styles.nameRow}>
                  <span className={styles.name}>{p.name}</span>
                  <span className={styles.teamPos}>{p.team} | {p.position}</span>
                </div>
                {p.archetype && (
                  <div className={styles.archetype}>
                    <span title={styleDescriptionByLabel(p.archetype)}>{p.archetype}</span>
                    {p.archetype2 && (
                      <span className={styles.archetype2} title={styleDescriptionByLabel(p.archetype2)}>
                        {" / "}
                        {p.archetype2}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Link>
        ))}
        {players.length === 0 && (
          <div style={{ color: '#8b949e', padding: '20px' }}>선수 데이터가 없습니다.</div>
        )}
      </div>
    </div>
  );
}
