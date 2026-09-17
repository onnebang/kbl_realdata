import { Achievement, getPlayerAchievements } from "../lib/achievements";
import styles from "./AchievementTrophyRoom.module.css";

interface Props {
  pcode: string;
}

const ALL_ACHIEVEMENTS: Achievement[] = [
  { id: "double_double_machine_gold", name: "더블 더블 머신 (Gold)", desc: "시즌 20회 더블더블 달성", category: "milestone" },
  { id: "double_double_machine_silver", name: "더블 더블 머신 (Silver)", desc: "시즌 10회 더블더블 달성", category: "milestone" },
  { id: "double_double_machine_bronze", name: "더블 더블 머신 (Bronze)", desc: "시즌 5회 더블더블 달성", category: "milestone" },
  { id: "club_180", name: "180 클럽", desc: "야투 50%, 3점슛 40%, 자유투 90% 동시 달성", category: "milestone" },
  { id: "iron_man", name: "철인", desc: "30경기 연속 20분 이상 출장", category: "milestone" },
  { id: "wailing_wall", name: "통곡의 벽", desc: "한 경기 5블록 이상", category: "impact" },
  { id: "triple_double", name: "트리플 더블", desc: "트리플 더블 달성", category: "impact" },
  { id: "scene_stealer", name: "씬 스틸러", desc: "15분 이하 출전 10득점 이상", category: "bench" },
  { id: "sacrificial_lamb", name: "아름다운 희생", desc: "15분 이하 출전 후 5반칙 퇴장", category: "bench" },
  { id: "invisible_man", name: "투명 인간", desc: "15분 이상 출전, 모든 1차 스탯 0", category: "easter_egg" },
  { id: "giving_tree", name: "아낌없이 주는 나무", desc: "무득점 10어시스트 이상 달성", category: "easter_egg" },
  { id: "unforgiving_rim", name: "자비 없는 림", desc: "한 경기 자유투 4구 이상 시도 0개 성공", category: "easter_egg" },
  { id: "pacifist", name: "평화주의자", desc: "30분 이상 출전, 파울 0개", category: "easter_egg" }
];

export default function AchievementTrophyRoom({ pcode }: Props) {
  const playerAchievements = getPlayerAchievements(pcode);
  const unlockedIds = new Set<string>();
  
  if (playerAchievements) {
    Object.values(playerAchievements.seasons).forEach(season => {
      season.forEach(ach => unlockedIds.add(ach.id));
    });
  }

  return (
    <div className={styles.trophyRoom}>
      <h3 className={styles.title}>🏆 업적 & 퀘스트 트로피 룸</h3>
      
      <div className={styles.grid}>
        {ALL_ACHIEVEMENTS.map(ach => {
          const unlocked = unlockedIds.has(ach.id);
          const isEasterEgg = ach.category === "easter_egg";
          
          return (
            <div key={ach.id} className={`${styles.trophyCard} ${unlocked ? styles.unlocked : styles.locked}`}>
              <div className={styles.iconBox}>
                {unlocked ? (
                   <span className={styles.icon}>
                     {ach.category === "milestone" ? "🏅" : ach.category === "impact" ? "🔥" : ach.category === "bench" ? "⚡" : "👀"}
                   </span>
                ) : (
                   <span className={styles.iconLocked}>🔒</span>
                )}
              </div>
              <div className={styles.info}>
                <h4 className={styles.achName}>
                  {!unlocked && isEasterEgg ? "???" : ach.name}
                </h4>
                <p className={styles.achDesc}>
                  {!unlocked && isEasterEgg ? "달성 조건이 숨겨져 있습니다." : ach.desc}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
