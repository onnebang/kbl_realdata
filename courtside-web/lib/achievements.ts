import rawAchievements from "./courtside_achievements.json";

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  category: "milestone" | "impact" | "bench" | "easter_egg";
}

export interface Rival {
  pcode: number | string;
  name: string;
  val: number;
  rank: number;
  photoUrl?: string | null;
}

export interface StackData {
  val: number;
  tier: string;
  target: number;
  
  // For Career
  rank_alltime?: number | null;
  rivals_alltime?: Rival[];
  rank_active?: number | null;
  rivals_active?: Rival[];
  
  // For Season
  rank?: number | null;
  rivals?: Rival[];
}

export interface CareerMatrix {
  stacks: Record<string, StackData>;
  missions: Achievement[];
}

export interface SeasonMatrix {
  stacks: Record<string, StackData>;
  missions: Achievement[];
}

export interface PlayerAchievements {
  name: string;
  career: CareerMatrix;
  seasons: Record<string, SeasonMatrix>;
}

export function getPlayerAchievements(pcode: string): PlayerAchievements | null {
  const achievements = rawAchievements as Record<string, PlayerAchievements>;
  return achievements[pcode] || null;
}

export function getAllAchievementsForPlayer(pcode: string): Achievement[] {
  const player = getPlayerAchievements(pcode);
  if (!player) return [];
  
  const allMap = new Map<string, Achievement>();
  
  // Collect career missions
  if (player.career?.missions) {
    for (const ach of player.career.missions) {
      if (!allMap.has(ach.id)) allMap.set(ach.id, ach);
    }
  }

  // Collect season missions
  if (player.seasons) {
    for (const season of Object.values(player.seasons)) {
      if (season.missions) {
        for (const ach of season.missions) {
          if (!allMap.has(ach.id)) allMap.set(ach.id, ach);
        }
      }
    }
  }
  
  return Array.from(allMap.values());
}
