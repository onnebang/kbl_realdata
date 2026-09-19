import { getOvrHistoryCache, OvrSeasonRecord } from "./ovr";

// app/rankings/teams/page.tsx에 있던 "팀 파워" 계산을 공용 함수로 뽑았다(요청: "프리시즌과
// 팀 자세히보기에서도 파워를 수치화해서 보여주면 재밌을 것 같아" - 페이지마다 따로 구현하면
// 두 곳의 팀 파워 숫자가 슬쩍 달라질 위험이 있다). 계산 방식 자체는 그대로: 로스터를 OVR
// 내림차순으로 세운 뒤 상위 5명(주전 추정) 70% + 다음 4명(주요 벤치) 30% 가중평균 - 팀
// 전체를 단순평균하면 10~11번째 선수 실력이 주전급 선수와 똑같은 비중을 갖게 되어 로스터가
// 깊은 팀이 실제보다 손해를 본다.
export interface TeamPower {
  teamName: string;
  ovr: number;
  off: number;
  def: number;
  season: string;
  roster: OvrSeasonRecord[]; // OVR 내림차순
}

const TOP5_WEIGHT = 0.7;
const NEXT4_WEIGHT = 0.3;

function weightedAvg(sortedRoster: OvrSeasonRecord[], key: "OVR" | "OFF" | "DEF"): number {
  if (sortedRoster.length === 0) return 0;
  if (sortedRoster.length < 5) {
    return sortedRoster.reduce((sum, p) => sum + p[key], 0) / sortedRoster.length;
  }
  const top5 = sortedRoster.slice(0, 5);
  const next4 = sortedRoster.slice(5, 9);
  const sum5 = top5.reduce((sum, p) => sum + p[key], 0);
  const sum4 = next4.reduce((sum, p) => sum + p[key], 0);
  const totalWeight = top5.length * TOP5_WEIGHT + next4.length * NEXT4_WEIGHT;
  return (sum5 * TOP5_WEIGHT + sum4 * NEXT4_WEIGHT) / totalWeight;
}

/**
 * 시즌을 지정하지 않으면 히스토리에 있는 가장 최신 시즌(다음 시즌 예상 포함)을 쓴다 -
 * 개막 전이라도 로스터+예상 OVR이 있으면 "지금 이 순간의 팀 파워"를 보여줄 수 있다.
 */
export function getAllTeamPowers(season?: string): TeamPower[] {
  const history = getOvrHistoryCache();
  const seasons = Array.from(new Set(history.map((r) => r.season))).sort();
  const targetSeason = season ?? seasons[seasons.length - 1];
  if (!targetSeason) return [];

  const players = history.filter((r) => r.season === targetSeason && r.team && r.team !== "Unknown");
  const byTeam = new Map<string, OvrSeasonRecord[]>();
  for (const p of players) {
    if (!byTeam.has(p.team!)) byTeam.set(p.team!, []);
    byTeam.get(p.team!)!.push(p);
  }

  const powers: TeamPower[] = [];
  for (const [teamName, roster] of byTeam) {
    const sorted = [...roster].sort((a, b) => b.OVR - a.OVR);
    powers.push({
      teamName,
      season: targetSeason,
      ovr: Math.round(weightedAvg(sorted, "OVR")),
      off: Math.round(weightedAvg(sorted, "OFF")),
      def: Math.round(weightedAvg(sorted, "DEF")),
      roster: sorted,
    });
  }
  powers.sort((a, b) => b.ovr - a.ovr);
  return powers;
}

/** teamName은 courtside_ovr_history.json의 team 필드(다음 시즌 행은 season_roster의 팀, 지난 시즌 행은 그 시즌 소속팀)와 같은
 * 표기여야 매칭된다 - 연고 이동으로 개명한 팀은 호출부에서 displayTeamName()의 결과를
 * 넘겨야 한다(Supabase teams.name은 옛 이름일 수 있음). */
export function getTeamPowerByName(teamName: string, season?: string): TeamPower | null {
  return getAllTeamPowers(season).find((p) => p.teamName === teamName) ?? null;
}

export function tierClass(rating: number): "gold" | "silver" | "bronze" | "default" {
  if (rating >= 95) return "gold";
  if (rating >= 85) return "silver";
  if (rating >= 75) return "bronze";
  return "default";
}
