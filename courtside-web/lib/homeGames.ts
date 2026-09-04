import { supabaseServer as supabase } from "./supabaseServer";
import { teamTopPerformer, bestBenchPerformer, type PlayerBox } from "./postgameReport";
import { getStandingsAsOf, type StandingsRow } from "./matchups";
import { displayTeamName } from "./teamNames";

// 홈 화면 경기 목록(app/page.tsx) 데이터 레이어 - 원래 page.tsx 안에 다 있었는데, 사용자
// 요청("예상 승률/MVP/AI 분석 배지 추가, 팀 목록은 시즌에 맞게")으로 쿼리가 늘어나서 분리.

export type TeamRef = { tcode: string; name: string; abbr: string; color: string; logo_url: string | null } | null;
export type GameRow = {
  gmkey: string;
  game_date: string;
  game_start: string | null; // "HH:MM:SS" - 예정 경기 카드의 시작 시각 표시용
  home_score: number | null;
  away_score: number | null;
  is_ended: boolean; // lib/gameStatus.ts의 deriveGameStatus가 예정/진행중/종료 판정에 사용
  season_category: string;
  season_name: string;
  home_team: TeamRef;
  away_team: TeamRef;
};

export async function getSeasons(): Promise<string[]> {
  const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

// 요청: "25-26 시즌에 없던 팀은 안보이게, 각 시즌에 맞는 팀만" - 예전엔 teams 전체(13개,
// 고양 캐롯/오리온스처럼 개명·해체된 옛 이름 포함)를 항상 보여줬는데, 이 시즌에 실제로
// 뛴 팀만. home_tcode/away_tcode 양쪽 다 훑어야 해서 두 쿼리 UNION.
export async function getTeamsForSeason(seasonName: string): Promise<{ tcode: string; name: string }[]> {
  // .not("home_score","is",null) 필터 제거(Phase 0) - 새 시즌은 개막 전엔 예정 경기(스코어
  // NULL)뿐이라 필터가 남아있으면 팀 드롭다운이 텅 빔. 과거 시즌은 모든 행에 스코어가
  // 있어서 결과가 동일 - "그 시즌에 실제로 뛴(또는 뛸) 팀만"이라는 원래 의도 유지.
  const { data } = await supabase
    .from("games")
    .select("home_tcode, away_tcode, home_team:teams!games_home_tcode_fkey(tcode, name), away_team:teams!games_away_tcode_fkey(tcode, name)")
    .eq("season_name", seasonName);
  const seen = new Map<string, string>();
  for (const g of data ?? []) {
    const h = g.home_team as unknown as { tcode: string; name: string } | null;
    const a = g.away_team as unknown as { tcode: string; name: string } | null;
    if (h) seen.set(h.tcode, displayTeamName(h.tcode, h.name, seasonName));
    if (a) seen.set(a.tcode, displayTeamName(a.tcode, a.name, seasonName));
  }
  return Array.from(seen.entries())
    .map(([tcode, name]) => ({ tcode, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

const GAME_SELECT = `gmkey, game_date, game_start, home_score, away_score, is_ended, season_category, season_name,
       home_team:teams!games_home_tcode_fkey(tcode, name, abbr, color, logo_url),
       away_team:teams!games_away_tcode_fkey(tcode, name, abbr, color, logo_url)`;

// Phase 0(라이브 대비) - 예정/진행중 경기도 홈 목록에 포함. 쿼리를 둘로 나눔:
//   1) 예정(home_score IS NULL, 오늘 이후) - 가까운 순(asc). 개막 직후엔 시즌 전체 일정이
//      들어있어서 하나의 date desc 쿼리로 합치면 12월 예정 경기가 limit 200을 먼저
//      잡아먹고 최근 종료 경기를 밀어내는 문제가 있어 분리.
//   2) 스코어 있는 경기(진행중+종료) - 기존과 동일하게 최신순(desc) 최대 200.
// 정렬은 상태 그룹 순: 진행중(지금 벌어지는 경기 - 최상단) -> 예정(가까운 날짜부터) ->
// 종료(기존과 동일, 최신부터).
export async function getGames(seasonName: string | undefined, tcode: string | undefined): Promise<GameRow[]> {
  // KBL 경기 날짜는 한국 시간 기준 - UTC 그대로 자르면 KST 00:00~09:00 사이에 "오늘"이
  // 하루 이르게 잡혀 어제 예정 경기가 잠깐 예정으로 남아 보임(검증 지적). +9h 보정.
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  let scheduledQ = supabase
    .from("games")
    .select(GAME_SELECT)
    .is("home_score", null)
    .gte("game_date", today)
    .order("game_date", { ascending: true })
    .order("game_start", { ascending: true })
    .limit(200);
  let playedQ = supabase
    .from("games")
    .select(GAME_SELECT)
    .not("home_score", "is", null)
    .order("game_date", { ascending: false })
    .limit(200);

  if (seasonName) {
    scheduledQ = scheduledQ.eq("season_name", seasonName);
    playedQ = playedQ.eq("season_name", seasonName);
  }
  if (tcode) {
    const teamFilter = `home_tcode.eq.${tcode},away_tcode.eq.${tcode}`;
    scheduledQ = scheduledQ.or(teamFilter);
    playedQ = playedQ.or(teamFilter);
  }

  const [scheduledRes, playedRes] = await Promise.all([scheduledQ, playedQ]);
  if (scheduledRes.error) throw scheduledRes.error;
  if (playedRes.error) throw playedRes.error;
  const scheduled = (scheduledRes.data ?? []) as unknown as GameRow[];
  const played = (playedRes.data ?? []) as unknown as GameRow[];
  const live = played.filter((g) => !g.is_ended);
  const finals = played.filter((g) => g.is_ended);
  const rows = [...live, ...scheduled, ...finals];
  // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 경기 자체의 season_name
  // 기준으로 표시 이름을 덮어씀(팀 필터 드롭다운은 getTeamsForSeason에서 따로 처리).
  for (const g of rows) {
    if (g.home_team) g.home_team.name = displayTeamName(g.home_team.tcode, g.home_team.name, g.season_name);
    if (g.away_team) g.away_team.name = displayTeamName(g.away_team.tcode, g.away_team.name, g.season_name);
  }
  return rows;
}

// 예상 승률(요청: "양 팀의 예상 승률도 제공") - game_events의 첫 행(event_order=0,
// quarter='PRE', 0-0 스코어)이 바로 그 경기 시작 전 모델 예측값. 라이브 승률(경기 중
// 매 플레이마다 갱신되는 home_win_prob와 같은 컬럼이지만, 첫 행만 걸러서 "경기 전
// 예측"으로 씀 - 별도 예측 모델을 새로 만들 필요 없음.
export async function getPregameWinProbs(gmkeys: string[]): Promise<Map<string, number>> {
  if (!gmkeys.length) return new Map();
  const map = new Map<string, number>();
  for (let i = 0; i < gmkeys.length; i += 200) {
    const chunk = gmkeys.slice(i, i + 200);
    const { data } = await supabase.from("game_events").select("gmkey, home_win_prob").eq("event_order", 0).in("gmkey", chunk);
    for (const r of data ?? []) {
      if (r.home_win_prob != null) map.set(r.gmkey, r.home_win_prob);
    }
  }
  // Phase 0 - 예정 경기는 game_events가 아직 없으므로(경기 전) 위 조회에서 안 잡힘.
  // tools/sync_upcoming_games.py가 pregame_features.home_win_prob에 넣어둔 경기 전 모델
  // 예측으로 폴백 - 종료 경기는 event_order=0 행이 항상 있어서 여기까지 안 내려옴(기존
  // 표시값 불변).
  const missing = gmkeys.filter((k) => !map.has(k));
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    const { data } = await supabase.from("pregame_features").select("gmkey, home_win_prob").in("gmkey", chunk);
    for (const r of data ?? []) {
      if (r.home_win_prob != null) map.set(r.gmkey, r.home_win_prob);
    }
  }
  return map;
}

// 진행중 경기의 "현재" 승률(Phase 0 - 수동 새로고침 기준) - 그 경기 game_events의 가장
// 마지막(최신) 행 home_win_prob. 진행중 경기는 동시에 많아야 몇 개라 경기당 1쿼리로 충분.
export async function getLiveWinProbs(gmkeys: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  await Promise.all(
    gmkeys.map(async (gmkey) => {
      const { data } = await supabase
        .from("game_events")
        .select("home_win_prob")
        .eq("gmkey", gmkey)
        .order("event_order", { ascending: false })
        .limit(1);
      const prob = data?.[0]?.home_win_prob;
      if (prob != null) map.set(gmkey, prob);
    })
  );
  return map;
}

// MVP(요청: "mvp는 이긴팀 선수와 진팀의 선수, 그리고 식스맨 조커 선수까지 표시" - 원래
// gameWideTopPerformer 하나만 쓰던 걸 승리팀/패배팀 스포트라이트 + 벤치 조커 3인으로
// 확장). game_player_stats.fgm/fga는 2점 전용이라(3점은 tpm/tpa) games/[gmkey]/page.tsx와
// 같은 방식으로 합산해서 넘김. is_starter도 이제 같이 조회(식스맨 판별에 필요 - 예전엔
// 이 화면에서 안 써서 null로 하드코딩했었음).
// 실측 버그(이 세션에서 다섯 번째로 걸림 - rarity/winContribution/scoringExplorer/
// formIndex에 이어) - 200경기 x 선수당 ~24행 ≈ 4800행인데 gmkey를 200개씩 묶기만 하고
// 응답 자체는 페이지네이션 안 해서 Supabase 기본 1000행 cap에 조용히 잘림(MVP가 200경기
// 중 42경기에서만 나타남). PAGE 단위로 .range() 페이지네이션 필수.
const PAGE = 1000;
export type GameMvp = { pcode: string; name: string; pts: number };
export type GameMvps = { winnerTop: GameMvp | null; loserTop: GameMvp | null; sixthMan: GameMvp | null };
// D(Phase 2 - 홈 자동 갱신) 비용 절감. 라이브 경기가 있으면 홈이 30초마다 서버에서 다시
// 돌고, 그때마다 이 함수가 종료 경기 200개분 game_player_stats를 페이지네이션하며 통째로
// 다시 읽는다(실측 홈 전체 응답의 대부분). 그런데 "이미 끝난 경기의 MVP"는 절대 안 바뀐다.
// 그래서 결과를 프로세스 메모리에 캐시하되, 키를 "종료 경기 gmkey 목록 자체"로 잡는다 -
// 새 경기가 하나라도 종료되면 키가 달라져 자동으로 다시 계산된다(오래된 MVP가 남지 않음).
// TTL은 순수 안전장치(경기 종료 직후 박스스코어 정산 배치가 아직 안 돌아 MVP가 빈 채로
// 캐시된 경우를 언젠가는 풀어주기 위한 것).
// 서버리스에서는 워밍된 인스턴스 안에서만 유효한 캐시라, 안 맞아도 그냥 한 번 더 조회할
// 뿐 정합성 문제는 생기지 않는다.
const MVP_CACHE_TTL_MS = 5 * 60 * 1000;
const mvpCache = new Map<string, { at: number; value: Map<string, GameMvps> }>();
const tagCache = new Map<string, { at: number; value: Map<string, GameTag> }>();

function cacheKey(gmkeys: string[]): string {
  // 정렬해서 조인 - 호출부의 배열 순서(정렬/필터 변화)에 흔들리지 않게.
  return gmkeys.slice().sort().join("|");
}
function readCache<T>(cache: Map<string, { at: number; value: T }>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MVP_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function writeCache<T>(cache: Map<string, { at: number; value: T }>, key: string, value: T): T {
  // 시즌/팀 필터 조합만큼만 늘어나는 작은 캐시지만 상한은 둔다.
  if (cache.size > 32) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function getGameMvps(games: GameRow[]): Promise<Map<string, GameMvps>> {
  const gmkeys = games.map((g) => g.gmkey);
  if (!gmkeys.length) return new Map();
  const ck = cacheKey(gmkeys);
  const cached = readCache(mvpCache, ck);
  if (cached) return cached;

  // 실측(이번 요청 검증 중 발견) - 청크를 순차 for-loop로 돌리면(200경기 ÷ 40 = 5개
  // 청크, 매번 await로 하나씩) Supabase 왕복 지연이 그대로 누적돼 홈 화면 전체가
  // 20~30초 가까이 걸림(is_starter 추가와 무관하게 기존 순차 구조 자체가 원인이었음).
  // 청크끼리는 서로 다른 gmkey를 겨냥해 완전히 독립적이라 Promise.all로 병렬 처리.
  const chunks: string[][] = [];
  for (let i = 0; i < gmkeys.length; i += 40) chunks.push(gmkeys.slice(i, i + 40));

  const rowsByGmkey = new Map<string, PlayerBox[]>();
  await Promise.all(
    chunks.map(async (chunk) => {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("game_player_stats")
          .select(
            "gmkey, pcode, tcode, pts, reb, ast, stl, blk, turnovers, fouls, is_starter, fgm, fga, tpm, tpa, ftm, fta, player:players(name)"
          )
          .in("gmkey", chunk)
          .range(from, from + PAGE - 1);
        if (error || !data || !data.length) break;
        for (const p of data) {
          const box: PlayerBox = {
            pcode: p.pcode,
            tcode: p.tcode,
            name: (p.player as unknown as { name: string } | null)?.name ?? p.pcode,
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
          };
          const list = rowsByGmkey.get(p.gmkey) ?? [];
          list.push(box);
          rowsByGmkey.set(p.gmkey, list);
        }
        if (data.length < PAGE) break;
      }
    })
  );

  const toMvp = (b: PlayerBox): GameMvp => ({ pcode: b.pcode, name: b.name, pts: b.pts });
  const result = new Map<string, GameMvps>();
  for (const g of games) {
    if (!g.home_team || !g.away_team || g.home_score == null || g.away_score == null) continue;
    const box = rowsByGmkey.get(g.gmkey);
    if (!box || !box.length) continue;
    const homeWon = g.home_score > g.away_score;
    const winnerTcode = homeWon ? g.home_team.tcode : g.away_team.tcode;
    const loserTcode = homeWon ? g.away_team.tcode : g.home_team.tcode;
    const winnerTop = teamTopPerformer(box, winnerTcode);
    const loserTop = teamTopPerformer(box, loserTcode);
    const exclude = new Set([winnerTop?.pcode, loserTop?.pcode].filter((x): x is string => !!x));
    const sixthMan = bestBenchPerformer(box, exclude);
    result.set(g.gmkey, {
      winnerTop: winnerTop ? toMvp(winnerTop) : null,
      loserTop: loserTop ? toMvp(loserTop) : null,
      sixthMan: sixthMan ? toMvp(sixthMan) : null,
    });
  }
  return writeCache(mvpCache, ck, result);
}

// 실제 시즌 승률(요청: "예상 승률과 실제 흘러간 승률, 표시") - 모델의 경기 전 예측
// (getPregameWinProbs)과 대조할 "이 시즌 실제 승률". 경기마다 그 시점까지의 승률을
// 따로 계산하면(lib/matchups.ts의 getStandingsAsOf를 최대 200번 호출) 너무 무거우니
// 시즌 전체 최종 승률 하나로 단순화 - beforeDate를 시즌 종료 이후로 넉넉히 잡아서
// getStandingsAsOf를 딱 한 번만 호출(팀 페이지 순위 계산과 같은 함수 재사용, 정규시즌만
// 집계하는 규칙도 그대로 따라감).
export async function getSeasonWinPcts(seasonName: string): Promise<Map<string, StandingsRow>> {
  const rows = await getStandingsAsOf(seasonName, "9999-12-31");
  return new Map(rows.map((r) => [r.tcode, r]));
}

// AI 분석 배지(요청: "짜릿한 역전승, 압도적 승리, 통한의 패배 등등") - 라이브로 계산하면
// game_events(242만행) 전체를 매 홈 화면 로드마다 훑어야 해서(200경기 × 수백 이벤트)
// 너무 무거움 - Supabase 마이그레이션으로 한 번만 미리 계산해둔 game_summary_tags 테이블
// (경기당 "이 경기 도중 최대 몇 점 차까지 뒤집혔는지" vs "최종 스코어"를 시즌별로 집계)
// 에서 그냥 조회만.
export type GameTag = { key: string; label: string };
export async function getGameTags(gmkeys: string[]): Promise<Map<string, GameTag>> {
  if (!gmkeys.length) return new Map();
  // MVP와 같은 이유로 캐시(호출부가 종료 경기 gmkey만 넘긴다 - 태그는 끝난 경기에만 붙는다).
  const ck = cacheKey(gmkeys);
  const cached = readCache(tagCache, ck);
  if (cached) return cached;
  const map = new Map<string, GameTag>();
  for (let i = 0; i < gmkeys.length; i += 200) {
    const chunk = gmkeys.slice(i, i + 200);
    const { data } = await supabase.from("game_summary_tags").select("gmkey, tag_key, tag_label").in("gmkey", chunk);
    for (const r of data ?? []) map.set(r.gmkey, { key: r.tag_key, label: r.tag_label });
  }
  return writeCache(tagCache, ck, map);
}
