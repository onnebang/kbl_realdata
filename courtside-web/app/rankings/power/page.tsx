import Link from "next/link";
import { getAllTeamPowers, tierClass as sharedTierClass } from "@/lib/teamPower";
import styles from "../rankings.module.css";

export const maxDuration = 60;

const TIER_CLASS_MAP = {
  gold: "tierGold",
  silver: "tierSilver",
  bronze: "tierBronze",
  default: "tierDefault",
} as const;

function tierClass(rating: number): string {
  return styles[TIER_CLASS_MAP[sharedTierClass(rating)]];
}

export default async function TeamPowerRankingsPage() {
  // 계산 로직은 lib/teamPower.ts로 옮겼다(프리시즌/팀 상세 페이지와 공유) - 이 페이지는
  // 그 결과를 topPlayers(주전 5) 표시용으로만 다시 다듬는다.
  // 원래 경로는 /rankings/teams였는데, 승-패 기반 실제 순위표가 그 자리를 차지하면서
  // OVR 파워랭킹인 이 페이지는 /rankings/power로 옮겼다.
  const allPowers = getAllTeamPowers();
  const teamPowers = allPowers.map((t) => ({
    teamName: t.teamName,
    teamOvr: t.ovr,
    teamOff: t.off,
    teamDef: t.def,
    topPlayers: t.roster.slice(0, 5),
  }));
  const latestSeason = allPowers[0]?.season ?? "";

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>TEAM POWER RANKINGS</h1>
      <p className={styles.subtitle}>{latestSeason} 시즌 KBL 팀 파워 오버롤</p>

      <div className={styles.tabs}>
        <Link href="/rankings/ovr" className={styles.tab}>PLAYERS</Link>
        <Link href="/rankings/power" className={`${styles.tab} ${styles.tabActive}`}>TEAMS</Link>
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
                <Link href={`/players/${p.pcode}`} key={p.pcode} style={{ textDecoration: 'none' }}>
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
