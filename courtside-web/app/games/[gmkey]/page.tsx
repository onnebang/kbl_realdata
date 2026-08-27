import Link from "next/link";
import { notFound } from "next/navigation";
import { supabase } from "@/lib/supabase";

type TeamRef = { tcode: string; name: string; abbr: string; color: string } | null;

type GameInfo = {
  gmkey: string;
  game_date: string;
  home_score: number | null;
  away_score: number | null;
  season_name: string;
  season_category: string;
  home_team: TeamRef;
  away_team: TeamRef;
};

type TeamStatRow = {
  tcode: string;
  score: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  turnovers: number | null;
  fouls: number | null;
  fgm: number | null;
  fga: number | null;
  tpm: number | null;
  tpa: number | null;
  ftm: number | null;
  fta: number | null;
};

type PlayerStatRow = {
  pcode: string;
  tcode: string;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  min_played: number | null;
  fgm: number | null;
  fga: number | null;
  tpm: number | null;
  tpa: number | null;
  ftm: number | null;
  fta: number | null;
  player: { name: string } | null;
};

type EventRow = { event_order: number; home_win_prob: number | null };

async function getGame(gmkey: string): Promise<GameInfo | null> {
  const { data, error } = await supabase
    .from("games")
    .select(
      `gmkey, game_date, home_score, away_score, season_name, season_category,
       home_team:teams!games_home_tcode_fkey(tcode, name, abbr, color),
       away_team:teams!games_away_tcode_fkey(tcode, name, abbr, color)`
    )
    .eq("gmkey", gmkey)
    .single();
  if (error) return null;
  return data as unknown as GameInfo;
}

async function getTeamStats(gmkey: string) {
  const { data } = await supabase
    .from("game_team_stats")
    .select("tcode, score, reb, ast, stl, blk, turnovers, fouls, fgm, fga, tpm, tpa, ftm, fta")
    .eq("gmkey", gmkey);
  return (data ?? []) as TeamStatRow[];
}

async function getPlayerStats(gmkey: string) {
  const { data } = await supabase
    .from("game_player_stats")
    .select(
      "pcode, tcode, pts, reb, ast, stl, blk, min_played, fgm, fga, tpm, tpa, ftm, fta, player:players(name)"
    )
    .eq("gmkey", gmkey)
    .order("pts", { ascending: false });
  return (data ?? []) as unknown as PlayerStatRow[];
}

async function getEvents(gmkey: string) {
  const { data } = await supabase
    .from("game_events")
    .select("event_order, home_win_prob")
    .eq("gmkey", gmkey)
    .order("event_order", { ascending: true });
  return (data ?? []) as EventRow[];
}

function WinProbChart({ events, homeColor }: { events: EventRow[]; homeColor: string }) {
  const valid = events.filter((e) => e.home_win_prob != null);
  if (!valid.length) {
    return (
      <div className="empty-note">
        승률 데이터 없음(game_events 마이그레이션이 이 경기까지 아직 안 왔을 수 있음)
      </div>
    );
  }
  const W = 640,
    H = 160,
    PAD = 14;
  const n = valid.length;
  const points = valid
    .map((e, i) => {
      const x = PAD + (i / Math.max(1, n - 1)) * (W - 2 * PAD);
      const y = PAD + (1 - (e.home_win_prob as number)) * (H - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const midY = PAD + 0.5 * (H - 2 * PAD);
  const finalProb = Math.round((valid[valid.length - 1].home_win_prob as number) * 100);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 160, display: "block" }}>
      <line x1={PAD} y1={midY} x2={W - PAD} y2={midY} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="3,3" />
      <text x={PAD} y={PAD - 2} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
        홈 100%
      </text>
      <text x={PAD} y={H - 2} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
        원정 100%
      </text>
      <polyline points={points} fill="none" stroke={homeColor} strokeWidth={2} />
      <text x={W - PAD} y={PAD - 2} fontSize={11} fill={homeColor} textAnchor="end" fontWeight={700} fontFamily="IBM Plex Mono, monospace">
        최종 홈 승률 {finalProb}%
      </text>
    </svg>
  );
}

function statLine(t: TeamStatRow | undefined) {
  if (!t) return null;
  return [
    ["PTS", t.score],
    ["REB", t.reb],
    ["AST", t.ast],
    ["STL", t.stl],
    ["BLK", t.blk],
    ["TO", t.turnovers],
    ["FG", `${t.fgm ?? "-"}/${t.fga ?? "-"}`],
    ["3P", `${t.tpm ?? "-"}/${t.tpa ?? "-"}`],
    ["FT", `${t.ftm ?? "-"}/${t.fta ?? "-"}`],
  ] as const;
}

export default async function GamePage({ params }: { params: Promise<{ gmkey: string }> }) {
  const { gmkey } = await params;
  const game = await getGame(gmkey);
  if (!game) notFound();

  const [teamStats, playerStats, events] = await Promise.all([
    getTeamStats(gmkey),
    getPlayerStats(gmkey),
    getEvents(gmkey),
  ]);

  const homeTeam = teamStats.find((t) => t.tcode === game.home_team?.tcode);
  const awayTeam = teamStats.find((t) => t.tcode === game.away_team?.tcode);
  const homePlayers = playerStats.filter((p) => p.tcode === game.home_team?.tcode);
  const awayPlayers = playerStats.filter((p) => p.tcode === game.away_team?.tcode);

  const playerTable = (rows: PlayerStatRow[]) => (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>선수</th>
            <th>MIN</th>
            <th>PTS</th>
            <th>REB</th>
            <th>AST</th>
            <th>STL</th>
            <th>BLK</th>
            <th>FG</th>
            <th>3P</th>
            <th>FT</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.pcode}>
              <td>{p.player?.name ?? p.pcode}</td>
              <td>{p.min_played?.toFixed(1) ?? "-"}</td>
              <td>{p.pts}</td>
              <td>{p.reb}</td>
              <td>{p.ast}</td>
              <td>{p.stl}</td>
              <td>{p.blk}</td>
              <td>
                {p.fgm}/{p.fga}
              </td>
              <td>
                {p.tpm}/{p.tpa}
              </td>
              <td>
                {p.ftm}/{p.fta}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="wrap">
      <Link href="/" className="back-link">
        ← 경기 목록
      </Link>

      <div
        className="matchup-banner"
        style={{
          background: `linear-gradient(to right, ${game.home_team?.color ?? "#888"} 50%, ${game.away_team?.color ?? "#888"} 50%)`,
        }}
      >
        <div className="matchup-banner-side home" style={{ background: game.home_team?.color ?? "#888" }}>
          <span className="matchup-banner-name">{game.home_team?.name ?? game.gmkey}</span>
          <span className="matchup-banner-score">{game.home_score}</span>
        </div>
        <div className="matchup-banner-vs">VS</div>
        <div className="matchup-banner-side away" style={{ background: game.away_team?.color ?? "#888" }}>
          <span className="matchup-banner-score">{game.away_score}</span>
          <span className="matchup-banner-name">{game.away_team?.name ?? ""}</span>
        </div>
      </div>
      <div className="subtitle">
        {game.game_date} · {game.season_name} {game.season_category} · {game.gmkey}
      </div>

      <div className="panel">
        <div className="panel-title">승률 흐름 (game_events, {events.length}개 이벤트)</div>
        <WinProbChart events={events} homeColor={game.home_team?.color ?? "#888"} />
      </div>

      <div className="panel">
        <div className="panel-title">팀 박스스코어</div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>팀</th>
                <th></th>
                {statLine(homeTeam)?.map(([label]) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ color: game.home_team?.color }}>{game.home_team?.name}</td>
                <td></td>
                {statLine(homeTeam)?.map(([label, val]) => (
                  <td key={label}>{val ?? "-"}</td>
                ))}
              </tr>
              <tr>
                <td style={{ color: game.away_team?.color }}>{game.away_team?.name}</td>
                <td></td>
                {statLine(awayTeam)?.map(([label, val]) => (
                  <td key={label}>{val ?? "-"}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title" style={{ color: game.home_team?.color }}>
          {game.home_team?.name} 선수 기록
        </div>
        {playerTable(homePlayers)}
      </div>

      <div className="panel">
        <div className="panel-title" style={{ color: game.away_team?.color }}>
          {game.away_team?.name} 선수 기록
        </div>
        {playerTable(awayPlayers)}
      </div>

      <footer className="foot">Supabase에서 실시간 조회 · {gmkey}</footer>
    </div>
  );
}
