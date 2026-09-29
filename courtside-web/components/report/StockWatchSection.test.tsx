import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { teamInkPair } from "@/lib/teamAccent";
import type { StockWatch } from "@/lib/report/stockWatch";
import { StockWatchSection } from "./StockWatchSection";

// 목적은 문구 검증이 아니라 마이그레이션 고정 - 기대값은 옮기기 직전 lib/postgameReport.ts
// 8.10 블록이 내보내던 HTML 문자열 그대로(골든)다. 팀 색만 teamInkPair()로 계산한다
// (팔레트 계산이 바뀌어도 이 테스트가 엉뚱하게 깨지지 않게).
const ink = (color: string) => {
  const i = teamInkPair(color);
  return `--ti-l:${i.light};--ti-d:${i.dark}`;
};

const home = { tcode: "H", name: "서울 삼성", abbr: "SAM", color: "#0C2340" };
const away = { tcode: "A", name: "대구 한국가스공사", abbr: "GAS", color: "#E4002B" };

const stock: StockWatch = {
  kind: "stock_watch",
  up: { team: home, name: "이정현", pts: 28, reb: 9, ast: 7, gameScore: 24.63 },
  down: { team: away, name: "샘조세프 벨란겔", pts: 3, fgm: 1, fga: 7, turnovers: 4 },
};

const chip = (t: typeof home, name: string) =>
  `<span class="report-team" style="${ink(t.color)}"><span class="report-team-abbr" title="${t.name}">${t.abbr}</span><b class="report-player">${name}</b></span>`;

describe("StockWatchSection", () => {
  it("상한가/하한가 두 줄이 기존 문자열 HTML과 바이트 단위로 같다", () => {
    expect(renderToStaticMarkup(<StockWatchSection stock={stock} />)).toBe(
      `<ul class="report-list">` +
        `<li class="report-li" style="${ink(home.color)}">📈 <b>상한가: ${chip(home, "이정현")}</b> - 오늘 <b>28점 9리바운드 7어시스트</b>를 쏟아부으며 게임스코어 <b>24.6</b>을 기록, 다음 라운드 OVR 급상승이 유력합니다!</li>` +
        `<li class="report-li" style="${ink(away.color)}">📉 <b>하한가: ${chip(away, "샘조세프 벨란겔")}</b> - 오늘 <b>3점 (야투 1/7)</b>, 턴오버 <b>4개</b>에 그치며 유독 고전했습니다. 하루빨리 폼 회복이 시급합니다.</li>` +
        `</ul>`
    );
  });

  it("팀 메타가 없으면 원본 liOpen()/playerTag()와 같은 폴백 - 색 없는 <li>에 맨 이름", () => {
    const orphan: StockWatch = { ...stock, up: { ...stock.up, team: null } };
    const out = renderToStaticMarkup(<StockWatchSection stock={orphan} />);
    expect(out).toContain(`<li>📈 <b>상한가: 이정현</b> - 오늘`);
    // 팀이 있는 쪽은 그대로 색이 붙는다(폴백이 한 줄에만 적용되는지).
    expect(out).toContain(`<li class="report-li" style="${ink(away.color)}">📉`);
  });

  it("이름은 React가 항상 이스케이프한다(문자열 조립 쪽에선 escHtml()을 잊으면 새는 자리)", () => {
    const evil: StockWatch = { ...stock, down: { ...stock.down, name: "<img src=x>" } };
    const out = renderToStaticMarkup(<StockWatchSection stock={evil} />);
    expect(out).toContain("&lt;img src=x&gt;");
    expect(out).not.toContain("<img");
  });
});
