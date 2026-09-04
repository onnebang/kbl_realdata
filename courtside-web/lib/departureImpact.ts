import { supabase } from "./supabase";
import { getTeams, prevSeasonName, type TeamInfo } from "./preseason";
import { GMKEY_CHUNK, SEASON_CATEGORY_REGULAR, chunk, getSeasonGames, num } from "./teamSeasonStats";

// 확정 이탈이 각 팀에서 무엇을 가져갔는가 - 요청("해당 인원들을 제외하고 ... 시즌 리포트와
// 예상을 적어줘야 할 것 같아")의 첫 절반.
//
// ── 이 파일이 하는 것과 하지 않는 것 ─────────────────────────────────────────────
// 하는 것: 나눗셈. "이 선수들이 지난 시즌 그 팀 합계에서 차지하던 몫". 모델이 아니라 사실이라
//          그대로 화면에 쓸 수 있다.
// 하지 않는 것: 전력 예측. "가스공사 전력 17% 하락" 같은 문장은 이 숫자가 뒷받침하지 않는다.
//          신규 영입·외국인 교체·부상 복귀·규정 변경이 전부 빠져 있기 때문이다. 화면 문구는
//          반드시 "지난 시즌 팀 출전시간의 17.3%를 차지했다"까지만 간다.
//
// ── 왜 포지션 몫을 같이 재는가(이 리포트의 핵심) ───────────────────────────────────
// 팀 총량만 보면 가스공사(17.3%)가 1위이고 KCC는 2위(14.2%)다. 그런데 자리로 좁히면 순서가
// 뒤집힌다 - KCC는 포워드 출전시간의 48.3%, 포워드 득점의 55.9%를 한꺼번에 잃었다(실측
// 2026-09-04). 총량은 "얼마나 빠졌나"를, 포지션은 "그 구멍을 메울 사람이 있나"를 말한다.
//
// ── 실측에서 나온 함정 세 가지(전부 아래 코드가 처리한다) ──────────────────────────
// 1. game_player_stats에는 결장 행(min_played = 0)이 섞여 있다. 경기 수를 행 수로 세면
//    문가온이 "20경기 출전"으로 찍히는데 실제 출전은 5경기다. 그래서 gp와 gpPlayed를 나눠 센다.
// 2. 25-26 출전이 0인 이탈자가 있다(두경민 - 24-25가 마지막). 그 팀의 몫은 0.0%가 되는데,
//    이건 "잃은 게 없다"가 아니라 "지난 시즌 기준으로는 잴 수 없다"이다. zeroKind로 구분한다.
// 3. 외국인·아시아쿼터는 season_roster의 pos가 비어 있어 포지션 분모에 안 들어간다. 그래서
//    포지션 몫은 "같은 분류(국내 GD/FD/C) 안에서"라고 화면이 밝혀야 한다.

/** 이탈 사유. tools/load_departures.py의 값과 같다. */
export type DepartureReason = "military" | "overseas" | "unsigned" | "retired" | "other";

export type DepartedPlayer = {
  pcode: string;
  name: string;
  tcode: string;
  reason: DepartureReason;
  label: string;
  detail: string | null;
  /** 직전 시즌 기록. 그 시즌에 안 뛰었으면 전부 0이고 played=false. */
  played: boolean;
  /** 스탯 행 수(결장 포함). */
  gp: number;
  /** 실제 출전(0분 초과) 경기 수. */
  gpPlayed: number;
  starts: number;
  minutes: number;
  pts: number;
  reb: number;
  ast: number;
  /** game_player_stats.pos(GD/FD/C). 외국인·아시아쿼터는 비어 있을 수 있다. */
  pos: string | null;
  /** 팀 내 출전시간 순위(1이 최다). 안 뛰었으면 null. */
  minutesRank: number | null;
  teamPlayers: number;
};

export type DepartureShare = {
  minutes: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  fga: number;
  tpa: number;
};

export type TeamDeparture = {
  team: TeamInfo;
  players: DepartedPlayer[];
  /** 팀 합계 대비 몫(0~1). */
  share: DepartureShare;
  /** 팀 합계 원자료(분자/분모를 화면이 그대로 인용할 수 있게). */
  lost: DepartureShare;
  total: DepartureShare;
  /** 선발 슬롯(54경기 × 5) 대비 이탈자 선발 횟수. */
  startShare: number;
  starts: number;
  startSlots: number;
  /** 같은 pos 분류 안에서의 몫. 이탈자가 여러 포지션이면 가장 큰 것. */
  topPos: { pos: string; minuteShare: number; ptsShare: number; lostMinutes: number; posMinutes: number } | null;
  /**
   * 몫이 0인 이유. "none" = 이탈자가 없다. "notPlayed" = 이탈자는 있는데 지난 시즌 출전이
   * 없었다(두경민). 두 0은 성격이 다르므로 표가 각주로 구분해야 한다.
   */
  zeroKind: "none" | "notPlayed" | null;
  /** 이탈 제외 후 등록 인원. */
  rosterN: number;
  /** 그중 지난 시즌 500분 이상 뛴 선수 수 - "로스터가 얇다"는 인원수가 아니라 이걸로 말한다. */
  provenN: number;
};

export type DepartureReport = {
  season: string;
  prevSeason: string;
  teams: TeamDeparture[];
  /** 이탈자 전원. */
  players: DepartedPlayer[];
  /** 리그 전체에서 이탈자가 차지하던 몫. */
  leagueShare: DepartureShare;
  /** 이탈 출전시간이 상위 두 팀에 몰린 비율 - "58%가 두 팀에" 문장의 근거. */
  topTwoConcentration: number;
  reasonCounts: Record<string, number>;
  /** 500분 기준(provenN의 문턱). */
  provenMinutes: number;
};

/** "얇은 로스터"를 인원수가 아니라 이 문턱으로 센다 - 인원수만 보면 이탈 0인 팀이 더 얇아 보인다. */
export const PROVEN_MINUTES = 500;

const EMPTY: DepartureShare = { minutes: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fga: 0, tpa: 0 };
const addTo = (a: DepartureShare, b: DepartureShare) => {
  a.minutes += b.minutes;
  a.pts += b.pts;
  a.reb += b.reb;
  a.ast += b.ast;
  a.stl += b.stl;
  a.blk += b.blk;
  a.fga += b.fga;
  a.tpa += b.tpa;
};
const ratio = (lost: DepartureShare, total: DepartureShare): DepartureShare => ({
  minutes: total.minutes > 0 ? lost.minutes / total.minutes : 0,
  pts: total.pts > 0 ? lost.pts / total.pts : 0,
  reb: total.reb > 0 ? lost.reb / total.reb : 0,
  ast: total.ast > 0 ? lost.ast / total.ast : 0,
  stl: total.stl > 0 ? lost.stl / total.stl : 0,
  blk: total.blk > 0 ? lost.blk / total.blk : 0,
  fga: total.fga > 0 ? lost.fga / total.fga : 0,
  tpa: total.tpa > 0 ? lost.tpa / total.tpa : 0,
});

const LABEL: Record<string, string> = {
  military: "군 입대",
  overseas: "해외 진출",
  unsigned: "FA 미계약",
  retired: "은퇴",
  other: "이탈",
};

type StatRow = {
  pcode: string;
  tcode: string;
  pos: string | null;
  is_starter: boolean | null;
  min_played: number | null;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  fga: number | null;
  tpa: number | null;
};

const STAT_SELECT = "pcode, tcode, pos, is_starter, min_played, pts, reb, ast, stl, blk, fga, tpa";

/**
 * 확정 이탈이 팀별로 가져간 몫. 표본은 직전 시즌 정규시즌뿐이다(플레이오프는 팀마다 경기 수가
 * 달라 "팀 합계 대비 몫"의 분모가 팀마다 다른 뜻이 된다).
 */
export async function getDepartureReport(season: string): Promise<DepartureReport | null> {
  const prevSeason = prevSeasonName(season);
  const [teamMap, depRes, games] = await Promise.all([
    getTeams(season),
    supabase.from("roster_departure").select("pcode, player_name, tcode, reason, detail").eq("season_name", season),
    getSeasonGames(prevSeason, { category: SEASON_CATEGORY_REGULAR }),
  ]);
  const deps = depRes.data ?? [];
  if (!deps.length || !games.length) return null;

  // 직전 시즌 정규시즌 선수 행 전부. 팀 합계와 포지션 합계의 분모가 여기서 나온다.
  const rows: StatRow[] = [];
  for (const part of chunk(games.map((g) => g.gmkey), GMKEY_CHUNK)) {
    let from = 0;
    for (;;) {
      const { data } = await supabase.from("game_player_stats").select(STAT_SELECT).in("gmkey", part).range(from, from + 999);
      const page = (data ?? []) as StatRow[];
      rows.push(...page);
      if (page.length < 1000) break;
      from += 1000;
    }
  }
  if (!rows.length) return null;

  const depByPcode = new Map(deps.map((d) => [d.pcode as string, d]));

  // 팀 합계 · 포지션 합계 · 선수별 합계를 한 번에 접는다.
  const teamTotal = new Map<string, DepartureShare>();
  const posTotal = new Map<string, DepartureShare>(); // "tcode|pos"
  type Agg = { tcode: string; pos: string | null; gp: number; gpPlayed: number; starts: number; s: DepartureShare };
  const byPlayer = new Map<string, Agg>();

  for (const r of rows) {
    const one: DepartureShare = {
      minutes: num(r.min_played),
      pts: num(r.pts),
      reb: num(r.reb),
      ast: num(r.ast),
      stl: num(r.stl),
      blk: num(r.blk),
      fga: num(r.fga) + num(r.tpa), // 이 DB의 fga는 2점 전용이라 총 야투시도는 둘의 합이다
      tpa: num(r.tpa),
    };
    const t = teamTotal.get(r.tcode) ?? { ...EMPTY };
    addTo(t, one);
    teamTotal.set(r.tcode, t);

    const pos = (r.pos ?? "").trim() || null;
    if (pos) {
      const key = `${r.tcode}|${pos}`;
      const p = posTotal.get(key) ?? { ...EMPTY };
      addTo(p, one);
      posTotal.set(key, p);
    }

    const a = byPlayer.get(r.pcode) ?? { tcode: r.tcode, pos, gp: 0, gpPlayed: 0, starts: 0, s: { ...EMPTY } };
    a.gp += 1;
    if (one.minutes > 0) a.gpPlayed += 1;
    if (r.is_starter) a.starts += 1;
    if (!a.pos && pos) a.pos = pos;
    addTo(a.s, one);
    byPlayer.set(r.pcode, a);
  }

  // 팀 내 출전시간 순위(이탈자가 그 팀에서 몇 번째로 많이 뛴 선수였나).
  const rankByTeam = new Map<string, string[]>();
  for (const [pcode, a] of byPlayer) {
    const list = rankByTeam.get(a.tcode) ?? [];
    list.push(pcode);
    rankByTeam.set(a.tcode, list);
  }
  for (const list of rankByTeam.values()) list.sort((x, y) => (byPlayer.get(y)?.s.minutes ?? 0) - (byPlayer.get(x)?.s.minutes ?? 0));

  // 이탈 제외 후 등록 인원 + 직전 시즌 검증된 인원.
  const { data: rosterRows } = await supabase.from("season_roster").select("tcode, pcode").eq("season_name", season);
  const rosterN = new Map<string, number>();
  const provenN = new Map<string, number>();
  for (const r of rosterRows ?? []) {
    const tc = r.tcode as string;
    const pc = r.pcode as string | null;
    if (pc && depByPcode.has(pc)) continue; // 이탈자는 인원에서 뺀다 - 명부에 남아 있다고 전력이 아니다
    rosterN.set(tc, (rosterN.get(tc) ?? 0) + 1);
    if (pc && (byPlayer.get(pc)?.s.minutes ?? 0) >= PROVEN_MINUTES) provenN.set(tc, (provenN.get(tc) ?? 0) + 1);
  }

  const players: DepartedPlayer[] = [];
  const lostByTeam = new Map<string, DepartureShare>();
  const lostByPos = new Map<string, DepartureShare>();
  const startsByTeam = new Map<string, number>();

  for (const d of deps) {
    const pcode = d.pcode as string;
    const tcode = d.tcode as string;
    const a = byPlayer.get(pcode);
    const reason = d.reason as DepartureReason;
    const teamRank = rankByTeam.get(a?.tcode ?? tcode) ?? [];
    players.push({
      pcode,
      name: d.player_name as string,
      tcode,
      reason,
      label: LABEL[reason] ?? "이탈",
      detail: (d.detail as string | null) ?? null,
      played: !!a && a.gpPlayed > 0,
      gp: a?.gp ?? 0,
      gpPlayed: a?.gpPlayed ?? 0,
      starts: a?.starts ?? 0,
      minutes: a?.s.minutes ?? 0,
      pts: a?.s.pts ?? 0,
      reb: a?.s.reb ?? 0,
      ast: a?.s.ast ?? 0,
      pos: a?.pos ?? null,
      minutesRank: a ? teamRank.indexOf(pcode) + 1 : null,
      teamPlayers: teamRank.length,
    });
    if (!a) continue;
    // 몫은 "그 선수가 실제로 뛴 팀" 기준으로 쌓는다(시즌 중 이적자 대비 - 실측상 이번 13명은
    // 전원 한 팀에서만 뛰었지만, 규칙을 코드에 남겨 둔다).
    const lt = lostByTeam.get(a.tcode) ?? { ...EMPTY };
    addTo(lt, a.s);
    lostByTeam.set(a.tcode, lt);
    startsByTeam.set(a.tcode, (startsByTeam.get(a.tcode) ?? 0) + a.starts);
    if (a.pos) {
      const key = `${a.tcode}|${a.pos}`;
      const lp = lostByPos.get(key) ?? { ...EMPTY };
      addTo(lp, a.s);
      lostByPos.set(key, lp);
    }
  }

  const gamesPerTeam = new Map<string, number>();
  for (const g of games) {
    gamesPerTeam.set(g.homeTcode, (gamesPerTeam.get(g.homeTcode) ?? 0) + 1);
    gamesPerTeam.set(g.awayTcode, (gamesPerTeam.get(g.awayTcode) ?? 0) + 1);
  }

  const teams: TeamDeparture[] = [];
  for (const [tcode, team] of teamMap) {
    const total = teamTotal.get(tcode);
    if (!total) continue; // 해체된 옛 팀코드
    const lost = lostByTeam.get(tcode) ?? { ...EMPTY };
    const mine = players.filter((p) => p.tcode === tcode);
    const startSlots = (gamesPerTeam.get(tcode) ?? 0) * 5;
    const starts = startsByTeam.get(tcode) ?? 0;

    // 같은 분류 안에서 가장 크게 빈 포지션. 총량이 아니라 여기가 "메울 사람이 있나"를 말한다.
    let topPos: TeamDeparture["topPos"] = null;
    for (const [key, lp] of lostByPos) {
      if (!key.startsWith(`${tcode}|`)) continue;
      const pos = key.slice(tcode.length + 1);
      const pt = posTotal.get(key);
      if (!pt || pt.minutes <= 0) continue;
      const share = lp.minutes / pt.minutes;
      if (!topPos || share > topPos.minuteShare) {
        topPos = {
          pos,
          minuteShare: share,
          ptsShare: pt.pts > 0 ? lp.pts / pt.pts : 0,
          lostMinutes: lp.minutes,
          posMinutes: pt.minutes,
        };
      }
    }

    teams.push({
      team,
      players: mine.sort((a, b) => b.minutes - a.minutes),
      share: ratio(lost, total),
      lost,
      total,
      starts,
      startSlots,
      startShare: startSlots > 0 ? starts / startSlots : 0,
      topPos,
      zeroKind: lost.minutes > 0 ? null : mine.length === 0 ? "none" : "notPlayed",
      rosterN: rosterN.get(tcode) ?? 0,
      provenN: provenN.get(tcode) ?? 0,
    });
  }
  // 결장자가 있는 팀을 먼저. 두경민처럼 직전 시즌 출전이 0인 경우 몫도 0이 되는데, 그 0을
  // 결장자가 아예 없는 팀의 0과 같은 자리에 두면 "잴 수 없다"가 "없다"로 읽힌다.
  teams.sort(
    (a, b) =>
      Number(b.players.length > 0) - Number(a.players.length > 0) ||
      b.share.minutes - a.share.minutes ||
      a.team.abbr.localeCompare(b.team.abbr)
  );

  const leagueLost = { ...EMPTY };
  const leagueTotal = { ...EMPTY };
  for (const t of teams) {
    addTo(leagueLost, t.lost);
    addTo(leagueTotal, t.total);
  }
  const lostMinutesSorted = teams.map((t) => t.lost.minutes).sort((a, b) => b - a);
  const topTwo = (lostMinutesSorted[0] ?? 0) + (lostMinutesSorted[1] ?? 0);

  const reasonCounts: Record<string, number> = {};
  for (const p of players) reasonCounts[p.reason] = (reasonCounts[p.reason] ?? 0) + 1;

  return {
    season,
    prevSeason,
    teams,
    players: players.sort((a, b) => b.minutes - a.minutes),
    leagueShare: ratio(leagueLost, leagueTotal),
    topTwoConcentration: leagueLost.minutes > 0 ? topTwo / leagueLost.minutes : 0,
    reasonCounts,
    provenMinutes: PROVEN_MINUTES,
  };
}
