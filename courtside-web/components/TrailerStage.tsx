"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import anime from "animejs";
import { AnimatePresence, motion } from "motion/react";
import styles from "@/app/trailer/trailer.module.css";

// 소개 영상의 플레이어. 이 사이트에서 손에 꼽는 클라이언트 컴포넌트인데 그럴 이유가 있다 -
// 장면 전환·카운트업·진행바는 시간을 다루는 일이라 CSS만으로는 안 된다.
//
// 구조: 장면 마크업은 부모(서버 컴포넌트)가 children으로 넘긴다. 이 컴포넌트는 그것을
// 감싸는 무대와 컨트롤만 그리고, 마운트된 뒤에야 .playing을 붙여 문서를 플레이어로 바꾼다.
// 첫 렌더는 서버와 같아야(하이드레이션 불일치 방지) `on`이 false로 시작한다.
//
// 모션의 역할 분담(2026-09-09, anime 엔진이 첫 틱에서 멈춰 화면이 통째로 사라진 사고 뒤):
//   - CSS(trailer.module.css): 가시성에 직결되는 전부. show()는 .isActive 한 클래스만 토글하고
//     헤드라인 리빌·숫자 착지·화면 프레임·문자 스태거는 그 클래스가 붙을 때 키프레임으로 돈다.
//     JS가 한 줄도 안 돌아도 서버 HTML이 곧 완성 화면이다.
//   - anime.js: 카운트업 중간값만. 죽어도 사라지는 건 없다 - 각 숫자에 1,530ms 워치독
//     setTimeout을 걸어 완성값을 다시 쓰고, show()마다 이전 타이머를 전부 지운 뒤 모든
//     숫자를 완성값으로 되돌린다.
//   - motion(motion/react): .playing 크롬 두 곳(HUD 'CUT nn/08' 라벨, 재생/정지 아이콘)의
//     key 스왑 스프링. 콘텐츠 영역에는 쓰지 않는다.
//
// 진행 상태는 React state 대신 ref + DOM 직접 쓰기로 돈다. 60fps로 진행바·샷클락을 밀면서
// 리렌더를 돌릴 이유가 없다. React가 아는 것은 "플레이어 모드인가", "재생 중인가", "몇 번째
// 컷인가"(HUD 라벨용) 셋뿐이다.

const SPRING = { type: "spring", stiffness: 520, damping: 36 } as const;
const COUNT_DELAY = 260;
const COUNT_DUR = 1150;
const COUNT_WATCHDOG = COUNT_DELAY + COUNT_DUR + 120; // 1,530ms - 카운트업이 끝났어야 할 시각

function fmt(el: HTMLElement, value?: number): string {
  const v = value == null ? parseFloat(el.dataset.count ?? "0") : value;
  const dec = parseInt(el.dataset.dec ?? "0", 10);
  return (el.dataset.prefix ?? "") + v.toLocaleString("ko-KR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

export function TrailerStage({ children }: { children: ReactNode }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const ticksRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [on, setOn] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [cut, setCut] = useState("CUT 01/08");
  const playingRef = useRef(true);
  const api = useRef<{ go: (i: number) => void; toggle: () => void } | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // 숫자는 처음부터 완성값. 카운트업은 그 위를 덮어썼다가 같은 값으로 끝난다.
    stage.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
      el.textContent = fmt(el);
    });
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; // 문서 상태로 남는다
    // 의도된 마운트 후 1회 상태 전환 - 서버 HTML(문서)과 첫 클라이언트 렌더를 같게 두고, 붙은 뒤에만 플레이어로.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOn(true);
  }, []);

  // useLayoutEffect다: .playing은 렌더에서 붙고 .isActive는 여기서 붙는데, 페인트 뒤에 돌면
  // "무대는 16:9인데 장면이 전부 visibility:hidden"인 빈 프레임이 한 장 생긴다. 커밋과 같은
  // 프레임에 show(0)을 돌려 그 틈을 없앤다(on이 false인 서버에서는 위 return으로 빠지므로
  // SSR 경고도 나지 않는다).
  useLayoutEffect(() => {
    if (!on) return;
    const stageEl = stageRef.current;
    const ticksEl = ticksRef.current;
    if (!stageEl || !ticksEl) return;
    const stage: HTMLDivElement = stageEl; // 호이스팅되는 function 선언 안에서도 non-null

    const scenes = Array.from(stage.querySelectorAll<HTMLElement>("[data-scene]"));
    const durs = scenes.map((s) => parseInt(s.dataset.dur ?? "5000", 10));
    const total = durs.reduce((a, b) => a + b, 0);
    let idx = 0;
    let sceneStart = performance.now();
    let elapsedBefore = 0;
    let raf = 0;
    let timers: number[] = [];

    // 진행바 칸 = 장면(길이가 시간에 비례). 누르면 그 장면으로 간다.
    ticksEl.replaceChildren();
    const ticks = durs.map((d, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = styles.tick;
      b.style.flexGrow = String(d);
      b.setAttribute("aria-label", `장면 ${i + 1}`);
      b.appendChild(document.createElement("i"));
      b.addEventListener("click", () => go(i));
      ticksEl.appendChild(b);
      return b;
    });

    // 모든 숫자를 완성값으로. 이전 장면의 카운트업이 어디서 죽었든 여기서 정리된다.
    function settle() {
      timers.forEach((t) => clearTimeout(t));
      timers = [];
      stage.querySelectorAll<HTMLElement>("[data-count]").forEach((n) => {
        n.textContent = fmt(n);
      });
    }

    // 카운트업 중간값 - anime의 유일한 일. 워치독이 완성값을 보증한다.
    function countUp(scene: HTMLElement) {
      scene.querySelectorAll<HTMLElement>("[data-count]").forEach((n) => {
        const obj = { v: 0 };
        anime({
          targets: obj,
          v: parseFloat(n.dataset.count ?? "0"),
          duration: COUNT_DUR,
          delay: COUNT_DELAY,
          easing: "cubicBezier(.1,.8,.2,1)",
          update: () => {
            n.textContent = fmt(n, obj.v);
          },
          complete: () => {
            n.textContent = fmt(n);
          },
        });
        timers.push(
          window.setTimeout(() => {
            n.textContent = fmt(n);
          }, COUNT_WATCHDOG),
        );
      });
    }

    function show(i: number) {
      settle();
      scenes.forEach((s, k) => s.classList.toggle(styles.isActive, k === i));
      stage.dataset.q = String(i + 1);
      setCut(`CUT ${pad2(i + 1)}/${pad2(scenes.length)}`);
      ticks.forEach((t, k) => {
        (t.firstChild as HTMLElement).style.inset = k < i ? "0" : "0 100% 0 0";
      });
      countUp(scenes[i]);
    }

    function go(i: number) {
      idx = ((i % scenes.length) + scenes.length) % scenes.length;
      elapsedBefore = durs.slice(0, idx).reduce((a, b) => a + b, 0);
      sceneStart = performance.now();
      show(idx);
      if (!playingRef.current) {
        playingRef.current = true;
        setPlaying(true);
        loop();
      }
    }

    function loop() {
      cancelAnimationFrame(raf);
      const step = (now: number) => {
        if (!playingRef.current) return;
        const t = now - sceneStart;
        const p = Math.min(1, t / durs[idx]);
        (ticks[idx].firstChild as HTMLElement).style.inset = `0 ${100 - p * 100}% 0 0`;
        // 샷클락: 이 장면의 잔여 시간(십분위). 1.0초 아래면 빨갛게.
        const rem = Math.max(0, durs[idx] - t);
        if (clockRef.current) {
          clockRef.current.textContent = `${pad2(Math.floor(rem / 1000))}.${Math.floor((rem % 1000) / 100)}`;
          clockRef.current.classList.toggle(styles.clockLow, rem < 1000);
        }
        if (timeRef.current) timeRef.current.textContent = `${mmss(elapsedBefore + Math.min(t, durs[idx]))} / ${mmss(total)}`;
        if (p >= 1) go(idx + 1);
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }

    function toggle() {
      playingRef.current = !playingRef.current;
      setPlaying(playingRef.current);
      if (playingRef.current) {
        sceneStart = performance.now();
        loop();
      } else cancelAnimationFrame(raf);
    }

    api.current = { go, toggle };

    const onKey = (e: KeyboardEvent) => {
      // 컨트롤에 포커스가 있으면 그 컨트롤의 기본 동작이 이긴다. 이 가드가 없으면 진행바 칸이나
      // '처음부터' 버튼에 탭으로 들어간 뒤 스페이스를 눌렀을 때 버튼이 눌리는 대신 재생만
      // 토글된다(keydown의 preventDefault가 click을 지운다).
      if ((e.target as HTMLElement | null)?.closest("button, a, input, textarea, select, [contenteditable]")) return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowRight") go(idx + 1);
      else if (e.key === "ArrowLeft") go(idx - 1);
    };
    document.addEventListener("keydown", onKey);

    show(0);
    loop();

    return () => {
      cancelAnimationFrame(raf);
      timers.forEach((t) => clearTimeout(t));
      document.removeEventListener("keydown", onKey);
      api.current = null;
    };
  }, [on]);

  return (
    <div ref={stageRef} className={`${styles.stage} ${on ? styles.playing : ""}`}>
      <div className={styles.ruler} aria-hidden="true">
        <span>100</span>
        <span>50</span>
        <span>0</span>
      </div>
      <div className={styles.hud} aria-live="off">
        <span className={`${styles.rec} ${playing ? styles.recOn : ""}`} />
        <span className={styles.q}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={cut} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} transition={SPRING}>
              {cut}
            </motion.span>
          </AnimatePresence>
        </span>
        <span ref={clockRef} className={styles.clock}>
          00.0
        </span>
      </div>

      {children}

      <div className={styles.rail}>
        <button type="button" className={styles.btn} aria-label={playing ? "일시정지" : "재생"} onClick={() => api.current?.toggle()}>
          <AnimatePresence mode="popLayout" initial={false}>
            {playing ? (
              <motion.svg key="pause" viewBox="0 0 12 12" aria-hidden="true" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={SPRING}>
                <rect x="1.5" y="1" width="3" height="10" />
                <rect x="7.5" y="1" width="3" height="10" />
              </motion.svg>
            ) : (
              <motion.svg key="play" viewBox="0 0 12 12" aria-hidden="true" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={SPRING}>
                <path d="M2 1l9 5-9 5z" />
              </motion.svg>
            )}
          </AnimatePresence>
        </button>
        <div ref={ticksRef} className={styles.ticks} />
        <span ref={timeRef} className={styles.time}>
          00:00 / 00:00
        </span>
        <button type="button" className={styles.btn} aria-label="처음부터 다시 재생" onClick={() => api.current?.go(0)}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 1.6V0L3.4 2.2 6 4.4V2.8a3.2 3.2 0 1 1-3.2 3.2H1.6A4.4 4.4 0 1 0 6 1.6z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
