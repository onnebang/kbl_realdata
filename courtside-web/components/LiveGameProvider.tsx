"use client";

// Phase 2 - 경기 페이지 한 장당 "라이브 전송 계층 1개"를 보장하는 얇은 컨텍스트.
//
// 왜 컨텍스트인가: 라이브 데이터를 봐야 하는 곳이 한 군데가 아니다.
//   - 상단 매치업 배너의 스코어(LiveScore)
//   - Act 2의 인터랙티브 문자중계(GameReplay)
// 둘이 각자 useLiveGame을 부르면 같은 경기에 웹소켓 채널 2개 + 폴링 타이머 2개가 생긴다.
// 프로바이더가 훅을 딱 한 번 돌리고 결과를 나눠준다(구독 1, 폴링 1).
//
// 서버 컴포넌트인 page.tsx가 이 클라이언트 컴포넌트로 children(서버 렌더 결과)을 감싸는
// 형태 - RSC에서 정상적인 패턴이고, 페이지 본문은 그대로 서버 렌더된다.

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useLiveGame, type UseLiveGameResult } from "@/lib/useLiveGame";

const OFF: UseLiveGameResult = { rows: [], score: null, ended: false, lateNames: {} };

const LiveGameContext = createContext<UseLiveGameResult>(OFF);

export function useLiveGameContext(): UseLiveGameResult {
  return useContext(LiveGameContext);
}

export default function LiveGameProvider({
  gmkey,
  live,
  initialLastOrder,
  children,
}: {
  gmkey: string;
  /** deriveGameStatus(game) === "live" 일 때만 true. false면 훅이 아무 일도 하지 않는다. */
  live: boolean;
  initialLastOrder: number;
  children: ReactNode;
}) {
  const value = useLiveGame({ gmkey, enabled: live, initialLastOrder });
  const router = useRouter();
  const refreshedRef = useRef(false);

  // E. 경기 종료 전환 - is_ended가 true로 뒤집히면 서버 컴포넌트를 다시 굴린다. 그러면
  // deriveGameStatus가 "final"이 되면서 3막(경기후 AI 리포트)이 열리고, live prop이 false로
  // 내려가 훅이 스스로 구독/폴링을 정리한다. 한 번만(refreshedRef) - refresh 후에도 잠깐
  // ended 상태가 남아 있어서 가드가 없으면 새로고침 루프가 된다.
  useEffect(() => {
    if (!live || !value.ended || refreshedRef.current) return;
    refreshedRef.current = true;
    router.refresh();
  }, [live, value.ended, router]);

  return <LiveGameContext.Provider value={value}>{children}</LiveGameContext.Provider>;
}
