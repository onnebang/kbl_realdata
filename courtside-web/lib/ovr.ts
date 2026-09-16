import rawHistory from "./courtside_ovr_history.json";

export interface OvrSeasonRecord {
  pcode: string;
  name: string;
  season: string;
  OVR: number;
  OFF: number;
  DEF: number;
}

export function getOvrHistoryCache(): OvrSeasonRecord[] {
  // 웹팩(Next.js)에서 import한 JSON은 자동으로 캐싱되고 번들에 포함됩니다.
  return rawHistory as OvrSeasonRecord[];
}

/**
 * 특정 선수의 역대 OVR 기록을 반환합니다. 
 * 오래된 시즌부터 오름차순으로 정렬되어 차트에 바로 쓰기 적합합니다.
 */
export function getPlayerOvrHistory(pcode: string): OvrSeasonRecord[] {
  const history = getOvrHistoryCache();
  return history.filter(record => record.pcode === pcode);
}
