import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// 감사 지적: robots가 없어 /api/*(박스스코어 JSON, health)까지 크롤러가 긁어간다.
// 페이지는 전부 허용, 기계용 엔드포인트만 막는다. 스크래퍼는 robots를 안 지키므로
// 이건 "예의 바른 봇" 차단이지 보호 수단이 아니다 - 보호는 RLS·레이트리밋이 맡는다.
//
// /predictions(예측 성적표)는 운영자 전용이다 - 모델의 캘리브레이션과 실력 수준이 그대로
// 드러나는 내부 지표라 공개하지 않는다(사용자 결정, 2026-09-30). 실제 차단은 그 페이지가
// REVALIDATE_TOKEN을 요구하는 것이고, 여기 disallow와 페이지의 noindex는 검색에 노출되지
// 않게 하는 보조 수단이다.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/predictions"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
