"use client";

import { Fragment, memo } from "react";
import Link from "next/link";
import { PlayerPhoto } from "./PlayerPhoto";
import { TeamBadge } from "./TeamBadge";
import { teamBarStyle, teamInkStyle } from "@/lib/teamAccent";
import { isLinkablePcode, ovrTier, type OnCourtCardPlayer, type OnCourtCardTeam } from "@/lib/onCourtCards";
import styles from "./OnCourtCards.module.css";

// "코트 위" 패널의 게임식 라인업 - 지금 스크럽 시점에 코트에 있는 선수를 프로필 카드(사진·OVR·플레이 스타일)로.
// 데이터는 전부 props(GameReplay가 이미 계산한 homeOnCourt/awayOnCourt·box·liveSec에서 lib/onCourtCards.ts가 만든 것)로
// 받는 프레젠테이션 컴포넌트다. lib/ovr.ts·OVR JSON은 여기서 import하지 않는다(브라우저 번들 - 서버가 cardInfo prop으로 내려줌).

const POS_KO = { G: "가드", F: "포워드", C: "센터" } as const;

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 띄어쓰기 없는 긴 스타일명("플레이메이커")은 폰 폭에서 카드 밖으로 넘친다 - 가운데에 줄바꿈 후보를 둔다(넓을 땐 한 줄 그대로). */
function softBreak(label: string) {
  if (label.length < 5 || label.includes(" ")) return label;
  const mid = Math.floor(label.length / 2);
  return (
    <>
      {label.slice(0, mid)}
      <wbr />
      {label.slice(mid)}
    </>
  );
}

function Card({ p, topTitle }: { p: OnCourtCardPlayer; topTitle: string }) {
  const info = p.info;
  const ovr = info?.ovr ?? null;
  const off = info?.off ?? null;
  const def = info?.def ?? null;
  const pos = info?.position ?? null;
  const style1 = info?.archetype ?? null;
  const style2 = info?.archetype2 ?? null;
  const tier = ovr == null ? "none" : ovrTier(ovr);
  const ovrText = ovr == null ? "OVR 없음" : `OVR ${ovr}`;
  // 사진 대체 텍스트 = 카드 한 줄 요약(이름, OVR, 스타일). 폰 폭에서는 OFF/DEF·보조 스타일이 숨겨지므로 여기에 같이 싣는다.
  const label = [p.name, ovrText, style1, style2 && `보조 ${style2}`, off != null && def != null ? `공격 ${off} 수비 ${def}` : null].filter(Boolean).join(", ");
  const sec = Math.max(0, Math.round(p.sec));

  // 하위 요소는 항상 같은 6칸을 렌더한다(비어 있어도). 카드 안쪽이 부모 그리드의 subgrid라서 칸 수가 카드마다
  // 같아야 이름·칩·스탯 줄이 다섯 카드에 걸쳐 가로로 정렬된다.
  return (
    <li className={styles.card}>
      <div className={styles.portrait}>
        {p.photoUrl ? (
          <PlayerPhoto src={p.photoUrl} alt={label} size={48} className={styles.img} />
        ) : (
          <span className={styles.initial} role="img" aria-label={label}>
            {p.name.slice(0, 1) || "?"}
          </span>
        )}
        {pos && (
          <span className={styles.pos} role="img" aria-label={POS_KO[pos]}>
            {pos}
          </span>
        )}
        <span className={`${styles.ovr} ${styles[tier]}`} role="img" aria-label={ovrText}>
          {ovr ?? "-"}
        </span>
        {p.backNum && <span className={styles.num}>#{p.backNum}</span>}
        {p.isTop && (
          <span className={styles.star} role="img" aria-label={topTitle} title={topTitle}>
            ⭐
          </span>
        )}
      </div>

      <div className={styles.name} title={p.name}>
        {isLinkablePcode(p.pcode) ? <Link href={`/players/${p.pcode}`}>{p.name}</Link> : p.name}
      </div>

      <div className={styles.chips}>
        {style1 && <span className={styles.main}>{softBreak(style1)}</span>}
        {style2 && <span className={styles.sub}>{softBreak(style2)}</span>}
      </div>

      <div className={styles.od}>
        {off != null && (
          <span>
            OFF<b>{off}</b>
          </span>
        )}
        {def != null && (
          <span>
            DEF<b>{def}</b>
          </span>
        )}
      </div>

      <div className={styles.stat} role="img" aria-label={`${p.pts}점 ${p.reb}리바운드 ${p.ast}어시스트`}>
        <span>
          <b>{p.pts}</b>
          <i>점</i>
        </span>
        <span>
          <b>{p.reb}</b>
          <i>
            리<span className={styles.more}>바</span>
          </i>
        </span>
        <span>
          <b>{p.ast}</b>
          <i>
            어<span className={styles.more}>시</span>
          </i>
        </span>
      </div>

      <div className={styles.meta}>
        <span className={styles.min} role="img" aria-label={`출전 ${Math.floor(sec / 60)}분 ${sec % 60}초`} title="지금까지 코트 위에 있던 시간">
          <span className={styles.more}>출전 </span>
          {mmss(sec)}
        </span>
        {p.fouls >= 4 && (
          <span className={styles.foul} role="img" aria-label={`개인 파울 ${p.fouls}개`}>
            파울 {p.fouls}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * 홈(위)·원정(아래) 두 줄, 줄마다 코트 위 선수 카드. key=pcode라 교체로 새로 들어온 선수만 CSS로 살짝 나타난다.
 * 두 팀 모두 코트에 아무도 없으면: 경기 시작 전이면 안내 문구, 그 밖(경기 종료 - 아래 표가 "경기 종료 · 최종 기록"이라 말한다)이면 아무것도 안 그린다.
 */
export const OnCourtCards = memo(function OnCourtCards({ teams, pre, topTitle }: { teams: OnCourtCardTeam[]; pre: boolean; topTitle: string }) {
  const shown = teams.map((t, i) => ({ t, i })).filter(({ t }) => t.players.length > 0);
  if (shown.length === 0) return pre ? <p className={styles.note}>경기 시작 전 — 선발 명단 대기 중</p> : null;
  const caption = pre ? "선발 라인업" : "지금 코트 위";
  return (
    <div className={styles.court} role="group" aria-label="코트 위 선수 카드">
      {shown.map(({ t, i }, n) => (
        <Fragment key={t.tcode}>
          {n > 0 && <div className={styles.mid} aria-hidden="true" />}
          <section className={`${styles.half} ${i === 0 ? styles.home : styles.away}`} style={{ ...teamBarStyle(t.color), ...teamInkStyle(t.color) }}>
            <header className={styles.head}>
              <TeamBadge team={{ name: t.name, abbr: t.abbr, color: t.color, logoUrl: t.logoUrl }} size={20} />
              <span className={styles.teamName}>{t.name}</span>
              <span className={styles.caption}>{caption}</span>
            </header>
            <ul className={styles.row} role="list" aria-label={`${t.name} ${caption}`}>
              {t.players.map((p) => (
                <Card key={p.pcode} p={p} topTitle={topTitle} />
              ))}
            </ul>
          </section>
        </Fragment>
      ))}
    </div>
  );
});
