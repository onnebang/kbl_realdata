"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Court3DGroupBy, Court3DProgress } from "./Court3DScene";
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

const fmtSeason = (s: string | null) => (s ? `${s.slice(2, 4)}-${s.slice(7, 9)}` : "");

/**
 * 히어로 슛 지도(밀도 장/별자리)가 "그냥 배경 디자인"으로 보인다는 제보 + "이 영상 같은 느낌"
 * (ESPN 르브론 제임스 커리어 득점 영상) - 확장 버튼을 누르면 같은 슛 데이터가 시즌 순으로
 * 쌓이는 3D 코트가 한 번 재생되고, 끝나면 자유롭게 돌려볼 수 있다.
 */
const GROUP_LABEL: Record<Court3DGroupBy, string> = { team: "팀별", season: "시즌별", quarter: "쿼터별" };

export function CourtHeroExpand({
  shots,
  accentColor,
  label = "이 슛 지도를 3D로 보기",
  teamNameByTcode,
}: {
  shots: Court3DShot[];
  accentColor: string;
  label?: string;
  /** "팀별" 탭 HUD에 tcode 대신 팀 이름을 보여주기 위한 매핑(없으면 tcode 그대로). */
  teamNameByTcode?: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<Court3DProgress | null>(null);
  const [skipToken, setSkipToken] = useState(0);
  const [showMadeArcs, setShowMadeArcs] = useState(true);
  const [showMissedArcs, setShowMissedArcs] = useState(false);
  // 탭은 해당 기준으로 실제로 갈릴 게 있을 때만 보여준다(예: 팀 페이지 슛은 tcode가 전부
  // 같아서 "팀별" 탭이 무의미함).
  const dims = (["team", "season", "quarter"] as const).filter(
    (k) => new Set(shots.map((s) => s[k]).filter(Boolean)).size > 1
  );
  const [filterStr, setFilterStr] = useState<string>("all");

  const [filterType, filterVal] = filterStr === "all" ? ["all", ""] : filterStr.split(":");
  // useMemo로 참조를 고정한다: Court3DScene의 재구성 effect가 [shots, ...]를 의존성으로 보는데,
  // 여기서 매 렌더마다 새 배열을 만들면(재생 중엔 onProgress → setProgress → 리렌더가 계속 도는데)
  // 그때마다 "새 shots"로 인식돼 재생이 처음부터 무한 재시작된다(시즌/쿼터 필터 선택 시 재생이
  // 멈춘 것처럼 보였던 원인 - "전체 보기"는 필터링을 안 해 원본 참조를 그대로 써서 안 걸렸다).
  const filteredShots = useMemo(
    () => (filterStr === "all" ? shots : shots.filter((s) => s[filterType as keyof Court3DShot] === filterVal)),
    [shots, filterStr] // eslint-disable-line react-hooks/exhaustive-deps -- filterType/filterVal은 filterStr에서 파생됨
  );
  // 전체보기일 때는 시즌별 재생, 필터링일 때는 그냥 한번에 렌더링되게 groupBy 제거
  const effectiveGroupBy = filterStr === "all" ? "season" : undefined;


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
  const playing = progress != null && !progress.done;

  if (!shots.length) return null;

  const fmtLabel = (raw: string) =>
    effectiveGroupBy === "season" ? fmtSeason(raw) : effectiveGroupBy === "team" ? (teamNameByTcode?.get(raw) ?? raw) : raw;

  const handleFilterChange = (val: string) => {
    if (val === filterStr) return;
    setFilterStr(val);
    setProgress(null);
    setSkipToken(0);
  };

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => {
          setProgress(null);
          setOpen(true);
        }}
      >
        {label}
      </button>
      {open && (
        <div className={styles.overlay} onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="3D 코트">
          <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.panelHead}>
              <div className={styles.panelTitle}>
                {playing ? (
                  <>
                    {progress?.label && <span className={styles.hudSeason}>{fmtLabel(progress.label)}</span>}
                    필드골 {progress?.pts.toLocaleString()}점 쌓는 중…
                  </>
                ) : (
                  <>
                    슛 {shots.length.toLocaleString()}개 · 성공 {madeN.toLocaleString()}개({Math.round((madeN / shots.length) * 100)}%)
                  </>
                )}
              </div>
              {playing && (
                <button type="button" className={styles.skipBtn} onClick={() => setSkipToken((n) => n + 1)}>
                  건너뛰기
                </button>
              )}
              <button type="button" className={styles.closeBtn} onClick={() => setOpen(false)} aria-label="닫기">
                ✕
              </button>
            </div>
            {true && (
              <div className={styles.tabs}>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <select 
                    value={filterStr} 
                    onChange={(e) => handleFilterChange(e.target.value)}
                    style={{ padding: '4px 10px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.2)', background: 'var(--surface)', color: 'var(--ink)', fontSize: '12px', fontWeight: 600, outline: 'none', cursor: 'pointer' }}
                  >
                    <option value="all">전체 보기 (시즌별 재생)</option>
                    {dims.includes("season") && (
                      <optgroup label="시즌 선택">
                        {Array.from(new Set(shots.map(s => s.season).filter((x): x is string => Boolean(x)))).sort().reverse().map(s => (
                          <option key={`season:${s}`} value={`season:${s}`}>{fmtSeason(s)} 시즌</option>
                        ))}
                      </optgroup>
                    )}
                    {dims.includes("quarter") && (
                      <optgroup label="쿼터 선택">
                        {Array.from(new Set(shots.map(s => s.quarter).filter((x): x is string => Boolean(x)))).sort().map(s => (
                          <option key={`quarter:${s}`} value={`quarter:${s}`}>{s}</option>
                        ))}
                      </optgroup>
                    )}
                    {dims.includes("team") && (
                      <optgroup label="팀 선택">
                        {Array.from(new Set(shots.map(s => s.team).filter((x): x is string => Boolean(x)))).sort().map(s => (
                          <option key={`team:${s}`} value={`team:${s}`}>{teamNameByTcode?.get(s) ?? s}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '12px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--ink-soft)', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showMadeArcs} onChange={(e) => setShowMadeArcs(e.target.checked)} />
                    성공 궤적
                  </label>
                  <label style={{ fontSize: '12px', color: 'var(--ink-soft)', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showMissedArcs} onChange={(e) => setShowMissedArcs(e.target.checked)} />
                    실패 궤적
                  </label>
                </div>
              </div>
            )}
            {playing && (
              <div className={styles.hudBar}>
                <div className={styles.hudBarFill} style={{ transform: `scaleX(${(progress?.shown ?? 0) / Math.max(1, progress?.total ?? 1)})`, background: accentColor }} />
              </div>
            )}
            <div className={styles.canvasWrap}>
              <WidgetBoundary name="3D 코트">
                <Court3DScene shots={filteredShots} accentColor={accentColor} onProgress={setProgress} skipToken={skipToken} groupBy={effectiveGroupBy} showMadeArcs={showMadeArcs} showMissedArcs={showMissedArcs} />
              </WidgetBoundary>
            </div>
            <div className={styles.legend}>
              <span>
                <span className={styles.swatchFill} style={{ background: accentColor }} /> 성공
              </span>
              <span>
                <span className={styles.swatchRing} /> 실패
              </span>
              <span className={styles.legendNote}>
                {playing ? `열 때 한 번, ${effectiveGroupBy ? GROUP_LABEL[effectiveGroupBy] : "순서대로"} 쌓입니다` : "드래그로 회전 · 스크롤로 확대 - 이제부터는 자동으로 움직이지 않습니다"}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
