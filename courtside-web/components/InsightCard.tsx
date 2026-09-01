import type { ReactNode } from "react";
import type { PreviewInsight } from "@/lib/matchupInsights";

// 프리뷰 스카우팅 인사이트(요청 항목 1~6) 카드 + 경기 후 채점(항목 7, actual prop) - 기존
// .report-text/.report-list(문자열 HTML을 dangerouslySetInnerHTML로 렌더)와 달리
// lib/matchupInsights.ts가 만드는 건 타입이 있는 구조화 데이터라, 카드마다 종류별로 분기해
// 직접 JSX로 렌더(문자열 조립 없음). 왼쪽 보더를 해당 인사이트가 가리키는 팀의 실제 브랜드
// 컬러로 칠해 어느 팀 얘기인지 한눈에 - 이 페이지 다른 곳(팀 스탯 바 등)과 같은 컨벤션.
const KIND_ICON: Record<PreviewInsight["kind"], string> = {
  watch_player: "\u{1F440}",
  weak_defender: "\u{1F3AF}",
  combo_synergy: "\u{1F91D}",
  trend: "\u{1F4C8}",
  oreb_watch: "\u{1F501}",
  block_watch: "\u{1F9F1}",
  win_prob: "\u{1F52E}",
};

export function InsightCard({
  insight,
  hColor,
  aColor,
  homeTname,
  awayTname,
  actual,
}: {
  insight: PreviewInsight;
  hColor: string;
  aColor: string;
  homeTname: string;
  awayTname: string;
  actual?: string | null;
}) {
  let borderColor = "var(--ink-faint)";
  let title = "";
  let body: ReactNode = null;

  switch (insight.kind) {
    case "watch_player": {
      const tname = insight.team === "home" ? homeTname : awayTname;
      borderColor = insight.team === "home" ? hColor : aColor;
      title = `${tname} - ${insight.name} 주의`;
      body = (
        <>
          {insight.statLine}
          <br />
          {insight.reason}
        </>
      );
      break;
    }
    case "weak_defender": {
      const tname = insight.theirTeam === "home" ? homeTname : awayTname;
      const ourTname = insight.theirTeam === "home" ? awayTname : homeTname;
      borderColor = insight.theirTeam === "home" ? hColor : aColor;
      title = `${tname} - ${insight.theirName} 수비 공략 포인트`;
      body = (
        <>
          {insight.reason}
          <br />→ <b>{ourTname}</b>의 {insight.ourTargetName}(usage {insight.ourTargetUsage.toFixed(1)})가 노릴 만함.
        </>
      );
      break;
    }
    case "combo_synergy": {
      const tname = insight.team === "home" ? homeTname : awayTname;
      borderColor = insight.team === "home" ? hColor : aColor;
      title = `${tname} - ${insight.names.join("+")} 조합`;
      body = (
        <>
          직전 경기({insight.gameDate}) 이 조합이 함께 뛴 동안 {insight.pts}득점 {insight.ast}어시 {insight.reb}리바 합작
          (동반 출전 {Math.round(insight.sharedSeconds / 60)}분).
        </>
      );
      break;
    }
    case "trend": {
      const tname = insight.team === "home" ? homeTname : awayTname;
      borderColor = insight.team === "home" ? hColor : aColor;
      title = `${tname} 최근 추세`;
      body = <>{insight.text}</>;
      break;
    }
    case "oreb_watch": {
      const tname = insight.team === "home" ? homeTname : awayTname;
      borderColor = insight.team === "home" ? hColor : aColor;
      title = `${tname} 오펜스 리바운드 주의`;
      body = <>{insight.reason}</>;
      break;
    }
    case "block_watch": {
      const tname = insight.team === "home" ? homeTname : awayTname;
      borderColor = insight.team === "home" ? hColor : aColor;
      title = `${tname} - ${insight.name} 블록 주의`;
      body = <>{insight.reason}</>;
      break;
    }
    case "win_prob": {
      title = "코트사이드 최종 예측";
      body = (
        <>
          <b style={{ color: hColor }}>{homeTname}</b> 승률 {Math.round(insight.homeProb * 100)}% · <b style={{ color: aColor }}>{awayTname}</b> 승률{" "}
          {Math.round(insight.awayProb * 100)}%
        </>
      );
      break;
    }
  }

  return (
    <div className="insight-card" style={{ borderLeftColor: borderColor }}>
      <span className="insight-card-icon">{KIND_ICON[insight.kind]}</span>
      <div className="insight-card-body">
        <div className="insight-card-title">{title}</div>
        <div className="insight-card-text">{body}</div>
        {actual != null && <div className="insight-grade">실제: {actual}</div>}
      </div>
    </div>
  );
}
