import { supabase } from "./supabase";
import { displayTeamName } from "./teamNames";
import { PRESEASON_SEASON, isRealGmkey, getPregameProb } from "./preseason";
import { getTeamNextGame, type TeamFixture } from "./matchups";
import { getPlayerInfo, getPlayerRecentGames, type CareerGameRow } from "./playerProfile";
import { classifyShot } from "./formIndex";
import { COMBO_MIN_MINUTES, DNA_ZONES, DNA_ZONE_LABELS, type DnaZone } from "./playerDataScience";
import { PERCENTILE_FINAL } from "./seasonFocus";

// 선수 프로필 페이지(app/players/[pcode]) 전용 데이터 레이어 - 프로필 개편 1단계.
//
// 공유 lib(playerProfile/playerDataScience/preseason/matchups/seasonFocus/playerStatus)이 주지
// 않는 것만 여기서 채운다(공유 lib은 이 작업에서 수정하지 않는다는 계약):
//   - xpts_zone_table의 fg_pct/attempts(존 +/- 표의 "리그 FG%" 열)
//   - player_season_wpa를 선수의 전 시즌에 대해 한 번에(순위·pos/neg 분해 - 히어로 타일·마지막
//     장면·클러치 분해 바·커리어 아크 순위 레인·시즌표 WPA 열이 전부 같은 Map을 씀)
//   - game_summary_tags 교차(마지막 장면 "경기 성격" 줄)
//   - lineup_combo n=2/3/5(기존 getTopPairCombos는 2인 상위 3개만 돌려줘 "26-27 동료 교집합"을
//     만들 수 없음)
//   - season_roster 팀 명단(동료 교집합 시드), 다음 경기 + 모델 승률, 수록 일정 끝 날짜,
//     퍼센타일 풀 평균(1시즌 선수의 커리어 아크 기준선), generateMetadata용 한 줄
//   - 커리어 경기 행(getPlayerCareerGames)에서 시즌/팀/정규·PO 집계를 만드는 순수 함수
//
// 원칙: 숫자마다 표본(경기·슛)과 기준 시즌을 같이 돌려주고, 추정·원인 서술은 하지 않는다.

// ── 존 기대값 테이블(리그 15시즌 553,248슛 기준, 마이그레이션 create_xpts_zone_table) ────────
export type ZoneLeagueRow = { zone: string; attempts: number; makes: number; fgPct: number; shotValue: number; expectedPtsPerShot: number };

export async function getZoneLeagueTable(): Promise<ZoneLeagueRow[]> {
  const { data } = await supabase.from("xpts_zone_table").select("zone, attempts, makes, fg_pct, shot_value, expected_pts_per_shot");
  return (data ?? []).map((z) => ({
    zone: z.zone as string,
    attempts: Number(z.attempts),
    makes: Number(z.makes),
    fgPct: Number(z.fg_pct),
    shotValue: Number(z.shot_value),
    expectedPtsPerShot: Number(z.expected_pts_per_shot),
  }));
}

/** lib/shotImpactChart.ts buildImpactDots가 받는 zone -> 기대득점 Map(같은 테이블을 두 번 읽지 않도록 여기서 변환). */
export function zoneExpectedMap(rows: ZoneLeagueRow[]): Map<string, number> {
  return new Map(rows.map((r) => [r.zone, r.expectedPtsPerShot]));
}

/** 리그 전체 3점 시도 비중(슈팅 DNA 밴드의 기준선). 테이블이 비면 null. */
export function leagueThreeShare(rows: ZoneLeagueRow[]): number | null {
  const total = rows.reduce((s, r) => s + r.attempts, 0);
  const three = rows.find((r) => r.zone === "three")?.attempts ?? 0;
  return total > 0 ? three / total : null;
}

// ── 존 +/- 표("어디서 리그를 이기는가") ─────────────────────────────────────────────────
/** 이 시도 수 미만인 행은 델타를 회색으로(표본 경고) - 디자인 상수. */
export const ZONE_TABLE_MIN_ATTEMPTS = 20;

export type ZoneTableRow = {
  zone: DnaZone;
  label: string;
  attempts: number;
  makes: number;
  fgPct: number | null;
  /** 이항 표준오차 √(p(1−p)/n) - 시도 0이면 null. */
  se: number | null;
  leagueFgPct: number | null;
  shotValue: number;
  actualPts: number;
  expectedPts: number;
  /** 실제 득점 − 시도 × 리그 존 기대득점. */
  delta: number;
};

export function computeZoneTable(shots: { x: number; y: number; d: string; made: boolean }[], league: ZoneLeagueRow[]): ZoneTableRow[] {
  const byZone = new Map<string, ZoneLeagueRow>(league.map((r) => [r.zone, r]));
  const counts = new Map<DnaZone, { att: number; made: number; value: number }>();
  for (const s of shots) {
    const { zone, value } = classifyShot(s.x, s.y, s.d);
    const z = (DNA_ZONES as readonly string[]).includes(zone) ? (zone as DnaZone) : "three";
    const c = counts.get(z) ?? { att: 0, made: 0, value };
    c.att += 1;
    if (s.made) c.made += 1;
    counts.set(z, c);
  }
  return DNA_ZONES.map((z) => {
    const c = counts.get(z) ?? { att: 0, made: 0, value: z === "three" ? 3 : 2 };
    const lg = byZone.get(z);
    const p = c.att > 0 ? c.made / c.att : null;
    const value = lg?.shotValue ?? c.value;
    const expected = c.att * (lg?.expectedPtsPerShot ?? 0);
    const actual = c.made * value;
    return {
      zone: z,
      label: DNA_ZONE_LABELS[z],
      attempts: c.att,
      makes: c.made,
      fgPct: p,
      se: p != null && c.att > 0 ? Math.sqrt((p * (1 - p)) / c.att) : null,
      leagueFgPct: lg ? lg.fgPct : null,
      shotValue: value,
      actualPts: actual,
      expectedPts: expected,
      delta: actual - expected,
    };
  });
}

// ── player_season_wpa - 선수의 전 시즌을 한 번에(순위는 JS) ───────────────────────────────
// player_season_wpa.games는 정규시즌 GP다(워니 25-26 games 50 vs 정규+PO 53GP - 검증). 이 값을
// 쓰는 화면은 반드시 '정규' 라벨을 붙인다. (pcode, season_name) 중복 행은 없음(검증 0건).
export type SeasonWpaLine = {
  seasonName: string;
  tcode: string;
  games: number; // 정규시즌 GP
  plays: number;
  totalWpa: number;
  posWpa: number;
  negWpa: number;
  wpaPerGame: number;
  rank: number; // 그 시즌 total_wpa 내림차순 순위(lib/playerDataScience.ts getSeasonWpaRank와 같은 정의)
  outOf: number;
};

export async function getPlayerWpaBySeason(pcode: string, seasons: string[]): Promise<Map<string, SeasonWpaLine>> {
  const out = new Map<string, SeasonWpaLine>();
  if (!seasons.length) return out;
  type Row = { pcode: string; season_name: string; tcode: string; games: number; plays: number; total_wpa: number; pos_wpa: number; neg_wpa: number; wpa_per_game: number };
  const PAGE = 1000;
  const rows: Row[] = [];
  // 시즌당 최대 189행(검증) × 커리어 15시즌 ≈ 2,800행 - 1000행 cap을 넘으므로 .range 페이지네이션.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("player_season_wpa")
      .select("pcode, season_name, tcode, games, plays, total_wpa, pos_wpa, neg_wpa, wpa_per_game")
      .in("season_name", seasons)
      .order("season_name", { ascending: true })
      .order("total_wpa", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    rows.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }
  const bySeason = new Map<string, Row[]>();
  for (const r of rows) (bySeason.get(r.season_name) ?? bySeason.set(r.season_name, []).get(r.season_name)!).push(r);
  for (const [seasonName, list] of bySeason) {
    const sorted = list.slice().sort((a, b) => b.total_wpa - a.total_wpa);
    const idx = sorted.findIndex((r) => r.pcode === pcode);
    if (idx < 0) continue;
    const me = sorted[idx];
    out.set(seasonName, {
      seasonName,
      tcode: me.tcode,
      games: Number(me.games),
      plays: Number(me.plays),
      totalWpa: Number(me.total_wpa),
      posWpa: Number(me.pos_wpa),
      negWpa: Number(me.neg_wpa),
      wpaPerGame: Number(me.wpa_per_game),
      rank: idx + 1,
      outOf: sorted.length,
    });
  }
  return out;
}

// ── game_summary_tags 교차(마지막 장면 "경기 성격") ──────────────────────────────────────
export type TagKey = "nailbiter" | "blowout" | "comeback";
export const TAG_LABELS: Record<TagKey, string> = { nailbiter: "박빙", blowout: "압도적", comeback: "역전" };
export type GameTag = { tagKey: string; tagLabel: string; margin: number | null };

export async function getGameTags(gmkeys: string[]): Promise<Map<string, GameTag[]>> {
  const out = new Map<string, GameTag[]>();
  const CHUNK = 300;
  for (let i = 0; i < gmkeys.length; i += CHUNK) {
    const { data } = await supabase.from("game_summary_tags").select("gmkey, tag_key, tag_label, margin").in("gmkey", gmkeys.slice(i, i + CHUNK));
    for (const t of data ?? []) {
      const k = t.gmkey as string;
      (out.get(k) ?? out.set(k, []).get(k)!).push({ tagKey: t.tag_key as string, tagLabel: t.tag_label as string, margin: t.margin == null ? null : Number(t.margin) });
    }
  }
  return out;
}

export type TagSummary = { key: TagKey; label: string; games: number; wins: number };

/** 선수가 실제 출전(0분 초과)한 종료 경기 중 태그된 경기 수와 그중 소속팀 승수. 태그는 경기당 1개(검증). */
export function summarizeGameTags(rows: CareerGameRow[], tags: Map<string, GameTag[]>): TagSummary[] {
  const keys: TagKey[] = ["nailbiter", "blowout", "comeback"];
  const acc = new Map<TagKey, { games: number; wins: number }>(keys.map((k) => [k, { games: 0, wins: 0 }]));
  for (const g of rows) {
    if (!g.isEnded || g.teamScore == null || g.oppScore == null || g.min <= 0) continue;
    for (const t of tags.get(g.gmkey) ?? []) {
      const a = acc.get(t.tagKey as TagKey);
      if (!a) continue;
      a.games += 1;
      if (g.teamScore > g.oppScore) a.wins += 1;
    }
  }
  return keys.map((k) => ({ key: k, label: TAG_LABELS[k], ...acc.get(k)! }));
}

// ── lineup_combo n=2/3/5(함께 뛰는 사람들) ───────────────────────────────────────────────
// 소표본 하한(분): 2인 = lib/playerDataScience.ts COMBO_MIN_MINUTES(50), 3인 30, 5인 20(spec).
// lineup_combo에는 season/tcode 컬럼이 없어 15시즌 커리어 합산이다 - 화면 캡션에 명시.
export const COMBO_MIN_MINUTES_BY_N: Record<2 | 3 | 5, number> = { 2: COMBO_MIN_MINUTES, 3: 30, 5: 20 };
const COMBO_FETCH_LIMIT = 600; // 실측 최대: 2인 112 / 3인 539 / 5인 230(선수당, 하한 적용 후)

export type LineupComboRow = { pcodes: string[]; partners: string[]; n: 2 | 3 | 5; minutes: number; stints: number; netRatingPer40: number };
export type PlayerCombos = { rows: LineupComboRow[]; nameByPcode: Map<string, string> };

export async function getPlayerCombos(pcode: string): Promise<PlayerCombos> {
  const ns: (2 | 3 | 5)[] = [2, 3, 5];
  const results = await Promise.all(
    ns.map((n) =>
      supabase
        .from("lineup_combo")
        .select("pcodes, n, minutes, stints, net_rating_per40")
        .contains("pcodes", [pcode])
        .eq("n", n)
        .gte("minutes", COMBO_MIN_MINUTES_BY_N[n])
        .order("net_rating_per40", { ascending: false })
        .limit(COMBO_FETCH_LIMIT)
    )
  );
  const rows: LineupComboRow[] = [];
  results.forEach((res, i) => {
    for (const r of res.data ?? []) {
      const pcodes = (r.pcodes as string[]) ?? [];
      rows.push({
        pcodes,
        partners: pcodes.filter((p) => p !== pcode),
        n: ns[i],
        minutes: Number(r.minutes),
        stints: Number(r.stints ?? 0),
        netRatingPer40: Number(r.net_rating_per40),
      });
    }
  });
  const partnerSet = new Set<string>();
  for (const r of rows) for (const p of r.partners) partnerSet.add(p);
  const partners = [...partnerSet];
  const nameByPcode = new Map<string, string>();
  const CHUNK = 200;
  for (let i = 0; i < partners.length; i += CHUNK) {
    const { data } = await supabase.from("players").select("pcode, name").in("pcode", partners.slice(i, i + CHUNK));
    for (const p of data ?? []) nameByPcode.set(p.pcode as string, p.name as string);
  }
  return { rows, nameByPcode };
}

// ── season_roster 팀 명단(pcode 있는 행만 - 신입은 pcode가 없어 조합에 등장할 수 없음) ───────
export type RosterMate = { pcode: string; name: string; backNum: string | null; pos: string | null };

export async function getTeamRoster(tcode: string, season = PRESEASON_SEASON): Promise<RosterMate[]> {
  const { data } = await supabase.from("season_roster").select("pcode, player_name, back_num, pos").eq("season_name", season).eq("tcode", tcode).not("pcode", "is", null);
  return (data ?? []).map((r) => ({ pcode: r.pcode as string, name: r.player_name as string, backNum: (r.back_num as string | null) ?? null, pos: (r.pos as string | null) ?? null }));
}

// ── 다음 경기 + 모델 승률(선수 소속팀 관점) ──────────────────────────────────────────────
export type NextGame = {
  fixture: TeamFixture;
  /** pregame_features.home_win_prob 원값(홈 팀 기준, 0~1). 없으면 null. */
  homeWinProb: number | null;
  /** 선수 소속팀 기준으로 뒤집은 값(원정이면 1 − p). */
  teamWinProb: number | null;
};

export async function getNextGameWithProb(tcode: string, season = PRESEASON_SEASON): Promise<NextGame | null> {
  const fixture = await getTeamNextGame(tcode, season);
  if (!fixture) return null;
  const p = await getPregameProb(fixture.gmkey);
  return { fixture, homeWinProb: p, teamWinProb: p == null ? null : fixture.isHome ? p : 1 - p };
}

/** 이 시즌 수록된 실제 일정의 마지막 날짜(캡션 '12-31까지 수록' - 후반기 적재 시 자동으로 늘어난다). */
export async function getSeasonScheduleEnd(season = PRESEASON_SEASON): Promise<string | null> {
  const { data } = await supabase.from("games").select("gmkey, game_date").eq("season_name", season).order("game_date", { ascending: false }).limit(10);
  const real = (data ?? []).find((g) => isRealGmkey(g.gmkey as string));
  return real ? (real.game_date as string) : null;
}

// ── 퍼센타일 풀 평균(1시즌 선수의 커리어 아크 기준선) ────────────────────────────────────
// 같은 RPC(player_season_percentile_pool)를 같은 자격(PERCENTILE_FINAL: 15경기 또는 300분)으로
// 걸러 평균만 낸다 - 퍼센타일 패널의 풀과 정의가 같아야 "같은 풀의 평균"이라고 쓸 수 있다.
export type PoolAverage = { season: string; n: number; ppg: number; minPg: number };

export async function getPoolAverage(season: string): Promise<PoolAverage | null> {
  const { data, error } = await supabase.rpc("player_season_percentile_pool", { p_season: season });
  if (error || !data) return null;
  type Row = { gp: number | string; min_total: number | string; ppg: number | string };
  const pool = (data as Row[]).map((r) => ({ gp: Number(r.gp), min: Number(r.min_total), ppg: Number(r.ppg) })).filter((r) => r.gp >= PERCENTILE_FINAL.gp || r.min >= PERCENTILE_FINAL.min);
  if (!pool.length) return null;
  return {
    season,
    n: pool.length,
    ppg: pool.reduce((s, r) => s + r.ppg, 0) / pool.length,
    minPg: pool.reduce((s, r) => s + (r.gp > 0 ? r.min / r.gp : 0), 0) / pool.length,
  };
}

// ── generateMetadata용 한 줄(커리어 전 경기를 다시 읽지 않도록 가벼운 조회만) ───────────────
export type PlayerHeadline = { name: string; ename: string | null; teamName: string | null; backNum: string | null; pos: string | null; seasonLabel: string };

export async function getPlayerHeadline(pcode: string): Promise<PlayerHeadline | null> {
  const [info, rosterRes, teamsRes, last] = await Promise.all([
    getPlayerInfo(pcode),
    supabase.from("season_roster").select("tcode, back_num, pos").eq("season_name", PRESEASON_SEASON).eq("pcode", pcode).limit(1),
    supabase.from("teams").select("tcode, name"),
    getPlayerRecentGames(pcode, 1),
  ]);
  if (!info) return null;
  const nameOf = new Map((teamsRes.data ?? []).map((t) => [t.tcode as string, t.name as string]));
  const roster = (rosterRes.data ?? [])[0] as { tcode: string; back_num: string | null; pos: string | null } | undefined;
  const lastGame = last[0];
  if (roster) {
    const sameTeam = lastGame?.tcode === roster.tcode;
    return {
      name: info.name,
      ename: info.ename,
      teamName: displayTeamName(roster.tcode, nameOf.get(roster.tcode) ?? roster.tcode, PRESEASON_SEASON),
      backNum: (roster.back_num ?? "").trim() || (sameTeam ? (lastGame?.backNum ?? null) : null),
      pos: roster.pos ? roster.pos.charAt(0).toUpperCase() : lastGame?.pos ? lastGame.pos.charAt(0).toUpperCase() : null,
      seasonLabel: `${PRESEASON_SEASON} 확정 명단`,
    };
  }
  if (lastGame) {
    // 마지막 경기 시즌은 getPlayerRecentGames가 주지 않으므로 팀명은 현재 표기 기준(상세 시즌 표기는 페이지가 담당).
    return {
      name: info.name,
      ename: info.ename,
      teamName: displayTeamName(lastGame.tcode, nameOf.get(lastGame.tcode) ?? lastGame.tcode, PRESEASON_SEASON),
      backNum: lastGame.backNum,
      pos: lastGame.pos ? lastGame.pos.charAt(0).toUpperCase() : null,
      seasonLabel: `마지막 경기 ${lastGame.gameDate}`,
    };
  }
  return { name: info.name, ename: info.ename, teamName: null, backNum: null, pos: null, seasonLabel: "KBL 출전 기록 없음" };
}

// ── 커리어 경기 행 집계(순수 함수) ────────────────────────────────────────────────────────
// GP는 행 수(0분 DNP 포함 - 기존 getPlayerCareerBySeason 관례)이고 gpPlayed가 0분 초과 수.
// FG%는 2점 야투(2P%) - game_player_stats.fga가 2점 시도만이라는 프로젝트 관례(lib/shotImpactChart.ts).
export type BoxAgg = {
  gp: number;
  gpPlayed: number;
  starts: number;
  minPg: number;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  tovPg: number;
  fgPct: number | null;
  tpPct: number | null;
  ftPct: number | null;
  tsPct: number | null;
};

export function aggBox(rows: CareerGameRow[]): BoxAgg | null {
  const gp = rows.length;
  if (!gp) return null;
  const sum = (fn: (r: CareerGameRow) => number) => rows.reduce((s, r) => s + fn(r), 0);
  const fgm = sum((r) => r.fgm),
    fga = sum((r) => r.fga),
    tpm = sum((r) => r.tpm),
    tpa = sum((r) => r.tpa),
    ftm = sum((r) => r.ftm),
    fta = sum((r) => r.fta),
    pts = sum((r) => r.pts);
  const tsa = fga + tpa + 0.44 * fta;
  return {
    gp,
    gpPlayed: rows.filter((r) => r.min > 0).length,
    starts: rows.filter((r) => r.isStarter === true).length,
    minPg: sum((r) => r.min) / gp,
    ppg: pts / gp,
    rpg: sum((r) => r.reb) / gp,
    apg: sum((r) => r.ast) / gp,
    spg: sum((r) => r.stl) / gp,
    bpg: sum((r) => r.blk) / gp,
    tovPg: sum((r) => r.tov) / gp,
    fgPct: fga > 0 ? fgm / fga : null,
    tpPct: tpa > 0 ? tpm / tpa : null,
    ftPct: fta > 0 ? ftm / fta : null,
    tsPct: tsa > 0 ? pts / (2 * tsa) : null,
  };
}

export const PLAYOFF_CATEGORY = "플레이오프";

/** 시즌 × 팀 라인(시즌별 기록 표) - 정규/PO 분리. */
export type SeasonTeamLine = { seasonName: string; tcode: string; lastDate: string; all: BoxAgg; reg: BoxAgg | null; po: BoxAgg | null };

/** 시즌 하나로 합친 서사 단위(히어로 타일·커리어 아크) - 시즌 중 이적은 경기수 가중으로 자연히 합쳐진다. */
export type SeasonAgg = BoxAgg & { seasonName: string; tcodes: string[]; gpReg: number; gpPo: number };

export function aggregateCareer(rows: CareerGameRow[]): { lines: SeasonTeamLine[]; seasonsAsc: SeasonAgg[] } {
  const bySeason = new Map<string, CareerGameRow[]>();
  for (const r of rows) (bySeason.get(r.seasonName) ?? bySeason.set(r.seasonName, []).get(r.seasonName)!).push(r);

  const lines: SeasonTeamLine[] = [];
  const seasonsAsc: SeasonAgg[] = [];
  for (const [seasonName, list] of bySeason) {
    const byTeam = new Map<string, CareerGameRow[]>();
    for (const r of list) (byTeam.get(r.tcode) ?? byTeam.set(r.tcode, []).get(r.tcode)!).push(r);
    for (const [tcode, trs] of byTeam) {
      lines.push({
        seasonName,
        tcode,
        lastDate: trs.reduce((m, r) => (r.gameDate > m ? r.gameDate : m), ""),
        all: aggBox(trs)!,
        reg: aggBox(trs.filter((r) => r.seasonCategory !== PLAYOFF_CATEGORY)),
        po: aggBox(trs.filter((r) => r.seasonCategory === PLAYOFF_CATEGORY)),
      });
    }
    const all = aggBox(list)!;
    // 팀 순서 = 그 시즌에 먼저 뛴 팀부터(시즌표 '이적' 칩의 읽기 순서).
    const tcodes = [...byTeam.entries()].sort((a, b) => (a[1].reduce((m, r) => (r.gameDate < m ? r.gameDate : m), "9") < b[1].reduce((m, r) => (r.gameDate < m ? r.gameDate : m), "9") ? -1 : 1)).map(([t]) => t);
    seasonsAsc.push({
      ...all,
      seasonName,
      tcodes,
      gpReg: list.filter((r) => r.seasonCategory !== PLAYOFF_CATEGORY).length,
      gpPo: list.filter((r) => r.seasonCategory === PLAYOFF_CATEGORY).length,
    });
  }
  lines.sort((a, b) => (a.seasonName !== b.seasonName ? (a.seasonName < b.seasonName ? 1 : -1) : a.lastDate < b.lastDate ? 1 : -1));
  seasonsAsc.sort((a, b) => (a.seasonName < b.seasonName ? -1 : 1));
  return { lines, seasonsAsc };
}

// ── 날짜/시즌 축 유틸 ────────────────────────────────────────────────────────────────────
export function seasonStartYear(season: string): number {
  return Number(season.slice(0, 4));
}

/** first~last 사이의 모든 시즌명("2019-2020" 꼴) - 커리어 아크의 공백 칸을 만들기 위해. */
export function buildSeasonAxis(first: string, last: string): string[] {
  const out: string[] = [];
  for (let y = seasonStartYear(first); y <= seasonStartYear(last); y++) out.push(`${y}-${y + 1}`);
  return out;
}

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** "2026-10-18" -> "일" (KST 날짜 문자열 그대로 - 시간대 변환 없음). */
export function weekdayKo(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return WEEKDAY_KO[d] ?? "";
}

/** "2026-10-18" -> "10.18" */
export function fmtMonthDay(dateStr: string): string {
  return `${dateStr.slice(5, 7)}.${dateStr.slice(8, 10)}`;
}

/** "14:00:00" -> "14:00" */
export function fmtTime(t: string | null): string {
  return t ? t.slice(0, 5) : "";
}
