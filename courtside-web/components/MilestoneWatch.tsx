"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { BoxLine } from "@/lib/boxEvents";
import { CAT_TEXT, evaluateApproaching, gameStatsFromBox, type MilestoneContext, type MilestoneItem, type MilestoneMoment } from "@/lib/milestones";
import { isLinkablePcode } from "@/lib/onCourtCards";
import styles from "./MilestoneWatch.module.css";

// 라이브 "기록 워치"(요청 2026-10-07) - 이 경기에서 올타임/현역 순위 돌파, 100개 단위 통산 이정표, 커리어 하이를
// 달성했거나 곧 달성할 선수. 달성은 이벤트 타임라인(lib/milestones.ts buildMilestoneTimeline)에서 스크럽 위치까지의
// 것만, 임박은 스크럽 시점 박스로 매번 다시 계산한다(재생·되감기·라이브 모두 같은 화면 규칙).

type TeamDot = { abbr: string; color: string } | null;

function Row({ item, clock, team, badge }: { item: MilestoneItem; clock?: string; team: TeamDot; badge?: boolean }) {
  const linkable = isLinkablePcode(item.pcode);
  return (
    <li className={styles.row}>
      <span className={styles.dot} style={team ? { background: team.color } : undefined} aria-hidden="true" />
      <div>
        <div className={styles.headline}>
          {linkable ? (
            <Link href={`/players/${item.pcode}`} className={styles.name}>
              {item.name}
            </Link>
          ) : (
            <span className={styles.name}>{item.name}</span>
          )}{" "}
          {item.text}
        </div>
        <div className={styles.detail}>
          {clock ? <span className={styles.clock}>{clock}</span> : null}
          {item.detail}
        </div>
      </div>
      {badge ? (
        <span className={`${styles.badge} ${item.remaining <= 2 ? styles.hot : ""}`}>
          {item.remaining}
          {CAT_TEXT[item.cat].unit}
        </span>
      ) : null}
    </li>
  );
}

export function MilestoneWatch({
  ctx,
  moments,
  idx,
  box,
  teamOf,
  hideNear = false,
  appeared,
}: {
  ctx: MilestoneContext;
  /** buildMilestoneTimeline 결과(경기 전체). */
  moments: MilestoneMoment[];
  /** 지금 보고 있는 이벤트 인덱스. */
  idx: number;
  /** GameReplay가 이미 계산한 스크럽 시점 박스스코어. */
  box: ReadonlyMap<string, BoxLine>;
  teamOf: (pcode: string, tcode?: string) => TeamDot;
  /** 끝난 경기를 맨 끝까지 본 상태 - 더 이룰 수 없는 "임박"은 숨기고 달성만 보여준다. */
  hideNear?: boolean;
  /** 지금까지 코트에 나온 선수인지 - 경기가 시작된 뒤(idx > 0)엔 안 나온 벤치 선수의 "임박"은 뺀다(끝난 경기를 되감을 때 결장자 잡음 방지). 경기 전(idx 0)엔 전원. */
  appeared?: (pcode: string) => boolean;
}) {
  const done = useMemo(() => moments.filter((m) => m.phase === "done" && m.idx <= idx).reverse(), [moments, idx]);
  const near = useMemo(
    () => (hideNear ? [] : evaluateApproaching(ctx, (pcode) => gameStatsFromBox(box.get(pcode)), { include: idx > 0 && appeared ? appeared : undefined })),
    [ctx, box, hideNear, idx, appeared]
  );
  if (done.length === 0 && near.length === 0) return null;

  return (
    <div className={styles.wrap}>
      <div className="panel-title">기록 워치</div>
      <p className={styles.sub}>
        {ctx.split === "regular" ? "정규리그" : "플레이오프"} 통산 기준 · 순위는 올타임 리더스와 같은 기준 · 합계는 이 경기 직전까지
      </p>
      {done.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>🏅 달성</div>
          <ul className={styles.list}>
            {done.map((m) => (
              <Row key={`${m.id}:${m.phase}`} item={m} clock={m.clock} team={teamOf(m.pcode, ctx.players[m.pcode]?.tcode)} />
            ))}
          </ul>
        </div>
      )}
      {near.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>⏳ 임박</div>
          <ul className={styles.list}>
            {near.map((m) => (
              <Row key={`${m.id}:near`} item={m} team={teamOf(m.pcode, ctx.players[m.pcode]?.tcode)} badge />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
