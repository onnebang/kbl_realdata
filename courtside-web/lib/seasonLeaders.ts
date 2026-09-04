import { supabase } from "./supabase";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { getTeams, shortSeason } from "./preseason";
import { PERCENTILE_FINAL } from "./seasonFocus";
import {
  GMKEY_CHUNK,
  SEASON_CATEGORY_REGULAR,
  chunk,
  getSeasonGames,
  normalizePos,
  num,
  posLabel,
  type SeasonGameRow,
} from "./teamSeasonStats";

// 시즌 리더보드(/leaders) - 요청: "시즌별 리더보드 추가", 참고 이미지는 Basketball-Reference의
// "League Leaders" 격자(카테고리마다 상위 5명씩 깔리고 더 보기로 펼침).
//
// 표본 = games.season_category '정규시즌' & is_ended. 플레이오프를 섞지 않는 이유는 두 가지:
//   (1) 팀 기록표(lib/teamSeasonStats.ts)·4팩터 RPC와 같은 기준이라 사이트 안에서 순위가 어긋나지 않고,
//   (2) WPA 원천인 player_season_wpa가 애초에 정규시즌 전용이라(games 컬럼 = 정규시즌 GP)
//       WPA만 다른 표본이 되는 걸 막는다.
//
// 함정 두 개를 코드로 못박아 둔다:
//   - fga/fgm은 2점 전용이고 3점은 tpa/tpm이다. 총 야투 시도 = fga + tpa. (이 저장소가 전에 틀린 곳)
//   - min_played = 0 행은 엔트리만 든 DNP다(2025-2026 정규시즌 612행, 득점·시도·리바운드 전부 0).
//     경기당 수치의 분모에 넣으면 안 되므로 출전 경기는 min_played > 0인 행만 센다.

/** 비율 지표 자격 - 저장소 선례 그대로(lib/seasonFocus.ts PERCENTILE_FINAL): 15경기 "또는" 300분. */
export const LEADER_QUALIFY = PERCENTILE_FINAL;

/** 각 카테고리에서 돌려주는 최대 인원(UI는 보통 5명만 펴고 나머지는 접어 둔다). */
export const LEADER_TOP_N = 20;

/**
 * 슛 성공률 카테고리의 추가 시도 하한 - "팀 경기 수 × 경기당 시도"로 시즌 길이에 맞춰 스케일한다
 * (Basketball-Reference의 리그 리더 최소 시도와 같은 방식). 54경기 시즌이면 3P 81시도 /
 * 총 야투 162시도 / 자유투 54시도. 이 하한이 없으면 10시도 5성공짜리 50%가 1위로 올라온다.
 */
export const SHOT_MIN_ATT_PER_TEAM_GAME = { tp: 1.5, fg: 3.0, ft: 1.0 } as const;

export type LeaderCategoryKey =
  | "pts" | "reb" | "ast" | "stl" | "blk"
  | "tpm"
  | "tpPct" | "fgPct" | "ftPct"
  | "mpg" | "per" | "tsPct" | "usgPct" | "wpa";

export type LeaderGroup = "기본" | "슈팅" | "고급";

export type LeaderCategoryDef = {
  key: LeaderCategoryKey;
  label: string;
  /** 값 옆에 붙일 단위 라벨("PPG", "%", "" 등). */
  unit: string;
  group: LeaderGroup;
  /** 비율/평균 지표라 자격 기준(15경기 또는 300분)을 적용하는가. 누적 합계는 false. */
  rate: boolean;
  /** 산식·표본 주석. UI는 캡션이나 툴팁에 그대로 쓴다. */
  note: string | null;
};

export const LEADER_CATEGORIES: LeaderCategoryDef[] = [
  { key: "pts", label: "득점", unit: "PPG", group: "기본", rate: true, note: "경기당 득점(출전 경기 기준, 0분 엔트리 제외)" },
  { key: "reb", label: "리바운드", unit: "RPG", group: "기본", rate: true, note: "경기당 총 리바운드" },
  { key: "ast", label: "어시스트", unit: "APG", group: "기본", rate: true, note: "경기당 어시스트" },
  { key: "stl", label: "스틸", unit: "SPG", group: "기본", rate: true, note: "경기당 스틸" },
  { key: "blk", label: "블록", unit: "BPG", group: "기본", rate: true, note: "경기당 블록" },
  { key: "mpg", label: "경기당 출전", unit: "분", group: "기본", rate: true, note: "출전 경기당 평균 출전 시간" },

  { key: "tpm", label: "3P 성공", unit: "개", group: "슈팅", rate: false, note: "시즌 누적 3점 성공 수 - 누적 기록이라 자격 기준 없음" },
  { key: "tpPct", label: "3P%", unit: "%", group: "슈팅", rate: true, note: "tpm / tpa" },
  { key: "fgPct", label: "FG%", unit: "%", group: "슈팅", rate: true, note: "총 야투 = (fgm+tpm) / (fga+tpa). 이 DB의 fga/fgm은 2점 전용이라 3점을 반드시 더해야 한다" },
  { key: "ftPct", label: "FT%", unit: "%", group: "슈팅", rate: true, note: "ftm / fta" },

  { key: "per", label: "PER", unit: "", group: "고급", rate: true, note: "경기별 per의 출전 시간 가중 평균(짧게 뛴 경기가 과대 반영되지 않게)" },
  { key: "tsPct", label: "TS%", unit: "%", group: "고급", rate: true, note: "득점 / (2 × (fga + tpa + 0.44×fta))" },
  { key: "usgPct", label: "USG%", unit: "%", group: "고급", rate: true, note: "경기별 usage_rtg의 출전 시간 가중 평균" },
  { key: "wpa", label: "WPA", unit: "", group: "고급", rate: false, note: "player_season_wpa.total_wpa(시즌 누적 승리확률 기여) - 원천이 정규시즌 전용" },
];

export type LeaderRow = {
  /** 1부터. 동률은 같은 순위(자기보다 확실히 나은 인원 + 1). */
  rank: number;
  pcode: string;
  name: string;
  tcode: string | null;
  teamName: string | null;
  teamAbbr: string | null;
  teamColor: string | null;
  pos: "G" | "F" | "C" | null;
  posLabel: string;
  value: number;
  display: string;
  gp: number;
  minutes: number;
  /** "50경기 · 1,685분" 또는 성공률이면 "137/313" - 값 옆에 반드시 붙일 표본. */
  sample: string;
  href: string;
};

export type Leaderboard = {
  key: LeaderCategoryKey;
  label: string;
  unit: string;
  group: LeaderGroup;
  rate: boolean;
  note: string | null;
  /** 이 카테고리에 실제로 적용된 자격 문장. 누적 기록이면 "자격 기준 없음(누적 기록)". */
  qualifyText: string;
  /** 자격을 통과해 순위에 들어간 인원 수. */
  poolN: number;
  rows: LeaderRow[];
};

export type SeasonLeaderboards = {
  seasonName: string;
  seasonCategory: string;
  /** 최소 시도 하한을 스케일하는 기준 = 모든 팀이 실제로 치른 최소 일정(= teamGamesMin). */
  teamGames: number;
  /** 팀별 정규시즌 경기 수의 실제 분포. 2019-2020(코로나 조기 종료)만 min≠max다. */
  teamGamesMin: number;
  teamGamesMax: number;
  /** "54경기" 또는 "42~43경기" - 팀당 경기 수를 문장에 그대로 넣을 때 쓴다. */
  teamGamesText: string;
  /** 하한의 근거 문장. 일정이 고르지 않은 시즌은 최소 일정을 썼다는 사실까지 적는다. */
  teamGamesBasis: string;
  playersN: number;
  qualifiedN: number;
  topN: number;
  boards: Leaderboard[];
  /** 페이지 상단 캡션(표본 + 자격 규칙). */
  caption: string;
  qualifyCaption: string;
};

export type PlayerGameRow = {
  gmkey: string;
  pcode: string;
  tcode: string;
  pos: string | null;
  back_num: string | null;
  min_played: number | string | null;
  pts: number | null; reb: number | null; ast: number | null; stl: number | null; blk: number | null;
  fgm: number | null; fga: number | null; tpm: number | null; tpa: number | null; ftm: number | null; fta: number | null;
  per: number | null; usage_rtg: number | null;
};

const PLAYER_SELECT =
  "gmkey, pcode, tcode, pos, back_num, min_played, pts, reb, ast, stl, blk, fgm, fga, tpm, tpa, ftm, fta, per, usage_rtg";

/**
 * 한 시즌 선수-경기 원본 행 전체.
 * 2025-2026 정규시즌만 해도 6,480행이라 Supabase 기본 1000행 cap을 확실히 넘는다 -
 * gmkey를 120개씩 끊고 각 덩어리를 fetchAllPagesBounded로 끝까지 페이지네이션한다.
 * lib/wowy.ts(선수 목록 만들기)도 이 함수를 쓴다.
 */
export async function fetchSeasonPlayerGameRows(
  seasonName: string,
  opts?: { category?: string | null }
): Promise<{ rows: PlayerGameRow[]; gamesN: number; games: SeasonGameRow[] }> {
  const category = opts && "category" in opts ? opts.category : SEASON_CATEGORY_REGULAR;
  const games = await getSeasonGames(seasonName, { category });
  if (!games.length) return { rows: [], gamesN: 0, games: [] };
  const rows: PlayerGameRow[] = [];
  for (const part of chunk(games.map((g) => g.gmkey), GMKEY_CHUNK)) {
    const got = await fetchAllPagesBounded<PlayerGameRow>((from, to) =>
      supabase.from("game_player_stats").select(PLAYER_SELECT, { count: "exact" }).in("gmkey", part).range(from, to)
    );
    rows.push(...got);
  }
  return { rows, gamesN: games.length, games };
}

/**
 * 팀별 실제 경기 수(일정 그 자체 - 경기 목록에서 홈/원정 양쪽을 세면 된다).
 *
 * "전체 경기 × 2 ÷ 팀 수"의 반올림을 쓰면 안 되는 이유: 2019-2020은 코로나로 조기 종료돼
 * 6팀 43경기 · 4팀 42경기다(2026-09-04 SQL 실측). 213×2/10 = 42.6 → 반올림 43이라
 * 42경기만 치른 4팀 선수에게 자기 팀이 치르지도 않은 일정 기준의 시도 하한이 걸리고,
 * 화면에는 "팀 43경기 기준"이라는 - 리그 10팀 중 4팀에게는 거짓인 - 근거가 인쇄된다.
 * 그래서 하한은 모든 팀이 실제로 치른 최소 일정(min)으로 잡고 분포(min~max)를 따로 실어 보낸다.
 * 나머지 14시즌은 10팀 모두 54경기라 하한 값이 지금과 똑같다.
 */
export function teamGameCounts(games: SeasonGameRow[]): {
  byTcode: Map<string, number>;
  min: number;
  max: number;
} {
  const byTcode = new Map<string, number>();
  for (const g of games) {
    for (const tc of [g.homeTcode, g.awayTcode]) {
      if (!tc) continue;
      byTcode.set(tc, (byTcode.get(tc) ?? 0) + 1);
    }
  }
  const counts = [...byTcode.values()];
  return {
    byTcode,
    min: counts.length ? Math.min(...counts) : 0,
    max: counts.length ? Math.max(...counts) : 0,
  };
}

export type SeasonPlayerAgg = {
  pcode: string;
  tcode: string;
  gp: number;
  minutes: number;
  pts: number; reb: number; ast: number; stl: number; blk: number;
  fgm: number; fga: number; tpm: number; tpa: number; ftm: number; fta: number;
  perW: number;   // 출전 시간 가중 평균 PER
  usgW: number;   // 출전 시간 가중 평균 USG%
  pos: string | null;
};

/**
 * 선수-경기 행 → 선수 시즌 집계.
 * gp는 min_played > 0인 경기만. tcode는 가장 많이 뛴 팀(시즌 중 이적 대비 - 실측으로 한 시즌에
 * 두 팀 행을 가진 선수가 존재한다).
 */
export function aggregateSeasonPlayers(rows: PlayerGameRow[]): SeasonPlayerAgg[] {
  type Acc = SeasonPlayerAgg & { perMinSum: number; usgMinSum: number; minByTeam: Map<string, number> };
  const accs = new Map<string, Acc>();
  for (const r of rows) {
    const min = num(r.min_played);
    let a = accs.get(r.pcode);
    if (!a) {
      a = {
        pcode: r.pcode, tcode: r.tcode, gp: 0, minutes: 0,
        pts: 0, reb: 0, ast: 0, stl: 0, blk: 0,
        fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
        perW: 0, usgW: 0, pos: r.pos,
        perMinSum: 0, usgMinSum: 0, minByTeam: new Map(),
      };
      accs.set(r.pcode, a);
    }
    if (min > 0) a.gp += 1;
    a.minutes += min;
    a.pts += num(r.pts); a.reb += num(r.reb); a.ast += num(r.ast); a.stl += num(r.stl); a.blk += num(r.blk);
    a.fgm += num(r.fgm); a.fga += num(r.fga); a.tpm += num(r.tpm); a.tpa += num(r.tpa);
    a.ftm += num(r.ftm); a.fta += num(r.fta);
    if (r.per != null) a.perMinSum += num(r.per) * min;
    if (r.usage_rtg != null) a.usgMinSum += num(r.usage_rtg) * min;
    if (r.pos) a.pos = r.pos;
    a.minByTeam.set(r.tcode, (a.minByTeam.get(r.tcode) ?? 0) + min + 0.001); // 0분 행도 소속 근거는 된다
  }
  return [...accs.values()].map((a) => {
    let best = a.tcode;
    let bestMin = -1;
    for (const [tc, m] of a.minByTeam) if (m > bestMin) { best = tc; bestMin = m; }
    return {
      pcode: a.pcode, tcode: best, gp: a.gp, minutes: a.minutes,
      pts: a.pts, reb: a.reb, ast: a.ast, stl: a.stl, blk: a.blk,
      fgm: a.fgm, fga: a.fga, tpm: a.tpm, tpa: a.tpa, ftm: a.ftm, fta: a.fta,
      perW: a.minutes > 0 ? a.perMinSum / a.minutes : 0,
      usgW: a.minutes > 0 ? a.usgMinSum / a.minutes : 0,
      pos: a.pos,
    };
  });
}

/** 자격 판정 - 15경기 "또는" 300분(둘 중 하나만 넘으면 통과). */
export function isQualified(a: { gp: number; minutes: number }): boolean {
  return a.gp >= LEADER_QUALIFY.gp || a.minutes >= LEADER_QUALIFY.min;
}

const fmt1 = (v: number) => v.toFixed(1);
const fmt2 = (v: number) => v.toFixed(2);
const fmtPct = (v: number) => v.toFixed(1);
const fmtInt = (v: number) => Math.round(v).toLocaleString();

type Extractor = {
  value: (a: SeasonPlayerAgg, wpa: number | null) => number | null;
  display: (v: number) => string;
  /** 값 옆 표본 문구. 없으면 "N경기 · M분". */
  sample?: (a: SeasonPlayerAgg) => string;
  /** 슛 성공률처럼 시도 하한이 더 필요한 카테고리. teamGames를 받아 최소 시도를 돌려준다. */
  minAtt?: (teamGames: number) => { need: number; of: (a: SeasonPlayerAgg) => number; label: string };
};

const EXTRACT: Record<LeaderCategoryKey, Extractor> = {
  pts: { value: (a) => (a.gp ? a.pts / a.gp : null), display: fmt1 },
  reb: { value: (a) => (a.gp ? a.reb / a.gp : null), display: fmt1 },
  ast: { value: (a) => (a.gp ? a.ast / a.gp : null), display: fmt1 },
  stl: { value: (a) => (a.gp ? a.stl / a.gp : null), display: fmt1 },
  blk: { value: (a) => (a.gp ? a.blk / a.gp : null), display: fmt1 },
  mpg: { value: (a) => (a.gp ? a.minutes / a.gp : null), display: fmt1 },
  tpm: { value: (a) => a.tpm, display: fmtInt, sample: (a) => `${a.tpm}/${a.tpa} · ${a.gp}경기` },
  tpPct: {
    value: (a) => (a.tpa ? (a.tpm / a.tpa) * 100 : null),
    display: fmtPct,
    sample: (a) => `${a.tpm}/${a.tpa}`,
    minAtt: (g) => ({ need: Math.ceil(g * SHOT_MIN_ATT_PER_TEAM_GAME.tp), of: (a) => a.tpa, label: "3점 시도" }),
  },
  fgPct: {
    value: (a) => (a.fga + a.tpa ? ((a.fgm + a.tpm) / (a.fga + a.tpa)) * 100 : null),
    display: fmtPct,
    sample: (a) => `${a.fgm + a.tpm}/${a.fga + a.tpa}`,
    minAtt: (g) => ({ need: Math.ceil(g * SHOT_MIN_ATT_PER_TEAM_GAME.fg), of: (a) => a.fga + a.tpa, label: "야투 시도(2점+3점)" }),
  },
  ftPct: {
    value: (a) => (a.fta ? (a.ftm / a.fta) * 100 : null),
    display: fmtPct,
    sample: (a) => `${a.ftm}/${a.fta}`,
    minAtt: (g) => ({ need: Math.ceil(g * SHOT_MIN_ATT_PER_TEAM_GAME.ft), of: (a) => a.fta, label: "자유투 시도" }),
  },
  per: { value: (a) => (a.minutes > 0 ? a.perW : null), display: fmt2 },
  tsPct: {
    value: (a) => {
      const d = a.fga + a.tpa + 0.44 * a.fta;
      return d ? (a.pts / (2 * d)) * 100 : null;
    },
    display: fmtPct,
    sample: (a) => `${a.pts}점 · ${a.fga + a.tpa}야투 ${a.fta}자유투`,
    minAtt: (g) => ({
      need: Math.ceil(g * SHOT_MIN_ATT_PER_TEAM_GAME.fg),
      of: (a) => a.fga + a.tpa + 0.44 * a.fta,
      label: "슈팅 포제션(야투+0.44×자유투)",
    }),
  },
  usgPct: { value: (a) => (a.minutes > 0 ? a.usgW : null), display: fmtPct },
  wpa: { value: (_a, wpa) => wpa, display: fmt2, sample: (a) => `${a.gp}경기 · ${Math.round(a.minutes).toLocaleString()}분` },
};

/**
 * 시즌 리더보드 전체.
 * @param opts.topN 카테고리당 인원(기본 LEADER_TOP_N = 20)
 * @param opts.categories 필요한 카테고리만 계산(생략 시 전부)
 * 경기가 없는 시즌(개막 전)은 null.
 */
export async function getSeasonLeaderboards(
  seasonName: string,
  opts?: { topN?: number; categories?: LeaderCategoryKey[] }
): Promise<SeasonLeaderboards | null> {
  const topN = opts?.topN ?? LEADER_TOP_N;
  const wanted = opts?.categories?.length
    ? LEADER_CATEGORIES.filter((c) => opts.categories!.includes(c.key))
    : LEADER_CATEGORIES;

  const [{ rows, gamesN, games }, teams] = await Promise.all([
    fetchSeasonPlayerGameRows(seasonName, { category: SEASON_CATEGORY_REGULAR }),
    getTeams(seasonName),
  ]);
  if (!rows.length) return null;

  const aggs = aggregateSeasonPlayers(rows).filter((a) => a.gp > 0);
  if (!aggs.length) return null;

  // 시도 하한을 시즌 길이에 맞춰 스케일하는 기준. 리그 평균을 반올림하지 않고 팀별 일정을 직접
  // 센 뒤 그 최소값을 쓴다 - 어떤 선수에게도 자기 팀이 치르지 않은 일정 기준의 하한이 걸리지 않고,
  // 화면에 인쇄되는 근거("팀 N경기")가 10팀 전부에게 참이 된다(teamGameCounts 주석 참고).
  const { min: teamGamesMin, max: teamGamesMax } = teamGameCounts(games);
  const teamGames = teamGamesMin || gamesN;
  const teamGamesText = teamGamesMin === teamGamesMax ? `${teamGamesMin}경기` : `${teamGamesMin}~${teamGamesMax}경기`;
  const teamGamesBasis =
    teamGamesMin === teamGamesMax
      ? `팀 ${teamGamesMin}경기 기준`
      : `팀별 일정이 ${teamGamesMin}~${teamGamesMax}경기라 최소 일정 ${teamGamesMin}경기 기준`;

  // WPA만 원천이 다르다(사전 집계 테이블). 시즌 한 개 = 최대 200행 남짓이라 페이지네이션 불필요하지만
  // 관례대로 안전하게 range로 끝까지 받는다.
  const needWpa = wanted.some((c) => c.key === "wpa");
  const wpaByPcode = new Map<string, number>();
  if (needWpa) {
    const wrows = await fetchAllPagesBounded<{ pcode: string; total_wpa: number | string | null }>((from, to) =>
      supabase.from("player_season_wpa").select("pcode, total_wpa", { count: "exact" }).eq("season_name", seasonName).range(from, to)
    );
    for (const w of wrows) wpaByPcode.set(w.pcode, num(w.total_wpa));
  }

  const names = new Map<string, string>();
  for (const part of chunk(aggs.map((a) => a.pcode), 200)) {
    const { data } = await supabase.from("players").select("pcode, name").in("pcode", part);
    for (const p of data ?? []) names.set(p.pcode as string, p.name as string);
  }

  const qualifiedN = aggs.filter(isQualified).length;
  const qualifyCaption = `비율·평균 지표 자격: ${LEADER_QUALIFY.gp}경기 또는 ${LEADER_QUALIFY.min}분 이상 (${seasonName} 정규시즌 ${qualifiedN}명 / 출전 ${aggs.length}명)`;

  const boards: Leaderboard[] = [];
  for (const def of wanted) {
    const ex = EXTRACT[def.key];
    const att = ex.minAtt?.(teamGames);
    let pool = aggs;
    const qualifyBits: string[] = [];
    if (def.rate) {
      pool = pool.filter(isQualified);
      qualifyBits.push(`${LEADER_QUALIFY.gp}경기 또는 ${LEADER_QUALIFY.min}분 이상`);
    }
    if (att) {
      pool = pool.filter((a) => att.of(a) >= att.need);
      qualifyBits.push(`${att.label} ${att.need.toLocaleString()}개 이상(${teamGamesBasis})`);
    }
    if (def.key === "wpa") pool = pool.filter((a) => wpaByPcode.has(a.pcode));

    const scored = pool
      .map((a) => ({ a, v: ex.value(a, wpaByPcode.get(a.pcode) ?? null) }))
      .filter((x): x is { a: SeasonPlayerAgg; v: number } => x.v != null && Number.isFinite(x.v));
    if (!scored.length) continue;
    scored.sort((x, y) => y.v - x.v || y.a.minutes - x.a.minutes);

    const rowsOut: LeaderRow[] = scored.slice(0, topN).map((x) => {
      const better = scored.filter((o) => o.v > x.v).length;
      const team = teams.get(x.a.tcode);
      const pos = normalizePos(x.a.pos);
      return {
        rank: better + 1,
        pcode: x.a.pcode,
        name: names.get(x.a.pcode) ?? x.a.pcode,
        tcode: x.a.tcode,
        teamName: team?.name ?? null,
        teamAbbr: team?.abbr ?? null,
        teamColor: team?.color ?? null,
        pos,
        posLabel: posLabel(pos),
        value: x.v,
        display: ex.display(x.v),
        gp: x.a.gp,
        minutes: x.a.minutes,
        sample: ex.sample ? ex.sample(x.a) : `${x.a.gp}경기 · ${Math.round(x.a.minutes).toLocaleString()}분`,
        href: `/players/${x.a.pcode}`,
      };
    });

    boards.push({
      key: def.key,
      label: def.label,
      unit: def.unit,
      group: def.group,
      rate: def.rate,
      note: def.note,
      qualifyText: qualifyBits.length ? `${qualifyBits.join(" · ")} · ${scored.length}명 중` : `자격 기준 없음(누적 기록) · ${scored.length}명 중`,
      poolN: scored.length,
      rows: rowsOut,
    });
  }
  if (!boards.length) return null;

  return {
    seasonName,
    seasonCategory: SEASON_CATEGORY_REGULAR,
    teamGames,
    teamGamesMin,
    teamGamesMax,
    teamGamesText,
    teamGamesBasis,
    playersN: aggs.length,
    qualifiedN,
    topN,
    boards,
    caption: `${shortSeason(seasonName)} 정규시즌 ${gamesN}경기(팀당 ${teamGamesText}) · 플레이오프 제외 · 출전 경기는 0분 엔트리 제외`,
    qualifyCaption,
  };
}

/**
 * 리더보드를 만들 수 있는 시즌(정규시즌 종료 경기가 하나라도 있는 시즌), 최신순.
 * seasons 표(16행)를 먼저 읽고 시즌마다 head count 한 번씩 - 행을 하나도 안 받아온다.
 * 개막 전 2026-2027은 여기서 자동으로 빠진다.
 */
export async function getLeaderboardSeasons(): Promise<string[]> {
  const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
  const seasons = (data ?? []).map((s) => s.season_name as string);
  const checks = await Promise.all(
    seasons.map(async (s) => {
      const { count } = await supabase
        .from("games")
        .select("gmkey", { count: "exact", head: true })
        .eq("season_name", s)
        .eq("season_category", SEASON_CATEGORY_REGULAR)
        .eq("is_ended", true);
      return { s, n: count ?? 0 };
    })
  );
  return checks.filter((c) => c.n > 0).map((c) => c.s);
}
