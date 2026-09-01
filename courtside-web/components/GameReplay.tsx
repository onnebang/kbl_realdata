"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { TeamBadge } from "./TeamBadge";
import { buildCourtDotsSvg, shotValue, COURT_X, COURT_Y, type ShotDotMeta } from "@/lib/zoneCompare";
import { findShootingStreaks, computeStatBursts, computeCurrentDroughts, fmtRating, gameWideTopPerformer, type GameEvent, type PlayerBox, type StreakEvent } from "@/lib/postgameReport";
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
import { currentOnCourt, comboKey, computeFinalPlusMinus } from "@/lib/gameLineups";
import type { LineupRating, PlayerOnOff } from "@/lib/lineupNetRating";

// "코트사이드" 시그니처 기능(인터랙티브 리플레이/스크럽) 포팅 - courtside_template.html의
// render(idx)/computeBoxScore/renderFeedGroups/renderCourt 등 약 90개 함수 중 핵심 스크럽
// 경험만 먼저(사용자 확인 - "핵심 스크럽 MVP 먼저"). AI 내러티브 8종/핫스트릭 애니메이션/
// 클러치샷 지수 등은 다음 단계로 미룸(이미 이 경기 페이지 하단에 있는 정적
// postgameReport/pregameInsights 패널이 "경기 끝난 뒤 요약"은 커버하고 있음).
const MAKE_CODES = new Set(["201", "205", "207"]);
const MISS_CODES = new Set(["202", "206", "208"]);
const FOUL_CODES = new Set(["216", "224"]);

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
  if (row.runHome >= PUSH_RUN_THRESHOLD && (!prevRow || prevRow.runHome < PUSH_RUN_THRESHOLD)) {
    out.push({ icon: "🔥", title: `${homeTeam.name} 런!`, msg: `상대 무득점 구간에 ${row.runHome}점 연속 - 지금 흐름이 넘어가고 있습니다.` });
  }
  if (row.runAway >= PUSH_RUN_THRESHOLD && (!prevRow || prevRow.runAway < PUSH_RUN_THRESHOLD)) {
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
function WinProbLiveChart({ events, idx, homeColor }: { events: GameEvent[]; idx: number; homeColor: string }) {
  const valid = events.map((e, i) => ({ e, i })).filter((r) => r.e.home_win_prob != null);
  if (!valid.length) return <div className="empty-note">승률 데이터 없음</div>;
  const W = 640,
    H = 150;
  const n = valid.length;
  const xOf = (vi: number) => (vi / Math.max(1, n - 1)) * W;
  const yOf = (p: number) => (1 - p) * H;
  const points = valid.map((r, vi) => [xOf(vi), yOf(r.e.home_win_prob as number)] as const);
  const linePath = "M " + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ");
  const areaPath = `${linePath} L ${points[points.length - 1][0].toFixed(1)} ${H} L 0 ${H} Z`;

  const quarterBounds: { x: number; q: string }[] = [];
  let lastQ: string | null = null;
  valid.forEach((r, vi) => {
    if (r.e.quarter !== "PRE" && r.e.quarter !== lastQ) {
      quarterBounds.push({ x: xOf(vi), q: r.e.quarter });
      lastQ = r.e.quarter;
    }
  });

  let markerVi = 0;
  for (let vi = 0; vi < valid.length; vi++) {
    if (valid[vi].i <= idx) markerVi = vi;
    else break;
  }
  const marker = valid[markerVi];
  const mx = xOf(markerVi);
  const my = yOf(marker.e.home_win_prob as number);
  const midY = H / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 150, display: "block" }}>
      <line x1={0} y1={midY} x2={W} y2={midY} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="3,4" />
      {quarterBounds.map((b) => (
        <line key={b.q} x1={b.x} y1={0} x2={b.x} y2={H} stroke="var(--ink-faint)" strokeWidth={1} opacity={0.35} />
      ))}
      <path d={areaPath} fill={homeColor} fillOpacity={0.12} />
      <path d={linePath} fill="none" stroke={homeColor} strokeWidth={2} />
      <line x1={mx} y1={0} x2={mx} y2={H} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="2,3" />
      <circle cx={mx} cy={my} r={4.5} fill={homeColor} stroke="var(--surface)" strokeWidth={1.5} />
      <text x={mx} y={Math.max(11, my - 10)} textAnchor="middle" fontSize={11} fontWeight={700} fill={homeColor} fontFamily="IBM Plex Mono, monospace">
        {Math.round((marker.e.home_win_prob as number) * 100)}%
      </text>
    </svg>
  );
}

export default function GameReplay({
  events,
  players,
  homeTeam,
  awayTeam,
  shots,
  homeNetRating,
  awayNetRating,
  lineupRatings,
  playerOnOff,
}: {
  events: GameEvent[];
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
}) {
  const [idx, setIdx] = useState(events.length - 1);
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
  }, [events, homeTeam, awayTeam, pushToast]);

  useEffect(() => {
    if (!playing || idx >= events.length - 1) return;
    const t = setTimeout(() => advanceForward(), speedMs);
    return () => clearTimeout(t);
  }, [playing, idx, events.length, speedMs, advanceForward]);

  // 요청: "스크롤을 내리면 상단에 점수/팀/예상승률/현재 쿼터 시간등을 작게 틀 고정" - 처음엔
  // 순수 CSS position:sticky였는데, "자기 자신이 줄어들거나 사라지는 sticky 요소가 있으면
  // 브라우저가 scrollY를 0으로 되돌린다"는 실제 버그를 겪음(레퍼런스 아티팩트가 이미 겪고
  // 고친 것과 동일 - courtside_template.html 3692~3726행 주석 참고). 그래서 이 프로젝트도
  // 같은 구조로 포팅: 전체 스코어보드는 이제 sticky가 아닌 완전히 평범한 카드(그냥 스크롤을
  // 따라 지나감, 자기 높이가 안 바뀜)이고, "고정" 역할은 완전히 별개의 position:fixed 요소
  // (아래 .replay-sticky-bar)가 전담 - display가 아니라 transform(translateY)+"show"
  // 클래스로만 등장/퇴장시켜서 문서 레이아웃/스크롤 높이에 전혀 영향을 안 줌. 스코어보드
  // 바로 아래(그 카드가 끝나는 지점)에 심어둔 sentinel을 IntersectionObserver로 지켜보다가
  // 화면 밖으로 나가면 켬 - 인앱브라우저 등 IO 동작이 들쭉날쭉한 웹뷰 대비 scroll 이벤트
  // 폴백도 이중화(둘 중 하나만 붙어도 정상 동작).
  const stickySentinelRef = useRef<HTMLDivElement | null>(null);
  const [stickyVisible, setStickyVisible] = useState(false);
  useEffect(() => {
    const el = stickySentinelRef.current;
    if (!el) return;
    const updateFromRect = () => setStickyVisible(el.getBoundingClientRect().bottom <= 0);
    let observer: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(([entry]) => setStickyVisible(!entry.isIntersecting), { threshold: 0 });
      observer.observe(el);
    }
    window.addEventListener("scroll", updateFromRect, { passive: true });
    updateFromRect();
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", updateFromRect);
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
  }, [events.length]);

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
  const nameByPcode = useMemo(() => new Map(players.map((p) => [p.pcode, p.name])), [players]);
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
  if (row.runHome >= RUN_THRESHOLD) flowChips.push({ key: "run-home", text: `🔥 ${homeTeam.abbr} ${row.runHome}-0 런` });
  if (row.runAway >= RUN_THRESHOLD) flowChips.push({ key: "run-away", text: `🔥 ${awayTeam.abbr} ${row.runAway}-0 런` });

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
        <div className="replay-leaders-val" style={best ? { color } : undefined}>
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
        <div className="replay-lineup-team" style={{ color: team.color }}>
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
  const isDnp = (p: PlayerMeta) => p.minPlayed == null || Number(p.minPlayed) === 0;
  const jerseyNum = (p: PlayerMeta) => (p.backNum ? <span className="replay-jersey-num">#{p.backNum}</span> : null);
  const plusMinusCell = (p: PlayerMeta) => {
    const pm = finalPlusMinus.get(p.pcode) ?? 0;
    return <td className={pm > 0 ? "replay-pm pos" : pm < 0 ? "replay-pm neg" : "replay-pm"}>{pm > 0 ? `+${pm}` : pm}</td>;
  };
  const COURT_COLS = 12; // 선수 1 + PTS/REB/AST/STL/BLK/TO/FG/3P/FT/+- 10 + 온/오프 1
  const courtHeaderRow = (key: string) => (
    <tr key={key}>
      <th>선수</th>
      <th>PTS</th>
      <th>REB</th>
      <th>AST</th>
      <th>STL</th>
      <th>BLK</th>
      <th>TO</th>
      <th>FG</th>
      <th>3P</th>
      <th>FT</th>
      <th>+/-</th>
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
          <span className="replay-court-mvp" title="이 경기 최고 활약">
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
    return (
      <tr className={`replay-court-row ${isOnCourt ? "on-court" : "bench"}${isTop ? " top" : ""}`} key={p.pcode}>
        <td>{nameCell}</td>
        <td>{b.pts}</td>
        <td>{b.reb}</td>
        <td>{b.ast}</td>
        <td>{b.stl}</td>
        <td>{b.blk}</td>
        <td>{b.to}</td>
        <td>
          {b.fgm}/{b.fga}
        </td>
        <td>
          {b.threePM}/{b.threePA}
        </td>
        <td>
          {b.ftm}/{b.fta}
        </td>
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
        <div className="replay-court-col-label" style={{ color: team.color }}>
          {team.name}
        </div>
        <div className="table-scroll">
          <table className="data-table replay-court-table">
            <thead>{courtHeaderRow("top")}</thead>
            <tbody>
              {onCourtList.map((p) => onCourtRow(p, true))}
              {bench.length > 0 && (
                <tr className="bench-divider-row">
                  <td colSpan={COURT_COLS}>벤치</td>
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
    // eslint-disable-next-line @next/next/no-img-element
    if (p.photoUrl) return <img className={cls} src={p.photoUrl} alt={p.name} />;
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
          <span className="replay-poss-team-name" style={{ color }}>
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
                          <span className="replay-psc-star" title="이 경기 최고 활약">
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
                        <span className="replay-psc-star" title="이 경기 최고 활약">
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
                          <span className="replay-psc-star" title="이 경기 최고 활약">
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

      {/* 요청: "스크롤을 내리면 상단에 점수/팀/예상승률/현재 쿼터 시간등을 작게 틀 고정" -
          position:sticky가 아니라 항상 존재하는 별개의 position:fixed 요소를 show 클래스로
          등장/퇴장시킴(문서 레이아웃에 영향 없음 - 위 useEffect의 IntersectionObserver/scroll
          폴백이 stickySentinelRef를 지켜보다가 켬/끔). 아래 .replay-scoreboard는 이제 완전히
          평범한 카드 - 이 컴포넌트 안 어디서도 sticky를 쓰지 않음. */}
      <div className={`replay-sticky-bar${stickyVisible ? " show" : ""}`}>
        {row.home_win_prob != null && (
          <span className="replay-sticky-prob" style={{ color: homeTeam.color }}>
            {Math.round(row.home_win_prob * 100)}%
          </span>
        )}
        <span className="replay-sticky-team" style={{ color: homeTeam.color }}>
          {homeTeam.abbr}
        </span>
        <span className="replay-sticky-score">{row.home_score}</span>
        <span className="replay-sticky-clock">{clockStr(row)}</span>
        <span className="replay-sticky-score">{row.away_score}</span>
        <span className="replay-sticky-team" style={{ color: awayTeam.color }}>
          {awayTeam.abbr}
        </span>
        {row.home_win_prob != null && (
          <span className="replay-sticky-prob" style={{ color: awayTeam.color }}>
            {Math.round((1 - row.home_win_prob) * 100)}%
          </span>
        )}
      </div>

      <div className="replay-scoreboard">
        <div className="replay-scoreboard-clock">{clockStr(row)}</div>

        <div className="replay-scoreboard-main">
          <div className="replay-team-col">
            <TeamBadge team={homeTeam} size={56} />
            <div className="replay-team-name" style={{ color: homeTeam.color }}>
              {homeTeam.name}
            </div>
            <div className="replay-team-score">{row.home_score}</div>
          </div>
          <div className="replay-sb-sep">:</div>
          <div className="replay-team-col">
            <TeamBadge team={awayTeam} size={56} />
            <div className="replay-team-name" style={{ color: awayTeam.color }}>
              {awayTeam.name}
            </div>
            <div className="replay-team-score">{row.away_score}</div>
          </div>
        </div>

        {row.home_win_prob != null && (
          <>
            <div className="replay-prob-row">
              <div>
                <span className="replay-prob-pct" style={{ color: homeTeam.color }}>
                  {Math.round(row.home_win_prob * 100)}%
                </span>
                <span className="replay-prob-label">승리확률</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <span className="replay-prob-pct" style={{ color: awayTeam.color }}>
                  {Math.round((1 - row.home_win_prob) * 100)}%
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
                <td className="replay-quarter-tname" style={{ color: homeTeam.color }}>
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
                <td className="replay-quarter-tname" style={{ color: awayTeam.color }}>
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

      {/* sentinel - 전체 스코어보드가 끝나는 지점. 이게 화면 밖으로 나가는 순간을
          IntersectionObserver가 감지해서 위 .replay-sticky-bar를 켬(내용 없는 1px 높이 - 그
          자체는 레이아웃에 영향 없음). */}
      <div className="replay-sticky-sentinel" ref={stickySentinelRef} />

      <div className="replay-now-line">{row.pcode ? `${row.player_name} · ` : ""}{row.action_label ?? "-"}</div>

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
          <div className="replay-leaders-team-tag home" style={{ color: homeTeam.color }}>
            <TeamBadge team={homeTeam} size={18} />
            {homeTeam.name}
          </div>
          <div className="replay-leaders-team-tag away" style={{ color: awayTeam.color }}>
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
        <div className="replay-court-grid">
          {onCourtColumn(homeTeam, homePlayers, homeOnCourt)}
          {onCourtColumn(awayTeam, awayPlayers, awayOnCourt)}
        </div>
      </div>

      {lineupRatings && (
        <div className="replay-lineups">
          {lineupLine(homeTeam, homeOnCourt)}
          {lineupLine(awayTeam, awayOnCourt)}
        </div>
      )}

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
        <button
          type="button"
          className="replay-btn"
          onClick={advanceForward}
          aria-label="다음"
        >
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
        <select value={speedMs} onChange={(e) => setSpeedMs(Number(e.target.value))} className="replay-speed">
          <option value={600}>0.5x</option>
          <option value={300}>1x</option>
          <option value={120}>2x</option>
          <option value={50}>4x</option>
        </select>
      </div>

      <input
        type="range"
        className="replay-slider"
        min={0}
        max={events.length - 1}
        value={idx}
        onChange={(e) => {
          setPlaying(false);
          setIdx(Number(e.target.value));
        }}
      />

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

      <WinProbLiveChart events={events} idx={idx} homeColor={homeTeam.color} />

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
            <select value={shotOutcome} onChange={(e) => setShotOutcome(e.target.value as typeof shotOutcome)}>
              <option value="all">성공+실패</option>
              <option value="make">성공만</option>
              <option value="miss">실패만</option>
            </select>
            <select value={shotVal} onChange={(e) => setShotVal(e.target.value as typeof shotVal)}>
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
