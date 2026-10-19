import type { NextConfig } from "next";

// Next가 동적 페이지에 쓰는 `Cache-Control: private, no-store`는 next.config의 일반
// Cache-Control보다 나중에 만들어져 일반 헤더로는 덮을 수 없다. Vercel 전용 헤더는 우선순위가
// 다르다. `Vercel-CDN-Cache-Control`은 Function의 일반 Cache-Control보다 우선하고 CDN에서
// 소비되어 브라우저로는 나가지 않는다. 이 헤더를 쓰면 모든 페이지 앞에서 proxy.ts를 실행하지
// 않아도 되므로, 한 요청이 Proxy + Function 두 Compute 구간을 지나며 Fast Origin Transfer가
// 이중으로 생기는 구조도 없어진다.
const CDN_CACHEABLE_PATHS = [
  "/players",
  "/players/:pcode",
  "/teams",
  "/teams/:tcode",
  "/coaches",
  "/coaches/:coachId",
  "/leaderboards/:path*",
  "/season-browser",
  "/preseason",
  "/season",
  "/rankings/:path*",
  "/lineups",
  "/awards/round",
  "/trailer",
  "/sitemap.xml",
] as const;

const CDN_HEADERS = [
  { key: "Vercel-CDN-Cache-Control", value: "public, s-maxage=300, stale-while-revalidate=3600" },
  { key: "x-courtside-cdn", value: "3" },
] as const;

// 정적 청크와 이미지 최적화 응답에는 Next/Vercel의 해시 기반 장기 캐시가 이미 있다. 아래 보안
// 헤더를 그 자산들까지 반복해서 붙이면 요청 수만큼 전송 바이트만 늘어나므로 문서/Route Handler
// 응답에만 적용한다. 개발 중 Fast Refresh는 eval/ws가 필요해 CSP를 프로덕션 빌드에만 넣는다.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
      "font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://kbl.or.kr https://www.kbl.or.kr https://*.supabase.co",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
] as const;

const nextConfig: NextConfig = {
  // 공유 미리보기 태그(og:title/og:image)를 모든 요청에서 <head>에 넣는다. 기본값은 목록에 있는
  // 봇에만 그러고 나머지는 본문 뒤에 흘려 보내는데(스트리밍 메타데이터), 카카오톡 스크래퍼
  // (kakaotalk-scrap)는 그 목록에 없어 JS 없이 <head>만 읽으면 제목·이미지를 못 본다.
  // generateMetadata는 전부 캐시된 조회(선수·팀·감독)나 페이지와 공유하는 요청 캐시(경기)라 비용이 거의 없다.
  htmlLimitedBots: /.*/,
  images: {
    // KBL 공식 선수 사진. 원본이 470x609 PNG(평균 402KB)인데 화면에는 34~44px로 그린다 -
    // /players 한 장이 31개만 걸어도 11.9MB였고(실측), 로스터 213명 사진이 다 채워지면
    // 85MB가 된다. next/image를 태우면 필요한 크기로 줄여서 내려보내고 CDN에 캐시된다.
    // 원본 응답에는 Cache-Control이 아예 없고 Content-Type도 image/png가 아니라
    // application/binary라, 브라우저 휴리스틱 캐싱에만 의존하던 상태였다.
    remotePatterns: [
      { protocol: "https", hostname: "kbl.or.kr" },
      { protocol: "https", hostname: "www.kbl.or.kr" },
      { protocol: "https", hostname: "*.supabase.co" }
    ],
    // 이 사이트가 실제로 쓰는 크기만. 목록이 넓으면 그만큼 변환 조합이 늘어난다.
    imageSizes: [16, 24, 32, 48, 64, 96],
    deviceSizes: [640, 828, 1080],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  async headers() {
    const security = process.env.NODE_ENV === "production"
      ? [{ source: "/((?!_next/static|_next/image|favicon.ico).*)", headers: [...SECURITY_HEADERS] }]
      : [];
    return [
      ...security,
      ...CDN_CACHEABLE_PATHS.map((source) => ({ source, headers: [...CDN_HEADERS] })),
    ];
  },
};

export default nextConfig;
