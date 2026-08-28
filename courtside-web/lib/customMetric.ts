import { supabase } from "./supabase";

// "커스텀 지표 빌더"(perthirtysix.com의 create-advanced-metric 페이지 레퍼런스) - 원본은
// "얼마나 중요한 스탯인지" 슬라이더로 가중치를 조절하면 실시간으로 순위가 바뀌는 CUSTOM
// Index. 핵심 아이디어(투명성: 모든 구성요소를 그대로 보여줌 / 커스터마이즈: 슬라이더로
// 즉시 반영 / 분포 활용: 원값이 아니라 "리그 평균 대비 몇 표준편차인지" z-score를 씀)를
// 그대로 가져오되, 저쪽의 "허슬 지표"(디플렉션/스크린어시스트 등)는 원본 KBL 데이터에
// 전혀 없어서 이번 라운드는 "전통 박스스코어" 버전만(저쪽도 두 버전으로 나눠서 만들었음).
// 실시간 슬라이더가 핵심 가치라 이 사이트에서 GameReplay.tsx에 이어 두 번째 "use client"
// 예외 - 매 슬라이더 조작마다 서버 왕복하면 원본의 "real time" 가치가 사라짐.
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

const MIN_GP = 10;

// 표시 순서 = 슬라이더 순서. TOV는 "낮을수록 좋음"이라 z-score를 계산 후 부호를 뒤집어서
// (invert:true) "높은 CUSTOM 값 = 좋은 기여"라는 일관된 방향을 유지(원본 아티팩트도 같은
// 관례 - "이 스탯이 커질수록 좋다"는 방향으로 전부 정렬해야 슬라이더 가중치의 부호가
// 직관적임).
export const METRIC_COMPONENTS = [
  { key: "ppg", label: "PPG", invert: false },
  { key: "rpg", label: "RPG", invert: false },
  { key: "apg", label: "APG", invert: false },
  { key: "spg", label: "SPG", invert: false },
  { key: "bpg", label: "BPG", invert: false },
  { key: "tovpg", label: "TOV", invert: true },
  { key: "fgPct", label: "FG%", invert: false },
  { key: "tpPct", label: "3P%", invert: false },
  { key: "ftPct", label: "FT%", invert: false },
] as const;
export type ComponentKey = (typeof METRIC_COMPONENTS)[number]["key"];

export type MetricPlayerRow = {
  pcode: string;
  name: string;
  tcode: string;
  teamName: string;
  teamAbbr: string;
  teamColor: string;
  teamLogoUrl: string | null;
  gp: number;
  raw: Record<ComponentKey, number>;
  z: Record<ComponentKey, number>;
};

export async function getSeasonsWithMetricData(): Promise<string[]> {
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

export async function getSeasonPlayerMetrics(seasonName: string): Promise<MetricPlayerRow[]> {
  const rows = await fetchAllPages<StatRow>((from, to) =>
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
        fgPct: fga > 0 ? (fgm / fga) * 100 : 0,
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
      teamName: team?.name ?? p.tcode,
      teamAbbr: team?.abbr ?? p.tcode,
      teamColor: team?.color ?? "#888888",
      teamLogoUrl: team?.logo_url ?? null,
      gp: p.gp,
      raw: p.raw,
      z,
    };
  });
}
