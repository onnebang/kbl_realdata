import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { teamInkPair } from "@/lib/teamAccent";
import { AceDuelSection } from "./AceDuelSection";
import type { AceDuel } from "@/lib/report/aceDuel";

// 목적은 문구 검증이 아니라 **마이그레이션 고정**이다: 아래 기대값은 옮기기 직전
// lib/postgameReport.ts 8.9 블록이 내보내던 HTML 문자열 그대로(골든)이고, 컴포넌트 렌더
// 결과가 바이트 단위로 같아야 한다. 팀 색 두 개(--ti-l/--ti-d)만 teamInkPair()로 계산하는데,
// 그 값은 이 마이그레이션의 관심사가 아니라서 하드코딩하지 않는다(팔레트 계산이 바뀌어도
// 이 테스트가 엉뚱하게 깨지지 않게).
const ink = (color: string) => {
  const i = teamInkPair(color);
  return `--ti-l:${i.light};--ti-d:${i.dark}`;
};

const home = { tcode: "H", name: "서울 삼성", abbr: "SAM", color: "#0C2340" };
const away = { tcode: "A", name: "대구 한국가스공사", abbr: "GAS", color: "#E4002B" };
const duel = (margin: number, verdict: AceDuel["verdict"]): AceDuel => ({
  kind: "ace_duel",
  seconds: 500, // fmtDuration -> "8분 20초"
  margin,
  verdict,
  home: { team: home, star: "이정현", pts: 24 },
  away: { team: away, star: "샘조세프 벨란겔", pts: 24 - margin },
});

describe("AceDuelSection", () => {
  it("홈 우위 - 기존 문자열 HTML과 바이트 단위로 동일", () => {
    expect(renderToStaticMarkup(<AceDuelSection duel={duel(9, "home")} />)).toBe(
      `<p class="report-text">🥊 <b class="report-team" style="${ink(home.color)}">서울 삼성</b>이 <b>이정현</b>은 <b>샘조세프 벨란겔</b>와의 에이스 맞대결 구간(8분 20초)에서 팀을 <b>+9점</b>(24-15) 우위로 이끌며 자존심 싸움에서 판정승을 거두었습니다.</p>`
    );
  });

  it("원정 우위 - 마진 절댓값과 스코어 순서가 원정 기준으로 뒤집힌다", () => {
    expect(renderToStaticMarkup(<AceDuelSection duel={duel(-7, "away")} />)).toBe(
      `<p class="report-text">🥊 <b class="report-team" style="${ink(away.color)}">대구 한국가스공사</b>가 <b>샘조세프 벨란겔</b>은 <b>이정현</b>와의 에이스 정면승부 구간(8분 20초)에서 팀을 <b>+7점</b>(31-24) 우위로 이끌며 완승했습니다.</p>`
    );
  });

  it("호각세 - 팀 색 태그 없이 두 에이스만", () => {
    expect(renderToStaticMarkup(<AceDuelSection duel={duel(2, "even")} />)).toBe(
      `<p class="report-text">🥊 양 팀의 에이스 <b>이정현</b>와 <b>샘조세프 벨란겔</b>은 코트에 동시 출전한 8분 20초 동안 스코어 <b>24-22</b>로 우열을 가리기 힘든 호각세를 보였습니다.</p>`
    );
  });

  it("이름은 React가 항상 이스케이프한다(문자열 조립 쪽에선 escHtml()을 잊으면 그대로 새는 자리)", () => {
    const evil = { ...duel(2, "even"), home: { team: home, star: "<img src=x>", pts: 24 } };
    const out = renderToStaticMarkup(<AceDuelSection duel={evil} />);
    expect(out).toContain("&lt;img src=x&gt;");
    expect(out).not.toContain("<img");
  });
});
