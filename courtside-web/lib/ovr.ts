import fs from "fs";
import path from "path";

export interface OvrSeasonRecord {
  pcode: string;
  name: string;
  season: string;
  OVR: number;
  OFF: number;
  DEF: number;
}

// 메모리 캐싱
let ovrHistoryCache: OvrSeasonRecord[] | null = null;

export function getOvrHistoryCache(): OvrSeasonRecord[] {
  if (ovrHistoryCache) return ovrHistoryCache;
  
  try {
    const filePath = path.join(process.cwd(), "..", "data", "courtside_ovr_history.json");
    const data = fs.readFileSync(filePath, "utf-8");
    ovrHistoryCache = JSON.parse(data) as OvrSeasonRecord[];
    return ovrHistoryCache;
  } catch (err) {
    console.error("Failed to load courtside_ovr_history.json:", err);
    return [];
  }
}

/**
 * 특정 선수의 역대 OVR 기록을 반환합니다. 
 * 오래된 시즌부터 오름차순으로 정렬되어 차트에 바로 쓰기 적합합니다.
 */
export function getPlayerOvrHistory(pcode: string): OvrSeasonRecord[] {
  const history = getOvrHistoryCache();
  return history.filter(record => record.pcode === pcode);
}
