import { supabase } from "./supabase";
import { displayTeamName } from "./teamNames";
import { PRESEASON_SEASON, prevSeasonName, roleFromNote, type ChangeKind } from "./preseason";
import { getPlayerCareerGames, type CareerGameRow } from "./playerProfile";

// 선수 프로필 상태 스트립의 3상태(프로필 개편 1단계, player_profile[0]).
//   active   - season_roster(PRESEASON_SEASON)에 행이 있음 → 26-27 소속·번호·포지션·역할 + 잔류/영입/복귀/신입
//   departed - 확정 명단엔 없고 roster_changes 'out' 행만 있음 → '26-27 확정 명단 없음 · 25-26 SK · 리그 이탈'
//   archive  - 둘 다 없음 → '커리어 아카이브 · 마지막 시즌 24-25 KT'
// 판정 재료는 전부 DB 사실(확정 명단·대조표·경기 기록)이고, 복귀 이유·이적 사유는 추정하지 않는다 -
// roster_changes.note는 원문 그대로 넘긴다.

export type PlayerPos = "G" | "F" | "C";
export type PlayerRosterState = "active" | "departed" | "archive";

/** 포지션 정규화 - game_player_stats.pos 원문은 C/FD/GD 세 값(실측), season_roster.pos는 이미 G/F/C.
 *  화면엔 G/F/C만 내보낸다(원문 FD/GD 노출 금지). */
export function normalizePos(raw: string | null | undefined): PlayerPos | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase().charAt(0);
  return c === "G" || c === "F" || c === "C" ? c : null;
}

export type LastPlayedGame = {
  gmkey: string;
  gameDate: string;
  seasonName: string;
  seasonCategory: string;
  tcode: string;
  oppTcode: string;
  isHome: boolean;
  teamScore: number;
  oppScore: number;
  won: boolean;
  backNum: string | null;
  pos: PlayerPos | null;
  /** false = 명단에는 있었지만 0분(DNP) - 이 경우 성적 라인을 쓰지 않는다. */
  played: boolean;
  min: number;
  pts: number;
  reb: number;
  ast: number;
};

export type PlayerRosterStatus = {
  pcode: string;
  /** 확정 명단을 대조한 시즌(= PRESEASON_SEASON). */
  season: string;
  state: PlayerRosterState;
  /** active: 26-27 소속 / departed: 떠난 팀(roster_changes.tcode) / archive: 마지막 경기 소속. */
  tcode: string | null;
  /** 위 tcode의 표시 이름 - active는 26-27 기준, 나머지는 그 시즌 기준(displayTeamName). */
  teamName: string | null;
  /** active: season_roster.back_num, 없으면(외국인) 같은 팀 마지막 경기 번호. departed/archive: 마지막 경기 번호. */
  backNum: string | null;
  /** backNum이 확정 명단이 아니라 마지막 경기에서 왔으면 true(표기 '지난 시즌 #34' / '23-24 #35'). */
  backNumAsLastSeason: boolean;
  backNumSeason: string | null;
  /** G/F/C 정규화. season_roster.pos가 비면(외국인) 마지막 경기 pos를 정규화. */
  pos: PlayerPos | null;
  /** 외국인 1옵션 / 2옵션 / 아시아쿼터 / null(국내). active에만. */
  role: string | null;
  /** roster_changes 판정(active에만): stay / in(이적+복귀) / new. 대조표에 없으면 null. */
  change: Exclude<ChangeKind, "out"> | null;
  /** change 'in'이고 이전 팀이 다른 팀(해먼즈 MOB→DB). */
  isTransfer: boolean;
  /** change 'in'이고 prevSeasonName이 직전 시즌이 아님(배스 23-24 → 26-27) - note에 "복귀"가 있는 행과 일치. */
  isReturn: boolean;
  /** prevSeasonName과 season 사이에 KBL 기록이 없는 시즌 수(배스 2). stay/직전 시즌 이적은 0, 알 수 없으면 null. */
  gapSeasons: number | null;
  prevTcode: string | null;
  prevTeamName: string | null;
  /** roster_changes.prev_season_name - 아래 note와 성적 라인이 어느 시즌 것인지. */
  prevSeasonName: string | null;
  /** departed: 옮겨 간 팀(roster_changes.next_tcode). 리그 이탈이면 null. */
  nextTcode: string | null;
  nextTeamName: string | null;
  /** roster_changes.note 원문(잔류는 null). 화면에 그대로 인용한다. */
  note: string | null;
  /** season_roster.note 원문("외국인 1옵션 | 잔류 | DB 이력: …" / 등록상태 표기) - 출처 캡션·등록상태용. */
  rosterNote: string | null;
  rosterSource: string | null;
  /** KBL 명부 등록상태가 현역(A)이 아닌 경우(군복무·육성 추정, 미확인) - /players 디렉터리와 같은 판정. */
  registryFlag: boolean;
  /** 출전 기록이 있는 시즌 수(DNP 행 포함 - lib/playerProfile.ts GP 관례). */
  seasonsPlayed: number;
  /** seasonsPlayed + (active이고 아직 26-27 기록이 없으면 1) → "8번째 시즌". */
  seasonsInLeague: number;
  /** lib/seasonFocus.ts resolvePlayerSeasons의 입력(최신순). gp = 행 수(기존 GP 관례), gpPlayed = 0분 DNP 제외. */
  seasonsPlayedDesc: { seasonName: string; gp: number; gpPlayed: number }[];
  /** 마지막으로 실제 뛴(종료 + 0분 초과) 경기. 전부 DNP면 마지막 종료 경기를 played=false로. */
  lastPlayed: LastPlayedGame | null;
  /** 커리어 전 경기 행(최신순) - 상대별 통산·마지막 장면 카드가 재사용. */
  careerGames: CareerGameRow[];
};

type RosterRow = { tcode: string; back_num: string | null; pos: string | null; note: string | null; source: string | null };
type ChangeRow = {
  tcode: string;
  change: ChangeKind;
  role: string | null;
  prev_tcode: string | null;
  next_tcode: string | null;
  prev_season_name: string | null;
  note: string | null;
};

function startYear(season: string): number {
  return Number(season.slice(0, 4));
}

/**
 * 선수 한 명의 로스터 상태. 쿼리 4개(season_roster 1행, roster_changes ≤2행, teams, 커리어 경기 페이지네이션)를
 * 병렬로. 페이지가 이미 getPlayerCareerGames 행을 갖고 있으면 careerRows로 넘겨 재조회를 피한다.
 */
export async function getPlayerRosterStatus(pcode: string, careerRows?: CareerGameRow[]): Promise<PlayerRosterStatus> {
  const season = PRESEASON_SEASON;
  const prevSeason = prevSeasonName(season);
  const [rosterRes, changesRes, teamsRes, career] = await Promise.all([
    supabase.from("season_roster").select("tcode, back_num, pos, note, source").eq("season_name", season).eq("pcode", pcode).limit(1),
    supabase.from("roster_changes").select("tcode, change, role, prev_tcode, next_tcode, prev_season_name, note").eq("season_name", season).eq("pcode", pcode),
    supabase.from("teams").select("tcode, name"),
    careerRows ? Promise.resolve(careerRows) : getPlayerCareerGames(pcode),
  ]);
  const roster = ((rosterRes.data ?? []) as RosterRow[])[0] ?? null;
  const changes = (changesRes.data ?? []) as ChangeRow[];
  const rawName = new Map((teamsRes.data ?? []).map((t) => [t.tcode as string, t.name as string]));
  const nameFor = (tcode: string | null, seasonName: string | null) =>
    tcode ? displayTeamName(tcode, rawName.get(tcode) ?? tcode, seasonName) : null;

  // 커리어 행은 최신순 보장(인자로 받은 배열은 순서를 믿지 않는다).
  const games = [...career].sort((a, b) => (a.gameDate < b.gameDate ? 1 : a.gameDate > b.gameDate ? -1 : a.gmkey < b.gmkey ? 1 : -1));
  const gpBySeason = new Map<string, { gp: number; gpPlayed: number }>();
  for (const g of games) {
    const cur = gpBySeason.get(g.seasonName) ?? { gp: 0, gpPlayed: 0 };
    cur.gp += 1;
    if (g.min > 0) cur.gpPlayed += 1;
    gpBySeason.set(g.seasonName, cur);
  }
  const seasonsPlayedDesc = [...gpBySeason.entries()].map(([seasonName, v]) => ({ seasonName, ...v })).sort((a, b) => (a.seasonName < b.seasonName ? 1 : -1));
  const isFinal = (g: CareerGameRow) => g.isEnded && g.teamScore != null && g.oppScore != null;
  const lastRow = games.find((g) => isFinal(g) && g.min > 0) ?? games.find(isFinal) ?? null;
  const lastPlayed: LastPlayedGame | null = lastRow
    ? {
        gmkey: lastRow.gmkey,
        gameDate: lastRow.gameDate,
        seasonName: lastRow.seasonName,
        seasonCategory: lastRow.seasonCategory,
        tcode: lastRow.tcode,
        oppTcode: lastRow.oppTcode,
        isHome: lastRow.isHome,
        teamScore: lastRow.teamScore as number,
        oppScore: lastRow.oppScore as number,
        won: (lastRow.teamScore as number) > (lastRow.oppScore as number),
        backNum: lastRow.backNum,
        pos: normalizePos(lastRow.pos),
        played: lastRow.min > 0,
        min: lastRow.min,
        pts: lastRow.pts,
        reb: lastRow.reb,
        ast: lastRow.ast,
      }
    : null;

  // 해먼즈처럼 옛 팀 'out' + 새 팀 'in' 두 행이 있을 수 있다 - 명단이 있으면 그 팀의 in/stay/new 행을 우선.
  const onChange = changes.find((c) => c.change !== "out" && (!roster || c.tcode === roster.tcode)) ?? changes.find((c) => c.change !== "out") ?? null;
  const outChange = changes.find((c) => c.change === "out") ?? null;

  const seasonsPlayed = seasonsPlayedDesc.length;
  const base = {
    pcode,
    season,
    seasonsPlayed,
    seasonsPlayedDesc,
    lastPlayed,
    careerGames: games,
    rosterNote: roster?.note ?? null,
    rosterSource: roster?.source ?? null,
    registryFlag: !!roster?.note?.includes("등록상태"),
  };

  if (roster) {
    const tcode = roster.tcode;
    const change = (onChange?.change as Exclude<ChangeKind, "out"> | undefined) ?? null;
    const prevSeasonOf = onChange?.prev_season_name ?? (change === "stay" ? prevSeason : null);
    const prevTcode = change === "in" ? (onChange?.prev_tcode ?? null) : change === "stay" ? tcode : null;
    const sameTeamLast = lastPlayed?.tcode === tcode;
    const backFromRoster = (roster.back_num ?? "").trim() || null;
    const gap = prevSeasonOf ? Math.max(0, startYear(season) - startYear(prevSeasonOf) - 1) : null;
    return {
      ...base,
      state: "active",
      tcode,
      teamName: nameFor(tcode, season),
      backNum: backFromRoster ?? (sameTeamLast ? (lastPlayed?.backNum ?? null) : null),
      backNumAsLastSeason: !backFromRoster && sameTeamLast && !!lastPlayed?.backNum,
      backNumSeason: !backFromRoster && sameTeamLast && lastPlayed?.backNum ? lastPlayed.seasonName : null,
      pos: normalizePos(roster.pos) ?? normalizePos(lastPlayed?.pos ?? null),
      role: onChange?.role ?? roleFromNote(roster.note),
      change,
      isTransfer: change === "in" && !!prevTcode && prevTcode !== tcode,
      isReturn: change === "in" && !!prevSeasonOf && prevSeasonOf !== prevSeason,
      gapSeasons: gap,
      prevTcode,
      prevTeamName: nameFor(prevTcode, prevSeasonOf),
      prevSeasonName: prevSeasonOf,
      nextTcode: null,
      nextTeamName: null,
      note: onChange?.note ?? null,
      seasonsInLeague: seasonsPlayed + (gpBySeason.has(season) ? 0 : 1),
    };
  }

  if (outChange) {
    const tcode = outChange.tcode;
    const prevSeasonOf = outChange.prev_season_name ?? lastPlayed?.seasonName ?? prevSeason;
    const nextTcode = outChange.next_tcode ?? null;
    return {
      ...base,
      state: "departed",
      tcode,
      teamName: nameFor(tcode, prevSeasonOf),
      backNum: lastPlayed?.backNum ?? null,
      backNumAsLastSeason: !!lastPlayed?.backNum,
      backNumSeason: lastPlayed?.backNum ? lastPlayed.seasonName : null,
      pos: normalizePos(lastPlayed?.pos ?? null),
      role: null,
      change: null,
      isTransfer: false,
      isReturn: false,
      gapSeasons: null,
      prevTcode: tcode,
      prevTeamName: nameFor(tcode, prevSeasonOf),
      prevSeasonName: prevSeasonOf,
      nextTcode,
      nextTeamName: nameFor(nextTcode, season),
      note: outChange.note ?? null,
      seasonsInLeague: seasonsPlayed,
    };
  }

  const tcode = lastPlayed?.tcode ?? null;
  return {
    ...base,
    state: "archive",
    tcode,
    teamName: nameFor(tcode, lastPlayed?.seasonName ?? null),
    backNum: lastPlayed?.backNum ?? null,
    backNumAsLastSeason: !!lastPlayed?.backNum,
    backNumSeason: lastPlayed?.backNum ? lastPlayed.seasonName : null,
    pos: normalizePos(lastPlayed?.pos ?? null),
    role: null,
    change: null,
    isTransfer: false,
    isReturn: false,
    gapSeasons: null,
    prevTcode: tcode,
    prevTeamName: nameFor(tcode, lastPlayed?.seasonName ?? null),
    prevSeasonName: lastPlayed?.seasonName ?? null,
    nextTcode: null,
    nextTeamName: null,
    note: null,
    seasonsInLeague: seasonsPlayed,
  };
}
