import type { Metadata, Viewport } from "next";
import { preconnect } from "react-dom";
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

// 브라우저 UI(주소창 등) 색을 페이지 배경(--bg)과 맞춘다 - 다크 테마는 globals.css의 미디어쿼리 하나뿐이라
// 같은 조건으로 두 색을 준다.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // 팀 로고·라이벌 아바타가 kbl.or.kr에서 바로 로드된다(TeamBadge, AchievementTrophyRoom) - 연결을 미리 맺는다.
  preconnect("https://kbl.or.kr");
  return (
    <html lang="ko">
      <body>
        <a href="#main" className="skip-link">
          본문으로 건너뛰기
        </a>
        <NavBar />
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
