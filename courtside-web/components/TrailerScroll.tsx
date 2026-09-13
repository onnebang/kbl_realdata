"use client";

import { useEffect } from "react";
import styles from "@/app/trailer/trailer.module.css";

// 소개 페이지(/trailer)의 스크롤 장치. 렌더하는 마크업은 없다 - 서버가 낸 문서 위에서 두 가지만 한다.
//
//   (1) 절이 화면에 들어오면 .in을 붙인다. 리빌 애니메이션은 전부 CSS가 그 클래스에서 발화한다.
//   (2) 현재 절의 레일 링크에 aria-current를 세운다.
//
// 이 컴포넌트가 한 줄도 안 돌아도 페이지는 성립한다. 시작값(opacity 0 등)을 정적 CSS에 두지
// 않았기 때문에 .in이 없으면 그냥 전부 보이는 상태이고, 레일은 원래부터 평범한 앵커 링크다.
// 지난 두 번의 사고(anime.js·motion 엔진이 첫 틱에서 멈춰 화면이 통째로 사라짐)가 그 규칙을
// 만들었다 - 가시성을 자바스크립트 틱에 걸지 않는다.
//
// 의존성 0. 자동 재생 플레이어였을 때 쓰던 animejs·motion은 이 전환에서 걷어냈다.

export function TrailerScroll() {
  useEffect(() => {
    const scenes = Array.from(document.querySelectorAll<HTMLElement>("[data-scene]"));
    if (!scenes.length) return;

    const links = new Map<string, HTMLAnchorElement>();
    document.querySelectorAll<HTMLAnchorElement>("[data-rail]").forEach((a) => {
      const id = a.getAttribute("href")?.slice(1);
      if (id) links.set(id, a);
    });

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers: number[] = [];

    // 리빌: 한 번 들어오면 그걸로 끝이다(나갈 때 되돌리지 않는다 - 위로 스크롤할 때 글자가
    // 다시 사라지면 읽던 사람을 방해한다). 모션을 원치 않으면 관찰 자체를 하지 않는다.
    let revealObserver: IntersectionObserver | null = null;
    if (!reduce) {
      revealObserver = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            e.target.classList.add(styles.in);
            revealObserver?.unobserve(e.target);
            // 워치독. 리빌은 시작값이 opacity 0이라, 애니메이션 시계가 멈춘 환경(백그라운드 탭,
            // 헤드리스 캡처, 일부 임베디드 뷰)에서는 .in을 붙인 순간 그 절이 통째로 안 보이게 된다.
            // 가장 긴 지연(400ms) + 가장 긴 길이(760ms)보다 넉넉히 뒤에 애니메이션을 끄고 제자리로
            // 돌려놓는다 - 못 본 모션은 잃어도 되지만 안 보이는 내용은 안 된다.
            timers.push(window.setTimeout(() => e.target.classList.add(styles.settled), 1600));
          }
        },
        // 절의 12%가 보이면 시작. 화면 한가운데까지 기다리면 짧은 절이 영영 안 켜진다.
        { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
      );
      scenes.forEach((s) => revealObserver?.observe(s));
    }

    // 레일 표시: 뷰포트 위쪽 35% 지점을 지나는 절을 "현재"로 본다.
    let current = "";
    const mark = () => {
      const line = window.innerHeight * 0.35;
      let id = scenes[0].id;
      for (const s of scenes) {
        if (s.getBoundingClientRect().top <= line) id = s.id;
      }
      if (id === current) return;
      const prev = links.get(current);
      if (prev) prev.removeAttribute("aria-current");
      const next = links.get(id);
      if (next) next.setAttribute("aria-current", "true");
      current = id;
    };

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        mark();
      });
    };
    mark();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    return () => {
      revealObserver?.disconnect();
      timers.forEach((t) => clearTimeout(t));
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return null;
}
