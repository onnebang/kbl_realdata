import rawHistory from "./courtside_ovr_history.json";

export interface OvrSeasonRecord {
  pcode: string;
  name: string;
  season: string;
  /** 그 시즌 소속팀의 teams.name(시즌 중 이적이면 더 많이 뛴 팀). 공백 시즌 보간 행은 공백 직전 팀. */
  team?: string;
  position?: string;
  OVR: number;
  OFF: number;
  DEF: number;
  attributes?: {
    outside: number;
    inside: number;
    playmaking: number;
    athletic: number;
    defense: number;
    rebounding: number;
  };
  archetype?: string;
  badges?: {
    finishing: number;
    shooting: number;
    playmaking: number;
    defense: number;
  };
  /** true면 경기 기록 없이 추정한 값 - 마지막 레코드(다음 시즌)는 작년 기록 기반 나이 곡선 추정, 그 밖의 레코드는
   *  군 복무·부상 등 공백 시즌의 앞뒤 실측 보간. 화면(OvrTrendChart)은 마지막 레코드를 선수 카드와 같이 확정값처럼
   *  그리고 보간만 점선·"보간"으로 표시한다(2026-09-19 결정). */
  projected?: boolean;
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
