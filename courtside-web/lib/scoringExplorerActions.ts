"use server";

import { getEntitySeasonGrids, type Dimension, type EntitySeasonGrids } from "./scoringExplorer";

// components/ScoringExplorerClient.tsx가 팀/선수/코치/리그 드롭다운에서 엔티티를 고를 때마다
// 부르는 Server Action - 최초 데이터 로딩은 서버(app/leaderboards/scoring-explorer/page.tsx)에서
// 하고 클라이언트는 이미 로드된 데이터로 재생/스크럽만 한다는 이 프로젝트 컨벤션을, "엔티티를
// 바꾸는 것도 매번 서버 데이터가 필요한 행위"로 보고 여기서 이어감(순수 상호작용은 아니지만
// 전체 15시즌 shot_log를 클라이언트에 미리 다 실어둘 수는 없어서 - 이 파일 상단 주석 참고).
/**
 * Server Action은 타입을 런타임에 검증하지 않는다 - 누구나 Next-Action 헤더로 임의의 값을
 * POST할 수 있다. 검증이 없을 때 dim이 목록 밖 값이면 lib/scoringExplorer.ts의 분기가 전부
 * 빗나가 **필터 없는 shot_log 전체(55만 행) 병렬 스캔**이 걸린다(1 POST ≈ 554회 PostgREST 요청).
 * 화이트리스트로 먼저 막는다.
 */
const ALLOWED_DIMS: readonly Dimension[] = ["coach", "league"];

export async function fetchEntitySeasonGridsAction(dim: Dimension, entityId: string): Promise<EntitySeasonGrids> {
  if (!ALLOWED_DIMS.includes(dim)) throw new Error("bad request");
  if (typeof entityId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(entityId)) throw new Error("bad request");
  return getEntitySeasonGrids(dim, entityId);
}
