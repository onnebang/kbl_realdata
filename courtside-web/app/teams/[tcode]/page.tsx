import Link from "next/link";
import { notFound } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { TeamBadge } from "@/components/TeamBadge";
import { getTeamSeasonSchedule } from "@/lib/matchups";

// 팀 시즌 스케줄 페이지(요청: "팀별, 시즌별 보기를 좀더 세분화" - ESPN 팀 스케줄 페이지
// 참고) - 홈 화면 경기 목록의 팀 이름/배지를 누르면 여기로. 팀 컬러를 배너에 그대로 써서
// "이 팀 전용 페이지"라는 느낌을 주는 게 핵심(다른 페이지는 전부 중립 --surface 톤).
type TeamInfo = { tcode: string; name: string; abbr: string; color: string; logo_url: string | null };

async function getTeam(tcode: string): Promise<TeamInfo | null> {
  const { data } = await supabase.from("teams").select("tcode, name, abbr, color, logo_url").eq("tcode", tcode).maybeSingle();
  return data as TeamInfo | null;
}

async function getSeasons(): Promise<string[]> {
  const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

function fmtDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${y.slice(2)}.${m}.${day}`;
}

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ tcode: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { tcode } = await params;
  const { season } = await searchParams;
  const team = await getTeam(tcode);
  if (!team) notFound();

  const seasons = await getSeasons();
  const activeSeason = season ?? seasons[0];
  const [schedule, opponents] = await Promise.all([
    getTeamSeasonSchedule(tcode, activeSeason),
    supabase.from("teams").select("tcode, name, abbr, color, logo_url").then((r) => r.data ?? []),
  ]);
  const oppByTcode = new Map(opponents.map((t) => [t.tcode, t]));

  const wins = schedule.filter((g) => g.teamScore > g.oppScore).length;
  const losses = schedule.length - wins;

  return (
    <div className="wrap">
      <Link href="/" className="back-link">
        ← 경기 목록
      </Link>

      <div className="team-page-banner" style={{ background: team.color }}>
        <TeamBadge team={{ name: team.name, abbr: team.abbr, color: "#ffffff33", logoUrl: team.logo_url }} size={56} />
        <div>
          <div className="team-page-name">{team.name}</div>
          <div className="team-page-record">
            {activeSeason} 시즌 · {wins}승 {losses}패
            {schedule.length > 0 ? ` (${((wins / schedule.length) * 100).toFixed(1)}%)` : ""}
          </div>
        </div>
      </div>

      <form style={{ marginTop: 18, display: "flex", gap: 8 }}>
        <select name="season" defaultValue={activeSeason}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s} 시즌
            </option>
          ))}
        </select>
        <button type="submit" className="btn-primary">
          시즌 보기
        </button>
      </form>

      <div className="panel">
        <div className="panel-title">
          {activeSeason} 시즌 전체 일정 ({schedule.length}경기)
        </div>
        {schedule.length === 0 ? (
          <div className="empty-note">이 시즌 경기 데이터 없음</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>구분</th>
                  <th>상대</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((g) => {
                  const opp = oppByTcode.get(g.oppTcode);
                  const won = g.teamScore > g.oppScore;
                  return (
                    <tr key={g.gmkey}>
                      <td>
                        <Link href={`/games/${g.gmkey}`}>{fmtDate(g.gameDate)}</Link>
                      </td>
                      <td>{g.seasonCategory}</td>
                      <td style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {g.isHome ? "vs" : "@"}
                        <TeamBadge team={opp ? { ...opp, logoUrl: opp.logo_url } : null} size={16} />
                        {opp?.name ?? g.oppTcode}
                      </td>
                      <td>
                        <span className={`sched-result ${won ? "win" : "loss"}`}>{won ? "W" : "L"}</span> {g.teamScore}-{g.oppScore}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <footer className="foot">
        {team.name} · {activeSeason} 시즌 · Supabase에서 실시간 조회
      </footer>
    </div>
  );
}
