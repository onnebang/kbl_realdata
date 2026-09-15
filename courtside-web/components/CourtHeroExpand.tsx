"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { Court3DShot } from "@/lib/court3d";
import { WidgetBoundary } from "@/components/WidgetBoundary";
import styles from "./court-hero-expand.module.css";

// three.js는 이 컴포넌트가 열릴 때만 필요하다 - 정적 import하면 기본 페이지 번들(팀·선수
// 프로필은 이미 무거운 페이지)에 three 전체가 실린다. next/dynamic + ssr:false로 클릭 전엔
// 요청조차 안 나가게 한다.
const Court3DScene = dynamic(() => import("./Court3DScene").then((m) => m.Court3DScene), {
  ssr: false,
  loading: () => <div className={styles.loading}>코트 불러오는 중…</div>,
});

/**
 * 히어로 슛 지도(밀도 장/별자리)가 "그냥 배경 디자인"으로 보인다는 제보 - 확장 버튼을 누르면
 * 같은 슛 데이터를 진짜 3D 코트에 색으로 찍어 보여준다. 팀·선수 히어로 둘 다 이 컴포넌트를
 * 그대로 쓴다(props만 다름).
 */
export function CourtHeroExpand({
  shots,
  accentColor,
  label = "이 슛 지도를 3D로 보기",
}: {
  shots: Court3DShot[];
  accentColor: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const madeN = shots.filter((s) => s.made).length;

  if (!shots.length) return null;

  return (
    <>
      <button type="button" className={styles.trigger} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <div className={styles.overlay} onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="3D 코트">
          <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.panelHead}>
              <div className={styles.panelTitle}>
                슛 {shots.length.toLocaleString()}개 · 성공 {madeN.toLocaleString()}개({Math.round((madeN / shots.length) * 100)}%)
              </div>
              <button type="button" className={styles.closeBtn} onClick={() => setOpen(false)} aria-label="닫기">
                ✕
              </button>
            </div>
            <div className={styles.canvasWrap}>
              <WidgetBoundary name="3D 코트">
                <Court3DScene shots={shots} accentColor={accentColor} />
              </WidgetBoundary>
            </div>
            <div className={styles.legend}>
              <span>
                <span className={styles.swatchFill} style={{ background: accentColor }} /> 성공
              </span>
              <span>
                <span className={styles.swatchRing} /> 실패
              </span>
              <span className={styles.legendNote}>드래그로 회전 · 스크롤로 확대 - 자동으로는 움직이지 않습니다</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
