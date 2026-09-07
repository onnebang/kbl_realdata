"use client";

// D. 홈 목록 자동 갱신. app/page.tsx는 서버 컴포넌트라서, 라이브 스코어를 따라가려면
// 클라이언트 렌더로 통째로 갈아엎거나(과함) 주기적으로 서버를 다시 굴리거나 둘 중 하나다.
// 후자 - router.refresh()만 부르는 아주 작은 클라이언트 컴포넌트.
//
// 중요한 것은 "언제 안 도는가"다:
//   - 진행중 경기가 하나도 없으면 app/page.tsx가 이 컴포넌트를 아예 렌더하지 않는다.
//     타이머 자체가 존재하지 않는다(검증 6). 홈이 30경기씩 페이지로 나뉜 뒤에도 그 판정은
//     **지금 보고 있는 페이지의 목록**으로 한다 - 라이브 경기는 목록 맨 앞 구간이라 2페이지
//     이후에는 렌더되지 않고, 거기서는 30초마다 오가는 바이트가 0이다.
//   - router.refresh()는 현재 URL(?season/?team/?page 포함)을 그대로 다시 굴린다 - 갱신
//     때문에 보던 페이지가 1페이지로 튕기지 않는다.
//   - 탭이 백그라운드면 건너뛴다. 홈 쿼리는 실측 수 초짜리라(아래 app/page.tsx 주석),
//     안 보는 탭이 30초마다 서버를 때리는 건 순수 낭비다.
//   - 주기는 30초. 요구사항 범위(20~30초)의 위쪽 - 쿼리 비용이 크고, 라이브 수집기 자체가
//     그보다 자주 새 스코어를 만들지 않는다.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomeLiveRefresher({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
