import Link from "next/link";
import { getOvrHistoryCache } from "@/lib/ovr";
import styles from "../rankings.module.css";
import { TeamBadge } from "@/components/TeamBadge";

export const maxDuration = 60;

function tierClass(rating: number): string {
  if (rating >= 95) return styles.tierGold;
  if (rating >= 85) return styles.tierSilver;
  if (rating >= 75) return styles.tierBronze;
  return styles.tierDefault;
}

export default async function TeamRankingsPage() {
  const history = getOvrHistoryCache();
  
  // Find the latest season
  const seasons = Array.from(new Set(history.map(r => r.season))).sort();
  const latestSeason = seasons[seasons.length - 1];
  
  const players = history.filter(r => r.season === latestSeason && r.team && r.team !== "Unknown");
  
  const teamsMap = new Map<string, typeof players>();
  for (const p of players) {
    if (!teamsMap.has(p.team!)) teamsMap.set(p.team!, []);
    teamsMap.get(p.team!)!.push(p);
  }
  
  const teamPowers = Array.from(teamsMap.entries()).map(([teamName, roster]) => {
    // Sort roster by OVR desc
    const sorted = [...roster].sort((a, b) => b.OVR - a.OVR);
    
    // Team Power Formula: (Top 5 OVR * 0.7 + Next 4 OVR * 0.3) / 4.7
    // If team has fewer players, just average them
    let teamOvr = 0, teamOff = 0, teamDef = 0;
    
    if (sorted.length === 0) {
      return { teamName, teamOvr: 0, teamOff: 0, teamDef: 0, topPlayers: [] };
    } else if (sorted.length < 5) {
      teamOvr = sorted.reduce((sum, p) => sum + p.OVR, 0) / sorted.length;
      teamOff = sorted.reduce((sum, p) => sum + p.OFF, 0) / sorted.length;
      teamDef = sorted.reduce((sum, p) => sum + p.DEF, 0) / sorted.length;
    } else {
      const top5 = sorted.slice(0, 5);
      const next4 = sorted.slice(5, 9); // up to 4 players
      
      const calcPower = (key: 'OVR' | 'OFF' | 'DEF') => {
        const sum5 = top5.reduce((sum, p) => sum + p[key], 0);
        const sum4 = next4.reduce((sum, p) => sum + p[key], 0);
        const weight5 = 0.7;
        const weight4 = 0.3;
        const totalWeight = (top5.length * weight5) + (next4.length * weight4);
        return ((sum5 * weight5) + (sum4 * weight4)) / totalWeight;
      };
      
      teamOvr = calcPower('OVR');
      teamOff = calcPower('OFF');
      teamDef = calcPower('DEF');
    }
    
    return {
      teamName,
      teamOvr: Math.round(teamOvr),
      teamOff: Math.round(teamOff),
      teamDef: Math.round(teamDef),
      topPlayers: sorted.slice(0, 5),
      fullRoster: sorted
    };
  });
  
  // Sort teams by Team OVR desc
  teamPowers.sort((a, b) => b.teamOvr - a.teamOvr);

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>TEAM POWER RANKINGS</h1>
      <p className={styles.subtitle}>{latestSeason} 시즌 KBL 팀 파워 오버롤</p>
      
      <div className={styles.tabs}>
        <Link href="/rankings/ovr" className={styles.tab}>PLAYERS</Link>
        <Link href="/rankings/teams" className={`${styles.tab} ${styles.tabActive}`}>TEAMS</Link>
      </div>
      
      <div className={styles.teamGrid}>
        {teamPowers.map((t, index) => (
          <div key={t.teamName} className={styles.teamCard}>
            <div className={styles.teamCardHeader}>
              <div>
                <div style={{ fontSize: '1.2rem', color: '#8b949e', fontWeight: 800, marginBottom: '4px' }}>#{index + 1}</div>
                <div className={styles.teamName}>{t.teamName}</div>
              </div>
              <div className={`${styles.teamOvrValue} ${tierClass(t.teamOvr)}`}>
                {t.teamOvr}
              </div>
            </div>
            
            <div className={styles.teamStats}>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>OFF</span>
                <span className={styles.statValue}>{t.teamOff}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>DEF</span>
                <span className={styles.statValue}>{t.teamDef}</span>
              </div>
            </div>
            
            <div className={styles.rosterTitle}>STARTING 5</div>
            <div className={styles.rosterList}>
              {t.topPlayers.map(p => (
                <Link href={`/player/${p.pcode}`} key={p.pcode} style={{ textDecoration: 'none' }}>
                  <div className={styles.rosterItem}>
                    <span className={styles.rosterName}>{p.name} <span style={{fontSize: '0.8rem', color: '#8b949e'}}>{p.position}</span></span>
                    <span className={`${styles.rosterOvr} ${tierClass(p.OVR)}`}>{p.OVR}</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))}
        {teamPowers.length === 0 && (
          <div style={{ color: '#8b949e', padding: '20px' }}>팀 데이터가 없습니다.</div>
        )}
      </div>
    </div>
  );
}
