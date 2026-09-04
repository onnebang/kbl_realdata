"use client";

// 라이브 전송 계층 본체 - **이 파일만 Supabase 브라우저 클라이언트를 끌어온다.**
//
// LiveGameProvider에서 갈라 나온 이유: 예전에는 프로바이더가 useLiveGame을 정적으로
// import해서, 진행 중이 아닌 경기(종료·예정)에서도 @supabase/supabase-js와 **공개 키가**
// 브라우저 번들에 실려 나갔다. 조회의 대부분은 종료된 경기다.
// 훅은 조건부로 부를 수 없으므로 "컴포넌트를 가르는" 방식으로만 지연 로딩할 수 있다 -
// 그래서 훅을 쓰는 부분만 이 컴포넌트로 떼어내고, 프로바이더가 live일 때만 next/dynamic으로
// 불러온다.

import { useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useLiveGame, type UseLiveGameResult } from "@/lib/useLiveGame";

export default function LiveGameTransport({
  gmkey,
  initialLastOrder,
  render,
}: {
  gmkey: string;
  initialLastOrder: number;
  /** 훅 결과를 그대로 컨텍스트에 넣는 것은 프로바이더의 일이다. */
  render: (value: UseLiveGameResult) => ReactNode;
}) {
  const value = useLiveGame({ gmkey, enabled: true, initialLastOrder });
  const router = useRouter();
  const refreshedRef = useRef(false);

  // 경기 종료 전환 - is_ended가 true로 뒤집히면 서버 컴포넌트를 다시 굴린다. 그러면
  // deriveGameStatus가 "final"이 되면서 3막(경기후 AI 리포트)이 열리고, live prop이 false로
  // 내려가 이 컴포넌트 자체가 언마운트되며 구독/폴링이 정리된다. 한 번만(refreshedRef) -
  // refresh 후에도 잠깐 ended 상태가 남아 있어서 가드가 없으면 새로고침 루프가 된다.
  useEffect(() => {
    if (!value.ended || refreshedRef.current) return;
    refreshedRef.current = true;
    router.refresh();
  }, [value.ended, router]);

  return <>{render(value)}</>;
}
