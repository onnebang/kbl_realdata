"use client";

import { useState } from "react";
import { Achievement, CareerQuest, getPlayerAchievements } from "../lib/achievements";
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
  { id: "man_of_steel", name: "강철 체력", desc: "시즌 54경기 출장 및 평균 30분 이상 출전", category: "milestone" },
  { id: "block_machine", name: "블록 머신", desc: "시즌 누적 블록슛 60개 이상 달성", category: "milestone" },
  { id: "wailing_wall", name: "통곡의 벽", desc: "한 경기 5블록 이상", category: "impact" },
  { id: "triple_double", name: "트리플 더블", desc: "트리플 더블 달성", category: "impact" },
  { id: "bomber", name: "폭격기", desc: "3경기 연속 30득점 이상 달성", category: "impact" },
  { id: "perimeter_sniper", name: "외곽의 저격수", desc: "한 경기 3점슛 7개 이상 성공", category: "impact" },
  { id: "hawk_eye", name: "매의 눈", desc: "한 경기 스틸 6개 이상", category: "impact" },
  { id: "backboard_destroyer", name: "백보드 파괴자", desc: "한 경기 리바운드 15개 이상 달성", category: "impact" },
  { id: "perfectionist", name: "완벽주의자", desc: "야투 성공률 100%로 15득점 이상 달성", category: "impact" },
  { id: "maestro", name: "마에스트로", desc: "무실책 10어시스트 이상 달성", category: "impact" },
  { id: "scene_stealer", name: "씬 스틸러", desc: "15분 이하 출전 10득점 이상", category: "bench" },
  { id: "sacrificial_lamb", name: "아름다운 희생", desc: "15분 이하 출전 후 5반칙 퇴장", category: "bench" },
  
  // 신규 미션형 업적 10종
  { id: "club_20_20", name: "20-20 클럽", desc: "한 경기 20득점 & 20리바운드 동시 달성", category: "impact" },
  { id: "swiss_army_knife", name: "스위스 아미 나이프", desc: "한 경기 5득점, 5리바, 5어시, 5스틸, 5블록 (5x5 달성)", category: "impact" },
  { id: "king_of_thieves", name: "도둑의 제왕", desc: "한 경기 스틸 8개 이상 달성", category: "impact" },
  { id: "swat_team", name: "SWAT 팀장", desc: "한 경기 블록슛 7개 이상 달성", category: "impact" },
  { id: "ft_master", name: "강심장 (자유투 마스터)", desc: "한 경기 자유투 10개 이상 시도하여 100% 성공", category: "impact" },
  { id: "unsung_hero", name: "언성 히어로", desc: "무득점이지만 리바운드+어시스트+스틸+블록 합산 15개 이상", category: "bench" },
  { id: "workhorse", name: "마당쇠", desc: "연장전 없이 40분 풀타임 출전하여 파울 1개 이하", category: "bench" },
  { id: "brick_layer", name: "벽돌공", desc: "한 경기 3점슛 10개 이상 시도하여 성공률 10% 미만", category: "easter_egg" },
  { id: "turnover_machine", name: "턴오버 자판기", desc: "한 경기 턴오버 8개 이상 기록", category: "easter_egg" },
  { id: "foul_trouble", name: "파울 트러블러", desc: "10분 미만 출전하여 5반칙 퇴장", category: "easter_egg" },

  // 기존 이스터에그
  { id: "invisible_man", name: "투명 인간", desc: "15분 이상 출전, 모든 1차 스탯 0", category: "easter_egg" },
  { id: "giving_tree", name: "아낌없이 주는 나무", desc: "무득점 10어시스트 이상 달성", category: "easter_egg" },
  { id: "unforgiving_rim", name: "자비 없는 림", desc: "한 경기 자유투 4구 이상 시도 0개 성공", category: "easter_egg" },
  { id: "pacifist", name: "평화주의자", desc: "30분 이상 출전, 파울 0개", category: "easter_egg" },
  { id: "black_hole", name: "블랙홀", desc: "야투율 20% 미만으로 야투 15개 이상 시도", category: "easter_egg" },
  { id: "ft_phobia", name: "자유투 공포증", desc: "한 경기 자유투 5개 이상 시도하여 0구 성공", category: "easter_egg" }
];

function RankBadge({ label, rank }: { label: string, rank: number | null }) {
  if (!rank) return null;
  
  let badgeClass = styles.rankBadge;
  if (rank === 1) badgeClass += ` ${styles.rankGold}`;
  else if (rank === 2) badgeClass += ` ${styles.rankSilver}`;
  else if (rank === 3) badgeClass += ` ${styles.rankBronze}`;

  return (
    <span className={badgeClass}>
      {label} <strong>{rank}위</strong>
    </span>
  );
}

export default function AchievementTrophyRoom({ pcode }: Props) {
  const [activeTab, setActiveTab] = useState<"career" | "season">("career");
  
  const playerAchievements = getPlayerAchievements(pcode);
  const unlockedIds = new Set<string>();
  
  if (playerAchievements && playerAchievements.seasons) {
    Object.values(playerAchievements.seasons).forEach(season => {
      season.forEach(ach => unlockedIds.add(ach.id));
    });
  }

  const quests = playerAchievements?.career_quests || [];
  const ranks = playerAchievements?.ranks || {};

  return (
    <div className={styles.trophyRoom}>
      <div className={styles.header}>
        <h3 className={styles.title}>🏆 트로피 룸</h3>
        <div className={styles.tabs}>
          <button 
            className={`${styles.tabBtn} ${activeTab === "career" ? styles.active : ""}`}
            onClick={() => setActiveTab("career")}
          >
            올타임 퀘스트
          </button>
          <button 
            className={`${styles.tabBtn} ${activeTab === "season" ? styles.active : ""}`}
            onClick={() => setActiveTab("season")}
          >
            시즌 업적
          </button>
        </div>
      </div>
      
      {activeTab === "career" && (
        <div className={styles.tabContent}>
          {quests.length === 0 ? (
            <div style={{ color: "rgba(255,255,255,0.5)", textAlign: "center", padding: "20px" }}>
              진행 중인 퀘스트가 없습니다.
            </div>
          ) : (
            <div className={styles.questList}>
              {quests.map(quest => {
                const pct = Math.min(100, (quest.current / quest.target) * 100);
                const rankData = ranks[quest.type];

                return (
                  <div key={quest.id} className={`${styles.questItem} ${quest.completed ? styles.questCompleted : ""}`}>
                    <div className={styles.questHeader}>
                      <div className={styles.questNameRow}>
                        <span className={styles.questName}>
                          {quest.name}
                          {quest.completed && <span className={styles.questCompletedText}>✔ 완료</span>}
                        </span>
                        {rankData && (
                          <div className={styles.questBadges}>
                            <RankBadge label="올타임" rank={rankData.all_time} />
                            <RankBadge label="현역" rank={rankData.active} />
                          </div>
                        )}
                      </div>
                      <div className={styles.questNumbers}>
                        {quest.current.toLocaleString()} / {quest.target.toLocaleString()}
                      </div>
                    </div>
                    <div className={styles.progressBarContainer}>
                      <div 
                        className={styles.progressBarFill} 
                        style={{ width: `${pct}%` }} 
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === "season" && (
        <div className={styles.tabContent}>
          <div className={styles.iconGrid}>
            {ALL_ACHIEVEMENTS.map(ach => {
              const unlocked = unlockedIds.has(ach.id);
              const isEasterEgg = ach.category === "easter_egg";
              
              const title = !unlocked && isEasterEgg ? "???" : ach.name;
              const desc = !unlocked && isEasterEgg ? "달성 조건이 숨겨져 있습니다." : ach.desc;

              return (
                <div key={ach.id} className={styles.hexWrapper}>
                  <div 
                    className={`${styles.hexagonCard} ${unlocked ? styles.unlocked : styles.locked}`}
                    data-tooltip-title={title}
                    data-tooltip-desc={desc}
                  >
                    <div className={styles.hexInner}>
                      {unlocked ? (
                         <span className={styles.icon}>
                           {ach.category === "milestone" ? "🏅" : ach.category === "impact" ? "🔥" : ach.category === "bench" ? "⚡" : "👀"}
                         </span>
                      ) : (
                         <span className={styles.iconLocked}>🔒</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
