"use client";

import { useState, type ReactNode } from "react";
import styles from "./PlayerHeroTabs.module.css";

// 모바일·데스크톱 모두 탭으로 전환(요청: "PC 화면에서도 나눠주고"). 데이터가 없는 패널
// (예: OVR 이력 없음)은 처음부터 탭 목록에서 빠진다 - 그래서 여기 로직은 "필터링"이지
// "감추기"가 아니다. 탭이 하나뿐이면 탭바 자체를 안 그린다(전환할 게 없으므로).
const LABELS = { ovr: "시즌 오버롤", awards: "수상 내역", trophy: "업적 · 트로피" } as const;
type TabId = keyof typeof LABELS;

interface Props {
  ovrTrend: ReactNode | null;
  awards: ReactNode | null;
  trophyRoom: ReactNode | null;
}

export default function PlayerHeroTabs({ ovrTrend, awards, trophyRoom }: Props) {
  const content: Record<TabId, ReactNode | null> = { ovr: ovrTrend, awards, trophy: trophyRoom };
  const tabIds = (Object.keys(LABELS) as TabId[]).filter((id) => content[id] != null);
  const [active, setActive] = useState<TabId | undefined>(tabIds[0]);
  const current = active && tabIds.includes(active) ? active : tabIds[0];

  if (!current) return null;

  return (
    <div className={styles.wrap}>
      {tabIds.length > 1 && (
        <div className={styles.tabBar} role="group" aria-label="시즌 오버롤 · 수상 · 업적 전환">
          {tabIds.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={current === id}
              className={`${styles.tab} ${current === id ? styles.tabActive : ""}`}
              onClick={() => setActive(id)}
            >
              {LABELS[id]}
            </button>
          ))}
        </div>
      )}
      {tabIds.map((id) => (
        <div key={id} className={current === id ? styles.panelActive : styles.panelHidden}>
          {content[id]}
        </div>
      ))}
    </div>
  );
}
