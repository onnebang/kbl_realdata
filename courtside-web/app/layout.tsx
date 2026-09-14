import type { Metadata } from "next";
import "./globals.css";
import { NavBar } from "@/components/NavBar";
import { SITE_URL } from "@/lib/site";

// 페이지마다 제목이 "코트사이드" 하나라 링크를 공유하면 무슨 페이지인지 안 보였다(2026-09-14).
// 각 페이지는 title만 주고, 뒤의 "| 코트사이드"와 og 기본값은 여기서 붙는다. 공유 이미지는
// app/opengraph-image.tsx(기본)와 경기·선수·팀·감독 폴더의 opengraph-image.tsx.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "코트사이드 | KBL 실시간 승률·데이터 분석", template: "%s | 코트사이드" },
  description: "KBL 경기 중 승률 흐름, 선수·팀·감독 프로필, 시즌 전망을 데이터로 봅니다.",
  openGraph: { siteName: "코트사이드", locale: "ko_KR", type: "website" },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body>
        <NavBar />
        {children}
      </body>
    </html>
  );
}
