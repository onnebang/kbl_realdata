import type { NextConfig } from "next";

// CDN에 캐시해도 되는 라우트에 붙일 값. 5분 신선 + 1시간 stale-while-revalidate.
// SWR이 켜져 있으면 만료 후 첫 요청자 1명만 낡은 HTML을 받고 그 뒤 백그라운드 재검증이
// 돌므로, "1시간 동안 낡음"이 아니라 "재검증 1회당 낡은 응답 1회"다.
const CDN_CACHEABLE = "public, s-maxage=300, stale-while-revalidate=3600";

// 이 규칙이 실제로 붙었는지 curl -I 한 번으로 구분하기 위한 표식.
// 없으면 source 패턴이 안 맞은 것이고, 있는데 Cache-Control이 private이면 Next의 동적 렌더
// 헤더가 덮어쓴 것이다 - 원인이 다르면 고칠 곳도 다르므로 둘을 구분할 수 있어야 한다.
const cdnHeaders = () => [
  { key: "Cache-Control", value: CDN_CACHEABLE },
  { key: "x-courtside-cdn", value: "1" },
];

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

  // ── CDN 캐시 (감사 실측 2026-09-06) ───────────────────────────────────────────────
  // 프로덕션 HTML 12개가 전부 `Cache-Control: private, no-cache, no-store`였다. supabase-js가
  // 부르는 fetch에 cache 옵션이 없어서 모든 페이지가 동적 렌더로 떨어지고(lib/cachePolicy.ts
  // 상단 주석 참고), 동적 렌더의 기본 헤더가 그대로 나간 것이다. 그래서 CDN 히트가 0이고
  // 같은 HTML을 매번 함수가 다시 만든다 - /players/210080은 763KB·1.77초였고, 10 rps면
  // 7.6MB/s(27GB/시간) + 함수 10개 상시 점유다.
  //
  // unstable_cache(lib/cachePolicy.ts)는 **DB 왕복**을 줄이지만 렌더와 전송은 그대로 일어난다.
  // 여기서 줄이는 건 그 나머지 - 같은 URL의 두 번째 요청부터 함수가 아예 안 깨어난다.
  //
  // ★ 안전한 라우트에만 붙인다. 특히 다음 둘에는 절대 붙이지 않는다:
  //   · `/games/:gmkey` - 라이브 문자중계. 서버가 준 시드(initialLastOrder)가 캐시돼 뒤처지면
  //     lib/useLiveGame.ts가 그 시드 뒤부터 이어받기 때문에 그 사이 이벤트가 **영구히 비는
  //     구멍**이 된다. TTL로는 못 고친다(lib/cachePolicy.ts의 gameTtl이 라이브에 0을 주는 것과
  //     같은 이유).
  //   · `/` (홈) - 경기 목록에 진행 중 경기의 라이브 점수가 있다. 캐시되면 낡은 점수가 나간다.
  //   · `/api/health` - 이미 라우트에서 no-store를 명시한다(진단용이라 캐시되면 무의미). 건드리지 않음.
  //
  // 아래 목록은 "쿠키/로그인 상태를 읽지 않고(앱 전체에서 next/headers의 cookies()를 쓰는
  // 곳이 없음 - 확인함), 화면에 라이브 점수가 없는" 페이지들이다. /teams/:tcode는 진행 중
  // 경기를 점수가 아니라 "진행 중"이라는 글자로만 표시하고, 종료 점수는 is_ended 이후에만
  // 그리므로 5분 지연이 틀린 숫자를 만들지 않는다(막 끝난 경기가 잠깐 "진행 중"으로 남을 뿐).
  //
  // RSC 페이로드와 HTML이 같은 URL을 공유하지만 Next가 응답에 `Vary: RSC, Next-Router-State-Tree,
  // Next-Router-Prefetch, Next-Url`을 붙이므로 CDN이 서로 섞어 주지 않는다.
  async headers() {
    return [
      { source: "/players/:pcode", headers: cdnHeaders() },
      { source: "/teams/:tcode", headers: cdnHeaders() },
      { source: "/leaderboards/:path*", headers: cdnHeaders() },
      { source: "/season-browser", headers: cdnHeaders() },
      // /preseason은 D-day 카운터가 있다(app/preseason/page.tsx). 자정 경계에서 최대 5분간
      // 이전 D-N이 남을 수 있는데, 하루 단위로 바뀌는 값이라 5분 지연은 표시상 무해하다고 봤다.
      { source: "/preseason", headers: cdnHeaders() },
    ];
  },
};

export default nextConfig;
