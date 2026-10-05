import type { CSSProperties } from "react";
import type { ReportSection } from "@/lib/postgameReport";
import { DataSectionBody } from "./DataSectionBody";
import { HtmlSectionRenderer } from "./HtmlSectionRenderer";

// AI 코트사이드 리포트 중 가장 눈에 띄는 네 조각을 본문 목록보다 먼저 카드로 보여준다(요청 -
// "글자가 너무 많다, 이목을 끌 내용부터 역동적이고 데이터 잘 보이게"). 새 데이터를 만들지
// 않는다 - buildPostgameReport()가 이미 만든 reportSections에서 제목으로 골라 재사용(아래
// 전체 목록에도 그대로 남는다). 여기 없는 제목이면(과거 시즌 fallback 등으로 섹션 자체가
// 안 만들어졌으면) 조용히 빠진다 - 네 장 미만이어도 괜찮다.
const HERO_TITLES: Record<string, { icon: string; kicker: string }> = {
  "AI 선정 베스트 장면": { icon: "✨", kicker: "BEST PLAY" },
  "극적인 흐름": { icon: "⚡", kicker: "MOMENTUM SWING" },
  "에이스 정면승부 성적표 (Head-to-Head Duel)": { icon: "🥊", kicker: "ACE DUEL" },
  "주가 변동 리포트 (Stock Up & Down)": { icon: "📈", kicker: "STOCK WATCH" },
};

export function HighlightReel({ sections }: { sections: ReportSection[] }) {
  const cards = Object.keys(HERO_TITLES)
    .map((title) => sections.find((s) => s.title === title))
    .filter((s): s is ReportSection => s != null);
  if (cards.length === 0) return null;
  return (
    <div className="highlight-reel">
      {cards.map((s, i) => {
        const meta = HERO_TITLES[s.title];
        return (
          <div className="highlight-card" style={{ "--hi": i } as CSSProperties} key={s.title}>
            <div className="highlight-kicker">{meta.kicker}</div>
            <div className="highlight-card-icon" aria-hidden>
              {meta.icon}
            </div>
            <div className="highlight-card-body">
              {"data" in s ? <DataSectionBody data={s.data} /> : <HtmlSectionRenderer html={s.html} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
