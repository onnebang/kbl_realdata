import { teamInkPair } from "../teamAccent";

// postgameReport.ts(1,500줄)에서 **렌더링 프리미티브만** 떼어낸 모듈. 섹션별 분석 모듈
// (lineupSynergy.ts, shotHotZone.ts, ...)이 팀 색·약어 칩을 쓰려면 이게 필요한데,
// 예전엔 buildPostgameReport() 안의 클로저였어서 밖으로 꺼낼 방법이 없었다.
//
// 의존 방향은 한쪽뿐이다: postgameReport.ts -> report/* (여기서 postgameReport.ts를
// 런타임 import하지 않는다). 그래서 순환 import가 생기지 않고, 이 파일의 타입/함수는
// 하위호환을 위해 postgameReport.ts가 그대로 re-export한다.

/** 리포트가 선수·팀 이름에 색과 약어를 붙이는 데 필요한 최소 정보. */
export type ReportTeamMeta = { tcode: string; name: string; abbr: string; color: string | null };

export type ReportSection = { title: string; html: string };

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
