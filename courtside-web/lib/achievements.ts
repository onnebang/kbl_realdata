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
