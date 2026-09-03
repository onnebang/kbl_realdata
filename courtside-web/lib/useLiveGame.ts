"use client";

// Phase 2 - "새로고침 없이 라이브 경기를 따라간다"의 전송 계층 하나.
//
// 설계 원칙 세 가지:
//  1) 병합 경로는 하나뿐이다. Realtime(웹소켓)이든 폴링(HTTP)이든 들어온 행은 전부
//     mergeEventRows() 하나만 통과한다. 두 경로가 서로 다른 병합 로직을 쓰면 "폴링일 때만
//     중복이 생긴다" 같은 재현 안 되는 버그가 반드시 생긴다.
//  2) 폴백은 옵션이 아니다. Realtime은 프록시/사내망/플랜 제한으로 조용히 죽는다(에러조차
//     안 난다). 그래서 "최근 REALTIME 메시지가 왔는지"만 보고 주기적으로 HTTP로도 긁는다.
//     폴링이 스스로 받은 행은 "realtime이 살아있다"는 증거가 아니므로 lastRealtimeAt를
//     갱신하지 않는다(그러면 폴링이 한 번 성공한 뒤 스스로를 꺼버린다).
//  3) 진행중(live)이 아니면 아무것도 하지 않는다. 구독 0, 폴링 0. 종료/예정 경기에서
//     소켓이 열리거나 타이머가 도는 일이 없어야 한다(liveStats로 실측 검증).
//
// game_events는 라이브 수집기가 upsert한다 - 같은 event_order가 INSERT 후 UPDATE로 다시
// 올 수 있다. 그래서 병합은 event_order를 키로 "교체"(중복 추가가 아니라)해야 한다.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

export type LiveEventRow = {
  event_order: number;
  quarter: string;
  clock_min: number | null;
  clock_sec: number | null;
  action_code: string | null;
  pcode: string | null;
  tcode: string | null;
  home_score: number;
  away_score: number;
  home_win_prob: number | null;
  wpa_home: number | null;
  objective_prob: number | null;
};

// 서버(app/games/[gmkey]/page.tsx의 getEvents)와 완전히 같은 컬럼 집합 - 폴백 폴링이
// 서버 렌더와 다른 모양의 행을 만들어내지 않도록 한 곳에 둔다.
export const LIVE_EVENT_COLUMNS =
  "event_order, quarter, clock_min, clock_sec, action_code, pcode, tcode, home_score, away_score, home_win_prob, wpa_home, objective_prob";

export type LiveTransport = "off" | "connecting" | "realtime" | "polling";

// 검증용 계측(요구사항 4/5의 증거). 콘솔을 어지럽히지 않으려고 로그 대신 카운터만 둔다 -
// 브라우저에서 window.__courtsideLive 를 읽으면 구독/폴링이 실제로 몇 번 일어났는지 보인다.
// 모듈 최상단에서 만들어두기 때문에 "진행중이 아닌 경기 = 전부 0"이 그 자체로 증거가 된다.
export type LiveStats = {
  channels: number; // realtime 채널을 실제로 연 횟수
  subscribed: number; // SUBSCRIBED 콜백을 받은 횟수
  realtimeMsgs: number; // 웹소켓으로 받은 postgres_changes 메시지 수
  polls: number; // 폴백 폴링이 실제로 DB를 때린 횟수
  pollsSkipped: number; // realtime이 살아있어서 건너뛴 폴링 tick 수
  rowsFromRealtime: number;
  rowsFromPolling: number;
  transport: LiveTransport;
  realtimeBlocked: boolean; // 폴백 증명용 강제 스위치(아래 참고)
};

const stats: LiveStats = {
  channels: 0,
  subscribed: 0,
  realtimeMsgs: 0,
  polls: 0,
  pollsSkipped: 0,
  rowsFromRealtime: 0,
  rowsFromPolling: 0,
  transport: "off",
  realtimeBlocked: false,
};

declare global {
  interface Window {
    __courtsideLive?: LiveStats;
  }
}

if (typeof window !== "undefined") window.__courtsideLive = stats;

// 폴백 증명(검증 4) - 콘솔에서 window.__courtsideLive.realtimeBlocked = true 로 켜면
// 이후 구독 자체를 만들지 않는다(웹소켓이 막힌 환경 시뮬레이션). 폴링만으로도 페이지가
// 계속 전진하는지 확인하는 용도. 프로덕션 동작에는 영향 없음(기본 false).
function realtimeBlocked() {
  return typeof window !== "undefined" && window.__courtsideLive?.realtimeBlocked === true;
}

// 폴백 주기. 요구사항은 15~20초 - 라이브 수집기 자체가 그보다 자주 넣지 않으므로
// 상한(18초)에 가깝게 둬서 불필요한 왕복을 줄인다.
const POLL_MS = 18_000;
// 폴백 폴링이 몇 번에 한 번 전 구간을 다시 읽을지(18초 x 10 = 3분). 워터마크 방식만으로는
// 이미 받은 행의 정정(재업서트)을 절대 못 보기 때문에 필요한 안전장치.
const FULL_REFETCH_EVERY = 10;

/**
 * 유일한 병합 함수 - realtime과 폴링, 그리고 GameReplay가 서버 prop을 다시 받았을 때까지
 * 전부 이걸 쓴다. event_order가 키이고 incoming이 이긴다(수집기의 upsert = 정정 반영).
 * 내용이 하나도 안 바뀌었으면 prev를 "같은 참조로" 돌려준다 - 호출부가 useState/useMemo로
 * 들고 있을 때 무의미한 리렌더를 막기 위해서.
 */
export function mergeEventRows<T extends { event_order: number }>(prev: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return prev;
  const byOrder = new Map<number, T>();
  for (const r of prev) byOrder.set(r.event_order, r);

  let changed = false;
  for (const r of incoming) {
    const cur = byOrder.get(r.event_order);
    // 얕은 비교로 "정말 바뀐 UPDATE"만 반영 - 폴링이 같은 행을 다시 가져와도 리렌더가 안 난다.
    if (cur === undefined || !shallowSameRow(cur, r)) {
      byOrder.set(r.event_order, r);
      changed = true;
    }
  }
  if (!changed) return prev;

  const out = Array.from(byOrder.values());
  out.sort((a, b) => a.event_order - b.event_order);
  return out;
}

function shallowSameRow(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  // b(새로 들어온 행)의 키만 본다 - realtime payload는 서버 select보다 컬럼이 많고,
  // 반대로 GameReplay가 들고 있는 행은 파생 필드(elapsed/runHome/...)가 더 많다.
  for (const k of Object.keys(b)) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function maxOrder(rows: LiveEventRow[], floor: number): number {
  let m = floor;
  // 배열이 클 수 있어서 Math.max(...rows)로 펼치지 않는다(스택 오버플로 방지).
  for (const r of rows) if (r.event_order > m) m = r.event_order;
  return m;
}

export type UseLiveGameArgs = {
  gmkey: string;
  /** 진행중(deriveGameStatus === "live")일 때만 true - false면 구독/폴링 전부 0. */
  enabled: boolean;
  /** 서버가 렌더한 마지막 event_order(폴링 워터마크의 출발점). */
  initialLastOrder: number;
};

export type UseLiveGameResult = {
  /** 마운트 이후 수신한 행들(정렬·중복 제거 완료). 서버가 이미 준 행은 포함하지 않는다. */
  rows: LiveEventRow[];
  /** games 행에서 온 최신 스코어(배너용). 아직 수신 전이면 null. */
  score: { home: number | null; away: number | null } | null;
  /** is_ended가 true로 뒤집힌 것을 관측했으면 true. */
  ended: boolean;
  /** 이벤트에 등장했지만 서버 렌더 시점엔 없던 pcode의 이름(라이브 교체 투입 선수). */
  lateNames: Record<string, string>;
};

export function useLiveGame({ gmkey, enabled, initialLastOrder }: UseLiveGameArgs): UseLiveGameResult {
  const [rows, setRows] = useState<LiveEventRow[]>([]);
  const [score, setScore] = useState<{ home: number | null; away: number | null } | null>(null);
  const [ended, setEnded] = useState(false);
  const [lateNames, setLateNames] = useState<Record<string, string>>({});
  // transport는 렌더에 쓰지 않는 진단 값이라 React 상태로 들지 않는다(상태로 들면 effect
  // 본문에서 setState를 하게 되고, 이 프로젝트가 이미 지키고 있는
  // react-hooks/set-state-in-effect 규칙과 충돌한다). window.__courtsideLive.transport로 관측.

  const bufRef = useRef<LiveEventRow[]>([]);
  const highOrderRef = useRef(initialLastOrder);
  const lastRealtimeAtRef = useRef(0);
  const knownPcodesRef = useRef<Set<string>>(new Set());
  const pollCountRef = useRef(0);

  // 두 전송 경로의 공통 입구. 여기 말고 setRows를 부르는 곳은 없다.
  const ingest = useCallback((incoming: LiveEventRow[], via: "realtime" | "polling") => {
    if (!incoming.length) return;
    if (via === "realtime") {
      lastRealtimeAtRef.current = Date.now();
      stats.rowsFromRealtime += incoming.length;
    } else {
      stats.rowsFromPolling += incoming.length;
    }
    const merged = mergeEventRows(bufRef.current, incoming);
    if (merged === bufRef.current) return; // 실제 변화 없음(같은 행 재수신)
    bufRef.current = merged;
    highOrderRef.current = maxOrder(merged, highOrderRef.current);
    setRows(merged);
    // 스코어는 games 행보다 이벤트가 먼저 오는 게 보통이라 최신 이벤트로도 갱신.
    const last = merged[merged.length - 1];
    setScore((prev) =>
      prev && prev.home === last.home_score && prev.away === last.away_score
        ? prev
        : { home: last.home_score, away: last.away_score }
    );
  }, []);

  // --- A-1. Realtime 구독 ---------------------------------------------------
  useEffect(() => {
    if (!enabled || ended) return;
    if (realtimeBlocked()) {
      // 폴백 증명 모드 - 구독을 아예 만들지 않는다.
      stats.transport = "polling";
      return;
    }
    stats.transport = "connecting";
    stats.channels += 1;

    const channel = supabase
      .channel(`live-game:${gmkey}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "game_events", filter: `gmkey=eq.${gmkey}` },
        (payload) => {
          stats.realtimeMsgs += 1;
          ingest([payload.new as unknown as LiveEventRow], "realtime");
        }
      )
      .on(
        "postgres_changes",
        // 수집기가 upsert 하므로 UPDATE도 반드시 구독 - 병합이 event_order로 "교체"한다.
        { event: "UPDATE", schema: "public", table: "game_events", filter: `gmkey=eq.${gmkey}` },
        (payload) => {
          stats.realtimeMsgs += 1;
          ingest([payload.new as unknown as LiveEventRow], "realtime");
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `gmkey=eq.${gmkey}` },
        (payload) => {
          stats.realtimeMsgs += 1;
          lastRealtimeAtRef.current = Date.now();
          const g = payload.new as unknown as { home_score: number | null; away_score: number | null; is_ended: boolean };
          setScore({ home: g.home_score, away: g.away_score });
          if (g.is_ended) setEnded(true);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          stats.subscribed += 1;
          lastRealtimeAtRef.current = Date.now();
          stats.transport = "realtime";
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          // 조용히 죽는 경우가 더 흔하지만, 티가 나는 경우엔 즉시 폴링으로 표시.
          stats.transport = "polling";
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [gmkey, enabled, ended, ingest]);

  // --- A-3. 폴링 폴백 -------------------------------------------------------
  // "최근 REALTIME 메시지가 없었으면" 직접 긁는다. 조용히 죽은 웹소켓을 신뢰하지 않는
  // 것이 핵심이라, 소켓 상태 플래그가 아니라 "실제 메시지 도착 시각"을 기준으로 판단한다.
  useEffect(() => {
    if (!enabled || ended) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - lastRealtimeAtRef.current < POLL_MS) {
        stats.pollsSkipped += 1;
        return;
      }
      stats.polls += 1;
      if (stats.transport !== "realtime") stats.transport = "polling";

      // 워터마크(gt event_order)는 새 이벤트만 가져오므로, 수집기가 이미 넣은 행을 정정
      // 재업서트해도(예: 경기 도중 승률 재계산) 폴백 경로에선 영영 반영되지 않는다 - realtime이
      // 죽어 있는 동안 승률 곡선이 옛 값을 계속 들고 있게 된다(실측 지적). 그래서 주기적으로
      // (FULL_REFETCH_EVERY번에 한 번) 워터마크를 버리고 전 구간을 다시 읽는다. mergeEventRows가
      // "정말 바뀐 행"만 반영하므로, 바뀐 게 없으면 리렌더도 나지 않는다.
      pollCountRef.current += 1;
      const fullRefetch = pollCountRef.current % FULL_REFETCH_EVERY === 0;

      let q = supabase.from("game_events").select(LIVE_EVENT_COLUMNS).eq("gmkey", gmkey);
      if (!fullRefetch) q = q.gt("event_order", highOrderRef.current);
      const { data } = await q.order("event_order", { ascending: true });
      if (cancelled) return;
      if (data && data.length) ingest(data as unknown as LiveEventRow[], "polling");

      // 종료 감지도 폴백이 필요하다(realtime이 죽어 있으면 games UPDATE도 안 온다).
      const { data: g } = await supabase
        .from("games")
        .select("home_score, away_score, is_ended")
        .eq("gmkey", gmkey)
        .maybeSingle();
      if (cancelled || !g) return;
      setScore((prev) => (prev && prev.home === g.home_score && prev.away === g.away_score ? prev : { home: g.home_score, away: g.away_score }));
      if (g.is_ended) setEnded(true);
    };

    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gmkey, enabled, ended, ingest]);

  // --- 라이브 도중 처음 등장한 선수 이름 채우기 -----------------------------
  // 진행중 경기는 game_player_stats(공식 박스스코어)가 아직 없어서 서버가 "그 시점 이벤트에
  // 나온 pcode"만 players에서 읽어 이름을 채워 넘긴다. 경기 중 처음 투입되는 선수는 그
  // 목록에 없어서 문자중계가 문자 그대로 "-"로 나온다 - 새 pcode가 보이면 한 번만 조회.
  //
  // 주의(실측 지적으로 고침): 예전엔 조회를 걸기 "전에" knownPcodesRef에 넣고, effect가 다시
  // 돌 때 cleanup이 그 조회를 cancelled로 버렸다. 이 effect는 rows에 의존하므로 이벤트가 하나만
  // 더 들어와도 재실행된다 - 즉 조회가 끝나기 전에 새 이벤트가 오면(라이브에선 거의 항상)
  // 결과가 버려지는데 pcode는 이미 "안다"고 표시돼 있어서 그 선수 이름을 영영 못 채웠다.
  // 이제는 성공했을 때만 known에 넣고, 진행 중인 pcode는 inFlight로 따로 막아 중복 조회만 없앤다.
  const inFlightNamesRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const unknown = new Set<string>();
    for (const r of rows) {
      if (r.pcode && !knownPcodesRef.current.has(r.pcode) && !inFlightNamesRef.current.has(r.pcode)) unknown.add(r.pcode);
    }
    if (unknown.size === 0) return;
    for (const p of unknown) inFlightNamesRef.current.add(p);
    (async () => {
      try {
        const { data } = await supabase.from("players").select("pcode, name").in("pcode", Array.from(unknown));
        if (!data?.length) return; // 실패/빈 결과 - known에 넣지 않으므로 다음 이벤트에서 재시도된다
        for (const r of data) knownPcodesRef.current.add(r.pcode as string);
        if (!mountedRef.current) return;
        setLateNames((prev) => {
          const next = { ...prev };
          for (const r of data) next[r.pcode as string] = r.name as string;
          return next;
        });
      } finally {
        for (const p of unknown) inFlightNamesRef.current.delete(p);
      }
    })();
  }, [rows, enabled]);

  // 종료를 관측하면 전송 계층이 완전히 꺼진다(위 두 effect가 ended에 의존해 스스로 정리).
  // 계측 값 갱신은 렌더 중이 아니라 effect에서(렌더 중 모듈 값 변경 금지 - react-hooks/immutability).
  useEffect(() => {
    if (enabled && ended) stats.transport = "off";
  }, [enabled, ended]);

  return { rows, score, ended, lateNames };
}
