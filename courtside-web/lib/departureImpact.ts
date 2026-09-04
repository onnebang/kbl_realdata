import { supabaseServer as supabase } from "./supabaseServer";
import { getTeams, prevSeasonName, type TeamInfo } from "./preseason";

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
// ── 왜 미리 구운 표를 읽는가 ────────────────────────────────────────────────────
// 처음엔 이 계산을 페이지에서 직접 했다. 그런데 분모가 "직전 시즌 팀 합계"라 game_player_stats
// 6,480행을 매 요청마다 끌어와야 했고, 개막 리포트 서버 렌더가 1초에서 9초로 늘었다(실측
// 2026-09-05). 값은 끝난 시즌 + 사람이 확인한 명단이라 변하지 않으므로
// tools/build_departure_impact.py 가 한 번 접어 두고 여기서는 팀 10행 + 선수 13행만 읽는다.
// **명단(tools/data/departures_*.csv)을 고치면 그 스크립트를 다시 돌려야 화면에 반영된다.**

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
  /** 선발 슬롯(경기 수 × 5) 대비 이탈자 선발 횟수. */
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

/** "얇은 로스터"를 인원수가 아니라 이 문턱으로 센다. tools/build_departure_impact.py와 같은 값. */
export const PROVEN_MINUTES = 500;

const LABEL: Record<string, string> = {
  military: "군 입대",
  overseas: "해외 진출",
  unsigned: "FA 미계약",
  retired: "은퇴",
  other: "이탈",
};

const n = (v: unknown): number => (v == null ? 0 : Number(v));

type Row = Record<string, unknown>;

const shareOf = (r: Row, prefix: "lost" | "tot"): DepartureShare => ({
  minutes: n(r[`${prefix}_minutes`]),
  pts: n(r[`${prefix}_pts`]),
  reb: n(r[`${prefix}_reb`]),
  ast: n(r[`${prefix}_ast`]),
  stl: n(r[`${prefix}_stl`]),
  blk: n(r[`${prefix}_blk`]),
  fga: n(r[`${prefix}_fga`]),
  tpa: n(r[`${prefix}_tpa`]),
});

const EMPTY = (): DepartureShare => ({ minutes: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fga: 0, tpa: 0 });
const KEYS = Object.keys(EMPTY()) as (keyof DepartureShare)[];
const ratio = (lost: DepartureShare, total: DepartureShare): DepartureShare => {
  const out = EMPTY();
  for (const k of KEYS) out[k] = total[k] > 0 ? lost[k] / total[k] : 0;
  return out;
};
const addTo = (a: DepartureShare, b: DepartureShare) => {
  for (const k of KEYS) a[k] += b[k];
};

/**
 * 확정 이탈이 팀별로 가져간 몫. 표본은 직전 시즌 정규시즌뿐이다(플레이오프는 팀마다 경기 수가
 * 달라 "팀 합계 대비 몫"의 분모가 팀마다 다른 뜻이 된다).
 * 집계 표가 아직 없는 시즌이면 null - 화면은 이 섹션만 빼고 그린다.
 */
export async function getDepartureReport(season: string): Promise<DepartureReport | null> {
  const prevSeason = prevSeasonName(season);
  const [teamMap, teamRes, playerRes] = await Promise.all([
    getTeams(season),
    supabase.from("departure_impact_team").select("*").eq("season_name", season),
    supabase.from("departure_impact_player").select("*").eq("season_name", season),
  ]);
  const teamRows = (teamRes.data ?? []) as Row[];
  const playerRows = (playerRes.data ?? []) as Row[];
  if (!teamRows.length || !playerRows.length) return null;

  const players: DepartedPlayer[] = playerRows
    .map((r) => {
      const reason = r.reason as DepartureReason;
      return {
        pcode: r.pcode as string,
        name: r.player_name as string,
        tcode: r.tcode as string,
        reason,
        label: LABEL[reason] ?? "이탈",
        detail: (r.detail as string | null) ?? null,
        played: !!r.played,
        gp: n(r.gp),
        gpPlayed: n(r.gp_played),
        starts: n(r.starts),
        minutes: n(r.minutes),
        pts: n(r.pts),
        reb: n(r.reb),
        ast: n(r.ast),
        pos: (r.pos as string | null) ?? null,
        minutesRank: r.minutes_rank == null ? null : n(r.minutes_rank),
        teamPlayers: n(r.team_players),
      };
    })
    .sort((a, b) => b.minutes - a.minutes);

  const teams: TeamDeparture[] = [];
  for (const r of teamRows) {
    const tcode = r.tcode as string;
    const team = teamMap.get(tcode);
    if (!team) continue; // 해체된 옛 팀코드
    const lost = shareOf(r, "lost");
    const total = shareOf(r, "tot");
    const startSlots = n(r.start_slots);
    const posMinutes = n(r.top_pos_minutes);
    const posPts = n(r.top_pos_pts);
    teams.push({
      team,
      players: players.filter((p) => p.tcode === tcode),
      share: ratio(lost, total),
      lost,
      total,
      starts: n(r.starts),
      startSlots,
      startShare: startSlots > 0 ? n(r.starts) / startSlots : 0,
      topPos:
        r.top_pos && posMinutes > 0
          ? {
              pos: r.top_pos as string,
              minuteShare: n(r.top_pos_lost_minutes) / posMinutes,
              ptsShare: posPts > 0 ? n(r.top_pos_lost_pts) / posPts : 0,
              lostMinutes: n(r.top_pos_lost_minutes),
              posMinutes,
            }
          : null,
      zeroKind: (r.zero_kind as "none" | "notPlayed" | null) ?? null,
      rosterN: n(r.roster_n),
      provenN: n(r.proven_n),
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

  const leagueLost = EMPTY();
  const leagueTotal = EMPTY();
  for (const t of teams) {
    addTo(leagueLost, t.lost);
    addTo(leagueTotal, t.total);
  }
  const sorted = teams.map((t) => t.lost.minutes).sort((a, b) => b - a);
  const reasonCounts: Record<string, number> = {};
  for (const p of players) reasonCounts[p.reason] = (reasonCounts[p.reason] ?? 0) + 1;

  return {
    season,
    prevSeason,
    teams,
    players,
    leagueShare: ratio(leagueLost, leagueTotal),
    topTwoConcentration: leagueLost.minutes > 0 ? ((sorted[0] ?? 0) + (sorted[1] ?? 0)) / leagueLost.minutes : 0,
    reasonCounts,
    provenMinutes: PROVEN_MINUTES,
  };
}
