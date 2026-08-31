"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { TeamBadge } from "./TeamBadge";
import { buildCourtDotsSvg, shotValue, type ShotRow } from "@/lib/zoneCompare";
import { findShootingStreaks, computeStatBursts, computeCurrentDroughts, fmtRating, type GameEvent } from "@/lib/postgameReport";
import { iGa } from "@/lib/josa";
import { currentOnCourt, comboKey } from "@/lib/gameLineups";
import type { LineupRating } from "@/lib/lineupNetRating";

// "코트사이드" 시그니처 기능(인터랙티브 리플레이/스크럽) 포팅 - courtside_template.html의
// render(idx)/computeBoxScore/renderFeedGroups/renderCourt 등 약 90개 함수 중 핵심 스크럽
// 경험만 먼저(사용자 확인 - "핵심 스크럽 MVP 먼저"). AI 내러티브 8종/핫스트릭 애니메이션/
// 클러치샷 지수 등은 다음 단계로 미룸(이미 이 경기 페이지 하단에 있는 정적
// postgameReport/pregameInsights 패널이 "경기 끝난 뒤 요약"은 커버하고 있음).
const MAKE_CODES = new Set(["201", "205", "207"]);
const MISS_CODES = new Set(["202", "206", "208"]);
const FOUL_CODES = new Set(["216", "224"]);

function emptyBoxLine() {
  return { pts: 0, fgm: 0, fga: 0, threePM: 0, threePA: 0, ftm: 0, fta: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, foul: 0 };
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

type PlayerMeta = { pcode: string; name: string; tcode: string; isStarter?: boolean | null };
type TeamMeta = { tcode: string; name: string; abbr: string; color: string; logoUrl: string | null };
type ShotWithQuarter = ShotRow & { quarter: string };

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
}) {
  const [idx, setIdx] = useState(events.length - 1);
  const [playing, setPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState(300);
  // 요청: "슛 차트와 슛 차트가 중복" - 독립 슛차트 패널(성공/실패, 2점/3점 필터)을 없애고
  // 여기 흡수시키면서 그 필터 기능도 같이 옮김(로컬 state - 이 컴포넌트는 이미 client
  // component라 서버 쿼리 파라미터 방식일 필요 없음).
  const [shotOutcome, setShotOutcome] = useState<"all" | "make" | "miss">("all");
  const [shotVal, setShotVal] = useState<"all" | "2" | "3">("all");

  useEffect(() => {
    if (!playing) return;
    if (idx >= events.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIdx((i) => Math.min(events.length - 1, i + 1)), speedMs);
    return () => clearTimeout(t);
  }, [playing, idx, events.length, speedMs]);

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
  const LEADER_STATS = [
    { key: "pts", label: "POINTS" },
    { key: "reb", label: "REBOUNDS" },
    { key: "ast", label: "ASSISTS" },
  ] as const;

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
  // 실제 슛 점 차트(app/games/[gmkey]/page.tsx와 같은 lib/zoneCompare.ts의
  // buildCourtDotsSvg) - 스크럽할수록 점이 하나씩 채워지는 느낌을 그대로 살림.
  const homeQuarterShots = useMemo(() => filteredShots.filter((s) => s.tcode === homeTeam.tcode), [filteredShots, homeTeam.tcode]);
  const awayQuarterShots = useMemo(() => filteredShots.filter((s) => s.tcode === awayTeam.tcode), [filteredShots, awayTeam.tcode]);
  const homeDotsSvg = homeQuarterShots.length > 0 ? buildCourtDotsSvg(homeQuarterShots, homeTeam.color) : null;
  const awayDotsSvg = awayQuarterShots.length > 0 ? buildCourtDotsSvg(awayQuarterShots, awayTeam.color) : null;

  // 요청: "실시간 중계에서 팀별로 묶어서 보여주고, 누가 어시를 했는지, 승률이 어떻게
  // 변화됐는지 표시" - 득점 이벤트 바로 다음(같은 타이밍대)에 어시스트(211) 이벤트가 오는
  // 실제 데이터 패턴을 확인(실측 - event_order 50 2점슛 성공 바로 다음 51이 같은 팀·같은
  // 시각의 어시스트)해서 그 인접 관계로 연결(별도 조인 데이터 불필요). 승률 변화는 항상
  // "그 플레이를 한 팀 자신에게 얼마나 도움이 됐는지" 기준으로 부호를 맞춤(원정팀 이벤트면
  // wpa_home 부호 반전 - 위 "결정적 장면들" 표기 수정과 같은 이유).
  const MAKE_CODES_FOR_ASSIST = new Set(["201", "205", "207"]);
  const feedRows = useMemo(() => {
    const start = Math.max(0, idx - 200 + 1);
    const rows: { e: GameEvent; assistName: string | null; teamDelta: number | null }[] = [];
    for (let i = idx; i >= start; i--) {
      const e = events[i];
      let assistName: string | null = null;
      if (e.action_code && MAKE_CODES_FOR_ASSIST.has(e.action_code)) {
        const next = events[i + 1];
        if (next && next.action_code === "211" && next.tcode === e.tcode && next.elapsed === e.elapsed) {
          assistName = next.player_name;
        }
      }
      const teamDelta = e.wpa_home == null ? null : e.tcode === homeTeam.tcode ? e.wpa_home : e.tcode === awayTeam.tcode ? -e.wpa_home : null;
      rows.push({ e, assistName, teamDelta });
    }
    return rows;
  }, [events, idx, homeTeam.tcode, awayTeam.tcode]);
  const homeFeedRows = useMemo(() => feedRows.filter((r) => r.e.tcode === homeTeam.tcode), [feedRows, homeTeam.tcode]);
  const awayFeedRows = useMemo(() => feedRows.filter((r) => r.e.tcode === awayTeam.tcode), [feedRows, awayTeam.tcode]);
  const feedRow = (r: (typeof feedRows)[number]) => (
    <div key={`${r.e.event_order}`} className="replay-feed-row">
      <span className="replay-feed-clock">{clockStr(r.e)}</span>
      <span className="replay-feed-text">
        {r.e.player_name ? `${r.e.player_name} ` : ""}
        {r.e.action_label ?? ""}
        {r.assistName && <span className="replay-feed-assist"> (AST: {r.assistName})</span>}
      </span>
      <span className="replay-feed-score">
        {r.e.home_score}-{r.e.away_score}
      </span>
      {r.teamDelta != null && (
        <span className={`replay-feed-delta ${r.teamDelta >= 0 ? "up" : "down"}`}>
          {r.teamDelta >= 0 ? "+" : ""}
          {Math.round(r.teamDelta * 100)}%p
        </span>
      )}
    </div>
  );

  // 요청: "선수 기록과 인터랙티브 리플레이의 선수기록이 중복" - 독립 선수기록 패널(선발/벤치
  // 구분선 있던)을 없애고 여기로 흡수시키면서 그 구분선도 같이 옮김.
  const playerRow = (p: PlayerMeta) => {
    const b = box.get(p.pcode) ?? emptyBoxLine();
    return (
      <tr key={p.pcode}>
        <td>
          <Link href={`/players/${p.pcode}`}>{p.name}</Link>
        </td>
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
      </tr>
    );
  };
  const byLivePts = (a: PlayerMeta, b: PlayerMeta) => (box.get(b.pcode)?.pts ?? 0) - (box.get(a.pcode)?.pts ?? 0);
  const boxTable = (list: PlayerMeta[]) => {
    const starters = list.filter((p) => p.isStarter).sort(byLivePts);
    const bench = list.filter((p) => !p.isStarter).sort(byLivePts);
    return (
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
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
            </tr>
          </thead>
          <tbody>
            {starters.map(playerRow)}
            {starters.length > 0 && bench.length > 0 && (
              <tr className="bench-divider-row">
                <td colSpan={10}>벤치</td>
              </tr>
            )}
            {bench.map(playerRow)}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="panel replay-panel">
      <div className="panel-title">인터랙티브 리플레이</div>

      {/* 요청: "스크롤을 내리면 상단에 점수/팀/예상승률/현재 쿼터 시간등을 작게 틀 고정" -
          순수 CSS position:sticky라 스크롤 리스너 JS 불필요. */}
      <div className="replay-sticky-bar">
        <span className="replay-sticky-team" style={{ color: homeTeam.color }}>
          {homeTeam.abbr} {row.home_score}
        </span>
        {row.home_win_prob != null && (
          <span className="replay-sticky-prob">
            {Math.round(row.home_win_prob * 100)}% - {Math.round((1 - row.home_win_prob) * 100)}%
          </span>
        )}
        <span className="replay-sticky-clock">{clockStr(row)}</span>
        <span className="replay-sticky-team away" style={{ color: awayTeam.color }}>
          {row.away_score} {awayTeam.abbr}
        </span>
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
        {LEADER_STATS.map(({ key, label }) => {
          const home = leaderOf(homeTeam.tcode, key);
          const away = leaderOf(awayTeam.tcode, key);
          return (
            <div className="replay-leaders-row" key={key}>
              <span className="replay-leaders-val" style={{ color: homeTeam.color }}>
                {home ? `${home.v} · ${home.p.name}` : "-"}
              </span>
              <span className="replay-leaders-label">{label}</span>
              <span className="replay-leaders-val away" style={{ color: awayTeam.color }}>
                {away ? `${away.v} · ${away.p.name}` : "-"}
              </span>
            </div>
          );
        })}
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
          onClick={() => setIdx((i) => Math.min(events.length - 1, i + 1))}
          aria-label="다음"
        >
          ▶
        </button>
        <button type="button" className="replay-btn" onClick={() => setIdx(events.length - 1)} aria-label="끝으로">
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
          <div className="report-section-title">홈 - {homeTeam.name}</div>
          {boxTable(homePlayers)}
          <div className="report-section-title" style={{ marginTop: 14 }}>
            원정 - {awayTeam.name}
          </div>
          {boxTable(awayPlayers)}
        </div>
        <div>
          <div className="report-section-title">플레이 바이 플레이</div>
          <div className="replay-feed-cols">
            <div>
              <div className="replay-feed-team-title" style={{ color: homeTeam.color }}>
                {homeTeam.abbr}
              </div>
              <div className="replay-feed">{homeFeedRows.map(feedRow)}</div>
            </div>
            <div>
              <div className="replay-feed-team-title" style={{ color: awayTeam.color }}>
                {awayTeam.abbr}
              </div>
              <div className="replay-feed">{awayFeedRows.map(feedRow)}</div>
            </div>
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
