// courtside_template.html의 teamBadgeHtml() 포팅 - 실제 로고가 있으면 이미지, 없으면
// (전자랜드/캐롯처럼 kbl.or.kr 현재 CSS 번들에 로고가 아예 없는 팀) 팀 컬러 배경 + 약어로
// 폴백. 사용자 요청("ESPN처럼 팀 컬러/로고로 구분") 반영.
export type TeamBadgeInfo = { name: string; abbr: string; color: string; logoUrl: string | null } | null;

export function TeamBadge({ team, size = 28 }: { team: TeamBadgeInfo; size?: number }) {
  if (!team) return null;
  if (team.logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={team.logoUrl}
        alt={team.abbr}
        className="team-badge has-logo"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span className="team-badge" style={{ width: size, height: size, background: team.color, fontSize: size * 0.34 }}>
      {team.abbr}
    </span>
  );
}
