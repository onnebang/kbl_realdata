import { supabaseServer as supabase } from "./supabaseServer";
import { PRESEASON_SEASON, isRealGmkey, type RosterChange, type TeamRosterChanges } from "./preseason";
import { getHeadToHead, type TeamFixture } from "./matchups";
import { normalizePos, type PlayerPos } from "./playerStatus";
import { UNIT_MIN_MINUTES_2MAN, UNIT_MIN_MINUTES_5MAN, ZONE_KEYS, type BestUnit, type RosterRow, type ZoneKey } from "./teamDataScience";

// 팀 프로필(app/teams/[tcode]) 1단계 개편의 페이지 전용 데이터 레이어. 공유 lib(preseason/
// matchups/seasonFocus/teamDataScience)는 계약이 고정돼 있어 손대지 않고, 이 페이지만 쓰는
// 조회·집계(프롤로그 사실, 로스터 월, 확정 명단 시드 베스트 유닛, 상대별 전적, 일정용 모델
// 승률·태그)를 여기에 모은다. 전부 SELECT + JS 집계이고 RPC·마이그레이션은 없다(1단계 원칙).

// ---------------------------------------------------------------------------
// 날짜·시각 표기(일정·상태 스트립·다음 장 공용)
// ---------------------------------------------------------------------------
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** "2026-10-03" -> "토" (날짜 문자열 자체의 요일 - KST 변환 불필요, 날짜만 있으므로 UTC 자정으로 계산). */
export function weekdayKo(date: string): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  return WEEKDAY_KO[d.getUTCDay()];
}

/** "2026-10-03" -> "10.03" */
export function fmtMd(date: string): string {
  return `${date.slice(5, 7)}.${date.slice(8, 10)}`;
}

/** "14:00:00" -> "14:00" (game_start 원문은 time without time zone). */
export function fmtStart(gameStart: string | null): string | null {
  return gameStart ? gameStart.slice(0, 5) : null;
}

/** "10.03(토) 14:00" - 시각이 없으면 날짜·요일만. */
export function fmtFixtureWhen(f: { gameDate: string; gameStart: string | null }): string {
  const t = fmtStart(f.gameStart);
  return `${fmtMd(f.gameDate)}(${weekdayKo(f.gameDate)})${t ? ` ${t}` : ""}`;
}

/** 홈 승률(pregame_features.home_win_prob)을 이 팀 기준으로. */
export function teamSideProb(homeWinProb: number | null | undefined, isHome: boolean): number | null {
  if (homeWinProb == null) return null;
  return isHome ? homeWinProb : 1 - homeWinProb;
}

// ---------------------------------------------------------------------------
// 예정 경기의 모델 승률·구장 넷레이팅(pregame_features) - 치른 경기의 경기 시작 시점 승률은
// lib/teamDataScience.ts getPregameProbs(game_events event_order=0)가 담당(실측: pregame_features는
// 2026-27 예정 127경기에만 있고 2025-26 치른 경기에는 0행).
// ---------------------------------------------------------------------------
export type PregameFeatureRow = {
  homeWinProb: number | null;
  homeVenueNetRtg: number | null;
  awayVenueNetRtg: number | null;
  homeNetRtg: number | null;
  awayNetRtg: number | null;
};

export async function getPregameFeatures(gmkeys: string[]): Promise<Map<string, PregameFeatureRow>> {
  const map = new Map<string, PregameFeatureRow>();
  for (let i = 0; i < gmkeys.length; i += 200) {
    const { data } = await supabase
      .from("pregame_features")
      .select("gmkey, home_win_prob, home_venue_netrtg, away_venue_netrtg, home_netrtg, away_netrtg")
      .in("gmkey", gmkeys.slice(i, i + 200));
    for (const r of data ?? []) {
      const n = (v: unknown) => (v == null ? null : Number(v));
      map.set(r.gmkey as string, {
        homeWinProb: n(r.home_win_prob),
        homeVenueNetRtg: n(r.home_venue_netrtg),
        awayVenueNetRtg: n(r.away_venue_netrtg),
        homeNetRtg: n(r.home_netrtg),
        awayNetRtg: n(r.away_netrtg),
      });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// 경기 성격 태그(game_summary_tags - 경기당 최대 1행, 실측 1,347행 = 1,347경기)
// ---------------------------------------------------------------------------
export type GameTagKey = "nailbiter" | "blowout" | "comeback";
export type GameTag = { key: GameTagKey; label: string; margin: number | null };
export const GAME_TAG_LABELS: Record<GameTagKey, string> = { nailbiter: "박빙", blowout: "압도", comeback: "역전" };
/** 태그 생성 기준(tools 측 규칙의 실측 요약 - 캡션용): 박빙 = 최종 |점수차| ≤ 3, 압도 = 큰 점수차, 역전 = 열세를 뒤집은 승리. */
export const GAME_TAG_CAPTION = "경기 성격 = game_summary_tags 3종(박빙 접전 |점수차| ≤ 3 · 압도적 승리 · 짜릿한 역전승) · 태그 없는 경기는 집계에서 제외";

export async function getGameTags(gmkeys: string[]): Promise<Map<string, GameTag>> {
  const map = new Map<string, GameTag>();
  for (let i = 0; i < gmkeys.length; i += 200) {
    const { data } = await supabase.from("game_summary_tags").select("gmkey, tag_key, tag_label, margin").in("gmkey", gmkeys.slice(i, i + 200));
    for (const r of data ?? []) {
      const key = r.tag_key as GameTagKey;
      if (!(key in GAME_TAG_LABELS)) continue;
      map.set(r.gmkey as string, { key, label: r.tag_label as string, margin: r.margin == null ? null : Number(r.margin) });
    }
  }
  return map;
}

/** 태그별 (경기 수, 그중 승리) - 프롤로그 '박빙 8경기 7승'용. */
export function tagRecord(fixtures: TeamFixture[], tags: Map<string, GameTag>): Record<GameTagKey, { n: number; w: number }> {
  const out: Record<GameTagKey, { n: number; w: number }> = { nailbiter: { n: 0, w: 0 }, blowout: { n: 0, w: 0 }, comeback: { n: 0, w: 0 } };
  for (const f of fixtures) {
    if (f.status !== "final" || f.teamScore == null || f.oppScore == null) continue;
    const t = tags.get(f.gmkey);
    if (!t) continue;
    out[t.key].n += 1;
    if (f.teamScore > f.oppScore) out[t.key].w += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 전적 집계(TeamFixture 배열에서 - 추가 쿼리 없음)
// ---------------------------------------------------------------------------
export type WinLoss = { w: number; l: number; gp: number; pts: number; opp: number };

export function computeRecord(fixtures: TeamFixture[], category: "정규시즌" | "all" = "정규시즌"): WinLoss {
  const r: WinLoss = { w: 0, l: 0, gp: 0, pts: 0, opp: 0 };
  for (const f of fixtures) {
    if (f.status !== "final" || f.teamScore == null || f.oppScore == null) continue;
    if (category !== "all" && f.seasonCategory !== category) continue;
    r.gp += 1;
    r.pts += f.teamScore;
    r.opp += f.oppScore;
    if (f.teamScore > f.oppScore) r.w += 1;
    else r.l += 1;
  }
  return r;
}

/** 상대별 정규시즌 W-L(일정표 위 요약 줄) - 상대 첫 등장 순. */
export function recordByOpponent(fixtures: TeamFixture[]): { oppTcode: string; oppName: string; w: number; l: number }[] {
  const map = new Map<string, { oppTcode: string; oppName: string; w: number; l: number }>();
  for (const f of fixtures) {
    if (f.status !== "final" || f.teamScore == null || f.oppScore == null || f.seasonCategory !== "정규시즌") continue;
    const row = map.get(f.oppTcode) ?? { oppTcode: f.oppTcode, oppName: f.oppName, w: 0, l: 0 };
    if (f.teamScore > f.oppScore) row.w += 1;
    else row.l += 1;
    map.set(f.oppTcode, row);
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// 리그 득점/실점 순위(프롤로그 '83.1 득점 / 84.3 실점 · 리그 N위') - 정규시즌 종료 경기만,
// games 한 시즌 ~270행 한 번으로 10팀 전부 계산(RPC의 pts_pg와 같은 정의: 경기당 평균).
// ---------------------------------------------------------------------------
export type LeagueScoring = { gp: number; ppg: number; oppPpg: number; ppgRank: number; oppRank: number; teamsN: number };

export async function getLeagueScoring(season: string): Promise<Map<string, LeagueScoring>> {
  const { data } = await supabase
    .from("games")
    .select("gmkey, home_tcode, away_tcode, home_score, away_score")
    .eq("season_name", season)
    .eq("season_category", "정규시즌")
    .eq("is_ended", true)
    .not("home_score", "is", null);
  const acc = new Map<string, { gp: number; pts: number; opp: number }>();
  const bump = (t: string, pts: number, opp: number) => {
    const cur = acc.get(t) ?? { gp: 0, pts: 0, opp: 0 };
    cur.gp += 1;
    cur.pts += pts;
    cur.opp += opp;
    acc.set(t, cur);
  };
  for (const g of data ?? []) {
    if (!isRealGmkey(g.gmkey as string)) continue;
    bump(g.home_tcode as string, g.home_score as number, g.away_score as number);
    bump(g.away_tcode as string, g.away_score as number, g.home_score as number);
  }
  const rows = [...acc.entries()].map(([tcode, a]) => ({ tcode, gp: a.gp, ppg: a.pts / a.gp, oppPpg: a.opp / a.gp }));
  const out = new Map<string, LeagueScoring>();
  for (const r of rows) {
    out.set(r.tcode, {
      gp: r.gp,
      ppg: r.ppg,
      oppPpg: r.oppPpg,
      // 득점은 많을수록 1위, 실점도 "많은 순" 1위(리그 최다 실점 = 1위) - 화면에서 '많은 순'이라고 명시한다.
      ppgRank: rows.filter((o) => o.ppg > r.ppg).length + 1,
      oppRank: rows.filter((o) => o.oppPpg > r.oppPpg).length + 1,
      teamsN: rows.length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 홈경기 사실(프롤로그 한 줄): 정규 홈 평균 관중(0·NULL 제외) + 홈경기 coach_id 최빈값의 감독명.
// 26-27 경기에는 coach_id·attendance가 없으므로(실측 0) 지난 시즌에만 의미가 있다.
// ---------------------------------------------------------------------------
export type HomeSeasonFacts = { avgAttendance: number | null; attendanceGames: number; coachName: string | null; coachGames: number; homeGames: number };

export async function getHomeSeasonFacts(tcode: string, season: string): Promise<HomeSeasonFacts> {
  const { data } = await supabase
    .from("games")
    .select("gmkey, attendance, home_coach_id")
    .eq("season_name", season)
    .eq("season_category", "정규시즌")
    .eq("home_tcode", tcode)
    .eq("is_ended", true);
  const rows = (data ?? []).filter((g) => isRealGmkey(g.gmkey as string));
  const att = rows.map((g) => Number(g.attendance ?? 0)).filter((a) => a > 0);
  const coachCount = new Map<number, number>();
  for (const g of rows) if (g.home_coach_id != null) coachCount.set(Number(g.home_coach_id), (coachCount.get(Number(g.home_coach_id)) ?? 0) + 1);
  let coachId: number | null = null,
    coachGames = 0;
  for (const [id, n] of coachCount) if (n > coachGames) (coachId = id), (coachGames = n);
  let coachName: string | null = null;
  if (coachId != null) {
    const { data: c } = await supabase.from("coaches").select("name").eq("coach_id", coachId).maybeSingle();
    coachName = (c?.name as string | undefined) ?? null;
  }
  return {
    avgAttendance: att.length ? Math.round(att.reduce((s, a) => s + a, 0) / att.length) : null,
    attendanceGames: att.length,
    coachName,
    coachGames,
    homeGames: rows.length,
  };
}

/** 이 팀이 실제로 경기한 마지막 시즌(해체 팀의 focusSeason 판정용). 없으면 null. */
export async function getTeamLastPlayedSeason(tcode: string): Promise<string | null> {
  const { data } = await supabase
    .from("games")
    .select("season_name")
    .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`)
    .not("home_score", "is", null)
    .order("season_name", { ascending: false })
    .limit(1);
  return (data?.[0]?.season_name as string | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// 확정 명단(season_roster) + 로스터 월
// ---------------------------------------------------------------------------
export type SeasonRosterRow = { pcode: string | null; name: string; backNum: string | null; pos: PlayerPos | null; note: string | null; source: string | null };

export async function getSeasonRoster(tcode: string, season: string): Promise<SeasonRosterRow[]> {
  const { data } = await supabase.from("season_roster").select("pcode, player_name, back_num, pos, note, source").eq("season_name", season).eq("tcode", tcode);
  return (data ?? []).map((r) => ({
    pcode: (r.pcode as string | null) || null,
    name: r.player_name as string,
    backNum: (r.back_num as string | null) || null,
    pos: normalizePos(r.pos as string | null),
    note: (r.note as string | null) ?? null,
    source: (r.source as string | null) ?? null,
  }));
}

export type PlayerWpaRow = { pcode: string; tcode: string; totalWpa: number; games: number };

/** 한 시즌의 개인 WPA(정규시즌 집계 - player_season_wpa.games = 정규 GP, 검증). 시즌 중 이적자는 팀별 행이 따로 온다. */
export async function getPlayerWpaRows(season: string, pcodes: string[]): Promise<PlayerWpaRow[]> {
  const out: PlayerWpaRow[] = [];
  for (let i = 0; i < pcodes.length; i += 200) {
    const { data } = await supabase.from("player_season_wpa").select("pcode, tcode, total_wpa, games").eq("season_name", season).in("pcode", pcodes.slice(i, i + 200));
    for (const r of data ?? []) {
      if (r.total_wpa == null) continue;
      out.push({ pcode: r.pcode as string, tcode: r.tcode as string, totalWpa: Number(r.total_wpa), games: Number(r.games ?? 0) });
    }
  }
  return out;
}

/** (pcode, 우선 팀) → WPA 행. 그 팀 행이 없으면 아무 행(시즌 중 이적자). */
export function pickWpa(rows: PlayerWpaRow[], pcode: string | null, preferTcode: string | null): PlayerWpaRow | null {
  if (!pcode) return null;
  const mine = rows.filter((r) => r.pcode === pcode);
  if (!mine.length) return null;
  return mine.find((r) => r.tcode === preferTcode) ?? mine[0];
}

type LastIdentity = { pos: PlayerPos | null; backNum: string | null; tcode: string; gameDate: string };

/** 외국인 행(season_roster.pos/back_num NULL - 실측 29명 전원)의 폴백: 그 선수의 prev_season 마지막 경기 pos·번호.
 *  시즌별로 묶어 한 번씩만 조회(복귀 선수는 prev_season이 다를 수 있음). */
async function fetchLastIdentity(bySeason: Map<string, string[]>): Promise<Map<string, LastIdentity>> {
  const out = new Map<string, LastIdentity>();
  await Promise.all(
    [...bySeason.entries()].map(async ([season, pcodes]) => {
      if (!pcodes.length) return;
      const { data } = await supabase
        .from("game_player_stats")
        .select("pcode, tcode, pos, back_num, games!inner(game_date)")
        .in("pcode", pcodes)
        .eq("games.season_name", season)
        .limit(1000);
      for (const r of data ?? []) {
        const g = r.games as unknown as { game_date: string } | { game_date: string }[] | null;
        const gameDate = (Array.isArray(g) ? g[0]?.game_date : g?.game_date) ?? "";
        const prev = out.get(r.pcode as string);
        if (prev && prev.gameDate >= gameDate) continue;
        out.set(r.pcode as string, { pos: normalizePos(r.pos as string | null), backNum: (r.back_num as string | null) || null, tcode: r.tcode as string, gameDate });
      }
    })
  );
  return out;
}

export type WallPlayer = {
  pcode: string | null;
  name: string;
  backNum: string | null;
  backNumAsLastSeason: boolean; // 확정 명단 번호가 아니라 지난 시즌 경기 번호(외국인 잔류)
  pos: PlayerPos | null;
  role: string | null; // 외국인 1옵션 / 2옵션 / 아시아쿼터
  change: RosterChange["change"] | null; // stay / in / new (out은 명단 밖이라 없음)
  isReturn: boolean; // in + note에 '복귀'
  prevTcode: string | null;
  prevSeason: string | null;
  gp: number | null;
  ppg: number | null;
  rpg: number | null;
  apg: number | null;
  mpg: number | null;
  prevMinutes: number; // 정렬 키 = prev_gp × prev_mpg(정규+PO 합산 - roster_changes 기준)
  wpa: number | null; // prevSeason 정규 WPA(player_season_wpa)
  wpaGames: number | null;
  registryNote: string | null; // season_roster.note 원문(등록상태 표기가 있을 때만)
  source: string | null;
  cur: { gp: number; minPg: number; ppg: number; wpa: number | null } | null; // 개막 후 이번 시즌 집계(RPC team_season_roster)
};

/**
 * 26-27 로스터 월 재료. season_roster 전원 × roster_changes(판정·지난 시즌 성적) × player_season_wpa(prevSeason 정규)
 * × (개막 후) team_season_roster 집계. 정렬은 페이지가 한다(지난 시즌 출전시간 순 / 개막 후 이번 시즌 출전시간 순).
 */
export async function getRosterWall(
  tcode: string,
  roster: SeasonRosterRow[],
  rc: TeamRosterChanges | null,
  prevSeason: string,
  contribution: RosterRow[]
): Promise<WallPlayer[]> {
  const changes = rc ? [...rc.stay, ...rc.in, ...rc.new] : [];
  const changeByName = new Map(changes.map((c) => [c.name, c]));
  const changeByPcode = new Map(changes.filter((c) => c.pcode).map((c) => [c.pcode as string, c]));
  const pcodes = roster.map((r) => r.pcode).filter((p): p is string => !!p);

  // 폴백이 필요한 행(pos 또는 번호 결측 + pcode 있음)을 prev_season별로 묶는다.
  const bySeason = new Map<string, string[]>();
  for (const r of roster) {
    if (!r.pcode || (r.pos && r.backNum)) continue;
    const c = changeByPcode.get(r.pcode) ?? changeByName.get(r.name);
    const season = c?.prevSeason ?? prevSeason;
    bySeason.set(season, [...(bySeason.get(season) ?? []), r.pcode]);
  }
  const [wpaRows, identity] = await Promise.all([getPlayerWpaRows(prevSeason, pcodes), fetchLastIdentity(bySeason)]);
  const curByPcode = new Map(contribution.map((c) => [c.pcode, c]));

  return roster.map((r) => {
    const c = (r.pcode ? changeByPcode.get(r.pcode) : undefined) ?? changeByName.get(r.name) ?? null;
    const last = r.pcode ? identity.get(r.pcode) : undefined;
    // 번호 폴백은 "같은 팀에서 뛴 마지막 경기"일 때만(팀이 바뀐 영입은 옛 번호를 달지 않는다 - 선수 스트립과 같은 규칙).
    const backFromLast = !r.backNum && last && last.tcode === tcode ? last.backNum : null;
    const wpa = pickWpa(wpaRows, r.pcode, c?.change === "in" ? (c.prevTcode ?? tcode) : tcode);
    const cur = r.pcode ? curByPcode.get(r.pcode) : undefined;
    return {
      pcode: r.pcode,
      name: r.name,
      backNum: r.backNum ?? backFromLast ?? null,
      backNumAsLastSeason: !r.backNum && !!backFromLast,
      pos: r.pos ?? last?.pos ?? null,
      role: c?.role ?? roleFromRosterNote(r.note),
      change: c?.change ?? (r.pcode ? null : "new"),
      isReturn: c?.change === "back",
      prevTcode: c?.prevTcode ?? null,
      prevSeason: c?.prevSeason ?? null,
      gp: c?.gp ?? null,
      ppg: c?.ppg ?? null,
      rpg: c?.rpg ?? null,
      apg: c?.apg ?? null,
      mpg: c?.mpg ?? null,
      prevMinutes: (c?.gp ?? 0) * (c?.mpg ?? 0),
      wpa: wpa?.totalWpa ?? null,
      wpaGames: wpa?.games ?? null,
      registryNote: r.note && r.note.includes("등록상태") ? r.note : null,
      source: r.source,
      cur: cur ? { gp: cur.gp, minPg: cur.minPg, ppg: cur.ppg, wpa: cur.totalWpa } : null,
    };
  });
}

/** season_roster.note 머리("외국인 1옵션 | …")의 역할 - lib/preseason.ts roleFromNote와 같은 규칙(순환 import 없이 로컬 복제). */
function roleFromRosterNote(note: string | null): string | null {
  const head = (note ?? "").split("|")[0].trim();
  return head && (head.includes("외국인") || head.includes("아시아")) ? head : null;
}

// ---------------------------------------------------------------------------
// 오프시즌 다이버징 바 - 이탈(왼쪽) / 영입·복귀(오른쪽), 길이 = prevSeason 정규 WPA, 두께 = 지난 시즌 출전시간
// ---------------------------------------------------------------------------
export type OffseasonBar = {
  name: string;
  pcode: string | null;
  side: "out" | "in";
  isReturn: boolean;
  wpa: number | null; // null = prevSeason 정규 기록 없음(복귀·신입) - 0이 아니라 '제외'
  minutes: number; // roster_changes prev_gp × prev_mpg(정규+PO 합산)
  prevSeason: string | null;
  fromTo: string | null; // '→ SAM' / '← MOB'
};

export function buildOffseasonBars(rc: TeamRosterChanges, wpaRows: PlayerWpaRow[], abbrOf: (t: string | null) => string | null): OffseasonBar[] {
  const rows: OffseasonBar[] = [];
  for (const r of rc.out) {
    const w = pickWpa(wpaRows, r.pcode, r.tcode);
    rows.push({
      name: r.name,
      pcode: r.pcode,
      side: "out",
      isReturn: false,
      wpa: w?.totalWpa ?? null,
      minutes: (r.gp ?? 0) * (r.mpg ?? 0),
      prevSeason: r.prevSeason,
      fromTo: r.nextTcode ? `→ ${abbrOf(r.nextTcode) ?? r.nextTcode}` : "리그 이탈",
    });
  }
  for (const r of rc.in) {
    const w = pickWpa(wpaRows, r.pcode, r.prevTcode ?? r.tcode);
    const ret = !!r.note?.includes("복귀");
    rows.push({
      name: r.name,
      pcode: r.pcode,
      side: "in",
      isReturn: ret,
      wpa: w?.totalWpa ?? null,
      minutes: (r.gp ?? 0) * (r.mpg ?? 0),
      prevSeason: r.prevSeason,
      fromTo: ret ? `${r.prevSeason ? r.prevSeason.slice(2, 4) + "-" + r.prevSeason.slice(7, 9) + " 이후 " : ""}복귀` : r.prevTcode ? `← ${abbrOf(r.prevTcode) ?? r.prevTcode}` : null,
    });
  }
  // 같은 쪽 안에서는 |WPA| 큰 순(기록 없는 선수는 뒤)
  rows.sort((a, b) => (a.side === b.side ? Math.abs(b.wpa ?? -1) - Math.abs(a.wpa ?? -1) : a.side === "out" ? -1 : 1));
  return rows;
}

// ---------------------------------------------------------------------------
// 베스트 유닛 - 확정 명단 시드(lineup_combo .containedBy) · RPC team_best_units 대체(1단계 마이그레이션 0건)
// lineup_combo는 15시즌 통산이고 시즌/팀 컬럼이 없다(스키마 실측) - 캡션에 명시. 검증(2026-09-03):
// KCC 26-27 명단 17 pcode → 2인 54 / 3인 96 / 5인 17 조합.
// ---------------------------------------------------------------------------
export const UNIT_MIN_MINUTES_3MAN = 30;
export type UnitEmptyReason = "no-roster" | "no-combo" | "below-min" | null;
export type RosterUnits = { units: BestUnit[]; reason: UnitEmptyReason };

export async function getBestUnitsFromRoster(pcodes: string[]): Promise<RosterUnits> {
  if (!pcodes.length) return { units: [], reason: "no-roster" };
  type Raw = { n: number; pcodes: string[]; minutes: string | number; net_rating_per40: string | number };
  const fetchN = async (n: number, minMinutes: number, limit: number) => {
    const { data } = await supabase
      .from("lineup_combo")
      .select("n, pcodes, minutes, net_rating_per40")
      .eq("n", n)
      .gte("minutes", minMinutes)
      .containedBy("pcodes", pcodes)
      .order("net_rating_per40", { ascending: false })
      .limit(limit);
    return (data ?? []) as Raw[];
  };
  const [pairs, trios, fives] = await Promise.all([fetchN(2, UNIT_MIN_MINUTES_2MAN, 4), fetchN(3, UNIT_MIN_MINUTES_3MAN, 2), fetchN(5, UNIT_MIN_MINUTES_5MAN, 2)]);
  const raw = [...pairs, ...trios, ...fives];
  if (!raw.length) {
    // 빈 원인 분리: 명단 선수 간 조합 자체가 없는지, 있는데 최소 출전시간 미달인지.
    const { data } = await supabase.from("lineup_combo").select("combo_key").containedBy("pcodes", pcodes).limit(1);
    return { units: [], reason: data && data.length ? "below-min" : "no-combo" };
  }
  const allP = [...new Set(raw.flatMap((r) => r.pcodes))];
  const { data: players } = await supabase.from("players").select("pcode, name").in("pcode", allP);
  const nameOf = new Map((players ?? []).map((p) => [p.pcode as string, p.name as string]));
  return {
    units: raw.map((r) => ({
      n: Number(r.n),
      pcodes: r.pcodes,
      names: r.pcodes.map((p) => nameOf.get(p) ?? p),
      minutes: Number(r.minutes),
      netRatingPer40: Number(r.net_rating_per40),
    })),
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// 상대별 전적(다음 장) - 지난 시즌 정규 W-L(fixtures) · 통산 H2H(getHeadToHead, 팀코드 기준) ·
// 이번 시즌 첫 맞대결(예정 fixtures) · 이번 시즌 W-L(치른 뒤).
// ---------------------------------------------------------------------------
export type OpponentRecord = {
  oppTcode: string;
  oppName: string;
  prev: { w: number; l: number };
  cur: { w: number; l: number };
  h2h: { w: number; l: number; n: number };
  first: TeamFixture | null; // 이번 시즌 첫 맞대결(치렀든 예정이든)
  nextVs: TeamFixture | null; // 아직 안 치른 첫 맞대결
};

export async function getOpponentRecords(tcode: string, focusFixtures: TeamFixture[], prevFixtures: TeamFixture[]): Promise<OpponentRecord[]> {
  const opps = [...new Set(focusFixtures.map((f) => f.oppTcode))];
  const h2hs = await Promise.all(opps.map((o) => getHeadToHead(tcode, o, "9999-12-31")));
  const rows = opps.map((o, i) => {
    const prev = prevFixtures.filter((f) => f.oppTcode === o);
    const cur = focusFixtures.filter((f) => f.oppTcode === o);
    const pr = computeRecord(prev, "정규시즌");
    const cr = computeRecord(cur, "정규시즌");
    const h = h2hs[i];
    return {
      oppTcode: o,
      oppName: cur[0]?.oppName ?? o,
      prev: { w: pr.w, l: pr.l },
      cur: { w: cr.w, l: cr.l },
      h2h: { w: h.homeWins, l: h.awayWins, n: h.meetings },
      first: cur[0] ?? null,
      nextVs: cur.find((f) => f.status !== "final") ?? null,
    };
  });
  rows.sort((a, b) => (a.first?.gameDate ?? "").localeCompare(b.first?.gameDate ?? ""));
  return rows;
}

// ---------------------------------------------------------------------------
// xPTS/시도 - xpts_zone_table(리그 15시즌 존별 기대 득점) × 팀 존 구성비. 실제 득점이 아니라
// "슛 선택의 기대값"(난이도·슈터 미반영) - 캡션 필수.
// ---------------------------------------------------------------------------
export async function getXptsPerShot(): Promise<Record<ZoneKey, number> | null> {
  const { data } = await supabase.from("xpts_zone_table").select("zone, expected_pts_per_shot");
  if (!data || !data.length) return null;
  const out = {} as Record<ZoneKey, number>;
  for (const r of data) {
    const z = r.zone as ZoneKey;
    if (ZONE_KEYS.includes(z)) out[z] = Number(r.expected_pts_per_shot);
  }
  return ZONE_KEYS.every((z) => out[z] != null) ? out : null;
}

// ---------------------------------------------------------------------------
// 확정 명단 시즌의 '이 팀이 치른 경기 수'와 개막 여부는 fixtures에서 바로 읽는다(팀 단위 게이트).
// ---------------------------------------------------------------------------
export function splitFixtures(fixtures: TeamFixture[]) {
  const played = fixtures.filter((f) => f.status === "final");
  const live = fixtures.find((f) => f.status === "live") ?? null;
  const next = fixtures.find((f) => f.status !== "final") ?? null; // live 포함(진행 중이면 그 경기가 '다음')
  const remaining = fixtures.filter((f) => f.status === "scheduled");
  const lastDate = fixtures.length ? fixtures[fixtures.length - 1].gameDate : null;
  const lastPlayed = played.length ? played[played.length - 1] : null;
  return { played, live, next, remaining, lastDate, lastPlayed };
}

export { PRESEASON_SEASON };
