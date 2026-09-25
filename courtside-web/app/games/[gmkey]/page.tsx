import Link from "next/link";
import type { Metadata } from "next";
import { cache, type CSSProperties, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { supabaseServer as supabase } from "@/lib/supabaseServer";
import { attachDerivedFields, buildPostgameReport, type GameEvent, type PlayerBox } from "@/lib/postgameReport";
import { teamInkStyle } from "@/lib/teamAccent";
import { pregameInsightItems, type PregameFeatures } from "@/lib/pregameInsights";
import { getGameRarity } from "@/lib/rarity";
import { getSeasonStatsAsOf, getRecentSchedule, getHeadToHead, getStandingsAsOf, getLeagueAvgOrebPct } from "@/lib/matchups";
import { type ShotRow } from "@/lib/zoneCompare";
import { displayTeamName } from "@/lib/teamNames";
import { collectAllOnCourtLineups, subComboKeys, type PlayerStartInfo } from "@/lib/gameLineups";
import { getLineupRatings, getPlayerOnOffRatings, type LineupRating, type PlayerOnOff } from "@/lib/lineupNetRating";
import { buildMatchupInsights, gradeMatchupInsights, type PreviewInsight, type PriorGameData } from "@/lib/matchupInsights";
import { getDepartedByTeam, prevSeasonName } from "@/lib/preseason";
import { getLineupWinProbs, type LineupWinProb } from "@/lib/homeGames";
import { getScheduleContext, scheduleSummary } from "@/lib/scheduleContext";
import { TeamBadge } from "@/components/TeamBadge";
import { getTeamPowerByName } from "@/lib/teamPower";
import GameReplay from "@/components/GameReplay";
import { InsightCard } from "@/components/InsightCard";
import { deriveGameStatus } from "@/lib/gameStatus";
import { cached, cachedMap, gameTtl, TTL, TAG } from "@/lib/cachePolicy";
import LiveGameProvider from "@/components/LiveGameProvider";
import LiveScore from "@/components/LiveScore";
import { WidgetBoundary } from "@/components/WidgetBoundary";

type TeamRef = { tcode: string; name: string; abbr: string; color: string; logo_url: string | null } | null;

type GameInfo = {
  gmkey: string;
  game_date: string;
  game_start: string | null;
  home_score: number | null;
  away_score: number | null;
  is_ended: boolean;
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
  // 프리뷰 인사이트("수비가 약했던 선수가 나오면 우리팀의 000이 노릴 것") - lib/matchupInsights.ts가
  // 직전 경기 로스터에서 "우리팀 usage_rtg 최고 선수"를 타깃으로 고르는 데 씀. 이미 이 쿼리(선수당
  // 한 행)에 열만 얹어서 해결 - N+1 쿼리 방지.
  usage_rtg: number | null;
  // KBL 등록 표기 3분류(GD/FD/C). game_player_stats 100,921행 전부 non-NULL이라 폴백이 필요 없다.
  // 수비 공략 포인트가 "가드의 약점을 센터가 공략"하는 문장을 만들지 않게 하는 데만 쓴다.
  pos: string | null;
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

// React cache - generateMetadata와 페이지가 같은 요청 안에서 한 번만 조회한다(요청 단위라 라이브 점수가 굳지 않는다).
const getGame = cache(async (gmkey: string): Promise<GameInfo | null> => {
  const { data, error } = await supabase
    .from("games")
    .select(
      `gmkey, game_date, game_start, home_score, away_score, is_ended, season_name, season_category,
       home_team:teams!games_home_tcode_fkey(tcode, name, abbr, color, logo_url),
       away_team:teams!games_away_tcode_fkey(tcode, name, abbr, color, logo_url)`
    )
    .eq("gmkey", gmkey)
    // single()이 아니라 maybeSingle()이어야 한다. single()은 "0행"도 에러(PGRST116)로 만드는데,
    // lib/supabaseServer.ts가 에러를 던지도록 바뀌면서 그러면 **없는 경기가 404 대신 오류 화면**이
    // 된다. maybeSingle()은 0행을 에러 없이 data=null로 주므로 아래 notFound() 경로가 살아 있고,
    // DB가 진짜로 죽었을 때만 던진다.
    .maybeSingle();
  // maybeSingle()은 "그런 경기 없음"을 error 없이 data=null로 준다. single()이었을 때는 그게
  // 에러로 와서 위의 `if (error)`가 걸러줬으므로, 여기서 null을 따로 막아야 한다.
  if (error || !data) return null;
  const game = data as unknown as GameInfo;
  // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 이 경기의 season_name
  // 기준으로 덮어씀. 이 함수 하나만 고치면 이 파일 전체(매치업 배너/박스스코어/슛차트
  // 등 game.home_team/away_team을 읽는 모든 곳)에 자동으로 반영됨.
  if (game.home_team) game.home_team.name = displayTeamName(game.home_team.tcode, game.home_team.name, game.season_name);
  if (game.away_team) game.away_team.name = displayTeamName(game.away_team.tcode, game.away_team.name, game.season_name);
  return game;
});

// ttl은 호출부가 deriveGameStatus(game)으로 구한 gameTtl()을 그대로 넘긴다(예정/진행중/종료
// 게이팅과 동일한 단일 기준 - lib/cachePolicy.ts 주석: 종료 경기는 정산 끝나면 불변, 라이브는
// 캐시 금지). 감사 지적: 이 파일의 7개 조회 함수만 캐시 없이 매 요청 Supabase를 그대로 쳤음.
async function getTeamStats(gmkey: string, ttl: number) {
  const load = async () => {
    const { data } = await supabase
      .from("game_team_stats")
      .select("tcode, score, reb, ast, stl, blk, turnovers, fouls, fgm, fga, tpm, tpa, ftm, fta")
      .eq("gmkey", gmkey);
    return (data ?? []) as TeamStatRow[];
  };
  return cached(load, ["gamePage:teamStats", gmkey], ttl, [TAG.game(gmkey)]);
}

async function getPlayerStats(gmkey: string, ttl: number) {
  // player:players(name, photo_url) - 새 포제션 피드(components/GameReplay.tsx의
  // PlayerPhoto)가 득점자/어시스트/스틸-블록-리바운드 카드에 선수 사진을 보여주려면
  // photo_url이 이 경기 로스터 전체에 필요함. lib/playerProfile.ts의 getPlayerInfo가
  // 이미 players.photo_url을 쓰는 것과 같은 필드 - 선수별로 따로 조회(N+1)하는 대신 이미
  // 있는 이 쿼리(경기당 한 번, 로스터 전체 포함)에 열만 얹어서 해결. back_num도 사진이
  // 없는 선수의 폴백 표시(#등번호)에 필요해서 같이 받음.
  const load = async () => {
    const { data } = await supabase
      .from("game_player_stats")
      .select(
        "pcode, tcode, pts, reb, ast, stl, blk, turnovers, fouls, is_starter, min_played, fgm, fga, tpm, tpa, ftm, fta, back_num, usage_rtg, pos, player:players(name, photo_url)"
      )
      .eq("gmkey", gmkey)
      .order("pts", { ascending: false });
    return (data ?? []) as unknown as PlayerStatRow[];
  };
  return cached(load, ["gamePage:playerStats", gmkey], ttl, [TAG.game(gmkey)]);
}

async function getEvents(gmkey: string, ttl: number) {
  const load = async () => {
    const { data } = await supabase
      .from("game_events")
      .select("event_order, quarter, clock_min, clock_sec, action_code, pcode, tcode, home_score, away_score, home_win_prob, wpa_home, objective_prob")
      .eq("gmkey", gmkey)
      .order("event_order", { ascending: true });
    return (data ?? []) as EventRow[];
  };
  return cached(load, ["gamePage:events", gmkey], ttl, [TAG.game(gmkey)]);
}

// action_codes(30여 개, 가벼움) 통째로 가져와 code->label 맵 - courtside_template.html의
// ACTION_LABELS 오브젝트와 같은 역할.
// 진행중 경기 전용 선수 정보 폴백(2026-09-02 이름, 2026-09-25 사진 추가 - 제보: "박스스코어가
// 아예 안 보인다"). 라이브 수집기는 game_events만 채우고 game_player_stats(공식 박스스코어)는
// 경기가 끝난 뒤 정산 배치가 넣는다. 그래서 경기 중에는 buildGameData의 nameMap이 통째로 비어
// player_name이 전부 null이 되고("null · 수비리바운드" 렌더 버그), GameReplay의 replayPlayers도
// 비어서 computeBoxScore(컴포넌트 내부, events만으로 박스스코어를 계산함 - game_player_stats에
// 의존하지 않음)가 `for (const p of players) box.set(...)`로 선수를 하나도 등록 못 해 이벤트가
// 있어도 전부 버려진다("경기 종료 후"에도 스탯이 하나도 안 보이는 원인). 이벤트에 등장한 pcode만
// players에서 직접 읽어 이름+사진을 채운다(경기당 한 번, 20~30명 규모라 가볍다). 종료된 경기는
// 박스스코어가 있으니 이 조회 자체를 하지 않는다. min_played/is_starter/back_num은 공식
// 박스스코어 전용 필드라 라이브 중엔 알 수 없음 - null로 둔다(MIN 칸이 "-"로 보이는 게, 틀린
// 값을 보여주는 것보다 정직하다).
async function getLivePlayerFallback(pcodes: string[]): Promise<Map<string, { name: string; photoUrl: string | null }>> {
  if (pcodes.length === 0) return new Map();
  const { data } = await supabase.from("players").select("pcode, name, photo_url").in("pcode", pcodes);
  return new Map((data ?? []).map((r) => [r.pcode as string, { name: r.name as string, photoUrl: (r.photo_url as string | null) ?? null }]));
}

// action_codes는 30여 개짜리 준-상수 테이블(lib/playerProfile.ts getAllTeams와 같은 부류) -
// 경기 상태와 무관하게 항상 TTL.reference로 덮는다.
async function getActionLabels(): Promise<Map<string, string>> {
  const load = async () => {
    const { data } = await supabase.from("action_codes").select("code, label");
    return new Map((data ?? []).map((r) => [r.code as string, r.label as string]));
  };
  return cachedMap(load, ["gamePage:actionLabels"], TTL.reference, [TAG.batch]);
}

async function getPregameFeatures(gmkey: string, ttl: number): Promise<PregameFeatures | null> {
  const load = async () => {
    const { data } = await supabase.from("pregame_features").select("*").eq("gmkey", gmkey).maybeSingle();
    return (data as PregameFeatures) ?? null;
  };
  return cached(load, ["gamePage:pregameFeatures", gmkey], ttl, [TAG.game(gmkey)]);
}

// GameReplay(인터랙티브 리플레이)가 "현재 쿼터까지" 슛만 필터링하는 데 quarter가 필요해서
// 같이 받아둠 - zoneCompareSvg(전체 경기 요약, 하단 고정 패널)는 quarter/pcode 필드를
// 무시하고 그대로 씀(ShotRow의 상위 집합이라 타입 호환). pcode는 lib/possessionFeed.ts의
// buildShotReliability/findShotForScoreRow가 (선수,쿼터) 단위로 문자중계 타임라인과
// shot_log를 대조하는 데 필요해서 추가(이 대조 없이는 어느 슛 로그 행이 어느 포제션
// 카드의 득점인지 알 방법이 없음). shot_order - 슛 차트 클릭→리플레이 이동(요청)의 역방향
// 매칭(lib/possessionFeed.ts의 buildShotToEventIndex)이 (선수,쿼터) 안에서 슛 순서를
// 명시적으로 정렬하는 데 씀 - .order()로 실어서 findShotForScoreRow가 기대는 "쿼리 반환
// 순서 = 슛 시간 순서"와 동일한 순서를 명시적으로 보장(ShotWithMeta 주석 참고).
async function getShots(gmkey: string, ttl: number): Promise<(ShotRow & { quarter: string; pcode: string | null; shot_order: number })[]> {
  const load = async () => {
    const { data } = await supabase
      .from("shot_log")
      .select("x, y, d, made, tcode, quarter, pcode, shot_order")
      .eq("gmkey", gmkey)
      .order("shot_order", { ascending: true });
    return (data ?? []) as (ShotRow & { quarter: string; pcode: string | null; shot_order: number })[];
  };
  return cached(load, ["gamePage:shots", gmkey], ttl, [TAG.game(gmkey)]);
}

// 프리뷰 인사이트(lib/matchupInsights.ts) - "직전 경기 전체(양 팀)"를 이 경기와 정확히 같은
// 규칙으로 GameEvent[]/PlayerBox[]로 조립해야 해서, 아래 컴포넌트 본문에 있던 rawEvents/box
// 매핑 로직을 재사용 가능한 함수로 뽑음(이 경기 자체에도, 직전 경기 두 판에도 동일하게 씀 -
// 셋 다 다른 로직을 쓰면 프리뷰와 채점이 서로 다른 기준으로 계산되는 부정직한 결과가 됨).
function buildGameData(
  playerStats: PlayerStatRow[],
  events: EventRow[],
  actionLabels: Map<string, string>,
  // 진행중 경기용 이름 폴백(getLivePlayerFallback 주석 참고). 박스스코어가 있으면 빈 맵.
  fallbackNames: Map<string, string> = new Map()
): {
  box: PlayerBox[];
  derivedEvents: GameEvent[];
  players: PlayerStartInfo[];
  minutesByPcode: Map<string, number>;
  usageByPcode: Map<string, number>;
  posByPcode: Map<string, string>;
} {
  const nameMap = new Map(playerStats.map((p) => [p.pcode, p.player?.name ?? p.pcode]));
  const rawEvents = events.map((e) => ({
    event_order: e.event_order,
    quarter: e.quarter,
    clock_min: e.clock_min,
    clock_sec: e.clock_sec,
    action_code: e.action_code,
    action_label: e.action_code ? actionLabels.get(e.action_code) ?? e.action_code : null,
    pcode: e.pcode,
    player_name: e.pcode ? nameMap.get(e.pcode) ?? fallbackNames.get(e.pcode) ?? null : null,
    tcode: e.tcode,
    home_score: e.home_score,
    away_score: e.away_score,
    home_win_prob: e.home_win_prob,
    wpa_home: e.wpa_home,
    objective_prob: e.objective_prob,
  }));
  const derivedEvents = attachDerivedFields(rawEvents);
  const box: PlayerBox[] = playerStats.map((p) => ({
    pcode: p.pcode,
    tcode: p.tcode,
    name: p.player?.name ?? p.pcode,
    is_starter: p.is_starter,
    pts: p.pts ?? 0,
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
  const players: PlayerStartInfo[] = playerStats.map((p) => ({ pcode: p.pcode, tcode: p.tcode, isStarter: p.is_starter }));
  const minutesByPcode = new Map(playerStats.map((p) => [p.pcode, p.min_played ?? 0]));
  const usageByPcode = new Map(playerStats.map((p) => [p.pcode, p.usage_rtg ?? 0]));
  const posByPcode = new Map(playerStats.map((p) => [p.pcode, (p.pos ?? "").trim()]));
  return { box, derivedEvents, players, minutesByPcode, usageByPcode, posByPcode };
}

// 위 buildGameData 하나로 "직전 경기" 전체(양 팀 box/events/players)를 PriorGameData로 조립.
// 스펙 요구대로 getPlayerStats(gmkey)/getEvents(gmkey)를 그 직전 경기의 gmkey로 그대로
// 재호출 - 이 경기 자체를 위한 쿼리와 완전히 같은 함수.
async function buildPriorGameData(
  gmkey: string | null,
  gameDate: string | null,
  priorHomeTcode: string | null,
  priorAwayTcode: string | null,
  actionLabels: Map<string, string>,
  seasonName: string | null = null // 그 직전 경기가 열린 시즌(개막 전엔 지난 시즌 - 문구에 명시하기 위해)
): Promise<PriorGameData | null> {
  if (!gmkey || !gameDate || !priorHomeTcode || !priorAwayTcode) return null;
  // "직전 경기"는 정의상 이미 끝난 경기다(이 경기보다 과거) - 항상 TTL.final로 캐시한다.
  const [pStats, pEvents] = await Promise.all([getPlayerStats(gmkey, TTL.final), getEvents(gmkey, TTL.final)]);
  if (!pStats.length || !pEvents.length) return null;
  const { box, derivedEvents, players, minutesByPcode, usageByPcode, posByPcode } = buildGameData(pStats, pEvents, actionLabels);
  return { gmkey, gameDate, seasonName: seasonName ?? undefined, homeTcode: priorHomeTcode, awayTcode: priorAwayTcode, box, events: derivedEvents, players, minutesByPcode, usageByPcode, posByPcode };
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
        <span className="ts-home team-ink" style={teamInkStyle(hColor)}>
          {hDisp}
        </span>
        <span className="ts-label">{label}</span>
        <span className="ts-away team-ink" style={teamInkStyle(aColor)}>
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
        <span className="ts-home team-ink" style={teamInkStyle(hColor)}>
          {hPct}% <span className="ts-raw">{hMade}-{hAtt}</span>
        </span>
        <span className="ts-label">{label}</span>
        <span className="ts-away team-ink" style={teamInkStyle(aColor)}>
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

// 요청: "경기전 프리뷰/경기중 인터랙티브 문자중계/경기후 AI리포트로 명확한 3막 구조" - 경기의
// 자연스러운 타임라인(경기 전 → 경기 중 → 경기 후) 순서로 페이지를 재배치하면서, 세 구간을
// "의도된 3막"으로 읽히게 각 구간 시작에 번호 배지 + 제목 + 구분선을 붙임(globals.css의
// .game-act*). 예전엔 "인터랙티브 리플레이가 메인이 되도록" 리플레이를 배너 바로 다음(맨
// 위)으로 올리고 프리뷰 정보를 그 아래 접이식으로 묶었었는데(아래 두 번째 act 직전 주석
// 참고), 이번 요청은 그 우선순위 배치보다 "경기 타임라인을 그대로 읽는" 서사 구조를 명시적으로
// 요구해서 순서를 되돌림 - 리플레이 자체의 내용/동작은 전혀 안 바꾸고 페이지 안에서의 위치와
// 라벨만 바뀜.
function ActHeader({ num, title }: { num: number; title: string }) {
  return (
    <div className="game-act-header">
      <span className="game-act-num">{num}</span>
      <span className="game-act-title">{title}</span>
      <span className="game-act-rule" />
    </div>
  );
}

/**
 * 선택적 패널 전용 폴백. lib/supabaseServer.ts가 모든 쿼리 실패를 던지게 된 뒤(조용한 빈 화면을
 * 없애려고), 이 페이지의 부수 패널 하나가 삐끗하면 경기 화면 전체가 오류가 됐다 - 라이브 중계
 * 중이라면 더 나쁘다. 실패를 삼키지는 않는다: 반드시 서버 로그에 남기고, 화면에는 그 패널만 빈다.
 *
 * NoInfer는 new Map() 같은 폴백이 T를 any로 넓히지 못하게 막는다.
 */
function soft<T>(label: string, p: Promise<T>, fallback: NoInfer<T>): Promise<T> {
  return p.catch((e: unknown) => {
    console.error("[game]", label, e);
    return fallback;
  });
}

// 캐시 미스에서 40회 안팎의 DB 왕복이 겹칠 수 있다(감사 실측). 다른 무거운 페이지와 같은 안전장치.
export const maxDuration = 60;

export async function generateMetadata({ params }: { params: Promise<{ gmkey: string }> }): Promise<Metadata> {
  const game = await getGame((await params).gmkey);
  if (!game) return {};
  const away = game.away_team?.name ?? "원정";
  const home = game.home_team?.name ?? "홈";
  const status = deriveGameStatus(game);
  const date = game.game_date.slice(2).split("-").join(".");
  if (status === "final") {
    return {
      title: `${away} ${game.away_score} : ${game.home_score} ${home} (${date})`,
      description: "최종 결과 · 경기 중 승률 흐름, 박스스코어, 슛차트, 승부처",
    };
  }
  return {
    title: `${away} vs ${home} (${date}${game.game_start ? ` ${game.game_start.slice(0, 5)}` : ""})`,
    description: status === "live"
      ? "진행 중 · 실시간 승률과 문자중계"
      : "경기 전 모델 승률, 최근 흐름, 매치업 인사이트",
  };
}

export default async function GamePage({
  params,
}: {
  params: Promise<{ gmkey: string }>;
}) {
  const { gmkey } = await params;
  const game = await getGame(gmkey);
  if (!game) notFound();

  // 예정/진행중/종료 판정 - 홈 목록과 같은 단일 정의(lib/gameStatus.ts). 이 아래의 3막
  // 게이팅은 전부 이 status만 봄(예전의 home_score != null 개별 체크 대신).
  const status = deriveGameStatus(game);
  // 예정/진행중/종료 게이팅과 동일한 기준으로 캐시 TTL도 결정(gameTtl: 라이브 0=통과,
  // 종료 86400s=불변, 예정 600s). 감사 지적: 이 페이지만 캐시가 없어 종료 경기도 매번
  // Supabase를 그대로 쳤음 - box-score API 라우트가 이미 쓰는 패턴을 그대로 가져옴.
  const ttl = gameTtl(status);

  // 매치업 배너 PWR 배지용 - 동기 함수(캐시된 JSON 읽기)라 Promise.all에 안 넣고 그냥 호출.
  const homePower = game.home_team ? getTeamPowerByName(game.home_team.name) : null;
  const awayPower = game.away_team ? getTeamPowerByName(game.away_team.name) : null;

  // 본체(팀스탯·박스스코어·이벤트·액션라벨)는 그대로 던진다 - 없으면 그릴 화면이 없다.
  // 프리뷰 지표와 슛 로그는 패널 재료라 실패해도 그 패널만 빈다.
  const [teamStats, playerStats, events, pregameFeatures, actionLabels, shots, lineupWinProbs] = await Promise.all([
    getTeamStats(gmkey, ttl),
    getPlayerStats(gmkey, ttl),
    getEvents(gmkey, ttl),
    soft("pregameFeatures", getPregameFeatures(gmkey, ttl), null),
    getActionLabels(),
    soft("shots", getShots(gmkey, ttl), []),
    // 12인 엔트리 반영 승률 - 예정 경기에만 쓴다(홈 목록 카드와 같은 규칙, lib/homeGames.ts 주석 참고).
    status === "scheduled"
      ? soft("lineupWinProbs", getLineupWinProbs([gmkey]), new Map<string, LineupWinProb>())
      : Promise.resolve(new Map<string, LineupWinProb>()),
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
  // buildGameData - 이 경기 자체와 "직전 경기"(lib/matchupInsights.ts)에 완전히 동일한 규칙으로
  // GameEvent[]/PlayerBox[]를 조립(중복 로직 제거, 위 buildGameData 정의부 주석 참고).
  // 박스스코어가 아직 없는 진행중 경기에서만 players에서 이름+사진을 보충한다
  // (getLivePlayerFallback 주석). tcode는 이벤트 자체에 이미 있어서 따로 조회할 필요 없음 -
  // 같은 선수의 첫 이벤트 tcode를 그대로 씀(경기 중 팀이 바뀔 리 없음).
  const liveTcodeByPcode = new Map<string, string>();
  for (const e of events) {
    if (e.pcode && e.tcode && !liveTcodeByPcode.has(e.pcode)) liveTcodeByPcode.set(e.pcode, e.tcode);
  }
  const livePlayerFallback =
    playerStats.length === 0 ? await getLivePlayerFallback([...liveTcodeByPcode.keys()]) : new Map<string, { name: string; photoUrl: string | null }>();
  const liveNames = new Map([...livePlayerFallback].map(([pcode, v]) => [pcode, v.name]));
  const { box, derivedEvents, players: currentGamePlayers } = buildGameData(playerStats, events, actionLabels, liveNames);


  // pregameLines는 아래 최근 일정(homeSchedule)이 있어야 "이 폼 수치가 지난 시즌 것인지"를
  // 알 수 있어서, 일정 조회가 끝난 뒤에 계산한다(선언 위치가 내려간 이유).

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
  let sched: Awaited<ReturnType<typeof getScheduleContext>> = { home: null, away: null };
  if (game.home_team && game.away_team) {
    // 여기부터는 전부 매치업 '패널'이다 - 하나가 없어도 경기 화면은 성립한다.
    // 다만 allTeams는 순위표·역대 맞대결·최근 일정 배지가 공유하는 이름 맵이라, 실패하면
    // 그 세 패널이 함께 약어로 떨어진다(빈 배열이어도 아래 teamMetaByTcode가 견딘다).
    [homeSeasonStats, awaySeasonStats, homeSchedule, awaySchedule, h2h, standings, allTeams, sched] = await Promise.all([
      soft("homeSeasonStats", getSeasonStatsAsOf(game.home_team.tcode, game.season_name, game.game_date), null),
      soft("awaySeasonStats", getSeasonStatsAsOf(game.away_team.tcode, game.season_name, game.game_date), null),
      soft("homeSchedule", getRecentSchedule(game.home_team.tcode, game.game_date), []),
      soft("awaySchedule", getRecentSchedule(game.away_team.tcode, game.game_date), []),
      soft<Awaited<ReturnType<typeof getHeadToHead>> | null>(
        "headToHead",
        getHeadToHead(game.home_team.tcode, game.away_team.tcode, game.game_date),
        null
      ),
      soft("standings", getStandingsAsOf(game.season_name, game.game_date), []),
      soft(
        "allTeams",
        // PostgREST 빌더는 PromiseLike(then만 있고 catch가 없다) - Promise로 감싸야 폴백이 붙는다.
        Promise.resolve(supabase.from("teams").select("tcode, name, abbr, color, logo_url").then((r) => r.data ?? [])),
        []
      ),
      // 일정 상황(연전/휴식/공유 구장) - **표시 전용.** 승률에는 넣지 않는다(lib/scheduleContext.ts
      // 상단에 15시즌 3,993경기 실측 근거 - 휴식일 차이의 설명력이 R2=0.0011이다).
      soft(
        "scheduleContext",
        getScheduleContext(game.gmkey, game.season_name, game.game_date, game.home_team.tcode, game.away_team.tcode),
        { home: null, away: null }
      ),
    ]);
  }
  let reportSections: { title: string; html: string }[] = [];
  if (status === "final" && game.home_score != null && game.away_score != null && derivedEvents.length > 0 && game.home_team && game.away_team) {
    // 희소성은 games 4,207행을 훑는 부수 지표다 - 없으면 리포트에서 그 문장만 빠진다.
    const rarity = await soft("gameRarity", getGameRarity(game.home_score, game.away_score), null);
    reportSections = buildPostgameReport({
      events: derivedEvents,
      box,
      homeTeam: {
        tcode: game.home_team.tcode,
        name: game.home_team.name,
        abbr: game.home_team.abbr,
        color: game.home_team.color,
      },
      awayTeam: {
        tcode: game.away_team.tcode,
        name: game.away_team.name,
        abbr: game.away_team.abbr,
        color: game.away_team.color,
      },
      homeScore: game.home_score,
      awayScore: game.away_score,
      rarity,
      // 추가 섹션 6개의 재료 - 전부 이 위에서 이미 받아 둔 것이라 새 왕복이 없다. 그래서 이 블록을
      // 시즌 스탯·맞대결 조회 뒤로 옮겼다(예전에는 그 앞에 있었다).
      shots,
      teamThrees: teamStats.map((t) => ({ tcode: t.tcode, tpm: t.tpm ?? 0, tpa: t.tpa ?? 0 })),
      h2h,
      homeSeason: homeSeasonStats,
      awaySeason: awaySeasonStats,
    });
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
  //
  // 진행중 경기는 playerStats(공식 박스스코어)가 아직 비어있어 이 목록도 통째로 비었었다 -
  // GameReplay.computeBoxScore가 `players` 목록에 있는 pcode만 집계하므로(내부에서
  // `for (const p of players) box.set(p.pcode, ...)`), 목록이 비면 이벤트가 있어도 박스스코어
  // 전체가 안 그려짐(제보: "점수판은 오르는데 선수 세부 기록이 안 보임"). livePlayerFallback으로
  // 이벤트에 등장한 pcode를 채워 넣는다 - is_starter/back_num/min_played는 공식 박스스코어
  // 전용이라 진행중엔 모름(null, MIN 칸은 "-"로 보임).
  const replayPlayers =
    playerStats.length > 0
      ? playerStats.map((p) => ({
          pcode: p.pcode,
          name: p.player?.name ?? p.pcode,
          tcode: p.tcode,
          isStarter: p.is_starter,
          photoUrl: p.player?.photo_url ?? null,
          backNum: p.back_num,
          minPlayed: p.min_played,
        }))
      : [...liveTcodeByPcode].map(([pcode, tcode]) => ({
          pcode,
          name: livePlayerFallback.get(pcode)?.name ?? pcode,
          tcode,
          isStarter: null,
          photoUrl: livePlayerFallback.get(pcode)?.photoUrl ?? null,
          backNum: null,
          minPlayed: null,
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
    const ratingsMap = await soft("lineupRatings", getLineupRatings(Array.from(keys)), new Map());
    lineupRatings = Object.fromEntries(ratingsMap);
  }

  // "코트 위" 패널의 온/오프 넷레이팅(요청) - 라인업 조합과 달리 이 경기 로스터 전원 pcode로
  // 바로 조회(부분조합 전개 불필요). 스크럽 위치와 무관한 정적 값이라 서버에서 한 번만.
  let playerOnOff: Record<string, PlayerOnOff> = {};
  if (replayPlayers.length > 0) {
    const onOffMap = await soft("playerOnOff", getPlayerOnOffRatings(replayPlayers.map((p) => p.pcode)), new Map());
    playerOnOff = Object.fromEntries(onOffMap);
  }

  // 개막 전이면 pregame_features의 "최근 3경기 / 직전 10경기" 폼 수치도 실제로는 지난 시즌
  // 경기다 - 그 시즌 라벨을 넘겨서 문장에 명시하게 한다(넘기지 않으면 기존 "최근 3경기" 그대로).
  const priorSeasonLabel =
    homeSchedule[0]?.seasonName && homeSchedule[0].seasonName !== game.season_name
      ? (() => {
          const [a, b] = homeSchedule[0].seasonName!.split("-");
          return `${a.slice(2)}-${b.slice(2)}`;
        })()
      : null;
  const pregameLines =
    pregameFeatures && game.home_team && game.away_team
      ? pregameInsightItems(pregameFeatures, game.home_team.name, game.away_team.name, priorSeasonLabel)
      : [];

  // 프리뷰 스카우팅 인사이트(lib/matchupInsights.ts, 요청 항목 1~6) + 경기 후 예측 정확도
  // 채점(항목 7) - "직전 경기"는 homeSchedule[0]/awaySchedule[0](이미 위에서 getRecentSchedule로
  // 가져온 것, date desc 정렬이라 [0]이 가장 최근)을 그대로 재사용(새 쿼리 없음). 그 직전
  // 경기 자체의 gmkey로 getPlayerStats/getEvents를 다시 호출(스펙 요구 - "같은 쿼리 함수
  // 재사용")해 완전한 박스스코어/이벤트 로그를 얻고, buildGameData로 이 경기와 동일한 규칙
  // 으로 조립.
  let previewInsights: PreviewInsight[] = [];
  let insightGrades: (string | null)[] = [];
  if (game.home_team && game.away_team) {
    const homeSched0 = homeSchedule[0] ?? null;
    const awaySched0 = awaySchedule[0] ?? null;
    // 개막 전 게이트(roster_changes 'out') - 이 시즌에 확정 로스터가 없으면 빈 맵이라 게이트 없음.
    // 직전 경기 재구성은 이 페이지에서 가장 무거운 부수 작업이다(경기를 두 개 더 조립한다).
    // 실패하면 프리뷰 인사이트 카드만 빠지고 본 경기 화면은 그대로 간다.
    const [homePriorGame, awayPriorGame, leagueAvgOrebPct, departedByTeam] = await Promise.all([
      soft(
        "homePriorGame",
        buildPriorGameData(
          homeSched0?.gmkey ?? null,
          homeSched0?.gameDate ?? null,
          homeSched0 ? (homeSched0.isHome ? game.home_team.tcode : homeSched0.oppTcode) : null,
          homeSched0 ? (homeSched0.isHome ? homeSched0.oppTcode : game.home_team.tcode) : null,
          actionLabels,
          homeSched0?.seasonName ?? null
        ),
        null
      ),
      soft(
        "awayPriorGame",
        buildPriorGameData(
          awaySched0?.gmkey ?? null,
          awaySched0?.gameDate ?? null,
          awaySched0 ? (awaySched0.isHome ? game.away_team.tcode : awaySched0.oppTcode) : null,
          awaySched0 ? (awaySched0.isHome ? awaySched0.oppTcode : game.away_team.tcode) : null,
          actionLabels,
          awaySched0?.seasonName ?? null
        ),
        null
      ),
      soft("leagueAvgOrebPct", getLeagueAvgOrebPct(game.season_name, game.game_date), null),
      soft("departedByTeam", getDepartedByTeam(game.season_name), new Map()),
    ]);

    previewInsights = await buildMatchupInsights({
      homeTcode: game.home_team.tcode,
      awayTcode: game.away_team.tcode,
      seasonName: game.season_name,
      // 개막 전(이 시즌 경기 0건)이면 시즌 누적 인사이트가 통째로 사라진다 - 그때 물러설 시즌.
      // 폴백을 쓰면 카드가 "지난 시즌 기준"이라고 스스로 밝힌다.
      prevSeasonName: prevSeasonName(game.season_name),
      gameDate: game.game_date,
      homeSchedule,
      awaySchedule,
      homeSeasonStats,
      awaySeasonStats,
      leagueAvgOrebPct,
      // 승률 인사이트 - 이벤트가 있으면 기존 그대로 첫 이벤트(경기 전 모델 예측)를,
      // 예정 경기(이벤트 없음)는 tools/sync_upcoming_games.py가 pregame_features에 넣어둔
      // 같은 모델의 예측(home_win_prob)을 사용.
      homeWinProb: derivedEvents[0]?.home_win_prob ?? pregameFeatures?.home_win_prob ?? null,
      homePriorGame,
      awayPriorGame,
      homeDeparted: departedByTeam.get(game.home_team.tcode),
      awayDeparted: departedByTeam.get(game.away_team.tcode),
    });

    // 경기 후 채점 - "종료" 상태에서만(예정/진행중 경기는 채점 대상 없음).
    if (status === "final" && previewInsights.length > 0 && game.home_score != null && game.away_score != null && derivedEvents.length > 0) {
      insightGrades = gradeMatchupInsights(previewInsights, {
        box,
        events: derivedEvents,
        players: currentGamePlayers,
        homeTcode: game.home_team.tcode,
        awayTcode: game.away_team.tcode,
        homeScore: game.home_score,
        awayScore: game.away_score,
        homeTname: game.home_team.name,
        awayTname: game.away_team.name,
      });
    }
  }

  // Phase 2 - 라이브 전송 계층(웹소켓 구독 1 + 폴백 폴링 1)을 페이지당 딱 하나만 돌린다.
  // live=false(예정/종료)면 훅이 구독도 타이머도 만들지 않는다(검증 5). 서버 컴포넌트가
  // 클라이언트 프로바이더로 children을 감싸는 형태 - 본문은 그대로 서버에서 렌더된다.
  const lastEventOrder = events.length > 0 ? events[events.length - 1].event_order : 0;

  return (
    <LiveGameProvider gmkey={gmkey} live={status === "live"} initialLastOrder={lastEventOrder}>
    <div className="wrap">
      <Link href="/" className="back-link">
        ← 경기 목록
      </Link>

      {/* Act 1/3 - 경기전. 매치업 배너(항상 표시)와, 더 깊은 프리뷰 인사이트/시즌 평균
          비교/최근 결과/역대 맞대결/리그 순위를 담은 접이식 패널. */}
      <div className="game-act">
        <ActHeader num={1} title="경기전 프리뷰 인사이트" />
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
            {/* 요청("실시간 라이브 중계에서도 오버롤 시스템... 지금 파워에서 누가 더 강력한지
                직관적으로") - 승률 모델과는 별개로, 로스터 오버롤 기반 팀 파워만 배지로 상시 노출. */}
            {homePower && <span className="matchup-banner-pwr" title="팀 파워(로스터 오버롤)">PWR {homePower.ovr}</span>}
            {/* 예정 경기는 스코어 자리를 아예 비움(0-0이나 빈칸처럼 보이는 것 방지) - 가운데 VS만 */}
            {status !== "scheduled" && <LiveScore side="home" initial={game.home_score} />}
          </div>
          <div className="matchup-banner-vs">VS</div>
          <div className="matchup-banner-side away" style={{ background: game.away_team?.color ?? "#888" }}>
            {status !== "scheduled" && <LiveScore side="away" initial={game.away_score} />}
            <span className="matchup-banner-name">{game.away_team?.name ?? ""}</span>
            {awayPower && <span className="matchup-banner-pwr" title="팀 파워(로스터 오버롤)">PWR {awayPower.ovr}</span>}
            <TeamBadge
              team={game.away_team ? { name: game.away_team.name, abbr: game.away_team.abbr, color: "#ffffff33", logoUrl: game.away_team.logo_url } : null}
              size={36}
            />
          </div>
        </div>
        <div className="subtitle">
          {game.game_date}
          {status === "scheduled" && game.game_start ? ` ${game.game_start.slice(0, 5)} 예정` : ""} · {game.season_name}{" "}
          {game.season_category} · {game.gmkey}
        </div>

        {/* 요청 항목 1~6("직전 경기 활약 선수 주의/수비 약점/조합 시너지/최근 추세/오펜스
            리바운드·블록 주의/코트사이드 최종 승률") - lib/matchupInsights.ts가 만드는 구조화된
            PreviewInsight[]를 카드로. 접이식 "프리뷰 인사이트 자세히 보기"(아래, 시즌 평균/역대
            전적 등 심화 수치 자료) 안이 아니라 배너 바로 아래 항상 보이는 자리에 둔 이유 - 이
            인사이트들이 이번 요청의 핵심 신규 기능이라, 시즌 평균 비교 같은 부가 자료와 달리
            "펼쳐야만 보이는" 자리에 묻으면 안 된다고 판단(데이터가 뒷받침하지 않는 항목은
            lib/matchupInsights.ts가 애초에 생성하지 않으므로 - 예: 시즌 첫 경기라 "직전 경기"가
            없는 팀 - 이 블록 자체가 자연스럽게 비거나 줄어듦, 자리만 비워두는 플레이스홀더 없음). */}
        {previewInsights.length > 0 && (
          <div className="panel">
            {/* 개막 전엔 "직전 경기"가 지난 시즌 경기라, 고정 제목이 카드 내용과 정면으로
                어긋난다(실측 지적) - 그래서 제목도 카드와 같은 기준을 따른다. */}
            <div className="panel-title">
              스카우팅 인사이트 ({priorSeasonLabel ? `지난 시즌(${priorSeasonLabel}) 데이터 기반` : "직전 경기 · 시즌 데이터 기반"})
            </div>
            {previewInsights.map((insight, i) => (
              <InsightCard
                key={i}
                insight={insight}
                hColor={hColor}
                aColor={aColor}
                homeTname={game.home_team?.name ?? ""}
                awayTname={game.away_team?.name ?? ""}
                lineup={insight.kind === "win_prob" ? lineupWinProbs.get(gmkey) : undefined}
              />
            ))}
            {/* 이적 게이트의 실제 적용 범위를 밝힌다 - roster_changes의 이탈 행은 확정 로스터가
                들어온 범위에서만 만들어지므로, 국내 로스터 미입력 단계에서는 국내 선수의 이적을
                걸러내지 못한다. 걸러진 것처럼 보이게 두면 그 자체가 부정직하다. */}
            {priorSeasonLabel && (
              <div className="insight-caveat">
                이 카드들은 지난 시즌 기록으로 만들어지며, 이번 시즌 로스터에서 빠진 선수는 제외했습니다. 다만 제외 판정은 확정 로스터가 들어온 범위
                (현재 외국인·아시아쿼터)까지만 가능해서, 국내 선수의 이적은 아직 반영되지 않았을 수 있습니다.{" "}
                <Link href="/preseason">개막 리포트에서 로스터 변화 보기 →</Link>
              </div>
            )}
          </div>
        )}

        {/* 요청: "프리뷰 인사이트 자세히 보기를 누르면 펼쳐서 보여줌" - 5개 패널(더 깊은
            프리뷰 인사이트/시즌 평균 비교/최근 결과/역대 맞대결/리그 순위)을 하나의 접이식
            안으로. 순수 CSS <details>라 클라이언트 JS 불필요(이 사이트 컨벤션 - "정말 필요할
            때만 client component"), 기본은 접힘. 요청("3막 구조")으로 이 accordion이 이제
            독립된 최상위 act(제목까지 붙은)가 됐지만, 접힘/펼침 자체는 그대로 유지 - 매치업
            배너가 이미 핵심 정보(팀·스코어)를 보여주고, 시즌 평균/역대 전적 같은 심화 자료는
            원래도 "필요할 때만 펼쳐 보는" 성격이라 top-level act가 됐다고 항상 펼쳐 보여줄
            이유는 아님(오히려 접힌 상태 + 뚜렷한 act 제목 조합이 "여기 더 볼 게 있다"를
            더 명확히 알려줌). */}
        {(pregameLines.length > 0 ||
          homeSeasonStats ||
          awaySeasonStats ||
          homeSchedule.length > 0 ||
          awaySchedule.length > 0 ||
          h2h ||
          sched.home ||
          sched.away ||
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


              {(sched.home || sched.away) && (
                <div className="preview-subsection">
                  <div className="panel-title">일정 상황</div>
                  <div className="sched-grid">
                    {([["home", sched.home], ["away", sched.away]] as const).map(([side, c]) => {
                      if (!c) return null;
                      const team = side === "home" ? game.home_team : game.away_team;
                      const bits = scheduleSummary(c);
                      return (
                        <div className="sched-col" key={side} style={{ borderLeftColor: side === "home" ? hColor : aColor }}>
                          <div className="sched-team">
                            {team?.name}
                            <span className="sched-side">{c.isHome ? "홈" : "원정"}</span>
                          </div>
                          <div className="sched-bits">{bits.length ? bits.join(" · ") : "특별한 일정 부담 없음"}</div>
                          {c.nextRestDays != null && (
                            <div className="sched-next">
                              다음 경기까지 {c.nextRestDays <= 0 ? "하루도 못 쉼" : `${c.nextRestDays}일`}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {sched.home?.stadium && (
                    <div className="sched-venue">
                      경기장 <b>{sched.home.stadium}</b>
                      {sched.home.venueNote ? ` · ${sched.home.venueNote}` : ""}
                    </div>
                  )}
                  {/* 이 캡션이 이 섹션의 핵심이다. 숫자를 보여주되 "그래서 유리하다"고 말하지 않는다. */}
                  <div className="sched-caveat">
                    일정은 <b>참고용 표시</b>입니다. 15시즌 정규시즌 3,993경기를 전수 확인한 결과, 휴식일과 경기 결과 사이에
                    쓸 만한 관계가 나오지 않았습니다 — 홈 승률이 백투백 55.6%, 하루 쉼 55.7%, 5일 이상 쉼 53.7%로 단조 경향이
                    없고, 휴식일 차이와 득실차의 설명력은 R<sup>2</sup>=0.001입니다. 그래서 위 숫자는 승률 계산에 반영하지
                    않습니다. 이동 거리는 경기장 좌표 자체가 없어 표시하지 않습니다.
                  </div>
                </div>
              )}

              {(homeSeasonStats || awaySeasonStats) && (
                <div className="preview-subsection">
                  <div className="panel-title">시즌 평균 비교 ({(homeSeasonStats ?? awaySeasonStats)?.gp}경기 기준, 이 경기 이전)</div>
                  <div className="ts-header">
                    <span className="team-ink" style={teamInkStyle(game.home_team?.color)}>{game.home_team?.name}</span>
                    <span className="team-ink" style={teamInkStyle(game.away_team?.color)}>{game.away_team?.name}</span>
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
                            <tr key={r.tcode} className={isCurrent ? "team-ink" : undefined} style={isCurrent ? teamInkStyle(tm?.color) : undefined}>
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
      </div>

      {/* Act 2/3 - 경기중. 인터랙티브 리플레이(스코어보드/코트 위/플레이바이플레이/슛차트
          등) 전체를 그대로 담되, 이제 명시적으로 "경기 중" 구간으로 라벨링. 예전엔("요청:
          인터랙티브 리플레이가 메인이 되도록") 이 컴포넌트를 배너 바로 다음(페이지 맨
          위/최우선)으로 올렸었는데, 이번 3막 구조 요청은 그 우선순위 배치보다 "경기 전 →
          경기 중 → 경기 후"라는 시간 순서를 그대로 따르길 원해서 순서를 되돌림 - GameReplay
          내부 동작/데이터는 전혀 안 바뀜, 페이지 안에서의 위치와 섹션 라벨만 바뀜. */}
      {/* 예정 - Act 2/3 헤더 자체를 숨기고 작은 안내만(상태 게이팅은 위 deriveGameStatus). */}
      {status === "scheduled" && (
        <div className="act-locked-note">경기 시작 후 인터랙티브 문자중계가 열립니다</div>
      )}
      {status !== "scheduled" && game.home_team && game.away_team && derivedEvents.length === 0 && (
        <div className="game-act">
          <ActHeader num={2} title="경기중 인터랙티브 문자중계" />
          <div className="act-locked-note">문자중계 데이터가 아직 수신되지 않았습니다 - 잠시 후 새로고침해 주세요.</div>
        </div>
      )}
      {status !== "scheduled" && game.home_team && game.away_team && derivedEvents.length > 0 && (
        <div className="game-act">
          <ActHeader num={2} title="경기중 인터랙티브 문자중계" />
          <WidgetBoundary name="인터랙티브 문자중계">
          <GameReplay
            /* 페이로드 감사(2026-09): 예전엔 derivedEvents를 그대로 넘겼는데, 그 배열의
               action_label(14,060B) / player_name(12,855B) / elapsed·runHome·runAway·surge
               (34,382B)는 전부 클라이언트가 이미 가진 재료로 복원 가능한 값이다. 그래서
               원본 행(events)만 넘기고 GameReplay가 attachDerivedFields + 아래 두 맵으로
               같은 배열을 다시 만든다(GameReplay.tsx의 serverEvents useMemo).
               derivedEvents 자체는 그대로 남는다 - 아래 Act 3의 AI 리포트가 서버에서 그
               파생값으로 계산하기 때문. 여기서 줄인 것은 "전송"뿐이다. */
            events={events}
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
            live={status === "live"}
            /* action_codes 33행 맵(약 800B). 예전엔 라이브 경기에만 보냈지만, 행마다 라벨
               문자열을 박는 것(14,060B)보다 압도적으로 싸서 이제 항상 보낸다. 복원 규칙은
               buildGameData와 같다(맵에 없으면 코드 자체를 라벨로). */
            actionLabels={Object.fromEntries(actionLabels)}
            /* 이름은 종료 경기라면 players prop(replayPlayers)이 이미 같은 값을 들고 있어서
               따로 보낼 게 없다. 진행중 경기만 박스스코어가 없어 이 폴백이 필요하다
               (getLivePlayerFallback 주석) - 그래서 이 prop은 예전 그대로 라이브 전용. */
            liveNames={status === "live" ? Object.fromEntries(liveNames) : undefined}
          />
          </WidgetBoundary>
        </div>
      )}

      {/* Act 3/3 - 경기후. AI 코트사이드 리포트(요청 - 시간 언급 클릭 시 위 Act 2 리플레이로
          스크롤+이동, lib/postgameReport.ts의 report-jump-link) + 팀 스탯.
          진행중 경기는 헤더까지 숨기고 안내만(종료 후 daily_batch가 데이터를 채우면 자동 표시). */}
      {status === "live" && (
        <div className="act-locked-note">경기 종료 후 AI 리포트가 생성됩니다</div>
      )}
      {status === "final" && (
      <div className="game-act">
        <ActHeader num={3} title="경기후 AI코트사이드 리포트" />
        {reportSections.length > 0 && (
          <div className="panel">
            <div className="panel-title">AI 코트사이드 리포트</div>
            {reportSections.map((s) => (
              <div className="report-section" key={s.title}>
                <div className="report-section-title">{s.title}</div>
                <div dangerouslySetInnerHTML={{ __html: s.html }} />
              </div>
            ))}
          </div>
        )}

        {/* 요청 항목 7("예측값이 얼마나 맞았는지") - Act 1에서 만든 것과 정확히 같은
            PreviewInsight 배열(previewInsights)을 그대로 다시 순회하며, 각 항목 옆에 이번 경기
            실제 값을 나란히 보여줌(lib/matchupInsights.ts의 gradeMatchupInsights). win_prob만
            "적중/빗나감"을 명시적으로 판정(postgameReport.ts의 "경기 결과" 문장과 같은
            preActPct 기준이라 서로 모순되지 않음) - 나머지는 예측-실제를 나란히 보여주기만 하고
            자동으로 "맞았다/틀렸다"를 억지로 판정하지 않음(이 프로젝트의 정직성 원칙 - 성급한
            확신 대신 근거를 그대로 노출). trend는 채점 대상에서 제외(gradeMatchupInsights가
            null 반환) - 참고 정보로만 카드가 남음. */}
        {previewInsights.length > 0 && insightGrades.length > 0 && (
          <div className="panel">
            <div className="panel-title">예측 정확도 (프리뷰 인사이트 vs 실제 결과)</div>
            {previewInsights.map((insight, i) => (
              <InsightCard
                key={i}
                insight={insight}
                hColor={hColor}
                aColor={aColor}
                homeTname={game.home_team?.name ?? ""}
                awayTname={game.away_team?.name ?? ""}
                actual={insightGrades[i] ?? null}
              />
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
      </div>
      )}

      {/* 요청: "경기 페이지에 라인업 조합 링크도 붙여줘" - 이 경기 자체의 온/오프 넷레이팅(위
          "코트 위" 패널)과 달리 시즌 전체 표본으로 본 선수별 조합(WOWY)이다. 팀만 채워서 넘긴다
          - 특정 선수를 고정하면 그 선수가 시즌 출전 기준(WOWY_SUBJECT_MIN_MINUTES)에 못 미쳐
          빈 화면이 될 수 있어(이적·교체선수 등), 로스터 고르기부터 시작하게 둔다. */}
      {game.home_team && game.away_team && (
        <div className="related-row">
          <Link href={`/lineups?season=${encodeURIComponent(game.season_name)}&team=${game.home_team.tcode}`} className="related-card" style={{ "--team": game.home_team.color } as CSSProperties}>
            <span className="related-kicker">선수별 조합</span>
            <span className="related-main">{game.home_team.name} 조합 보기</span>
            <span className="related-sub">이 시즌 누구와 같이 뛸 때 팀 마진이 어떻게 달라지는지</span>
          </Link>
          <Link href={`/lineups?season=${encodeURIComponent(game.season_name)}&team=${game.away_team.tcode}`} className="related-card" style={{ "--team": game.away_team.color } as CSSProperties}>
            <span className="related-kicker">선수별 조합</span>
            <span className="related-main">{game.away_team.name} 조합 보기</span>
            <span className="related-sub">이 시즌 누구와 같이 뛸 때 팀 마진이 어떻게 달라지는지</span>
          </Link>
        </div>
      )}

      <footer className="foot">실시간 조회 · {gmkey}</footer>
    </div>
    </LiveGameProvider>
  );
}
