import rawAchievements from "./courtside_achievements.json";

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  category: "milestone" | "impact" | "bench" | "easter_egg";
}

export interface CareerQuest {
  id: string;
  type: string;
  name: string;
  current: number;
  target: number;
  completed: boolean;
}

export interface PlayerAchievements {
  name: string;
  career_quests: CareerQuest[];
  seasons: Record<string, Achievement[]>;
}

export function getPlayerAchievements(pcode: string): PlayerAchievements | null {
  const achievements = rawAchievements as Record<string, PlayerAchievements>;
  return achievements[pcode] || null;
}

export function getAllAchievementsForPlayer(pcode: string): Achievement[] {
  const player = getPlayerAchievements(pcode);
  if (!player) return [];
  
  const allMap = new Map<string, Achievement>();
  for (const season of Object.values(player.seasons)) {
    for (const ach of season) {
      if (!allMap.has(ach.id)) {
        allMap.set(ach.id, ach);
      }
    }
  }
  return Array.from(allMap.values());
}
