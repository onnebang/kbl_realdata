import { teamInkPair } from "../teamAccent";
import type { AceDuel } from "./aceDuel";
import type { StockWatch } from "./stockWatch";
import type { UnsungHeroes } from "./unsungHero";

// postgameReport.ts(1,500줄)에서 **렌더링 프리미티브만** 떼어낸 모듈. 섹션별 분석 모듈
// (lineupSynergy.ts, shotHotZone.ts, ...)이 팀 색·약어 칩을 쓰려면 이게 필요한데,
// 예전엔 buildPostgameReport() 안의 클로저였어서 밖으로 꺼낼 방법이 없었다.
//
// 의존 방향은 한쪽뿐이다: postgameReport.ts -> report/* (여기서 postgameReport.ts를
// 런타임 import하지 않는다). 그래서 순환 import가 생기지 않고, 이 파일의 타입/함수는
// 하위호환을 위해 postgameReport.ts가 그대로 re-export한다.

/** 리포트가 선수·팀 이름에 색과 약어를 붙이는 데 필요한 최소 정보. */
export type ReportTeamMeta = { tcode: string; name: string; abbr: string; color: string | null };

/** 문자열 HTML을 만드는 섹션. 아직 옮기지 않은 섹션 전부와 render*Section() 반환값. */
export type HtmlSection = { title: string; html: string };
/** 타입 있는 데이터만 내려보내고 렌더는 컴포넌트가 하는 섹션. */
export type DataSection = { title: string; data: ReportSectionData };

/**
 * 리포트 한 섹션. 지금은 두 형태가 공존한다:
 * - `html`: 원본(courtside_template.html) 그대로의 문자열 조립.
 * - `data`: components/report/*.tsx가 JSX로 렌더하는 구조화 데이터
 *   (lib/matchupInsights.ts + components/InsightCard.tsx가 이미 쓰는 방식과 같다).
 *
 * 섹션 단위로 하나씩 `data`로 옮긴다 - 22개를 한 번에 바꾸면 문장 하나가 조용히 달라져도
 * 알아채기 어렵고, `.report-text b`(금색)/`.report-list b`(--ink)가 `.report-team`을 이기는
 * CSS 특이도(app/globals.css 주석) 때문에 마크업이 한 겹만 달라져도 색이 바뀐다. 그래서
 * 옮긴 섹션은 렌더 결과가 기존 문자열과 바이트 단위로 같은지 테스트로 고정한다
 * (components/report/AceDuelSection.test.tsx).
 */
export type ReportSection = HtmlSection | DataSection;

/** `data` 섹션의 판별 유니온 - 섹션을 옮길 때마다 한 종류씩 늘어난다. 두 종류가 되면서
 *  예고대로 분기가 필요해졌고, components/report/DataSectionBody.tsx가 `kind`로 가른다
 *  (switch가 exhaustive라 세 번째 종류를 추가하면 그 파일에서 타입 에러가 난다). */
export type ReportSectionData = AceDuel | UnsungHeroes | StockWatch;

export const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60),
    s = Math.round(sec % 60);
  return `${m}분${s > 0 ? " " + s + "초" : ""}`;
}

export type ReportTags = {
  /** tcode -> 팀 메타. 홈/원정 어느 쪽도 아니면 null(심판 이벤트 등). */
  metaOf: (tcode: string | null) => ReportTeamMeta | null;
  playerTag: (name: string, tcode: string | null) => string;
  teamTag: (tcode: string | null, text: string) => string;
  liOpen: (tcode: string | null) => string;
};

export function createReportTags(homeTeam: ReportTeamMeta, awayTeam: ReportTeamMeta): ReportTags {
  // ── 팀 색 태그 ──────────────────────────────────────────────────────────────
  // 두 색을 같이 내려보내고 CSS 미디어쿼리가 고른다(서버는 테마를 모른다 - teamAccent.ts 참고).
  const inkVars = (t: ReportTeamMeta) => {
    const ink = teamInkPair(t.color);
    return `--ti-l:${ink.light};--ti-d:${ink.dark}`;
  };
  const metaOf = (tcode: string | null): ReportTeamMeta | null =>
    tcode === homeTeam.tcode ? homeTeam : tcode === awayTeam.tcode ? awayTeam : null;

  /** 선수 이름 - 약어 칩 + 팀색. 색만으로는 색각 이상·흑백에서 무력해서 약어를 같이 붙인다. */
  const playerTag = (name: string, tcode: string | null): string => {
    const t = metaOf(tcode);
    if (!t) return escHtml(name);
    return (
      `<span class="report-team" style="${inkVars(t)}">` +
      `<span class="report-team-abbr" title="${escHtml(t.name)}">${escHtml(t.abbr)}</span>` +
      `<b class="report-player">${escHtml(name)}</b></span>`
    );
  };
  /** 문장 속 팀 이름 - 칩 없이 색만(팀명 자체가 이미 텍스트 단서다). */
  const teamTag = (tcode: string | null, text: string): string => {
    const t = metaOf(tcode);
    return t ? `<b class="report-team" style="${inkVars(t)}">${escHtml(text)}</b>` : escHtml(text);
  };
  /**
   * 그 줄의 주체 팀 - **마커만** 팀 색으로. 본문까지 칠하면 문장 전체가 팀 색이 되어
   * 안에 있는 상대 팀 이름과 구분이 사라진다(실측에서 그렇게 나왔다). 그래서 색을 상속시키지
   * 않는 전용 클래스(.report-li)를 쓴다.
   */
  const liOpen = (tcode: string | null): string => {
    const t = metaOf(tcode);
    return t ? `<li class="report-li" style="${inkVars(t)}">` : "<li>";
  };

  return { metaOf, playerTag, teamTag, liOpen };
}
