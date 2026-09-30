import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { teamInkPair } from "@/lib/teamAccent";
import type { StockWatch } from "@/lib/report/stockWatch";
import { StockWatchSection } from "./StockWatchSection";

// 원래는 마이그레이션 고정(옮기기 직전 문자열과 바이트 단위 동일)만 하던 테스트였다. 이제는
// 문구 규칙까지 고정한다: 하한가 근거로 **실제로 나쁜 값만** 들어야 한다. 예전엔 턴오버를 무조건
// 나열해서 "턴오버 0개에 그치며 유독 고전했습니다"가 배포돼 있었다(정인덕, 2026-09-30 실측 -
// 턴오버 0은 잘한 것이다). 팀 색만 teamInkPair()로 계산한다(팔레트 계산이 바뀌어도 이 테스트가
// 엉뚱하게 깨지지 않게).
const ink = (color: string) => {
  const i = teamInkPair(color);
  return `--ti-l:${i.light};--ti-d:${i.dark}`;
};

const home = { tcode: "H", name: "서울 삼성", abbr: "SAM", color: "#0C2340" };
const away = { tcode: "A", name: "대구 한국가스공사", abbr: "GAS", color: "#E4002B" };

const stock: StockWatch = {
  kind: "stock_watch",
  up: { team: home, name: "이정현", pts: 28, reb: 9, ast: 7, gameScore: 24.63 },
  down: { team: away, name: "샘조세프 벨란겔", pts: 3, fgm: 1, fga: 7, turnovers: 4, fouls: null },
};

const chip = (t: typeof home, name: string) =>
  `<span class="report-team" style="${ink(t.color)}"><span class="report-team-abbr" title="${t.name}">${t.abbr}</span><b class="report-player">${name}</b></span>`;

describe("StockWatchSection", () => {
  it("상한가/하한가 두 줄", () => {
    expect(renderToStaticMarkup(<StockWatchSection stock={stock} />)).toBe(
      `<ul class="report-list">` +
        `<li class="report-li" style="${ink(home.color)}">📈 <b>상한가: ${chip(home, "이정현")}</b> - 오늘 <b>28점 9리바운드 7어시스트</b>로 게임스코어 <b>24.6</b>, 이 경기 양 팀 최고치입니다.</li>` +
        `<li class="report-li" style="${ink(away.color)}">📉 <b>하한가: ${chip(away, "샘조세프 벨란겔")}</b> - 오늘 <b>3점 (야투 1/7)</b>, <b>턴오버 4개</b>로 이 경기에서는 고전했습니다.</li>` +
        `</ul>`
    );
  });

  // 실측 버그 회귀 방지 - 턴오버/반칙이 말할 만한 값이 아니면(stockWatch.ts가 null로 담는다)
  // 문장에 아예 나오지 않아야 한다. 야투만으로 하한가에 걸린 선수(fga>=5)가 이 경우다.
  it("턴오버가 null이면 문장에 턴오버를 아예 언급하지 않는다", () => {
    const fgaOnly: StockWatch = { ...stock, down: { ...stock.down, turnovers: null, fouls: null } };
    const out = renderToStaticMarkup(<StockWatchSection stock={fgaOnly} />);
    expect(out).not.toContain("턴오버");
    expect(out).not.toContain("반칙");
    expect(out).toContain(`<b>3점 (야투 1/7)</b>로 이 경기에서는 고전했습니다.`);
  });

  it("턴오버와 반칙이 둘 다 있으면 가운뎃점으로 이어 붙인다", () => {
    const both: StockWatch = { ...stock, down: { ...stock.down, turnovers: 4, fouls: 5 } };
    const out = renderToStaticMarkup(<StockWatchSection stock={both} />);
    expect(out).toContain(`<b>턴오버 4개 · 5반칙</b>로 이 경기에서는 고전했습니다.`);
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
