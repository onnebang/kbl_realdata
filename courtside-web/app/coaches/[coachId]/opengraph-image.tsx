import { getCoachProfile } from "@/lib/coachPage";
import { accentFor } from "@/lib/teamAccent";
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "@/lib/ogCard";

export const alt = "코트사이드 감독 카드";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ coachId: string }> }) {
  const { coachId } = await params;
  const p = /^\d{1,9}$/.test(coachId) ? await getCoachProfile(Number(coachId)) : null;
  if (!p) return ogCard({ kicker: "감독 프로필", title: "코트사이드", sub: "감독을 찾을 수 없음" });
  const team = p.currentTeam ?? p.seasons[p.seasons.length - 1]?.team ?? null;
  return ogCard({
    kicker: "감독 프로필 · 커리어 승패·로테이션 스타일",
    title: `${p.coach.name} 감독`,
    sub: team ? (p.currentTeam ? team.name : `마지막 팀 ${team.name}`) : undefined,
    accent: team ? accentFor(team.tcode, team.color) : undefined,
  });
}
