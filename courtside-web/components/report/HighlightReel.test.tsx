import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportSection } from "@/lib/postgameReport";
import type { StockWatch } from "@/lib/report/stockWatch";
import { HighlightReel } from "./HighlightReel";

const home = { tcode: "H", name: "서울 삼성", abbr: "SAM", color: "#0C2340" };

const stock: StockWatch = {
  kind: "stock_watch",
  up: { team: home, name: "이정현", pts: 28, reb: 9, ast: 7, gameScore: 24.63 },
  down: { team: home, name: "김영수", pts: 3, fgm: 1, fga: 7, turnovers: null, fouls: null },
};

const sections: ReportSection[] = [
  { title: "팀별 스포트라이트", html: `<p class="report-text">무시되는 섹션</p>` },
  { title: "AI 선정 베스트 장면", html: `<p class="report-text">✨ 베스트 장면 문장</p>` },
  { title: "주가 변동 리포트 (Stock Up & Down)", data: stock },
];

describe("HighlightReel", () => {
  it("아는 제목만 고정된 순서(베스트 장면 -> 주가 변동)로 카드화하고, 모르는 섹션은 건너뛴다", () => {
    const out = renderToStaticMarkup(<HighlightReel sections={sections} />);
    expect(out).toContain('class="highlight-reel"');
    expect(out).not.toContain("무시되는 섹션");
    expect(out).toContain("BEST PLAY");
    expect(out).toContain("베스트 장면 문장");
    expect(out).toContain("STOCK WATCH");
    expect(out).toContain("상한가");
    expect(out.indexOf("BEST PLAY")).toBeLessThan(out.indexOf("STOCK WATCH"));
  });

  it("아는 제목이 하나도 없으면 아무것도 렌더하지 않는다", () => {
    const out = renderToStaticMarkup(
      <HighlightReel sections={[{ title: "팀별 스포트라이트", html: "<p>x</p>" }]} />
    );
    expect(out).toBe("");
  });
});
