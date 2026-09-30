import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { teamInkPair } from "@/lib/teamAccent";
import { AceDuelSection } from "./AceDuelSection";
import type { AceDuel } from "@/lib/report/aceDuel";

// 컴포넌트 렌더 결과를 바이트 단위로 박아 둔다. 고정하는 규칙 셋:
//  1) 홈/원정 문구 비대칭 없음(원래 홈만 "맞대결 구간", 원정만 "완승"이었다).
//  2) **와/과 조사**를 josa.waGwa()로 고른다 - 예전엔 '와'가 하드코딩돼 있어서 배포본에
//     "루이스 킹와 양홍석"이 그대로 나가 있었다(2026-09-30 실측). 여기 두 픽스처는
//     '이정현'(ㄴ받침)·'샘조세프 벨란겔'(ㄹ받침) 둘 다 받침이 있어 '과'가 맞다.
//  3) 스코어가 **두 선수 개인 득점이 아니라 팀 득실**이라는 단서를 같이 낸다 - 예전 문장은
//     두 선수 이름 바로 뒤에 "스코어 50-46"을 붙여 개인 기록처럼 읽혔다.
// 팀 색 두 개(--ti-l/--ti-d)만 teamInkPair()로 계산하는데,
// 그 값은 이 마이그레이션의 관심사가 아니라서 하드코딩하지 않는다(팔레트 계산이 바뀌어도
// 이 테스트가 엉뚱하게 깨지지 않게).
const ink = (color: string) => {
  const i = teamInkPair(color);
  return `--ti-l:${i.light};--ti-d:${i.dark}`;
};

const home = { tcode: "H", name: "서울 삼성", abbr: "SAM", color: "#0C2340" };
const away = { tcode: "A", name: "대구 한국가스공사", abbr: "GAS", color: "#E4002B" };
/** 세 갈래 모두 뒤에 붙는 한계 표기. */
const CAVEAT = `<p class="report-caveat">두 선수 개인 득점이 아니라 둘이 함께 코트에 있던 시간의 팀 득실입니다.</p>`;

const duel = (margin: number, verdict: AceDuel["verdict"]): AceDuel => ({
  kind: "ace_duel",
  seconds: 500, // fmtDuration -> "8분 20초"
  margin,
  verdict,
  home: { team: home, star: "이정현", pts: 24 },
  away: { team: away, star: "샘조세프 벨란겔", pts: 24 - margin },
});

describe("AceDuelSection", () => {
  it("홈 우위", () => {
    expect(renderToStaticMarkup(<AceDuelSection duel={duel(9, "home")} />)).toBe(
      `<p class="report-text">🥊 <b class="report-team" style="${ink(home.color)}">서울 삼성</b>의 <b>이정현</b>이 <b>샘조세프 벨란겔</b>과의 에이스 정면승부 구간(8분 20초)에서 팀을 <b>+9점</b>(24-15) 우위로 이끌며 판정승을 거두었습니다.</p>` + CAVEAT
    );
  });

  it("원정 우위 - 마진 절댓값과 스코어 순서가 원정 기준으로 뒤집힌다(문구는 홈과 동일)", () => {
    expect(renderToStaticMarkup(<AceDuelSection duel={duel(-7, "away")} />)).toBe(
      `<p class="report-text">🥊 <b class="report-team" style="${ink(away.color)}">대구 한국가스공사</b>의 <b>샘조세프 벨란겔</b>이 <b>이정현</b>과의 에이스 정면승부 구간(8분 20초)에서 팀을 <b>+7점</b>(31-24) 우위로 이끌며 판정승을 거두었습니다.</p>` + CAVEAT
    );
  });

  it("호각세 - 팀 색 태그 없이 두 에이스만", () => {
    expect(renderToStaticMarkup(<AceDuelSection duel={duel(2, "even")} />)).toBe(
      `<p class="report-text">🥊 양 팀의 에이스 <b>이정현</b>과 <b>샘조세프 벨란겔</b>이 코트에 동시 출전한 8분 20초 동안 팀 스코어 <b>24-22</b>, 우열을 가릴 만한 차이가 나지 않았습니다.</p>` + CAVEAT
    );
  });

  // 실측 버그 회귀 방지 - 받침 없는 이름이면 '와'가 맞다(마레이**와**). 하드코딩이었으면
  // 두 경우 중 하나는 반드시 틀린다.
  it("받침 없는 이름에는 '와', 있는 이름에는 '과'", () => {
    const noBatchim = { ...duel(2, "even"), away: { team: away, star: "아셈 마레이", pts: 22 } };
    expect(renderToStaticMarkup(<AceDuelSection duel={noBatchim} />)).toContain("<b>이정현</b>과 <b>아셈 마레이</b>가");
    const batchim = { ...duel(9, "home"), home: { team: home, star: "루이스 킹", pts: 24 } };
    expect(renderToStaticMarkup(<AceDuelSection duel={batchim} />)).toContain("<b>샘조세프 벨란겔</b>과의 에이스");
  });

  it("이름은 React가 항상 이스케이프한다(문자열 조립 쪽에선 escHtml()을 잊으면 그대로 새는 자리)", () => {
    const evil = { ...duel(2, "even"), home: { team: home, star: "<img src=x>", pts: 24 } };
    const out = renderToStaticMarkup(<AceDuelSection duel={evil} />);
    expect(out).toContain("&lt;img src=x&gt;");
    expect(out).not.toContain("<img");
  });
});
