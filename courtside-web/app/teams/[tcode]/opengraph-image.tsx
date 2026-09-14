import { getAllTeams } from "@/lib/playerProfile";
import { accentFor } from "@/lib/teamAccent";
import { displayTeamName } from "@/lib/teamNames";
import { PRESEASON_SEASON } from "@/lib/preseason";
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "@/lib/ogCard";

export const alt = "코트사이드 팀 카드";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ tcode: string }> }) {
  const { tcode } = await params;
  const team = (await getAllTeams()).get(tcode);
  if (!team) return ogCard({ kicker: "팀 프로필", title: "코트사이드", sub: "팀을 찾을 수 없음" });
  return ogCard({
    kicker: "팀 프로필",
    title: displayTeamName(team.tcode, team.name, PRESEASON_SEASON), // teams.name은 옛 이름일 수 있다(60 = 전주 KCC)
    sub: `${PRESEASON_SEASON.replace(/^20(\d\d)-20(\d\d)$/, "$1-$2")} 시즌 전망·로스터 변화·팀 DNA`,
    accent: accentFor(team.tcode, team.color),
  });
}
