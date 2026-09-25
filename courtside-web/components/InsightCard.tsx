import type { ReactNode } from "react";
import { teamInkStyle } from "@/lib/teamAccent";
import { absenceText } from "@/lib/lineupText";
import { POS_LABEL_KO, type AceEntry, type PreviewInsight } from "@/lib/matchupInsights";

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
  season_ace: "\u{2B50}",
  win_prob: "\u{1F52E}",
};

export function InsightCard({
  insight,
  hColor,
  aColor,
  homeTname,
  awayTname,
  actual,
  lineup,
}: {
  insight: PreviewInsight;
  hColor: string;
  aColor: string;
  homeTname: string;
  awayTname: string;
  actual?: string | null;
  // 12인 엔트리 발표 후 재계산한 홈 승률(예정 경기의 win_prob 카드에만 - 홈 목록 카드와 같은 규칙).
  lineup?: { homeProb: number; absentHome: string[]; absentAway: string[] } | null;
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
      title = `${tname} - ${insight.theirName} 온코트 열세 (${POS_LABEL_KO[insight.pos]})`;
      body = (
        <>
          {insight.reason}
          <br />
          같은 {POS_LABEL_KO[insight.pos]} 자리의 <b>{ourTname}</b> 최다 볼 소유는 {insight.ourTargetName}(usage{" "}
          {insight.ourTargetUsage.toFixed(1)})입니다.
          <br />
          {/* 이 데이터셋에는 온볼 수비 매치업 기록이 없다. 같은 포지션으로 묶어도 두 선수가 실제로
              맞붙은 시간은 880초 vs 882초로 차이가 없었다(25-26 실측) - 그래서 "노릴 만함" 같은
              인과 문장을 쓰지 않고 무엇을 세었는지만 적는다. */}
          <span style={{ opacity: 0.7 }}>
            누가 누구를 막았는지는 이 데이터에 없습니다. 두 숫자를 같은 포지션끼리 나란히 놓은 것뿐입니다.
          </span>
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
          {insight.priorLabel ?? `직전 경기(${insight.gameDate})`} 이 조합이 함께 뛴 동안 {insight.pts}득점 {insight.ast}어시 {insight.reb}리바 합작
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
    case "season_ace": {
      const tname = insight.team === "home" ? homeTname : awayTname;
      borderColor = insight.team === "home" ? hColor : aColor;
      title = `${tname} 시즌 에이스`;
      // watch_player가 "직전 경기 한 판"을 보는 반면 이 카드는 같은 자(게임스코어)를 시즌
      // 전체에 댄 것이다. 둘이 같은 선수를 가리키면 그 자체가 "반짝이 아니다"라는 뜻이 된다.
      const row = (label: string, e: AceEntry | null) =>
        e ? (
          <div className="ace-row" key={label}>
            <span className="ace-tag">{label}</span>
            <b className="ace-name">{e.name}</b>
            {e.isAsianQuota && <span className="ace-aq">아시아쿼터</span>}
            <span className="ace-num">게임스코어 {e.gameScorePg.toFixed(1)}</span>
            <span className="ace-sub">
              {e.gp}경기 · {e.minutes.toLocaleString()}분
            </span>
          </div>
        ) : (
          <div className="ace-row" key={label}>
            <span className="ace-tag">{label}</span>
            {/* 왜 비었는지를 정확히 말한다. 개막 전에 외국선수를 전원 교체한 팀(실측: KT·현대모비스)은
                "기준 미달"이 아니라 "지난 시즌 KBL 기록 자체가 없음"이라, 같은 문구를 쓰면 오해가 된다. */}
            <span className="ace-sub">
              {insight.priorSeasonLabel
                ? `지난 시즌(${insight.priorSeasonLabel}) 기록이 남아 있는 선수가 없습니다(전원 교체).`
                : "15경기 또는 300분을 채운 선수가 아직 없습니다."}
            </span>
          </div>
        );
      body = (
        <>
          {row("국내", insight.domestic)}
          {row("외국", insight.foreign)}
          <div className="ace-note">
            {insight.priorSeasonLabel
              ? `이번 시즌 경기가 아직 없어 지난 시즌(${insight.priorSeasonLabel}) 기준입니다.`
              : "이 경기 직전까지의 시즌 누적 기준입니다."}{" "}
            게임스코어는 득점·리바운드·어시스트·스틸·블록에서 야투 실패와 실책을 뺀 한 줄짜리
            활약도로, 위 &lsquo;주의&rsquo; 카드와 같은 식을 시즌 전체에 적용한 값입니다.
          </div>
        </>
      );
      break;
    }
    case "win_prob": {
      title = "코트사이드 최종 예측";
      // 요청(2026-09-25): 시즌 전체 기준 예측과 12인 엔트리 반영 예측을 나란히, 변동이 있으면 어디서
      // 생겼는지(빠진 핵심 로테이션 선수)까지. 엔트리 미발표면 lineup이 없어 예전 한 줄 그대로.
      const homePct = Math.round(insight.homeProb * 100);
      const lineupPct = lineup ? Math.round(lineup.homeProb * 100) : null;
      const delta = lineupPct != null ? lineupPct - homePct : 0;
      const absent = lineup ? absenceText(homeTname, awayTname, lineup) : "";
      body = (
        <>
          {lineup && <span className="prob-caveat">시즌 기준 · </span>}
          <b className="team-ink" style={teamInkStyle(hColor)}>{homeTname}</b> 승률 {homePct}% · <b className="team-ink" style={teamInkStyle(aColor)}>{awayTname}</b> 승률{" "}
          {Math.round(insight.awayProb * 100)}%
          {lineupPct != null && (
            <>
              <br />
              <span className="prob-caveat">엔트리 반영 · </span>
              <b className="team-ink" style={teamInkStyle(hColor)}>{homeTname}</b> 승률 {lineupPct}% · <b className="team-ink" style={teamInkStyle(aColor)}>{awayTname}</b> 승률{" "}
              {100 - lineupPct}%{" "}
              <span className="prob-caveat">
                ({delta === 0 ? "변동 없음" : `${homeTname} ${delta > 0 ? "+" : "−"}${Math.abs(delta)}%p`})
              </span>
              {absent && <div className="ace-note">12인 엔트리에서 빠진 핵심 로테이션 선수 — {absent}</div>}
            </>
          )}
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
