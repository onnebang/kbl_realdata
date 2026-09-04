import { supabaseServer as supabase } from "./supabaseServer";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { displayTeamName } from "./teamNames";

// "폼 지수" 리더보드(claude.ai/code/artifact 폼지수 리더보드) 포팅 - tools/build_form_index.py의
// 로직을 그대로 라이브 쿼리로 옮김. 원본은 "2025-2026 시즌 마지막 5경기"로 고정이었지만,
// 여기서는 이 프로젝트 전체 컨벤션대로 시즌 선택형으로 일반화(그 시즌 내에서의 마지막
// ROLLING_WINDOW경기 - 시즌 경계를 넘지 않음, 원본과 동일한 정의).
// xPts 존 테이블(tools/build_xpts_shot_quality.py가 만들던 것)은 이제 Supabase
// xpts_zone_table에 미리 계산돼 있음(15시즌 553,248개 슛 전체 기준, 마이그레이션
// create_xpts_zone_table).
const ROLLING_WINDOW = 5;
const MIN_RECENT_GAMES = 3;
const MIN_ATTEMPTS = 15;

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
  lastGameDate: string;
};
export type FormSortKey = "delta" | "deltaPerGame" | "actualPts" | "expectedPts" | "attempts" | "games";

export async function getSeasonsWithFormData(): Promise<string[]> {
  const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

type ZoneRow = { zone: string; shot_value: number; expected_pts_per_shot: string };
type GameStatRow = { pcode: string; gmkey: string; games: { game_date: string } | null };
type ShotRow = { pcode: string; gmkey: string; x: number; y: number; d: string; made: boolean };

export async function getFormIndexLeaderboard(
  seasonName: string,
  sortKey: FormSortKey = "delta",
  ascending = false
): Promise<FormIndexRow[]> {
  const { data: zoneRows } = await supabase.from("xpts_zone_table").select("zone, shot_value, expected_pts_per_shot");
  const expectedPtsByZone = new Map((zoneRows as ZoneRow[] | null)?.map((z) => [z.zone, Number(z.expected_pts_per_shot)]) ?? []);
  if (!expectedPtsByZone.size) return [];

  // 1단계: 이 시즌 (선수, 경기, 날짜) 목록 - game_player_stats는 선수당 경기당 한 행이라
  // shot_log보다 훨씬 적음(한 시즌 최대 270경기 x ~24명 ≈ 6000행). 이걸로 선수별 "이 시즌
  // 마지막 N경기"의 gmkey 집합을 먼저 정함.
  const gameRows = await fetchAllPagesBounded<GameStatRow>((from, to) =>
    supabase
      .from("game_player_stats")
      .select("pcode, gmkey, games!inner(game_date, season_name)")
      .eq("games.season_name", seasonName)
      .range(from, to) as unknown as PromiseLike<{ data: GameStatRow[] | null; error: unknown }>
  );

  const gamesByPlayer = new Map<string, { gmkey: string; date: string }[]>();
  for (const r of gameRows) {
    if (!r.games) continue;
    const list = gamesByPlayer.get(r.pcode) ?? [];
    list.push({ gmkey: r.gmkey, date: r.games.game_date });
    gamesByPlayer.set(r.pcode, list);
  }

  const recentGmkeysByPlayer = new Map<string, Set<string>>();
  const recentCountByPlayer = new Map<string, number>();
  const lastGameDateByPlayer = new Map<string, string>();
  for (const [pcode, list] of gamesByPlayer) {
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
    const recent = list.slice(0, ROLLING_WINDOW);
    if (recent.length < MIN_RECENT_GAMES) continue;
    recentGmkeysByPlayer.set(pcode, new Set(recent.map((g) => g.gmkey)));
    recentCountByPlayer.set(pcode, recent.length);
    lastGameDateByPlayer.set(pcode, recent[0].date);
  }
  if (!recentGmkeysByPlayer.size) return [];

  // 2단계: 이 시즌 슛 전체를 훑으면서, 위에서 정한 "마지막 N경기" 집합에 속하는 슛만 집계.
  const shotRows = await fetchAllPagesBounded<ShotRow>((from, to) =>
    supabase
      .from("shot_log")
      .select("pcode, gmkey, x, y, d, made, games!inner(season_name)")
      .eq("games.season_name", seasonName)
      .range(from, to) as unknown as PromiseLike<{ data: ShotRow[] | null; error: unknown }>
  );

  const agg = new Map<string, { attempts: number; actualPts: number; expectedPts: number }>();
  for (const s of shotRows) {
    const gmkeys = recentGmkeysByPlayer.get(s.pcode);
    if (!gmkeys || !gmkeys.has(s.gmkey)) continue;
    const { zone, value } = classifyShot(s.x, s.y, s.d);
    const expected = expectedPtsByZone.get(zone) ?? 0;
    const a = agg.get(s.pcode) ?? { attempts: 0, actualPts: 0, expectedPts: 0 };
    a.attempts += 1;
    if (s.made) a.actualPts += value;
    a.expectedPts += expected;
    agg.set(s.pcode, a);
  }

  const pcodes = Array.from(agg.keys()).filter((pcode) => agg.get(pcode)!.attempts >= MIN_ATTEMPTS);
  if (!pcodes.length) return [];

  const { data: players } = await supabase.from("players").select("pcode, name").in("pcode", pcodes);
  const nameByPcode = new Map((players ?? []).map((p) => [p.pcode, p.name]));

  // 선수당 팀 - 이 시즌 이 선수가 가장 많이 뛴 팀(트레이드 시 마지막 소속 팀이 더 자연스럽지만,
  // game_player_stats에서 mode(tcode)로 대표 팀을 뽑는 게 다른 리더보드(player_season_wpa)와
  // 일관적).
  const tcodeByPcode = new Map<string, string>();
  const statRowsForTeam = await fetchAllPagesBounded<{ pcode: string; tcode: string; games: { season_name: string } | null }>((from, to) =>
    supabase
      .from("game_player_stats")
      .select("pcode, tcode, games!inner(season_name)")
      .eq("games.season_name", seasonName)
      .in("pcode", pcodes)
      .range(from, to) as unknown as PromiseLike<{
      data: { pcode: string; tcode: string; games: { season_name: string } | null }[] | null;
      error: unknown;
    }>
  );
  const tcodeCounts = new Map<string, Map<string, number>>();
  for (const r of statRowsForTeam) {
    const byTcode = tcodeCounts.get(r.pcode) ?? new Map<string, number>();
    byTcode.set(r.tcode, (byTcode.get(r.tcode) ?? 0) + 1);
    tcodeCounts.set(r.pcode, byTcode);
  }
  for (const [pcode, byTcode] of tcodeCounts) {
    let best = "";
    let bestCount = -1;
    for (const [tcode, count] of byTcode) {
      if (count > bestCount) {
        best = tcode;
        bestCount = count;
      }
    }
    tcodeByPcode.set(pcode, best);
  }

  const { data: teams } = await supabase.from("teams").select("tcode, name, abbr, color, logo_url");
  const teamByTcode = new Map((teams ?? []).map((t) => [t.tcode, t]));

  const rows: FormIndexRow[] = pcodes.map((pcode) => {
    const a = agg.get(pcode)!;
    const delta = a.actualPts - a.expectedPts;
    const games = recentCountByPlayer.get(pcode) ?? 0;
    const tcode = tcodeByPcode.get(pcode) ?? "";
    const team = teamByTcode.get(tcode);
    return {
      pcode,
      playerName: nameByPcode.get(pcode) ?? pcode,
      tcode,
      // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - seasonName은 이 함수의
      // 인자로 이미 고정돼있어 그대로 재사용.
      teamName: displayTeamName(tcode, team?.name ?? tcode, seasonName),
      teamAbbr: team?.abbr ?? tcode,
      teamColor: team?.color ?? "#888888",
      teamLogoUrl: team?.logo_url ?? null,
      games,
      attempts: a.attempts,
      actualPts: Math.round(a.actualPts * 10) / 10,
      expectedPts: Math.round(a.expectedPts * 10) / 10,
      delta: Math.round(delta * 10) / 10,
      deltaPerGame: Math.round((delta / games) * 100) / 100,
      lastGameDate: lastGameDateByPlayer.get(pcode) ?? "",
    };
  });

  rows.sort((x, y) => (ascending ? x[sortKey] - y[sortKey] : y[sortKey] - x[sortKey]));
  return rows;
}
