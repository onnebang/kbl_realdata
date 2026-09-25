import type { GameStatus } from "./gameStatus";

// 경기 페이지 탭(components/GameTabs.tsx) 정의. "use client" 파일이 아니라 여기 둔 이유 - 서버
// 컴포넌트(page.tsx)가 parse/default 함수를 **호출**해야 하는데, 클라이언트 모듈에서 import한 함수는
// 서버에서 호출할 수 없다(클라이언트 참조로 바뀐다).
export const GAME_TABS = [
  { id: "pre", label: "경기 전" },
  { id: "live", label: "실시간 중계" },
  { id: "post", label: "경기 후 AI 분석" },
] as const;

export type GameTabId = (typeof GAME_TABS)[number]["id"];

// 상태별 기본 탭 - 지금 상황에 맞는 화면부터 보여준다.
const DEFAULT_TAB: Record<GameStatus, GameTabId> = { scheduled: "pre", live: "live", final: "post" };

/**
 * `?tab=` 값과 경기 상태로 첫 탭을 정한다. 알 수 없는 값·빈 값·`?tab=a&tab=b`(배열)는 무시하고
 * 상태별 기본 탭으로 - 이상한 URL이 빈 화면을 만들지 않게.
 */
export function initialGameTab(status: GameStatus, tabParam: string | string[] | undefined): GameTabId {
  const raw = Array.isArray(tabParam) ? tabParam[0] : tabParam;
  return GAME_TABS.find((t) => t.id === raw)?.id ?? DEFAULT_TAB[status];
}
