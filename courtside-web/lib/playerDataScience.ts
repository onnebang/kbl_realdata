import { supabase } from "./supabase";
import { classifyShot } from "./formIndex";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { COURT_X, HOOP_RIGHT, drawCourtMarkings, mirrorShotX } from "./zoneCompare";

// 선수 프로필 "데이터 사이언스" 대개편의 데이터 레이어 - 퍼센타일/클러치/시너지/슈팅 DNA/
// 히어로 별자리(커리어 슛 전체). GROUP BY 집계가 필요한 두 가지(시즌 전체 선수 풀, 클러치
// 프로필)는 PostgREST로는 불가능해서 이번에 만든 RPC(마이그레이션 player_profile_datasci_rpc,
// 클러치용 부분 커버링 인덱스 포함 - 콜드 2.2s -> 29ms 실측)를 supabase.rpc로 호출.

// ── 커리어 슛 전체(히어로 별자리 + 슈팅 DNA + 슛 임팩트 리포트가 공유) ──────────────
// 한 선수의 커리어 슛은 최대 7천여 건(워니 7,215 실측) - scoringExplorer.ts의 병렬
// 페이지네이션을 재사용해 한 번만 받고, 시즌별 필터는 전부 JS에서(요청 1회로 3개 섹션 공급).
export type CareerShot = { x: number; y: number; d: string; made: boolean; season: string };

export async function getCareerShots(pcode: string): Promise<CareerShot[]> {
  type Row = { x: number; y: number; d: string; made: boolean; games: { season_name: string } | { season_name: string }[] };
  const rows = await fetchAllPagesBounded<Row>(
    (from, to) =>
      supabase
        .from("shot_log")
        .select("x, y, d, made, games!inner(season_name)", { count: "exact" })
        .eq("pcode", pcode)
        .range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown; count: number | null }>
  );
  return rows.map((r) => {
    const g = Array.isArray(r.games) ? r.games[0] : r.games;
    return { x: r.x, y: r.y, d: r.d, made: r.made, season: g.season_name };
  });
}

// ── 히어로 "슛 별자리" - 커리어 슛 전부를 반코트에 옅은 점으로(배경 아트 레이어) ─────────
// 점이 3천 개를 넘으면 균등 샘플링(렌더 무게 상한 - spec). 색은 CSS 변수(--hero-dot*)로
// 넘겨서 팀 컬러를 페이지가 주입 - 성공은 밝게, 실패는 어둡고 더 옅게(밀도 텍스처).
export const CONSTELLATION_MAX_DOTS = 3000;

export function buildConstellationSvg(shots: { x: number; y: number; d: string; made: boolean }[]): string {
  const step = shots.length > CONSTELLATION_MAX_DOTS ? shots.length / CONSTELLATION_MAX_DOTS : 1;
  // 히어로는 위임적 다크 - 테마 토큰(var(--ink-*)) 대신 흰색 라인을 아주 옅게 직접 칠함.
  let svg = drawCourtMarkings(HOOP_RIGHT[0], COURT_X[1], -1, "rgba(255,255,255,0.09)", 1.3);
  for (let i = 0; i < shots.length; i += step) {
    const s = shots[Math.floor(i)];
    const x = mirrorShotX(s.x, s.d);
    if (s.made) {
      svg += `<circle cx="${x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="2.1" fill="var(--hero-dot-made)" opacity="0.5"/>`;
    } else {
      svg += `<circle cx="${x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="1.6" fill="var(--hero-dot)" opacity="0.2"/>`;
    }
  }
  return svg;
}

// ── 리그 퍼센타일 프로필 ────────────────────────────────────────────────────────────
// 자격 기준(퍼센타일 비교 풀): 그 시즌 15경기 이상 "또는" 300분 이상 출전 - 짧게 뛰고 떠난
// 외국인 교체 선수(경기수 적어도 분수 많음)와 로테이션 선수를 모두 포용하는 OR 조건.
export const PERCENTILE_MIN_GP = 15;
export const PERCENTILE_MIN_MINUTES = 300;

type PoolRow = {
  pcode: string;
  gp: number;
  min_total: number;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  ts_pct: number | null;
  usg_avg: number | null;
  tov_rate: number | null;
};

export type PercentileAxis = {
  key: string;
  label: string;
  display: string;
  percentile: number; // 0~100, 항상 "높을수록 좋음"으로 정규화(TOV%는 반전)
  inverted: boolean;
};

export type PercentileProfile = {
  poolN: number; // 자격 충족 선수 수
  qualified: boolean; // 이 선수가 풀에 포함되는지
  gp: number;
  minTotal: number;
  axes: PercentileAxis[];
};

// 퍼센타일 = (자기보다 낮은 선수 수) / (풀 - 1) * 100 (반전 축은 "높은" 선수 수) - 최고가
// 정확히 100, 최저가 0이 되는 순위 기반 정의. SQL 스팟체크와 같은 공식을 써야 검증이 맞음.
function rankPercentile(values: number[], mine: number, invert: boolean): number {
  const others = values.length - 1;
  if (others <= 0) return 50;
  const below = values.filter((v) => (invert ? v > mine : v < mine)).length;
  return Math.round((below / others) * 100);
}

export async function getPercentileProfile(pcode: string, seasonName: string): Promise<PercentileProfile | null> {
  const { data, error } = await supabase.rpc("player_season_percentile_pool", { p_season: seasonName });
  if (error || !data) return null;
  const rows = (data as PoolRow[]).map((r) => ({
    ...r,
    gp: Number(r.gp),
    min_total: Number(r.min_total),
  }));
  const me = rows.find((r) => r.pcode === pcode);
  if (!me) return null;

  const pool = rows.filter((r) => r.gp >= PERCENTILE_MIN_GP || r.min_total >= PERCENTILE_MIN_MINUTES);
  const qualified = pool.some((r) => r.pcode === pcode);
  if (!qualified) {
    return { poolN: pool.length, qualified: false, gp: me.gp, minTotal: me.min_total, axes: [] };
  }

  const axisDefs: { key: keyof PoolRow; label: string; fmt: (v: number) => string; invert?: boolean }[] = [
    { key: "ppg", label: "PPG", fmt: (v) => v.toFixed(1) },
    { key: "rpg", label: "RPG", fmt: (v) => v.toFixed(1) },
    { key: "apg", label: "APG", fmt: (v) => v.toFixed(1) },
    { key: "spg", label: "SPG", fmt: (v) => v.toFixed(1) },
    { key: "bpg", label: "BPG", fmt: (v) => v.toFixed(1) },
    { key: "ts_pct", label: "TS%", fmt: (v) => `${(v * 100).toFixed(1)}%` },
    { key: "usg_avg", label: "USG%", fmt: (v) => `${v.toFixed(1)}%` },
    { key: "tov_rate", label: "TOV%", fmt: (v) => `${(v * 100).toFixed(1)}%`, invert: true },
  ];

  const axes: PercentileAxis[] = [];
  for (const def of axisDefs) {
    const mine = me[def.key];
    if (mine == null || typeof mine !== "number") continue; // usage_rtg 없는 옛 시즌 등 - 축 자체를 생략
    const values = pool.map((r) => r[def.key]).filter((v): v is number => v != null && typeof v === "number");
    axes.push({
      key: def.key,
      label: def.label,
      display: def.fmt(Number(mine)),
      percentile: rankPercentile(values.map(Number), Number(mine), !!def.invert),
      inverted: !!def.invert,
    });
  }
  return { poolN: pool.length, qualified: true, gp: me.gp, minTotal: me.min_total, axes };
}

// ── 클러치 프로필(RPC player_clutch_profile) ────────────────────────────────────────
// 클러치 정의(RPC와 동일, 마이그레이션 주석 참고): Q4 또는 연장, 피리어드 잔여 5:00 이하,
// 그 순간(득점 이벤트는 득점 반영 전) 점수차 5점 이내.
export type ClutchTotals = {
  plays: number;
  games: number;
  fg2m: number;
  fg2a: number;
  fg3m: number;
  fg3a: number;
  ftm: number;
  fta: number;
  pts: number;
  wpaTotal: number;
};

export type ClutchMoment = {
  gmkey: string;
  gameDate: string;
  seasonName: string;
  quarter: string;
  clockMin: number;
  clockSec: number;
  actionLabel: string;
  tcode: string;
  homeTcode: string;
  awayTcode: string;
  homeScore: number;
  awayScore: number;
  wpaTeam: number;
};

export type ClutchProfile = { totals: ClutchTotals; moments: ClutchMoment[] };

export async function getClutchProfile(pcode: string): Promise<ClutchProfile | null> {
  const { data, error } = await supabase.rpc("player_clutch_profile", { p_pcode: pcode });
  if (error || !data) return null;
  type RawMoment = {
    gmkey: string;
    game_date: string;
    season_name: string;
    quarter: string;
    clock_min: number;
    clock_sec: number;
    action_label: string;
    tcode: string;
    home_tcode: string;
    away_tcode: string;
    home_score: number;
    away_score: number;
    wpa_team: number;
  };
  const raw = data as {
    totals: { plays: number; games: number; fg2m: number; fg2a: number; fg3m: number; fg3a: number; ftm: number; fta: number; pts: number; wpa_total: number };
    moments: RawMoment[];
  };
  return {
    totals: {
      plays: raw.totals.plays,
      games: raw.totals.games,
      fg2m: raw.totals.fg2m,
      fg2a: raw.totals.fg2a,
      fg3m: raw.totals.fg3m,
      fg3a: raw.totals.fg3a,
      ftm: raw.totals.ftm,
      fta: raw.totals.fta,
      pts: raw.totals.pts,
      wpaTotal: raw.totals.wpa_total,
    },
    moments: (raw.moments ?? []).map((m) => ({
      gmkey: m.gmkey,
      gameDate: m.game_date,
      seasonName: m.season_name,
      quarter: m.quarter,
      clockMin: m.clock_min,
      clockSec: m.clock_sec,
      actionLabel: m.action_label,
      tcode: m.tcode,
      homeTcode: m.home_tcode,
      awayTcode: m.away_tcode,
      homeScore: m.home_score,
      awayScore: m.away_score,
      wpaTeam: m.wpa_team,
    })),
  };
}

// ── 시너지: 최고 2인 조합(lineup_combo) ─────────────────────────────────────────────
// 커리어 통산 2인 조합 넷레이팅 상위 3개 - 소표본 노이즈 컷: 함께 뛴 시간 50분 이상(한 시즌
// 로테이션에서 대략 10~15경기어치 - 이보다 짧으면 net_rating_per40이 ±40을 넘나드는 노이즈).
export const COMBO_MIN_MINUTES = 50;

export type PairCombo = { partnerPcode: string; partnerName: string; minutes: number; netRatingPer40: number };

export async function getTopPairCombos(pcode: string): Promise<PairCombo[]> {
  // combo_key는 정렬된 pcode들을 콤마로 이은 텍스트지만, pcodes(text[]) 컬럼이 있어
  // 배열 contains 필터가 더 직접적(spec 확인 사항).
  const { data, error } = await supabase
    .from("lineup_combo")
    .select("pcodes, minutes, net_rating_per40")
    .contains("pcodes", [pcode])
    .eq("n", 2)
    .gte("minutes", COMBO_MIN_MINUTES)
    .order("net_rating_per40", { ascending: false })
    .limit(3);
  if (error || !data || !data.length) return [];

  const partnerPcodes = data.map((r) => (r.pcodes as string[]).find((p) => p !== pcode)).filter((p): p is string => !!p);
  const { data: players } = await supabase.from("players").select("pcode, name").in("pcode", partnerPcodes);
  const nameByPcode = new Map((players ?? []).map((p) => [p.pcode as string, p.name as string]));

  return data.map((r) => {
    const partner = (r.pcodes as string[]).find((p) => p !== pcode) ?? "?";
    return {
      partnerPcode: partner,
      partnerName: nameByPcode.get(partner) ?? partner,
      minutes: Number(r.minutes),
      netRatingPer40: Number(r.net_rating_per40),
    };
  });
}

// ── 시즌 WPA(승리 기여) + 리그 랭크 ──────────────────────────────────────────────────
// player_season_wpa는 시즌당 150~200행 수준이라 시즌 하나를 통째로 받아 JS에서 순위 산출
// (winContributionLeaderboard.ts와 같은 테이블·정렬 기준 - total_wpa 내림차순).
export type SeasonWpaRank = { totalWpa: number; wpaPerGame: number; games: number; rank: number; outOf: number };

export async function getSeasonWpaRank(pcode: string, seasonName: string): Promise<SeasonWpaRank | null> {
  const { data, error } = await supabase
    .from("player_season_wpa")
    .select("pcode, total_wpa, wpa_per_game, games")
    .eq("season_name", seasonName)
    .order("total_wpa", { ascending: false });
  if (error || !data) return null;
  const idx = data.findIndex((r) => r.pcode === pcode);
  if (idx < 0) return null;
  const me = data[idx];
  return { totalWpa: me.total_wpa, wpaPerGame: me.wpa_per_game, games: me.games, rank: idx + 1, outOf: data.length };
}

// ── 슈팅 DNA: 시즌별 존 구성비(커리어 슛에서 계산) ──────────────────────────────────
// 시즌 슛 30개 미만은 구성비가 노이즈라 제외(scoringExplorer.ts MIN_SAMPLE=30과 같은 기준).
export const DNA_MIN_SEASON_SHOTS = 30;
export const DNA_ZONES = ["rim", "close", "midShort", "midLong", "three"] as const;
export type DnaZone = (typeof DNA_ZONES)[number];
export const DNA_ZONE_LABELS: Record<DnaZone, string> = {
  rim: "림",
  close: "근거리",
  midShort: "중거리",
  midLong: "롱2",
  three: "3점",
};

export type SeasonZoneMix = { season: string; total: number; shares: Record<DnaZone, number> };

export function computeShootingDna(shots: CareerShot[]): SeasonZoneMix[] {
  const bySeason = new Map<string, Record<DnaZone, number>>();
  for (const s of shots) {
    const { zone } = classifyShot(s.x, s.y, s.d);
    const counts = bySeason.get(s.season) ?? { rim: 0, close: 0, midShort: 0, midLong: 0, three: 0 };
    counts[(zone as DnaZone) ?? "three"] += 1;
    bySeason.set(s.season, counts);
  }
  return Array.from(bySeason.entries())
    .map(([season, counts]) => {
      const total = DNA_ZONES.reduce((s, z) => s + counts[z], 0);
      const shares = Object.fromEntries(DNA_ZONES.map((z) => [z, total > 0 ? counts[z] / total : 0])) as Record<DnaZone, number>;
      return { season, total, shares };
    })
    .filter((m) => m.total >= DNA_MIN_SEASON_SHOTS)
    .sort((a, b) => (a.season < b.season ? -1 : 1));
}
