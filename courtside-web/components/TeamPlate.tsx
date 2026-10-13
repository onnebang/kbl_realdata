import { TeamBadge, type TeamBadgeInfo } from "./TeamBadge";
import { teamBarStyle } from "@/lib/teamAccent";
import styles from "./TeamPlate.module.css";

// TeamBadge를 흰 플레이트 + 팀 색 링으로 감싼다. 로고는 어두운 단색(KT·KCC)도 있어 다크 배경 위에서
// 묻히므로 플레이트가 바탕을 보장하고, 링이 팀을 색으로 구분한다. 링 색은 테마별 대비를 맞춘
// --tb-l/--tb-d 쌍(teamBarStyle) - 서버는 테마를 모르므로 두 색을 같이 내려보낸다.
export function TeamPlate({ team, size = 30 }: { team: TeamBadgeInfo; size?: number }) {
  if (!team) return null;
  return (
    <span className={styles.plate} style={teamBarStyle(team.color)}>
      <TeamBadge team={team} size={size} />
    </span>
  );
}
