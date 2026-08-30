import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { attachDerivedFields, buildPostgameReport, type GameEvent, type PlayerBox } from "@/lib/postgameReport";
import { pregameInsightItems, type PregameFeatures } from "@/lib/pregameInsights";
import { getGameRarity } from "@/lib/rarity";
import { getSeasonStatsAsOf, getRecentSchedule, getHeadToHead, getStandingsAsOf } from "@/lib/matchups";
import { buildCourtDotsSvg, shotValue, type ShotRow } from "@/lib/zoneCompare";
import { TeamBadge } from "@/components/TeamBadge";
import GameReplay from "@/components/GameReplay";

type TeamRef = { tcode: string; name: string; abbr: string; color: string; logo_url: string | null } | null;

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
       home_team:teams!games_home_tcode_fkey(tcode, name, abbr, color, logo_url),
       away_team:teams!games_away_tcode_fkey(tcode, name, abbr, color, logo_url)`
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

// GameReplay(인터랙티브 리플레이)가 "현재 쿼터까지" 슛만 필터링하는 데 quarter가 필요해서
// 같이 받아둠 - zoneCompareSvg(전체 경기 요약, 하단 고정 패널)는 quarter 필드를 무시하고
// 그대로 씀(ShotRow의 상위 집합이라 타입 호환).
async function getShots(gmkey: string): Promise<(ShotRow & { quarter: string })[]> {
  const { data } = await supabase.from("shot_log").select("x, y, d, made, tcode, quarter").eq("gmkey", gmkey);
  return (data ?? []) as (ShotRow & { quarter: string })[];
}

// courtside_template.html의 buildChartStatic()/updateChart(idx)(2508~2545행) 스타일을
// 그대로 이식 - 50% 기준 점선 + 쿼터 경계 세로선 + 곡선 아래 영역 채우기(area fill) +
// 마지막 지점 세로 가이드선/점. 이전 구현은 이 중 area fill과 쿼터 경계선이 빠져 있었고,
// 대신 템플릿에 없는 좌상단/좌하단 "홈100%/원정100%" 축 라벨이 들어가 있었음(제거).
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
    PAD = 0;
  const n = valid.length;
  const xOf = (i: number) => PAD + (i / Math.max(1, n - 1)) * (W - 2 * PAD);
  const yOf = (p: number) => PAD + (1 - p) * (H - 2 * PAD);
  const points = valid.map((e, i) => [xOf(i), yOf(e.home_win_prob as number)] as const);
  const linePath = "M " + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ");
  const areaPath = `${linePath} L ${points[points.length - 1][0].toFixed(1)} ${H} L 0 ${H} Z`;
  const midY = H / 2;

  // 쿼터 경계선(qBounds) - valid 배열 안에서 쿼터가 바뀌는 첫 지점의 x좌표.
  const quarterBounds: { x: number; q: string }[] = [];
  let lastQ: string | null = null;
  valid.forEach((e, i) => {
    if (e.quarter !== "PRE" && e.quarter !== lastQ) {
      quarterBounds.push({ x: xOf(i), q: e.quarter });
      lastQ = e.quarter;
    }
  });

  const last = points[points.length - 1];
  const finalProb = Math.round((valid[valid.length - 1].home_win_prob as number) * 100);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 160, display: "block" }}>
      <line x1={0} y1={midY} x2={W} y2={midY} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="3,4" />
      {quarterBounds.map((b) => (
        <line key={b.q} x1={b.x} y1={0} x2={b.x} y2={H} stroke="var(--ink-faint)" strokeWidth={1} opacity={0.35} />
      ))}
      <path d={areaPath} fill={homeColor} fillOpacity={0.12} />
      <path d={linePath} fill="none" stroke={homeColor} strokeWidth={2} />
      <line x1={last[0]} y1={0} x2={last[0]} y2={H} stroke="var(--ink)" strokeWidth={1.4} opacity={0.55} />
      <circle cx={last[0]} cy={last[1]} r={5.5} fill="var(--ink)" stroke="var(--surface)" strokeWidth={2} />
      <text x={last[0]} y={Math.max(12, last[1] - 10)} textAnchor="end" fontSize={11} fill={homeColor} fontWeight={700} fontFamily="IBM Plex Mono, monospace">
        최종 홈 승률 {finalProb}%
      </text>
    </svg>
  );
}

// 팀 스탯 바 비교 - courtside_template.html의 tsBarHtml/tsPctRow/tsCountRow(3387~3400행)를
// 그대로 이식. 정밀 대조 전에는 이 자리가 그냥 숫자만 나열한 data-table이었는데, 원본은
// 스탯마다 홈 막대(오른쪽 끝에서 왼쪽으로 자람)와 원정 막대(왼쪽 끝에서 오른쪽으로 자람)가
// 가운데서 마주보는 형태 - .ts-row/.ts-nums/.ts-bar(globals.css)에 그 스타일을 그대로 추가.
function tsBarRow(label: string, hVal: number, aVal: number, hDisp: ReactNode, aDisp: ReactNode) {
  const total = hVal + aVal;
  const hPct = total > 0 ? (hVal / total) * 100 : 50;
  return (
    <div className="ts-row" key={label}>
      <div className="ts-nums">
        <span className="ts-home">{hDisp}</span>
        <span className="ts-label">{label}</span>
        <span className="ts-away">{aDisp}</span>
      </div>
      <div className="ts-bar">
        <div className="ts-bar-fill home" style={{ width: `${hPct}%` }} />
        <div className="ts-bar-fill away" style={{ width: `${100 - hPct}%` }} />
      </div>
    </div>
  );
}
// 템플릿의 tsPctRow와 동일하게, 막대 길이는 성공/시도 개수가 아니라 두 팀의 "성공률(%)"
// 값 자체를 서로 비교해 나눔(예: 45% vs 38% → 45:38 비율로 막대 분할).
function tsPctRow(label: string, hPct: number, aPct: number, hRaw: string, aRaw: string) {
  return tsBarRow(
    label,
    hPct,
    aPct,
    <>
      {hPct}% <span className="ts-raw">{hRaw}</span>
    </>,
    <>
      <span className="ts-raw">{aRaw}</span> {aPct}%
    </>
  );
}
function tsCountRow(label: string, hVal: number, aVal: number) {
  return tsBarRow(label, hVal, aVal, hVal, aVal);
}
function fgPct(m: number | null | undefined, a: number | null | undefined) {
  const mm = m ?? 0,
    aa = a ?? 0;
  return aa > 0 ? Math.round((mm / aa) * 100) : 0;
}

export default async function GamePage({
  params,
  searchParams,
}: {
  params: Promise<{ gmkey: string }>;
  searchParams: Promise<{ outcome?: string; value?: string; quarter?: string }>;
}) {
  const { gmkey } = await params;
  const { outcome, value, quarter } = await searchParams;
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

  // 최대 리드(팀 스탯 바의 마지막 행) - courtside_template.html의 renderTeamStats()가
  // timeline을 훑어 계산하던 것과 동일하게 game_events 전체를 훑음.
  let largestLeadHome = 0;
  let largestLeadAway = 0;
  for (const e of events) {
    const diff = e.home_score - e.away_score;
    if (diff > largestLeadHome) largestLeadHome = diff;
    if (-diff > largestLeadAway) largestLeadAway = -diff;
  }

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
  let allTeams: { tcode: string; name: string; abbr: string; color: string; logo_url: string | null }[] = [];
  if (game.home_team && game.away_team) {
    [homeSeasonStats, awaySeasonStats, homeSchedule, awaySchedule, h2h, standings, allTeams] = await Promise.all([
      getSeasonStatsAsOf(game.home_team.tcode, game.season_name, game.game_date),
      getSeasonStatsAsOf(game.away_team.tcode, game.season_name, game.game_date),
      getRecentSchedule(game.home_team.tcode, game.game_date),
      getRecentSchedule(game.away_team.tcode, game.game_date),
      getHeadToHead(game.home_team.tcode, game.away_team.tcode, game.game_date),
      getStandingsAsOf(game.season_name, game.game_date),
      supabase.from("teams").select("tcode, name, abbr, color, logo_url").then((r) => r.data ?? []),
    ]);
  }
  const teamMetaByTcode = new Map(allTeams.map((t) => [t.tcode, t]));

  // 실제 슛 위치 점 차트(구역 막대 대신) - perthirtysix.com(NBA 데이터 저널리즘 사이트)을
  // 레퍼런스로 사용자가 요청한 업그레이드("우리가 만든 팀 그래프를, 위 사이트와 같이
  // 비교"). 필터(성공여부/슛종류/쿼터)는 이 사이트 전체 컨벤션대로 query-param GET 폼으로
  // 서버에서 필터링(클라이언트 JS 없음) - 경기당 shot_log가 보통 100~300건이라 매번
  // .filter()해도 비용 무시 가능. perthirtysix는 시즌 전체(수천 개) 슛이라 hexbin
  // 밀도가 맞지만, 한 경기 단위는 이 정도 개수면 점 하나하나가 더 읽기 쉬움
  // (lib/zoneCompare.ts의 buildCourtDotsSvg 참고).
  const shotQuarters = Array.from(new Set(shots.map((s) => s.quarter)));
  const filteredShots = shots.filter((s) => {
    if (outcome === "make" && !s.made) return false;
    if (outcome === "miss" && s.made) return false;
    if (value && value !== "all" && shotValue(s.x, s.y, s.d) !== Number(value)) return false;
    if (quarter && quarter !== "all" && s.quarter !== quarter) return false;
    return true;
  });
  const homeFilteredShots = game.home_team ? filteredShots.filter((s) => s.tcode === game.home_team!.tcode) : [];
  const awayFilteredShots = game.away_team ? filteredShots.filter((s) => s.tcode === game.away_team!.tcode) : [];
  const homeShotDotsSvg = game.home_team ? buildCourtDotsSvg(homeFilteredShots, game.home_team.color) : null;
  const awayShotDotsSvg = game.away_team ? buildCourtDotsSvg(awayFilteredShots, game.away_team.color) : null;

  const replayPlayers = playerStats.map((p) => ({ pcode: p.pcode, name: p.player?.name ?? p.pcode, tcode: p.tcode }));

  // 선발/벤치 구분선 - courtside_template.html의 .bench-divider(코트 위 패널에서 현재
  // 라인업 5인 다음 벤치 선수들 사이에 "벤치" 텍스트 행을 넣던 것)를 정적 박스스코어
  // 테이블 컨텍스트로 옮김. 원본은 "지금 코트 위에 있는가"(실시간 교체 추적) 기준이지만,
  // 이 정적 테이블엔 그 데이터가 없어 game_player_stats.is_starter(선발 여부)로 대체.
  const playerRow = (p: PlayerStatRow) => (
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
  );
  const playerTable = (rows: PlayerStatRow[]) => {
    const starters = rows.filter((p) => p.is_starter);
    const bench = rows.filter((p) => !p.is_starter);
    return (
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
            {starters.map(playerRow)}
            {starters.length > 0 && bench.length > 0 && (
              <tr className="bench-divider-row">
                <td colSpan={10}>벤치</td>
              </tr>
            )}
            {bench.map(playerRow)}
          </tbody>
        </table>
      </div>
    );
  };

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
          <TeamBadge
            team={game.home_team ? { name: game.home_team.name, abbr: game.home_team.abbr, color: "#ffffff33", logoUrl: game.home_team.logo_url } : null}
            size={36}
          />
          <span className="matchup-banner-name">{game.home_team?.name ?? game.gmkey}</span>
          <span className="matchup-banner-score">{game.home_score}</span>
        </div>
        <div className="matchup-banner-vs">VS</div>
        <div className="matchup-banner-side away" style={{ background: game.away_team?.color ?? "#888" }}>
          <span className="matchup-banner-score">{game.away_score}</span>
          <span className="matchup-banner-name">{game.away_team?.name ?? ""}</span>
          <TeamBadge
            team={game.away_team ? { name: game.away_team.name, abbr: game.away_team.abbr, color: "#ffffff33", logoUrl: game.away_team.logo_url } : null}
            size={36}
          />
        </div>
      </div>
      <div className="subtitle">
        {game.game_date} · {game.season_name} {game.season_category} · {game.gmkey}
      </div>

      {/* 패널 순서 - courtside_template.html 정밀 대조 결과에 맞춤: 프리뷰 정보 → 매치업 →
          순위 → 스코어보드/리플레이 → AI 리포트 → 팀스탯 → 박스스코어. 템플릿은 프리뷰/매치업/
          순위가 하나의 접이식 .preview-panel 안에 이 순서로 중첩돼 있고(797~841행), 스코어보드는
          그 앞에 sticky 헤더로 항상 보이는 별개 요소라 원본 raw DOM 순서만 보면 스코어보드가
          먼저지만 - 이 페이지는 sticky 헤더가 없는 정적 페이지라 "경기 배경 정보를 먼저 읽고
          리플레이를 보는" 흐름이 더 자연스러움. */}
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
                      {g.isHome ? "vs" : "@"} <TeamBadge team={teamMetaByTcode.get(g.oppTcode) ? { ...teamMetaByTcode.get(g.oppTcode)!, logoUrl: teamMetaByTcode.get(g.oppTcode)!.logo_url } : null} size={16} /> {g.oppName}
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
                        <td style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <TeamBadge team={teamMetaByTcode.get(m.homeTcode) ? { ...teamMetaByTcode.get(m.homeTcode)!, logoUrl: teamMetaByTcode.get(m.homeTcode)!.logo_url } : null} size={16} />
                          {teamMetaByTcode.get(m.homeTcode)?.name ?? m.homeTcode}
                        </td>
                        <td>
                          {m.homeScore}-{m.awayScore}
                        </td>
                        <td style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <TeamBadge team={teamMetaByTcode.get(m.awayTcode) ? { ...teamMetaByTcode.get(m.awayTcode)!, logoUrl: teamMetaByTcode.get(m.awayTcode)!.logo_url } : null} size={16} />
                          {teamMetaByTcode.get(m.awayTcode)?.name ?? m.awayTcode}
                        </td>
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
                      <td style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <TeamBadge team={tm ? { ...tm, logoUrl: tm.logo_url } : null} size={18} />
                        {tm?.name ?? r.tcode}
                      </td>
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

      {game.home_team && game.away_team && derivedEvents.length > 0 && (
        <GameReplay
          events={derivedEvents}
          players={replayPlayers}
          homeTeam={{
            tcode: game.home_team.tcode,
            name: game.home_team.name,
            abbr: game.home_team.abbr,
            color: game.home_team.color,
            logoUrl: game.home_team.logo_url,
          }}
          awayTeam={{
            tcode: game.away_team.tcode,
            name: game.away_team.name,
            abbr: game.away_team.abbr,
            color: game.away_team.color,
            logoUrl: game.away_team.logo_url,
          }}
          shots={shots}
        />
      )}

      {shots.length > 0 && game.home_team && game.away_team && (
        <div className="panel">
          <div className="panel-title">
            슛 차트 (shot_log {shots.length}건 중 {filteredShots.length}건 표시)
          </div>
          <form style={{ marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select name="outcome" defaultValue={outcome ?? "all"}>
              <option value="all">성공+실패</option>
              <option value="make">성공만</option>
              <option value="miss">실패만</option>
            </select>
            <select name="value" defaultValue={value ?? "all"}>
              <option value="all">2점+3점</option>
              <option value="2">2점만</option>
              <option value="3">3점만</option>
            </select>
            <select name="quarter" defaultValue={quarter ?? "all"}>
              <option value="all">전체 쿼터</option>
              {shotQuarters.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-primary">
              적용
            </button>
          </form>
          <div className="matchup-schedule-grid">
            <div>
              <div className="explorer-stat-line">
                {game.home_team.name} · {homeFilteredShots.filter((s) => s.made).length}/{homeFilteredShots.length}
              </div>
              {homeShotDotsSvg && (
                <div className="zc-court-tilt">
                  <svg className="zc-court" viewBox="355 27 375 357" dangerouslySetInnerHTML={{ __html: homeShotDotsSvg }} />
                </div>
              )}
            </div>
            <div>
              <div className="explorer-stat-line">
                {game.away_team.name} · {awayFilteredShots.filter((s) => s.made).length}/{awayFilteredShots.length}
              </div>
              {awayShotDotsSvg && (
                <div className="zc-court-tilt">
                  <svg className="zc-court" viewBox="355 27 375 357" dangerouslySetInnerHTML={{ __html: awayShotDotsSvg }} />
                </div>
              )}
            </div>
          </div>
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
        <div className="panel-title">팀 스탯</div>
        {homeTeam && awayTeam ? (
          <>
            {tsPctRow(
              "FG%",
              fgPct(homeTeam.fgm, homeTeam.fga),
              fgPct(awayTeam.fgm, awayTeam.fga),
              `${homeTeam.fgm ?? 0}-${homeTeam.fga ?? 0}`,
              `${awayTeam.fgm ?? 0}-${awayTeam.fga ?? 0}`
            )}
            {tsPctRow(
              "3PT%",
              fgPct(homeTeam.tpm, homeTeam.tpa),
              fgPct(awayTeam.tpm, awayTeam.tpa),
              `${homeTeam.tpm ?? 0}-${homeTeam.tpa ?? 0}`,
              `${awayTeam.tpm ?? 0}-${awayTeam.tpa ?? 0}`
            )}
            {tsPctRow(
              "FT%",
              fgPct(homeTeam.ftm, homeTeam.fta),
              fgPct(awayTeam.ftm, awayTeam.fta),
              `${homeTeam.ftm ?? 0}-${homeTeam.fta ?? 0}`,
              `${awayTeam.ftm ?? 0}-${awayTeam.fta ?? 0}`
            )}
            {tsCountRow("턴오버", homeTeam.turnovers ?? 0, awayTeam.turnovers ?? 0)}
            {tsCountRow("리바운드", homeTeam.reb ?? 0, awayTeam.reb ?? 0)}
            {tsCountRow("어시스트", homeTeam.ast ?? 0, awayTeam.ast ?? 0)}
            {tsCountRow("스틸", homeTeam.stl ?? 0, awayTeam.stl ?? 0)}
            {tsCountRow("블록", homeTeam.blk ?? 0, awayTeam.blk ?? 0)}
            {tsCountRow("파울", homeTeam.fouls ?? 0, awayTeam.fouls ?? 0)}
            {tsCountRow("최대 리드", largestLeadHome, largestLeadAway)}
          </>
        ) : (
          <div className="empty-note">팀 스탯 데이터 없음</div>
        )}
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
