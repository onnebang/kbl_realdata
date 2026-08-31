import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { attachDerivedFields, buildPostgameReport, type GameEvent, type PlayerBox } from "@/lib/postgameReport";
import { pregameInsightItems, type PregameFeatures } from "@/lib/pregameInsights";
import { getGameRarity } from "@/lib/rarity";
import { getSeasonStatsAsOf, getRecentSchedule, getHeadToHead, getStandingsAsOf } from "@/lib/matchups";
import { type ShotRow } from "@/lib/zoneCompare";
import { displayTeamName } from "@/lib/teamNames";
import { collectAllOnCourtLineups, subComboKeys } from "@/lib/gameLineups";
import { getLineupRatings, getPlayerOnOffRatings, type LineupRating, type PlayerOnOff } from "@/lib/lineupNetRating";
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
  back_num: string | null;
  player: { name: string; photo_url: string | null } | null;
};

// min_played는 이미 위 select에 들어있던 필드(실측 - game_player_stats 100,921행 중
// null은 0건, "0.00"이 곧 DNP) - GameReplay.tsx의 박스스코어 테이블이 "DNP-COACH'S
// DECISION" 행을 그리는 데 필요해서 replayPlayers 매핑에만 새로 얹음(아래).

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
  const game = data as unknown as GameInfo;
  // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 이 경기의 season_name
  // 기준으로 덮어씀. 이 함수 하나만 고치면 이 파일 전체(매치업 배너/박스스코어/슛차트
  // 등 game.home_team/away_team을 읽는 모든 곳)에 자동으로 반영됨.
  if (game.home_team) game.home_team.name = displayTeamName(game.home_team.tcode, game.home_team.name, game.season_name);
  if (game.away_team) game.away_team.name = displayTeamName(game.away_team.tcode, game.away_team.name, game.season_name);
  return game;
}

async function getTeamStats(gmkey: string) {
  const { data } = await supabase
    .from("game_team_stats")
    .select("tcode, score, reb, ast, stl, blk, turnovers, fouls, fgm, fga, tpm, tpa, ftm, fta")
    .eq("gmkey", gmkey);
  return (data ?? []) as TeamStatRow[];
}

async function getPlayerStats(gmkey: string) {
  // player:players(name, photo_url) - 새 포제션 피드(components/GameReplay.tsx의
  // PlayerPhoto)가 득점자/어시스트/스틸-블록-리바운드 카드에 선수 사진을 보여주려면
  // photo_url이 이 경기 로스터 전체에 필요함. lib/playerProfile.ts의 getPlayerInfo가
  // 이미 players.photo_url을 쓰는 것과 같은 필드 - 선수별로 따로 조회(N+1)하는 대신 이미
  // 있는 이 쿼리(경기당 한 번, 로스터 전체 포함)에 열만 얹어서 해결. back_num도 사진이
  // 없는 선수의 폴백 표시(#등번호)에 필요해서 같이 받음.
  const { data } = await supabase
    .from("game_player_stats")
    .select(
      "pcode, tcode, pts, reb, ast, stl, blk, turnovers, fouls, is_starter, min_played, fgm, fga, tpm, tpa, ftm, fta, back_num, player:players(name, photo_url)"
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
// 같이 받아둠 - zoneCompareSvg(전체 경기 요약, 하단 고정 패널)는 quarter/pcode 필드를
// 무시하고 그대로 씀(ShotRow의 상위 집합이라 타입 호환). pcode는 lib/possessionFeed.ts의
// buildShotReliability/findShotForScoreRow가 (선수,쿼터) 단위로 문자중계 타임라인과
// shot_log를 대조하는 데 필요해서 추가(이 대조 없이는 어느 슛 로그 행이 어느 포제션
// 카드의 득점인지 알 방법이 없음).
async function getShots(gmkey: string): Promise<(ShotRow & { quarter: string; pcode: string | null })[]> {
  const { data } = await supabase.from("shot_log").select("x, y, d, made, tcode, quarter, pcode").eq("gmkey", gmkey);
  return (data ?? []) as (ShotRow & { quarter: string; pcode: string | null })[];
}

// 요청: "팀별 색상을 해놨듯이, 스탯표에도 색상으로 비교" - 이 아래 바 차트들은 전부
// --home/--away(고정 주황/파랑) 토큰을 썼는데, 팀 이름/스코어보드처럼 실제 팀 브랜드 색을
// 쓰도록 변경. 다만 "색상이 비슷한 팀일 경우, 줄무늬로 다르다는 걸 체크" 요청 반영 - redmean
// 색상거리 공식(단순 유클리드보다 사람 눈 인지에 가까움)으로 두 팀 색이 너무 가까우면
// 원정 쪽만 대각선 줄무늬로 텍스처를 줘서 구분(예: 서울 SK #E4002B vs 안양 정관장 #C8102E는
// 둘 다 빨강이라 거리 ~57로 트리거됨 - threshold는 실측 KBL 팀 색상표 기준으로 잡음).
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [parseInt(clean.slice(0, 2), 16) || 0, parseInt(clean.slice(2, 4), 16) || 0, parseInt(clean.slice(4, 6), 16) || 0];
}
function colorDistance(hex1: string, hex2: string): number {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  const rMean = (r1 + r2) / 2;
  const dr = r1 - r2,
    dg = g1 - g2,
    db = b1 - b2;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}
const SIMILAR_COLOR_THRESHOLD = 90;
// 원정 막대 배경 - 색이 비슷하면 팀 색 그대로 위에 흰색 대각선 줄무늬를 겹쳐서(그 팀 색 자체는
// 유지한 채 질감만 다르게) 홈과 눈으로 구분되게. 안 비슷하면 그냥 단색.
function awayFillBackground(homeColor: string, awayColor: string): string {
  if (colorDistance(homeColor, awayColor) >= SIMILAR_COLOR_THRESHOLD) return awayColor;
  return `repeating-linear-gradient(45deg, transparent 0 4px, rgba(255,255,255,0.45) 4px 8px), ${awayColor}`;
}

// 팀 스탯 바 비교 - courtside_template.html의 tsBarHtml/tsPctRow/tsCountRow(3387~3400행)를
// 그대로 이식. 정밀 대조 전에는 이 자리가 그냥 숫자만 나열한 data-table이었는데, 원본은
// 스탯마다 홈 막대(오른쪽 끝에서 왼쪽으로 자람)와 원정 막대(왼쪽 끝에서 오른쪽으로 자람)가
// 가운데서 마주보는 형태 - .ts-row/.ts-nums/.ts-bar(globals.css)에 그 스타일을 그대로 추가.
function tsBarRow(
  label: string,
  hVal: number,
  aVal: number,
  hDisp: ReactNode,
  aDisp: ReactNode,
  hColor: string,
  aColor: string
) {
  const total = hVal + aVal;
  const hPct = total > 0 ? (hVal / total) * 100 : 50;
  return (
    <div className="ts-row" key={label}>
      <div className="ts-nums">
        <span className="ts-home" style={{ color: hColor }}>
          {hDisp}
        </span>
        <span className="ts-label">{label}</span>
        <span className="ts-away" style={{ color: aColor }}>
          {aDisp}
        </span>
      </div>
      <div className="ts-bar">
        <div className="ts-bar-fill" style={{ width: `${hPct}%`, background: hColor }} />
        <div className="ts-bar-fill" style={{ width: `${100 - hPct}%`, background: awayFillBackground(hColor, aColor) }} />
      </div>
    </div>
  );
}
// 요청: "같은 40%라도 3점 10개 들어간 40%랑 3개 들어간 40%는 다른 느낌을 주도록" - 예전엔
// 성공률(%) 값 자체를 45:38처럼 나눠서, 시도 수가 아무리 달라도 같은 %면 항상 반반으로
// 보였음. 이제 막대 "길이"는 두 팀의 시도(attempts) 합계 대비 비중으로 나누고, 그 안에서
// "채워진 정도"만 성공률을 나타내도록 이중 구조로 변경 - 시도가 많은 쪽은 막대 자체가 길어져
// 볼륨 차이가 먼저 눈에 들어오고, 그 안의 채움 비율로 효율을 따로 읽음.
function tsPctRow(label: string, hMade: number, hAtt: number, aMade: number, aAtt: number, hColor: string, aColor: string) {
  const hPct = fgPct(hMade, hAtt);
  const aPct = fgPct(aMade, aAtt);
  const totalAtt = hAtt + aAtt;
  const hShare = totalAtt > 0 ? (hAtt / totalAtt) * 100 : 50;
  return (
    <div className="ts-row" key={label}>
      <div className="ts-nums">
        <span className="ts-home" style={{ color: hColor }}>
          {hPct}% <span className="ts-raw">{hMade}-{hAtt}</span>
        </span>
        <span className="ts-label">{label}</span>
        <span className="ts-away" style={{ color: aColor }}>
          <span className="ts-raw">{aMade}-{aAtt}</span> {aPct}%
        </span>
      </div>
      <div className="ts-bar">
        <div className="ts-bar-seg" style={{ width: `${hShare}%` }}>
          <div className="ts-bar-seg-fill" style={{ width: `${hPct}%`, right: 0, background: hColor }} />
        </div>
        <div className="ts-bar-seg" style={{ width: `${100 - hShare}%` }}>
          <div
            className="ts-bar-seg-fill"
            style={{ width: `${aPct}%`, left: 0, background: awayFillBackground(hColor, aColor) }}
          />
        </div>
      </div>
    </div>
  );
}
function tsCountRow(label: string, hVal: number, aVal: number, hColor: string, aColor: string) {
  return tsBarRow(label, hVal, aVal, hVal, aVal, hColor, aColor);
}
// 요청: "시즌평균 비교를 그래프를 통해서 비교" - 표 대신 위 tsBarRow와 같은 다이버징 바.
// 시즌 평균은 소수 1자리라 tsCountRow처럼 정수 그대로 쓰지 않고 toFixed(1) 문자열로 표시.
function tsAvgRow(label: string, hVal: number, aVal: number, hColor: string, aColor: string) {
  return tsBarRow(label, hVal, aVal, hVal.toFixed(1), aVal.toFixed(1), hColor, aColor);
}
function fgPct(m: number | null | undefined, a: number | null | undefined) {
  const mm = m ?? 0,
    aa = a ?? 0;
  return aa > 0 ? Math.round((mm / aa) * 100) : 0;
}

export default async function GamePage({
  params,
}: {
  params: Promise<{ gmkey: string }>;
}) {
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
  // tsPctRow/tsCountRow/tsAvgRow(팀 스탯·시즌 평균 비교 바)에 공통으로 넘길 팀 색상 - 색이
  // null인 경우는 사실상 없지만 타입상 대비.
  const hColor = game.home_team?.color ?? "#888888";
  const aColor = game.away_team?.color ?? "#888888";

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
  // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - allTeams는 teams 전체를 시즌
  // 문맥 없이 가져온 정적 목록이라, 지금 보고 있는 이 경기의 season_name 기준으로
  // 표시 이름만 덮어씀(순위표/역대 맞대결/최근 일정 배지가 전부 이 맵을 씀).
  const teamMetaByTcode = new Map(
    allTeams.map((t) => [t.tcode, { ...t, name: displayTeamName(t.tcode, t.name, game.season_name) }])
  );

  // 요청: "선수 기록과 인터랙티브 리플레이의 선수기록이 중복" - 독립 선수기록 패널을
  // 없애고 GameReplay의 boxTable로 흡수시키면서, 그쪽에서도 선발/벤치 구분선을 그리려면
  // is_starter가 필요해서 같이 넘김.
  const replayPlayers = playerStats.map((p) => ({
    pcode: p.pcode,
    name: p.player?.name ?? p.pcode,
    tcode: p.tcode,
    isStarter: p.is_starter,
    photoUrl: p.player?.photo_url ?? null,
    backNum: p.back_num,
    minPlayed: p.min_played,
  }));

  // 요청: "라인업 조합별(1~5인) 넷레이팅 표시" - tools/build_synergy_matchup.py가 이미
  // 계산해둔 lineup_combo 테이블을 조회하되, 로스터 전체 조합(수백~수천 개)이 아니라 이
  // 경기에서 실제로 코트에 나왔던 라인업의 부분조합만(gameLineups.collectAllOnCourtLineups)
  // 서버에서 한 번에 조회해 클라이언트로 넘김 - 스크럽 중엔 네트워크 호출 없이 맵 조회만.
  let lineupRatings: Record<string, LineupRating> = {};
  if (game.home_team && game.away_team && derivedEvents.length > 0) {
    const homeLineups = collectAllOnCourtLineups(derivedEvents, replayPlayers, game.home_team.tcode);
    const awayLineups = collectAllOnCourtLineups(derivedEvents, replayPlayers, game.away_team.tcode);
    const keys = new Set<string>();
    for (const lineup of [...homeLineups, ...awayLineups]) for (const k of subComboKeys(lineup)) keys.add(k);
    const ratingsMap = await getLineupRatings(Array.from(keys));
    lineupRatings = Object.fromEntries(ratingsMap);
  }

  // "코트 위" 패널의 온/오프 넷레이팅(요청) - 라인업 조합과 달리 이 경기 로스터 전원 pcode로
  // 바로 조회(부분조합 전개 불필요). 스크럽 위치와 무관한 정적 값이라 서버에서 한 번만.
  let playerOnOff: Record<string, PlayerOnOff> = {};
  if (replayPlayers.length > 0) {
    const onOffMap = await getPlayerOnOffRatings(replayPlayers.map((p) => p.pcode));
    playerOnOff = Object.fromEntries(onOffMap);
  }

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

      {/* 요청: "인터랙티브 리플레이가 메인이 되도록" - 예전엔 프리뷰/매치업/순위 패널들을
          다 읽은 다음에야 나왔는데, 이제 리플레이를 배너 바로 다음(메인)으로 올리고 그
          프리뷰 정보들은 아래 접이식 하나로 묶음. */}
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
          homeNetRating={homeSeasonStats ? homeSeasonStats.ppg - homeSeasonStats.oppPpg : null}
          awayNetRating={awaySeasonStats ? awaySeasonStats.ppg - awaySeasonStats.oppPpg : null}
          lineupRatings={lineupRatings}
          playerOnOff={playerOnOff}
        />
      )}

      {/* 요청: "프리뷰 인사이트 자세히 보기를 누르면 펼쳐서 보여줌" - 5개 패널(더 깊은
          프리뷰 인사이트/시즌 평균 비교/최근 결과/역대 맞대결/리그 순위)을 하나의 접이식
          안으로. 순수 CSS <details>라 클라이언트 JS 불필요(이 사이트 컨벤션 - "정말 필요할
          때만 client component"), 기본은 접힘. */}
      {(pregameLines.length > 0 ||
        homeSeasonStats ||
        awaySeasonStats ||
        homeSchedule.length > 0 ||
        awaySchedule.length > 0 ||
        h2h ||
        standings.length > 0) && (
        <details className="panel preview-details">
          <summary className="preview-details-summary">프리뷰 인사이트 자세히 보기</summary>
          <div className="preview-details-body">
            {pregameLines.length > 0 && (
              <div className="preview-subsection">
                <div className="panel-title">더 깊은 프리뷰 인사이트</div>
                <ul className="report-list">
                  {pregameLines.map((line, i) => (
                    <li key={i} dangerouslySetInnerHTML={{ __html: line }} />
                  ))}
                </ul>
              </div>
            )}

            {(homeSeasonStats || awaySeasonStats) && (
              <div className="preview-subsection">
                <div className="panel-title">시즌 평균 비교 ({(homeSeasonStats ?? awaySeasonStats)?.gp}경기 기준, 이 경기 이전)</div>
                <div className="ts-header">
                  <span style={{ color: game.home_team?.color }}>{game.home_team?.name}</span>
                  <span style={{ color: game.away_team?.color }}>{game.away_team?.name}</span>
                </div>
                {tsAvgRow("경기당 득점", homeSeasonStats?.ppg ?? 0, awaySeasonStats?.ppg ?? 0, hColor, aColor)}
                {tsAvgRow("경기당 실점", homeSeasonStats?.oppPpg ?? 0, awaySeasonStats?.oppPpg ?? 0, hColor, aColor)}
                {tsAvgRow("3점 성공", homeSeasonStats?.threePg ?? 0, awaySeasonStats?.threePg ?? 0, hColor, aColor)}
                {tsAvgRow("어시스트", homeSeasonStats?.astPg ?? 0, awaySeasonStats?.astPg ?? 0, hColor, aColor)}
                {tsAvgRow("리바운드", homeSeasonStats?.rebPg ?? 0, awaySeasonStats?.rebPg ?? 0, hColor, aColor)}
                {tsAvgRow("스틸", homeSeasonStats?.stlPg ?? 0, awaySeasonStats?.stlPg ?? 0, hColor, aColor)}
                {tsAvgRow("블록", homeSeasonStats?.blkPg ?? 0, awaySeasonStats?.blkPg ?? 0, hColor, aColor)}
                {tsAvgRow("턴오버", homeSeasonStats?.tovPg ?? 0, awaySeasonStats?.tovPg ?? 0, hColor, aColor)}
              </div>
            )}

            {(homeSchedule.length > 0 || awaySchedule.length > 0) && (
              <div className="preview-subsection">
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
              <div className="preview-subsection">
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
              <div className="preview-subsection">
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
          </div>
        </details>
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
        <div className="panel-title">팀 스탯</div>
        {homeTeam && awayTeam ? (
          <>
            {tsPctRow("FG%", homeTeam.fgm ?? 0, homeTeam.fga ?? 0, awayTeam.fgm ?? 0, awayTeam.fga ?? 0, hColor, aColor)}
            {tsPctRow("3PT%", homeTeam.tpm ?? 0, homeTeam.tpa ?? 0, awayTeam.tpm ?? 0, awayTeam.tpa ?? 0, hColor, aColor)}
            {tsPctRow("FT%", homeTeam.ftm ?? 0, homeTeam.fta ?? 0, awayTeam.ftm ?? 0, awayTeam.fta ?? 0, hColor, aColor)}
            {tsCountRow("턴오버", homeTeam.turnovers ?? 0, awayTeam.turnovers ?? 0, hColor, aColor)}
            {tsCountRow("리바운드", homeTeam.reb ?? 0, awayTeam.reb ?? 0, hColor, aColor)}
            {tsCountRow("어시스트", homeTeam.ast ?? 0, awayTeam.ast ?? 0, hColor, aColor)}
            {tsCountRow("스틸", homeTeam.stl ?? 0, awayTeam.stl ?? 0, hColor, aColor)}
            {tsCountRow("블록", homeTeam.blk ?? 0, awayTeam.blk ?? 0, hColor, aColor)}
            {tsCountRow("파울", homeTeam.fouls ?? 0, awayTeam.fouls ?? 0, hColor, aColor)}
            {tsCountRow("최대 리드", largestLeadHome, largestLeadAway, hColor, aColor)}
          </>
        ) : (
          <div className="empty-note">팀 스탯 데이터 없음</div>
        )}
      </div>

      <footer className="foot">Supabase에서 실시간 조회 · {gmkey}</footer>
    </div>
  );
}
