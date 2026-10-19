import { NextResponse, type NextRequest } from "next/server";

// Next 16에서 middleware는 proxy로 이름이 바뀌었다(node_modules/next/dist/docs/01-app/
// 03-api-reference/03-file-conventions/proxy.md - "The `middleware` file convention is
// deprecated and has been renamed to `proxy`"). 파일은 app/과 같은 레벨(프로젝트 루트)에 둔다.
//
// 이 Proxy는 운영자 전용 페이지의 렌더 자체를 막는 한 가지 일만 한다. CDN/보안 헤더는
// next.config.ts로, 공개 API와 비싼 Server Action의 레이트리밋은 각각의 실행 함수로 옮겼다.
// Vercel은 Proxy 뒤에서 Function을 부르면 한 요청에 Fast Origin Transfer가 두 번 생길 수 있어
// 모든 페이지를 matcher로 잡는 것 자체가 이번 사용량 급증의 일부였다.

/**
 * 운영자 전용 경로 - 예측 성적표(/predictions). 모델의 캘리브레이션과 기준선 대비 실력이
 * 그대로 드러나는 내부 지표라 공개하지 않는다(사용자 결정 2026-09-30).
 *
 * 페이지 자체도 같은 토큰을 검사하지만(app/predictions/page.tsx의 gateOk) 그쪽은 렌더가
 * 시작된 뒤 notFound()를 부르는 자리라 스트리밍 응답의 상태코드가 이미 200으로 나가 있다
 * (실측: 키 없이 요청하면 본문은 404 화면인데 헤더는 200 - soft 404). 여기서 막으면 페이지가
 * 아예 호출되지 않아 진짜 404가 되고 DB 조회도 일어나지 않는다.
 *
 * 토큰을 못 읽는 런타임이면 **막지 않고 통과시킨다** - 그 경우 페이지 쪽 게이트가 판정하므로
 * 비공개는 유지되고, 반대로 여기서 잠가버려 운영자 본인이 못 들어가는 사고를 피한다.
 */
function operatorOnlyBlocked(req: NextRequest): boolean {
  if (!req.nextUrl.pathname.startsWith("/predictions")) return false;
  const token = process.env.REVALIDATE_TOKEN;
  if (!token) return false;
  return req.nextUrl.searchParams.get("key") !== token;
}

export function proxy(req: NextRequest): NextResponse {
  if (operatorOnlyBlocked(req)) {
    return new NextResponse("Not Found", {
      status: 404,
      // 404가 CDN에 캐시되면 키를 붙인 요청까지 404로 나갈 수 있다.
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/predictions/:path*"],
};
