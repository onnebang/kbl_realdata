import Link from "next/link";
import { notFound } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { attachDerivedFields, buildPostgameReport, type GameEvent, type PlayerBox } from "@/lib/postgameReport";
import { pregameInsightItems, type PregameFeatures } from "@/lib/pregameInsights";
import { getGameRarity } from "@/lib/rarity";
import { getSeasonStatsAsOf, getRecentSchedule, getHeadToHead, getStandingsAsOf } from "@/lib/matchups";
import { teamZoneStats, buildZoneCompareSvg, type ShotRow } from "@/lib/zoneCompare";

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

async function getShots(gmkey: string): Promise<ShotRow[]> {
  const { data } = await supabase.from("shot_log").select("x, y, d, made, tcode").eq("gmkey", gmkey);
  return (data ?? []) as ShotRow[];
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

  const [teamStats, playerStats, events, pregameFeatures, actionLabels, shots] = await Promise.all([
    getTeamStats(gmkey),
    getPlayerStats(gmkey),
    getEvents(gmkey),
    getPregameFeatures(gmkey),
    getActionLabels(),
    getShots(gmkey),
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

  // 매치업 패널(README "다음 단계" - 매치업/선수 프로필/득점 분포 중 첫 번째) - 전부
  // games/game_team_stats에서 라이브로 계산 가능해서(정적 페이지처럼 미리 구운 JSON이
  // 필요 없음) 새 마이그레이션 없이 바로 포팅.
  let homeSeasonStats = null as Awaited<ReturnType<typeof getSeasonStatsAsOf>>;
  let awaySeasonStats = null as Awaited<ReturnType<typeof getSeasonStatsAsOf>>;
  let homeSchedule: Awaited<ReturnType<typeof getRecentSchedule>> = [];
  let awaySchedule: Awaited<ReturnType<typeof getRecentSchedule>> = [];
  let h2h: Awaited<ReturnType<typeof getHeadToHead>> | null = null;
  let standings: Awaited<ReturnType<typeof getStandingsAsOf>> = [];
  let allTeams: { tcode: string; name: string; abbr: string; color: string }[] = [];
  if (game.home_team && game.away_team) {
    [homeSeasonStats, awaySeasonStats, homeSchedule, awaySchedule, h2h, standings, allTeams] = await Promise.all([
      getSeasonStatsAsOf(game.home_team.tcode, game.season_name, game.game_date),
      getSeasonStatsAsOf(game.away_team.tcode, game.season_name, game.game_date),
      getRecentSchedule(game.home_team.tcode, game.game_date),
      getRecentSchedule(game.away_team.tcode, game.game_date),
      getHeadToHead(game.home_team.tcode, game.away_team.tcode, game.game_date),
      getStandingsAsOf(game.season_name, game.game_date),
      supabase.from("teams").select("tcode, name, abbr, color").then((r) => r.data ?? []),
    ]);
  }
  const teamMetaByTcode = new Map(allTeams.map((t) => [t.tcode, t]));

  // 득점 분포(README "다음 단계" 세 번째) - shot_log는 이미 마이그레이션돼 있어서 새 작업
  // 없이 바로 포팅. lib/zoneCompare.ts가 courtside_template.html의 teamZoneStats/
  // renderZoneCompare/drawCourtMarkings/drawHoop을 그대로 옮김.
  const zoneCompareSvg =
    shots.length > 0 && game.home_team && game.away_team
      ? buildZoneCompareSvg(teamZoneStats(shots, game.home_team.tcode), teamZoneStats(shots, game.away_team.tcode))
      : null;

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
              <td>
                <Link href={`/players/${p.pcode}`}>{p.player?.name ?? p.pcode}</Link>
              </td>
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

      {(homeSeasonStats || awaySeasonStats) && (
        <div className="panel">
          <div className="panel-title">시즌 평균 비교 ({(homeSeasonStats ?? awaySeasonStats)?.gp}경기 기준, 이 경기 이전)</div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{game.home_team?.name}</th>
                  <th>항목</th>
                  <th>{game.away_team?.name}</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["경기당 득점", "ppg"],
                    ["경기당 실점", "oppPpg"],
                    ["3점 성공", "threePg"],
                    ["어시스트", "astPg"],
                    ["리바운드", "rebPg"],
                    ["스틸", "stlPg"],
                    ["블록", "blkPg"],
                    ["턴오버", "tovPg"],
                  ] as const
                ).map(([label, key]) => (
                  <tr key={key}>
                    <td>{homeSeasonStats ? homeSeasonStats[key].toFixed(1) : "-"}</td>
                    <td>{label}</td>
                    <td>{awaySeasonStats ? awaySeasonStats[key].toFixed(1) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(homeSchedule.length > 0 || awaySchedule.length > 0) && (
        <div className="panel">
          <div className="panel-title">최근 결과 (이 경기 이전 5경기)</div>
          <div className="matchup-schedule-grid">
            {[
              [game.home_team, homeSchedule],
              [game.away_team, awaySchedule],
            ].map(([team, sched], i) => (
              <div className="sched-col" key={i}>
                <div className="sched-col-title">{(team as TeamRef)?.name}</div>
                {(sched as typeof homeSchedule).map((g) => (
                  <div className="sched-row" key={g.gmkey}>
                    <span className={`sched-result ${g.teamScore > g.oppScore ? "win" : "loss"}`}>
                      {g.teamScore > g.oppScore ? "W" : "L"}
                    </span>
                    <span className="sched-opp">
                      {g.isHome ? "vs" : "@"} {g.oppName}
                    </span>
                    <span className="sched-score">
                      {g.teamScore}-{g.oppScore}
                    </span>
                  </div>
                ))}
                {(sched as typeof homeSchedule).length === 0 && <div className="empty-note">기록 없음</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {h2h && (
        <div className="panel">
          <div className="panel-title">역대 맞대결</div>
          {h2h.meetings > 0 ? (
            <>
              <p className="report-text">
                역대 맞대결 {h2h.meetings}경기 - {game.home_team?.name} {h2h.homeWins}승, {game.away_team?.name} {h2h.awayWins}승
              </p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>날짜</th>
                      <th>홈</th>
                      <th>스코어</th>
                      <th>원정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h2h.recentMeetings.map((m) => (
                      <tr key={m.gmkey}>
                        <td>{m.gameDate}</td>
                        <td>{teamMetaByTcode.get(m.homeTcode)?.name ?? m.homeTcode}</td>
                        <td>
                          {m.homeScore}-{m.awayScore}
                        </td>
                        <td>{teamMetaByTcode.get(m.awayTcode)?.name ?? m.awayTcode}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="empty-note">이 경기 이전 맞대결 기록 없음(첫 대결 또는 신생팀)</div>
          )}
        </div>
      )}

      {standings.length > 0 && (
        <div className="panel">
          <div className="panel-title">
            리그 순위 ({game.season_name} 정규시즌, 이 경기 시점 기준)
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>팀</th>
                  <th>W</th>
                  <th>L</th>
                  <th>PCT</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((r, i) => {
                  const tm = teamMetaByTcode.get(r.tcode);
                  const isCurrent = r.tcode === game.home_team?.tcode || r.tcode === game.away_team?.tcode;
                  return (
                    <tr key={r.tcode} style={isCurrent ? { color: tm?.color } : undefined}>
                      <td>{i + 1}</td>
                      <td>{tm?.name ?? r.tcode}</td>
                      <td>{r.wins}</td>
                      <td>{r.losses}</td>
                      <td>{(r.pct * 100).toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">승률 흐름 (game_events, {events.length}개 이벤트)</div>
        <WinProbChart events={events} homeColor={game.home_team?.color ?? "#888"} />
      </div>

      {zoneCompareSvg && (
        <div className="panel">
          <div className="panel-title">구역별 시도·성공 비교 (막대가 길수록 시도 많음, shot_log {shots.length}건)</div>
          <div className="zc-court-tilt">
            <svg className="zc-court" viewBox="355 27 375 357" dangerouslySetInnerHTML={{ __html: zoneCompareSvg }} />
          </div>
          <div className="zone-compare-legend">
            <span className="zcl-home">● {game.home_team?.name}</span>
            <span className="zcl-away">{game.away_team?.name} ●</span>
          </div>
        </div>
      )}

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
