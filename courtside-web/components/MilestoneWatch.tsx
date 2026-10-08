"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { BoxLine } from "@/lib/boxEvents";
import { basisNote, CAT_TEXT, evaluateApproaching, gameStatsFromBox, type MilestoneContext, type MilestoneItem, type MilestoneMoment } from "@/lib/milestones";
import { isLinkablePcode } from "@/lib/onCourtCards";
import { doneUpTo, nearAt, type RecordMoment } from "@/lib/records";
import styles from "./MilestoneWatch.module.css";

// 라이브 "기록 워치"(요청 2026-10-07) - 이 경기에서 올타임/현역 순위 돌파, 100개 단위 통산 이정표, 커리어 하이를
// 달성했거나 곧 달성할 선수. 달성은 이벤트 타임라인(lib/milestones.ts buildMilestoneTimeline)에서 스크럽 위치까지의
// 것만, 임박은 스크럽 시점 박스로 매번 다시 계산한다(재생·되감기·라이브 모두 같은 화면 규칙).
//
// 같은 패널 맨 위에 "🏆 역대 기록"(요청 2026-10-08) - KBL 역대 TOP10(쿼터·경기·연장별 최다/최소 기록)에 닿았거나 닿을 선수·팀.
// lib/records.ts buildRecordTimeline이 만든 타임라인에서 스크럽 위치까지의 달성과 그 위치에서 유효한 임박을 그대로 보여준다.

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

/** 역대 기록 한 줄 - 선수는 프로필 링크, 팀은 이름만. 라이브(잠정)면 상세 앞에 "잠정"을 붙인다. */
function RecordRow({ m, team, badge }: { m: RecordMoment; team: TeamDot; badge?: boolean }) {
  const linkable = m.scope === "p" && isLinkablePcode(m.subject);
  const unit = m.board.split(".")[1] === "pts" ? "점" : "개";
  return (
    <li className={styles.row}>
      <span className={styles.dot} style={team ? { background: team.color } : undefined} aria-hidden="true" />
      <div>
        <div className={styles.headline}>
          {linkable ? (
            <Link href={`/players/${m.subject}`} className={styles.name}>
              {m.name}
            </Link>
          ) : (
            <span className={styles.name}>{m.name}</span>
          )}{" "}
          {m.text}
        </div>
        <div className={styles.detail}>
          <span className={styles.clock}>{m.clock}</span>
          {m.provisional && m.phase === "done" ? "잠정 · " : ""}
          {m.detail}
        </div>
      </div>
      {badge ? (
        <span className={`${styles.badge} ${m.remaining <= 2 ? styles.hot : ""}`}>
          {m.remaining}
          {unit}
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
  records = [],
  recordTeamOf,
}: {
  /** 통산 기록 재료 - 없으면(전시경기·스냅샷 공백 등) 통산 그룹만 빠지고 역대 기록 그룹은 그대로 나온다. */
  ctx: MilestoneContext | null;
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
  /** buildRecordTimeline 결과(경기 전체) - 역대 기록 그룹. */
  records?: RecordMoment[];
  recordTeamOf?: (tcode: string | null) => TeamDot;
}) {
  const done = useMemo(() => moments.filter((m) => m.phase === "done" && m.idx <= idx).reverse(), [moments, idx]);
  const near = useMemo(
    () => (hideNear || !ctx ? [] : evaluateApproaching(ctx, (pcode) => gameStatsFromBox(box.get(pcode)), { include: idx > 0 && appeared ? appeared : undefined })),
    [ctx, box, hideNear, idx, appeared]
  );
  const recordDone = useMemo(() => doneUpTo(records, idx), [records, idx]);
  const recordNear = useMemo(() => (hideNear ? [] : nearAt(records, idx)), [records, idx, hideNear]);
  if (done.length === 0 && near.length === 0 && recordDone.length === 0 && recordNear.length === 0) return null;

  return (
    <div className={styles.wrap}>
      <div className="panel-title">기록 워치</div>
      {ctx && <p className={styles.sub}>{basisNote(ctx.split)}</p>}
      {(recordDone.length > 0 || recordNear.length > 0) && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>🏆 역대 기록</div>
          <p className={styles.sub}>KBL 역대 TOP10 기준 · 정규시즌·플레이오프 합산 · 공식 기록과 대조를 통과한 경기만 집계 · 라이브 중에는 잠정</p>
          <ul className={styles.list}>
            {recordDone.map((m) => (
              <RecordRow key={m.id} m={m} team={recordTeamOf ? recordTeamOf(m.tcode) : null} />
            ))}
            {recordNear.map((m) => (
              <RecordRow key={m.id} m={m} team={recordTeamOf ? recordTeamOf(m.tcode) : null} badge />
            ))}
          </ul>
        </div>
      )}
      {done.length > 0 && ctx && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>🏅 달성</div>
          <ul className={styles.list}>
            {done.map((m) => (
              <Row key={`${m.id}:${m.phase}`} item={m} clock={m.clock} team={teamOf(m.pcode, ctx.players[m.pcode]?.tcode)} />
            ))}
          </ul>
        </div>
      )}
      {near.length > 0 && ctx && (
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
