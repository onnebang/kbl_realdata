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

import { createContext, useContext, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { UseLiveGameResult } from "@/lib/useLiveGame";

// 진행 중일 때만 불러온다. 정적 import면 종료된 경기 페이지에도 @supabase/supabase-js와
// 공개 키가 실려 나간다(조회의 대부분이 종료 경기다). ssr:false인 이유 - 이 컴포넌트는
// 웹소켓/타이머를 여는 브라우저 전용 계층이라 서버에서 실행할 이유가 없다.
const LiveGameTransport = dynamic(() => import("./LiveGameTransport"), { ssr: false });

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
  // 진행 중이 아니면 전송 계층을 아예 만들지 않는다 - 훅도, 구독도, Supabase 청크도 없다.
  if (!live) return <LiveGameContext.Provider value={OFF}>{children}</LiveGameContext.Provider>;

  return (
    <LiveGameTransport
      gmkey={gmkey}
      initialLastOrder={initialLastOrder}
      render={(value) => <LiveGameContext.Provider value={value}>{children}</LiveGameContext.Provider>}
    />
  );
}
