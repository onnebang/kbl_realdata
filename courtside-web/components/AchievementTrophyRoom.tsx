"use client";

import { useState } from "react";
import { Achievement, Rival, StackData, getPlayerAchievements } from "../lib/achievements";
import styles from "./AchievementTrophyRoom.module.css";

interface Props {
  pcode: string;
}

const STAT_LABELS: Record<string, string> = {
  pts: "득점",
  reb: "리바운드",
  ast: "어시스트",
  threep: "3점슛",
  stl: "스틸",
  blk: "블록",
  gp: "출장 경기"
};

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
  { id: "invisible_man", name: "투명 인간", desc: "15분 이상 출전, 모든 1차 스탯 0", category: "easter_egg" },
  { id: "giving_tree", name: "아낌없이 주는 나무", desc: "무득점 10어시스트 이상 달성", category: "easter_egg" },
  { id: "unforgiving_rim", name: "자비 없는 림", desc: "한 경기 자유투 4구 이상 시도 0개 성공", category: "easter_egg" },
  { id: "pacifist", name: "평화주의자", desc: "30분 이상 출전, 파울 0개", category: "easter_egg" },
  { id: "black_hole", name: "블랙홀", desc: "야투율 20% 미만으로 야투 15개 이상 시도", category: "easter_egg" },
  { id: "ft_phobia", name: "자유투 공포증", desc: "한 경기 자유투 5개 이상 시도하여 0구 성공", category: "easter_egg" }
];

export default function AchievementTrophyRoom({ pcode }: Props) {
  const [activeTab, setActiveTab] = useState<"career" | "season">("season");
  const [activeSubTab, setActiveSubTab] = useState<"stacks" | "missions">("stacks");
  
  // For career rival toggle
  const [careerRivalType, setCareerRivalType] = useState<"alltime" | "active">("alltime");
  
  const player = getPlayerAchievements(pcode);
  
  // Season selector state
  const seasonsList = player?.seasons ? Object.keys(player.seasons).sort((a,b) => b.localeCompare(a)) : [];
  const [selectedSeason, setSelectedSeason] = useState<string>(seasonsList[0] || "");

  if (!player) return null;

  // Derive unlocked missions for the active view
  const unlockedIds = new Set<string>();
  if (activeTab === "season" && selectedSeason && player.seasons[selectedSeason]) {
    player.seasons[selectedSeason].missions?.forEach(ach => unlockedIds.add(ach.id));
  } else if (activeTab === "career" && player.career?.missions) {
    player.career.missions.forEach(ach => unlockedIds.add(ach.id));
  }

  // Derive stacks to show
  let stacksData: Record<string, StackData> = {};
  if (activeTab === "season" && selectedSeason && player.seasons[selectedSeason]) {
    stacksData = player.seasons[selectedSeason].stacks || {};
  } else if (activeTab === "career" && player.career) {
    stacksData = player.career.stacks || {};
  }

  return (
    <div className={styles.trophyRoom}>
      <div className={styles.header}>
        <h3 className={styles.title}>🏆 트로피 룸</h3>
        <div className={styles.tabs}>
          <button 
            className={`${styles.tabBtn} ${activeTab === "season" ? styles.active : ""}`}
            onClick={() => setActiveTab("season")}
          >
            시즌
          </button>
          <button 
            className={`${styles.tabBtn} ${activeTab === "career" ? styles.active : ""}`}
            onClick={() => setActiveTab("career")}
          >
            커리어
          </button>
        </div>
      </div>
      
      <div className={styles.subTabs}>
        <button 
          className={`${styles.subTabBtn} ${activeSubTab === "stacks" ? styles.active : ""}`}
          onClick={() => setActiveSubTab("stacks")}
        >
          스택형 기록
        </button>
        <button 
          className={`${styles.subTabBtn} ${activeSubTab === "missions" ? styles.active : ""}`}
          onClick={() => setActiveSubTab("missions")}
        >
          미션형 배지
        </button>
      </div>

      {activeTab === "season" && seasonsList.length > 0 && (
        <div className={styles.seasonSelector}>
          <select 
            className={styles.seasonSelect} 
            value={selectedSeason} 
            onChange={(e) => setSelectedSeason(e.target.value)}
          >
            {seasonsList.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      )}
      
      <div className={styles.tabContent}>
        {activeSubTab === "stacks" ? (
          <div className={styles.questList}>
            {Object.keys(stacksData).length === 0 && (
              <div style={{ color: "rgba(255,255,255,0.5)", textAlign: "center" }}>기록이 없습니다.</div>
            )}
            {Object.entries(stacksData).map(([key, stack]) => {
              
              let myRank = stack.rank;
              let rivals = stack.rivals || [];
              
              if (activeTab === "career") {
                myRank = careerRivalType === "alltime" ? stack.rank_alltime : stack.rank_active;
                rivals = (careerRivalType === "alltime" ? stack.rivals_alltime : stack.rivals_active) || [];
              }

              // Calculate track scale based on max value to show
              // max_val is either target, or the max rival's val, whichever is bigger, so they all fit on the graph line
              const maxVal = Math.max(stack.target, ...rivals.map(r => r.val), stack.val);
              
              // Base progress fill for the player
              const myPct = (stack.val / maxVal) * 100;

              // Ensure we have "myself" in the nodes list. If my pcode isn't in rivals for some reason, add it.
              const nodes = [...rivals];
              if (!nodes.find(r => String(r.pcode) === String(pcode))) {
                nodes.push({ pcode, name: player.name, val: stack.val, rank: myRank || 0 });
              }

              const tierClass = styles[`tier${stack.tier}`] || "";

              return (
                <div key={key} className={styles.questItem}>
                  <div className={styles.questHeader}>
                    <div className={styles.questNameRow}>
                      <span className={styles.questName}>
                        {STAT_LABELS[key] || key}
                        {stack.tier && <span className={`${styles.questTier} ${tierClass}`}>{stack.tier}</span>}
                      </span>
                      {activeTab === "career" && (
                        <div className={styles.rivalToggle}>
                          <button 
                            className={`${styles.rivalToggleBtn} ${careerRivalType === "alltime" ? styles.active : ""}`}
                            onClick={() => setCareerRivalType("alltime")}
                          >올타임</button>
                          <button 
                            className={`${styles.rivalToggleBtn} ${careerRivalType === "active" ? styles.active : ""}`}
                            onClick={() => setCareerRivalType("active")}
                          >현역</button>
                        </div>
                      )}
                    </div>
                    <div className={styles.questNumbers}>
                      {stack.val.toLocaleString()} / <span style={{opacity: 0.6}}>{stack.target.toLocaleString()}</span>
                      {myRank && <span style={{marginLeft: "8px", color: "var(--hero-team, #d9640a)"}}>[{myRank}위]</span>}
                    </div>
                  </div>
                  
                  <div className={styles.progressBarTrack}>
                    <div 
                      className={styles.progressBarFill} 
                      style={{ width: `${myPct}%` }} 
                    />
                    
                    {/* Render Rival Nodes directly on the track */}
                    {nodes.map((r, i) => {
                      const isMe = String(r.pcode) === String(pcode);
                      const leftPct = (r.val / maxVal) * 100;
                      return (
                        <div 
                          key={`${r.pcode}-${i}`} 
                          className={`${styles.rivalNode} ${isMe ? styles.isMe : ""}`}
                          style={{ left: `${leftPct}%` }}
                        >
                          <img 
                            src={`https://kbl.or.kr/images/players/Portrait/${r.pcode}.png`} 
                            alt={r.name} 
                            className={styles.rivalAvatar}
                            onError={(e) => { e.currentTarget.src = 'https://kbl.or.kr/images/common/no_player.jpg'; }}
                          />
                          <div className={styles.rivalLabel}>
                            {r.rank}위 {r.name}<br/>
                            {r.val.toLocaleString()}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className={styles.iconGrid}>
            {ALL_ACHIEVEMENTS.map(ach => {
              const unlocked = unlockedIds.has(ach.id);
              return (
                <div key={ach.id} className={styles.hexWrapper}>
                  <div 
                    className={`${styles.hexagonCard} ${unlocked ? styles.unlocked : styles.locked}`}
                    // Tooltip shows regardless of whether it's locked!
                    data-tooltip-title={ach.name}
                    data-tooltip-desc={ach.desc}
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
        )}
      </div>
    </div>
  );
}
