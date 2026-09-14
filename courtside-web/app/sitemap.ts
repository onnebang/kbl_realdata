import type { MetadataRoute } from "next";
import { supabaseServer as supabase } from "@/lib/supabaseServer";
import { PRESEASON_SEASON, prevSeasonName } from "@/lib/preseason";
import { cached, TTL } from "@/lib/cachePolicy";
import { SITE_URL } from "@/lib/site";

// 검색엔진용 지도(예전엔 /sitemap.xml이 404). 목록 페이지 + 이번·지난 시즌 경기 + 확정 명단 선수 +
// 팀 + 감독만 - 15시즌 경기 전부(4천여 개)는 넣지 않는다. 크롤러만 부르므로 하루 캐시.
const LIST_PAGES = [
  "", "/preseason", "/teams", "/players", "/coaches", "/lineups", "/season-browser",
  "/leaderboards/season", "/leaderboards/win-contribution", "/leaderboards/scoring-explorer",
  "/leaderboards/form-index", "/leaderboards/custom-metric", "/trailer",
];

async function entityPaths(): Promise<string[]> {
  const [games, roster, coaches] = await Promise.all([
    supabase.from("games").select("gmkey").in("season_name", [PRESEASON_SEASON, prevSeasonName(PRESEASON_SEASON)]).limit(1000),
    supabase.from("season_roster").select("pcode, tcode").eq("season_name", PRESEASON_SEASON).limit(1000),
    supabase.from("coach_season_record").select("coach_id").limit(1000),
  ]);
  const rows = roster.data ?? [];
  return [
    ...[...new Set(rows.map((r) => r.tcode))].map((t) => `/teams/${t}`),
    ...[...new Set(rows.map((r) => r.pcode))].map((p) => `/players/${p}`),
    ...[...new Set((coaches.data ?? []).map((c) => c.coach_id))].map((c) => `/coaches/${c}`),
    ...(games.data ?? []).map((g) => `/games/${g.gmkey}`),
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const paths = await cached(entityPaths, ["sitemap", PRESEASON_SEASON], TTL.batchDaily);
  return [...LIST_PAGES, ...paths].map((p) => ({ url: `${SITE_URL}${p}` }));
}
