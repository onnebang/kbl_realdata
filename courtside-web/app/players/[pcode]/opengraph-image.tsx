import { getAllTeams, getPlayerInfo } from "@/lib/playerProfile";
import { getPlayerRosterStatus } from "@/lib/playerStatus";
import { accentFor } from "@/lib/teamAccent";
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "@/lib/ogCard";

export const alt = "코트사이드 선수 카드";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

const POS = { G: "가드", F: "포워드", C: "센터" } as const;

export default async function Image({ params }: { params: Promise<{ pcode: string }> }) {
  const { pcode } = await params;
  const info = await getPlayerInfo(pcode);
  if (!info) return ogCard({ kicker: "선수 프로필", title: "코트사이드", sub: "선수를 찾을 수 없음" });
  const [status, teams] = await Promise.all([getPlayerRosterStatus(pcode), getAllTeams()]);
  const team = status.tcode ? teams.get(status.tcode) : undefined;

  const bits = [
    status.teamName && (status.state === "active" ? status.teamName : `마지막 소속 ${status.teamName}`),
    status.pos && POS[status.pos],
    status.backNum && !status.backNumAsLastSeason ? `#${status.backNum}` : null,
  ].filter(Boolean);

  return ogCard({
    kicker: "선수 프로필 · 커리어·슈팅 DNA·승리 기여",
    title: info.name,
    sub: bits.join(" · ") || undefined,
    accent: team ? accentFor(team.tcode, team.color) : undefined,
  });
}
