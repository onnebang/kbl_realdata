import { METRIC_COMPONENTS, type ComponentKey, type MetricPlayerRow } from "./customMetricShape";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { supabaseServer as supabase } from "./supabaseServer";
import { displayTeamName } from "./teamNames";
import { cachedFn, TAG, TTL } from "./cachePolicy";

// "커스텀 지표 빌더"(perthirtysix.com의 create-advanced-metric 페이지 레퍼런스) - 원본은
// "얼마나 중요한 스탯인지" 슬라이더로 가중치를 조절하면 실시간으로 순위가 바뀌는 CUSTOM
// Index. 핵심 아이디어(투명성: 모든 구성요소를 그대로 보여줌 / 커스터마이즈: 슬라이더로
// 즉시 반영 / 분포 활용: 원값이 아니라 "리그 평균 대비 몇 표준편차인지" z-score를 씀)를
// 그대로 가져오되, 저쪽의 "허슬 지표"(디플렉션/스크린어시스트 등)는 원본 KBL 데이터에
// 전혀 없어서 이번 라운드는 "전통 박스스코어" 버전만(저쪽도 두 버전으로 나눠서 만들었음).
// 실시간 슬라이더가 핵심 가치라 이 사이트에서 GameReplay.tsx에 이어 두 번째 "use client"
// 예외 - 매 슬라이더 조작마다 서버 왕복하면 원본의 "real time" 가치가 사라짐.
// 페이지네이션은 lib/scoringExplorer.ts의 fetchAllPagesBounded를 쓴다.
// 여기 있던 지역 구현은 `if (error || !data.length) break` 라 **페이지 하나가 실패하면 예외
// 없이 부분 데이터로 계산이 끝났다.** 같은 버그를 이 저장소가 두 번 겪었고(rarity.ts 주석,
// scoringExplorer.ts 주석의 "37,621건이 13,000건으로 조용히 잘림"), 그때 만든 함수가
// 재시도 후에도 실패하면 예외를 던진다 - 틀린 숫자를 정상처럼 그리지 않기 위해서다.

const MIN_GP = 10;

// 표시 순서 = 슬라이더 순서. TOV는 "낮을수록 좋음"이라 z-score를 계산 후 부호를 뒤집어서
// (invert:true) "높은 CUSTOM 값 = 좋은 기여"라는 일관된 방향을 유지(원본 아티팩트도 같은
// 관례 - "이 스탯이 커질수록 좋다"는 방향으로 전부 정렬해야 슬라이더 가중치의 부호가
// 직관적임).
export { METRIC_COMPONENTS, type ComponentKey, type MetricPlayerRow } from "./customMetricShape";


// 캐시(2026-09-15): 요청마다 한 시즌 박스스코어 전체를 페이지로 다시 받고 있었다(프로덕션 로그).
export const getSeasonsWithMetricData = cachedFn(computeSeasonsWithMetricData, { name: "metricSeasons", ttl: TTL.batchDaily, tags: () => [TAG.batch] });
export const getSeasonPlayerMetrics = cachedFn(computeSeasonPlayerMetrics, { name: "seasonPlayerMetrics", ttl: TTL.batchDaily, tags: () => [TAG.batch] });

async function computeSeasonsWithMetricData(): Promise<string[]> {
  const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

type StatRow = {
  pcode: string;
  tcode: string;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  turnovers: number | null;
  fgm: number | null;
  fga: number | null;
  tpm: number | null;
  tpa: number | null;
  ftm: number | null;
  fta: number | null;
  player: { name: string } | null;
  games: { season_name: string } | null;
};

function mean(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}
function stddev(xs: number[], m: number) {
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length);
  return Math.sqrt(variance);
}

async function computeSeasonPlayerMetrics(seasonName: string): Promise<MetricPlayerRow[]> {
  const rows = await fetchAllPagesBounded<StatRow>((from, to) =>
    supabase
      .from("game_player_stats")
      .select(
        "pcode, tcode, pts, reb, ast, stl, blk, turnovers, fgm, fga, tpm, tpa, ftm, fta, player:players(name), games!inner(season_name)"
      )
      .eq("games.season_name", seasonName)
      .range(from, to) as unknown as PromiseLike<{ data: StatRow[] | null; error: unknown }>
  );
  if (!rows.length) return [];

  // 선수당 대표 팀 - 다른 리더보드(player_season_wpa/formIndex)와 같은 관례로 이 시즌
  // 가장 많이 뛴 팀.
  const byPcode = new Map<string, StatRow[]>();
  for (const r of rows) {
    const list = byPcode.get(r.pcode) ?? [];
    list.push(r);
    byPcode.set(r.pcode, list);
  }

  const { data: teams } = await supabase.from("teams").select("tcode, name, abbr, color, logo_url");
  const teamByTcode = new Map((teams ?? []).map((t) => [t.tcode, t]));

  const prelim: {
    pcode: string;
    name: string;
    tcode: string;
    gp: number;
    raw: Record<ComponentKey, number>;
  }[] = [];

  for (const [pcode, list] of byPcode) {
    const gp = list.length;
    if (gp < MIN_GP) continue;
    const sum = (fn: (r: StatRow) => number) => list.reduce((s, r) => s + fn(r), 0);
    const fgm = sum((r) => r.fgm ?? 0) + sum((r) => r.tpm ?? 0);
    const fga = sum((r) => r.fga ?? 0) + sum((r) => r.tpa ?? 0);
    const tpm = sum((r) => r.tpm ?? 0);
    const tpa = sum((r) => r.tpa ?? 0);
    const ftm = sum((r) => r.ftm ?? 0);
    const fta = sum((r) => r.fta ?? 0);
    const tcodeCounts = new Map<string, number>();
    for (const r of list) tcodeCounts.set(r.tcode, (tcodeCounts.get(r.tcode) ?? 0) + 1);
    const tcode = Array.from(tcodeCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
    prelim.push({
      pcode,
      name: list[0].player?.name ?? pcode,
      tcode,
      gp,
      raw: {
        ppg: sum((r) => r.pts ?? 0) / gp,
        rpg: sum((r) => r.reb ?? 0) / gp,
        apg: sum((r) => r.ast ?? 0) / gp,
        spg: sum((r) => r.stl ?? 0) / gp,
        bpg: sum((r) => r.blk ?? 0) / gp,
        tovpg: sum((r) => r.turnovers ?? 0) / gp,
        // 버그 수정(2026-09-04): 이 DB의 fgm/fga는 2점 전용이라 fgm/fga를 'FG%'로 쓰면 사실은
        // 2P%다(실측 25-26 L15 코호트에서 중앙값 +7.2%p 부풀림, 최대 +73.3%p). z-score의 입력이
        // 통째로 어긋나므로 커스텀 지표 순위까지 흔들린다. lib/seasonLeaders.ts fgPct와 같은 정의로.
        fgPct: fga + tpa > 0 ? ((fgm + tpm) / (fga + tpa)) * 100 : 0,
        tpPct: tpa > 0 ? (tpm / tpa) * 100 : 0,
        ftPct: fta > 0 ? (ftm / fta) * 100 : 0,
      },
    });
  }
  if (!prelim.length) return [];

  // z-score = (원값 - 리그평균) / 표준편차, 이 필터(GP>=10) 통과한 풀 기준. TOV는 부호
  // 반전(invert)해서 "낮은 턴오버 = 높은 z" - 슬라이더 가중치를 전부 양수 방향으로 두면
  // "좋을수록 CUSTOM이 올라간다"는 일관된 직관 유지.
  const zByKey: Record<ComponentKey, number[]> = {} as Record<ComponentKey, number[]>;
  for (const c of METRIC_COMPONENTS) zByKey[c.key] = prelim.map((p) => p.raw[c.key]);
  const meanByKey = {} as Record<ComponentKey, number>;
  const sdByKey = {} as Record<ComponentKey, number>;
  for (const c of METRIC_COMPONENTS) {
    meanByKey[c.key] = mean(zByKey[c.key]);
    sdByKey[c.key] = stddev(zByKey[c.key], meanByKey[c.key]) || 1;
  }

  return prelim.map((p) => {
    const z = {} as Record<ComponentKey, number>;
    for (const c of METRIC_COMPONENTS) {
      const raw = (p.raw[c.key] - meanByKey[c.key]) / sdByKey[c.key];
      z[c.key] = c.invert ? -raw : raw;
    }
    const team = teamByTcode.get(p.tcode);
    return {
      pcode: p.pcode,
      name: p.name,
      tcode: p.tcode,
      // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - seasonName은 이 함수의
      // 인자로 이미 고정돼있어 그대로 재사용.
      teamName: displayTeamName(p.tcode, team?.name ?? p.tcode, seasonName),
      teamAbbr: team?.abbr ?? p.tcode,
      teamColor: team?.color ?? "#888888",
      teamLogoUrl: team?.logo_url ?? null,
      gp: p.gp,
      raw: p.raw,
      z,
    };
  });
}
