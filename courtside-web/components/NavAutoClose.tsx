"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

// 페이지 이동이나 쿼리 파라미터가 바뀌면 열려 있는 네비 그룹(<details>)을 닫는다. NavBar는 서버 컴포넌트(클라이언트 JS 0)로 두고 이 작은 조각만 Suspense 안에서 붙는다 -
// useSearchParams를 Suspense 밖에서 쓰면 정적 페이지 프리렌더가 실패해 Vercel 배포가 막힌다(2026-10-11 빌드 실패의 원인).
export function NavAutoClose() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  useEffect(() => {
    document.querySelectorAll("nav.nav-bar details[open]").forEach((d) => d.removeAttribute("open"));
  }, [pathname, searchParams]);
  return null;
}
