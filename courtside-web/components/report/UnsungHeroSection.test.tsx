import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { teamInkPair } from "@/lib/teamAccent";
import { UnsungHeroSection } from "./UnsungHeroSection";
import type { UnsungHero, UnsungHeroes } from "@/lib/report/unsungHero";

// 고정하는 규칙 둘(둘 다 2026-09-30 실측 배포본에서 고친 것):
//  1) "N득점에 그쳤지만, **비록 득점은 적었으나**"로 같은 말을 두 번 하지 않는다.
//  2) 각 줄 끝에 "…공수 밸런스를 든든하게 지탱했습니다"를 값과 무관하게 붙이지 않는다. 양 팀
//     두 선수에게 토씨 하나 안 틀리고 똑같이 붙어서 템플릿인 게 드러났고, 이 모듈이 스스로
//     적어둔 한계(한 경기 온/오프 스플릿은 인과가 아니다)와도 어긋나는 주장이었다. 그 한계는
//     목록 뒤 .report-caveat 한 줄로 한 번만 말한다.
const ink = (color: string) => {
  const i = teamInkPair(color);
  return `--ti-l:${i.light};--ti-d:${i.dark}`;
};

const home = { tcode: "H", name: "서울 삼성", abbr: "SAM", color: "#0C2340" };
const away = { tcode: "A", name: "대구 한국가스공사", abbr: "GAS", color: "#E4002B" };

const hero = (over: Partial<UnsungHero> = {}): UnsungHero => ({
  team: home,
  name: "이원석",
  pts: 6,
  chores: [
    { label: "리바운드", value: 7 },
    { label: "어시스트", value: 2 },
  ],
  onSec: 1200, // fmtDuration -> "20분"
  onMargin: 9,
  offSec: 630, // -> "10분 30초"
  offMargin: -7,
  ...over,
});
const wrap = (...heroes: UnsungHero[]): UnsungHeroes => ({ kind: "unsung_heroes", heroes });

const CAVEAT = `<p class="report-caveat">한 경기 온/오프 스플릿입니다. 상대 라인업을 통제하지 않았으므로 &quot;이 선수 때문&quot;이라는 인과로는 읽을 수 없습니다.</p>`;
const GOLDEN = `<ul class="report-list"><li class="report-li" style="${ink(home.color)}"><b><span class="report-team" style="${ink(home.color)}"><span class="report-team-abbr" title="서울 삼성">SAM</span><b class="report-player">이원석</b></span></b> - 오늘 <b>6득점</b>에 그쳤지만, <b>7리바운드</b> <b>2어시스트</b> 등 궂은일을 도맡았고, 그가 코트를 밟은 20분 동안 팀은 마진 <b>+9</b>, 벤치에서 쉰 10분 30초 동안에는 <b>-7</b>였습니다.</li></ul>` + CAVEAT;

describe("UnsungHeroSection", () => {
  it("궂은일 스탯이 있는 경우", () => {
    expect(renderToStaticMarkup(<UnsungHeroSection heroes={wrap(hero())} />)).toBe(GOLDEN);
  });

  // 회귀 방지 - 같은 말 두 번 / 무조건 붙는 미사여구가 다시 들어오면 여기서 깨진다.
  it("이중 부정과 무조건 붙는 맺음말이 없다", () => {
    const html = renderToStaticMarkup(<UnsungHeroSection heroes={wrap(hero())} />);
    expect(html).not.toContain("비록 득점은 적었으나");
    expect(html).not.toContain("든든하게 지탱");
  });

  // 실제 페이지가 쓰는 렌더러는 이쪽(스트리밍 SSR)이다. renderToStaticMarkup만 고정해 두면
  // "배포된 HTML과 같다"가 실제로는 거짓이 된다 - 2026-09-29 배포본 실측에서
  // `<b>11<!-- -->득점</b>`처럼 인접 텍스트 노드 사이에 하이드레이션 구분자가 들어 있었다
  // (먼저 옮긴 AceDuelSection도 동일). 눈에 보이는 글자·공백·클래스는 그대로이고 주석은
  // 렌더되지 않으며 CSS 선택자에도 영향이 없어서 그대로 두고, 대신 여기서 명시적으로 고정한다.
  it("실제 SSR 출력도 <!-- --> 구분자만 빼면 같은 문자열", () => {
    const ssr = renderToString(<UnsungHeroSection heroes={wrap(hero())} />);
    expect(ssr).toContain("<!-- -->");
    expect(ssr.replace(/<!-- -->/g, "")).toBe(GOLDEN);
  });

  it("궂은일이 하나도 없으면 문장이 다른 갈래로 간다", () => {
    const html = renderToStaticMarkup(<UnsungHeroSection heroes={wrap(hero({ chores: [] }))} />);
    expect(html).toContain("그쳤지만, 스탯 라인은 단출했지만, 그가 코트를 밟은");
    expect(html).not.toContain("궂은일");
  });

  it("양 팀이 다 걸리면 li가 둘, 각자 자기 팀 색", () => {
    const html = renderToStaticMarkup(
      <UnsungHeroSection heroes={wrap(hero(), hero({ team: away, name: "김낙현", chores: [{ label: "스틸", value: 3 }] }))} />
    );
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toContain(ink(away.color));
    expect(html).toContain("<b>3스틸</b> 등 궂은일");
  });

  it("이름은 React가 항상 이스케이프한다(문자열 조립 쪽에선 escHtml()을 잊으면 새는 자리)", () => {
    const html = renderToStaticMarkup(<UnsungHeroSection heroes={wrap(hero({ name: "<img src=x>" }))} />);
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img");
  });
});
