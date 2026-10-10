import { supabaseServer as supabase } from "./supabaseServer";
import { TAG, TTL, cachedFn, cachedMap } from "./cachePolicy";
import { classifyShot } from "./formIndex";
import { COURT_X, COURT_Y, HOOP_RIGHT, mirrorShotX, drawCourtMarkings, drawHoop } from "./zoneCompare";
import { OPEN_MATCH_CATEGORY } from "./playerPageData";

// "하든 차트"(perthirtysix.com류, 슛 하나하나를 존 기대값 대비 잔차로 색칠하는 개인 리포트) -
// 선수 프로필의 "슛 분포"(15x15 히트맵)를 실제 슛 위치 + 임팩트 색상으로 업그레이드(커밋
// 9f7324e와 같은 "성긴 시각화 -> 실제 좌표 점"의 이 프로젝트 관례). MOREY%/PSA/존 분류는
// 다음 작업(리그 전체 산점도)이 그대로 가져다 쓸 수 있게 개별 함수로 export.

export type ShotImpactRow = { x: number; y: number; d: string; made: boolean };

// xpts_zone_table(formIndex.ts가 이미 쓰는 존별 기대득점 테이블) - 여기서도 그대로 재조회.
// zone -> 슛 1회당 기대득점.
export type ZoneExpected = Map<string, number>;

/** xpts_zone_table 5행 - 일회성 적재라 사실상 상수. Map이라 cachedMap으로 감싼다. */
export function getZoneExpectedPts(): Promise<ZoneExpected> {
  return cachedMap(computeZoneExpectedPts, ["zoneExpectedPts"], TTL.reference, [TAG.build]);
}

async function computeZoneExpectedPts(): Promise<ZoneExpected> {
  const { data } = await supabase.from("xpts_zone_table").select("zone, expected_pts_per_shot");
  return new Map((data ?? []).map((z) => [z.zone as string, Number(z.expected_pts_per_shot)]));
}

// 선수 1명 x 시즌 1개 규모(최대 수백 건)라 formIndex.ts/scoringExplorer.ts의 병렬 페이지네이션은
// 과함 - 순차 페이지네이션이면 충분(1000행 넘는 시즌 FGA는 사실상 없음, 넘더라도 안전하게 순회).
const PAGE = 1000;
export async function fetchPlayerSeasonShots(pcode: string, seasonName: string): Promise<ShotImpactRow[]> {
  const isCup = seasonName.endsWith(" 컵/오픈매치");
  const dbSeason = isCup ? seasonName.replace(" 컵/오픈매치", "") : seasonName;

  const rows: ShotImpactRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("shot_log")
      .select("x, y, d, made, games!inner(season_name, season_category)")
      .eq("pcode", pcode)
      .eq("games.season_name", dbSeason)
      .range(from, from + PAGE - 1);
      
    if (isCup) {
      q = q.in("games.season_category", ["CUP", OPEN_MATCH_CATEGORY]);
    } else {
      q = q.neq("games.season_category", "CUP").neq("games.season_category", OPEN_MATCH_CATEGORY);
    }

    const { data, error } = await q;
    if (error || !data || !data.length) break;
    rows.push(...(data as unknown as ShotImpactRow[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

export type PlayerSeasonBoxTotals = {
  gp: number;
  pts: number;
  fga: number;
  fta: number;
  ast: number;
  tov: number;
  usgAvg: number | null;
};

// PTS/FGA/FTA/USG%는 공식 박스스코어(game_player_stats) 합계 기준 - shot_log 행 수를 쓰지 않음
// (shot_log는 좌표·존 분류 전용, spec 확인 사항). 트레이드로 시즌 중 팀이 바뀐 선수도 시즌
// 하나로 합쳐서 보여주는 이 리포트의 목적상 tcode로 나누지 않고 시즌 전체를 그대로 합산.
//
// 실측으로 확인한 이 프로젝트의 스키마 관례 - game_player_stats.fga/fgm은 "2점슛만"이고 3점은
// tpa/tpm에 별도로 들어있음(사이트 다른 곳의 FG%/3P% 표시가 이미 이 분리를 그대로 씀 - 예:
// 시즌별 기록 표의 FG%는 2점만의 성공률). shot_log 표본과 대조해서 확인(같은 선수·시즌 shot_log
// 행 수 ≈ fga+tpa, fga 단독과는 안 맞음). TSA/MOREY%/FTr 공식이 말하는 "FGA"는 2점+3점 합산이
// 표준이라 여기서 더해서 반환 - 안 더하면 TSA가 실제 슛 표본의 3분의 2 수준으로 축소되는 오류가 남.
export const getPlayerSeasonBoxTotals = cachedFn(computeGetPlayerSeasonBoxTotals, {
  name: "playerSeasonBoxTotals",
  ttl: TTL.batchDaily,
  tags: (pcode, seasonName) => [TAG.batch, TAG.season(seasonName), `player:${pcode}`],
});

async function computeGetPlayerSeasonBoxTotals(pcode: string, seasonName: string): Promise<PlayerSeasonBoxTotals> {
  type Row = {
    pts: number | null;
    fga: number | null;
    tpa: number | null;
    fta: number | null;
    ast: number | null;
    turnovers: number | null;
    usage_rtg: number | null;
  };

  const isCup = seasonName.endsWith(" 컵/오픈매치");
  const dbSeason = isCup ? seasonName.replace(" 컵/오픈매치", "") : seasonName;

  let q = supabase
    .from("game_player_stats")
    .select("pts, fga, tpa, fta, ast, turnovers, usage_rtg, games!inner(season_name, season_category)")
    .eq("pcode", pcode)
    .eq("games.season_name", dbSeason);
    
  if (isCup) {
    q = q.in("games.season_category", ["CUP", OPEN_MATCH_CATEGORY]);
  } else {
    q = q.neq("games.season_category", "CUP").neq("games.season_category", OPEN_MATCH_CATEGORY);
  }

  const { data } = await q;
  const rows = (data ?? []) as unknown as Row[];
  const sum = (fn: (r: Row) => number) => rows.reduce((s, r) => s + fn(r), 0);
  const usgRows = rows.filter((r) => r.usage_rtg != null);
  return {
    gp: rows.length,
    pts: sum((r) => r.pts ?? 0),
    fga: sum((r) => r.fga ?? 0) + sum((r) => r.tpa ?? 0),
    fta: sum((r) => r.fta ?? 0),
    ast: sum((r) => r.ast ?? 0),
    tov: sum((r) => r.turnovers ?? 0),
    usgAvg: usgRows.length ? usgRows.reduce((s, r) => s + (r.usage_rtg ?? 0), 0) / usgRows.length : null,
  };
}

// TSA(true shot attempts) = FGA + 0.44 * FTA - 자유투 한 트립을 대략 0.44회의 필드골 시도로
// 환산하는 표준 계수(TS%/USG% 계열 지표가 공통으로 쓰는 값).
export function computeTSA(fga: number, fta: number): number {
  return fga + 0.44 * fta;
}

// PSA(points per shot attempt) = PTS / TSA.
export function computePSA(pts: number, tsa: number): number | null {
  return tsa > 0 ? pts / tsa : null;
}

// MOREY%("무레이볼") = (림 FGA + 3점 FGA + FTA) / TSA - "효율적인 슛(림/3점) 또는 자유투로
// 이어진 시도"의 비중. 원 지표는 "자유투 트립" 단위지만 이 DB엔 트립으로 묶인 FT 데이터가 없어
// FTA 자체를 트립 프록시로 씀(트립당 자유투가 보통 1~2개라 다소 과대산정될 수 있음 - 트립 데이터가
// 없을 때 쓰는 공개적으로 통용되는 근사).
export function computeMoreyPct(rimFga: number, threeFga: number, fta: number, tsa: number): number | null {
  return tsa > 0 ? (rimFga + threeFga + fta) / tsa : null;
}

export function countRimAndThreeFga(shots: ShotImpactRow[]): { rimFga: number; threeFga: number } {
  let rimFga = 0;
  let threeFga = 0;
  for (const s of shots) {
    const { zone } = classifyShot(s.x, s.y, s.d);
    if (zone === "rim") rimFga++;
    else if (zone === "three") threeFga++;
  }
  return { rimFga, threeFga };
}

export type PlayerSeasonHeaderStats = {
  pts: number;
  tsa: number;
  psa: number | null;
  usgPct: number | null;
  moreyPct: number | null;
};

export function buildHeaderStats(box: PlayerSeasonBoxTotals, rimFga: number, threeFga: number): PlayerSeasonHeaderStats {
  const tsa = computeTSA(box.fga, box.fta);
  return {
    pts: box.pts,
    tsa,
    psa: computePSA(box.pts, tsa),
    usgPct: box.usgAvg,
    moreyPct: computeMoreyPct(rimFga, threeFga, box.fta, tsa),
  };
}

export type ImpactDot = { x: number; y: number; made: boolean; zone: string; residual: number };

// 점 하나 = 슛 하나. residual = 실제 득점가치(성공 시 슛가치 2/3, 실패 시 0) - 그 존의 기대득점
// (xpts_zone_table). 양수 = 그 존 기댓값보다 이득(잘 넣었거나 좋은 자리에서 넣음) -> --positive,
// 음수 = 손해(놓쳤거나 나쁜 자리) -> --negative. 색상 토큰은 globals.css에 이번 세션
// GameReplay.tsx용으로 이미 추가된 것을 그대로 재사용(새 토큰 발명 안 함).
export function buildImpactDots(shots: ShotImpactRow[], expectedByZone: ZoneExpected): ImpactDot[] {
  return shots.map((s) => {
    const { zone, value } = classifyShot(s.x, s.y, s.d);
    const expected = expectedByZone.get(zone) ?? 0;
    const residual = (s.made ? value : 0) - expected;
    return { x: mirrorShotX(s.x, s.d), y: s.y, made: s.made, zone, residual };
  });
}

// 잔차 클램프 상한 - 실측 분포 상 3점 성공(잔차 = 3 - 0.995 ≈ +2.0)이 사실상 최댓값이라 이
// 근방에서 클램프(그 이상 이례적인 값이 있어도 크기가 무한정 커지지 않게).
const MAX_ABS_RESIDUAL = 2.2;

// 시즌 전체(100~300+개) 슛을 한 반코트에 다 찍는 차트라 zoneCompare.ts의 buildCourtDotsSvg
// (경기당 60~90개 기준, 불투명 원)보다 훨씬 옅고 작은 점을 씀 - 많이 겹치는 구역은 자연히
// 짙어져서 밀도로 읽히고, 잔차가 큰(임팩트가 큰) 개별 슛만 크기·불투명도로 튀어나옴.
// make=채운 원, miss=테두리만(zoneCompare.ts와 같은 성공/실패 관례 유지) + 색은 잔차 부호.
export function buildImpactCourtSvg(dots: ImpactDot[]): string {
  let svg = `<rect x="${COURT_X[0]}" y="${COURT_Y[0]}" width="${COURT_X[1] - COURT_X[0]}" height="${COURT_Y[1] - COURT_Y[0]}" fill="#d9b98a" stroke="var(--ink-faint)" stroke-width="2"/>`;
  svg += drawCourtMarkings(HOOP_RIGHT[0], COURT_X[1], -1, "#fff", 1.6);

  for (const d of dots) {
    const mag = Math.min(Math.abs(d.residual), MAX_ABS_RESIDUAL) / MAX_ABS_RESIDUAL;
    const r = 1.5 + mag * 2.7;
    const opacity = 0.14 + mag * 0.62;
    const color = d.residual >= 0 ? "var(--positive)" : "var(--negative)";
    if (d.made) {
      svg += `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`;
    } else {
      svg += `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${(1 + mag * 1.1).toFixed(1)}" opacity="${opacity.toFixed(2)}"/>`;
    }
  }

  svg += drawHoop(HOOP_RIGHT[0], HOOP_RIGHT[1], false);
  return svg;
}

export type DrawnFoulProxy = { fta: number; ftr: number | null };

// 유발 파울(shooting fouls drawn) - action_codes 215("파울자유투") 이벤트의 pcode는 "파울을
// 유발한 선수"가 아니라 "파울을 범한 선수"임을 실측으로 확인함(game_events 표본 대조: 215
// 이벤트 직후 반대 팀 선수가 자유투를 쏨). 즉 이 이벤트에서 파울을 "당한" 선수는 pcode 필드가
// 아니라 뒤따르는 자유투(203/204) 이벤트의 슈터로만 알 수 있는데, 앤드원/technical/flagrant 등
// 트립 경계가 불명확한 경우가 섞여 있어 이벤트 순서 매칭으로 안전하게 귀속시키긴 어려움 -
// 잘못된 숫자를 확신 있게 보여주는 것보다, spec이 제시한 대로 FTA 기반 프록시(자유투 시도는
// 대부분 슈팅파울에서 나옴)로 정직하게 대체.
export function computeDrawnFoulProxy(fta: number, fga: number): DrawnFoulProxy {
  return { fta, ftr: fga > 0 ? fta / fga : null };
}
