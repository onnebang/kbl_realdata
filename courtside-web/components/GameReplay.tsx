"use client";
import { PlayerPhoto } from "./PlayerPhoto";
import { teamInkStyle } from "@/lib/teamAccent";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { TeamBadge } from "./TeamBadge";
import { buildCourtDotsSvg, shotValue, COURT_X, COURT_Y, type ShotDotMeta } from "@/lib/zoneCompare";
import {
  attachDerivedFields,
  findShootingStreaks,
  computeStatBursts,
  computeCurrentDroughts,
  fmtRating,
  gameWideTopPerformer,
  QUARTER_ORDER,
  quarterLenSec,
  surgeScoreText,
  fmtSurgeDuration,
  type GameEvent,
  type PlayerBox,
  type StreakEvent,
} from "@/lib/postgameReport";
// lib/useLiveGame이 아니라 여기서 - 그쪽은 Supabase 클라이언트를 만들어서 종료된 경기
// 페이지에도 공개 키를 실어 보낸다.
import { mergeEventRows, type LiveEventRow } from "@/lib/liveEventMerge";
import { useLiveGameContext } from "./LiveGameProvider";
import {
  buildRecentFeed,
  buildShotReliability,
  buildShotToEventIndex,
  drawMiniShotSpot,
  findShotForScoreRow,
  KEY_FLOW_CODES,
  KEY_FLOW_TAGS,
  SCORING_CODES,
  type PossessionItem,
  type ShotWithMeta,
} from "@/lib/possessionFeed";
import { iGa } from "@/lib/josa";
import { currentOnCourt, comboKey, computeFinalPlusMinus, computeSecondsUpTo } from "@/lib/gameLineups";
import type { LineupRating, PlayerOnOff } from "@/lib/lineupNetRating";
import { OnCourtCards } from "./OnCourtCards";
import { buildOnCourtTeam } from "@/lib/onCourtCards";
import type { CourtCardInfo } from "@/lib/courtCardInfo"; // 타입만 - 값을 가져오면 OVR JSON이 브라우저 번들에 들어간다

// "코트사이드" 시그니처 기능(인터랙티브 리플레이/스크럽) 포팅 - courtside_template.html의
// render(idx)/computeBoxScore/renderFeedGroups/renderCourt 등 약 90개 함수 중 핵심 스크럽
// 경험만 먼저(사용자 확인 - "핵심 스크럽 MVP 먼저"). AI 내러티브 8종/핫스트릭 애니메이션/
// 클러치샷 지수 등은 다음 단계로 미룸(이미 이 경기 페이지 하단에 있는 정적
// postgameReport/pregameInsights 패널이 "경기 끝난 뒤 요약"은 커버하고 있음).
const MAKE_CODES = new Set(["201", "205", "207"]);
const MISS_CODES = new Set(["202", "206", "208"]);
// 215(파울자유투)가 빠져 있으면 개인 파울이 실제보다 적게 세어진다 - PF 칸을 추가하면서
// 실측(25-26 최근 40경기 845 선수-경기)으로 확인: 215+216+224면 845/845 전부 game_player_stats.fouls와
// 일치, 216+224만이면 463/845만 일치했다. lib/possessionFeed.ts·lib/postgameReport.ts는 처음부터
// 세 코드를 다 세고 있었고 이 파일만 어긋나 있었다.
const FOUL_CODES = new Set(["215", "216", "224"]);

// 모멘텀 숨은 공신 (Momentum MVP) 계산기: 특정 시간(초) 동안 해당 팀의 득점, 어시스트, 스틸을 합산하여 기여도 1위를 찾는다.
function getSurgeMvp(
  eventsUpToIdx: GameEvent[],
  surgeDurationSec: number,
  tcode: string
): { pcode: string; pts: number; ast: number; stl: number } | null {
  if (eventsUpToIdx.length === 0) return null;
  const endRow = eventsUpToIdx[eventsUpToIdx.length - 1];
  const startElapsed = endRow.elapsed - surgeDurationSec;
  
  const stats = new Map<string, { pts: number; ast: number; stl: number }>();
  for (let i = eventsUpToIdx.length - 1; i >= 0; i--) {
    const e = eventsUpToIdx[i];
    if (e.elapsed < startElapsed) break;
    if (e.tcode === tcode && e.pcode) {
      if (!stats.has(e.pcode)) stats.set(e.pcode, { pts: 0, ast: 0, stl: 0 });
      const s = stats.get(e.pcode)!;
      const lbl = e.action_label || "";
      
      if (lbl.includes("성공")) {
        if (lbl.includes("3점")) s.pts += 3;
        else if (lbl.includes("자유투")) s.pts += 1;
        else s.pts += 2;
      }
      if (lbl.includes("어시스트")) s.ast += 1;
      if (lbl.includes("스틸")) s.stl += 1;
    }
  }

  let mvpPcode: string | null = null;
  let maxImpact = 0;
  for (const [pcode, s] of stats.entries()) {
    const impact = s.pts + s.ast * 2 + s.stl * 2; // Impact formula
    if (impact > maxImpact && impact >= 2) { // Minimum impact to show
      maxImpact = impact;
      mvpPcode = pcode;
    }
  }
  return mvpPcode ? { pcode: mvpPcode, ...stats.get(mvpPcode)! } : null;
}

// 모듈 레벨 상수여야 한다 - 기본값을 `= {}`로 쓰면 렌더마다 새 객체가 되어 아래
// serverEvents/events useMemo가 매 렌더 재계산된다(600~800행 × attachDerivedFields).
const EMPTY_MAP: Record<string, string> = {};

function emptyBoxLine() {
  // oreb/dreb - Game Leaders 카드(REBOUNDS 항목의 "N DREB, M OREB" 서브라인)용으로 209/210을
  // 나눠 셈. reb는 그대로 둘의 합(기존 박스스코어 테이블 REB 컬럼이 이미 이 값을 씀).
  return { pts: 0, fgm: 0, fga: 0, threePM: 0, threePA: 0, ftm: 0, fta: 0, reb: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, to: 0, foul: 0 };
}
type BoxLine = ReturnType<typeof emptyBoxLine>;

// game_events는 shot_id 단위가 아니라 액션코드 로그라서, courtside_template.html의
// computeBoxScore(uptoIdx)와 동일하게 매 스크럽마다 0..idx를 재훑어 박스스코어를 만듦
// (경기당 500~800개뿐이라 클라이언트에서도 비용 무시 가능).
function computeBoxScore(events: GameEvent[], uptoIdx: number, players: PlayerMeta[]): Map<string, BoxLine> {
  const box = new Map<string, BoxLine>();
  for (const p of players) box.set(p.pcode, emptyBoxLine());
  for (let i = 0; i <= uptoIdx; i++) {
    const row = events[i];
    if (!row.pcode) continue;
    const b = box.get(row.pcode);
    if (!b) continue;
    const code = row.action_code;
    if (!code) continue;
    if (MAKE_CODES.has(code)) {
      b.pts += code === "205" ? 3 : 2;
      b.fgm++;
      b.fga++;
      if (code === "205") {
        b.threePM++;
        b.threePA++;
      }
    } else if (MISS_CODES.has(code)) {
      if (code === "206") b.threePA++;
      b.fga++;
    } else if (code === "203") {
      b.pts += 1;
      b.ftm++;
      b.fta++;
    } else if (code === "204") {
      b.fta++;
    } else if (code === "209" || code === "210") {
      b.reb++;
      if (code === "209") b.oreb++;
      else b.dreb++;
    } else if (code === "211") {
      b.ast++;
    } else if (code === "212") {
      b.stl++;
    } else if (code === "213") {
      b.blk++;
    } else if (code === "214") {
      b.to++;
    } else if (FOUL_CODES.has(code)) {
      b.foul++;
    }
  }
  return box;
}

// ── 박스스코어 표 세 장(요청: "득점, 리바, 어시, 스틸, 블락, 턴오버 말고도, 성공률 부터해서
// 복합적인 데이터까지(길어진다면, 표를 여러개 만들어서 항목을 넘기도록)") ────────────────
// 세 장 전부 이벤트 로그만으로 스크럽 시점에서 다시 계산된다 - game_player_stats의 per/pie/
// off_rtg 같은 "경기 최종" 지표는 섞지 않는다(3쿼터인데 최종 PER를 적으면 거짓).
type BoxView = "basic" | "shooting" | "impact";
const BOX_VIEWS: { key: BoxView; label: string; hint: string }[] = [
  { key: "basic", label: "기본", hint: "출전 시간과 기본 스탯" },
  { key: "shooting", label: "슈팅", hint: "구간별 성공/시도와 성공률, eFG%·TS%" },
  { key: "impact", label: "영향", hint: "팀 득점 점유 · USG% · AST/TO" },
];
const BOX_HEADERS: Record<BoxView, string[]> = {
  basic: ["MIN", "PTS", "REB", "OR", "AST", "STL", "BLK", "TO", "PF"],
  shooting: ["MIN", "PTS", "FG", "FG%", "2P", "3P", "3P%", "FT", "FT%", "eFG%", "TS%"],
  impact: ["MIN", "PTS", "팀득점%", "USG%", "AST/TO", "STL+BLK"],
};
/** 세 장 모두 마지막 두 칸은 +/-와 온/오프로 공통(뷰를 넘겨도 비교 기준을 잃지 않게). */
const BOX_TAIL = 2;

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** 성공률 - 시도가 없으면 "-"(0%로 적으면 없는 시도를 실패로 단정하게 된다). */
function rate(made: number, att: number): string {
  return att > 0 ? `${Math.round((made / att) * 100)}%` : "-";
}

function clockStr(e: GameEvent) {
  if (e.quarter === "PRE") return "경기 시작 전";
  return `${e.quarter} ${e.clock_min}:${String(e.clock_sec).padStart(2, "0")}`;
}

// --- 모바일 푸시 알림(courtside_template.html의 pushNotify/checkPushNotifications 포팅) ---
// 순방향 스크럽(재생 또는 "다음" 버튼 - advanceForward)에서만 호출됨. 슬라이더/쿼터버튼
// 점프나 "이전" 버튼은 render만 하고 이 함수를 절대 안 부름 - 스크러버로 아무 데나 점프할
// 때마다 알림이 우수수 쏟아지는 스팸을 막기 위해(레퍼런스 아티팩트가 명시한 이유 그대로).
const BIG_MOMENT_THRESHOLD = 0.12; // 레퍼런스와 동일 기준(0.05 NOTABLE_WPA_THRESHOLD보다 훨씬 큰 스윙만 - 알림은 진짜 큰 순간에만)
const PUSH_RUN_THRESHOLD = 6; // 아래 컴포넌트의 flow-chip RUN_THRESHOLD(6)와 같은 값
const PUSH_DROUGHT_SEC = 180; // 3분 - flow-chip의 DROUGHT_MIN_SEC(90초, "지금 흐름" 표시용)보다 높은 알림 전용 기준
type PushToastSpec = { icon: string; title: string; msg: string };

function computePushNotifications(
  events: GameEvent[],
  prevIdx: number,
  newIdx: number,
  homeTeam: { tcode: string; name: string },
  awayTeam: { tcode: string; name: string }
): PushToastSpec[] {
  const row = events[newIdx];
  const out: PushToastSpec[] = [];

  // 결정적 순간(큰 승률 스윙) - 이 프로젝트가 이미 확립한 "수혜팀 기준" 컨벤션
  // (postgameReport.ts "결정적 장면들"과 동일 - wpa_home 원시 부호를 그대로 안 쓰고
  // 수혜팀 자신의 승률/부호로 통일, 원정팀이 득점해도 숫자가 거꾸로 안 보이게).
  if (row.wpa_home != null && Math.abs(row.wpa_home) >= BIG_MOMENT_THRESHOLD) {
    const beneficiaryIsHome = row.wpa_home > 0;
    const beneficiary = beneficiaryIsHome ? homeTeam.name : awayTeam.name;
    const beneficiaryProb = row.home_win_prob == null ? null : beneficiaryIsHome ? row.home_win_prob : 1 - row.home_win_prob;
    const swingPts = Math.round(Math.abs(row.wpa_home) * 100);
    const clutch = (row.quarter === "Q4" || row.quarter.startsWith("X")) && (row.clock_min ?? 99) < 1;
    out.push({
      icon: clutch ? "🚨" : "⚡",
      title: clutch ? `버저비터! ${row.player_name ?? ""}` : `승부처! ${row.player_name ?? ""}`,
      msg: `${row.action_label ?? ""} - ${beneficiary} 승률 ${beneficiaryProb != null ? Math.round(beneficiaryProb * 100) : "-"}% (+${swingPts}%p)`,
    });
  }

  // 6-0 이상 런 "시작 전환점"에만 - runHome/runAway는 다음 득점 전까지 값이 유지되는데, 그
  // 사이 무득점 이벤트(리바운드/파울 등)에서도 이 함수가 매번 불려서, 이전 idx 값과 비교
  // 안 하면 같은 알림이 계속 중복 발사됨(레퍼런스가 실제로 겪은 버그 - 그대로 재도입 안 함).
  const prevRow = prevIdx >= 0 ? events[prevIdx] : null;

  // 서지(상대가 득점해도 크게 밀리는 구간)가 먼저다 - 같은 순간에 0-런 알림까지 쏘면
  // 같은 사건을 두 번 알리는 꼴이라, 서지가 떴으면 아래 0-런 알림은 건너뛴다.
  const surgeSide = row.surge?.side ?? null;
  if (row.surge && prevRow?.surge?.side !== surgeSide) {
    const t = row.surge.side === "home" ? homeTeam : awayTeam;
    const body =
      row.surge.opp > 0
        ? `${fmtSurgeDuration(row.surge.seconds)} 동안 ${surgeScoreText(row.surge)} - 상대가 넣고 있는데도 점수차가 벌어지는 중입니다.`
        : `${fmtSurgeDuration(row.surge.seconds)} 동안 ${surgeScoreText(row.surge)} - 지금 흐름이 넘어가고 있습니다.`;
    out.push({ icon: "🔥", title: `${t.name} 몰아치기!`, msg: body });
  }
  if (!row.surge && row.runHome >= PUSH_RUN_THRESHOLD && (!prevRow || prevRow.runHome < PUSH_RUN_THRESHOLD)) {
    out.push({ icon: "🔥", title: `${homeTeam.name} 런!`, msg: `상대 무득점 구간에 ${row.runHome}점 연속 - 지금 흐름이 넘어가고 있습니다.` });
  }
  if (!row.surge && row.runAway >= PUSH_RUN_THRESHOLD && (!prevRow || prevRow.runAway < PUSH_RUN_THRESHOLD)) {
    out.push({ icon: "🔥", title: `${awayTeam.name} 런!`, msg: `상대 무득점 구간에 ${row.runAway}점 연속 - 지금 흐름이 넘어가고 있습니다.` });
  }

  // 3분+ 무득점 가뭄 "시작 전환점"에만 - computeCurrentDroughts(eventsUpToIdx)는 이미 이
  // 컴포넌트의 flow-chip이 매 idx마다 재계산해 쓰는 함수(events.slice 비용 무시 가능 -
  // computeBoxScore와 같은 원칙)를 그대로 재사용, prevIdx 시점에도 한 번 더 돌려 전환 여부만 비교.
  const droughtsNow = computeCurrentDroughts(events.slice(0, newIdx + 1));
  const droughtsPrev = prevIdx >= 0 ? computeCurrentDroughts(events.slice(0, prevIdx + 1)) : { homeSec: 0, awaySec: 0 };
  if (droughtsNow.homeSec >= PUSH_DROUGHT_SEC && droughtsPrev.homeSec < PUSH_DROUGHT_SEC) {
    out.push({ icon: "🧊", title: `${homeTeam.name} 침묵`, msg: "3분 넘게 득점이 없습니다." });
  }
  if (droughtsNow.awaySec >= PUSH_DROUGHT_SEC && droughtsPrev.awaySec < PUSH_DROUGHT_SEC) {
    out.push({ icon: "🧊", title: `${awayTeam.name} 침묵`, msg: "3분 넘게 득점이 없습니다." });
  }

  return out;
}

// 쿼터별 점수(요청: "경기 세부는 courtside_template을 참고해서 개발" - 원본
// renderQuarterTable(idx)와 동일한 계산: 각 쿼터 "끝" 시점 누적점수 - 그 전 쿼터 누적점수
// = 그 쿼터에서만 낸 점수. 아직 안 온 쿼터는 null("-"), 현재 진행 중인 쿼터는 live 표시.
type QuarterCell = { v: number; live: boolean } | null;
function computeQuarterScores(
  events: GameEvent[],
  idx: number,
  quarterOrder: string[],
  lastIdxByQuarter: Map<string, number>
): { homeByQ: QuarterCell[]; awayByQ: QuarterCell[] } {
  const curQuarter = events[idx].quarter;
  const curRank = curQuarter === "PRE" ? -1 : quarterOrder.indexOf(curQuarter);
  let prevH = 0,
    prevA = 0;
  const homeByQ: QuarterCell[] = [];
  const awayByQ: QuarterCell[] = [];
  quarterOrder.forEach((q, qi) => {
    if (qi > curRank) {
      homeByQ.push(null);
      awayByQ.push(null);
      return;
    }
    const isCurrent = qi === curRank;
    const endIdx = isCurrent ? idx : lastIdxByQuarter.get(q) ?? idx;
    const h = events[endIdx].home_score,
      a = events[endIdx].away_score;
    homeByQ.push({ v: h - prevH, live: isCurrent });
    awayByQ.push({ v: a - prevA, live: isCurrent });
    prevH = h;
    prevA = a;
  });
  return { homeByQ, awayByQ };
}

// photoUrl/backNum - 새 포제션 피드(아래 playerPhoto)의 선수 사진 카드용. page.tsx가
// game_player_stats 조회에 players.photo_url/back_num을 얹어서 로스터 전체를 한 번에
// 넘겨줌(선수별 추가 조회 없음 - lib/playerProfile.ts의 getPlayerInfo와 같은 필드명).
// minPlayed - 박스스코어 테이블의 DNP 판정용(page.tsx의 replayPlayers가 game_player_stats.
// min_played를 그대로 얹어줌). 실측(Supabase 전체 100,921행) - min_played는 null이 0건,
// 뛰지 않은 선수는 예외 없이 "0.00"으로 채워져 있어서 0(또는 방어적으로 null)이면 DNP.
type PlayerMeta = { pcode: string; name: string; tcode: string; isStarter?: boolean | null; photoUrl?: string | null; backNum?: string | null; minPlayed?: number | null };
type TeamMeta = { tcode: string; name: string; abbr: string; color: string; logoUrl: string | null };
type ShotWithQuarter = ShotWithMeta;

// courtside_template.html의 buildChartStatic()/updateChart(idx)(2508~2545행) 스타일로
// 정밀 대조 - 50% 기준 점선 + 쿼터 경계 세로선 + 곡선 아래 영역 채우기(area fill)를
// 추가(이전엔 빠져 있었음). 스크럽 위치를 따라가는 마커(세로 가이드선+점+% 라벨)는 이
// 컴포넌트만의 인터랙티브 기능이라 그대로 유지.
//
// C. 진행중 경기의 정직한 축(Phase 2). 지금까지의 축은 "유효 이벤트 인덱스를 폭 전체에
// 균등 배치"라서, 2쿼터까지만 진행된 경기도 오른쪽 끝까지 꽉 찬 곡선이 되어 완주한 경기처럼
// 보였다. 진행중일 때만 x축을 "경기 경과 시간"으로 바꾸고 남은 시간은 빈 칸으로 둔다
// (Q3/Q4 격자선까지 미리 그려서 '아직 두 쿼터가 남았다'가 한눈에 보이게) + 곡선의 맨 앞에
// 진행중 마커를 찍는다. 종료 경기는 live=false로 예전 경로를 그대로 타서 픽셀 단위로 동일.
// raw game_events 행(라이브 수신분 **그리고 서버 prop**)을 GameEvent 모양으로.
// 파생 필드(elapsed/runHome/runAway/surge)는 호출부가 채운 뒤 attachDerivedFields가
// 배열 전체에 대해 다시 계산한다.
//
// 왜 서버 prop까지 이 함수를 타는가(페이로드 감사, 2026-09): 서버가 events prop에
// action_label(실측 14,060B)과 player_name(12,855B)을 행마다 문자열로 박아 보내고 있었다.
// 둘 다 같은 페이로드 안에 이미 있는 것으로 복원 가능하다 - 라벨은 action_codes 33행 맵
// (약 800B), 이름은 players prop(replayPlayers)이 그대로 들고 있다. 그래서 서버는 원본
// 행만 보내고 복원은 여기서 한다. 이름 해석 순서(nameByPcode -> names -> lateNames -> null)는
// page.tsx buildGameData의 (nameMap -> fallbackNames -> null)과 같은 순서다:
//   - 종료 경기: nameByPcode = replayPlayers = nameMap, names(liveNames) = {}
//   - 진행중 경기: playerStats가 아직 없어 replayPlayers/nameMap 둘 다 비고 names가 답을 준다
// 즉 어느 경우에도 표시되는 이름은 이전과 글자 단위로 같다.
function toGameEventShape(
  r: LiveEventRow,
  actionLabels: Record<string, string>,
  nameByPcode: Map<string, string>,
  names: Record<string, string>,
  lateNames: Record<string, string>
): Omit<GameEvent, "elapsed" | "runHome" | "runAway" | "surge"> {
  return {
    event_order: r.event_order,
    quarter: r.quarter,
    clock_min: r.clock_min,
    clock_sec: r.clock_sec,
    action_code: r.action_code,
    action_label: r.action_code ? actionLabels[r.action_code] ?? r.action_code : null,
    pcode: r.pcode,
    player_name: r.pcode ? nameByPcode.get(r.pcode) ?? names[r.pcode] ?? lateNames[r.pcode] ?? null : null,
    tcode: r.tcode,
    home_score: r.home_score,
    away_score: r.away_score,
    home_win_prob: r.home_win_prob,
    wpa_home: r.wpa_home,
    objective_prob: r.objective_prob,
  };
}

function plannedTotalSec(lastQuarter: string): number {
  const i = QUARTER_ORDER.indexOf(lastQuarter);
  // 최소 4쿼터, 연장에 들어갔으면 지금 진행 중인 연장 쿼터까지가 "예정된 경기 길이".
  const upto = Math.max(4, i + 1);
  let total = 0;
  for (let k = 0; k < upto && k < QUARTER_ORDER.length; k++) total += quarterLenSec(QUARTER_ORDER[k]);
  return total;
}


// 스크러버 트랙 배경 - 승률 곡선 + 쿼터 경계(요청: "좀더 점수와, 중계흐름이 잘 보이도록").
//
// x축을 반드시 "이벤트 인덱스"로 잡아야 한다. 위 WinProbLiveChart는 진행 중 경기에서 경과
// 시간을 x로 쓰는데(아직 안 치른 시간을 비워 두려고), 그 축을 여기 가져오면 곡선과 슬라이더
// 손잡이가 어긋난다 - 슬라이더의 값은 인덱스이기 때문이다. 두 그림의 목적이 다르므로 축도 다르다.
//
// 곡선 아래(=홈 승률)와 위(=원정)를 팀 색으로 갈라 칠한다. 44px 높이에서도 "지금 어느 쪽으로
// 기울었나"가 숫자 없이 읽힌다. 팀 색을 원색 그대로 쓰면 남색 계열이 다크 표면에 묻히므로
// CSS에서 잉크와 섞는다(.replay-scrub-home/.replay-scrub-away).
// 요청: "점수랑 승률도 부드럽게 올라가도록". 값이 바뀌면 지금 보이는 숫자에서 새 값까지
// ms 동안 세어 올라간다(15→18이면 16·17을 거친다). 재생 중에는 재생 헤드와 같은 speedMs·선형이라
// 다음 틱과 끊김 없이 이어지고, ms=0(스크럽·쿼터 이동)이면 다음 프레임에 바로 새 값이다.
// rAF 콜백 안에서만 setState하므로 effect 본문에서 동기 setState를 부르지 않는다.
function CountUp({ value, ms, decimals = 0 }: { value: number; ms: number; decimals?: number }) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
      const v = from + (value - from) * t;
      shownRef.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  const f = 10 ** decimals;
  return <>{Math.round(shown * f) / f}</>;
}

const SCRUB_W = 1000;
const SCRUB_H = 100;
const SCRUB_MAX_POINTS = 320; // 이벤트 800개짜리 경기도 path 문자열이 짧게 유지된다

function ScrubTrack({
  events,
  idx,
  quarterOrder,
  firstIdxByQuarter,
  playing,
  speedMs,
}: {
  events: GameEvent[];
  idx: number;
  quarterOrder: string[];
  firstIdxByQuarter: Map<string, number>;
  playing: boolean;
  speedMs: number;
}) {
  const n = events.length;
  // 요청: "재생시 바가 툭툭 끊기지 않고 부드럽게 다음 중계로". 재생은 speedMs마다 한 칸씩
  // 전진하므로, 한 칸 전진일 때만 위치를 speedMs 동안 선형으로 흘려 다음 틱과 이어 붙인다.
  // 스크럽·쿼터 이동·처음으로 같은 큰 점프는 즉시 옮긴다(되감기가 미끄러지면 오히려 어색하다).
  const [prevIdx, setPrevIdx] = useState(idx);
  const [glide, setGlide] = useState(false);
  if (prevIdx !== idx) {
    setPrevIdx(idx);
    setGlide(playing && idx - prevIdx === 1);
  }
  const pct = n > 1 ? (idx / (n - 1)) * 100 : 0;
  const motion = { left: `${pct}%`, transitionDuration: glide ? `${speedMs}ms` : "0ms" };
  // 곡선은 idx와 무관하므로 events가 바뀔 때만 다시 만든다(스크럽 한 틱마다 800점 path를
  // 새로 잇지 않기 위해서 - 움직이는 건 아래 마커뿐이다).
  // 면(채움)과 선(경계)을 따로 만든다. 44px 트랙에서 채움만으로는 - 특히 팀 색이 어두우면 -
  // 곡선의 모양이 안 읽혔다(실측: 부산 KCC 남색). 밝은 경계선 하나가 채움보다 훨씬 크게 읽힌다.
  const { areaPath, linePath } = useMemo(() => {
    if (n < 2) return { areaPath: null, linePath: null };
    const step = Math.max(1, Math.floor(n / SCRUB_MAX_POINTS));
    const pts: string[] = [];
    let last: number | null = null;
    for (let i = 0; i < n; i += step) {
      const p = events[i].home_win_prob;
      if (p != null) last = p;
      if (last == null) continue;
      const x = (i / (n - 1)) * SCRUB_W;
      pts.push(`${x.toFixed(1)} ${((1 - last) * SCRUB_H).toFixed(1)}`);
    }
    if (last == null || pts.length < 2) return { areaPath: null, linePath: null };
    // 마지막 점은 항상 오른쪽 끝까지(step 때문에 끝이 잘리면 트랙에 빈 칸이 생긴다).
    pts.push(`${SCRUB_W} ${((1 - last) * SCRUB_H).toFixed(1)}`);
    const line = `M ${pts.join(" L ")}`;
    return { areaPath: `${line} L ${SCRUB_W} ${SCRUB_H} L 0 ${SCRUB_H} Z`, linePath: line };
  }, [events, n]);

  return (
    <>
    <svg className="replay-scrub-svg" viewBox={`0 0 ${SCRUB_W} ${SCRUB_H}`} preserveAspectRatio="none" aria-hidden="true">
      {/* 위쪽 = 원정 몫. 곡선이 아래를 덮으면 남는 부분이 그대로 원정 승률이 된다. */}
      <rect x={0} y={0} width={SCRUB_W} height={SCRUB_H} className="replay-scrub-away" />
      {areaPath && <path d={areaPath} className="replay-scrub-home" />}
      {linePath && <path d={linePath} className="replay-scrub-line" vectorEffect="non-scaling-stroke" />}
      <line
        x1={0}
        y1={SCRUB_H / 2}
        x2={SCRUB_W}
        y2={SCRUB_H / 2}
        className="replay-scrub-mid"
        vectorEffect="non-scaling-stroke"
      />
      {quarterOrder.map((q) => {
        const first = firstIdxByQuarter.get(q);
        if (first == null || first <= 0 || n < 2) return null;
        const x = (first / (n - 1)) * SCRUB_W;
        return <line key={q} x1={x} y1={0} x2={x} y2={SCRUB_H} className="replay-scrub-qline" vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
    {/* SVG 속성(x1/x2)은 CSS로 전환할 수 없어서 재생 위치는 HTML로 그린다 - 아직 안 온
        구간을 흐리게 덮는 막 + 재생 헤드. 둘이 같은 left로 함께 흐른다. */}
    <div className="replay-scrub-future" style={motion} aria-hidden="true" />
    <div className="replay-scrub-head" style={motion} aria-hidden="true" />
    </>
  );
}

function WinProbLiveChart({ events, idx, homeColor, live }: { events: GameEvent[]; idx: number; homeColor: string; live: boolean }) {
  const valid = events.map((e, i) => ({ e, i })).filter((r) => r.e.home_win_prob != null);
  if (!valid.length) return <div className="empty-note">승률 데이터 없음</div>;
  const W = 640,
    H = 150;
  const n = valid.length;

  // 진행중 - 경과 시간(attachDerivedFields가 이미 채워둔 elapsed, PRE는 0)을 x로. 시계
  // 데이터가 튀는 경우를 대비해 단조 증가로 눌러준다(뒤로 가는 곡선 방지).
  const totalSec = live ? plannedTotalSec(events[events.length - 1].quarter) : 0;
  const elapsedOf: number[] = [];
  if (live) {
    let run = 0;
    for (const r of valid) {
      run = Math.max(run, Math.min(totalSec, r.e.elapsed));
      elapsedOf.push(run);
    }
  }
  const xOf = live ? (vi: number) => (elapsedOf[vi] / Math.max(1, totalSec)) * W : (vi: number) => (vi / Math.max(1, n - 1)) * W;
  const yOf = (p: number) => (1 - p) * H;
  const points = valid.map((r, vi) => [xOf(vi), yOf(r.e.home_win_prob as number)] as const);
  const linePath = "M " + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ");
  const areaPath = `${linePath} L ${points[points.length - 1][0].toFixed(1)} ${H} L 0 ${H} Z`;

  // 격자선: 종료 경기는 예전대로 "그 쿼터 첫 이벤트 위치", 진행중은 아직 시작도 안 한
  // 쿼터까지 포함한 고정 시간 경계.
  const quarterBounds: { x: number; q: string }[] = [];
  if (live) {
    let acc = 0;
    for (let k = 0; k < QUARTER_ORDER.length; k++) {
      if (acc >= totalSec) break;
      quarterBounds.push({ x: (acc / totalSec) * W, q: QUARTER_ORDER[k] });
      acc += quarterLenSec(QUARTER_ORDER[k]);
    }
  } else {
    let lastQ: string | null = null;
    valid.forEach((r, vi) => {
      if (r.e.quarter !== "PRE" && r.e.quarter !== lastQ) {
        quarterBounds.push({ x: xOf(vi), q: r.e.quarter });
        lastQ = r.e.quarter;
      }
    });
  }

  let markerVi = 0;
  for (let vi = 0; vi < valid.length; vi++) {
    if (valid[vi].i <= idx) markerVi = vi;
    else break;
  }
  const marker = valid[markerVi];
  const mx = xOf(markerVi);
  const my = yOf(marker.e.home_win_prob as number);
  const midY = H / 2;
  // 곡선의 맨 앞(= 지금까지 들어온 마지막 이벤트) - 스크럽 마커와 별개.
  const leadX = xOf(valid.length - 1);
  const leadY = yOf(valid[valid.length - 1].e.home_win_prob as number);

  // 요청: "wpLbl 텍스트가 너무 크다 - 주변과 어울리게". 예전엔 라벨을 SVG <text>로 그려서 글자
  // 크기가 뷰박스 단위(26~32)였고, 화면 폭에 따라 배율이 달라져 데스크톱에선 26px로 본문(13px)의
  // 두 배가 됐다. 라벨과 점은 HTML로 올려 실제 px로 고정하고(본문 서체 Pretendard, 라벨 단 13px),
  // 선·면만 SVG에 남긴다. SVG는 preserveAspectRatio="none"으로 지면 폭을 꽉 채우고, 선 굵기는
  // non-scaling-stroke로 지킨다 - 늘어나도 원이 타원이 되지 않게 점은 HTML이다.
  const pct = (x: number, span: number) => `${(x / span) * 100}%`;
  // 승률 라벨: 점 위에 자리가 있으면 위, 아니면 아래(진행중 라벨이 위쪽 띠를 쓴다).
  // 위쪽 45% 안이면 위로 올릴 자리가 없다(라벨 높이+간격 ~27px가 150/120px 차트의 윗 띠와 겹침).
  const pctAbove = my >= H * 0.45;
  const probPct = Math.round((marker.e.home_win_prob as number) * 100);

  return (
    <div className="wp-chart team-ink" style={teamInkStyle(homeColor)}>
      <svg className="wp-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {live && leadX < W - 0.5 && (
          // 아직 안 치른 시간 - 곡선이 없는 영역임을 명시적으로 칠해서 "여기까지가 전부"라는
          // 오독을 막는다.
          <rect x={leadX} y={0} width={W - leadX} height={H} fill="var(--ink-faint)" opacity={0.07} />
        )}
        <line x1={0} y1={midY} x2={W} y2={midY} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="3,4" vectorEffect="non-scaling-stroke" />
        {quarterBounds.map((b) => (
          <line key={b.q} x1={b.x} y1={0} x2={b.x} y2={H} stroke="var(--ink-faint)" strokeWidth={1} opacity={0.35} vectorEffect="non-scaling-stroke" />
        ))}
        <path d={areaPath} fill="currentColor" fillOpacity={0.12} />
        <path d={linePath} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <line x1={mx} y1={0} x2={mx} y2={H} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="2,3" vectorEffect="non-scaling-stroke" />
      </svg>
      {live && (
        <>
          <span className="wp-dot wp-dot-live" style={{ left: pct(leadX, W), top: pct(leadY, H) }} />
          <span className={`wp-lbl wp-lbl-live${leadX > W * 0.85 ? " end" : ""}`} style={{ left: pct(leadX, W) }}>
            진행중
          </span>
        </>
      )}
      <span className="wp-dot" style={{ left: pct(mx, W), top: pct(my, H) }} />
      <span
        className={`wp-lbl wp-lbl-prob${pctAbove ? " above" : " below"}`}
        style={{ left: `clamp(22px, ${pct(mx, W)}, calc(100% - 22px))`, top: pct(my, H) }}
      >
        {probPct}%
      </span>
    </div>
  );
}

export default function GameReplay({
  events: serverEventRows,
  players,
  homeTeam,
  awayTeam,
  shots,
  homeNetRating,
  awayNetRating,
  lineupRatings,
  playerOnOff,
  live = false,
  actionLabels = EMPTY_MAP,
  liveNames,
  cardInfo,
}: {
  // 파생 필드(elapsed/runHome/runAway/surge = 실측 34,382B)와 action_label/player_name까지
  // 뺀 **원본 game_events 행 그대로**. 전부 이 컴포넌트가 복원한다 - toGameEventShape 주석과
  // 아래 serverEvents useMemo 참고. LiveEventRow가 곧 그 원본 모양이라 타입을 그대로 쓴다
  // (page.tsx의 EventRow와 필드가 일치).
  events: LiveEventRow[];
  players: PlayerMeta[];
  homeTeam: TeamMeta;
  awayTeam: TeamMeta;
  shots: ShotWithQuarter[];
  // 요청: "왜 해당승률이 나오는지" 설명(넷레이팅 차이로 이유 문장 조립) - page.tsx가 이미
  // getSeasonStatsAsOf로 불러오는 시즌 스탯에서 ppg-oppPpg만 뽑아서 넘김(새 쿼리 불필요).
  homeNetRating?: number | null;
  awayNetRating?: number | null;
  // 요청: "현재 라인업 1~5인 조합과 넷레이팅" - page.tsx가 이 경기에서 실제로 나온 조합만
  // 미리 Supabase lineup_combo에서 조회해 넘김(combo_key -> rating, 서버 1회 조회).
  lineupRatings?: Record<string, LineupRating>;
  // 요청: "코트 위 패널에 온/오프 넷레이팅" - lineupRatings와 같은 이유로 스크럽 위치와
  // 무관한 정적 값이라 page.tsx가 player_onoff를 서버에서 한 번만 조회해 넘김.
  playerOnOff?: Record<string, PlayerOnOff>;
  // Phase 2 - 진행중(deriveGameStatus === "live")일 때만 true. false면 이 컴포넌트는
  // 예전과 완전히 동일하게 동작한다(구독/폴링 없음, 라벨/차트도 그대로).
  live?: boolean;
  // action_code -> 라벨 맵(action_codes 33행). 예전엔 라이브 경기에만 내려보내고 종료
  // 경기는 행마다 action_label 문자열을 박아 보냈는데, 33행 맵(약 800B)이 14,060B보다
  // 압도적으로 싸서 이제 **항상** 내려받는다. 없으면 코드 자체를 라벨로 쓰는 폴백은 그대로.
  actionLabels?: Record<string, string>;
  // 진행중 경기 전용 pcode -> 이름 폴백. 경기가 끝나기 전엔 game_player_stats가 없어서
  // players prop(=박스스코어 기반)이 통째로 비고, 그때만 이 맵이 이름을 준다. 종료 경기는
  // players prop이 같은 이름을 이미 들고 있어 서버가 아예 안 보낸다(undefined).
  // 경기 도중 처음 투입되는 선수 이름만 useLiveGame이 따로 채운다(lateNames).
  liveNames?: Record<string, string>;
  // "코트 위" 선수 카드(OnCourtCards)의 OVR·플레이 스타일 - page.tsx가 서버에서 lib/courtCardInfo.ts로 뽑아 내려준다
  // (OVR JSON이 커서 클라이언트에서 직접 읽지 않는다). 없으면 카드는 OVR 없이 그려진다.
  cardInfo?: Record<string, CourtCardInfo>;
}) {
  // ---- B-1. events = 서버 prop ∪ 라이브 수신 행 --------------------------------
  // 로컬 state가 아니라 파생값(useMemo)으로 둔 것이 이 구현의 핵심 선택이다. state로 두면
  // "prop이 새로 오면 seed"와 "라이브 행이 오면 append" 두 동기화 경로가 생기고, 그 사이에
  // 도착한 행이 router.refresh() 한 번에 사라지는 종류의 버그가 실제로 난다. 파생값이면
  // 서버 prop은 언제나 기준선이고(리마운트/refresh 시 자동으로 소스 오브 트루스), 라이브
  // 행은 그 위에 event_order 기준으로 덮인다 - 순서 상관없이 결과가 같다.
  // 병합은 realtime/폴링과 완전히 같은 mergeEventRows 하나를 쓴다.
  const liveCtx = useLiveGameContext();
  const liveRows = liveCtx.rows;
  // 아래 serverEvents 복원이 이름 맵을 필요로 해서 원래 있던 자리(박스스코어 섹션)에서
  // 여기로 올렸다. 값/의존성은 그대로 - 위치만 이동.
  const nameByPcode = useMemo(() => new Map(players.map((p) => [p.pcode, p.name])), [players]);
  // 서버가 보낸 원본 행 -> 예전 events prop과 값이 동일한 GameEvent[]. attachDerivedFields는
  // 라이브 병합 경로가 이미 쓰던 바로 그 함수라 클라이언트 번들이 커지지 않는다(이미 import됨).
  // 서버는 AI 리포트를 위해 파생값을 그대로 계산한다 - 여기서 뺀 건 "전송"뿐이다.
  const serverEvents = useMemo(
    () => attachDerivedFields(serverEventRows.map((r) => toGameEventShape(r, actionLabels, nameByPcode, liveNames ?? EMPTY_MAP, liveCtx.lateNames))),
    [serverEventRows, actionLabels, nameByPcode, liveNames, liveCtx.lateNames]
  );
  const events = useMemo(() => {
    if (!live || liveRows.length === 0) return serverEvents;
    const byOrder = new Map(serverEvents.map((e) => [e.event_order, e]));
    const incoming: GameEvent[] = liveRows.map((r) => {
      const cur = byOrder.get(r.event_order);
      return {
        ...toGameEventShape(r, actionLabels, nameByPcode, liveNames ?? EMPTY_MAP, liveCtx.lateNames),
        // 파생 필드는 아래 attachDerivedFields가 어차피 전부 다시 계산한다. 다만 기존 행과
        // "값이 같은지" 비교할 때 이것들 때문에 매번 달라 보이면 무의미한 재계산이 나므로
        // 기존 값을 그대로 실어 보낸다(mergeEventRows가 참조 동일성을 유지할 수 있게).
        elapsed: cur?.elapsed ?? 0,
        runHome: cur?.runHome ?? 0,
        runAway: cur?.runAway ?? 0,
        surge: cur?.surge ?? null,
      };
    });
    const merged = mergeEventRows(serverEvents, incoming);
    return merged === serverEvents ? serverEvents : attachDerivedFields(merged);
  }, [live, liveRows, serverEvents, actionLabels, nameByPcode, liveNames, liveCtx.lateNames]);

  // ---- B-2. 팔로우 라이브 / 이탈 ------------------------------------------------
  // pinnedIdx === null 이 곧 "최신 이벤트에 붙어 있음(팔로우 중)". 사용자가 뒤로 스크럽하면
  // 그 인덱스가 핀으로 박히고, 새 이벤트가 들어와도 절대 앞으로 끌려가지 않는다.
  // idx를 state로 두고 새 이벤트마다 setIdx로 밀어 올리는 대신 이렇게 파생시킨 이유는,
  // "따라가는 중"이라는 상태를 별도 불리언으로 또 관리하다가 둘이 어긋나는 걸 막기 위해서다.
  const [pinnedIdx, setPinnedIdx] = useState<number | null>(null);
  const lastIdx = events.length - 1;
  const idx = pinnedIdx == null ? lastIdx : Math.min(pinnedIdx, lastIdx);
  const following = pinnedIdx == null;
  const setIdx = useCallback(
    (next: number | ((cur: number) => number)) => {
      setPinnedIdx((cur) => {
        const curIdx = cur == null ? lastIdx : Math.min(cur, lastIdx);
        const v = typeof next === "function" ? next(curIdx) : next;
        const clamped = Math.max(0, Math.min(lastIdx, v));
        // 맨 끝으로 이동 = 라이브에 다시 붙는다(⏭/슬라이더를 끝까지 미는 경우 포함).
        return clamped >= lastIdx ? null : clamped;
      });
    },
    [lastIdx]
  );
  const [playing, setPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState(300);
  // 요청: "슛 차트와 슛 차트가 중복" - 독립 슛차트 패널(성공/실패, 2점/3점 필터)을 없애고
  // 여기 흡수시키면서 그 필터 기능도 같이 옮김(로컬 state - 이 컴포넌트는 이미 client
  // component라 서버 쿼리 파라미터 방식일 필요 없음).
  const [shotOutcome, setShotOutcome] = useState<"all" | "make" | "miss">("all");
  const [shotVal, setShotVal] = useState<"all" | "2" | "3">("all");

  // 요청: "실시간 순방향 재생 중에만 푸시 알림" - pushNotify/checkPushNotifications 포팅
  // (레퍼런스 courtside_template.html). 최대 3개 스택, ~4.7초 후 자동 제거(CSS 페이드아웃
  // 애니메이션 4.2s+0.4s와 맞춤 - 아래 globals.css .replay-push-toast).
  const [toasts, setToasts] = useState<(PushToastSpec & { id: number })[]>([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((spec: PushToastSpec) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => {
      const next = [...prev, { ...spec, id }];
      return next.length > 3 ? next.slice(next.length - 3) : next;
    });
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4700);
  }, []);

  // 순방향 한 칸 전진 - 재생 타이머와 "다음"(▶) 버튼 딱 두 곳만 이걸 호출함(아래).
  // 슬라이더/쿼터버튼/"이전" 버튼은 setIdx를 직접 불러 이 경로를 거치지 않으므로
  // computePushNotifications가 절대 안 불림 - "순방향 자동재생 중에만 알림" 요구사항의
  // 실제 구현 지점은 여기 하나뿐.
  //
  // idxRef - advanceForward가 클로저로 캡처한 idx 대신 이 ref를 읽고 직접 갱신함. 리렌더를
  // 기다리지 않고 자기 자신을 즉시 최신 상태로 만들어서, 리렌더가 끼어들 틈 없이 "다음"
  // 버튼이 연타되거나(테스트로 실측 - 동기 루프에서 클릭을 여러 번 몰아치면 리렌더 전이라
  // 클로저의 idx가 그대로라 매번 "처음 idx+1"로만 계산됨) 재생 타이머 콜백이 겹치는
  // 경우에도 항상 직전 호출이 만든 값에서 이어서 전진 - 아래 useEffect가 idx가 바뀔 때마다
  // (스크럽 등 다른 경로로 바뀐 경우 포함) ref를 동기화해줌.
  const idxRef = useRef(idx);
  useEffect(() => {
    idxRef.current = idx;
  }, [idx]);
  const advanceForward = useCallback(() => {
    const cur = idxRef.current;
    const next = Math.min(events.length - 1, cur + 1);
    if (next === cur) return;
    idxRef.current = next;
    for (const spec of computePushNotifications(events, cur, next, homeTeam, awayTeam)) pushToast(spec);
    setIdx(next);
    // 재생 타이머가 마지막 이벤트에 도달하면 여기서 바로 멈춤(끝에 다다른 idx로의 setIdx와
    // 같은 tick) - 아래 useEffect 본문에서 동기적으로 setPlaying을 부르면
    // react-hooks/set-state-in-effect 린트 에러가 나서, 그 대신 idx를 실제로 옮기는 이
    // 지점(setTimeout 콜백/버튼 클릭 - 둘 다 effect 본문 밖)에서 처리.
    if (next >= events.length - 1) setPlaying(false);
  }, [events, homeTeam, awayTeam, pushToast, setIdx]);

  useEffect(() => {
    if (!playing || idx >= events.length - 1) return;
    const t = setTimeout(() => advanceForward(), speedMs);
    return () => clearTimeout(t);
  }, [playing, idx, events.length, speedMs, advanceForward]);

  // ---- B-3. 라이브 전진 시 알림(버스트 상한 포함) --------------------------------
  // 요구사항: realtime으로 밀려온 전진도 재생 버튼과 "같은 느낌"이어야 하고, 50개짜리
  // 따라잡기 폭탄이 알림 스팸이 되면 안 된다.
  //  - 한 번에 10개 이하로 들어오면(= 실제 중계 속도) 각 단계마다 computePushNotifications를
  //    돌려 재생 버튼과 완전히 동일한 알림을 만들고, 화면 스택 상한(3)에 맞춰 마지막 3개만 띄운다.
  //  - 10개를 넘으면(탭을 오래 비워뒀다가 돌아온 경우 등) 개별 알림은 전부 버리고
  //    "N개를 한 번에 반영했다 + 현재 스코어" 요약 하나만 띄운다. 지나간 순간을 실제로는
  //    못 본 사용자에게 "승부처!"를 10개 쏘는 건 정직하지도, 유용하지도 않다.
  //
  // 코얼레싱이 핵심이다: Supabase Realtime은 한 번에 들어온 50개 행도 웹소켓 메시지 50개로
  // 쪼개 보낸다. 메시지마다 알림을 계산하면 "한 번에 50개"가 아니라 "1개씩 50번"이 되어
  // 위 상한이 무력화된다. 그래서 이벤트가 늘어날 때마다 타이머를 다시 걸고(디바운스),
  // 그동안 쌓인 구간의 시작점(pendingFromRef)은 유지한다 - 조용해진 뒤 한 번만, 버스트
  // 전체 구간을 대상으로 계산한다. 실제 중계 속도(플레이당 수십 초)에서는 400ms 지연이
  // 체감되지 않고, 따라잡기 폭탄에서는 요약 하나로 접힌다.
  const LIVE_TOAST_MAX_SPAN = 10;
  const LIVE_TOAST_DEBOUNCE_MS = 400;
  const TOAST_STACK_MAX = 3;
  const seenLenRef = useRef(events.length);
  const pendingFromRef = useRef<number | null>(null);
  const followingRef = useRef(following);
  useEffect(() => {
    followingRef.current = following;
  }, [following]);

  // 디바운스 타이머는 effect의 cleanup이 아니라 ref가 소유한다. 이게 실제로 물린 버그다
  // (2026-09-02 드라이런에서 관측): 타이머를 `return () => clearTimeout(t)`로 정리하면,
  // "이벤트가 안 늘어난 리렌더"가 한 번만 끼어들어도 React가 먼저 이전 cleanup을 돌려
  // 타이머를 죽이는데, 그 리렌더 경로는 조기 return이라 타이머를 다시 걸지 않는다 -
  // 결과적으로 알림이 영영 안 뜬다. 그리고 그 리렌더는 드물기는커녕 버스트 때마다 온다:
  // useLiveGame이 새로 등장한 pcode 이름을 채우려고 players를 조회한 뒤 lateNames를
  // 갱신하면(라이브 교체 투입 = 버스트마다 발생) events 배열의 "길이는 그대로, 참조만
  // 새로" 바뀌기 때문. 그래서 타이머는 언마운트 때만 정리한다.
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 타이머 콜백이 걸릴 때의 렌더에 갇히지 않도록 최신 스냅샷을 따로 들고 간다.
  const latestRef = useRef({ events, homeTeam, awayTeam });
  useEffect(() => {
    latestRef.current = { events, homeTeam, awayTeam };
  }, [events, homeTeam, awayTeam]);
  useEffect(() => () => { if (burstTimerRef.current) clearTimeout(burstTimerRef.current); }, []);

  useEffect(() => {
    const prevLen = seenLenRef.current;
    if (events.length <= prevLen) {
      seenLenRef.current = events.length;
      return;
    }
    const from = prevLen - 1;
    seenLenRef.current = events.length;
    if (!live || !followingRef.current || from < 0) return;
    if (pendingFromRef.current == null) pendingFromRef.current = from;
    // effect 본문에서 동기적으로 상태를 바꾸지 않는다(이 파일이 이미 겪은
    // react-hooks/set-state-in-effect 제약과 같은 이유) - 새 스코어가 먼저 그려지고
    // 그다음에 알림이 뜨는 순서가 중계 감각에도 더 맞다.
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    burstTimerRef.current = setTimeout(() => {
      burstTimerRef.current = null;
      const burstFrom = pendingFromRef.current;
      pendingFromRef.current = null;
      // 버스트 도중 사용자가 뒤로 스크럽했으면(이탈) 조용히 버린다 - 본 적도 없는 장면의
      // "승부처!"를 띄우지 않는다.
      if (burstFrom == null || !followingRef.current) return;
      const cur = latestRef.current;
      const to = cur.events.length - 1;
      const span = to - burstFrom;
      if (span <= 0) return;
      if (span > LIVE_TOAST_MAX_SPAN) {
        const row = cur.events[to];
        pushToast({
          icon: "⏩",
          title: "라이브 따라잡기",
          msg: `새 플레이 ${span}개를 한 번에 반영했습니다 · 현재 ${row.home_score}-${row.away_score}`,
        });
        return;
      }
      const specs: PushToastSpec[] = [];
      for (let i = burstFrom; i < to; i++) specs.push(...computePushNotifications(cur.events, i, i + 1, cur.homeTeam, cur.awayTeam));
      for (const spec of specs.slice(-TOAST_STACK_MAX)) pushToast(spec);
    }, LIVE_TOAST_DEBOUNCE_MS);
  }, [events, live, pushToast]);

  /** 박스스코어 표 세 장 중 지금 보고 있는 것. */
  const [boxView, setBoxView] = useState<BoxView>("basic");
  // 요청: "상단 점수판과 하단의 재생바를 상단쪽에 합치되". 예전엔 상단 바(스코어보드를
  // 지나쳤을 때만)와 하단 바(리플레이 패널이 화면 어디든 걸쳐 있으면)가 서로 다른 조건으로
  // 따로 떠 있었다. 하나로 합친 뒤에는 더 넓은 쪽(아래 panelRef 기반 조건)을 그대로 쓴다 -
  // 좁은 조건을 썼다면 사용자가 아직 메인 스코어보드를 보고 있는 동안 재생 버튼에 손이 안
  // 닿는 퇴보가 생긴다. 문서 흐름 밖의 position:fixed + transform(translateY)+"show"
  // 클래스로만 등장/퇴장(문서 레이아웃/스크롤 높이에 영향 없음 - 위쪽 주석의 sticky 버그 회피
  // 구조 유지).
  /** 합쳐진 고정 바 노출 - 리플레이 패널이 화면에 걸쳐 있는 동안만. */
  const [transportVisible, setTransportVisible] = useState(false);
  /* 요청: "ESPN에는 없는 재생 버튼을 어떻게" - 평소엔 스파크라인+재생 버튼만 보이는 컨트롤
     줄로 접어 두고, 탭하면 큰 그래프+Q1~4·배속·이전/다음 버튼이 아래로 펼쳐진다(음악 앱
     미니플레이어와 같은 패턴). */
  const [transportExpanded, setTransportExpanded] = useState(false);
  useEffect(() => {
    const update = () => {
      const el = panelRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // 위/아래로 조금 여유를 둬서, 패널 경계에 딱 걸릴 때 바가 깜빡이지 않게.
      setTransportVisible(r.top < window.innerHeight - 80 && r.bottom > 160);
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  // Feature("AI 코트사이드 리포트/슛 차트에서 특정 순간을 클릭하면 리플레이가 그 시점으로
  // 이동") - lib/postgameReport.ts가 dangerouslySetInnerHTML로 박아 넣는 report-jump-link
  // 앵커와, 아래 슛 차트 SVG(dangerouslySetInnerHTML)의 data-jump-idx 원(circle) 둘 다 순수
  // 문자열/raw DOM이라 React 이벤트 핸들러를 못 붙임 - 이 idx 상태를 쥐고 있는 이
  // 컴포넌트가 document 레벨 클릭 위임(delegation)으로 한 곳에서 처리(두 기능이 같은
  // data-jump-idx 컨벤션을 공유하므로 리스너도 하나만).
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function handleJumpClick(e: MouseEvent) {
      const target = e.target as Element | null;
      const link = target?.closest?.("[data-jump-idx]");
      if (!link) return;
      const raw = link.getAttribute("data-jump-idx");
      const jumpIdx = raw == null ? NaN : Number(raw);
      if (!Number.isFinite(jumpIdx)) return;
      e.preventDefault();
      setPlaying(false);
      setIdx(Math.max(0, Math.min(events.length - 1, jumpIdx)));
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    document.addEventListener("click", handleJumpClick);
    return () => document.removeEventListener("click", handleJumpClick);
  }, [events.length, setIdx]);

  const quarterOrder = useMemo(() => {
    const seen: string[] = [];
    for (const e of events) if (e.quarter !== "PRE" && !seen.includes(e.quarter)) seen.push(e.quarter);
    return seen;
  }, [events]);
  const lastIdxByQuarter = useMemo(() => {
    const m = new Map<string, number>();
    events.forEach((e, i) => {
      if (e.quarter !== "PRE") m.set(e.quarter, i);
    });
    return m;
  }, [events]);
  // 요청: "쿼터를 누르면 쿼터 시작이 아니라 쿼터 끝으로 이동함" - 원인은 lastIdxByQuarter
  // (computeQuarterScores용으로 만든 "그 쿼터 마지막 인덱스" 맵)를 쿼터 버튼 클릭 핸들러가
  // 그대로 재사용하고 있었기 때문. "쿼터 시작으로 이동"엔 별도의 첫 인덱스 맵이 필요해서 추가.
  const firstIdxByQuarter = useMemo(() => {
    const m = new Map<string, number>();
    events.forEach((e, i) => {
      if (e.quarter !== "PRE" && !m.has(e.quarter)) m.set(e.quarter, i);
    });
    return m;
  }, [events]);
  const quarterRank = useMemo(() => new Map(quarterOrder.map((q, i) => [q, i])), [quarterOrder]);

  const row = events[idx];
  const box = useMemo(() => computeBoxScore(events, idx, players), [events, idx, players]);
  const { homeByQ, awayByQ } = useMemo(
    () => computeQuarterScores(events, idx, quarterOrder, lastIdxByQuarter),
    [events, idx, quarterOrder, lastIdxByQuarter]
  );
  const homePlayers = players.filter((p) => p.tcode === homeTeam.tcode);
  const awayPlayers = players.filter((p) => p.tcode === awayTeam.tcode);

  // 요청: "연속 성공(핫핸드), 연속실패(콜드핸드), 팀 전체 무득점 기간, 20-6 런 등등" - 전부
  // "지금 스크럽 시점 기준"이라 events.slice(0, idx+1)을 매번 다시 훑음(lib/postgameReport.ts의
  // findShootingStreaks/computeStatBursts/computeCurrentDroughts 재사용 - 경기당 최대
  // 800개뿐이라 스크럽마다 재계산해도 비용 무시 가능, computeBoxScore와 같은 원칙).
  // 최근 3분 안에 있었던 것만 "지금 흐름"으로 보여줌(전체 경기 이력이 아니라).
  const RECENT_WINDOW_SEC = 180;
  const RUN_THRESHOLD = 6; // lib/postgameReport.ts의 checkOpponentRunAfterFoulTrouble과 같은 기준
  const DROUGHT_MIN_SEC = 90;
  const eventsUpToIdx = useMemo(() => events.slice(0, idx + 1), [events, idx]);
  const liveStreaks = useMemo(
    () => findShootingStreaks(eventsUpToIdx).filter((s) => row.elapsed - s.row.elapsed <= RECENT_WINDOW_SEC),
    [eventsUpToIdx, row.elapsed]
  );
  const liveBursts = useMemo(
    () => computeStatBursts(eventsUpToIdx).filter((b) => row.elapsed - b.endRow.elapsed <= RECENT_WINDOW_SEC),
    [eventsUpToIdx, row.elapsed]
  );
  const droughts = useMemo(() => computeCurrentDroughts(eventsUpToIdx), [eventsUpToIdx]);
  const flowChips: { key: string; text: string }[] = [];
  for (const s of liveStreaks) {
    const name = nameByPcode.get(s.pcode) ?? s.pcode;
    flowChips.push({
      key: `streak-${s.pcode}-${s.idx}`,
      text: s.len > 0 ? `🔥 ${name} ${s.len}연속 성공` : `🧊 ${name} ${Math.abs(s.len)}연속 실패`,
    });
  }
  for (const b of liveBursts) {
    const name = nameByPcode.get(b.key) ?? b.key;
    flowChips.push({ key: `burst-${b.key}-${b.startIdx}`, text: `${name} ${b.label} ${b.count}개 몰아침` });
  }
  if (droughts.homeSec >= DROUGHT_MIN_SEC) {
    flowChips.push({ key: "drought-home", text: `${homeTeam.abbr} ${Math.floor(droughts.homeSec / 60)}분 ${droughts.homeSec % 60}초 무득점` });
  }
  if (droughts.awaySec >= DROUGHT_MIN_SEC) {
    flowChips.push({ key: "drought-away", text: `${awayTeam.abbr} ${Math.floor(droughts.awaySec / 60)}분 ${droughts.awaySec % 60}초 무득점` });
  }
  if (row.surge) {
    const t = row.surge.side === "home" ? homeTeam : awayTeam;
    let mvpStr = "";
    const mvp = getSurgeMvp(eventsUpToIdx, row.surge.seconds, t.tcode);
    if (mvp) {
      const parts = [];
      if (mvp.pts > 0) parts.push(`${mvp.pts}득점`);
      if (mvp.ast > 0) parts.push(`${mvp.ast}어시스트`);
      if (mvp.stl > 0) parts.push(`${mvp.stl}스틸`);
      const name = nameByPcode.get(mvp.pcode) ?? mvp.pcode;
      if (parts.length > 0) {
        mvpStr = ` - 이 구간 핵심: ${name} ${parts.join(" ")}`;
      }
    }
    flowChips.push({
      key: `surge-${row.surge.side}`,
      text: `🔥 ${t.abbr} ${surgeScoreText(row.surge)} 몰아치기 (${fmtSurgeDuration(row.surge.seconds)})${mvpStr}`,
    });
  } else {
    if (row.runHome >= RUN_THRESHOLD) flowChips.push({ key: "run-home", text: `🔥 ${homeTeam.abbr} ${row.runHome}-0 런` });
    if (row.runAway >= RUN_THRESHOLD) flowChips.push({ key: "run-away", text: `🔥 ${awayTeam.abbr} ${row.runAway}-0 런` });
  }

  // 1. 쿼터 파울트러블, 팀파울이 걸렸을때 좀더 표시 (요청 1번)
  let homeTeamFouls = 0;
  let awayTeamFouls = 0;
  for (let i = idx; i >= 0; i--) {
    const e = events[i];
    if (e.quarter !== row.quarter) break;
    if (e.action_code && FOUL_CODES.has(e.action_code)) {
      if (e.tcode === homeTeam.tcode) homeTeamFouls++;
      else if (e.tcode === awayTeam.tcode) awayTeamFouls++;
    }
  }
  if (homeTeamFouls >= 5) flowChips.push({ key: "team-foul-home", text: `🚨 ${homeTeam.abbr} 팀파울 (현재 쿼터)` });
  if (awayTeamFouls >= 5) flowChips.push({ key: "team-foul-away", text: `🚨 ${awayTeam.abbr} 팀파울 (현재 쿼터)` });

  for (const p of players) {
    const b = box.get(p.pcode);
    if (!b) continue;
    if (b.foul > 0) {
      const isEarly = row.quarter === "Q1" || row.quarter === "Q2";
      if ((isEarly && b.foul >= 3) || b.foul >= 4) {
        flowChips.push({ key: `foul-trouble-${p.pcode}`, text: `⚠️ ${p.name ?? p.pcode} 파울트러블 (${b.foul}반칙)` });
      }
    }

    // 2, 3. 기록 및 밀스톤 (더블-더블, 득점 점유율)
    const stats = [b.pts, b.reb, b.ast, b.stl, b.blk];
    const doubleDigits = stats.filter((v) => v >= 10).length;
    if (doubleDigits >= 3) {
      flowChips.push({ key: `triple-double-${p.pcode}`, text: `🌟 ${p.name ?? p.pcode} 트리플-더블 달성!` });
    } else if (doubleDigits === 2) {
      flowChips.push({ key: `double-double-${p.pcode}`, text: `✨ ${p.name ?? p.pcode} 더블-더블 달성!` });
    }

    const tPts = p.tcode === homeTeam.tcode ? row.home_score : row.away_score;
    if (tPts >= 20 && b.pts >= tPts * 0.4) {
      const pct = Math.round((b.pts / tPts) * 100);
      flowChips.push({ key: `score-carry-${p.pcode}`, text: `🔥 ${p.name ?? p.pcode} 팀 득점의 ${pct}%(${b.pts}점) 책임지는 중` });
    }
  }


  // 요청: "현 시점 game leaders를 보여줌" - 위 box(computeBoxScore, 이미 as-of-idx로
  // 계산됨)에서 팀별 최고 득점/리바운드/어시스트만 뽑음.
  const leaderOf = (tcode: string, stat: "pts" | "reb" | "ast") => {
    let best: { p: PlayerMeta; v: number } | null = null;
    for (const p of players) {
      if (p.tcode !== tcode) continue;
      const v = box.get(p.pcode)?.[stat] ?? 0;
      if (!best || v > best.v) best = { p, v };
    }
    return best;
  };
  // sub - 레퍼런스 renderGameLeaders(courtside_template.html 3358~3380행)의 카테고리별
  // 서브라인 그대로: POINTS는 슈팅 스플릿, REBOUNDS는 위에서 새로 나눈 oreb/dreb, ASSISTS는
  // 턴오버(어시스트-턴오버 비율을 가늠하는 보조 지표로 같이 보여줌).
  const LEADER_STATS = [
    { key: "pts", label: "POINTS", sub: (b: BoxLine) => `${b.fgm}/${b.fga} FG, ${b.ftm}/${b.fta} FT` },
    { key: "reb", label: "REBOUNDS", sub: (b: BoxLine) => `${b.dreb} DREB, ${b.oreb} OREB` },
    { key: "ast", label: "ASSISTS", sub: (b: BoxLine) => `${b.to} TO` },
  ] as const;
  // leaderBlock(레퍼런스의 leaderBlock/leaderPhotoHtml 포팅) - 위 playerPhoto 헬퍼(사진 있으면
  // img, 없으면 등번호/이니셜 폴백 div)를 그대로 재사용해서 사진 렌더링 로직을 중복시키지 않음.
  const leaderBlock = (best: { p: PlayerMeta; v: number } | null, side: "home" | "away", color: string, sub: (b: BoxLine) => string) => (
    <div className={`replay-leaders-player ${side}`}>
      {playerPhoto(best?.p.pcode ?? null, "replay-leaders-photo")}
      <div className="replay-leaders-info">
        <div className={best ? "replay-leaders-val team-ink" : "replay-leaders-val"} style={best ? teamInkStyle(color) : undefined}>
          {best ? best.v : "-"}
        </div>
        {best && (
          <>
            <div className="replay-leaders-name">
              {best.p.name}
              {best.p.backNum ? ` #${best.p.backNum}` : ""}
            </div>
            <div className="replay-leaders-sub">{sub(box.get(best.p.pcode) ?? emptyBoxLine())}</div>
          </>
        )}
      </div>
    </div>
  );

  // 요청: "현재 라인업 1인, 2인, 3인, 4인, 5인 조합과 넷레이팅을 보여줌" - 지금 스크럽
  // 시점의 온코트 5인을 교체(101 IN/102 OUT) 이벤트로 재구성(lib/gameLineups.ts, 시작
  // 라인업은 is_starter 기준)한 뒤, page.tsx가 미리 조회해둔 lineupRatings에서 그 5인 및
  // 부분조합의 통산 넷레이팅을 찾음(스크럽 중 네트워크 호출 없음).
  const homeOnCourt = useMemo(() => currentOnCourt(events, idx, players, homeTeam.tcode), [events, idx, players, homeTeam.tcode]);
  const awayOnCourt = useMemo(() => currentOnCourt(events, idx, players, awayTeam.tcode), [events, idx, players, awayTeam.tcode]);
  const ratingLookup = (pcodes: string[]) => (lineupRatings ?? {})[comboKey(pcodes)];
  function bestComboBySize(lineup: Set<string>, size: number): { pcodes: string[]; rating: LineupRating } | null {
    const arr = Array.from(lineup);
    if (arr.length < size) return null;
    let best: { pcodes: string[]; rating: LineupRating } | null = null;
    const combos = (pool: string[], n: number): string[][] => {
      if (n === 0) return [[]];
      if (pool.length < n) return [];
      const [first, ...rest] = pool;
      return [...combos(rest, n - 1).map((c) => [first, ...c]), ...combos(rest, n)];
    };
    for (const combo of combos(arr, size)) {
      const rating = ratingLookup(combo);
      if (rating && (!best || rating.netRatingPer40 > best.rating.netRatingPer40)) best = { pcodes: combo, rating };
    }
    return best;
  }
  const lineupLine = (team: TeamMeta, onCourt: Set<string>) => {
    const five = bestComboBySize(onCourt, 5);
    const best3 = bestComboBySize(onCourt, 3);
    const best2 = bestComboBySize(onCourt, 2);
    const nameOf = (pcode: string) => nameByPcode.get(pcode) ?? pcode;
    return (
      <div className="replay-lineup-col" key={team.tcode}>
        <div className="replay-lineup-team team-ink" style={teamInkStyle(team.color)}>
          {team.name}
        </div>
        {five ? (
          <div className="replay-lineup-line">
            현재 5인 라인업 통산 넷레이팅: <b>{fmtRating(five.rating.netRatingPer40)}</b>{" "}
            <span className="replay-lineup-sample">
              ({five.rating.minutes}분, {five.rating.stints}스틴트)
            </span>
          </div>
        ) : (
          <div className="replay-lineup-line replay-lineup-empty">현재 5인 라인업: 표본 부족(15시즌 중 충분히 함께 뛴 적 없음)</div>
        )}
        {best3 && (
          <div className="replay-lineup-line">
            최고 3인 조합: {best3.pcodes.map(nameOf).join(" + ")} (<b>{fmtRating(best3.rating.netRatingPer40)}</b>)
          </div>
        )}
        {best2 && (
          <div className="replay-lineup-line">
            최고 2인 조합: {best2.pcodes.map(nameOf).join(" + ")} (<b>{fmtRating(best2.rating.netRatingPer40)}</b>)
          </div>
        )}
      </div>
    );
  };

  // 요청: "왜 해당승률이 나오는지, 예상대로라면 그 흐름을 보여주고, 예상이 깨졌다면 이유를
  // 표기" - objective_prob(점수·시간만 반영한 naive 확률, GameEvent에 있지만 지금까지 이
  // 코드베이스 어디서도 안 쓰였음)와 home_win_prob(시즌 전력까지 반영한 실제 모델 예측)의
  // 격차가 곧 "왜 다른지"의 답. 격차 방향과 시즌 넷레이팅 우위 방향이 일치할 때만 이유
  // 문장을 붙임(안 맞으면 억지로 끼워맞추지 않고 숫자만 보여줌).
  const objProb = row.objective_prob;
  const actProb = row.home_win_prob;
  let winExplainText: string | null = null;
  if (objProb != null && actProb != null && homeNetRating != null && awayNetRating != null) {
    const delta = actProb - objProb;
    const netDiff = homeNetRating - awayNetRating;
    if (Math.abs(delta) >= 0.03 && Math.sign(delta) === Math.sign(netDiff)) {
      const favored = delta > 0 ? homeTeam.name : awayTeam.name;
      const favoredNetDiff = delta > 0 ? netDiff : -netDiff;
      winExplainText = `${favored}${iGa(favored)} 시즌 전체 데이터 기준 강세로 평가돼(넷레이팅 차이 ${favoredNetDiff > 0 ? "+" : ""}${favoredNetDiff.toFixed(1)}) 승률이 점수·시간만 봤을 때보다 ${Math.round(Math.abs(delta) * 100)}%p 높게 조정됨.`;
    }
  }

  const curQRank = row.quarter === "PRE" ? -1 : quarterRank.get(row.quarter) ?? 0;
  const filteredShots = useMemo(
    () =>
      shots.filter((s) => {
        if ((quarterRank.get(s.quarter) ?? 0) > curQRank) return false;
        if (shotOutcome === "make" && !s.made) return false;
        if (shotOutcome === "miss" && s.made) return false;
        if (shotVal !== "all" && shotValue(s.x, s.y, s.d) !== Number(shotVal)) return false;
        return true;
      }),
    [shots, curQRank, quarterRank, shotOutcome, shotVal]
  );
  // (선수,쿼터) 조합별 신뢰도 - 경기 전체를 대상으로 하는 정적 결과라 스크럽 위치(idx)와
  // 무관, shots/events가 바뀔 때만 다시 계산. findShotForScoreRow(포제션 카드, 아래)와
  // shotToEventIdx(슛 차트 클릭, 바로 다음)가 이 하나의 계산을 공유(같은 신뢰도 게이트
  // 중복 금지 - 두 방향 모두 findShotForScoreRow/buildShotToEventIndex 쪽에서 온 원칙).
  const shotReliability = useMemo(() => buildShotReliability(events, shots), [events, shots]);

  // 실제 슛 점 차트(app/games/[gmkey]/page.tsx와 같은 lib/zoneCompare.ts의
  // buildCourtDotsSvg) - 스크럽할수록 점이 하나씩 채워지는 느낌을 그대로 살림.
  const homeQuarterShots = useMemo(() => filteredShots.filter((s) => s.tcode === homeTeam.tcode), [filteredShots, homeTeam.tcode]);
  const awayQuarterShots = useMemo(() => filteredShots.filter((s) => s.tcode === awayTeam.tcode), [filteredShots, awayTeam.tcode]);

  // Feature("슛 차트 호버로 누가/언제, 클릭하면 그 순간으로 이동") - lib/possessionFeed.ts의
  // buildShotToEventIndex(findShotForScoreRow의 반대 방향, 같은 shotReliability 게이트
  // 재사용)로 신뢰 가능한 (선수,쿼터) 조합의 슛만 정확한 game_events 인덱스를 앎. 이 맵은
  // 스크럽 위치(idx)와 무관 - shots/events가 바뀔 때만 재계산.
  const shotToEventIdx = useMemo(() => buildShotToEventIndex(events, shots, shotReliability), [events, shots, shotReliability]);
  const shotDotMeta = useCallback(
    (s: ShotWithQuarter): ShotDotMeta => {
      const name = (s.pcode && nameByPcode.get(s.pcode)) || "선수 불명";
      const exactIdx = shotToEventIdx.get(s);
      if (exactIdx != null) {
        return { title: `${name} · ${clockStr(events[exactIdx])}`, jumpIdx: exactIdx };
      }
      // 정확한 이벤트 매칭이 안 되는 조합(신뢰도 게이트 탈락)은 정확한 시각을 지어내지
      // 않고 쿼터만 보여줌 - 클릭은 그 쿼터 "시작"으로만 이동(항상 100% 정확 - 요청의
      // "honest" 폴백). 쿼터 시작 인덱스조차 없으면(사실상 없음) 클릭 불가.
      const fallbackIdx = firstIdxByQuarter.get(s.quarter) ?? null;
      return {
        title: fallbackIdx != null ? `${name} · ${s.quarter} (정확한 시점 불명 - 클릭 시 쿼터 시작으로 이동)` : `${name} · ${s.quarter}`,
        jumpIdx: fallbackIdx,
      };
    },
    [nameByPcode, shotToEventIdx, events, firstIdxByQuarter]
  );
  const homeDotsSvg = homeQuarterShots.length > 0 ? buildCourtDotsSvg(homeQuarterShots, homeTeam.color, shotDotMeta) : null;
  const awayDotsSvg = awayQuarterShots.length > 0 ? buildCourtDotsSvg(awayQuarterShots, awayTeam.color, shotDotMeta) : null;

  // 요청: "실시간 중계에서 팀별로 묶어서 보여주고, 누가 어시를 했는지, 승률이 어떻게
  // 변화됐는지 표시" - "한 공격(포제션)" 단위로 이벤트를 묶어(스틸-어시-득점처럼) 시간
  // 순서 그대로 한 줄 피드로(레퍼런스 아티팩트 courtside_template.html의
  // segmentPossessions/renderGroup 포팅 - lib/possessionFeed.ts). 예전엔 팀별 2열로 나눠
  // 단순 인접(i+1) 어시스트 감지만 하던 M6 구현을 완전히 대체 - 포제션 단위 그룹핑이
  // "두경민 3점 실패 - 공격리바운드 - 유기상 3점" 같은 실제 흐름을 훨씬 잘 보여줌.
  const recentFeed = useMemo(() => buildRecentFeed(events, idx), [events, idx]);
  const playerByPcode = useMemo(() => new Map(players.map((p) => [p.pcode, p])), [players]);

  // 박스스코어 +/- 컬럼 - game_player_stats엔 plus_minus 컬럼이 없어서 game_events 전체를
  // 훑어 직접 계산(lib/gameLineups.ts의 computeFinalPlusMinus, currentOnCourt와 같은 IN=101/
  // OUT=102 온코트 추적 재사용). 경기 최종 값 하나만 필요(레퍼런스 박스스코어도 스크럽
  // 위치와 무관한 고정 +/-)라 events 전체로 한 번만(useMemo) 계산 - idx 의존성 없음.
  const finalPlusMinus = useMemo(
    () => computeFinalPlusMinus(events, players, homeTeam.tcode, awayTeam.tcode),
    [events, players, homeTeam.tcode, awayTeam.tcode]
  );

  // C. ⭐ 배지 문구 - 진행중이면 "최고 활약"이 확정된 게 아니라 지금까지의 1등이다. 계산
  // (아래 topPcode)은 손대지 않고 표현만 바꾼다.
  const topBadgeTitle = live ? "현재 최고 활약" : "이 경기 최고 활약";

  // ⭐ 배지("이 경기 최고 활약")용 - 항상 경기 최종 박스스코어 기준(스크럽 위치와 무관,
  // lib/postgameReport.ts의 gameWideTopPerformer를 그대로 재사용 - 블로아웃 가드까지 포함).
  const finalBox = useMemo(() => computeBoxScore(events, events.length - 1, players), [events, players]);
  const topPcode = useMemo(() => {
    const finalRow = events[events.length - 1];
    const asPlayerBox: PlayerBox[] = players.map((p) => {
      const b = finalBox.get(p.pcode) ?? emptyBoxLine();
      return {
        pcode: p.pcode,
        tcode: p.tcode,
        name: p.name,
        is_starter: p.isStarter ?? null,
        pts: b.pts,
        fgm: b.fgm,
        fga: b.fga,
        ftm: b.ftm,
        fta: b.fta,
        reb: b.reb,
        ast: b.ast,
        stl: b.stl,
        blk: b.blk,
        fouls: b.foul,
        turnovers: b.to,
      };
    });
    return gameWideTopPerformer(asPlayerBox, finalRow.home_score, finalRow.away_score, homeTeam.tcode, awayTeam.tcode)?.pcode ?? null;
  }, [finalBox, players, events, homeTeam.tcode, awayTeam.tcode]);

  // "코트 위" 패널(요청 - 지금 스크럽 시점 온코트 5인 + 벤치, 레퍼런스 courtside_template.html의
  // renderCourt/playerRowHtml 이식). 온코트 판정은 위 homeOnCourt/awayOnCourt(currentOnCourt)를
  // 그대로 재사용 - 별도 추적 로직을 새로 만들지 않음. 스트릭 배지도 위 flowChips가 이미 쓰는
  // liveStreaks(findShootingStreaks, 최근 3분 이내 임계값 교차 이벤트)를 그대로 재사용 - 같은
  // 선수가 최근 3분 안에 여러 번 교차했으면 마지막(가장 최근) 것만 배지에 반영.
  //
  // 요청: "replay-court와 replay-cols(선수 기록 박스스코어)의 내용이 겹치니 합쳐서 replay-court만
  // 나오도록" - 아래 예전 박스스코어(PTS/REB/AST/STL/BLK/TO/FG/3P/FT/+-, DNP 처리)를 여기
  // 흡수해서 온/오프 컬럼까지 더한 표로 만들고, 그룹 기준은 그대로 온코트(라이브)/벤치 유지
  // (예전 박스스코어의 선발/벤치 기준과는 다름 - 지금 코트에 있는지가 이 패널의 정체성이라
  // 그 기준을 살림). isDnp/jerseyNum/plusMinusCell은 예전 boxTable이 쓰던 것 그대로 재사용.
  const streakByPcode = useMemo(() => {
    const m = new Map<string, StreakEvent>();
    for (const s of liveStreaks) m.set(s.pcode, s);
    return m;
  }, [liveStreaks]);

  // 스크럽 시점까지의 출전 시간(초). 교체 이벤트로 재구성 - 실측상 경기 종료 시점 값이
  // game_player_stats.min_played와 소수점까지 일치한다(lib/gameLineups.ts 주석 참고).
  const liveSec = useMemo(
    () => computeSecondsUpTo(events, idx, players, homeTeam.tcode, awayTeam.tcode),
    [events, idx, players, homeTeam.tcode, awayTeam.tcode]
  );
  // "코트 위" 선수 카드 재료 - 아래 표와 같은 homeOnCourt/awayOnCourt·box·liveSec를 그대로 재사용한다(새 이벤트 스캔 없음).
  const courtCardTeams = useMemo(
    () => [
      buildOnCourtTeam(homeTeam, players, homeOnCourt, box, liveSec, cardInfo, topPcode),
      buildOnCourtTeam(awayTeam, players, awayOnCourt, box, liveSec, cardInfo, topPcode),
    ],
    [homeTeam, awayTeam, players, homeOnCourt, awayOnCourt, box, liveSec, cardInfo, topPcode]
  );
  // 팀별 스크럽 시점 합계 - '팀 득점 점유'와 USG%의 분모.
  const teamTotals = useMemo(() => {
    const acc = new Map<string, { pts: number; fga: number; fta: number; to: number }>();
    for (const p of players) {
      const b = box.get(p.pcode);
      if (!b) continue;
      const cur = acc.get(p.tcode) ?? { pts: 0, fga: 0, fta: 0, to: 0 };
      cur.pts += b.pts;
      cur.fga += b.fga;
      cur.fta += b.fta;
      cur.to += b.to;
      acc.set(p.tcode, cur);
    }
    return acc;
  }, [box, players]);
  const elapsedMin = (row.quarter === "PRE" ? 0 : row.elapsed) / 60;
  // 공식 DNP = min_played가 정확히 0(game_player_stats 10만 1천 행 중 null 0건, 0이 12,854건).
  // minPlayed == null은 "공식 출전시간을 아직 모름"이다 - 진행중/정산 전 경기의 폴백 목록(page.tsx
  // replayPlayers, 이벤트에 등장한 선수만)이 이 값을 null로 넘기는데, 예전처럼 null도 DNP로 치면
  // 라이브 중 전원이 "DNP - 감독 결정"으로 뜨고 스탯이 하나도 안 보인다(2026-09-25 발견). 출전시간
  // 자체는 아래 liveSec(교체 이벤트로 재구성, 실측 오차 0.00분)가 따로 계산한다.
  // 진행중에는 min_played가 공식 값이 아니다 - live_collector가 12인 엔트리를 0분으로 미리 넣어 두기 때문에
  // (seed_game_player_stats) 그대로 믿으면 코트 위 선수까지 전원 DNP가 된다. 진행중 출전은 liveSec가 정한다.
  const isDnp = (p: PlayerMeta) => !live && p.minPlayed != null && Number(p.minPlayed) === 0;
  const jerseyNum = (p: PlayerMeta) => (p.backNum ? <span className="replay-jersey-num">#{p.backNum}</span> : null);
  const plusMinusCell = (p: PlayerMeta) => {
    const pm = finalPlusMinus.get(p.pcode) ?? 0;
    return <td className={pm > 0 ? "replay-pm pos" : pm < 0 ? "replay-pm neg" : "replay-pm"}>{pm > 0 ? `+${pm}` : pm}</td>;
  };
  // 점수·승률 숫자가 세어 올라가는 시간 - 재생 중엔 재생 헤드와 같은 speedMs(다음 틱과 이어짐),
  // 라이브를 따라가는 중이면 새 플레이가 들어올 때 짧게, 수동 스크럽·쿼터 이동은 즉시.
  const countMs = playing ? speedMs : live && following ? 400 : 0;
  const homePct = row.home_win_prob != null ? row.home_win_prob * 100 : null;

  const COURT_COLS = 1 + BOX_HEADERS[boxView].length + BOX_TAIL; // 선수 + 뷰별 칸 + (+/-, 온/오프)
  const courtHeaderRow = (key: string) => (
    <tr key={key}>
      <th>선수</th>
      {BOX_HEADERS[boxView].map((h) => (
        <th key={h}>{h}</th>
      ))}
      {/* C. 진행중 경기에서는 이 +/-가 "최종"이 아니라 "지금까지"다 - 계산은 그대로 두고
          라벨만 정직하게(종료 경기는 예전과 글자 하나까지 동일). */}
      <th title={live ? "지금 이 시점까지의 득실 마진" : "경기 최종 득실 마진"}>{live ? "+/- (현재까지)" : "+/-"}</th>
      <th>온/오프</th>
    </tr>
  );
  const onCourtRow = (p: PlayerMeta, isOnCourt: boolean) => {
    const streak = streakByPcode.get(p.pcode);
    const onoff = playerOnOff?.[p.pcode];
    const isTop = p.pcode === topPcode;
    // 표본 부족(player_onoff에 이 pcode 행 자체가 없음) - 위 M7 라인업 넷레이팅의
    // "표본 부족" 폴백과 같은 취지로 "-" 표시.
    const onoffCls = onoff == null ? "" : onoff.netRatingPer40 > 0 ? "pos" : onoff.netRatingPer40 < 0 ? "neg" : "";
    const nameCell = (
      <span className="replay-court-pname">
        {jerseyNum(p)}
        <Link href={`/players/${p.pcode}`} className="replay-court-pname-text">
          {p.name}
        </Link>
        {streak && (
          <span className="replay-court-streak" title={`${Math.abs(streak.len)}연속 ${streak.len > 0 ? "성공" : "실패"}`}>
            {streak.len > 0 ? "🔥" : "🧊"}×{Math.abs(streak.len)}
          </span>
        )}
        {isTop && (
          <span className="replay-court-mvp" title={topBadgeTitle}>
            ⭐
          </span>
        )}
      </span>
    );
    if (isDnp(p)) {
      return (
        <tr className={`replay-court-row ${isOnCourt ? "on-court" : "bench"}`} key={p.pcode}>
          <td>{nameCell}</td>
          <td colSpan={COURT_COLS - 1} className="replay-dnp-label">
            DNP - 감독 결정
          </td>
        </tr>
      );
    }
    const b = box.get(p.pcode) ?? emptyBoxLine();
    const sec = liveSec.get(p.pcode) ?? 0;
    const min = sec / 60;
    // 2점은 전체 FG에서 3점을 뺀 값(computeBoxScore의 fga/fgm은 3점을 포함한다 -
    // game_player_stats의 fga/fgm이 2점만 세는 것과 규칙이 다르니 주의).
    const twoM = b.fgm - b.threePM;
    const twoA = b.fga - b.threePA;
    const tsAtt = b.fga + 0.44 * b.fta;
    const tm = teamTotals.get(p.tcode);
    const tmUse = tm ? tm.fga + 0.44 * tm.fta + tm.to : 0;
    const use = b.fga + 0.44 * b.fta + b.to;
    // USG% 표준식: 100 × (선수 포제션 사용 × 팀 출전분/5) ÷ (선수 출전분 × 팀 포제션 사용).
    // 팀 출전분/5 = 경과 시간이라 스크럽 어느 지점에서도 그대로 성립한다.
    const usg = min > 0 && tmUse > 0 && elapsedMin > 0 ? (100 * use * elapsedMin) / (min * tmUse) : null;
    const share = tm && tm.pts > 0 ? (b.pts / tm.pts) * 100 : null;
    const cells: (string | number)[] =
      boxView === "basic"
        ? [mmss(sec), b.pts, b.reb, b.oreb, b.ast, b.stl, b.blk, b.to, b.foul]
        : boxView === "shooting"
          ? [
              mmss(sec),
              b.pts,
              `${b.fgm}/${b.fga}`,
              rate(b.fgm, b.fga),
              `${twoM}/${twoA}`,
              `${b.threePM}/${b.threePA}`,
              rate(b.threePM, b.threePA),
              `${b.ftm}/${b.fta}`,
              rate(b.ftm, b.fta),
              b.fga > 0 ? `${Math.round(((b.fgm + 0.5 * b.threePM) / b.fga) * 100)}%` : "-",
              tsAtt > 0 ? `${Math.round((b.pts / (2 * tsAtt)) * 100)}%` : "-",
            ]
          : [
              mmss(sec),
              b.pts,
              share != null ? `${Math.round(share)}%` : "-",
              usg != null ? `${usg.toFixed(1)}%` : "-",
              b.to > 0 ? (b.ast / b.to).toFixed(1) : b.ast > 0 ? "∞" : "-",
              b.stl + b.blk,
            ];
    return (
      <tr className={`replay-court-row ${isOnCourt ? "on-court" : "bench"}${isTop ? " top" : ""}`} key={p.pcode}>
        <td>{nameCell}</td>
        {cells.map((c, i) => (
          <td key={i}>{c}</td>
        ))}
        {plusMinusCell(p)}
        <td className={`replay-court-onoff ${onoffCls}`}>{onoff ? fmtRating(onoff.netRatingPer40) : "-"}</td>
      </tr>
    );
  };
  const byLivePts = (a: PlayerMeta, b: PlayerMeta) => (box.get(b.pcode)?.pts ?? 0) - (box.get(a.pcode)?.pts ?? 0);
  const onCourtColumn = (team: TeamMeta, roster: PlayerMeta[], onCourt: Set<string>) => {
    const onCourtList = roster.filter((p) => onCourt.has(p.pcode)).sort(byLivePts);
    const bench = roster.filter((p) => !onCourt.has(p.pcode)).sort(byLivePts);
    return (
      <div className="replay-court-col" key={team.tcode}>
        <div className="replay-court-col-label team-ink" style={teamInkStyle(team.color)}>
          {team.name}
        </div>
        <div className="table-scroll">
          <table className="data-table replay-court-table">
            <thead>{courtHeaderRow("top")}</thead>
            <tbody>
              {onCourtList.map((p) => onCourtRow(p, true))}
              {bench.length > 0 && (
                <tr className="bench-divider-row">
                  {/* KBL 이벤트 로그는 경기 종료 시 5명 전원을 102(OUT)로 뺀다 - 그래서 마지막
                      순간에는 온코트가 0명이 되고 전원이 이 구분선 아래로 내려간다. 그때 "벤치"라고
                      적으면 거짓이라 무슨 상태인지 그대로 말한다. */}
                  <td colSpan={COURT_COLS}>{onCourtList.length === 0 ? "경기 종료 · 최종 기록" : "벤치"}</td>
                </tr>
              )}
              {bench.map((p) => onCourtRow(p, false))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const playerPhoto = (pcode: string | null, cls: string) => {
    const p = pcode ? playerByPcode.get(pcode) : undefined;
    if (!p) return <div className={`${cls}-fallback`}>?</div>;
    // components/TeamBadge.tsx와 같은 이유(외부 kbl.or.kr 호스팅 사진이라 next/image 최적화 대상이 아님).
    if (p.photoUrl) return <PlayerPhoto src={p.photoUrl} alt={p.name} size={34} className={cls} />;
    return <div className={`${cls}-fallback`}>{p.backNum ? `#${p.backNum}` : (p.name || "?").slice(0, 1)}</div>;
  };

  // 요청: "허훈의 2점슛 실패로 승률이 어느정도 떨어지는지 분석" - 큰 스윙이 아니어도 눈에
  // 띄는 미스/플레이의 승률 영향은 줄 옆에 바로 보여줌(±5%p 이상). 부호는 위 결정적
  // 장면들과 같은 팀-상대 컨벤션이 아니라 "이 플레이를 한 팀 자신에게 좋았는지"
  // 기준(row.tcode 관점) - 턴오버/미스처럼 득점으로 안 끝나는 줄에도 자연스럽게 맞음.
  const NOTABLE_WPA_THRESHOLD = 0.05;
  const possLineRow = (r: GameEvent) => {
    const isMiss = r.action_code ? MISS_CODES.has(r.action_code) : false;
    const delta = r.wpa_home == null ? null : r.tcode === homeTeam.tcode ? r.wpa_home : r.tcode === awayTeam.tcode ? -r.wpa_home : null;
    return (
      <div className="replay-poss-line" key={r.event_order}>
        <span>
          {isMiss && <span className="replay-pl-miss">✕</span>} {r.player_name && <b>{r.player_name}</b>} {r.action_label ?? ""}
          {delta != null && Math.abs(delta) >= NOTABLE_WPA_THRESHOLD && (
            <span className={`replay-pl-wpa ${delta >= 0 ? "up" : "down"}`}> {delta >= 0 ? "+" : ""}{Math.round(delta * 100)}%p</span>
          )}
        </span>
        <span className="replay-pl-clock">{clockStr(r)}</span>
      </div>
    );
  };

  const possDivider = (item: PossessionItem & { type: "divider" }) => {
    const last = item.rows[item.rows.length - 1];
    // 교체는 한꺼번에 몰려서 나오는 경우가 많아 개별 줄 대신 하나의 "교체 N명" 구분선으로.
    if (item.rows.length > 1) {
      return (
        <div className="replay-poss-divider" key={`div-${last.event_order}`}>
          선수교체 {item.rows.length}명 · {clockStr(last)}
        </div>
      );
    }
    const r = item.rows[0];
    return (
      <div className="replay-poss-divider" key={`div-${r.event_order}`}>
        {r.action_label ?? ""}
        {r.player_name ? ` · ${r.player_name}` : ""} · {clockStr(r)}
      </div>
    );
  };

  const possessionCard = (group: PossessionItem & { type: "group" }) => {
    const isHome = group.team === homeTeam.tcode;
    const isAway = group.team === awayTeam.tcode;
    const team = isHome ? homeTeam : isAway ? awayTeam : null;
    const oppTeam = isHome ? awayTeam : isAway ? homeTeam : null;
    const color = team ? team.color : "var(--ink-faint)";

    const rows = group.rows;
    const veryLast = rows[rows.length - 1];
    // 득점 바로 뒤에 어시스트가 같은 그룹에 묶여 있으면(요청) 마지막 줄이 어시스트가 되므로,
    // "득점으로 끝났는가"는 어시스트를 건너뛰고 그 앞의 득점 이벤트로 판정해야 함.
    // 단, buildRecentFeed는 FEED_WINDOW로 이벤트를 잘라서 segmentPossessions에 넘기는데,
    // 그 절단 경계가 하필 "득점 -> 어시스트" 쌍의 어시스트 행 바로 앞이면(예: idx로 직접
    // 점프하는 report-jump-link/슛차트 클릭이 이런 idx에 정확히 떨어질 수 있음 - 실사용
    // 중 크래시로 발견됨) segmentPossessions은 윈도우의 첫 행(그 어시스트)부터 새 그룹을
    // 시작하므로 "어시스트 1행짜리" 그룹이 만들어짐 - 짝이 되는 득점 행은 윈도우 밖으로
    // 잘려나가 존재하지 않는다. 이럴 땐 rows.length가 2 미만이라 rows[rows.length-2]가
    // undefined이므로, "어시스트로 끝남" 취급을 하지 않고(실제 득점 행을 볼 수 없으므로)
    // 이 어시스트 행 자체를 마지막 행으로 취급해 일반 텍스트 줄로만 보여줌.
    const isAssistLast = veryLast.action_code === "211" && rows.length >= 2;
    const scoreRow = isAssistLast ? rows[rows.length - 2] : veryLast;
    const assistRow = isAssistLast ? veryLast : null;
    const endedInScore = !!scoreRow.action_code && SCORING_CODES.has(scoreRow.action_code);

    const trimCount = endedInScore ? (isAssistLast ? 2 : 1) : 0;
    const bodyRows = trimCount ? rows.slice(0, rows.length - trimCount) : rows;
    // 요청: "스틸-어시-득점", "블락-어시-득점" 처럼 중요한 흐름은 사진으로 이어서 보여달라 -
    // 득점으로 끝난 섹션에서 스틸/블록/공격리바운드는 텍스트 줄 대신 득점자·어시스트와 같은
    // 사진 카드로 승격(미스는 여전히 텍스트 줄에 ✕ 표시로 남김).
    const keyFlowRows = endedInScore ? bodyRows.filter((r) => r.action_code && KEY_FLOW_CODES.has(r.action_code) && r.pcode) : [];
    const plainRows = endedInScore ? bodyRows.filter((r) => !(r.action_code && KEY_FLOW_CODES.has(r.action_code) && r.pcode)) : bodyRows;

    let shotSvg: string | null = null;
    if (endedInScore) {
      const shot = findShotForScoreRow(events, shots, shotReliability, scoreRow);
      if (shot) shotSvg = drawMiniShotSpot(shot, isAway, color, homeTeam.logoUrl);
    }

    const resultTxt = endedInScore ? `${scoreRow.home_score}-${scoreRow.away_score}` : veryLast.action_code === "214" ? "턴오버" : "";

    // 요청: "승률 60%→48%인데 정관장이 유리해졌다는 표현이 이상하다"에서 이미 확립된
    // 컨벤션(lib/postgameReport.ts "결정적 장면들" 참고) - 득점 줄 맨 아래 요약은 항상
    // 득점한 팀 자신의 승률로 보여줌(home_win_prob를 그대로 쓰면 원정팀이 득점해도 숫자가
    // home 기준으로만 오르내려 헷갈림 - 이 프로젝트가 이미 겪고 고친 버그를 재도입하지 않음).
    const scoringIsHome = scoreRow.tcode === homeTeam.tcode;
    const scoringTeam = scoringIsHome ? homeTeam : awayTeam;
    const scoringProb = scoreRow.home_win_prob == null ? null : scoringIsHome ? scoreRow.home_win_prob : 1 - scoreRow.home_win_prob;
    const scoringDelta = scoreRow.wpa_home == null ? null : scoringIsHome ? scoreRow.wpa_home : -scoreRow.wpa_home;

    const totalCards = keyFlowRows.length + 1 + (assistRow ? 1 : 0);

    return (
      <div className="replay-poss-group" style={{ "--pg-color": color } as CSSProperties} key={rows[0].event_order}>
        <div className="replay-poss-banner">
          <TeamBadge team={team ? { name: team.name, abbr: team.abbr, color: team.color, logoUrl: team.logoUrl } : null} size={18} />
          <span className={team ? "replay-poss-team-name team-ink" : "replay-poss-team-name"} style={team ? teamInkStyle(team.color) : { color }}>
            {team?.name ?? ""}
          </span>
          {oppTeam && <span className="replay-poss-vs-tag">vs {oppTeam.abbr}</span>}
          {resultTxt && <span className="replay-poss-result">{resultTxt}</span>}
        </div>
        <div className="replay-poss-body">
          {plainRows.map(possLineRow)}
          {endedInScore && (
            <>
              {shotSvg && (
                <div className="replay-mini-court-tilt">
                  <svg
                    className="replay-mini-court"
                    viewBox={`${COURT_X[0]} ${COURT_Y[0]} ${COURT_X[1] - COURT_X[0]} ${COURT_Y[1] - COURT_Y[0]}`}
                    dangerouslySetInnerHTML={{ __html: shotSvg }}
                  />
                </div>
              )}
              <div className={`replay-poss-score-card${totalCards <= 1 ? " single" : ""}`}>
                {keyFlowRows.map((r) => (
                  <div className="replay-psc-player" key={r.event_order}>
                    {playerPhoto(r.pcode, "replay-psc-photo")}
                    <div>
                      <div className="replay-psc-name">
                        {r.pcode === topPcode && (
                          <span className="replay-psc-star" title={topBadgeTitle}>
                            ⭐
                          </span>
                        )}
                        {r.player_name ?? "-"}
                      </div>
                      <div className="replay-psc-tag">{KEY_FLOW_TAGS[r.action_code!]}</div>
                    </div>
                  </div>
                ))}
                <div className="replay-psc-player">
                  {playerPhoto(scoreRow.pcode, "replay-psc-photo")}
                  <div>
                    <div className="replay-psc-name">
                      {scoreRow.pcode === topPcode && (
                        <span className="replay-psc-star" title={topBadgeTitle}>
                          ⭐
                        </span>
                      )}
                      {scoreRow.player_name ?? "-"}
                    </div>
                    <div className="replay-psc-tag">{scoreRow.action_code === "203" ? "+1 PTS" : scoreRow.action_code === "205" ? "+3 PTS" : "+2 PTS"}</div>
                  </div>
                </div>
                {assistRow && (
                  <div className="replay-psc-player">
                    {playerPhoto(assistRow.pcode, "replay-psc-photo")}
                    <div>
                      <div className="replay-psc-name">
                        {assistRow.pcode === topPcode && (
                          <span className="replay-psc-star" title={topBadgeTitle}>
                            ⭐
                          </span>
                        )}
                        {assistRow.player_name ?? "-"}
                      </div>
                      <div className="replay-psc-tag">AST</div>
                    </div>
                  </div>
                )}
              </div>
              <div className="replay-poss-scoreline">
                <span className="replay-feed-score">
                  {scoreRow.home_score} - {scoreRow.away_score}
                </span>
                <span className="replay-poss-winpct">
                  {scoringTeam.name} {scoringProb != null ? Math.round(scoringProb * 100) : "-"}%
                  {scoringDelta != null && (
                    <span className={`replay-poss-wpa ${scoringDelta >= 0 ? "up" : "down"}`}> {scoringDelta >= 0 ? "+" : ""}{Math.round(scoringDelta * 100)}%p</span>
                  )}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="panel replay-panel" ref={panelRef}>
      {/* 푸시 알림 스택(요청 3) - position:fixed로 항상 문서 최상단에 떠서 어디에
          렌더링되든 상관없음. pushToast가 최근 3개까지만 유지, ~4.7초 후 자동 제거. */}
      <div className="replay-push-stack" aria-live="polite">
        {toasts.map((t) => (
          <div className="replay-push-toast" key={t.id}>
            <div className="replay-push-icon">{t.icon}</div>
            <div className="replay-push-body-wrap">
              <div className="replay-push-top-row">
                <span className="replay-push-app">코트사이드</span>
                <span className="replay-push-time">지금</span>
              </div>
              <div className="replay-push-title">{t.title}</div>
              <div className="replay-push-msg">{t.msg}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="panel-title">인터랙티브 리플레이</div>

      {/* 요청: "상단 점수판과 하단의 재생바를 상단쪽에 합치되, 사이즈는 기존 상단 점수판을
          넘지 않도록". position:sticky가 아니라 항상 존재하는 별개의 position:fixed 요소를
          show 클래스로 등장/퇴장(문서 레이아웃에 영향 없음). 아래 .replay-scoreboard는
          완전히 평범한 카드 - 이 컴포넌트 안 어디서도 sticky를 쓰지 않음. */}
      <div
        className={`replay-sticky-bar${transportVisible ? " show" : ""}`}
        style={{ "--h": homeTeam.color, "--a": awayTeam.color } as CSSProperties}
      >
        <div className="replay-sticky-main">
          <div className="replay-sticky-side">
            <TeamBadge team={homeTeam} size={26} />
            <span className="replay-sticky-team">{homeTeam.abbr}</span>
          </div>
          <div className="replay-sticky-nums">
            <span className="replay-sticky-score"><CountUp value={row.home_score} ms={countMs} /></span>
            <span className="replay-sticky-clock">
              {live && <span className="live-dot" />}
              {clockStr(row)}
            </span>
            <span className="replay-sticky-score"><CountUp value={row.away_score} ms={countMs} /></span>
          </div>
          <div className="replay-sticky-side">
            <span className="replay-sticky-team">{awayTeam.abbr}</span>
            <TeamBadge team={awayTeam} size={26} />
          </div>
        </div>
        {/* 예전엔 승률 분할막대 + "흐름" 텍스트 줄이 따로 있었다. 그 두 줄 자리에 하단
            재생바를 합친다 - 단색 막대가 아니라 ScrubTrack을 작게 재사용해 실제 승률
            추이(스파크라인)를 보여주고, 재생 버튼과 펼침 화살표를 옆에 붙인다. 점수차
            텍스트("KCC +13")는 이미 위 점수 숫자로 보이고, 런/몰아치기는
            computePushNotifications가 토스트로 따로 알리므로 이 줄에서 다시 안 적는다. */}
        <div className="replay-sticky-control">
          <span className="replay-sticky-prob">
            {homePct != null && <><CountUp value={homePct} ms={countMs} />%</>}
          </span>
          <button
            type="button"
            className="replay-mini-scrub"
            onClick={() => setTransportExpanded((v) => !v)}
            aria-label={transportExpanded ? "재생 컨트롤 접기" : "재생 컨트롤 펼치기"}
            aria-expanded={transportExpanded}
          >
            <ScrubTrack events={events} idx={idx} quarterOrder={quarterOrder} firstIdxByQuarter={firstIdxByQuarter} playing={playing} speedMs={speedMs} />
          </button>
          <button
            type="button"
            className="replay-sticky-play"
            onClick={(e) => {
              e.stopPropagation();
              if (idx >= events.length - 1) setIdx(0);
              setPlaying((p) => !p);
            }}
            aria-label={playing ? "일시정지" : "재생"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            className="replay-transport-toggle"
            onClick={() => setTransportExpanded((v) => !v)}
            aria-label={transportExpanded ? "재생 컨트롤 접기" : "재생 컨트롤 펼치기"}
            aria-expanded={transportExpanded}
          >
            {transportExpanded ? "▾" : "▴"}
          </button>
          <span className="replay-sticky-prob">
            {homePct != null && <><CountUp value={100 - homePct} ms={countMs} />%</>}
          </span>
        </div>
        {/* 펼침 단 - 예전엔 화면 하단 고정바 안에 있던 내용을 그대로 옮겨왔다. 탭했을 때만
            렌더되므로 평소(접힌) 바 높이에는 전혀 영향이 없다. */}
        {transportExpanded && (
          <div className="replay-sticky-expand">
            <div className="replay-scrub">
              <ScrubTrack events={events} idx={idx} quarterOrder={quarterOrder} firstIdxByQuarter={firstIdxByQuarter} playing={playing} speedMs={speedMs} />
              <div className="replay-scrub-qlabels" aria-hidden="true">
                {quarterOrder.map((q) => {
                  const first = firstIdxByQuarter.get(q);
                  if (first == null || events.length < 2) return null;
                  return (
                    <span key={q} className="replay-scrub-qlabel" style={{ left: `${(first / (events.length - 1)) * 100}%` }}>
                      {q}
                    </span>
                  );
                })}
              </div>
              <input
                type="range"
                className="replay-slider"
                min={0}
                max={events.length - 1}
                value={idx}
                aria-label="재생 위치"
                onChange={(e) => {
                  setPlaying(false);
                  setIdx(Number(e.target.value));
                }}
              />
            </div>
            <div className="replay-transport-row">
              <div className="replay-controls">
                <button type="button" className="replay-btn" onClick={() => setIdx(0)} aria-label="처음으로">
                  ⏮
                </button>
                <button type="button" className="replay-btn" onClick={() => setIdx((i) => Math.max(0, i - 1))} aria-label="이전">
                  ◀
                </button>
                <button
                  type="button"
                  className="replay-btn replay-btn-play"
                  onClick={() => {
                    if (idx >= events.length - 1) setIdx(0);
                    setPlaying((p) => !p);
                  }}
                >
                  {playing ? "일시정지" : "재생"}
                </button>
                <button type="button" className="replay-btn" onClick={advanceForward} aria-label="다음">
                  ▶
                </button>
                <button
                  type="button"
                  className="replay-btn"
                  onClick={() => {
                    setPlaying(false);
                    setIdx(events.length - 1);
                  }}
                  aria-label="끝으로"
                >
                  ⏭
                </button>
                <select value={speedMs} onChange={(e) => setSpeedMs(Number(e.target.value))} className="replay-speed" aria-label="재생 속도">
                  <option value={600}>0.5x</option>
                  <option value={300}>1x</option>
                  <option value={120}>2x</option>
                  <option value={50}>4x</option>
                </select>
              </div>
              <div className="replay-quarter-btns">
                {quarterOrder.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={`replay-quarter-btn ${row.quarter === q ? "active" : ""}`}
                    onClick={() => {
                      setPlaying(false);
                      setIdx(firstIdxByQuarter.get(q) ?? 0);
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
              <div className="replay-transport-clock">
                <span className="replay-transport-time">{clockStr(row)}</span>
                <span className="replay-transport-pos">
                  {(idx + 1).toLocaleString()} / {events.length.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="replay-scoreboard">
        <div className="replay-scoreboard-clock">{clockStr(row)}</div>

        <div className="replay-scoreboard-main">
          <div className="replay-team-col">
            <TeamBadge team={homeTeam} size={56} />
            <div className="replay-team-name team-ink" style={teamInkStyle(homeTeam.color)}>
              {homeTeam.name}
            </div>
            <div className="replay-team-score"><CountUp value={row.home_score} ms={countMs} /></div>
          </div>
          <div className="replay-sb-sep">:</div>
          <div className="replay-team-col">
            <TeamBadge team={awayTeam} size={56} />
            <div className="replay-team-name team-ink" style={teamInkStyle(awayTeam.color)}>
              {awayTeam.name}
            </div>
            <div className="replay-team-score"><CountUp value={row.away_score} ms={countMs} /></div>
          </div>
        </div>

        {row.home_win_prob != null && (
          <>
            <div className="replay-prob-row">
              <div>
                <span className="replay-prob-pct team-ink" style={teamInkStyle(homeTeam.color)}>
                  <CountUp value={row.home_win_prob * 100} ms={countMs} />%
                </span>
                <span className="replay-prob-label">승리확률</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <span className="replay-prob-pct team-ink" style={teamInkStyle(awayTeam.color)}>
                  <CountUp value={(1 - row.home_win_prob) * 100} ms={countMs} />%
                </span>
                <span className="replay-prob-label">승리확률</span>
              </div>
            </div>
            <div className="replay-split-bar">
              <div className="replay-split-home" style={{ width: `${row.home_win_prob * 100}%`, background: homeTeam.color }} />
              <div className="replay-split-away" style={{ width: `${(1 - row.home_win_prob) * 100}%`, background: awayTeam.color }} />
            </div>
          </>
        )}

        <div className="table-scroll">
          <table className="replay-quarter-table">
            <thead>
              <tr>
                <th></th>
                {quarterOrder.map((q) => (
                  <th key={q}>{q}</th>
                ))}
                <th>계</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="replay-quarter-tname team-ink" style={teamInkStyle(homeTeam.color)}>
                  {homeTeam.abbr}
                </td>
                {homeByQ.map((c, i) => (
                  <td key={i}>
                    {c == null ? "-" : c.v}
                    {c?.live && <span className="replay-quarter-live">*</span>}
                  </td>
                ))}
                <td className="replay-quarter-total">{row.home_score}</td>
              </tr>
              <tr>
                <td className="replay-quarter-tname team-ink" style={teamInkStyle(awayTeam.color)}>
                  {awayTeam.abbr}
                </td>
                {awayByQ.map((c, i) => (
                  <td key={i}>
                    {c == null ? "-" : c.v}
                    {c?.live && <span className="replay-quarter-live">*</span>}
                  </td>
                ))}
                <td className="replay-quarter-total">{row.away_score}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* pcode가 아니라 player_name으로 판단해야 한다(2026-09-02) - 라이브 경기에서는
          pcode는 있는데 이름이 아직 안 붙는 경우가 있고, 그때 예전 코드는 문자 그대로
          `null · 수비리바운드`를 그렸다. 이름이 없으면 액션만 보여준다. */}
      <div className="replay-now-line">{row.player_name ? `${row.player_name} · ` : ""}{row.action_label ?? "-"}</div>

      {flowChips.length > 0 && (
        <div className="replay-flow-chips">
          {flowChips.map((c) => (
            <span key={c.key} className="replay-flow-chip">
              {c.text}
            </span>
          ))}
        </div>
      )}

      <div className="replay-leaders">
        <div className="panel-title">GAME LEADERS</div>
        <div className="replay-leaders-teams">
          <div className="replay-leaders-team-tag home team-ink" style={teamInkStyle(homeTeam.color)}>
            <TeamBadge team={homeTeam} size={18} />
            {homeTeam.name}
          </div>
          <div className="replay-leaders-team-tag away team-ink" style={teamInkStyle(awayTeam.color)}>
            {awayTeam.name}
            <TeamBadge team={awayTeam} size={18} />
          </div>
        </div>
        {LEADER_STATS.map(({ key, label, sub }) => {
          const home = leaderOf(homeTeam.tcode, key);
          const away = leaderOf(awayTeam.tcode, key);
          return (
            <div className="replay-leaders-row" key={key}>
              {leaderBlock(home, "home", homeTeam.color, sub)}
              <div className="replay-leaders-cat">{label}</div>
              {leaderBlock(away, "away", awayTeam.color, sub)}
            </div>
          );
        })}
      </div>

      {/* "코트 위" 패널을 M7 라인업 넷레이팅 바로 위에 붙여서 "지금 누가 뛰고 있고, 이 조합이
          통산 얼마나 잘했는지"를 한 섹션처럼 읽히게 배치(요청). */}
      <div className="replay-court">
        <div className="panel-title">코트 위</div>
        {/* 게임식 선수 카드 - 아래 표(상세)와 같은 온코트 5인을 프로필 카드로. 경기 시작 전(PRE)에만 빈 상태 안내가 나온다. */}
        <OnCourtCards teams={courtCardTeams} pre={row.quarter === "PRE"} topTitle={topBadgeTitle} />
        {/* 표를 넘기는 탭(요청: "길어진다면, 표를 여러개 만들어서 항목을 넘기도록"). 세 장 모두
            지금 스크럽 시점까지의 이벤트만으로 계산한다 - 아래 캡션이 그 사실을 들고 있다. */}
        <div className="replay-boxtabs" role="tablist">
          {BOX_VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={boxView === v.key}
              title={v.hint}
              className={`replay-boxtab${boxView === v.key ? " active" : ""}`}
              onClick={() => setBoxView(v.key)}
            >
              {v.label}
            </button>
          ))}
          <span className="replay-boxtab-hint">{BOX_VIEWS.find((v) => v.key === boxView)?.hint}</span>
        </div>
        <div className="replay-court-grid">
          {onCourtColumn(homeTeam, homePlayers, homeOnCourt)}
          {onCourtColumn(awayTeam, awayPlayers, awayOnCourt)}
        </div>
        <div className="replay-box-note">
          MIN은 교체 기록으로 다시 센 &quot;지금까지 코트 위에 있던 시간&quot;입니다(경기 종료 시점에서 공식 기록과 일치). eFG% =
          (FG성공 + 0.5×3점성공) ÷ FG시도, TS% = 득점 ÷ (2 × (FG시도 + 0.44×자유투시도)), USG% = 이 선수가 쓴 팀 포제션 비율. 세 표
          전부 이 순간까지의 이벤트만으로 계산하며, 오른쪽 온/오프만 15시즌 통산값입니다.
        </div>
      </div>

      {lineupRatings && (
        <div className="replay-lineups">
          {lineupLine(homeTeam, homeOnCourt)}
          {lineupLine(awayTeam, awayOnCourt)}
        </div>
      )}

      {/* B-2. 붙어있음/떨어짐이 눈에 확 띄어야 한다 - 라이브일 때만 나오는 줄.
          팔로우 중이면 점멸하는 LIVE 점(홈 카드의 .live-dot 재사용)과 함께 "라이브 따라가는
          중", 사용자가 뒤로 스크럽했으면 몇 개 뒤인지와 함께 돌아가는 칩. 칩을 누르기 전엔
          절대 앞으로 끌고 가지 않는다. */}
      {live && (
        <div className={`replay-live-bar${following ? " following" : " detached"}`}>
          {following ? (
            <span className="replay-live-state">
              <span className="live-dot" />
              라이브 따라가는 중
            </span>
          ) : (
            <>
              <span className="replay-live-state">
                ⏸ 지난 장면 보는 중 · 라이브보다 {lastIdx - idx}개 뒤
              </span>
              <button
                type="button"
                className="replay-live-chip"
                onClick={() => {
                  setPlaying(false);
                  setPinnedIdx(null);
                }}
              >
                <span className="live-dot" />
                라이브로 돌아가기
              </button>
            </>
          )}
        </div>
      )}

      {objProb != null && actProb != null && (
        <div className="replay-explain">
          <div className="report-section-title">왜 이 승률인가</div>
          <div className="replay-explain-row">
            <span className="replay-explain-label">점수·시간만 보면</span>
            <div className="replay-explain-track">
              <div className="replay-explain-fill" style={{ width: `${objProb * 100}%` }} />
            </div>
            <span className="replay-explain-val">{Math.round(objProb * 100)}%</span>
          </div>
          <div className="replay-explain-row">
            <span className="replay-explain-label">시즌 전력 반영시</span>
            <div className="replay-explain-track">
              <div className="replay-explain-fill actual" style={{ width: `${actProb * 100}%` }} />
            </div>
            <span className="replay-explain-val">{Math.round(actProb * 100)}%</span>
          </div>
          {winExplainText && <div className="replay-explain-text">{winExplainText}</div>}
        </div>
      )}

      <WinProbLiveChart events={events} idx={idx} homeColor={homeTeam.color} live={live} />

      <div className="replay-cols">
        <div>
          <div className="report-section-title">플레이 바이 플레이</div>
          <div className="replay-poss-feed">
            {recentFeed.length === 0 ? (
              <div className="empty-note">재생을 시작하면 여기에 플레이가 표시됩니다.</div>
            ) : (
              recentFeed.map((item) => (item.type === "divider" ? possDivider(item) : possessionCard(item)))
            )}
          </div>
        </div>
      </div>

      {shots.length > 0 && (
        <div className="report-section" style={{ marginTop: 16 }}>
          <div className="report-section-title">슛 차트 (현재 쿼터까지)</div>
          <div className="replay-shot-filters">
            <select aria-label="슛 결과 필터" value={shotOutcome} onChange={(e) => setShotOutcome(e.target.value as typeof shotOutcome)}>
              <option value="all">성공+실패</option>
              <option value="make">성공만</option>
              <option value="miss">실패만</option>
            </select>
            <select aria-label="슛 점수 필터" value={shotVal} onChange={(e) => setShotVal(e.target.value as typeof shotVal)}>
              <option value="all">2점+3점</option>
              <option value="2">2점만</option>
              <option value="3">3점만</option>
            </select>
          </div>
          {homeDotsSvg || awayDotsSvg ? (
            <div className="matchup-schedule-grid">
              <div>
                <div className="explorer-stat-line">
                  {homeTeam.abbr} · {homeQuarterShots.filter((s) => s.made).length}/{homeQuarterShots.length}
                </div>
                {homeDotsSvg && (
                  <div className="zc-court-tilt">
                    <svg className="zc-court" viewBox="355 27 375 357" dangerouslySetInnerHTML={{ __html: homeDotsSvg }} />
                  </div>
                )}
              </div>
              <div>
                <div className="explorer-stat-line">
                  {awayTeam.abbr} · {awayQuarterShots.filter((s) => s.made).length}/{awayQuarterShots.length}
                </div>
                {awayDotsSvg && (
                  <div className="zc-court-tilt">
                    <svg className="zc-court" viewBox="355 27 375 357" dangerouslySetInnerHTML={{ __html: awayDotsSvg }} />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="empty-note">조건에 맞는 슛이 아직 없음</div>
          )}
        </div>
      )}
    </div>
  );
}
