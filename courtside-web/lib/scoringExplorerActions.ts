"use server";

import { getEntitySeasonGrids, type Dimension, type EntitySeasonGrids } from "./scoringExplorer";

// components/ScoringExplorerClient.tsx가 팀/선수/코치/리그 드롭다운에서 엔티티를 고를 때마다
// 부르는 Server Action - 최초 데이터 로딩은 서버(app/leaderboards/scoring-explorer/page.tsx)에서
// 하고 클라이언트는 이미 로드된 데이터로 재생/스크럽만 한다는 이 프로젝트 컨벤션을, "엔티티를
// 바꾸는 것도 매번 서버 데이터가 필요한 행위"로 보고 여기서 이어감(순수 상호작용은 아니지만
// 전체 15시즌 shot_log를 클라이언트에 미리 다 실어둘 수는 없어서 - 이 파일 상단 주석 참고).
export async function fetchEntitySeasonGridsAction(dim: Dimension, entityId: string): Promise<EntitySeasonGrids> {
  return getEntitySeasonGrids(dim, entityId);
}
