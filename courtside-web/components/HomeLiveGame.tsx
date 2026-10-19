"use client";

// 홈의 라이브 카드는 예전에는 30초마다 router.refresh()로 페이지 전체 RSC를 다시 받았다.
// 경기일에 열린 탭 하나가 시간당 120번 Vercel Function을 호출하는 구조였다. 이 Provider는
// 브라우저가 Supabase Realtime에 직접 붙어 점수/승률만 바꾼다. Realtime이 막힌 환경의 60초
// 폴백도 Supabase Data API로 직접 가므로 Vercel Function/Origin Transfer를 쓰지 않는다.

import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

type LiveValue = {
  home: number | null;
  away: number | null;
  homeWinProb: number | null;
  ended: boolean;
};

type LiveEvent = {
  event_order: number;
  home_score: number | null;
  away_score: number | null;
  home_win_prob: number | null;
};

type LiveGame = {
  home_score: number | null;
  away_score: number | null;
  is_ended: boolean;
};

const HomeLiveContext = createContext<LiveValue | null>(null);
const POLL_MS = 60_000;
const REALTIME_FRESH_MS = 90_000;

function sameValue(a: LiveValue, b: LiveValue): boolean {
  return a.home === b.home && a.away === b.away && a.homeWinProb === b.homeWinProb && a.ended === b.ended;
}

export default function HomeLiveProvider({
  gmkey,
  initialHome,
  initialAway,
  initialHomeWinProb,
  children,
}: {
  gmkey: string;
  initialHome: number | null;
  initialAway: number | null;
  initialHomeWinProb?: number;
  children: ReactNode;
}) {
  const [value, setValue] = useState<LiveValue>({
    home: initialHome,
    away: initialAway,
    homeWinProb: initialHomeWinProb ?? null,
    ended: false,
  });
  const router = useRouter();
  const refreshedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let disposeChannel: (() => void) | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let lastRealtimeAt = 0;
    let highEventOrder = -1;

    const applyEvent = (row: LiveEvent, realtime: boolean) => {
      if (realtime) lastRealtimeAt = Date.now();
      if (!Number.isFinite(row.event_order) || row.event_order < highEventOrder) return;
      highEventOrder = Math.max(highEventOrder, row.event_order);
      setValue((prev) => {
        const next = {
          ...prev,
          home: row.home_score,
          away: row.away_score,
          homeWinProb: row.home_win_prob ?? prev.homeWinProb,
        };
        return sameValue(prev, next) ? prev : next;
      });
    };

    const applyGame = (game: LiveGame, realtime: boolean) => {
      if (realtime) lastRealtimeAt = Date.now();
      setValue((prev) => {
        const next = {
          ...prev,
          home: game.home_score,
          away: game.away_score,
          ended: game.is_ended,
        };
        return sameValue(prev, next) ? prev : next;
      });
    };

    const start = async () => {
      // 홈에 라이브 경기가 없을 때는 @supabase/supabase-js 청크 자체를 받지 않는다.
      const { supabase } = await import("@/lib/supabase");
      if (cancelled) return;

      const catchUp = async () => {
        const queryStartedAt = Date.now();
        const [{ data: event }, { data: game }] = await Promise.all([
          supabase
            .from("game_events")
            .select("event_order, home_score, away_score, home_win_prob")
            .eq("gmkey", gmkey)
            .order("event_order", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase.from("games").select("home_score, away_score, is_ended").eq("gmkey", gmkey).maybeSingle(),
        ]);
        if (cancelled) return;
        if (event) applyEvent(event as LiveEvent, false);
        // 조회 중 더 최신 Realtime 메시지가 왔다면 낡은 games 스냅샷으로 점수를 되돌리지 않는다.
        // 종료 플래그만은 한 번 관측하면 반드시 새 서버 렌더로 전환해야 하므로 예외다.
        if (game && (lastRealtimeAt <= queryStartedAt || game.is_ended)) applyGame(game as LiveGame, false);
      };

      const channel = supabase
        .channel(`home-live:${gmkey}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "game_events", filter: `gmkey=eq.${gmkey}` },
          (payload) => applyEvent(payload.new as unknown as LiveEvent, true)
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "game_events", filter: `gmkey=eq.${gmkey}` },
          (payload) => applyEvent(payload.new as unknown as LiveEvent, true)
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "games", filter: `gmkey=eq.${gmkey}` },
          (payload) => applyGame(payload.new as unknown as LiveGame, true)
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") lastRealtimeAt = Date.now();
        });

      disposeChannel = () => {
        void supabase.removeChannel(channel);
      };

      // 서버 렌더와 구독 완료 사이에 들어온 이벤트를 한 번 따라잡는다.
      void catchUp();
      pollId = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        if (Date.now() - lastRealtimeAt < REALTIME_FRESH_MS) return;
        void catchUp();
      }, POLL_MS);
    };

    void start().catch((error: unknown) => {
      // 초기 HTML의 점수는 그대로 남는다. 라이브 전송 실패가 홈 전체 오류가 되면 안 된다.
      console.warn("[home-live] 실시간 점수 연결 실패", error);
    });

    return () => {
      cancelled = true;
      if (pollId) clearInterval(pollId);
      disposeChannel?.();
    };
  }, [gmkey]);

  // 경기 종료 때만 한 번 서버를 다시 그려 결과 배지/MVP/태그를 연다. 예전의 30초 주기 새로고침은
  // 사라지고, 한 경기당 열린 탭에서 최대 한 번만 Vercel Function을 호출한다.
  useEffect(() => {
    if (!value.ended || refreshedRef.current) return;
    refreshedRef.current = true;
    router.refresh();
  }, [router, value.ended]);

  return <HomeLiveContext.Provider value={value}>{children}</HomeLiveContext.Provider>;
}

function useHomeLive(): LiveValue {
  const value = useContext(HomeLiveContext);
  if (!value) throw new Error("HomeLiveScore는 HomeLiveProvider 안에서만 사용할 수 있습니다.");
  return value;
}

export function HomeLiveScore({ href }: { href: string }) {
  const { home, away } = useHomeLive();
  return (
    <Link href={href} className="game-card-score" prefetch={false}>
      <span>{home ?? "-"}</span>
      <span className="score-sep">-</span>
      <span>{away ?? "-"}</span>
    </Link>
  );
}

export function HomeLiveProbability({ homeAbbr, awayAbbr }: { homeAbbr?: string; awayAbbr?: string }) {
  const { homeWinProb } = useHomeLive();
  if (homeWinProb == null) return null;
  const home = Math.round(homeWinProb * 100);
  return (
    <span className="game-card-meta-item live-prob">
      실시간 예측 승률 {homeAbbr} {home}% · {awayAbbr} {100 - home}%
    </span>
  );
}
