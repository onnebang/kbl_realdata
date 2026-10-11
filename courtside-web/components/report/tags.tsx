import type { ReactNode } from "react";
import { teamInkStyle } from "@/lib/teamAccent";
import type { ReportTeamMeta } from "@/lib/report/renderKit";

// 리포트 섹션 컴포넌트들이 공유하는 태그 - lib/report/renderKit.ts의 teamTag()/playerTag()/
// liOpen()과 **같은 마크업**을 내는 JSX 버전이다(섹션을 하나씩 컴포넌트로 옮기는 동안 두
// 구현이 공존하므로, 옮긴 섹션의 렌더 결과가 기존 문자열과 바이트 단위로 같아야 한다 -
// 각 섹션의 *.test.tsx가 고정).
//
// 서버는 테마를 모르므로 --ti-l/--ti-d 두 색을 같이 내려보내고 CSS 미디어쿼리가 고른다
// (lib/teamAccent.ts의 teamInkStyle - 이미 있던 것 재사용).

/** 문장 속 팀 이름 - 칩 없이 색만(팀명 자체가 이미 텍스트 단서다). renderKit의 teamTag(). */
export function TeamInk({ team, children }: { team: ReportTeamMeta; children?: ReactNode }) {
  const isAwayClash = Boolean(team.isClash && team.isAway);
  const teamClass = isAwayClash ? "report-team report-clash-team-away" : "report-team";
  return <b className={teamClass} style={teamInkStyle(team.color)}>{children ?? team.name}</b>;
}

/** 선수 이름 - 약어 칩 + 팀색. 색만으로는 색각 이상·흑백에서 무력해서 약어를 같이 붙인다. */
export function PlayerTag({ team, name }: { team: ReportTeamMeta; name: string }) {
  const isAwayClash = Boolean(team.isClash && team.isAway);
  const abbrClass = isAwayClash ? "report-team-abbr report-clash-away" : "report-team-abbr";
  return (
    <span className="report-team" style={teamInkStyle(team.color)}>
      <span className={abbrClass} title={team.name}>{team.abbr}</span>
      <b className="report-player">{name}</b>
    </span>
  );
}

/**
 * 그 줄의 주체 팀 - **마커만** 팀 색으로. 본문까지 칠하면 문장 전체가 팀 색이 되어 안에 있는
 * 상대 팀 이름과 구분이 사라진다(실측). 그래서 색을 상속시키지 않는 전용 클래스를 쓴다.
 */
export function ReportLi({ team, children }: { team: ReportTeamMeta; children: ReactNode }) {
  const isAwayClash = Boolean(team.isClash && team.isAway);
  const liClass = isAwayClash ? "report-li report-clash-li-away" : "report-li";
  return <li className={liClass} style={teamInkStyle(team.color)}>{children}</li>;
}

