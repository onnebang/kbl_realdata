"use client";

import Image from "next/image";
import { useState } from "react";
import styles from "./CourtsidePlayerCard.module.css";

// 2K 스타일 선수 카드. 처음 버전(git blame: feat "implement 2K style infographic player
// profile")은 Tailwind 유틸리티 클래스(w-[400px], bg-black/40 등)로 작성됐는데, 이 프로젝트엔
// Tailwind가 설치돼 있지 않아(package.json/tailwind.config 전부 없음) 그 클래스들이 전부
// 아무 효과가 없었다 - 프로덕션에서 카드 틀 없이 텍스트만 겹쳐 쌓이는 상태로 노출됨(감사에서
// 스크린샷으로 확인). 이 사이트의 다른 모든 컴포넌트와 같은 방식(CSS Modules)으로 다시 짬.

interface CourtsidePlayerCardProps {
  name: string;
  /** 영문 이름. 없으면 name으로 대체(예전엔 'NIKOLA JOKIC'이 기본값이라 사진 없는 선수에게
      NBA 선수 이름이 뜰 뻔했다 - 호출부가 이미 막고 있지만 컴포넌트 자체도 안전하게). */
  ename?: string;
  /** 표시용 팀 약칭(예: "DB", "KCC") - 색상 계산에는 안 쓰고 TEAM/NUM 칩에 텍스트로만 쓴다. */
  team: string;
  /** 실제 팀 색상(hex) - 호출부가 이미 갖고 있는 teams.color를 그대로 받는다. 예전 버전은
      컴포넌트 안에 팀명→색 하드코딩 표를 따로 두고 "원주 DB"(전체 표시명) 같은 문자열로
      찾으려 해서 항상 매치에 실패했다(감사에서 발견). */
  teamColor: string;
  number: number;
  ovr: number;
  offOvr: number;
  defOvr: number;
  photoUrl?: string | null;
  archetype?: string;
  badges?: {
    finishing: number;
    shooting: number;
    playmaking: number;
    defense: number;
  };
}

function tierClass(rating: number): string {
  if (rating >= 92) return styles.tierElite;
  if (rating >= 89) return styles.tierGold;
  if (rating >= 85) return styles.tierSilver;
  if (rating >= 75) return styles.tierBronze;
  return styles.tierDefault;
}

function badgeClass(level: number): string {
  if (level >= 4) return styles.badgeHof;
  if (level === 3) return styles.badgeGold;
  if (level === 2) return styles.badgeSilver;
  if (level === 1) return styles.badgeBronze;
  return "";
}

import OvrRadarChart from "./OvrRadarChart";

export default function CourtsidePlayerCard({
  name,
  ename,
  team,
  teamColor,
  number,
  ovr,
  offOvr,
  defOvr,
  photoUrl,
  archetype,
  badges,
  attributes,
}: CourtsidePlayerCardProps & {
  attributes?: {
    outside: number;
    inside: number;
    playmaking: number;
    athletic: number;
    defense: number;
    rebounding: number;
  };
}) {
  const displayEname = ename || name;
  const [enameFirst, ...enameRestParts] = displayEname.split(" ");
  const enameRest = enameRestParts.join(" ") || name;

  // 능력치가 있을 때만 뒷면(육각형 레이더)이 존재 - 예전엔 사진 위에 겹쳐 그려서 사진과 능력치
  // 둘 다 잘 안 보인다는 제보(2026-09-25)가 있었다. 카드 뒤집기로 분리.
  const [flipped, setFlipped] = useState(false);

  return (
    <div className={styles.cardShell}>
      <div className={styles.card} style={{ "--team-color": teamColor } as React.CSSProperties}>
        <div className={`${styles.cardInner} ${flipped ? styles.flipped : ""}`}>
          <div className={styles.front}>
            {/* 배경에 흐리게 깔리는 대형 OVR 숫자 */}
            <div className={`${styles.bgOvr} ${tierClass(ovr)}`} aria-hidden="true">
              {ovr}
            </div>

            <div className={styles.header}>
              <div className={styles.ovrBlock}>
                <span className={`${styles.ovrValue} ${tierClass(ovr)}`}>{ovr}</span>
                <span className={styles.ovrLabel}>OVR</span>
              </div>
              <div className={styles.nameBlock}>
                <span className={styles.nameFirst}>{enameFirst}</span>
                <span className={styles.nameLast}>{enameRest}</span>
                {archetype && <span className={styles.archetype}>{archetype}</span>}
                {badges && (
                  <div className={styles.badgeRow}>
                    {badges.finishing > 0 && <span className={`${styles.badge} ${badgeClass(badges.finishing)}`} title="Finishing">F</span>}
                    {badges.shooting > 0 && <span className={`${styles.badge} ${badgeClass(badges.shooting)}`} title="Shooting">S</span>}
                    {badges.playmaking > 0 && <span className={`${styles.badge} ${badgeClass(badges.playmaking)}`} title="Playmaking">P</span>}
                    {badges.defense > 0 && <span className={`${styles.badge} ${badgeClass(badges.defense)}`} title="Defense">D</span>}
                  </div>
                )}
              </div>
            </div>

            <div className={styles.photoWrap}>
              <Image
                src={photoUrl || "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}
                alt={name}
                fill
                sizes="(max-width: 800px) 260px, 340px"
                className={styles.photo}
              />
            </div>

            <div className={styles.statsBar}>
              <div className={styles.statCell}>
                <span className={styles.statLabel}>OFFENSE</span>
                <span className={`${styles.statPill} ${tierClass(offOvr)}`}>{offOvr}</span>
              </div>
              <div className={styles.statCell}>
                <span className={styles.statLabel}>DEFENSE</span>
                <span className={`${styles.statPill} ${tierClass(defOvr)}`}>{defOvr}</span>
              </div>
              <div className={styles.statCell}>
                <span className={styles.statLabel}>TEAM / NUM</span>
                <span className={styles.teamNumPill}>
                  {team}
                  <span className={styles.teamNumDivider}>|</span>#{number}
                </span>
              </div>
            </div>
          </div>

          {attributes && (
            <div className={styles.back}>
              <div className={styles.backHeader}>
                <span className={`${styles.backOvr} ${tierClass(ovr)}`}>{ovr}</span>
                <span className={styles.backName}>{enameRest}</span>
              </div>
              <div className={styles.backRadar}>
                <OvrRadarChart attributes={attributes} ovr={ovr} />
              </div>
            </div>
          )}
        </div>

        <div className={styles.frame} aria-hidden="true" />
      </div>

      {attributes && (
        <button
          type="button"
          className={styles.flipBtn}
          onClick={() => setFlipped((f) => !f)}
          aria-label={flipped ? "카드 앞면 보기" : "카드 뒷면 보기 (능력치 육각형)"}
        >
          {flipped ? "앞면 보기" : "뒷면 보기"} ↻
        </button>
      )}
    </div>
  );
}
