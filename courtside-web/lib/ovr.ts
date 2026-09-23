import rawHistory from "./courtside_ovr_history.json";

/**
 * KBL 공식 pcode를 아직 못 받은 선수(신규 영입/신인)에게 build_courtside_ovr.py가 붙이는
 * 임시 키의 접두사 - `tbd_<이름>` 꼴이다. **라우팅 가능한 pcode가 아니다**:
 * `/players/tbd_존무니`는 players 테이블 조회가 비어 404가 되고, 프로필 사진도 없다.
 * 그래서 화면에서는 pcode가 없는 선수로 취급하고 이름으로 이어야 한다.
 * 진짜 pcode가 배정되면 이 키는 자동으로 안 쓰인다(정상 경로로 흡수됨).
 */
export const TBD_PCODE_PREFIX = "tbd_";

/** 그 pcode가 KBL이 실제로 발급한 것인지(= 프로필 링크를 걸어도 되는지). */
export function isRealPcode(pcode: string | null | undefined): boolean {
  return !!pcode && !pcode.startsWith(TBD_PCODE_PREFIX);
}

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
