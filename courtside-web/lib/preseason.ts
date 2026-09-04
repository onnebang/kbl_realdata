import { supabase } from "./supabase";
import { displayTeamName } from "./teamNames";
import { getPlayerCareerGames, type CareerGameRow } from "./playerProfile";

// 개막 전 리포트(/preseason) 데이터 - 요청: "이적생들로 인해서 팀이 많이 변경이 되었을텐데 그
// 부분에 대해서도 리포트가 필요... 시즌 시작전 리포트를 먼저 제공하고, 실제 시즌이 시작되면
// 실제 경기가 보일 수 있게, 그동안은 실제경기 10경기정도만 테스트로 보여주고, 이렇게 중계가
// 보일거다라는것을 알려주면".
//
// 세 가지 재료 전부 이미 DB에 있는 것만 쓴다(새 모델/새 집계 없음):
//   1. 시즌 전망  - tools/sync_upcoming_games.py가 예정 경기마다 넣어둔 pregame_features.
//                  home_win_prob(경기 전 모델)을 팀별로 합산한 "기대승수". 이 모델은 지난 시즌
//                  전력(넷레이팅/시너지/홈코트)으로 계산되므로 로스터 변화는 아직 안 들어가
//                  있다 - 페이지 캡션에 그대로 적는다(데이터 정직성 원칙).
//   2. 로스터 변화 - tools/build_roster_changes.py가 season_roster(확정 로스터) x 지난 시즌
//                  출전 기록으로 재생성하는 roster_changes(잔류/영입/이탈/신입 + 지난 시즌 성적).
//   3. 데모 경기  - 지난 시즌 실제 경기 10개를 골라 "개막하면 이렇게 보입니다"로 안내.
//                  gmkey는 상수, 스코어/팀/태그는 렌더 시 DB에서(하드코딩된 숫자 없음).

export const PRESEASON_SEASON = "2026-2027";

export function prevSeasonName(season: string): string {
  const [a, b] = season.split("-").map(Number);
  return `${a - 1}-${b - 1}`;
}

/** "2025-2026" -> "25-26" */
export function shortSeason(season: string): string {
  const [a, b] = season.split("-");
  return `${a.slice(2)}-${b.slice(2)}`;
}

// 실제 KBL gmkey는 "S47G01N174"처럼 S로 시작한다. 라이브 드라이런/시뮬레이터가 넣는
// 합성 경기(P2LIVE-/DRYRUN-/ZZTEST-)는 같은 시즌에 예정 경기로 섞여 들어오므로 일정 집계에서
// 제외(실측: 2026-09-02자 P2LIVE 경기가 "개막일"로 잡혔음). 프로필의 일정·다음 경기 조회
// (lib/matchups.ts getTeamSeasonFixtures/getTeamNextGame)도 같은 가드를 쓰도록 export.
export function isRealGmkey(gmkey: string): boolean {
  return /^S\d/.test(gmkey);
}

/** 개막까지 남은 날(KST) - lib/homeGames.ts의 컷오프 계산과 같은 방식(UTC+9를 더한 뒤 날짜만). */
export function daysUntilKst(dateStr: string): number {
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const a = Date.UTC(+todayKst.slice(0, 4), +todayKst.slice(5, 7) - 1, +todayKst.slice(8, 10));
  const b = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/** 홈 배너용 경량 조회 - 이 시즌 실제 첫 경기 날짜와 예정 경기 수(승률 조회 없음).
 *
 * 리그 전체에 이미 치른 경기가 하나라도 있으면 null(= 개막 전이 아님). 홈 화면의 렌더 조건은
 * 팀 필터가 걸린 목록을 보기 때문에, "그 팀만 아직 안 뛰었을 뿐인 시즌 중반"을 개막 전으로
 * 오인할 수 있다(실측: 창원 LG의 첫 경기는 2026-10-18이라 10/10에 팀 필터를 걸면 종료 경기가
 * 0건 → "개막까지 개막 7일째"라는 모순된 배너가 떴음). 개막 여부는 필터와 무관한 리그 전체
 * 기준이어야 하므로 그 판정을 이 함수 안으로 옮긴다.
 */
export async function getSeasonOpener(season: string): Promise<{ firstGameDate: string; nGames: number } | null> {
  const { data } = await supabase.from("games").select("gmkey, game_date, home_score").eq("season_name", season).order("game_date");
  const real = (data ?? []).filter((g) => isRealGmkey(g.gmkey as string));
  if (!real.length) return null;
  if (real.some((g) => g.home_score != null)) return null; // 이미 개막함
  return { firstGameDate: real[0].game_date as string, nGames: real.length };
}

export type TeamInfo = { tcode: string; name: string; abbr: string; color: string; logoUrl: string | null };

export async function getTeams(season: string): Promise<Map<string, TeamInfo>> {
  const { data } = await supabase.from("teams").select("tcode, name, abbr, color, logo_url");
  return new Map(
    (data ?? []).map((t) => [
      t.tcode as string,
      {
        tcode: t.tcode as string,
        // 연고지 개명(전주 KCC -> 부산 KCC)은 이 시즌 기준 표기로.
        name: displayTeamName(t.tcode as string, t.name as string, season),
        abbr: t.abbr as string,
        color: (t.color as string) ?? "#888888",
        logoUrl: (t.logo_url as string | null) ?? null,
      },
    ])
  );
}

// ---------------------------------------------------------------------------
// 1. 시즌 전망 - 팀별 기대승수(경기 전 모델 승률 합산) vs 지난 시즌 정규시즌 성적
// ---------------------------------------------------------------------------
export type TeamOutlook = TeamInfo & {
  gp: number; // 승률이 있는 예정 경기 수(= 기대승수의 분모)
  expWins: number;
  expPct: number; // 0~1
  prevW: number;
  prevL: number;
  prevPct: number | null;
};

export type SeasonOutlook = {
  season: string;
  prevSeason: string;
  firstGameDate: string | null;
  lastGameDate: string | null;
  nGames: number;
  // 승률이 실제로 매겨진 경기 수. nGames와 다를 수 있고(모델이 아직 값을 못 낸 경기), 캡션은
  // 반드시 이쪽을 써야 한다 - "예정 N경기 각각에 매긴 승률"이라고 nGames로 말하면 값이 없는
  // 경기까지 매긴 것처럼 과장된다(실측 지적).
  nPriced: number;
  teams: TeamOutlook[];
};

export async function getSeasonOutlook(season = PRESEASON_SEASON): Promise<SeasonOutlook> {
  const prevSeason = prevSeasonName(season);
  const [teams, schedRes, prevRes] = await Promise.all([
    getTeams(season),
    supabase.from("games").select("gmkey, game_date, home_tcode, away_tcode").eq("season_name", season).order("game_date"),
    supabase
      .from("games")
      .select("home_tcode, away_tcode, home_score, away_score")
      .eq("season_name", prevSeason)
      .eq("is_ended", true)
      .eq("season_category", "정규시즌"),
  ]);
  const sched = (schedRes.data ?? []).filter((g) => isRealGmkey(g.gmkey as string));

  const probs = new Map<string, number>();
  for (let i = 0; i < sched.length; i += 200) {
    const chunk = sched.slice(i, i + 200).map((g) => g.gmkey as string);
    const { data } = await supabase.from("pregame_features").select("gmkey, home_win_prob").in("gmkey", chunk);
    for (const r of data ?? []) if (r.home_win_prob != null) probs.set(r.gmkey as string, Number(r.home_win_prob));
  }

  const acc = new Map<string, { gp: number; exp: number }>();
  const bump = (tcode: string, p: number) => {
    const cur = acc.get(tcode) ?? { gp: 0, exp: 0 };
    cur.gp += 1;
    cur.exp += p;
    acc.set(tcode, cur);
  };
  for (const g of sched) {
    const p = probs.get(g.gmkey as string);
    if (p == null) continue; // 승률 없는 경기는 분자·분모 모두에서 제외(기대승수 분모와 일치)
    bump(g.home_tcode as string, p);
    bump(g.away_tcode as string, 1 - p);
  }

  const rec = new Map<string, { w: number; l: number }>();
  for (const g of prevRes.data ?? []) {
    const hs = g.home_score as number,
      as = g.away_score as number;
    if (hs == null || as == null || hs === as) continue;
    const h = rec.get(g.home_tcode as string) ?? { w: 0, l: 0 };
    const a = rec.get(g.away_tcode as string) ?? { w: 0, l: 0 };
    if (hs > as) {
      h.w++;
      a.l++;
    } else {
      h.l++;
      a.w++;
    }
    rec.set(g.home_tcode as string, h);
    rec.set(g.away_tcode as string, a);
  }

  const rows: TeamOutlook[] = [];
  for (const [tcode, { gp, exp }] of acc) {
    const team = teams.get(tcode);
    if (!team || gp === 0) continue;
    const r = rec.get(tcode);
    rows.push({
      ...team,
      gp,
      expWins: exp,
      expPct: exp / gp,
      prevW: r?.w ?? 0,
      prevL: r?.l ?? 0,
      prevPct: r && r.w + r.l > 0 ? r.w / (r.w + r.l) : null,
    });
  }
  rows.sort((a, b) => b.expPct - a.expPct);

  return {
    season,
    prevSeason,
    firstGameDate: sched.length ? (sched[0].game_date as string) : null,
    lastGameDate: sched.length ? (sched[sched.length - 1].game_date as string) : null,
    nGames: sched.length,
    nPriced: sched.filter((g) => probs.has(g.gmkey as string)).length,
    teams: rows,
  };
}

// ---------------------------------------------------------------------------
// 2. 로스터 변화 - roster_changes(파생 테이블) 그대로 + 팀별 그룹핑 + 헤드라인
// ---------------------------------------------------------------------------
// back(복귀) = 지난 시즌 KBL 기록이 없고 그 전엔 있는 선수. 요청("군대갔다가 복귀한 선수를
// 영입이라고 체크가 되어있더라고 ... 군대전역이나 부상복귀는 복귀라고 체크")대로 in(이적)에서
// 떼어냈다. 군 전역인지 부상 복귀인지는 KBL 기록 어디에도 없어 구분하지 않는다 - 공백 시즌
// 수만 note가 들고 있다(tools/build_roster_changes.py).
export type ChangeKind = "stay" | "in" | "back" | "out" | "new";

export type RosterChange = {
  /** 이 판정이 속한 시즌("2026-2027") - 복귀 공백 계산이 상수에 묶이지 않도록 행이 직접 들고 다닌다. */
  season: string;
  tcode: string;
  pcode: string | null;
  name: string;
  change: ChangeKind;
  role: string | null; // 외국인 1옵션 / 2옵션 / 아시아쿼터 / null(국내)
  prevTcode: string | null;
  nextTcode: string | null;
  prevSeason: string | null; // 아래 성적이 어느 시즌 것인지(복귀 선수는 지난 시즌이 아닐 수 있음)
  gp: number | null;
  ppg: number | null;
  rpg: number | null;
  apg: number | null;
  mpg: number | null;
  note: string | null;
  /** 이탈 사유(roster_departure에서 확인된 경우에만). military/overseas/unsigned/retired/other. */
  reason: string | null;
};

export type TeamRosterChanges = {
  team: TeamInfo;
  in: RosterChange[];
  back: RosterChange[];
  new: RosterChange[];
  stay: RosterChange[];
  out: RosterChange[];
};

export type RosterMove = { name: string; pcode: string | null; from: TeamInfo; to: TeamInfo; ppg: number | null };

export type RosterChangeReport = {
  season: string;
  prevSeason: string;
  teams: TeamRosterChanges[];
  moves: RosterMove[]; // 팀 간 이동(옛 팀 'out' + 새 팀 'in'이 같은 선수)
  topIn: (RosterChange & { team: TeamInfo }) | null; // 지난 시즌 득점 기준 최대 영입
  topOut: (RosterChange & { team: TeamInfo }) | null; // 지난 시즌 득점 기준 최대 이탈
  counts: Record<ChangeKind, number>;
  hasData: boolean; // 이 시즌 roster_changes 행이 하나라도 있는가(없으면 대조 자체를 안 한 것)
  // 국내 선수 로스터가 아직 안 들어온 팀들의 약어. 로스터는 팀별로 들어오므로 리그 전체를
  // 하나의 불리언으로 말하면, 한 팀만 입력돼도 나머지 아홉 팀의 "국내 미입력" 단서가 통째로
  // 사라진다(실측 지적) - 그래서 팀 목록으로 들고 다닌다.
  domesticPendingTeams: string[];
  domesticPending: boolean; // = domesticPendingTeams.length > 0
};

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function getRosterChangeReport(season = PRESEASON_SEASON): Promise<RosterChangeReport> {
  const prevSeason = prevSeasonName(season);
  const [teams, res] = await Promise.all([
    getTeams(season),
    supabase.from("roster_changes").select("*").eq("season_name", season).order("prev_ppg", { ascending: false, nullsFirst: false }),
  ]);
  const rows: RosterChange[] = (res.data ?? []).map((r) => ({
    season: r.season_name as string,
    tcode: r.tcode as string,
    pcode: (r.pcode as string | null) ?? null,
    name: r.player_name as string,
    change: r.change as ChangeKind,
    role: (r.role as string | null) ?? null,
    prevTcode: (r.prev_tcode as string | null) ?? null,
    nextTcode: (r.next_tcode as string | null) ?? null,
    prevSeason: (r.prev_season_name as string | null) ?? null,
    gp: num(r.prev_gp),
    ppg: num(r.prev_ppg),
    rpg: num(r.prev_rpg),
    apg: num(r.prev_apg),
    mpg: num(r.prev_mpg),
    note: (r.note as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
  }));

  const byTeam = new Map<string, TeamRosterChanges>();
  for (const team of teams.values()) byTeam.set(team.tcode, { team, in: [], back: [], new: [], stay: [], out: [] });
  for (const r of rows) byTeam.get(r.tcode)?.[r.change].push(r);

  // 로스터가 실제로 들어온 팀만(행이 하나도 없는 팀 - 해체된 옛 팀코드 등 - 은 제외), 약어순.
  const teamList = [...byTeam.values()]
    .filter((t) => t.in.length + t.back.length + t.new.length + t.stay.length + t.out.length > 0)
    .sort((a, b) => a.team.abbr.localeCompare(b.team.abbr));

  const moves: RosterMove[] = [];
  for (const r of rows) {
    if (r.change !== "in" || !r.prevTcode || r.prevTcode === r.tcode) continue; // 같은 팀 복귀는 이동이 아님
    if (r.prevSeason !== prevSeason) continue; // 지난 시즌에 실제로 다른 팀에 있었던 경우만
    const from = teams.get(r.prevTcode),
      to = teams.get(r.tcode);
    if (from && to) moves.push({ name: r.name, pcode: r.pcode, from, to, ppg: r.ppg });
  }
  moves.sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0));

  const withTeam = (r: RosterChange) => ({ ...r, team: teams.get(r.tcode)! });
  const ins = rows.filter((r) => r.change === "in" && r.ppg != null && teams.has(r.tcode));
  const outs = rows.filter((r) => r.change === "out" && r.ppg != null && teams.has(r.tcode));
  const counts: Record<ChangeKind, number> = { stay: 0, in: 0, back: 0, out: 0, new: 0 };
  for (const r of rows) counts[r.change]++;

  // 국내 선수가 한 명도 없는(= role 태그가 붙지 않은 잔류/영입/신입 행이 없는) 팀 = 그 팀의
  // 국내 로스터는 아직 미입력. import_roster.py가 외국인 행에만 "외국인 1옵션/2옵션/
  // 아시아쿼터"를 role로 남기므로 role == null 이 곧 국내 선수라는 신호다.
  const domesticPendingTeams = teamList
    .filter((t) => ![...t.in, ...t.back, ...t.new, ...t.stay].some((r) => r.role == null))
    .map((t) => t.team.abbr);

  return {
    season,
    prevSeason,
    teams: teamList,
    moves,
    topIn: ins.length ? withTeam(ins[0]) : null,
    topOut: outs.length ? withTeam(outs[0]) : null,
    counts,
    hasData: rows.length > 0,
    domesticPendingTeams,
    domesticPending: domesticPendingTeams.length > 0,
  };
}

/** 팀 프로필용 - 한 팀의 이번 시즌 로스터 변화(행이 없으면 null: 로스터 미수신 시즌/과거 시즌). */
export async function getTeamRosterChanges(season: string, tcode: string): Promise<TeamRosterChanges | null> {
  const report = await getRosterChangeReport(season);
  return report.teams.find((t) => t.team.tcode === tcode) ?? null;
}

// ---------------------------------------------------------------------------
// 선수 디렉터리(/players) - 이 시즌 확정 로스터(season_roster) 전체를 팀별로. 사진은 players,
// 지난 시즌 성적과 잔류/영입/신입 구분은 roster_changes에서. 국내 선수는 KBL 명부(tools/
// fetch_kbl_roster.py)에서, 외국인은 확정 명단에서 왔다는 출처 차이가 note에 남아 있다.
// ---------------------------------------------------------------------------
export type DirectoryPlayer = {
  pcode: string | null; // null = 아직 KBL 출전 기록이 없는 신입(첫 경기 때 자동 연결)
  name: string;
  backNum: string | null;
  pos: string | null;
  role: string | null; // 외국인 1옵션 / 2옵션 / 아시아쿼터 / null(국내)
  registryStatus: string | null; // KBL 명부 상태가 현역(A)이 아닌 경우의 표기(군복무·육성 추정)
  /** 이 시즌에 뛰지 않는 것이 확인된 경우(roster_departure). 명부에는 남아 있어도 전력이 아니다. */
  departure: { reason: string; label: string; detail: string | null } | null;
  photoUrl: string | null;
  change: ChangeKind | null;
  prevSeason: string | null;
  gp: number | null;
  ppg: number | null;
};
export type DirectoryTeam = { team: TeamInfo; players: DirectoryPlayer[] };

/** roster_departure.reason -> 화면 문구. components/RosterChangeLine.tsx의 REASON_TEXT와 같은 표. */
export const DEPARTURE_LABEL: Record<string, string> = {
  military: "군 입대",
  overseas: "해외 진출",
  unsigned: "FA 미계약",
  retired: "은퇴",
  other: "이탈",
};

/** season_roster.note의 머리("외국인 1옵션 | ...")에서 역할만. 국내 선수는 null. lib/playerStatus.ts도 같은 규칙을 쓴다. */
export function roleFromNote(note: string | null): string | null {
  const head = (note ?? "").split("|")[0].trim();
  return head && (head.includes("외국인") || head.includes("아시아")) ? head : null;
}

export async function getSeasonDirectory(season = PRESEASON_SEASON): Promise<DirectoryTeam[]> {
  const [teams, rosterRes, changesRes, departureRes] = await Promise.all([
    getTeams(season),
    supabase.from("season_roster").select("tcode, pcode, player_name, back_num, pos, note").eq("season_name", season),
    supabase
      .from("roster_changes")
      .select("tcode, pcode, player_name, change, prev_season_name, prev_gp, prev_ppg")
      .eq("season_name", season)
      .neq("change", "out"),
    // 명부에는 남아 있지만 이 시즌엔 못 뛰는 선수. 없으면 빈 목록이라 화면은 예전과 같다.
    supabase.from("roster_departure").select("pcode, reason, detail").eq("season_name", season),
  ]);
  const departureByPcode = new Map<string, { reason: string; label: string; detail: string | null }>();
  for (const d of departureRes.data ?? []) {
    const reason = d.reason as string;
    departureByPcode.set(d.pcode as string, {
      reason,
      label: DEPARTURE_LABEL[reason] ?? "이탈",
      detail: (d.detail as string | null) ?? null,
    });
  }
  const roster = rosterRes.data ?? [];
  const changeByKey = new Map<string, { change: ChangeKind; prevSeason: string | null; gp: number | null; ppg: number | null }>();
  for (const c of changesRes.data ?? []) {
    changeByKey.set(`${c.tcode}|${c.player_name}`, {
      change: c.change as ChangeKind,
      prevSeason: (c.prev_season_name as string | null) ?? null,
      gp: num(c.prev_gp),
      ppg: num(c.prev_ppg),
    });
  }

  const pcodes = [...new Set(roster.map((r) => r.pcode as string | null).filter((p): p is string => !!p))];
  const photo = new Map<string, string | null>();
  for (let i = 0; i < pcodes.length; i += 200) {
    const { data } = await supabase.from("players").select("pcode, photo_url").in("pcode", pcodes.slice(i, i + 200));
    for (const p of data ?? []) photo.set(p.pcode as string, (p.photo_url as string | null) ?? null);
  }

  const byTeam = new Map<string, DirectoryTeam>();
  for (const r of roster) {
    const team = teams.get(r.tcode as string);
    if (!team) continue;
    const entry = byTeam.get(team.tcode) ?? { team, players: [] };
    const note = (r.note as string | null) ?? null;
    const ch = changeByKey.get(`${r.tcode}|${r.player_name}`);
    entry.players.push({
      pcode: (r.pcode as string | null) ?? null,
      name: r.player_name as string,
      backNum: (r.back_num as string | null) || null,
      pos: (r.pos as string | null) || null,
      role: roleFromNote(note),
      // 이탈이 확인된 선수는 명부 상태를 "추정"으로 말하지 않는다 - 이제 사유를 안다.
      registryStatus:
        r.pcode && departureByPcode.has(r.pcode as string)
          ? null
          : note && note.includes("등록상태")
            ? "등록상태 별도(군복무·육성 추정)"
            : null,
      departure: r.pcode ? (departureByPcode.get(r.pcode as string) ?? null) : null,
      photoUrl: r.pcode ? (photo.get(r.pcode as string) ?? null) : null,
      change: ch?.change ?? null,
      prevSeason: ch?.prevSeason ?? null,
      gp: ch?.gp ?? null,
      ppg: ch?.ppg ?? null,
    });
    byTeam.set(team.tcode, entry);
  }
  // 등번호 순(없으면 뒤로), 같은 번호면 이름순
  const numKey = (b: string | null) => (b && /^\d+$/.test(b) ? parseInt(b, 10) : 999);
  for (const t of byTeam.values()) t.players.sort((a, b) => numKey(a.backNum) - numKey(b.backNum) || a.name.localeCompare(b.name));
  return [...byTeam.values()].sort((a, b) => a.team.abbr.localeCompare(b.team.abbr));
}

/** 프리뷰 인사이트 게이트용 - 팀별 "이미 떠난" 선수 pcode(직전 시즌 경기에서 뽑힌 선수를 걸러낼 때). */
export async function getDepartedByTeam(season = PRESEASON_SEASON): Promise<Map<string, Set<string>>> {
  const { data } = await supabase.from("roster_changes").select("tcode, pcode").eq("season_name", season).eq("change", "out").not("pcode", "is", null);
  const map = new Map<string, Set<string>>();
  for (const r of data ?? []) {
    const set = map.get(r.tcode as string) ?? new Set<string>();
    set.add(r.pcode as string);
    map.set(r.tcode as string, set);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 3. 데모 경기 - 지난 시즌 실제 경기 10개. 선정 근거는 전부 DB에서 확인한 사실(연장 여부는
//    game_events 쿼터 라벨 X1/X2, 태그는 game_summary_tags, 점수/합계는 games).
// ---------------------------------------------------------------------------
export const DEMO_GAMES: { gmkey: string; why: string }[] = [
  { gmkey: "S47G03N18", why: "플레이오프 최종전 - 시즌의 마지막 경기, 3막(경기전·경기중·경기후) 전부 열린 상태" },
  { gmkey: "S47G01N1", why: "지난 시즌 개막전 - 연장까지 간 첫 경기" },
  { gmkey: "S47G01N238", why: "2차 연장 2점차 - 승률 곡선이 끝까지 요동치는 접전" },
  { gmkey: "S47G01N195", why: "연장 끝 역전승, 양 팀 모두 100점 이상" },
  { gmkey: "S47G01N78", why: "연장 1점차 역전승" },
  { gmkey: "S47G01N174", why: "45점차 압도적 승리 - 승률이 일찍 굳는 경기는 어떻게 보이는지" },
  { gmkey: "S47G01N177", why: "2차 연장, 시즌 최다 합계 득점(211점)" },
  { gmkey: "S47G03N11", why: "플레이오프 역전승" },
  // "최대 점수차"는 뒤집은 점수차가 아니라 최종 점수차 기준(역전승 태그가 붙은 19경기 중 12점이
  // 최대). 그냥 "최대 점수차 역전승"이라고 쓰면 뒤집은 열세 폭으로 읽힐 수 있어 기준을 명시함.
  { gmkey: "S47G01N189", why: "역전승 중 최종 점수차가 가장 컸던 경기(12점 차)" },
  { gmkey: "S47G01N175", why: "연장 2점차 접전" },
];

export type DemoGame = {
  gmkey: string;
  why: string;
  gameDate: string;
  seasonCategory: string;
  home: TeamInfo | null;
  away: TeamInfo | null;
  homeScore: number | null;
  awayScore: number | null;
  tag: { key: string; label: string } | null;
};

export async function getDemoGames(): Promise<DemoGame[]> {
  const gmkeys = DEMO_GAMES.map((d) => d.gmkey);
  const [gamesRes, tagsRes] = await Promise.all([
    supabase.from("games").select("gmkey, game_date, season_name, season_category, home_tcode, away_tcode, home_score, away_score").in("gmkey", gmkeys),
    supabase.from("game_summary_tags").select("gmkey, tag_key, tag_label").in("gmkey", gmkeys),
  ]);
  const games = new Map((gamesRes.data ?? []).map((g) => [g.gmkey as string, g]));
  const tags = new Map((tagsRes.data ?? []).map((t) => [t.gmkey as string, { key: t.tag_key as string, label: t.tag_label as string }]));
  // 팀 표기는 그 경기가 열린 시즌 기준(개명 규칙과 동일).
  const firstSeason = (gamesRes.data?.[0]?.season_name as string | undefined) ?? prevSeasonName(PRESEASON_SEASON);
  const teams = await getTeams(firstSeason);

  const out: DemoGame[] = [];
  for (const d of DEMO_GAMES) {
    const g = games.get(d.gmkey);
    if (!g) continue; // DB에 없는 경기는 조용히 제외(잘못된 카드보다 빈 자리가 낫다)
    out.push({
      gmkey: d.gmkey,
      why: d.why,
      gameDate: g.game_date as string,
      seasonCategory: g.season_category as string,
      home: teams.get(g.home_tcode as string) ?? null,
      away: teams.get(g.away_tcode as string) ?? null,
      homeScore: (g.home_score as number | null) ?? null,
      awayScore: (g.away_score as number | null) ?? null,
      tag: tags.get(d.gmkey) ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. 프로필 개편 1단계 - 선수 "이 상대와의 나", 팀 "출전시간 잔류율", 경기 전 모델 승률
// ---------------------------------------------------------------------------

export type VsOpponentMeeting = {
  gmkey: string;
  gameDate: string;
  seasonName: string;
  seasonCategory: string;
  isHome: boolean;
  teamScore: number;
  oppScore: number;
  won: boolean;
  pts: number;
  reb: number;
  ast: number;
};

export type VsOpponentCareer = {
  oppTcode: string;
  gp: number; // 스코어가 있는(종료된) + 실제 출전(0분 DNP 제외) 경기만 - "vs 소노 21경기"처럼 항상 표본과 함께 표기
  dnp: number; // 명단엔 있었지만 0분이었던 맞대결 수(평균에서 제외한 이유를 캡션에 쓸 수 있도록)
  ppg: number;
  rpg: number;
  apg: number;
  tsPct: number | null; // PTS / (2·(FGA+TPA+0.44·FTA)) - fga는 2점 시도만이라 tpa를 더함(lib/playerProfile.ts 관례)
  teamW: number; // 선수 소속팀의 승패(선수 개인 승패가 아님 - 캡션 '팀 13-8')
  teamL: number;
  last3: VsOpponentMeeting[]; // 최근 맞대결 3경기, 최신순
};

/**
 * 커리어 전 경기 중 한 상대(oppTcode)와의 통산 라인 + 최근 3경기. 상대 팀코드 기준이라 팀명이
 * 바뀐 같은 프랜차이즈(전주→부산 KCC, tcode 60 동일)는 이어지고, 다른 팀코드(오리온스 30 →
 * 캐롯 73 → 소노 66)는 잇지 않는다(사실 그대로). 페이지가 이미 getPlayerCareerGames 행을 갖고
 * 있으면 careerRows로 넘겨 재조회를 피한다. 0분(DNP) 행은 평균을 깎기만 하므로 제외하고 dnp로
 * 센다(실측: 국내 베테랑의 최근 맞대결 3경기가 전부 0P 0R 0A인 DNP 행으로 나왔음). 출전 맞대결이
 * 없으면 null.
 * 검증(2026-09-03): 워니(291248) vs 소노(66) = 21G 20.7P 11.6R 5.0A · TS .504 · 팀 13-8.
 */
export async function getPlayerVsOpponentCareer(pcode: string, oppTcode: string, careerRows?: CareerGameRow[]): Promise<VsOpponentCareer | null> {
  const all = careerRows ?? (await getPlayerCareerGames(pcode));
  const ended = all.filter((r) => r.oppTcode === oppTcode && r.teamScore != null && r.oppScore != null);
  const rows = ended
    .filter((r) => r.min > 0)
    .sort((a, b) => (a.gameDate < b.gameDate ? 1 : a.gameDate > b.gameDate ? -1 : a.gmkey < b.gmkey ? 1 : -1));
  if (!rows.length) return null;
  const gp = rows.length;
  const dnp = ended.length - gp;
  const sum = (fn: (r: CareerGameRow) => number) => rows.reduce((s, r) => s + fn(r), 0);
  const tsa = sum((r) => r.fga + r.tpa + 0.44 * r.fta);
  const teamW = rows.filter((r) => (r.teamScore as number) > (r.oppScore as number)).length;
  return {
    oppTcode,
    gp,
    dnp,
    ppg: sum((r) => r.pts) / gp,
    rpg: sum((r) => r.reb) / gp,
    apg: sum((r) => r.ast) / gp,
    tsPct: tsa > 0 ? sum((r) => r.pts) / (2 * tsa) : null,
    teamW,
    teamL: gp - teamW,
    last3: rows.slice(0, 3).map((r) => ({
      gmkey: r.gmkey,
      gameDate: r.gameDate,
      seasonName: r.seasonName,
      seasonCategory: r.seasonCategory,
      isHome: r.isHome,
      teamScore: r.teamScore as number,
      oppScore: r.oppScore as number,
      won: (r.teamScore as number) > (r.oppScore as number),
      pts: r.pts,
      reb: r.reb,
      ast: r.ast,
    })),
  };
}

// 출전시간 잔류율 - 명칭 고정. "전력 유지율"·"continuity"라고 부르지 않는다(pregame_features.
// roster_continuity는 모델 입력값이라 뜻이 다르고, "전력"은 출전시간이 말해 주지 않는 것을
// 약속한다). 캡션 문구도 이 함수가 만든다.
export function retainedMinutesCaption(prevSeason: string): string {
  const s = shortSeason(prevSeason);
  return `출전시간 잔류율 = 잔류 선수의 ${s} 정규 출전시간 / 팀 전체 ${s} 정규 출전시간 · 분모 = ${s} 정규 팀 총 출전시간 · 복귀·신입은 0`;
}

export type RetainedMinutesTeam = {
  tcode: string;
  retainedPct: number | null; // 0~1, 팀 총 출전시간이 0이면 null
  retainedMinutes: number;
  teamMinutes: number;
  countStay: number;
};

export type RetainedMinutes = RetainedMinutesTeam & {
  season: string; // 확정 명단 시즌(= 분자의 잔류 판정 기준)
  prevSeason: string; // 출전시간·WPA를 집계한 시즌(정규시즌만)
  minutesOut: number; // 이탈 선수들이 이 팀에서 뛴 prevSeason 정규 출전시간
  minutesIn: number; // 영입 선수들이 "이전 팀"에서 뛴 prevSeason 정규 출전시간(복귀·신입은 0)
  wpaOut: number; // 이탈 선수 prevSeason 정규 WPA 합(player_season_wpa, 이 팀 소속 행)
  wpaIn: number; // 영입 선수 prevSeason 정규 WPA 합(이전 팀 소속 행) - 팀 맥락 보정 없음
  wpaStay: number; // 잔류 선수 prevSeason 정규 WPA 합
  countOut: number; // roster_changes out 행 수
  countOutWithWpa: number; // 그중 prevSeason WPA가 있는 선수 수(캡션 '떠난 WPA −X (N명)'의 N)
  countIn: number; // roster_changes in 행 수(이적 + 복귀)
  countInWithWpa: number; // 그중 prevSeason WPA가 있는 선수 수 - 복귀 선수는 기록이 없어 "0이 아니라 제외"
  countNew: number;
  leagueRank: number | null; // 잔류율 내림차순 순위(확정 명단이 있는 팀 중)
  leagueN: number;
  league: RetainedMinutesTeam[]; // 리그 미니 순위 바용, 내림차순
  caption: string;
};

/**
 * 한 팀의 출전시간 잔류율 + 이탈/영입 WPA 헤드라인(팀 프로필 히어로 타일·오프시즌 패널).
 * 계산: roster_changes(season) × game_player_stats(prevSeason 정규시즌, 분) × player_season_wpa(prevSeason).
 * player_season_wpa.games는 정규시즌 GP다(검증: 워니 25-26 games 50 = 정규 50, 정규+PO 53).
 * 리그 순위를 내려면 10팀 전부 필요해서 prevSeason 정규 전 선수-경기 행(약 6,400행)을 받는다.
 * 리그 전체를 offset 페이지네이션으로 받으면 10초가 걸렸고(실측, count+offset 7페이지), 팀별로
 * 쪼개면 팀당 650행 안팎이라 1페이지씩 10개를 병렬로 받는 편이 1~2초로 끝난다(PostgREST 집계
 * 함수는 이 프로젝트에서 비활성 - "Use of aggregate functions is not allowed" 실측).
 * 검증(2026-09-03, 분모 = 팀 총 출전시간): SK .957 · SAM .917 · DB .908 · KCC .903 · GAS .891 ·
 * LG .883 · SONO .756 · MOB .689 · KGC .640 · KT .620; KT 떠난 WPA 55.7(6명) / 들어온 6.0(3명).
 * 이 팀에 roster_changes 행이 없으면(과거 시즌·명단 미수신) null.
 */
type RegMinRow = { pcode: string; tcode: string; min_played: number | string | null };

async function fetchTeamRegMinutes(tcode: string, seasonName: string): Promise<RegMinRow[]> {
  const PAGE = 1000;
  const rows: RegMinRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("game_player_stats")
      .select("pcode, tcode, min_played, games!inner()")
      .eq("tcode", tcode)
      .eq("games.season_name", seasonName)
      .eq("games.season_category", "정규시즌")
      // offset 페이지네이션은 정렬이 없으면 페이지 경계에서 행이 겹치거나 빠질 수 있다(PostgreSQL은
      // ORDER BY 없는 LIMIT/OFFSET 순서를 보장하지 않음). game_player_stats PK가 (gmkey, pcode)라
      // 이 두 컬럼이면 전순서라, 시즌이 길어져 2페이지가 되어도 잔류율이 조용히 흔들리지 않는다.
      .order("gmkey", { ascending: true })
      .order("pcode", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    rows.push(...(data as unknown as RegMinRow[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

export async function getRetainedMinutes(tcode: string, season = PRESEASON_SEASON): Promise<RetainedMinutes | null> {
  const prevSeason = prevSeasonName(season);
  const [changesRes, wpaRes] = await Promise.all([
    supabase.from("roster_changes").select("tcode, pcode, change, prev_tcode, prev_season_name").eq("season_name", season),
    supabase.from("player_season_wpa").select("pcode, tcode, total_wpa").eq("season_name", prevSeason),
  ]);
  const changes = changesRes.data ?? [];
  if (!changes.some((c) => c.tcode === tcode)) return null;

  // 확정 명단이 있는 팀 + 영입 선수의 이전 팀(해체 팀 등 명단 밖일 수 있음) 전부의 prevSeason 정규 분.
  const teamSet = new Set<string>();
  for (const c of changes) {
    teamSet.add(c.tcode as string);
    if (c.prev_tcode) teamSet.add(c.prev_tcode as string);
  }
  const minRows = (await Promise.all([...teamSet].map((t) => fetchTeamRegMinutes(t, prevSeason)))).flat();

  // (pcode|tcode) -> prevSeason 정규 분 / WPA. 시즌 중 이적한 선수는 팀별로 따로 잡힌다.
  const minutes = new Map<string, number>();
  const teamMinutes = new Map<string, number>();
  for (const r of minRows) {
    const m = Number(r.min_played ?? 0);
    if (!Number.isFinite(m)) continue;
    const key = `${r.pcode}|${r.tcode}`;
    minutes.set(key, (minutes.get(key) ?? 0) + m);
    teamMinutes.set(r.tcode, (teamMinutes.get(r.tcode) ?? 0) + m);
  }
  const wpa = new Map<string, number>();
  for (const r of wpaRes.data ?? []) if (r.total_wpa != null) wpa.set(`${r.pcode}|${r.tcode}`, Number(r.total_wpa));

  const league: RetainedMinutesTeam[] = [];
  const perTeam = new Map<string, RetainedMinutesTeam>();
  for (const c of changes) {
    const t = c.tcode as string;
    const row = perTeam.get(t) ?? { tcode: t, retainedPct: null, retainedMinutes: 0, teamMinutes: teamMinutes.get(t) ?? 0, countStay: 0 };
    if (c.change === "stay" && c.pcode) {
      row.countStay += 1;
      row.retainedMinutes += minutes.get(`${c.pcode}|${t}`) ?? 0;
    }
    perTeam.set(t, row);
  }
  for (const row of perTeam.values()) {
    row.retainedPct = row.teamMinutes > 0 ? row.retainedMinutes / row.teamMinutes : null;
    league.push(row);
  }
  league.sort((a, b) => (b.retainedPct ?? -1) - (a.retainedPct ?? -1));
  const mine = perTeam.get(tcode)!;
  const rankIdx = league.findIndex((r) => r.tcode === tcode);

  let minutesOut = 0,
    minutesIn = 0,
    wpaOut = 0,
    wpaIn = 0,
    wpaStay = 0,
    countOut = 0,
    countOutWithWpa = 0,
    countIn = 0,
    countInWithWpa = 0,
    countNew = 0;
  for (const c of changes) {
    if (c.tcode !== tcode) continue;
    const pcode = c.pcode as string | null;
    if (c.change === "out") {
      countOut += 1;
      if (!pcode) continue;
      minutesOut += minutes.get(`${pcode}|${tcode}`) ?? 0;
      const w = wpa.get(`${pcode}|${tcode}`);
      if (w != null) {
        wpaOut += w;
        countOutWithWpa += 1;
      }
    } else if (c.change === "in") {
      countIn += 1;
      if (!pcode) continue;
      // 영입의 지난 시즌 기록은 "이전 팀" 소속 행(같은 팀 복귀면 이 팀 행). prev_season_name이
      // prevSeason이 아닌 복귀 선수는 행 자체가 없어 자연히 제외된다.
      const from = (c.prev_tcode as string | null) ?? tcode;
      minutesIn += minutes.get(`${pcode}|${from}`) ?? 0;
      const w = wpa.get(`${pcode}|${from}`);
      if (w != null) {
        wpaIn += w;
        countInWithWpa += 1;
      }
    } else if (c.change === "stay") {
      if (pcode) wpaStay += wpa.get(`${pcode}|${tcode}`) ?? 0;
    } else if (c.change === "new") {
      countNew += 1;
    }
  }

  return {
    ...mine,
    season,
    prevSeason,
    minutesOut,
    minutesIn,
    wpaOut,
    wpaIn,
    wpaStay,
    countOut,
    countOutWithWpa,
    countIn,
    countInWithWpa,
    countNew,
    leagueRank: rankIdx >= 0 ? rankIdx + 1 : null,
    leagueN: league.length,
    league,
    caption: retainedMinutesCaption(prevSeason),
  };
}

/** 경기 전 모델 홈 승률(pregame_features.home_win_prob, 0~1). 없으면 null. 캡션은 페이지가
 *  PREGAME_MODEL_CAPTION을 그대로 붙인다(로스터 변화 부분 반영 - 실측 continuity 0.891~1.0). */
export const PREGAME_MODEL_CAPTION = "지난 시즌 지표 기반 프리시즌 모델 · 로스터 변화 부분 반영(연속성 입력 0.89~1.0) · 참고용";

export async function getPregameProb(gmkey: string): Promise<number | null> {
  const { data } = await supabase.from("pregame_features").select("home_win_prob").eq("gmkey", gmkey).maybeSingle();
  return data?.home_win_prob == null ? null : Number(data.home_win_prob);
}
