import { cachedFn, TAG, TTL } from "./cachePolicy";
import { TOP_RANKS, type BoardSummary, type RecordContext } from "./records";
import { supabaseServer as supabase } from "./supabaseServer";

// 역대 기록(Record Book) 서버 쪽 - record_entries(보드·구간별 순위 <= 15 보관)를 읽어 "이 경기 이전" 기준 TOP10 요약(RecordContext)을 만든다.
// 설계: docs/superpowers/specs/2026-10-08-record-book-design.md §8.1. 테이블 갱신은 tools/record_book.py(경기 종료 정산이 호출).

export type RecordEntry = { board: string; bucket: string; gmkey: string; subject: string; period: string; value: number; date: string; start: string; name: string };

const PAGE = 1000; // PostgREST 한 번에 최대 1,000행
const ELIGIBLE_CATEGORIES = new Set(["정규시즌", "플레이오프", "챔피언결정전"]);
/** 보관 범위(순위 <= 15)는 "지금" 기준이라 오래된 경기를 그 시점 기준으로 다시 계산하면 순위가 틀린다 - 이보다 오래된 경기는 기능을 끈다. */
export const RECORD_MAX_AGE_DAYS = 60;

export function isRecordEligible(game: { game_date: string; season_category: string }, nowMs: number): boolean {
  return ELIGIBLE_CATEGORIES.has(game.season_category) && (nowMs - Date.parse(game.game_date)) / 86_400_000 <= RECORD_MAX_AGE_DAYS;
}

const isMin = (board: string) => board.endsWith(".min");

/** 순수 함수 - 항목들에서 경기 `at` 이전 기준 보드 요약과(종료 경기면) 이 경기 행 키 목록을 만든다. 보드가 하나도 없으면 null. */
export function summarizeRecordBook(entries: RecordEntry[], at: { date: string; start: string; gmkey: string }, final: boolean): RecordContext | null {
  // 같은 날은 경기 시작 시각이 더 이른 경기만(같은 시각에 시작한 경기끼리는 서로 모른다). 자기 자신은 항상 뺀다.
  const before = entries.filter((e) => e.gmkey !== at.gmkey && (e.date < at.date || (e.date === at.date && e.start < at.start)));
  const groups = new Map<string, RecordEntry[]>();
  const add = (key: string, e: RecordEntry) => {
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  };
  for (const e of before) {
    add(`${e.board}|${e.bucket}`, e);
    if (/^Q[1-4]$/.test(e.bucket)) add(`${e.board}|ALL`, e); // '전체(1~4Q 묶음)' - 연장은 섞지 않는다
  }
  const boards: Record<string, BoardSummary> = {};
  for (const [key, list] of groups) {
    const sign = isMin(key.split("|")[0]) ? 1 : -1;
    const sorted = [...list].sort((a, b) => sign * (a.value - b.value) || a.date.localeCompare(b.date) || a.gmkey.localeCompare(b.gmkey));
    const tops: number[] = [];
    const holders: BoardSummary["holders"] = [];
    let rank = 0;
    let last: number | null = null;
    sorted.forEach((e, i) => {
      if (e.value !== last) {
        rank = i + 1;
        last = e.value;
      }
      if (rank <= TOP_RANKS) tops.push(e.value);
      if (rank <= 3 && holders.length < 6) holders.push({ v: e.value, who: e.name, d: e.date });
    });
    if (tops.length) boards[key] = { tops, holders };
  }
  if (Object.keys(boards).length === 0) return null;
  const ctx: RecordContext = { asOf: `${at.date} ${at.start}`.trim(), boards };
  if (final) ctx.validated = entries.filter((e) => e.gmkey === at.gmkey).map((e) => `${e.board}|${e.bucket}|${e.subject}|${e.period}`);
  return ctx;
}

/** record_entries 전체(수천 행)를 10분 캐시로 - 조회 에러는 던진다(빈 배열을 캐시에 굳히지 않는다). 경기 종료 정산이 'records' 태그로 즉시 비운다. */
const fetchRecordEntries = cachedFn(
  async (): Promise<RecordEntry[]> => {
    const out: RecordEntry[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("record_entries")
        .select("board, bucket, gmkey, subject, period, value, game_date, game_start, subject_name")
        .order("board")
        .order("bucket")
        .order("gmkey")
        .order("subject")
        .order("period")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`recordEntries: ${error.message}`);
      for (const r of data ?? []) {
        out.push({
          board: r.board as string, bucket: r.bucket as string, gmkey: r.gmkey as string, subject: r.subject as string, period: r.period as string,
          value: r.value as number, date: r.game_date as string, start: ((r.game_start as string | null) ?? "").slice(0, 5), name: r.subject_name as string,
        });
      }
      if (!data || data.length < PAGE) break;
    }
    return out;
  },
  { name: "recordEntries", ttl: TTL.scheduled, tags: () => [TAG.records] }
);

/** 경기 페이지용 - 이 경기 이전 기준 역대 기록 요약. 대상이 아니거나(전시경기·60일 초과) 기록이 없으면 null. final = 종료된 경기. */
export async function getRecordContext(
  game: { gmkey: string; game_date: string; game_start: string | null; season_category: string },
  final: boolean
): Promise<RecordContext | null> {
  if (!isRecordEligible(game, Date.now())) return null;
  const entries = await fetchRecordEntries();
  if (entries.length === 0) return null;
  return summarizeRecordBook(entries, { date: game.game_date, start: (game.game_start ?? "").slice(0, 5), gmkey: game.gmkey }, final);
}
