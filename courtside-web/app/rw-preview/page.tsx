// 임시 미리보기 라우트 - RecentWindow 렌더 검증용. 검증이 끝나면 삭제한다.
import { getPlayerCareerGames, getAllTeams } from "@/lib/playerProfile";
import { RecentWindow } from "@/components/RecentWindow";
import { resolveRecentRate } from "@/lib/recentWindow";

export const dynamic = "force-dynamic";

const CASES: { pcode: string; name: string; w: number }[] = [
  { pcode: "291248", name: "자밀 워니 L15", w: 15 },
  { pcode: "291248", name: "자밀 워니 L5", w: 5 },
  { pcode: "291499", name: "조은후 L15", w: 15 },
  { pcode: "291499", name: "조은후 L5(합계 1.2분)", w: 5 },
  { pcode: "291879", name: "카이린 갤러웨이 L30(통산 9경기)", w: 30 },
];

export default async function Preview({ searchParams }: { searchParams: Promise<{ rw?: string }> }) {
  const { rw } = await searchParams;
  const rate = resolveRecentRate(rw);
  const teams = await getAllTeams();
  const abbrs = new Map<string, string>();
  for (const [tc, t] of teams) abbrs.set(tc, t.abbr);
  const rows = await Promise.all(CASES.map((c) => getPlayerCareerGames(c.pcode)));
  return (
    <div className="wrap">
      {CASES.map((c, i) => (
        <div key={`${c.pcode}-${c.w}`}>
          <h2 style={{ marginTop: 24, fontSize: 14 }}>{c.name}</h2>
          <RecentWindow careerRows={rows[i]} windowN={c.w} rate={rate} query={{ rw }} teamAbbrs={abbrs} />
        </div>
      ))}
    </div>
  );
}
