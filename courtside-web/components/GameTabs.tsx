"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { GAME_TABS, type GameTabId } from "@/lib/gameTabs";
import styles from "./GameTabs.module.css";

// 경기 페이지의 세 화면(경기 전 / 실시간 중계 / 경기 후 AI 분석)을 탭으로 나눈다(요청: "페이지가 너무
// 길다"). 매치업 배너는 이 컴포넌트 바깥(page.tsx)에서 항상 보이고, 여기는 탭 바 + 패널 셋뿐이다.
//
// 패널 셋은 **전부 마운트해 두고** 비활성만 hidden으로 감춘다 - 언마운트하면 GameReplay의 상태(스크러버
// 위치, "라이브 따라가는 중")와 라이브 구독이 탭을 바꿀 때마다 초기화된다. 셋 다 서버에서 이미 렌더되는
// 내용이라 감춰도 전송량은 그대로다.
//
// 첫 탭(initialTab)은 서버가 ?tab=/경기 상태로 정해 내려준다(lib/gameTabs.ts) - 첫 렌더부터 맞아서
// 깜빡임이 없고, 이 파일은 렌더 중에 window를 만지지 않는다.

interface Props {
  pre: ReactNode;
  live: ReactNode;
  post: ReactNode;
  initialTab: GameTabId;
  /** false면 탭은 눌러 볼 수 있지만 흐리게 보인다(그 패널에는 "언제 열린다"는 안내가 들어 있다). */
  available: Record<GameTabId, boolean>;
  /** 진행 중이면 실시간 중계 탭에 점멸 점. */
  isLive: boolean;
}

export default function GameTabs({ pre, live, post, initialTab, available, isLive }: Props) {
  const panels: Record<GameTabId, ReactNode> = { pre, live, post };
  const [active, setActive] = useState<GameTabId>(initialTab);
  // 탭 바가 화면 위에 붙어 있는지(아래 IntersectionObserver). 제자리(배너가 보이는 맨 위)면 false.
  const [stuck, setStuck] = useState(false);
  const uid = useId();
  const barRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<GameTabId, HTMLButtonElement | null>>>({});
  const prevActive = useRef(active);

  const show = useCallback((id: GameTabId) => {
    setActive(id);
    // 주소만 바꾼다(페이지 이동 없음 - Next 문서가 말하는 네이티브 History API 사용법 그대로, 라우터의
    // URL 상태에만 반영된다). 링크를 공유하면 같은 탭이 열린다. 기본 탭이어도 항상 붙인다: 경기가 끝나
    // 서버가 다시 그리면(LiveGameTransport의 router.refresh) 이 컴포넌트가 새로 마운트되는데, 그때
    // 사용자가 고른 탭을 주소가 붙들어 준다.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", id);
    window.history.replaceState(null, "", url);
  }, []);

  // 사용자가 탭을 눌렀을 때. 본문을 한참 내려 본 상태(탭 바가 화면 위에 붙은 상태)에서 다른 탭으로 가면
  // 그 탭의 맨 위부터 보이게 한다 - 안 그러면 짧은 패널로 바뀌면서 스크롤이 패널 중간이나 맨 아래에 걸린다.
  // 페이지 맨 위에서, 그리고 이미 열린 탭을 다시 누를 때는 아무것도 움직이지 않는다.
  const select = useCallback(
    (id: GameTabId) => {
      const top = sentinelRef.current?.getBoundingClientRect().top ?? 0;
      if (top < 0 && id !== active) window.scrollBy({ top });
      show(id);
    },
    [active, show],
  );

  useEffect(() => {
    // 좁은 화면에서 탭 바가 가로로 넘칠 때 고른 탭이 화면 밖에 남지 않게 가운데로(넘치지 않으면 무동작).
    const bar = barRef.current;
    const tab = tabRefs.current[active];
    if (bar && tab) bar.scrollLeft = tab.offsetLeft - (bar.clientWidth - tab.offsetWidth) / 2;

    if (prevActive.current === active) return;
    prevActive.current = active;
    // 숨겨져 있던 패널이 나타났다 - GameReplay의 고정 재생바는 스크롤/리사이즈 때만 "패널이 화면에 걸쳤나"를
    // 다시 재는데, hidden 동안 잰 값(위치 0)이 남아 있다. 탭을 바꾼 직후에도 바로 다시 재도록 알린다.
    window.dispatchEvent(new Event("resize"));
  }, [active]);

  // 경기 후 탭의 AI 리포트에 있는 시간 언급(data-jump-idx)은 GameReplay가 document 클릭 위임으로 받아
  // 재생 위치를 옮기고 리플레이 패널로 스크롤한다. 그 패널이 hidden이면 스크롤할 박스가 없어 아무 일도
  // 안 일어난다 - 그래서 캡처 단계(GameReplay의 버블 리스너보다 먼저)에서 실시간 중계 탭부터 연다.
  // flushSync: 다음 리스너가 돌기 전에 패널이 이미 화면에 있어야 한다. 스크롤은 여기서 안 건드린다 -
  // 곧이어 GameReplay가 리플레이 패널로 스크롤한다(select가 아니라 show).
  useEffect(() => {
    if (active === "live" || !available.live) return;
    const onClick = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-jump-idx]")) flushSync(() => show("live"));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [active, available.live, show]);

  // 탭 바가 제자리인지 화면 위에 붙었는지 - 붙었을 때만 GameReplay의 고정 점수·재생바를 보인다(CSS
  // 참고). 안 그러면 실시간 탭을 열자마자 그 바가 내비/배너/뒤로가기 링크를 덮고, 바로 아래 점수판과
  // 같은 점수가 두 겹으로 보인다.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return; // Alt+←(뒤로가기) 등 브라우저 단축키는 건드리지 않는다.
    const n = GAME_TABS.length;
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % n;
    else if (e.key === "ArrowLeft") next = (i + n - 1) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    select(GAME_TABS[next].id); // 패널 전환이 즉시라서 포커스를 따라 바로 활성화한다(WAI-ARIA 자동 활성화).
    tabRefs.current[GAME_TABS[next].id]?.focus();
  }

  return (
    <div className={styles.tabs} data-stuck={stuck ? "" : undefined}>
      <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
      <div ref={barRef} role="tablist" aria-label="경기 화면 전환" className={styles.bar}>
        {GAME_TABS.map((t, i) => {
          const selected = active === t.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${uid}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              data-empty={available[t.id] ? undefined : ""}
              className={styles.tab}
              onClick={() => select(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {t.id === "live" && isLive && <span className="live-dot" aria-hidden="true" />}
              {t.label}
              {t.id === "live" && isLive && <span className={styles.srOnly}> (진행 중)</span>}
            </button>
          );
        })}
      </div>
      {GAME_TABS.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${uid}-panel-${t.id}`}
          aria-labelledby={`${uid}-tab-${t.id}`}
          hidden={active !== t.id}
        >
          {panels[t.id]}
        </div>
      ))}
    </div>
  );
}
