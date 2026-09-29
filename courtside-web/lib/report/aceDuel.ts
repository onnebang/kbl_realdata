import type { ReportTeamMeta } from "./renderKit";
// 타입만 가져온다(런타임 import 아님) - postgameReport.ts가 이 모듈을 import하므로 값을
// 가져오면 순환이 된다. lineupSynergy.ts와 같은 규칙.
import type { LineupSegment } from "../postgameReport";

// ---------------------------------------------------------------------------
// 에이스 정면승부 성적표 (Head-to-Head Duel)
//
// 양 팀 에이스가 코트에 동시에 있던 구간만 모아 그 동안의 팀 득점을 비교한다.
//
// 이 모듈은 다른 report/* 섹션과 달리 render* 함수가 없다 - 문장은
// components/report/AceDuelSection.tsx가 JSX로 만든다(리포트를 문자열 조립에서 선언적
// 컴포넌트로 옮기는 첫 섹션. renderKit.ts의 ReportSection 주석 참고).
//
// 주의: 상대 라인업을 통제하지 않은 한 경기 스플릿이라 "에이스가 이겼다"는 인과로 읽으면
// 안 된다(lineupSynergy.ts와 같은 한계).
// ---------------------------------------------------------------------------

/** 두 에이스가 같이 뛴 최소 시간. 이만큼은 돼야 '정면승부'라 부를 수 있다(인라인 상수였던 300 그대로). */
export const DUEL_MIN_SEC = 300;
/** 이 점수 이상 벌어지면 우열이 있었다고 본다. */
export const DUEL_DECISIVE_PTS = 5;

export type AceDuelSide = { team: ReportTeamMeta; star: string; pts: number };

export type AceDuel = {
  kind: "ace_duel";
  /** 두 에이스가 코트에 동시에 있던 시간(초). */
  seconds: number;
  /** 홈 기준 득실차(home.pts - away.pts). */
  margin: number;
  /**
   * 우열 판정. "누가 이겼나"는 분석이라 여기서 정하고(DUEL_DECISIVE_PTS), 컴포넌트는 그걸
   * 어떤 문장으로 읽히게 할지만 고른다.
   */
  verdict: "home" | "away" | "even";
  home: AceDuelSide;
  away: AceDuelSide;
};

/** 동시 출전이 DUEL_MIN_SEC 미만이거나 한쪽 에이스가 없으면 null(섹션을 아예 안 만든다). */
export function computeAceDuel(
  segs: LineupSegment[],
  home: { team: ReportTeamMeta; star: { pcode: string; name: string } | null },
  away: { team: ReportTeamMeta; star: { pcode: string; name: string } | null }
): AceDuel | null {
  if (!home.star || !away.star) return null;
  let seconds = 0;
  let hPts = 0;
  let aPts = 0;
  for (const s of segs) {
    if (s.homeOn.includes(home.star.pcode) && s.awayOn.includes(away.star.pcode)) {
      seconds += s.seconds;
      hPts += s.homePts;
      aPts += s.awayPts;
    }
  }
  if (seconds < DUEL_MIN_SEC) return null;
  const margin = hPts - aPts;
  return {
    kind: "ace_duel",
    seconds,
    margin,
    verdict: margin >= DUEL_DECISIVE_PTS ? "home" : margin <= -DUEL_DECISIVE_PTS ? "away" : "even",
    home: { team: home.team, star: home.star.name, pts: hPts },
    away: { team: away.team, star: away.star.name, pts: aPts },
  };
}
