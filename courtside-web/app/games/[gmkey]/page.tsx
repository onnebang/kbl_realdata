import Link from "next/link";
import { notFound } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { attachDerivedFields, buildPostgameReport, type GameEvent, type PlayerBox } from "@/lib/postgameReport";
import { pregameInsightItems, type PregameFeatures } from "@/lib/pregameInsights";
import { getGameRarity } from "@/lib/rarity";

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
  turnovers: number | null;
  fouls: number | null;
  is_starter: boolean | null;
  min_played: number | null;
  fgm: number | null;
  fga: number | null;
  tpm: number | null;
  tpa: number | null;
  ftm: number | null;
  fta: number | null;
  player: { name: string } | null;
};

type EventRow = {
  event_order: number;
  quarter: string;
  clock_min: number | null;
  clock_sec: number | null;
  action_code: string | null;
  pcode: string | null;
  tcode: string | null;
  home_score: number;
  away_score: number;
  home_win_prob: number | null;
  wpa_home: number | null;
  objective_prob: number | null;
};

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
      "pcode, tcode, pts, reb, ast, stl, blk, turnovers, fouls, is_starter, min_played, fgm, fga, tpm, tpa, ftm, fta, player:players(name)"
    )
    .eq("gmkey", gmkey)
    .order("pts", { ascending: false });
  return (data ?? []) as unknown as PlayerStatRow[];
}

async function getEvents(gmkey: string) {
  const { data } = await supabase
    .from("game_events")
    .select("event_order, quarter, clock_min, clock_sec, action_code, pcode, tcode, home_score, away_score, home_win_prob, wpa_home, objective_prob")
    .eq("gmkey", gmkey)
    .order("event_order", { ascending: true });
  return (data ?? []) as EventRow[];
}

// action_codes(30여 개, 가벼움) 통째로 가져와 code->label 맵 - courtside_template.html의
// ACTION_LABELS 오브젝트와 같은 역할.
async function getActionLabels(): Promise<Map<string, string>> {
  const { data } = await supabase.from("action_codes").select("code, label");
  return new Map((data ?? []).map((r) => [r.code as string, r.label as string]));
}

async function getPregameFeatures(gmkey: string): Promise<PregameFeatures | null> {
  const { data } = await supabase.from("pregame_features").select("*").eq("gmkey", gmkey).maybeSingle();
  return (data as PregameFeatures) ?? null;
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

  const [teamStats, playerStats, events, pregameFeatures, actionLabels] = await Promise.all([
    getTeamStats(gmkey),
    getPlayerStats(gmkey),
    getEvents(gmkey),
    getPregameFeatures(gmkey),
    getActionLabels(),
  ]);

  const homeTeam = teamStats.find((t) => t.tcode === game.home_team?.tcode);
  const awayTeam = teamStats.find((t) => t.tcode === game.away_team?.tcode);
  const homePlayers = playerStats.filter((p) => p.tcode === game.home_team?.tcode);
  const awayPlayers = playerStats.filter((p) => p.tcode === game.away_team?.tcode);

  // 요청: "코트사이드웹에도 같은 리포트 붙여줘" - courtside_template.html(35차)의 AI
  // 코트사이드 리포트/프리뷰 인사이트를 그대로 포팅. 정적 페이지는 미리 구운 timeline
  // 배열을 클라이언트에서 훑었지만, 여기는 Supabase game_events를 서버에서 한 번에
  // 불러와 lib/postgameReport.ts(A1-A8 그대로 이식)가 같은 계산을 함.
  const playerNameMap = new Map(playerStats.map((p) => [p.pcode, p.player?.name ?? p.pcode]));
  const rawEvents = events.map((e) => ({
    event_order: e.event_order,
    quarter: e.quarter,
    clock_min: e.clock_min,
    clock_sec: e.clock_sec,
    action_code: e.action_code,
    action_label: e.action_code ? actionLabels.get(e.action_code) ?? e.action_code : null,
    pcode: e.pcode,
    player_name: e.pcode ? playerNameMap.get(e.pcode) ?? null : null,
    tcode: e.tcode,
    home_score: e.home_score,
    away_score: e.away_score,
    home_win_prob: e.home_win_prob,
    wpa_home: e.wpa_home,
    objective_prob: e.objective_prob,
  }));
  const derivedEvents: GameEvent[] = attachDerivedFields(rawEvents);

  const box: PlayerBox[] = playerStats.map((p) => ({
    pcode: p.pcode,
    tcode: p.tcode,
    name: p.player?.name ?? p.pcode,
    is_starter: p.is_starter,
    pts: p.pts ?? 0,
    // game_player_stats.fgm/fga는 원본 소스가 2점슛만 따로 셈(3점은 tpm/tpa) - 리포트
    // 엔진(gameScore 등)은 정적 페이지처럼 합산 FG를 기대해서 여기서 더해서 넘김(실측
    // 확인 - lib/postgameReport.ts의 PlayerBox 주석 참고).
    fgm: (p.fgm ?? 0) + (p.tpm ?? 0),
    fga: (p.fga ?? 0) + (p.tpa ?? 0),
    ftm: p.ftm ?? 0,
    fta: p.fta ?? 0,
    reb: p.reb ?? 0,
    ast: p.ast ?? 0,
    stl: p.stl ?? 0,
    blk: p.blk ?? 0,
    fouls: p.fouls ?? 0,
    turnovers: p.turnovers ?? 0,
  }));

  let reportSections: { title: string; html: string }[] = [];
  if (game.home_score != null && game.away_score != null && derivedEvents.length > 0 && game.home_team && game.away_team) {
    const rarity = await getGameRarity(game.home_score, game.away_score);
    reportSections = buildPostgameReport({
      events: derivedEvents,
      box,
      homeTcode: game.home_team.tcode,
      awayTcode: game.away_team.tcode,
      homeTname: game.home_team.name,
      awayTname: game.away_team.name,
      homeScore: game.home_score,
      awayScore: game.away_score,
      rarity,
    });
  }

  const pregameLines =
    pregameFeatures && game.home_team && game.away_team
      ? pregameInsightItems(pregameFeatures, game.home_team.name, game.away_team.name)
      : [];

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

      {pregameLines.length > 0 && (
        <div className="panel">
          <div className="panel-title">더 깊은 프리뷰 인사이트</div>
          <ul className="report-list">
            {pregameLines.map((line, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: line }} />
            ))}
          </ul>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">승률 흐름 (game_events, {events.length}개 이벤트)</div>
        <WinProbChart events={events} homeColor={game.home_team?.color ?? "#888"} />
      </div>

      {reportSections.length > 0 && (
        <div className="panel">
          <div className="panel-title">🏀 AI 코트사이드 리포트</div>
          {reportSections.map((s) => (
            <div className="report-section" key={s.title}>
              <div className="report-section-title">{s.title}</div>
              <div dangerouslySetInnerHTML={{ __html: s.html }} />
            </div>
          ))}
        </div>
      )}

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
