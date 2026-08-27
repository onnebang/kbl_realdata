import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "코트사이드",
  description: "KBL 실시간 승률 분석 - 경기 목록과 라이브 리플레이",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
