import { supabaseServer as supabase } from "./supabaseServer";
import { teamTopPerformer, bestBenchPerformer, type PlayerBox } from "./postgameReport";
import { getStandingsAsOf, type StandingsRow } from "./matchups";
import { displayTeamName } from "./teamNames";
import { cached, cachedFn, cachedMap, TTL, TAG } from "./cachePolicy";

// 홈 화면 경기 목록(app/page.tsx) 데이터 레이어 - 원래 page.tsx 안에 다 있었는데, 사용자
// 요청("예상 승률/MVP/AI 분석 배지 추가, 팀 목록은 시즌에 맞게")으로 쿼리가 늘어나서 분리.
//
// ── 페이지네이션(감사 지적, 실측) ────────────────────────────────────────────────
// 예전엔 이 파일이 최대 200경기를 한 번에 돌려주고 app/page.tsx가 그걸 한 장에 다 그렸다
// (실측 raw 717,554B / <img> 400개 / <a> 1,412개). 게다가 라이브 경기가 하나라도 있으면
// HomeLiveRefresher가 30초마다 router.refresh()로 **그 200경기 전체**를 다시 내려받아,
// 탭을 40분 켜두면 초기 HTML의 수십 배가 나갔다.
// 그래서 한 번에 HOME_PAGE_SIZE(30)경기만 조회한다. **정렬 순서는 그대로다** - 기본
// 진입에서 보이던 경기가 그대로 1페이지 앞머리에 온다(아래 getGames 주석의 세 구간 순서).
export const HOME_PAGE_SIZE = 30;

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

/** getGames의 반환 - 목록 자체와 "지금 몇 페이지인가"를 같이 준다(푸터·이전/다음 링크용). */
export type GamesPage = {
  games: GameRow[];
  /** 1-based. 범위를 벗어난 ?page=999는 마지막 페이지로 클램프된 값이 들어온다. */
  page: number;
  /** 최소 1(경기가 0건이어도 "1 / 1"로 그린다). */
  pageCount: number;
  /** 이 필터(시즌·팀)에 해당하는 전체 경기 수 - 마지막 페이지 계산 근거. */
  total: number;
  /** 이 페이지 첫 경기의 0-based 전체 순번. 푸터의 "31-60번째" 표기에 쓴다. */
  offset: number;
  /**
   * 구간별 전체 개수(현재 페이지가 아니라 필터 전체). 개막 배너처럼 "이 시즌에 종료 경기가
   * 아예 없는가" 같은 시즌 단위 판정은 반드시 이걸 봐야 한다 - 현재 페이지의 목록으로
   * 판정하면 예정 경기가 많은 시즌에서 1페이지에 종료 경기가 안 걸려 배너가 잘못 뜬다.
   */
  counts: { live: number; scheduled: number; final: number };
};

export function getSeasons(): Promise<string[]> {
  // 시즌 목록은 준-상수다(시즌이 하나 늘어나는 건 1년에 한 번). 라이브 30초 갱신이 이걸
  // 매번 다시 읽을 이유가 없어 TTL.reference로 덮는다. 반환값은 string[] - 직렬화 안전.
  return cached(
    async () => {
      const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
      return (data ?? []).map((s) => s.season_name);
    },
    ["homeGames:seasons"],
    TTL.reference,
    [TAG.batch]
  );
}

// 요청: "25-26 시즌에 없던 팀은 안보이게, 각 시즌에 맞는 팀만" - 예전엔 teams 전체(13개,
// 고양 캐롯/오리온스처럼 개명·해체된 옛 이름 포함)를 항상 보여줬는데, 이 시즌에 실제로
// 뛴 팀만. home_tcode/away_tcode 양쪽 다 훑어야 해서 두 쿼리 UNION.
//
// 이 조회는 그 시즌 games 전체를 훑는다(가장 무거운 준-상수). 시즌 중에 참가 팀이 늘거나
// 줄지 않으므로 TTL.reference로 덮는다 - 30초 갱신마다 시즌 전체 스캔을 반복하지 않는다.
// cachedFn: 인자(시즌명)가 그대로 캐시 키가 된다.
export const getTeamsForSeason = cachedFn(
  async (seasonName: string): Promise<{ tcode: string; name: string }[]> => {
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
    // Map은 캐시에서 살아남지 못한다(cachePolicy 주석) - 여기서 배열로 확정해서 내보낸다.
    return Array.from(seen.entries())
      .map(([tcode, name]) => ({ tcode, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  },
  { name: "homeGames:teamsForSeason", ttl: TTL.reference, tags: (seasonName) => [TAG.season(seasonName)] }
);

const GAME_SELECT = `gmkey, game_date, game_start, home_score, away_score, is_ended, season_category, season_name,
       home_team:teams!games_home_tcode_fkey(tcode, name, abbr, color, logo_url),
       away_team:teams!games_away_tcode_fkey(tcode, name, abbr, color, logo_url)`;

/** 목록의 세 구간. 화면에 나가는 순서와 같다(진행중 -> 예정 -> 종료). */
type Segment = "live" | "scheduled" | "final";
const SEGMENTS: readonly Segment[] = ["live", "scheduled", "final"];

type SegmentScope = { seasonName: string | undefined; tcode: string | undefined; today: string; scheduledUntil: string };

// 제보(2026-09-24): "오늘 경기가 안 보인다" - 개막 직후 전체 시즌 일정(277경기, 2027-04-11까지)이
// 한 번에 동기화되면서, 방금 끝난 경기 3건이 "예정" 구간 277개 뒤(약 10페이지 뒤)로 완전히
// 밀려버림. 이 파일 상단 주석("개막 직후엔 시즌 전체 일정이 들어있어서...")이 이미 이 상황을
// 예견했지만, 실제로는 "구간을 나눔"만으로는 안 막아진다 - 예정 구간 자체가 종료 구간보다
// 압도적으로 크면(277 vs 3) 순서(진행중->예정->종료)상 종료 구간이 첫 페이지에 아예 안 걸림.
// "예정"을 가까운 미래로만 한정해서 원래 의도(Phase 0 댓글의 "곧 열릴 경기")를 지킨다 - 전체
// 시즌 일정은 games 테이블에 그대로 남아있어 다른 화면(팀 페이지 등)에는 영향 없음.
const SCHEDULED_WINDOW_DAYS = 14;

// supabase-js 클라이언트를 Database 제네릭 없이 만들었기 때문에(lib/supabaseServer.ts) 빌더의
// 정확한 타입을 이름으로 부를 수 없다. 이 파일이 실제로 쓰는 모양만 좁게 선언하고 캐스팅은
// segmentQuery 한 곳에서만 한다(기존 `as unknown as GameRow[]`와 같은 이유).
type SegmentResult = { data: unknown[] | null; count: number | null };
type SegmentBuilder = PromiseLike<SegmentResult> & { range(from: number, to: number): PromiseLike<SegmentResult> };
interface ScopedBuilder {
  eq(column: string, value: string): ScopedBuilder;
  or(filter: string): ScopedBuilder;
}

/**
 * 한 구간의 쿼리를 만든다. head=true면 행 없이 개수만 받는다(HEAD 요청 - 바이트 0에 가깝다).
 *
 * 정렬 키에 gmkey를 덧붙인 이유(감사): 예전 단일 쿼리는 game_date만으로 정렬했는데, 같은
 * 날짜의 경기들 사이 순서는 Postgres가 정해주지 않는다. 한 번에 200개를 받을 땐 그래도
 * 한 쿼리 안이라 앞뒤가 맞았지만, .range()로 잘라 받는 순간 동률 구간의 순서가 페이지마다
 * 달라져 **경기가 중복되거나 사라진다.** gmkey는 S{시즌}G{단계}N{일련번호} 형식이라 같은
 * 날짜 안에서는 경기 순번과 같은 순서다 - 실측한 기존 출력(같은 날짜면 번호 오름차순)과
 * 같은 배열이 나오도록 오름차순으로 붙였다. 구간 사이 순서(desc/asc)는 손대지 않았다.
 */
function segmentQuery(seg: Segment, cols: string, head: boolean, scope: SegmentScope): SegmentBuilder {
  const sel = supabase.from("games").select(cols, { count: "exact", head });
  // 상태 판정은 lib/gameStatus.ts와 같은 규칙 - 스코어부터 보고 is_ended는 그 다음.
  const q =
    seg === "scheduled"
      ? sel
          .is("home_score", null)
          .gte("game_date", scope.today)
          .lte("game_date", scope.scheduledUntil)
          .order("game_date", { ascending: true })
          .order("game_start", { ascending: true })
          .order("gmkey", { ascending: true })
      : sel
          .not("home_score", "is", null)
          .eq("is_ended", seg === "final")
          .order("game_date", { ascending: false })
          .order("gmkey", { ascending: true });
  let scoped = q as unknown as ScopedBuilder;
  if (scope.seasonName) scoped = scoped.eq("season_name", scope.seasonName);
  if (scope.tcode) scoped = scoped.or(`home_tcode.eq.${scope.tcode},away_tcode.eq.${scope.tcode}`);
  return scoped as unknown as SegmentBuilder;
}

/**
 * 한 구간에서 [from, to] 행만 가져온다(0-based, to 포함).
 *
 * 캐시 정책:
 *   - live는 **절대 캐시하지 않는다.** 스코어가 지금 바뀌는 중이다(cachePolicy 주석 1).
 *   - scheduled/final은 캐시 키에 그 구간의 전체 개수(segCount)를 넣는다. 경기가 하나
 *     끝나거나(final +1, live -1) 새 일정이 들어오면 개수가 달라져 키가 통째로 바뀌므로,
 *     TTL이 남아 있어도 낡은 창(window)이 재사용되지 않는다 - 페이지 경계가 밀려 같은
 *     경기가 두 번 나오거나 빠지는 사고를 TTL 길이와 무관하게 막는다.
 */
async function fetchSegment(seg: Segment, from: number, to: number, scope: SegmentScope, segCount: number): Promise<GameRow[]> {
  const run = async (): Promise<GameRow[]> => {
    const { data } = await segmentQuery(seg, GAME_SELECT, false, scope).range(from, to);
    const rows = (data ?? []) as unknown as GameRow[];
    // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 경기 자체의 season_name
    // 기준으로 표시 이름을 덮어씀(팀 필터 드롭다운은 getTeamsForSeason에서 따로 처리).
    for (const g of rows) {
      if (g.home_team) g.home_team.name = displayTeamName(g.home_team.tcode, g.home_team.name, g.season_name);
      if (g.away_team) g.away_team.name = displayTeamName(g.away_team.tcode, g.away_team.name, g.season_name);
    }
    return rows;
  };
  if (seg === "live") return run();
  // 종료 경기는 정산이 끝나면 불변, 예정 경기는 sync_upcoming_games(하루 1회)만 건드린다.
  const ttl = seg === "final" ? TTL.final : TTL.batchDaily;
  return cached(
    run,
    ["homeGames:segment", seg, scope.seasonName ?? "", scope.tcode ?? "", scope.today, String(segCount), String(from), String(to)],
    ttl,
    scope.seasonName ? [TAG.batch, TAG.season(scope.seasonName)] : [TAG.batch]
  );
}

// Phase 0(라이브 대비) - 예정/진행중 경기도 홈 목록에 포함. 목록은 상태 그룹 순으로 이어
// 붙인다: 진행중(지금 벌어지는 경기 - 최상단, 날짜 최신순) -> 예정(가까운 날짜부터) ->
// 종료(최신부터). 개막 직후엔 시즌 전체 일정이 들어있어서 하나의 date desc 쿼리로 합치면
// 12월 예정 경기가 최근 종료 경기를 밀어내기 때문에 구간을 나눠 조회한다.
//
// 페이지네이션은 이 "이어 붙인 하나의 목록"을 30개씩 자른 것뿐이다 - 구간별 개수를 먼저
// 세고(HEAD 3번, 행 0개), 요청한 창에 걸치는 구간만 .range()로 읽는다. 그래서 2페이지를
// 봐도 1페이지의 30경기를 다시 읽지 않는다.
//
// 개수는 캐시하지 않는다. 경기가 하나 끝나면 live -> final로 옮겨가는데 그 개수가 낡으면
// 페이지 경계가 통째로 밀린다(캐시로 아낄 바이트보다 잃을 정확도가 크다). HEAD 요청이라
// 바이트도 거의 들지 않는다.
export async function getGames(
  seasonName: string | undefined,
  tcode: string | undefined,
  requestedPage = 1
): Promise<GamesPage> {
  // KBL 경기 날짜는 한국 시간 기준 - UTC 그대로 자르면 KST 00:00~09:00 사이에 "오늘"이
  // 하루 이르게 잡혀 어제 예정 경기가 잠깐 예정으로 남아 보임(검증 지적). +9h 보정.
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const scheduledUntil = new Date(Date.now() + 9 * 3600 * 1000 + SCHEDULED_WINDOW_DAYS * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
  const scope: SegmentScope = { seasonName, tcode, today, scheduledUntil };

  const counts = await Promise.all(SEGMENTS.map(async (seg) => (await segmentQuery(seg, "gmkey", true, scope)).count ?? 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const pageCount = Math.max(1, Math.ceil(total / HOME_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pageCount);
  const offset = (page - 1) * HOME_PAGE_SIZE;

  // 창 [offset, offset+30)이 각 구간의 어디에 걸치는지 계산해서, 걸치는 구간만 읽는다.
  const wanted: Promise<GameRow[]>[] = [];
  let base = 0;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const seg = SEGMENTS[i];
    const count = counts[i];
    const from = Math.max(0, offset - base);
    const end = Math.min(count, offset + HOME_PAGE_SIZE - base); // exclusive
    if (from < end) wanted.push(fetchSegment(seg, from, end - 1, scope, count));
    base += count;
  }
  const parts = await Promise.all(wanted);
  return {
    games: parts.flat(),
    page,
    pageCount,
    total,
    offset,
    counts: { live: counts[0], scheduled: counts[1], final: counts[2] },
  };
}

// 예상 승률(요청: "양 팀의 예상 승률도 제공") - game_events의 첫 행(event_order=0,
// quarter='PRE', 0-0 스코어)이 바로 그 경기 시작 전 모델 예측값. 라이브 승률(경기 중
// 매 플레이마다 갱신되는 home_win_prob와 같은 컬럼이지만, 첫 행만 걸러서 "경기 전
// 예측"으로 씀 - 별도 예측 모델을 새로 만들 필요 없음.
//
// 캐시: 종료 경기의 event_order=0 행은 불변이고, 예정 경기의 pregame_features는
// daily_batch에서만 바뀐다(TTL.scheduled의 정의 그대로). 키는 넘어온 gmkey 목록 자체라
// 페이지가 바뀌면 자동으로 다른 키가 된다. **라이브 승률(getLiveWinProbs)과는 다른
// 값이다 - 그쪽은 절대 캐시하지 않는다.**
export async function getPregameWinProbs(gmkeys: string[]): Promise<Map<string, number>> {
  if (!gmkeys.length) return new Map();
  return cachedMap(
    () => fetchPregameWinProbs(gmkeys),
    ["homeGames:pregameWinProbs", cacheKey(gmkeys)],
    TTL.scheduled,
    [TAG.batch]
  );
}

// 엔트리 반영 승률(요청, 2026-09-25: "승률을 2개를 적어야할것 같아... 승률의 변동이 있다면
// 어느 부분에서 변동이 있었는지" - 이정현 결장으로 소노 승률이 크게 내려간 사례). 라이브/종료
// 경기의 카드 승률(getPregameWinProbs)은 game_events event_order=0(라이브 모델, netrtg/synergy
// 기반 - 엔트리와 무관)을 쓰므로 여긴 건드리지 않는다. 엔트리가 의미를 가지는 건 "예정" 경기뿐 -
// pregame_features.home_win_prob_lineup(tools/recalc_lineup_winprob.py가 씀)이 있을 때만
// 반환하고, 없으면(엔트리 미발표) 빈 결과라 기존 단일 승률 표시가 그대로 유지된다.
export type LineupWinProb = { lineupProb: number; absentHome: string[]; absentAway: string[] };
export async function getLineupWinProbs(gmkeys: string[]): Promise<Map<string, LineupWinProb>> {
  if (!gmkeys.length) return new Map();
  return cachedMap(
    () => fetchLineupWinProbs(gmkeys),
    ["homeGames:lineupWinProbs", cacheKey(gmkeys)],
    TTL.scheduled,
    [TAG.batch]
  );
}

async function fetchLineupWinProbs(gmkeys: string[]): Promise<Map<string, LineupWinProb>> {
  const map = new Map<string, LineupWinProb>();
  const { data } = await supabase
    .from("pregame_features")
    .select("gmkey, home_win_prob_lineup, lineup_absences")
    .in("gmkey", gmkeys)
    .not("home_win_prob_lineup", "is", null);
  if (!data?.length) return map;

  const allPcodes = new Set<string>();
  for (const r of data) {
    const abs = (r.lineup_absences ?? {}) as { home?: string[]; away?: string[] };
    for (const p of [...(abs.home ?? []), ...(abs.away ?? [])]) allPcodes.add(p);
  }
  const nameByPcode = new Map<string, string>();
  if (allPcodes.size > 0) {
    const { data: players } = await supabase.from("players").select("pcode, name").in("pcode", [...allPcodes]);
    for (const p of players ?? []) nameByPcode.set(p.pcode as string, p.name as string);
  }

  for (const r of data) {
    const abs = (r.lineup_absences ?? {}) as { home?: string[]; away?: string[] };
    map.set(r.gmkey as string, {
      lineupProb: r.home_win_prob_lineup as number,
      absentHome: (abs.home ?? []).map((p) => nameByPcode.get(p) ?? p),
      absentAway: (abs.away ?? []).map((p) => nameByPcode.get(p) ?? p),
    });
  }
  return map;
}

async function fetchPregameWinProbs(gmkeys: string[]): Promise<Map<string, number>> {
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
// **캐시 금지.** 이 값은 매 플레이마다 바뀐다 - 30초 자동 갱신이 보러 오는 바로 그 값이다.
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
// 돌고, 그때마다 이 함수가 종료 경기분 game_player_stats를 페이지네이션하며 통째로 다시
// 읽는다(실측 홈 전체 응답의 대부분). 그런데 "이미 끝난 경기의 MVP"는 절대 안 바뀐다.
// 그래서 결과를 프로세스 메모리에 캐시하되, 키를 "종료 경기 gmkey 목록 자체"로 잡는다 -
// 새 경기가 하나라도 종료되면 키가 달라져 자동으로 다시 계산된다(오래된 MVP가 남지 않음).
// TTL은 순수 안전장치(경기 종료 직후 박스스코어 정산 배치가 아직 안 돌아 MVP가 빈 채로
// 캐시된 경우를 언젠가는 풀어주기 위한 것).
// 서버리스에서는 워밍된 인스턴스 안에서만 유효한 캐시라, 안 맞아도 그냥 한 번 더 조회할
// 뿐 정합성 문제는 생기지 않는다. 인스턴스 밖(배포·콜드스타트 너머)까지 아끼려고 바깥을
// cachedMap(TTL.final)으로 한 겹 더 덮었다 - 같은 이유로 키는 gmkey 목록이다.
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
  // 값은 Map<string, GameMvps>라 cachedMap으로 감싼다(엔트리 배열로 저장 -> Map 복원).
  // GameMvps 안에는 평범한 객체/ null 뿐이라 직렬화에 안전하다.
  return cachedMap(() => computeGameMvps(games, gmkeys), ["homeGames:gameMvps", cacheKey(gmkeys)], TTL.final, [TAG.batch]);
}

async function computeGameMvps(games: GameRow[], gmkeys: string[]): Promise<Map<string, GameMvps>> {
  const ck = cacheKey(gmkeys);
  const memo = readCache(mvpCache, ck);
  if (memo) return memo;

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
// 따로 계산하면(lib/matchups.ts의 getStandingsAsOf를 여러 번 호출) 너무 무거우니
// 시즌 전체 최종 승률 하나로 단순화 - beforeDate를 시즌 종료 이후로 넉넉히 잡아서
// getStandingsAsOf를 딱 한 번만 호출(팀 페이지 순위 계산과 같은 함수 재사용, 정규시즌만
// 집계하는 규칙도 그대로 따라감).
//
// 캐시: 승률은 경기가 끝날 때만 움직인다(daily_batch 주기) - TTL.batchDaily. 반환이 Map이라
// cachedMap을 쓴다. StandingsRow는 {tcode, wins, losses, pct} 뿐이라 직렬화에 안전하다.
export async function getSeasonWinPcts(seasonName: string): Promise<Map<string, StandingsRow>> {
  return cachedMap(
    async () => new Map((await getStandingsAsOf(seasonName, "9999-12-31")).map((r) => [r.tcode, r])),
    ["homeGames:seasonWinPcts", seasonName],
    TTL.batchDaily,
    [TAG.batch, TAG.season(seasonName)]
  );
}

// AI 분석 배지(요청: "짜릿한 역전승, 압도적 승리, 통한의 패배 등등") - 라이브로 계산하면
// game_events(242만행) 전체를 매 홈 화면 로드마다 훑어야 해서(수백 이벤트 × 경기 수)
// 너무 무거움 - Supabase 마이그레이션으로 한 번만 미리 계산해둔 game_summary_tags 테이블
// (경기당 "이 경기 도중 최대 몇 점 차까지 뒤집혔는지" vs "최종 스코어"를 시즌별로 집계)
// 에서 그냥 조회만.
export type GameTag = { key: string; label: string };
export async function getGameTags(gmkeys: string[]): Promise<Map<string, GameTag>> {
  if (!gmkeys.length) return new Map();
  // 호출부가 종료 경기 gmkey만 넘긴다 - 태그는 끝난 경기에만 붙고 한 번 붙으면 안 바뀐다.
  return cachedMap(() => fetchGameTags(gmkeys), ["homeGames:gameTags", cacheKey(gmkeys)], TTL.final, [TAG.batch]);
}

async function fetchGameTags(gmkeys: string[]): Promise<Map<string, GameTag>> {
  // MVP와 같은 이유로 프로세스 메모리 캐시도 그대로 둔다(Data Cache 미스일 때의 2차 방어).
  const ck = cacheKey(gmkeys);
  const memo = readCache(tagCache, ck);
  if (memo) return memo;
  const map = new Map<string, GameTag>();
  for (let i = 0; i < gmkeys.length; i += 200) {
    const chunk = gmkeys.slice(i, i + 200);
    const { data } = await supabase.from("game_summary_tags").select("gmkey, tag_key, tag_label").in("gmkey", chunk);
    for (const r of data ?? []) map.set(r.gmkey, { key: r.tag_key, label: r.tag_label });
  }
  return writeCache(tagCache, ck, map);
}
