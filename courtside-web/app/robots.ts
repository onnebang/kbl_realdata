import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// 감사 지적: robots가 없어 /api/*(박스스코어 JSON, health)까지 크롤러가 긁어간다.
// 기계용 엔드포인트는 막는다. 스크래퍼는 robots를 안 지키므로 이건 "예의 바른 봇" 차단이지
// 보호 수단이 아니다 - 보호는 RLS·레이트리밋이 맡는다.
//
// /predictions(예측 성적표)는 운영자 전용이다 - 모델의 캘리브레이션과 실력 수준이 그대로
// 드러나는 내부 지표라 공개하지 않는다(사용자 결정, 2026-09-30). 실제 차단은 그 페이지가
// REVALIDATE_TOKEN을 요구하는 것이고, 여기 disallow와 페이지의 noindex는 검색에 노출되지
// 않게 하는 보조 수단이다.
//
// ── 쿼리가 붙은 주소는 크롤링 금지 (실측 2026-10-18~19, Vercel 계정 차단의 원인) ──────────────
// 선수 페이지의 토글 링크(?w= 창 4종 × ?season= 출전 시즌 전부 × ?rate= 2종 × ?rw= 2종)가 전부 <a href>라
// 크롤러가 선수 한 명당 최대 수백 개 주소를 따라갔다. 쿼리마다 CDN 캐시 키가 달라 매번 무거운 렌더(약 760KB,
// Supabase 왕복 약 60번)가 돌았고, 10-18 02시부터 하루 넘게 시간당 최대 2,500번(서로 다른 선수 약 690명) 렌더가
// 일정한 속도로 이어진 끝에 계정이 막혔다(Supabase edge_logs의 service_role 요청으로 측정 - 경기 페이지는 시간당
// 수십 번뿐이었다). 홈(?page=·?team=…)·라인업·팀·감독·경기(?tab=)도 같은 구조라 경로가 아니라 "쿼리가 붙은
// 모든 주소"를 막는다 - 쿼리는 화면 상태일 뿐이고 색인할 본문은 쿼리 없는 주소에 있다(사이트맵도 전부 쿼리 없음).
// /_next/(JS·이미지 최적화 ?url=)는 검색엔진이 페이지를 그릴 때 필요해 열어 둔다 - 더 긴 규칙이 이긴다.
//
// robots를 안 지키는 봇은 여기서 못 막는다. 그건 함수 호출 전에 끊는 Vercel 방화벽(Bot Protection)의 몫이다.
// 앱에서 "봇이면 쿼리 없는 주소로 리다이렉트"는 쓰지 않는다 - 선수·팀 페이지는 CDN 캐시 키가 주소뿐이라
// 봇에게 준 리다이렉트가 캐시돼 같은 주소로 온 사람에게도 나가면 시즌 선택이 날아간다.
const QUERY_VARIANTS = "/*?";
const MACHINE_ONLY = ["/api/", "/predictions"];

// 방문자를 데려오지 않는 AI 학습·SEO 도구 크롤러 - 통째로 막는다. 검색엔진(Googlebot·Yeti·Daum·Bingbot)과
// AI 검색·사용자 요청 봇(OAI-SearchBot·ChatGPT-User·Claude-SearchBot·Claude-User·PerplexityBot)은 아래 일반 규칙을 따른다.
const TRAINING_AND_SEO_CRAWLERS = [
  "GPTBot",
  "ClaudeBot",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "Bytespider",
  "meta-externalagent",
  "FacebookBot",
  "Amazonbot",
  "cohere-ai",
  "Diffbot",
  "PetalBot",
  "AhrefsBot",
  "SemrushBot",
  "MJ12bot",
  "DotBot",
  "DataForSeoBot",
];

// 링크 미리보기 봇 - 카톡·페북·X 등으로 공유한 주소(쿼리 포함)를 그대로 읽어야 제목·이미지가 뜬다.
// 크롤링이 아니라 공유 한 번에 한 번 오므로 쿼리 금지·크롤 간격을 걸지 않는다.
const PREVIEW_BOTS = ["kakaotalk-scrap", "facebookexternalhit", "Twitterbot", "Slackbot", "Discordbot", "TelegramBot"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: TRAINING_AND_SEO_CRAWLERS, disallow: "/" },
      { userAgent: PREVIEW_BOTS, allow: "/", disallow: MACHINE_ONLY },
      // Crawl-delay는 Bing·Naver처럼 지키는 봇에게만 듣는다(Googlebot은 무시하고 서버 응답 속도로 스스로 조절).
      { userAgent: "*", allow: ["/", "/_next/"], disallow: [...MACHINE_ONLY, QUERY_VARIANTS], crawlDelay: 10 },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
