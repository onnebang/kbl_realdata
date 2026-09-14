import { supabaseServer as supabase } from "./supabaseServer";
import { displayTeamName } from "./teamNames";
import { cachedFn, TAG, TTL } from "./cachePolicy";

// "폼 지수" 리더보드(claude.ai/code/artifact 폼지수 리더보드) 포팅 - tools/build_form_index.py의
// 로직을 그대로 라이브 쿼리로 옮김. 원본은 "2025-2026 시즌 마지막 5경기"로 고정이었지만,
// 여기서는 이 프로젝트 전체 컨벤션대로 시즌 선택형으로 일반화(그 시즌 내에서의 마지막
// ROLLING_WINDOW경기 - 시즌 경계를 넘지 않음, 원본과 동일한 정의).
// xPts 존 테이블(tools/build_xpts_shot_quality.py가 만들던 것)은 이제 Supabase
// xpts_zone_table에 미리 계산돼 있음(15시즌 553,248개 슛 전체 기준, 마이그레이션
// create_xpts_zone_table).
// 아래 셋은 이제 **tools/rpc_form_index.sql이 실제로 적용하는 값**이다. 여기서는 화면 캡션이
// 같은 숫자를 말하도록 export만 한다 - 한쪽만 고치면 "화면 설명과 실제 기준이 다른" 상태가 된다.
// (SQL 쪽: rn <= ROLLING_WINDOW, having count(*) >= MIN_RECENT_GAMES, having count(*) >= MIN_ATTEMPTS)
export const ROLLING_WINDOW = 5;
export const MIN_RECENT_GAMES = 3;
export const MIN_ATTEMPTS = 15;

const HOOP_LEFT: [number, number] = [69, 205];
const HOOP_RIGHT: [number, number] = [681, 205];
const SCALE_M_PER_UNIT = 0.0413;
const THREE_PT_M = 6.75;
const ZONE_BOUNDS: [string, number, number][] = [
  ["rim", 0, 1.2],
  ["close", 1.2, 3.0],
  ["midShort", 3.0, 5.0],
  ["midLong", 5.0, THREE_PT_M],
  ["three", THREE_PT_M, 999],
];

// export: lib/shotImpactChart.ts(선수 슛 임팩트 리포트)가 존 분류를 그대로 재사용 - 존 경계가
// 사이트 전체에서 하나로 유지되게(중복 정의 금지).
export function classifyShot(x: number, y: number, d: string): { zone: string; value: number } {
  const [hx, hy] = d === "1" ? HOOP_RIGHT : HOOP_LEFT;
  const dist = Math.hypot(x - hx, y - hy) * SCALE_M_PER_UNIT;
  const value = dist >= THREE_PT_M ? 3 : 2;
  for (const [zone, lo, hi] of ZONE_BOUNDS) {
    if (dist >= lo && dist < hi) return { zone, value };
  }
  return { zone: "three", value };
}

// 페이지네이션은 lib/scoringExplorer.ts의 fetchAllPagesBounded를 쓴다.
// 여기 있던 지역 구현은 `if (error || !data.length) break` 라 **페이지 하나가 실패하면 예외
// 없이 부분 데이터로 계산이 끝났다.** 같은 버그를 이 저장소가 두 번 겪었고(rarity.ts 주석,
// scoringExplorer.ts 주석의 "37,621건이 13,000건으로 조용히 잘림"), 그때 만든 함수가
// 재시도 후에도 실패하면 예외를 던진다 - 틀린 숫자를 정상처럼 그리지 않기 위해서다.

export type FormIndexRow = {
  pcode: string;
  playerName: string;
  tcode: string;
  teamName: string;
  teamAbbr: string;
  teamColor: string;
  teamLogoUrl: string | null;
  games: number;
  attempts: number;
  actualPts: number;
  expectedPts: number;
  delta: number;
  deltaPerGame: number;
  /**
   * 100슛당 델타. 이 지표의 기본값이어야 하는 값이다 - 원시 합계(delta)는 많이 던진 선수를
   * 구조적으로 불리하게 만든다(실측: 25-26 시도 1위 자밀 워니가 합계 113/119위, 100슛당 74/119위).
   */
  deltaPer100: number;
  lastGameDate: string;
};
export type FormSortKey = "delta" | "deltaPer100" | "deltaPerGame" | "actualPts" | "expectedPts" | "attempts" | "games";

/** 창 선택지 - 0은 시즌 전체. RPC form_index_season(p_season, p_window)의 p_window로 그대로 간다. */
export const FORM_WINDOWS = [1, 3, 5, 10, 0] as const;
export type FormWindow = (typeof FORM_WINDOWS)[number];
export function formWindowLabel(w: number): string {
  return w <= 0 ? "시즌 전체" : `최근 ${w}경기`;
}

// 캐시(2026-09-15): 요청마다 시즌 뷰 + RPC + 팀 표를 다시 읽고 있었다(프로덕션 로그). 폼 지수는
// 끝난 경기(daily_batch)로만 바뀐다.
export const getSeasonsWithFormData = cachedFn(computeSeasonsWithFormData, { name: "formSeasons", ttl: TTL.batchDaily, tags: () => [TAG.batch] });
export const getFormIndexLeaderboard = cachedFn(computeFormIndexLeaderboard, { name: "formIndex", ttl: TTL.batchDaily, tags: () => [TAG.batch] });

async function computeSeasonsWithFormData(): Promise<string[]> {
  // seasons 테이블을 그대로 쓰면 아직 한 경기도 안 치른 시즌(개막 전 2026-2027)이 맨 앞에 와서
  // 기본 진입이 빈 표가 된다. 그래서 "실제로 경기를 치른 시즌"만 남겨야 하는데, games를 직접
  // 훑으면 **PostgREST 1,000행 상한에 잘린다** - 3,993행 중 앞 1,000행만 오니 distinct 결과가
  // 15시즌이 아니라 4시즌이 됐다(프로덕션에서 실제로 드롭다운이 4개만 떴다).
  // 같은 조건을 이미 담고 있는 뷰를 쓴다(15행). lib/seasonLeaders.ts도 같은 뷰를 쓴다.
  const { data } = await supabase
    .from("seasons_with_regular_games")
    .select("season_name")
    .order("season_name", { ascending: false });
  return (data ?? []).map((r) => r.season_name as string);
}

/** form_index_season RPC 한 행. tools/rpc_form_index.sql 참고. */
type FormRpcRow = {
  pcode: string;
  player_name: string | null;
  tcode: string | null;
  games: number;
  attempts: number;
  actual_pts: number;
  expected_pts: number;
  last_game_date: string | null;
};

/**
 * 최근 5경기 폼 지수.
 *
 * 예전에는 이 계산을 웹에서 했다 - 실측(감사) 프로덕션 11초, 53왕복, 48,469행, 5.2MB.
 * 그중 shot_log 37,621행을 1,000행씩 38번 받는데 실제로 쓰는 건 4,068행(89% 낭비)이었다.
 * 지금은 Postgres 함수 하나로 92행을 받는다(실측 331ms).
 *
 * 바꾸기 전에 **15시즌 전수 대조로 불일치 0건**을 확인했다(선수 집합·attempts·actual_pts·
 * expected_pts를 pcode별 비교). 존 경계·상수를 고칠 일이 생기면 이 파일의 classifyShot과
 * tools/rpc_form_index.sql을 **반드시 같이** 고쳐야 한다 - 한쪽만 고치면 조용히 어긋난다.
 */
async function computeFormIndexLeaderboard(
  seasonName: string,
  windowGames: number = 5,
  sortKey: FormSortKey = "deltaPer100",
  ascending = false
): Promise<FormIndexRow[]> {
  const [rpcRes, teamsRes] = await Promise.all([
    supabase.rpc("form_index_season", { p_season: seasonName, p_window: windowGames }),
    supabase.from("teams").select("tcode, name, abbr, color, logo_url"),
  ]);
  if (rpcRes.error) throw new Error(`form_index_season(${seasonName}, ${windowGames}): ${rpcRes.error.message}`);
  const raw = (rpcRes.data ?? []) as FormRpcRow[];
  if (!raw.length) return [];

  const teamByTcode = new Map((teamsRes.data ?? []).map((t) => [t.tcode, t]));

  const rows: FormIndexRow[] = raw.map((r) => {
    const actualPts = Number(r.actual_pts);
    const expectedPts = Number(r.expected_pts);
    const delta = actualPts - expectedPts;
    const games = Number(r.games);
    const tcode = r.tcode ?? "";
    const team = teamByTcode.get(tcode);
    return {
      pcode: r.pcode,
      playerName: r.player_name ?? r.pcode,
      tcode,
      // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - seasonName은 이 함수의
      // 인자로 이미 고정돼있어 그대로 재사용.
      teamName: displayTeamName(tcode, team?.name ?? tcode, seasonName),
      teamAbbr: team?.abbr ?? tcode,
      teamColor: team?.color ?? "#888888",
      teamLogoUrl: team?.logo_url ?? null,
      games,
      attempts: Number(r.attempts),
      actualPts: Math.round(actualPts * 10) / 10,
      expectedPts: Math.round(expectedPts * 10) / 10,
      delta: Math.round(delta * 10) / 10,
      deltaPerGame: Math.round((delta / games) * 100) / 100,
      deltaPer100: Math.round((delta / Math.max(1, Number(r.attempts))) * 100 * 100) / 100,
      lastGameDate: r.last_game_date ?? "",
    };
  });

  rows.sort((x, y) => (ascending ? x[sortKey] - y[sortKey] : y[sortKey] - x[sortKey]));
  return rows;
}
