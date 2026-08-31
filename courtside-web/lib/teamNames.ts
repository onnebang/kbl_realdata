// 팀 연고지 변경(요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어") - teams 테이블은
// tcode당 정적으로 한 행뿐이라 연고지 이력을 못 담음(실제로는 같은 프랜차이즈라 tcode는
// 그대로 유지 - KBL도 팀 코드/로스터 계보는 이어지고 연고지·구단명만 바뀜). 이 사이트
// 전역에 teams 테이블 조인이 많아서(홈 화면/팀 페이지/경기 상세/시즌 브라우저/선수
// 프로필 등) 새 이력 테이블을 만들어 모든 조인을 바꾸는 대신, 시즌 문맥을 이미 알고
// 있는 각 데이터 조회 지점에서 표시 이름만 이 함수로 덮어씀. season_name이
// "YYYY-YYYY" 포맷이라 문자열 사전식 비교로 시간 순서와 정확히 일치.
type Rename = { tcode: string; fromSeason: string; name: string };
const TEAM_RENAMES: Rename[] = [{ tcode: "60", fromSeason: "2023-2024", name: "부산 KCC" }];

export function displayTeamName(
  tcode: string | null | undefined,
  fallbackName: string,
  seasonName: string | null | undefined
): string {
  if (!tcode || !seasonName) return fallbackName;
  const rename = TEAM_RENAMES.find((r) => r.tcode === tcode && seasonName >= r.fromSeason);
  return rename ? rename.name : fallbackName;
}

// 시즌 문맥이 없는(여러 시즌을 통틀어 하나의 엔티티로 다루는) 곳용 - 예: 득점 분포
// 탐색기의 엔티티 검색 드롭다운(전체 이력을 한 항목으로 취급). 이런 곳은 "지금 이
// 팀의 정식 명칭"을 보여주는 게 맞아서 시즌 무관하게 최신 개명 결과를 적용.
export function currentTeamName(tcode: string | null | undefined, fallbackName: string): string {
  if (!tcode) return fallbackName;
  const rename = TEAM_RENAMES.filter((r) => r.tcode === tcode).sort((a, b) => (a.fromSeason < b.fromSeason ? 1 : -1))[0];
  return rename ? rename.name : fallbackName;
}
