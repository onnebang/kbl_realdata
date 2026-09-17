import rawAwards from "./courtside_awards.json";

export interface AwardItem {
  id: string;
  name: string;
  count: number;
  years: string[];
}

export function getPlayerAwards(pcode: string): AwardItem[] {
  const awardsMap = rawAwards as Record<string, AwardItem[]>;
  return awardsMap[pcode] || [];
}
