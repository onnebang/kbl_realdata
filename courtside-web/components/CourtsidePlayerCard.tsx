import Image from "next/image";
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
  photoUrl: string;
}

function tierClass(rating: number): string {
  if (rating >= 95) return styles.tierGold;
  if (rating >= 85) return styles.tierSilver;
  if (rating >= 75) return styles.tierBronze;
  return styles.tierDefault;
}

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
}: CourtsidePlayerCardProps) {
  const displayEname = ename || name;
  const [enameFirst, ...enameRestParts] = displayEname.split(" ");
  const enameRest = enameRestParts.join(" ") || name;

  return (
    <div className={styles.card} style={{ "--team-color": teamColor } as React.CSSProperties}>
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
        </div>
      </div>

      <div className={styles.photoWrap}>
        <Image
          src={photoUrl}
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

      <div className={styles.frame} aria-hidden="true" />
    </div>
  );
}
