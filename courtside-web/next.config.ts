import type { NextConfig } from "next";

// ── CDN 캐시 헤더는 여기서 만들지 않는다 (2026-09-06, 두 번의 실패 뒤 결론) ─────────────
// 1차: 이 자리에 headers()로 Cache-Control을 붙였다 -> 배포해서 curl로 재보니 x-courtside-cdn:1은
// 붙는데 Cache-Control은 여전히 private였다. force-dynamic 라우트는 렌더 막바지에 프레임워크가
// Cache-Control을 강제로 다시 쓰는데, next.config.ts의 headers()가 그보다 먼저 적용되는 설정이라
// 그 시점에 덮인다.
// 2차: proxy.ts(NextResponse.next().headers.set())로 옮겼다 -> 그런데도 여전히 x-courtside-cdn:1
// (proxy가 쓰려던 "2"가 아니라)이 나왔다. 원인을 좁혀 보니 **origin(이 파일의 headers()가 낸
// 값)이 그 헤더 이름을 이미 갖고 있으면, 단순 패스스루(NextResponse.next())로는 proxy 쪽 값이
// 못 이긴다** - 같은 이름을 origin이 안 내야 proxy가 유일한 소스가 되어 이긴다.
// 그래서 이 headers() 블록을 통째로 지웠다. Cache-Control/x-courtside-cdn은 이제 proxy.ts가
// 유일하게 만든다(그 파일의 CDN_CACHEABLE_PATHS 주석에 대상 라우트·근거가 그대로 있다).
const nextConfig: NextConfig = {
  images: {
    // KBL 공식 선수 사진. 원본이 470x609 PNG(평균 402KB)인데 화면에는 34~44px로 그린다 -
    // /players 한 장이 31개만 걸어도 11.9MB였고(실측), 로스터 213명 사진이 다 채워지면
    // 85MB가 된다. next/image를 태우면 필요한 크기로 줄여서 내려보내고 CDN에 캐시된다.
    // 원본 응답에는 Cache-Control이 아예 없고 Content-Type도 image/png가 아니라
    // application/binary라, 브라우저 휴리스틱 캐싱에만 의존하던 상태였다.
    remotePatterns: [{ protocol: "https", hostname: "kbl.or.kr" }, { protocol: "https", hostname: "www.kbl.or.kr" }],
    // 이 사이트가 실제로 쓰는 크기만. 목록이 넓으면 그만큼 변환 조합이 늘어난다.
    imageSizes: [16, 24, 32, 48, 64, 96],
    deviceSizes: [640, 828, 1080],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
};

export default nextConfig;
