import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "코트사이드 | KBL 실시간 승률·데이터 분석",
    short_name: "코트사이드",
    description: "KBL 경기 중 승률 흐름, 선수·팀·감독 프로필, 시즌 전망을 데이터로 봅니다.",
    start_url: "/",
    display: "standalone",
    background_color: "#0f1115",
    theme_color: "#0f1115",
    lang: "ko",
    icons: [
      { src: "/brand/courtside-app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/courtside-app-icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/courtside-app-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
