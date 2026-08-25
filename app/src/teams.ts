// tools/build_live_replay_demo.py의 TEAM_META(2026-08-25 실제 구단컬러로 정정된 값)에서
// 2025-26 시즌 현역 10개 구단만 추림 - 히스토리컬 코드(오리온스/전자랜드/캐롯)는 지금 뛰지
// 않는 팀이라 알림 구독 대상에서 제외.
export interface Team {
  tcode: string;
  name: string;
  abbr: string;
  color: string;
}

export const TEAMS: Team[] = [
  { tcode: '06', name: '수원 KT', abbr: 'KT', color: '#1A1A1A' },
  { tcode: '10', name: '울산 현대모비스', abbr: 'MOB', color: '#A6192E' },
  { tcode: '16', name: '원주 DB', abbr: 'DB', color: '#1C8A43' },
  { tcode: '35', name: '서울 삼성', abbr: 'SAM', color: '#1428A0' },
  { tcode: '55', name: '서울 SK', abbr: 'SK', color: '#E4002B' },
  { tcode: '60', name: '전주 KCC', abbr: 'KCC', color: '#0C2340' },
  { tcode: '64', name: '대구 한국가스공사', abbr: 'GAS', color: '#0072CE' },
  { tcode: '66', name: '고양 소노', abbr: 'SONO', color: '#3FA9F5' },
  { tcode: '70', name: '안양 정관장', abbr: 'KGC', color: '#C8102E' },
  { tcode: '50', name: '창원 LG', abbr: 'LG', color: '#8E1B3D' },
];
