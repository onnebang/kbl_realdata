import { supabase } from "./supabase";
import { displayTeamName } from "./teamNames";

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
// 제외(실측: 2026-09-02자 P2LIVE 경기가 "개막일"로 잡혔음).
function isRealGmkey(gmkey: string): boolean {
  return /^S\d/.test(gmkey);
}

/** 개막까지 남은 날(KST) - lib/homeGames.ts의 컷오프 계산과 같은 방식(UTC+9를 더한 뒤 날짜만). */
export function daysUntilKst(dateStr: string): number {
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const a = Date.UTC(+todayKst.slice(0, 4), +todayKst.slice(5, 7) - 1, +todayKst.slice(8, 10));
  const b = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/** 홈 배너용 경량 조회 - 이 시즌 실제 첫 경기 날짜와 예정 경기 수(승률 조회 없음). */
export async function getSeasonOpener(season: string): Promise<{ firstGameDate: string; nGames: number } | null> {
  const { data } = await supabase.from("games").select("gmkey, game_date").eq("season_name", season).order("game_date");
  const real = (data ?? []).filter((g) => isRealGmkey(g.gmkey as string));
  if (!real.length) return null;
  return { firstGameDate: real[0].game_date as string, nGames: real.length };
}

export type TeamInfo = { tcode: string; name: string; abbr: string; color: string; logoUrl: string | null };

async function getTeams(season: string): Promise<Map<string, TeamInfo>> {
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
    teams: rows,
  };
}

// ---------------------------------------------------------------------------
// 2. 로스터 변화 - roster_changes(파생 테이블) 그대로 + 팀별 그룹핑 + 헤드라인
// ---------------------------------------------------------------------------
export type ChangeKind = "stay" | "in" | "out" | "new";

export type RosterChange = {
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
};

export type TeamRosterChanges = {
  team: TeamInfo;
  in: RosterChange[];
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
  domesticPending: boolean; // 국내 선수 로스터가 아직 안 들어온 단계(외국인만 판정된 상태)
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
  }));

  const byTeam = new Map<string, TeamRosterChanges>();
  for (const team of teams.values()) byTeam.set(team.tcode, { team, in: [], new: [], stay: [], out: [] });
  for (const r of rows) byTeam.get(r.tcode)?.[r.change].push(r);

  // 로스터가 실제로 들어온 팀만(행이 하나도 없는 팀 - 해체된 옛 팀코드 등 - 은 제외), 약어순.
  const teamList = [...byTeam.values()]
    .filter((t) => t.in.length + t.new.length + t.stay.length + t.out.length > 0)
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
  const counts: Record<ChangeKind, number> = { stay: 0, in: 0, out: 0, new: 0 };
  for (const r of rows) counts[r.change]++;

  return {
    season,
    prevSeason,
    teams: teamList,
    moves,
    topIn: ins.length ? withTeam(ins[0]) : null,
    topOut: outs.length ? withTeam(outs[0]) : null,
    counts,
    domesticPending: !rows.some((r) => r.change !== "out" && r.role == null),
  };
}

/** 팀 프로필용 - 한 팀의 이번 시즌 로스터 변화(행이 없으면 null: 로스터 미수신 시즌/과거 시즌). */
export async function getTeamRosterChanges(season: string, tcode: string): Promise<TeamRosterChanges | null> {
  const report = await getRosterChangeReport(season);
  return report.teams.find((t) => t.team.tcode === tcode) ?? null;
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
  { gmkey: "S47G01N189", why: "시즌 최대 점수차 역전승" },
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
