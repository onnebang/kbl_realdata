"use client";

// 상단 매치업 배너의 스코어. 진행중 경기에서 이 숫자만 서버 렌더 시점에 멈춰 있으면,
// 바로 아래 Act 2의 문자중계는 최신인데 배너는 몇 분 전 스코어를 보여주는 상태가 된다
// (Phase 2가 없애려는 바로 그 "조용히 낡은 화면"). LiveGameProvider가 이미 돌리고 있는
// 단 하나의 전송 계층에서 최신 스코어를 받아 쓴다 - 구독을 새로 만들지 않는다.
//
// 진행중이 아닌 경기에서는 컨텍스트가 항상 OFF(score = null)라 서버 값이 그대로 나온다.

import { useLiveGameContext } from "./LiveGameProvider";

export default function LiveScore({ side, initial }: { side: "home" | "away"; initial: number | null }) {
  const { score } = useLiveGameContext();
  const v = score ? (side === "home" ? score.home : score.away) : null;
  return <span className="matchup-banner-score">{v ?? initial}</span>;
}
