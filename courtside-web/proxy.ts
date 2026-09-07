import { NextResponse, type NextRequest } from "next/server";
import { rateLimit } from "@/lib/rateLimit";

// Next 16에서 middleware는 proxy로 이름이 바뀌었다(node_modules/next/dist/docs/01-app/
// 03-api-reference/03-file-conventions/proxy.md - "The `middleware` file convention is
// deprecated and has been renamed to `proxy`"). 파일은 app/과 같은 레벨(프로젝트 루트)에 둔다.
//
// ── 왜 생겼나 (감사 실측 2026-09-06) ────────────────────────────────────────────────
// 이 저장소에는 레이트리밋이 코드에 전혀 없었다(middleware/proxy 없음, vercel.json은 regions만).
// 그런데 비싼 경로가 인증 없이 열려 있다:
//   · /players/210080 한 장이 763KB·1.77초 - 10 rps면 27GB/시간 + 함수 10개 상시 점유
//   · Server Action fetchEntitySeasonGridsAction - 캐시 미스 1회가 shot_log 55만행 스캔
//   · /api/season-browser/box-score - gmkey 4,477개를 훑으면 박스스코어 전량이 수집된다
// 한도의 실효성에 대한 정직한 설명은 lib/rateLimit.ts 상단에 있다(인메모리라 인스턴스마다
// 흩어진다 - 완전한 방어가 아니라 "루프 도는 클라이언트"와 "단순 스크립트"를 막는 1차 방어).

/** 분당 허용 횟수. lib/rateLimit.ts의 창이 60초라 그대로 "분당"이 된다. */
const LIMITS = {
  /** Server Action 포함 모든 POST. 가장 비싼 경로가 여기로 들어온다. */
  post: 20,
  /** /api/* - box-score 모달이 연속으로 여러 경기를 열 수 있어 페이지보다는 넉넉하게. */
  api: 60,
  /** 그 외 페이지(HTML/RSC). */
  page: 120,
  /**
   * Next의 링크 프리페치(next-router-prefetch 헤더). 별도 버킷인 이유: 홈/시즌 브라우저처럼
   * 링크가 수십 개인 페이지는 뷰포트에 들어온 링크를 브라우저가 알아서 한꺼번에 당겨온다.
   * 이걸 page 버킷에 같이 넣으면 프리페치만으로 창을 다 써버리고 **정작 사용자의 실제 이동이
   * 429**가 된다(= 이 작업이 고치려던 것보다 큰 회귀). 헤더는 누구나 흉내 낼 수 있으므로
   * 이 분리는 보안 경계가 아니라 오탐 방지용이고, 그래서 무제한이 아니라 한도만 높였다.
   */
  prefetch: 600,
} as const;

// CDN 캐시 헤더를 여기서 붙인다 - next.config.ts의 headers()가 안 먹혔다(배포 후 curl로 확인:
// x-courtside-cdn:1은 붙는데 Cache-Control은 여전히 private,no-cache,no-store). 원인은
// force-dynamic 라우트(예: /leaderboards/season, /preseason)가 렌더 파이프라인 막바지에
// **프레임워크 자신이** Cache-Control을 강제로 써넣기 때문이다 - next.config.js의 headers()는
// 그보다 먼저 적용되는 설정이라 이 시점에 덮여 사라진다. proxy(구 middleware)는 응답이 만들어진
// **뒤에** 헤더를 다시 쓸 수 있는 유일한 지점이라 여기서 강제로 덮어쓴다.
const CDN_CACHEABLE = "public, s-maxage=300, stale-while-revalidate=3600";
// 정규식으로 판정한다(next.config.ts의 source 목록과 대상이 같다) - /games/:gmkey와 /(홈)은
// 여기에 절대 없다(라이브 점수). PathnameRegExp가 아니라 손으로 정확히 맞춘다.
const CDN_CACHEABLE_PATHS = [
  /^\/players\/[^/]+$/,
  /^\/teams\/[^/]+$/,
  /^\/leaderboards(\/.*)?$/,
  /^\/season-browser$/,
  /^\/preseason$/,
];
function isCdnCacheable(pathname: string): boolean {
  return CDN_CACHEABLE_PATHS.some((re) => re.test(pathname));
}

export function proxy(req: NextRequest): NextResponse {
  // Vercel 뒤에서는 x-forwarded-for의 첫 항목이 클라이언트 IP다. 없으면 제한하지 않는다 -
  // 키가 없다고 전원을 한 키로 묶으면 그 순간 사이트 전체가 429가 된다(대안이 더 나쁘다).
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!ip) return NextResponse.next();

  const bucket = classify(req);
  const { allowed, retryAfterSec } = rateLimit(`${bucket}:${ip}`, LIMITS[bucket]);
  if (allowed) {
    const res = NextResponse.next();
    // 진단용: NextResponse.next()에 붙인 응답 헤더가 애초에 클라이언트까지 살아남는지부터
    // 무조건 확인한다(Cache-Control/x-courtside-cdn이 배포 후 아예 안 보였음 - 원인이
    // "Cache-Control만 특별 취급"인지 "next() 패스스루 헤더 자체가 전달 안 됨"인지 구분).
    res.headers.set("x-proxy-probe", "1");
    // GET만(POST/서버액션 응답을 캐시하면 안 된다) + 화이트리스트 경로만. 여기서 세팅하면
    // 프레임워크가 나중에 쓰는 Cache-Control을 덮어쓴다 - 순서가 이래야 이긴다.
    if (req.method === "GET" && isCdnCacheable(req.nextUrl.pathname)) {
      res.headers.set("Cache-Control", CDN_CACHEABLE);
      res.headers.set("x-courtside-cdn", "2"); // "2" = proxy가 덮어썼다(config만 붙은 "1"과 구분)
    }
    return res;
  }

  return new NextResponse(`Too Many Requests - ${retryAfterSec}초 뒤에 다시 시도해 주세요.`, {
    status: 429,
    headers: {
      "Retry-After": String(retryAfterSec),
      "Content-Type": "text/plain; charset=utf-8",
      // 429가 CDN에 캐시되면 창이 끝난 뒤에도 정상 사용자에게 계속 나간다. 반드시 no-store.
      // (next.config.ts의 headers()가 /players/:pcode 등에 public s-maxage를 붙이지만,
      //  이 응답은 그 규칙을 타지 않는 별도 Response다.)
      "Cache-Control": "no-store",
    },
  });
}

/** POST가 먼저다 - Server Action은 페이지 URL로 POST되므로 경로만 보면 page로 새어 나간다. */
function classify(req: NextRequest): keyof typeof LIMITS {
  if (req.method === "POST") return "post";
  if (req.nextUrl.pathname.startsWith("/api/")) return "api";
  if (req.headers.get("next-router-prefetch")) return "prefetch";
  return "page";
}

export const config = {
  // 정적 자산은 제외한다. matcher가 없으면 _next/static·_next/image·public까지 전부 proxy를
  // 타서, 페이지 한 장이 유발하는 수십 개의 자산 요청이 그대로 카운터를 태운다.
  // 값은 빌드 타임에 정적으로 분석되므로 변수를 쓰면 안 된다(proxy.md).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
