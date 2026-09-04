import { GRID, buildHeatmapSvg, type Dimension, type EntityOption, type EntitySeasonGrids, type GridCell, type GridResult } from "./scoringExplorerShape";
import { supabaseServer as supabase } from "./supabaseServer";

// 클라이언트도 쓰는 모양은 ./scoringExplorerShape에 있다(그쪽은 Supabase를 import하지 않는다).
export { GRID, buildHeatmapSvg };
export type { Dimension, EntityOption, EntitySeasonGrids, GridCell, GridResult };
import { drawCourtMarkings } from "./zoneCompare";
import { currentTeamName } from "./teamNames";

// "득점 분포 탐색기" 아티팩트(claude.ai 원본, web/scoring_distribution_template.html) 리디자인
// 2차 포팅 - 원본은 Python이 미리 구운 DATA blob(팀/선수/감독/리그 x 전체 15시즌의 15x15 격자를
// 전부 미리 계산해서 박아둔 JSON)을 브라우저에서 그냥 훑는 구조라 즉각적인 시즌 재생 애니메이션이
// 가능했음. 여기서는 그 "엔티티 하나를 고르면 그 엔티티의 전체 15시즌 격자를 한번에 들고 있다가
// 클라이언트에서 시즌 인덱스만 바꿔가며 애니메이션"하는 형태를 유지하되, 데이터는 shot_log에서
// 라이브로 계산 - 엔티티를 고를 때(초기 진입 포함) lib/scoringExplorerActions.ts의 Server Action이
// 그 엔티티의 전체 이력을 한 번에 그리드로 뭉쳐서 내려주고, 이후 재생/이전/다음/슬라이더 조작은
// 전부 클라이언트 메모리 안에서만 일어남(추가 서버 왕복 없음 - components/GameReplay.tsx가 이미
// 로드된 events 배열을 스크럽하는 것과 같은 패턴).


// (엔티티, 시즌) 조합의 시도가 이 미만이면 표본 부족으로 취급 - 원본 아티팩트의 Python 빌드
// 스크립트가 DATA JSON을 구울 때 적용했던 것과 동일한 기준(minAttempts:30). 원본은 이 기준
// 미달 시즌을 아예 DATA.entity.seasons에서 빼버려서 클라이언트가 그 시즌을 목록에서 볼 일이
// 없었는데, 여기서도 같은 효과를 내려고 getEntitySeasonGrids가 미달 시즌을 결과에서 제외.
// export: lib/shotValueScatter.ts(리그 전체 슛 가치 산점도)도 같은 "표본 부족 컷오프"가
// 필요해서 새로 정의하지 않고 그대로 재사용(기준을 사이트 전체에서 하나로 유지).
export const MIN_SAMPLE = 30;



// 실측 버그(rarity.ts, winContributionLeaderboard.ts에 이어 이 파일에서도 세 번째) - Supabase
// 기본 max_rows(1000)에 range 없는 select가 조용히 잘림. 이 함수는 그 위에 "전체 페이지를
// 병렬로" 얹은 버전 - 첫 페이지에서 count:'exact'로 총 행수를 받아 남은 페이지 수를 계산하고,
// CONCURRENCY개씩 묶어 Promise.all로 동시에 쏨. 왜 필요했냐면: league 차원(전체 15시즌
// 55만행)이나 시도 많은 팀(시즌당 최대 5.7만행)을 순차 페이지네이션(기존 fetchAllPages처럼
// 1000행씩 하나씩 기다림)으로 받으면 수십 초~분 단위로 느려져서 "재생" 애니메이션용 데이터를
// 한 번에 들고 오는 이 페이지의 목적 자체가 무너짐 - DB 마이그레이션(집계 RPC)으로 푸는 게
// 정공법이지만 이번 작업 범위에서 권한상 막혀서, 병렬 페이지네이션으로 절충.
const PAGE = 1000;
const CONCURRENCY = 6;
const MAX_RETRIES = 4;

// 실측으로 발견한 버그 - 처음엔 배치 안에서 에러난 페이지를 그냥 건너뛰었더니(!r.error 체크만
// 하고 조용히 drop), 동시성이 겹칠 때(예: "리그 평균과 비교"의 3시즌 병렬 fetch가 팀/선수
// 전환과 동시에 돌 때) 일부 페이지 요청이 실패하면서 실제 37,621건짜리 시즌이 13,000건으로
// 조용히 잘려서 화면에 나온 걸 브라우저로 직접 확인함(팀 상세를 curl로 재검증해서 진짜 버그임을
// 확정) - "라이브 쿼리 결과가 정확해야 한다"는 이 페이지의 핵심 전제를 깨는 심각한 문제라,
// 페이지 하나가 실패하면 지수 백오프로 재시도하고 그래도 안 되면 조용히 빈 배열을 반환하는 대신
// 예외를 던져서(호출부가 그대로 실패) "숫자는 틀렸는데 화면은 정상처럼 보이는" 상황을 막음.
async function fetchPageWithRetry<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>,
  from: number,
  to: number
): Promise<{ data: T[] | null; error: unknown; count?: number | null }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
    const res = await makeQuery(from, to);
    if (!res.error && res.data) return res;
    lastErr = res.error;
  }
  throw new Error(`scoring-explorer: shot_log 페이지 조회 실패(range ${from}-${to}) - ${String(lastErr)}`);
}

// export: lib/shotValueScatter.ts도 시즌 전체(전 선수) shot_log/game_player_stats를 한 번에
// 끌어와야 해서(그 파일 상단 주석) 이 병렬 페이지네이션이 그대로 필요 - 같은 문제를 겪은 이
// 파일의 해법을 재사용(중복 구현 금지).
export async function fetchAllPagesBounded<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>
): Promise<T[]> {
  const first = await fetchPageWithRetry(makeQuery, 0, PAGE - 1);
  const rows: T[] = [...(first.data ?? [])];
  if (!first.data || first.data.length < PAGE) return rows;

  const total = first.count ?? null;
  if (total == null) {
    // count를 못 받은 경우(드묾) - 안전하게 순차 폴백.
    let from = PAGE;
    for (;;) {
      const { data } = await fetchPageWithRetry(makeQuery, from, from + PAGE - 1);
      if (!data || !data.length) break;
      rows.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return rows;
  }

  const totalPages = Math.ceil(total / PAGE);
  const remainingPages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 1);
  for (let i = 0; i < remainingPages.length; i += CONCURRENCY) {
    const batch = remainingPages.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((p) => fetchPageWithRetry(makeQuery, p * PAGE, p * PAGE + PAGE - 1)));
    for (const r of results) if (r.data) rows.push(...r.data);
  }
  return rows;
}

// 시즌 목록(순서만 필요 - 실제 어느 시즌에 데이터가 있는지는 getEntitySeasonGrids가 개별
// 엔티티 단위로 다시 계산).
export async function getSeasonsWithShots(): Promise<string[]> {
  const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

// 검색 드롭다운용 "이 차원의 전체 이력 상 존재하는 모든 엔티티" 목록 - 원본 아티팩트는
// DATA[dim]을 총 시도 횟수 내림차순으로 정렬해서 보여줬지만(entityListFor), 그 정렬 기준
// 자체가 shot_log 55만행 전체를 훑어야 나오는 값이라 검색창을 열 때마다 계산하기엔 무거움.
// 대신 teams/players/coaches 테이블(각각 그 자체로 이미 전체 이력 명단)을 직접 읽어
// 한글 로케일 이름순으로 정렬 - "시도 많은 순" 배지는 포기하는 대신 검색 자체는 즉시 응답.
export async function getAllEntityOptions(dim: Dimension): Promise<EntityOption[]> {
  if (dim === "league") return [{ id: "league", label: "리그 전체" }];

  if (dim === "team") {
    const { data } = await supabase.from("teams").select("tcode, name");
    // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 이 드롭다운은 팀 하나를
    // 전체 이력(15시즌) 통틀어 한 엔티티로 다루므로 시즌 무관하게 현재 정식 명칭 사용.
    return (data ?? [])
      .map((t) => ({ id: t.tcode as string, label: currentTeamName(t.tcode as string, t.name as string) }))
      .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  }

  if (dim === "coach") {
    const { data } = await supabase.from("coaches").select("coach_id, name");
    return (data ?? [])
      .map((c) => ({ id: String(c.coach_id), label: c.name as string }))
      .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  }

  // player: players 테이블이 741행으로 1000 미만 - 페이지네이션 없이 한 번에.
  const { data } = await supabase.from("players").select("pcode, name");
  return (data ?? [])
    .map((p) => ({ id: p.pcode as string, label: p.name as string }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko"));
}

type ShotXYDM = { x: number; y: number; d: string; made: boolean };
type ShotWithSeason = ShotXYDM & { season: string };

function toGrid(shots: ShotXYDM[]): GridResult {
  const map = new Map<string, GridCell>();
  let totalAtt = 0;
  let totalMade = 0;
  for (const s of shots) {
    const x = s.d === "2" ? 750 - s.x : s.x;
    const col = Math.min(GRID.cols - 1, Math.max(0, Math.floor(((x - GRID.xMin) / (GRID.xMax - GRID.xMin)) * GRID.cols)));
    const row = Math.min(GRID.rows - 1, Math.max(0, Math.floor(((s.y - GRID.yMin) / (GRID.yMax - GRID.yMin)) * GRID.rows)));
    const key = `${row}_${col}`;
    const cell = map.get(key) ?? { row, col, att: 0, made: 0 };
    cell.att++;
    if (s.made) cell.made++;
    map.set(key, cell);
    totalAtt++;
    if (s.made) totalMade++;
  }
  return { cells: Array.from(map.values()), totalAtt, totalMade };
}

// 코치 전용: shot_log엔 코치 FK가 없어서(games.home_coach_id/away_coach_id 단위) 이 코치가
// 담당한 전체 이력의 (gmkey, tcode, season) 조합을 games에서 먼저 구하고, 그 gmkey 묶음으로
// shot_log를 청크 조회(getShotGrid의 기존 시즌 스코프 버전과 같은 2단계 패턴을 전체 이력으로
// 확장).
async function fetchCoachShotsAllSeasons(coachId: string): Promise<ShotWithSeason[]> {
  const [homeGames, awayGames] = await Promise.all([
    fetchAllPagesBounded<{ gmkey: string; home_tcode: string; season_name: string }>((from, to) =>
      supabase
        .from("games")
        .select("gmkey, home_tcode, season_name", { count: "exact" })
        .eq("home_coach_id", coachId)
        .range(from, to)
    ),
    fetchAllPagesBounded<{ gmkey: string; away_tcode: string; season_name: string }>((from, to) =>
      supabase
        .from("games")
        .select("gmkey, away_tcode, season_name", { count: "exact" })
        .eq("away_coach_id", coachId)
        .range(from, to)
    ),
  ]);
  const meta = new Map<string, { tcode: string; season: string }>();
  for (const g of homeGames) meta.set(g.gmkey, { tcode: g.home_tcode, season: g.season_name });
  for (const g of awayGames) meta.set(g.gmkey, { tcode: g.away_tcode, season: g.season_name });
  const gmkeys = Array.from(meta.keys());
  if (!gmkeys.length) return [];

  const shots: ShotWithSeason[] = [];
  for (let i = 0; i < gmkeys.length; i += 100) {
    const chunk = gmkeys.slice(i, i + 100);
    const chunkShots = await fetchAllPagesBounded<{ gmkey: string; tcode: string } & ShotXYDM>((from, to) =>
      supabase.from("shot_log").select("gmkey, tcode, x, y, d, made", { count: "exact" }).in("gmkey", chunk).range(from, to)
    );
    for (const s of chunkShots) {
      const m = meta.get(s.gmkey);
      if (m && s.tcode === m.tcode) shots.push({ x: s.x, y: s.y, d: s.d, made: s.made, season: m.season });
    }
  }
  return shots;
}

// 코치 전용(단일 시즌 스코프) - app/players/[pcode]/page.tsx가 쓰는 getShotGrid("player", ...)는
// 이 함수를 안 타지만, getShotGrid의 dim==="coach" 분기가 필요로 해서 유지.
async function getCoachGameTcodesForSeason(coachId: string, seasonName: string): Promise<{ gmkey: string; tcode: string }[]> {
  const [homeGames, awayGames] = await Promise.all([
    fetchAllPagesBounded<{ gmkey: string; home_tcode: string }>((from, to) =>
      supabase
        .from("games")
        .select("gmkey, home_tcode", { count: "exact" })
        .eq("season_name", seasonName)
        .eq("home_coach_id", coachId)
        .range(from, to)
    ),
    fetchAllPagesBounded<{ gmkey: string; away_tcode: string }>((from, to) =>
      supabase
        .from("games")
        .select("gmkey, away_tcode", { count: "exact" })
        .eq("season_name", seasonName)
        .eq("away_coach_id", coachId)
        .range(from, to)
    ),
  ]);
  return [
    ...homeGames.map((g) => ({ gmkey: g.gmkey, tcode: g.home_tcode })),
    ...awayGames.map((g) => ({ gmkey: g.gmkey, tcode: g.away_tcode })),
  ];
}

// app/players/[pcode]/page.tsx(선수 프로필 페이지)가 쓰는 단일 시즌 스코프 버전 - 이 리디자인
// 이전부터 있던 함수로, 다른 페이지가 이미 의존하고 있어 시그니처를 그대로 유지.
export async function getShotGrid(dim: Dimension, entityId: string, seasonName: string): Promise<GridResult> {
  if (dim === "league" || dim === "team") {
    const shots = await fetchAllPagesBounded<ShotXYDM>((from, to) => {
      let q = supabase
        .from("shot_log")
        .select("x, y, d, made, games!inner(season_name)", { count: "exact" })
        .eq("games.season_name", seasonName);
      if (dim === "team") q = q.eq("tcode", entityId);
      return q.range(from, to) as unknown as PromiseLike<{ data: ShotXYDM[] | null; error: unknown; count: number | null }>;
    });
    return toGrid(shots);
  }
  if (dim === "player") {
    const shots = await fetchAllPagesBounded<ShotXYDM>(
      (from, to) =>
        supabase
          .from("shot_log")
          .select("x, y, d, made, games!inner(season_name)", { count: "exact" })
          .eq("games.season_name", seasonName)
          .eq("pcode", entityId)
          .range(from, to) as unknown as PromiseLike<{ data: ShotXYDM[] | null; error: unknown; count: number | null }>
    );
    return toGrid(shots);
  }
  // coach
  const pairs = await getCoachGameTcodesForSeason(entityId, seasonName);
  if (!pairs.length) return { cells: [], totalAtt: 0, totalMade: 0 };
  const gmkeys = Array.from(new Set(pairs.map((p) => p.gmkey)));
  const tcodeByGmkey = new Map(pairs.map((p) => [p.gmkey, p.tcode]));
  const shots: ShotXYDM[] = [];
  for (let i = 0; i < gmkeys.length; i += 100) {
    const chunk = gmkeys.slice(i, i + 100);
    const chunkShots = await fetchAllPagesBounded<{ gmkey: string; tcode: string } & ShotXYDM>((from, to) =>
      supabase.from("shot_log").select("gmkey, tcode, x, y, d, made", { count: "exact" }).in("gmkey", chunk).range(from, to)
    );
    for (const s of chunkShots) {
      if (s.tcode === tcodeByGmkey.get(s.gmkey)) shots.push(s);
    }
  }
  return toGrid(shots);
}


// 리그 전체(15시즌 55만행)를 이 페이지 방식대로(엔티티 하나의 전체 이력을 한 번에) 끌어오면
// 얼마나 느린지 실측함(병렬 페이지네이션, 동시성 8 기준) - 70개 배치 중 21번째(16만9천행)에서
// 이미 47.8초, 전체를 끝내면 150초 이상 걸릴 것으로 추정 - Server Action/서버리스 함수 타임아웃을
// 확실히 넘김. 반면 시즌 하나(약 3.5만행)는 실측 7.6초 - 그래서 리그 차원(단독 선택 + "리그
// 평균과 비교" 체크박스 둘 다)만 최근 N시즌으로 제한(memory 지침의 "리그 옵션은 최근 시즌
// 몇 개만 우선 지원" 절충안). 팀/선수/코치는 실측상 문제없어서(최대 팀 tcode=10 57043행 =
// 10.3초) 전체 15시즌 그대로 유지.
const LEAGUE_RECENT_SEASONS = 3;

// 이 페이지의 핵심 데이터 함수 - 엔티티(팀/선수/코치) 또는 리그 전체의 "표본이 30회 이상인
// 시즌"의 15x15 격자를 한 번에 계산해서 반환(리그는 최근 LEAGUE_RECENT_SEASONS개로 제한 -
// 위 주석). lib/scoringExplorerActions.ts의 Server Action이 이 함수를 감싸서 클라이언트가
// 엔티티를 바꿀 때마다 호출.
export async function getEntitySeasonGrids(dim: Dimension, entityId: string): Promise<EntitySeasonGrids> {
  if (dim === "league") {
    const allSeasons = await getSeasonsWithShots(); // 최신순
    const recent = allSeasons.slice(0, LEAGUE_RECENT_SEASONS);
    const results = await Promise.all(recent.map((season) => getShotGrid("league", "league", season)));
    const grids: Record<string, GridResult> = {};
    recent.forEach((season, i) => {
      if (results[i].totalAtt >= MIN_SAMPLE) grids[season] = results[i];
    });
    return { seasons: Object.keys(grids).sort(), grids };
  }

  let shots: ShotWithSeason[];

  if (dim === "coach") {
    shots = await fetchCoachShotsAllSeasons(entityId);
  } else {
    type Row = ShotXYDM & { games: { season_name: string } | { season_name: string }[] };
    const rows = await fetchAllPagesBounded<Row>((from, to) => {
      let q = supabase.from("shot_log").select("x, y, d, made, games!inner(season_name)", { count: "exact" });
      if (dim === "team") q = q.eq("tcode", entityId);
      if (dim === "player") q = q.eq("pcode", entityId);
      return q.range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown; count: number | null }>;
    });
    shots = rows.map((r) => {
      const g = Array.isArray(r.games) ? r.games[0] : r.games;
      return { x: r.x, y: r.y, d: r.d, made: r.made, season: g.season_name };
    });
  }

  const bySeasonShots = new Map<string, ShotXYDM[]>();
  for (const s of shots) {
    const arr = bySeasonShots.get(s.season) ?? [];
    arr.push(s);
    bySeasonShots.set(s.season, arr);
  }

  const grids: Record<string, GridResult> = {};
  for (const [season, arr] of bySeasonShots) {
    const g = toGrid(arr);
    if (g.totalAtt >= MIN_SAMPLE) grids[season] = g;
  }
  const seasons = Object.keys(grids).sort();
  return { seasons, grids };
}

// 셀 불투명도 = (시도/이시즌최대시도)^0.6 * 0.88, 코트/골대 - 원본 아티팩트(scoring_distribution_
// template.html)의 renderCourtSvg()/drawCourtMarkings()/drawHoop() 그대로. drawCourtMarkings는
// lib/zoneCompare.ts와 상수·공식이 완전히 동일해 재사용(출력이 바이트 단위로 같음 - 중복 구현
// 아님). drawHoop만은 템플릿 로컬 버전이 zoneCompare.ts 버전(두 골대짜리 전체 코트용, 그물 표시
// 있음)과 달라서 이 파일에 템플릿 그대로 복사.
