import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "@/lib/ogCard";

// 사이트 기본 공유 카드 - 자기 카드가 없는 모든 페이지(목록·리더보드·개막 리포트)가 이걸 물려받는다.
export const alt = "코트사이드 - KBL 실시간 승률·데이터 분석";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    kicker: "KBL 경기·선수·팀·감독",
    title: "승률 흐름부터 시즌 전망까지",
    sub: "라이브 문자중계, 선수 슈팅 DNA, 확정 로스터 기반 전망",
  });
}
