import type { NextConfig } from "next";

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
