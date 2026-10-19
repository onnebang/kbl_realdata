import { supabaseServer as supabase } from "./supabaseServer";
import { TAG, TTL, cached, cachedFn } from "./cachePolicy";
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
  | "totalPts" | "totalReb" | "totalAst" | "totalStl" | "totalBlk"
  | "tpm"
  | "tpPct" | "fgPct" | "ftPct"
  | "mpg" | "per" | "tsPct" | "usgPct";

export type LeaderGroup = "기본" | "총량" | "슈팅" | "고급";

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

  // 사용자 요청(2026-10-06, 시즌 초반) - 경기당 평균은 적게 뛴 선수가 한두 경기 잘하면 과장되기
  // 쉽지만, 시즌 누적 총량은 "많이, 꾸준히 뛰어야" 쌓이므로 표본이 적은 시즌 초반엔 평균보다
  // 왜곡이 덜하다. tpm과 같은 패턴(rate: false = 자격 기준 없음, 그냥 누적 합계 순위).
  { key: "totalPts", label: "총 득점", unit: "점", group: "총량", rate: false, note: "시즌 누적 득점 - 누적 기록이라 자격 기준 없음(경기당 평균과 달리 적게 뛴 선수가 유리해지지 않음)" },
  { key: "totalReb", label: "총 리바운드", unit: "개", group: "총량", rate: false, note: "시즌 누적 리바운드" },
  { key: "totalAst", label: "총 어시스트", unit: "개", group: "총량", rate: false, note: "시즌 누적 어시스트" },
  { key: "totalStl", label: "총 스틸", unit: "개", group: "총량", rate: false, note: "시즌 누적 스틸" },
  { key: "totalBlk", label: "총 블록", unit: "개", group: "총량", rate: false, note: "시즌 누적 블록" },

  { key: "tpm", label: "3P 성공", unit: "개", group: "슈팅", rate: false, note: "시즌 누적 3점 성공 수 - 누적 기록이라 자격 기준 없음" },
  { key: "tpPct", label: "3P%", unit: "%", group: "슈팅", rate: true, note: "tpm / tpa" },
  { key: "fgPct", label: "FG%", unit: "%", group: "슈팅", rate: true, note: "총 야투 = (fgm+tpm) / (fga+tpa). 이 DB의 fga/fgm은 2점 전용이라 3점을 반드시 더해야 한다" },
  { key: "ftPct", label: "FT%", unit: "%", group: "슈팅", rate: true, note: "ftm / fta" },

  { key: "per", label: "PER", unit: "", group: "고급", rate: true, note: "경기별 per의 출전 시간 가중 평균(짧게 뛴 경기가 과대 반영되지 않게)" },
  { key: "tsPct", label: "TS%", unit: "%", group: "고급", rate: true, note: "득점 / (2 × (fga + tpa + 0.44×fta))" },
  { key: "usgPct", label: "USG%", unit: "%", group: "고급", rate: true, note: "경기별 usage_rtg의 출전 시간 가중 평균" },
  // WPA 카드는 뺐다(2026-09-15): 선수 시즌 WPA 합계는 득점과 r=0.991이라 득점 카드와 같은 순위였다(WPA가 넣은 슛에만
  // 붙는다 - tools/rpc_win_moments.sql). 페이지가 "승부를 가른 순간"으로 가는 안내 카드를 대신 둔다.
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
  /** 이 시점에 적용된 평균·성공률 부문 자격(시즌 초반이면 relaxed). */
  qualify: QualifyRule;
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

export const PLAYER_SELECT =
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
export function teamGameCounts(games: Pick<SeasonGameRow, "homeTcode" | "awayTcode">[]): {
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

/**
 * 시즌 초반 완화 자격. 15경기/300분은 54경기 시즌을 전제로 한 값이라 팀이 3~4경기만 치른 개막
 * 직후에는 아무도 통과하지 못해 경기당·성공률·고급 부문이 통째로 비었다(2026-10-13 라이브 확인:
 * 자격 통과 0명/111명). 그래서 팀 경기 수에 맞춰 자라는 기준을 "기존 기준에 더해" 둔다:
 *   - 출전 경기 >= 팀 경기의 절반(최소 2, 최대 15)  **그리고**
 *   - 누적 출전 >= 팀 경기당 8분(최대 300)
 * 둘 다를 요구하는 이유(OR이 아닌): 2경기 × 3분짜리 벤치 선수가 PER·USG% 1위에 올라오는 걸 막는다
 * (로컬 실측: 단순 OR 완화는 84명 중 경기당 8분 미만이 11명, 이 AND는 64명 중 6명).
 * 기존 기준(15경기 또는 300분)과의 합집합이라, 팀 29경기부터는 완화 쪽이 기존 기준에 포함돼
 * 결과가 이전과 완전히 같다 - 지난 시즌 리더보드는 바뀌지 않는다.
 */
export const QUALIFY_MIN_PER_TEAM_GAME = 8;
export const QUALIFY_FLOOR_GP = 2;

export type QualifyRule = {
  /** 완화 기준의 최소 출전 경기 / 누적 분. relaxed가 false면 기존 기준과 같다. */
  gp: number;
  min: number;
  relaxed: boolean;
  /** 완화가 끝나는 팀 경기 수(이때부터 기존 15경기 또는 300분). */
  fullAt: number;
};

export function qualifyRule(teamGames: number): QualifyRule {
  const gp = Math.min(LEADER_QUALIFY.gp, Math.max(QUALIFY_FLOOR_GP, Math.ceil(teamGames / 2)));
  const min = Math.min(LEADER_QUALIFY.min, teamGames * QUALIFY_MIN_PER_TEAM_GAME);
  // gp가 15에 닿는 순간(= 팀 2×15−1경기) 완화 쪽은 기존 기준의 부분집합이 된다.
  return { gp, min, relaxed: gp < LEADER_QUALIFY.gp, fullAt: 2 * LEADER_QUALIFY.gp - 1 };
}

/** 자격 판정 - 15경기 "또는" 300분. rule을 주면 시즌 초반 완화 기준(AND)도 통과로 친다. */
export function isQualified(a: { gp: number; minutes: number }, rule?: QualifyRule): boolean {
  if (a.gp >= LEADER_QUALIFY.gp || a.minutes >= LEADER_QUALIFY.min) return true;
  return !!rule?.relaxed && a.gp >= rule.gp && a.minutes >= rule.min;
}

const fmt1 = (v: number) => v.toFixed(1);
const fmt2 = (v: number) => v.toFixed(2);
const fmtPct = (v: number) => v.toFixed(1);
const fmtInt = (v: number) => Math.round(v).toLocaleString();

type Extractor = {
  value: (a: SeasonPlayerAgg) => number | null;
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
  totalPts: { value: (a) => a.pts, display: fmtInt, sample: (a) => `${a.gp}경기` },
  totalReb: { value: (a) => a.reb, display: fmtInt, sample: (a) => `${a.gp}경기` },
  totalAst: { value: (a) => a.ast, display: fmtInt, sample: (a) => `${a.gp}경기` },
  totalStl: { value: (a) => a.stl, display: fmtInt, sample: (a) => `${a.gp}경기` },
  totalBlk: { value: (a) => a.blk, display: fmtInt, sample: (a) => `${a.gp}경기` },
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
};

/**
 * 시즌 리더보드 전체.
 * @param opts.topN 카테고리당 인원(기본 LEADER_TOP_N = 20)
 * @param opts.categories 필요한 카테고리만 계산(생략 시 전부)
 * 경기가 없는 시즌(개막 전)은 null.
 */
/**
 * 시즌 리더보드는 game_player_stats 6,800행을 7~8왕복으로 읽어 접는다. 경기가 끝날 때만
 * 바뀌므로 캐시한다. 키에 카테고리 목록이 들어가야 한다 - 같은 시즌이라도 요청한 카테고리가
 * 다르면 다른 결과다(정렬해서 넣어야 순서가 달라도 같은 키가 된다).
 */
export async function getSeasonLeaderboards(
  seasonName: string,
  opts?: { topN?: number; categories?: LeaderCategoryKey[] }
): Promise<SeasonLeaderboards | null> {
  const catKey = opts?.categories?.length ? [...opts.categories].sort().join(",") : "all";
  return cached(
    () => computeSeasonLeaderboards(seasonName, opts),
    ["seasonLeaderboards-v3", seasonName, String(opts?.topN ?? "d"), catKey], // v3: 시즌 초반 완화 자격(qualify 필드 추가) / v2: WPA 카드 제거
    TTL.batchDaily,
    [TAG.batch, TAG.season(seasonName)]
  );
}

async function computeSeasonLeaderboards(
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

  const names = new Map<string, string>();
  for (const part of chunk(aggs.map((a) => a.pcode), 200)) {
    const { data } = await supabase.from("players").select("pcode, name").in("pcode", part);
    for (const p of data ?? []) names.set(p.pcode as string, p.name as string);
  }

  const rule = qualifyRule(teamGames);
  const qualifiedN = aggs.filter((a) => isQualified(a, rule)).length;
  const rateRuleText = rule.relaxed
    ? `${rule.gp}경기 이상 출전 + 누적 ${rule.min}분 이상(시즌 초반 완화 · 팀 ${teamGames}경기 기준)`
    : `${LEADER_QUALIFY.gp}경기 또는 ${LEADER_QUALIFY.min}분 이상`;
  const qualifyCaption = rule.relaxed
    ? `비율·평균 지표 자격(시즌 초반 완화): ${rateRuleText}. 팀 ${rule.fullAt}경기부터 원래 기준(${LEADER_QUALIFY.gp}경기 또는 ${LEADER_QUALIFY.min}분)으로 자동 복귀 (${seasonName} 정규시즌 ${qualifiedN}명 / 출전 ${aggs.length}명)`
    : `비율·평균 지표 자격: ${rateRuleText} (${seasonName} 정규시즌 ${qualifiedN}명 / 출전 ${aggs.length}명)`;

  const boards: Leaderboard[] = [];
  for (const def of wanted) {
    const ex = EXTRACT[def.key];
    const att = ex.minAtt?.(teamGames);
    let pool = aggs;
    const qualifyBits: string[] = [];
    if (def.rate) {
      pool = pool.filter((a) => isQualified(a, rule));
      qualifyBits.push(rateRuleText);
    }
    if (att) {
      pool = pool.filter((a) => att.of(a) >= att.need);
      qualifyBits.push(`${att.label} ${att.need.toLocaleString()}개 이상(${teamGamesBasis})`);
    }
    const scored = pool
      .map((a) => ({ a, v: ex.value(a) }))
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
    qualify: rule,
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
 * 개막 전 2026-2027은 여기서 자동으로 빠진다.
 *
 * 예전에는 seasons 16행을 읽고 시즌마다 head count를 한 번씩 던졌다 - 행은 하나도 안 받지만
 * **왕복이 17번**이었고, /lineups와 /leaderboards/season이 매 요청 이걸 불렀다(실측).
 * 지금은 뷰 하나로 1왕복이다:
 *   create or replace view seasons_with_regular_games as
 *     select distinct season_name from games
 *      where season_category = '정규시즌' and is_ended;
 * 미리 구운 컬럼이 아니라 뷰인 이유 - 개막 첫 경기가 끝난 날 배치(매일 06:00)를 기다리지
 * 않고 바로 켜져야 하기 때문이다.
 */
export const getLeaderboardSeasons = cachedFn(computeLeaderboardSeasons, {
  name: "leaderboardSeasons",
  ttl: TTL.batchDaily,
  tags: () => [TAG.batch],
});

async function computeLeaderboardSeasons(): Promise<string[]> {
  const { data, error } = await supabase
    .from("seasons_with_regular_games")
    .select("season_name")
    .order("season_name", { ascending: false });
  if (error) throw new Error(`getLeaderboardSeasons: ${error.message}`);
  return (data ?? []).map((s) => s.season_name as string);
}
