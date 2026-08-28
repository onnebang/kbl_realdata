import { supabase } from "./supabase";
import { HOOP_RIGHT, COURT_X, COURT_Y, drawCourtMarkings, drawHoop } from "./zoneCompare";

// "득점 분포 탐색기" 아티팩트(claude.ai/code/artifact/788e8698...) 포팅 - 팀/선수/코치/리그
// 단위로 한 시즌의 슛 시도를 15x15 반코트 그리드에 히트맵으로. 원본은 미리 구운 DATA blob
// (grid/coach/player/team/league)이었지만, shot_log가 이미 FK까지 갖춰 마이그레이션돼
// 있어서(gmkey->games, pcode->players, tcode->teams) 라이브로 그대로 계산 가능. 그리드
// 좌표계는 lib/zoneCompare.ts와 동일(원본 courtside_template.html 기준).
export const GRID = { cols: 15, rows: 15, xMin: 345, xMax: 720, yMin: 27, yMax: 384, hoopX: 681, hoopY: 205 };

export type GridCell = { row: number; col: number; att: number; made: number };
export type GridResult = { cells: GridCell[]; totalAtt: number; totalMade: number };
export type Dimension = "player" | "team" | "coach" | "league";
export type EntityOption = { id: string; label: string; subLabel?: string };

// 실측 버그(이 세션에서 세 번째로 걸림 - rarity.ts, winContributionLeaderboard.ts에 이어) -
// Supabase 기본 max_rows(1000)에 range 없는 select가 조용히 잘림. 여기는 shot_log 전체
// (55만행)를 다루는 파일이라 거의 모든 쿼리가 이 위험에 걸려서, 매번 따로 페이지네이션을
// 손으로 쓰는 대신 공용 헬퍼로 통일 - 이 파일 안 모든 잠재적 대량 조회는 반드시 이걸 통해서.
const PAGE = 1000;
async function fetchAllPages<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

function cellKey(row: number, col: number) {
  return `${row}_${col}`;
}

function toGrid(shots: { x: number; y: number; d: string; made: boolean }[]): GridResult {
  const map = new Map<string, GridCell>();
  let totalAtt = 0,
    totalMade = 0;
  for (const s of shots) {
    const x = s.d === "2" ? 750 - s.x : s.x;
    const col = Math.min(GRID.cols - 1, Math.max(0, Math.floor(((x - GRID.xMin) / (GRID.xMax - GRID.xMin)) * GRID.cols)));
    const row = Math.min(GRID.rows - 1, Math.max(0, Math.floor(((s.y - GRID.yMin) / (GRID.yMax - GRID.yMin)) * GRID.rows)));
    const key = cellKey(row, col);
    const cell = map.get(key) ?? { row, col, att: 0, made: 0 };
    cell.att++;
    if (s.made) cell.made++;
    map.set(key, cell);
    totalAtt++;
    if (s.made) totalMade++;
  }
  return { cells: Array.from(map.values()), totalAtt, totalMade };
}

export async function getSeasonsWithShots(): Promise<string[]> {
  const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

export async function getEntityOptions(dim: Dimension, seasonName: string): Promise<EntityOption[]> {
  if (dim === "league") return [{ id: "league", label: "리그 전체" }];

  if (dim === "team") {
    const { data } = await supabase.from("teams").select("tcode, name").order("name");
    return (data ?? []).map((t) => ({ id: t.tcode, label: t.name }));
  }

  if (dim === "coach") {
    // 한 시즌 최대 270경기 x 2(홈/원정 코치) = 540행 - 1000 미만이라 안전하지만 통일성을
    // 위해 그냥 헬퍼로.
    const rows = await fetchAllPages<{
      home_coach: { coach_id: number; name: string } | null;
      away_coach: { coach_id: number; name: string } | null;
    }>((from, to) =>
      supabase
        .from("games")
        .select(
          "home_coach:coaches!games_home_coach_id_fkey(coach_id, name), away_coach:coaches!games_away_coach_id_fkey(coach_id, name)"
        )
        .eq("season_name", seasonName)
        .range(from, to) as unknown as PromiseLike<{
        data: { home_coach: { coach_id: number; name: string } | null; away_coach: { coach_id: number; name: string } | null }[] | null;
        error: unknown;
      }>
    );
    const seen = new Map<string, string>();
    for (const g of rows) {
      if (g.home_coach) seen.set(String(g.home_coach.coach_id), g.home_coach.name);
      if (g.away_coach) seen.set(String(g.away_coach.coach_id), g.away_coach.name);
    }
    return Array.from(seen.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  }

  // player: 이 시즌 실제로 뛴 선수만(볼륨 적은 선수까지 다 보여주면 목록이 너무 길어짐 -
  // 원본 아티팩트의 minAttempts:30처럼 표본 기준 필요하지만, 여기선 "이 시즌 출전 기록
  // 있음"만으로 단순화 - 커리어 전체가 아니라 시즌 단위 탐색기라 자연스러운 필터). 한
  // 시즌 최대 270경기 x ~24명 ≈ 6000행이라 반드시 페이지네이션 필요.
  const rows = await fetchAllPages<{ pcode: string; player: { name: string } | null }>((from, to) =>
    supabase
      .from("game_player_stats")
      .select("pcode, player:players(name), games!inner(season_name)")
      .eq("games.season_name", seasonName)
      .range(from, to) as unknown as PromiseLike<{ data: { pcode: string; player: { name: string } | null }[] | null; error: unknown }>
  );
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (r.player) seen.set(r.pcode, r.player.name);
  }
  return Array.from(seen.entries())
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko"));
}

type ShotXYDM = { x: number; y: number; d: string; made: boolean };

async function getCoachGameTcodes(coachId: string, seasonName: string): Promise<{ gmkey: string; tcode: string }[]> {
  const [homeGames, awayGames] = await Promise.all([
    fetchAllPages<{ gmkey: string; home_tcode: string }>((from, to) =>
      supabase.from("games").select("gmkey, home_tcode").eq("season_name", seasonName).eq("home_coach_id", coachId).range(from, to)
    ),
    fetchAllPages<{ gmkey: string; away_tcode: string }>((from, to) =>
      supabase.from("games").select("gmkey, away_tcode").eq("season_name", seasonName).eq("away_coach_id", coachId).range(from, to)
    ),
  ]);
  return [
    ...homeGames.map((g) => ({ gmkey: g.gmkey, tcode: g.home_tcode })),
    ...awayGames.map((g) => ({ gmkey: g.gmkey, tcode: g.away_tcode })),
  ];
}

export async function getShotGrid(dim: Dimension, entityId: string, seasonName: string): Promise<GridResult> {
  if (dim === "league" || dim === "team") {
    const shots = await fetchAllPages<ShotXYDM>((from, to) => {
      let q = supabase.from("shot_log").select("x, y, d, made, games!inner(season_name)").eq("games.season_name", seasonName);
      if (dim === "team") q = q.eq("tcode", entityId);
      return q.range(from, to);
    });
    return toGrid(shots);
  }
  if (dim === "player") {
    const shots = await fetchAllPages<ShotXYDM>((from, to) =>
      supabase
        .from("shot_log")
        .select("x, y, d, made, games!inner(season_name)")
        .eq("games.season_name", seasonName)
        .eq("pcode", entityId)
        .range(from, to)
    );
    return toGrid(shots);
  }
  // coach: 이 코치가 이 시즌에 담당한 (경기, 팀) 목록을 먼저 구하고, 그 조합에 해당하는
  // shot_log만 - 코치별 전용 FK가 없어서(games.home_coach_id/away_coach_id 단위) 2단계로.
  const pairs = await getCoachGameTcodes(entityId, seasonName);
  if (!pairs.length) return { cells: [], totalAtt: 0, totalMade: 0 };
  const gmkeys = Array.from(new Set(pairs.map((p) => p.gmkey)));
  const tcodeByGmkey = new Map(pairs.map((p) => [p.gmkey, p.tcode]));
  const shots: ShotXYDM[] = [];
  for (let i = 0; i < gmkeys.length; i += 100) {
    const chunk = gmkeys.slice(i, i + 100);
    const chunkShots = await fetchAllPages<{ gmkey: string; tcode: string } & ShotXYDM>((from, to) =>
      supabase.from("shot_log").select("gmkey, tcode, x, y, d, made").in("gmkey", chunk).range(from, to)
    );
    for (const s of chunkShots) {
      if (s.tcode === tcodeByGmkey.get(s.gmkey)) shots.push(s);
    }
  }
  return toGrid(shots);
}

// 셀 불투명도 = (시도/이시즌최대시도)^0.6 * 0.88 - 원본 아티팩트 공식 그대로(감마 압축으로
// 저빈도 구간도 어느 정도 보이게). 코트/골대는 zoneCompare.ts의 나무색 코트를 그대로 재사용.
export function buildHeatmapSvg(grid: GridResult): string {
  const maxAtt = Math.max(1, ...grid.cells.map((c) => c.att));
  const cellW = (GRID.xMax - GRID.xMin) / GRID.cols;
  const cellH = (GRID.yMax - GRID.yMin) / GRID.rows;

  let svg = `<rect x="${COURT_X[0]}" y="${COURT_Y[0]}" width="${COURT_X[1] - COURT_X[0]}" height="${COURT_Y[1] - COURT_Y[0]}" fill="#d9b98a" stroke="var(--ink-faint)" stroke-width="2"/>`;
  for (const cell of grid.cells) {
    const x = GRID.xMin + cell.col * cellW;
    const y = GRID.yMin + cell.row * cellH;
    const ratio = Math.pow(cell.att / maxAtt, 0.6);
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${cellH.toFixed(1)}" fill="var(--home)" opacity="${(ratio * 0.88).toFixed(2)}"><title>${cell.att}회 시도, ${cell.made}회 성공(${cell.att ? Math.round((cell.made / cell.att) * 100) : 0}%)</title></rect>`;
  }
  svg += drawCourtMarkings(HOOP_RIGHT[0], COURT_X[1], -1, "#fff", 1.6);
  svg += drawHoop(HOOP_RIGHT[0], HOOP_RIGHT[1], false);
  return svg;
}
