import { clockOf, holdersLine, rankInfo, TOP_RANKS, verdictText, type RankInfo, type RecordContext, type RecordEvent, type RecordMoment, type RecordTimelineOptions, type ValueFmt } from "./records";

// 역대 기록 4단계 B 라이브 엔진 - 최다 점수차 역전승. 설계: docs/superpowers/specs/2026-10-11-record-book-phase4b-design.md §4
//
// 이벤트의 두 팀 점수(home_score/away_score)로 팀별 "지금까지 최대 열세"를 따라가며 보드 요약(tg.comeback.max|G)과 비교한다.
//  - 임박(near, 패널): 열세가 20점 이상인 채 아직 리드를 못 잡은 팀 - 열세가 늘 때마다 새로 열고, 리드를 잡으면 닫는다.
//  - 확정(done): TOP10에 드는 열세를 뒤집고 리드를 잡는 이벤트. 라이브는 잠정(이대로 이기면), 종료 경기는 이긴 팀의 마지막 리드 탈환 이벤트 한 번(테이블에 이 경기 행이 있을 때만).
// 순수 함수 - 서버 전용 모듈을 import하지 않는다.

export const COMEBACK_BOARD = "tg.comeback.max";
const KEY = `${COMEBACK_BOARD}|G`;
/** 임박 줄을 올리는 최대 열세(점) */
export const NEAR_FROM = 20;
/** 파이썬 후보 행의 최소 점수 - tools/record_book.py COMEBACK_MIN과 같아야 한다 */
export const COMEBACK_MIN = 15;
const pts: ValueFmt = (v) => `${v}점`;
const levelOf = (i: RankInfo) => (i.breaks ? 0 : i.rank);

export function buildComebackMoments(
  ctx: RecordContext | null,
  events: RecordEvent[],
  opts: RecordTimelineOptions,
  finals?: Map<string, number>
): RecordMoment[] {
  const out: RecordMoment[] = [];
  const home = opts.home;
  const away = opts.away;
  if (!home || !away) return out;
  const summary = ctx?.boards[KEY];
  const provisional = !opts.final;
  const worst: Record<string, number> = { [home]: 0, [away]: 0 };
  const lead: Record<string, number> = { [home]: 0, [away]: 0 };
  const open = new Map<string, RecordMoment>();
  const takeover = new Map<string, number>();
  const lastEmit = new Map<string, { level: number; value: number }>();
  let last: RecordEvent | null = null;

  const mk = (phase: "near" | "done", tc: string, idx: number, value: number, info: RankInfo, text: string, detail: string, remaining: number): RecordMoment => ({
    id: `cb|${phase}|${tc}|${value}`, idx, until: Infinity, clock: clockOf(events[idx]), phase,
    board: COMEBACK_BOARD, bucket: "G", subject: tc, period: "", scope: "t", name: opts.names.team(tc), tcode: tc, value,
    rank: info.rank, tie: info.tie, breaks: info.breaks, remaining, text, detail, provisional, sig: levelOf(info),
  });
  const closeNear = (tc: string, at: number) => {
    const o = open.get(tc);
    if (o) {
      o.until = at;
      open.delete(tc);
    }
  };
  const ensureNear = (tc: string, idx: number) => {
    if (!summary) return;
    const m = worst[tc];
    const cur = open.get(tc);
    if (cur && cur.value === m) return;
    closeNear(tc, idx);
    const tops = summary.tops;
    const info = rankInfo(tops, m, "max");
    if (!info) return;
    const name = opts.names.team(tc);
    let near: RecordMoment;
    if (info.rank <= TOP_RANKS) {
      near = mk("near", tc, idx, m, info, `${name} 최대 ${m}점 열세 · 이기면 역전승 ${verdictText(info, pts, "KBL")}`, holdersLine(summary, info, pts), 0);
    } else {
      const floor = tops[tops.length - 1];
      const target = rankInfo(tops, floor, "max");
      if (!target) return;
      near = mk("near", tc, idx, m, target, `${name} 최대 ${m}점 열세 · ${floor}점차가 되면 역전승 ${verdictText(target, pts, "KBL")}`, holdersLine(summary, target, pts), floor - m);
    }
    open.set(tc, near);
    out.push(near);
  };
  const liveDone = (tc: string, idx: number) => {
    if (!summary) return;
    const m = worst[tc];
    const info = rankInfo(summary.tops, m, "max");
    if (!info || info.rank > TOP_RANKS) return;
    const level = levelOf(info);
    const prev = lastEmit.get(tc);
    if (prev && !(level < prev.level || (level === 0 && m > prev.value))) return;     // 순위가 좋아질 때만(신기록은 값이 늘 때만) 다시 알린다
    lastEmit.set(tc, { level, value: m });
    out.push(mk("done", tc, idx, m, info, `${opts.names.team(tc)} ${m}점차 열세를 뒤집고 리드 · 이대로 이기면 ${verdictText(info, pts, "KBL")}`, holdersLine(summary, info, pts), 0));
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (e.home_score == null || e.away_score == null) continue;
    last = e;
    const margin = e.home_score - e.away_score;
    for (const tc of [home, away]) {
      const prev = lead[tc];
      const cur = tc === home ? margin : -margin;
      lead[tc] = cur;
      if (cur < 0 && -cur > worst[tc]) worst[tc] = -cur;
      if (cur > 0 && prev <= 0) {
        closeNear(tc, idx);
        takeover.set(tc, idx);
        if (!opts.final) liveDone(tc, idx);
      } else if (cur < 0 && worst[tc] >= NEAR_FROM) {
        ensureNear(tc, idx);
      }
    }
  }
  for (const tc of [home, away]) closeNear(tc, events.length);

  const winner = last ? (lead[home] > 0 ? home : lead[away] > 0 ? away : null) : null;
  if (winner) {
    const m = worst[winner];
    if (finals && m >= COMEBACK_MIN) finals.set(`${KEY}|${winner}|`, m);
    const at = takeover.get(winner);
    if (opts.final && summary && at != null && ctx?.validated?.includes(`${KEY}|${winner}|`)) {
      const info = rankInfo(summary.tops, m, "max");
      if (info && info.rank <= TOP_RANKS) {
        const loser = winner === home ? away : home;
        const h = holdersLine(summary, info, pts);
        out.push(mk("done", winner, at, m, info, `${opts.names.team(winner)} ${m}점차 열세를 뒤집은 역전승 ${verdictText(info, pts, "KBL")}`, `${opts.names.team(loser)} ${m}점 리드를 날림${h ? ` · ${h}` : ""}`, 0));
      }
    }
  }
  return out;
}
