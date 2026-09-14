import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// 감사 지적: robots가 없어 /api/*(박스스코어 JSON, health)까지 크롤러가 긁어간다.
// 페이지는 전부 허용, 기계용 엔드포인트만 막는다. 스크래퍼는 robots를 안 지키므로
// 이건 "예의 바른 봇" 차단이지 보호 수단이 아니다 - 보호는 RLS·레이트리밋이 맡는다.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
