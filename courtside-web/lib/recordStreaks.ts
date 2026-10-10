import { cachedFn, TAG, TTL } from "./cachePolicy";
import { getTeamRoster } from "./playerPageData";
import { isRecordEligible } from "./recordBook";
import { supabaseServer as supabase } from "./supabaseServer";
import { KIND_OF_BOARD, STREAK_BOARD, STREAK_KINDS, type StreakContext, type StreakEntry, type StreakKind } from "./streakKinds";

// 연속 기록(3단계) 서버 쪽 - record_entries의 연속 보드 7개와 record_streak_log(최근 120일)를 읽어 "이 경기 직전의 연속 상태" 요약(StreakContext)을 만든다.
// 설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md §5. 테이블 갱신은 tools/record_streaks.py(경기 종료 정산이 노트북에서 호출).

export type StreakBoardRow = { board: string; subject: string; period: string; value: number; name: string; date: string };
export type StreakLogRow = { gmkey: string; pcode: string; kind: string; before_len: number; after_len: number; alive: boolean };

const PAGE = 1000;
const CATEGORIES = ["정규시즌", "플레이오프", "챔피언결정전"];

/** 순수 함수 - 보드 행과 로그 행으로 StreakContext를 만든다. 보드도 상태도 없으면 null. */
export function summarizeStreaks(args: {
  boardRows: StreakBoardRow[];
  logRows: StreakLogRow[];
  gmkey: string;
  final: boolean;
  asOf: string;
  players: Record<string, { name: string; tcode?: string }>;
  /** 경기 전: 로그가 그 팀의 직전 경기까지 반영된 팀들. 종료 경기는 쓰지 않는다. */
  freshTeams: Set<string> | null;
  /** 정규시즌 경기인가 - 연속 출장은 정규시즌만 세므로 플레이오프·챔프전에서는 그 상태를 쓰지 않는다(기본 true). */
  regular?: boolean;
}): StreakContext | null {
  const boards = Object.fromEntries(STREAK_KINDS.map((k) => [k, [] as StreakEntry[]])) as Record<StreakKind, StreakEntry[]>;
  for (const r of args.boardRows) {
    const kind = KIND_OF_BOARD[r.board];
    if (kind) boards[kind].push({ v: r.value, pcode: r.subject, who: r.name, active: r.period.indexOf("A:") === 0, d: r.date });
  }
  for (const k of STREAK_KINDS) boards[k].sort((a, b) => b.v - a.v);
  const known: string[] = [];
  for (const [pcode, p] of Object.entries(args.players)) {
    if (args.final || (p.tcode != null && args.freshTeams != null && args.freshTeams.has(p.tcode))) known.push(pcode);
  }
  const state: StreakContext["state"] = {};
  for (const r of args.logRows) {
    const kind = STREAK_KINDS.find((k) => k === r.kind);
    if (!kind || (kind === "gp" && args.regular === false)) continue;
    if (args.final ? r.gmkey !== args.gmkey : !r.alive) continue;
    const slot = state[r.pcode] ?? {};
    slot[kind] = args.final ? { before: r.before_len, after: r.after_len } : { before: r.after_len };
    state[r.pcode] = slot;
  }
  const hasBoard = STREAK_KINDS.some((k) => boards[k].length > 0);
  if (!hasBoard && Object.keys(state).length === 0) return null;
  return { asOf: args.asOf, final: args.final, boards, state, known, players: args.players };
}

const BOARD_LIST = STREAK_KINDS.map((k) => STREAK_BOARD[k]);

/** 연속 보드 7개의 보관 행 전부(수백 행) - 10분 캐시, 정산이 'records' 태그로 즉시 비운다. 조회 에러는 던진다(빈 배열을 캐시에 굳히지 않는다). */
const fetchStreakBoards = cachedFn(
  async (): Promise<StreakBoardRow[]> => {
    const out: StreakBoardRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("record_entries")
        .select("board, subject, period, value, game_date, subject_name")
        .in("board", BOARD_LIST)
        .order("board")
        .order("bucket")
        .order("gmkey")
        .order("subject")
        .order("period")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`streakBoards: ${error.message}`);
      for (const r of data ?? []) {
        out.push({ board: r.board as string, subject: r.subject as string, period: r.period as string, value: r.value as number, name: r.subject_name as string, date: r.game_date as string });
      }
      if (!data || data.length < PAGE) break;
    }
    return out;
  },
  { name: "streakBoards", ttl: TTL.scheduled, tags: () => [TAG.records] }
);

/** 한 경기의 로그 행(약 130행). */
const fetchLogByGame = cachedFn(
  async (gmkey: string): Promise<StreakLogRow[]> => {
    const { data, error } = await supabase.from("record_streak_log").select("gmkey, pcode, kind, before_len, after_len, alive").eq("gmkey", gmkey).limit(3000);
    if (error) throw new Error(`streakLogGame: ${error.message}`);
    return (data ?? []) as StreakLogRow[];
  },
  { name: "streakLogGame", ttl: TTL.scheduled, tags: () => [TAG.records] }
);

/** 선수들의 alive 로그 행(그 선수·종류의 최신 행) - pcodes는 콤마로 이은 문자열(캐시 키). */
const fetchAliveLog = cachedFn(
  async (pcodesKey: string): Promise<StreakLogRow[]> => {
    const pcodes = pcodesKey.split(",").filter(Boolean);
    if (pcodes.length === 0) return [];
    const { data, error } = await supabase.from("record_streak_log").select("gmkey, pcode, kind, before_len, after_len, alive").in("pcode", pcodes).eq("alive", true).limit(5000);
    if (error) throw new Error(`streakLogAlive: ${error.message}`);
    return (data ?? []) as StreakLogRow[];
  },
  { name: "streakLogAlive", ttl: TTL.scheduled, tags: () => [TAG.records] }
);

/** 그 팀이 이 경기 직전에 치른 종료 경기의 gmkey(없으면 null). */
const fetchPrevGame = cachedFn(
  async (tcode: string, date: string, start: string, gmkey: string): Promise<string | null> => {
    const { data, error } = await supabase
      .from("games")
      .select("gmkey, game_date, game_start")
      .eq("is_ended", true)
      .in("season_category", CATEGORIES)
      .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`)
      .lte("game_date", date)
      .order("game_date", { ascending: false })
      .order("game_start", { ascending: false })
      .limit(4);
    if (error) throw new Error(`streakPrevGame: ${error.message}`);
    const prev = (data ?? []).find((g) => g.gmkey !== gmkey && ((g.game_date as string) < date || String(g.game_start ?? "").slice(0, 5) < start));
    return prev ? (prev.gmkey as string) : null;
  },
  { name: "streakPrevGame", ttl: TTL.scheduled, tags: () => [TAG.records] }
);

/** 팀 로스터는 하루 단위로 안 바뀐다 - 1시간 캐시, 빈 로스터는 캐시에 안 넣는다(호출부 catch가 박스 선수만으로 이어 간다). */
const cachedRoster = cachedFn(
  async (tcode: string, season: string) => {
    const roster = await getTeamRoster(tcode, season);
    if (!roster.length) throw new Error(`streakRoster: empty ${tcode}/${season}`);
    return roster;
  },
  { name: "streakRoster", ttl: TTL.batchDaily }
);

/**
 * 경기 페이지용 - 이 경기에 나올 선수들의 연속 상태 요약. 대상이 아니거나(전시경기·60일 초과) 읽을 게 없으면 null.
 * 경기 전·라이브: 로그의 alive 행(= 직전까지 이어지던 연속)을 쓰되, 그 팀의 직전 경기까지 로그가 반영된 팀만 믿는다(클라우드만 정산한 날은 한 경기 늦다).
 * 종료 경기: 이 경기의 로그 행(before·after).
 */
export async function getStreakContext(
  game: {
    gmkey: string; game_date: string; game_start: string | null; season_category: string; season_name: string;
    home_team?: { tcode: string } | null; away_team?: { tcode: string } | null;
  },
  final: boolean,
  boxPlayers: { pcode: string; name: string; tcode?: string }[]
): Promise<StreakContext | null> {
  if (!isRecordEligible(game, Date.now())) return null;
  const tcodes = [game.home_team?.tcode, game.away_team?.tcode].filter((t): t is string => !!t);
  const rosters = await Promise.all(tcodes.map((t) => cachedRoster(t, game.season_name).catch(() => [] as { pcode: string; name: string }[])));
  const players: Record<string, { name: string; tcode?: string }> = {};
  rosters.forEach((list, i) => list.forEach((r) => (players[r.pcode] = { name: r.name, tcode: tcodes[i] })));
  for (const p of boxPlayers) players[p.pcode] = { name: p.name, tcode: p.tcode };
  const start = (game.game_start ?? "").slice(0, 5);
  const freshTeams = final
    ? null
    : new Set(
        (
          await Promise.all(
            tcodes.map(async (t) => {
              const prev = await fetchPrevGame(t, game.game_date, start, game.gmkey);
              if (prev == null) return t; // 그 팀의 첫 경기 - 이어받을 상태가 없으니 믿어도 된다
              return (await fetchLogByGame(prev)).length > 0 ? t : null; // 플레이오프 경기는 연속 출장 행이 없으므로 종류와 상관없이 그 경기 로그가 있는지만 본다
            })
          )
        ).filter((t): t is string => t != null)
      );
  const [boardRows, logRows] = await Promise.all([fetchStreakBoards(), final ? fetchLogByGame(game.gmkey) : fetchAliveLog(Object.keys(players).sort().join(","))]);
  return summarizeStreaks({ boardRows, logRows, gmkey: game.gmkey, final, asOf: `${game.game_date} ${start}`.trim(), players, freshTeams, regular: game.season_category === "정규시즌" });
}
