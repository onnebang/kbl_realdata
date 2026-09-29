import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { teamInkPair } from "@/lib/teamAccent";
import { UnsungHeroSection } from "./UnsungHeroSection";
import type { UnsungHero, UnsungHeroes } from "@/lib/report/unsungHero";

// AceDuelSection.test.tsx와 같은 목적: 문구 검증이 아니라 **마이그레이션 고정**이다. 아래
// 기대값은 옮기기 직전 lib/postgameReport.ts 2.5 블록이 내보내던 HTML 문자열 그대로(골든).
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

/** 옮기기 직전 문자열 조립이 내보내던 HTML 그대로. */
const GOLDEN = `<ul class="report-list"><li class="report-li" style="${ink(home.color)}"><b><span class="report-team" style="${ink(home.color)}"><span class="report-team-abbr" title="서울 삼성">SAM</span><b class="report-player">이원석</b></span></b> - 오늘 <b>6득점</b>에 그쳤지만, 비록 득점은 적었으나 <b>7리바운드</b> <b>2어시스트</b> 등 궂은일을 도맡았으며, 그가 코트를 밟은 20분 동안 팀은 마진 <b>+9</b>를 기록했습니다. 반면 벤치에서 쉰 10분 30초 동안에는 팀 마진이 <b>-7</b>로 무너졌습니다. 코트 위에서 <b class="report-team" style="${ink(home.color)}">서울 삼성</b>의 공수 밸런스를 든든하게 지탱했습니다.</li></ul>`;

describe("UnsungHeroSection", () => {
  it("궂은일 스탯이 있는 경우 - 기존 문자열 HTML과 바이트 단위로 동일", () => {
    expect(renderToStaticMarkup(<UnsungHeroSection heroes={wrap(hero())} />)).toBe(GOLDEN);
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
    expect(html).toContain("그쳤지만, 비록 스탯 라인은 단출했으나, 그가 코트를 밟은");
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
