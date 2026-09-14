import { supabaseServer as supabase } from "@/lib/supabaseServer";
import { deriveGameStatus } from "@/lib/gameStatus";
import { accentFor } from "@/lib/teamAccent";
import { displayTeamName } from "@/lib/teamNames";
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "@/lib/ogCard";

export const alt = "코트사이드 경기 카드";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

type TeamRow = { tcode: string; name: string; color: string | null };

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

export default async function Image({ params }: { params: Promise<{ gmkey: string }> }) {
  const { gmkey } = await params;
  const [{ data: g }, { data: pre }] = await Promise.all([
    supabase
      .from("games")
      .select(
        `game_date, game_start, home_score, away_score, is_ended, season_name, season_category,
         home_team:teams!games_home_tcode_fkey(tcode, name, color),
         away_team:teams!games_away_tcode_fkey(tcode, name, color)`
      )
      .eq("gmkey", gmkey)
      .maybeSingle(),
    supabase.from("pregame_features").select("home_win_prob").eq("gmkey", gmkey).maybeSingle(),
  ]);
  const home = g?.home_team as unknown as TeamRow | null;
  const away = g?.away_team as unknown as TeamRow | null;
  if (!g || !home || !away) return ogCard({ kicker: "KBL 경기", title: "코트사이드", sub: "경기를 찾을 수 없음" });

  const side = (t: TeamRow) => ({ name: displayTeamName(t.tcode, t.name, g.season_name), accent: accentFor(t.tcode, t.color) });
  const [y, m, d] = (g.game_date as string).split("-").map(Number);
  const when = `${String(y).slice(2)}.${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}(${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
  const time = g.game_start ? ` ${(g.game_start as string).slice(0, 5)}` : "";
  const status = deriveGameStatus(g);
  const h = side(home);
  const a = side(away);

  let note: string | undefined;
  if (status === "final" && g.home_score != null && g.away_score != null && g.home_score !== g.away_score) {
    note = `최종 · ${g.home_score > g.away_score ? h.name : a.name} 승`;
  } else if (status === "live") {
    note = "진행 중 · 실시간 승률 중계";
  } else if (status === "scheduled" && pre?.home_win_prob != null) {
    note = `경기 전 모델 승률 ${h.name} ${Math.round(pre.home_win_prob * 100)}%`;
  }

  return ogCard({
    kicker: `${when}${time} · ${g.season_category ?? "KBL"}`,
    matchup: {
      away: a,
      home: h,
      awayScore: status === "scheduled" ? null : g.away_score,
      homeScore: status === "scheduled" ? null : g.home_score,
      note,
    },
  });
}
