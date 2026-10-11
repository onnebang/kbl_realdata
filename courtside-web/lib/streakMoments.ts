import {
  clockOf,
  holdersLine,
  nextTarget,
  rankInfo,
  TOP_RANKS,
  verdictText,
  type BoardSummary,
  type RankInfo,
  type RecordContext,
  type RecordEvent,
  type RecordMoment,
  type RecordTimelineOptions,
  type ValueFmt,
} from "./records";
import { STREAK_BOARD, type StreakContext, type StreakEntry, type StreakKind } from "./streakKinds";

// 역대 기록 3단계 라이브 엔진(연속 기록) - 설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md §5
//
// 이벤트를 한 번 훑으며 (1) 선수가 경기에 처음 나오는 순간 연속 출장 N경기째, (2) 슛 연속(경기 간: 앞 경기에서 이어진 것 / 한 경기 안)을 판정해
// 서버가 내려준 보드(StreakContext)·요약(RecordContext)의 TOP10과 비교한다. 순수 함수 - 서버 전용 모듈을 import하지 않는다.

export const MILESTONE_FROM = 100;
export const MILESTONE_STEP = 50;
export const isMilestone = (n: number) => n >= MILESTONE_FROM && n % MILESTONE_STEP === 0;

type ShotKind = "fg" | "tp" | "ft";
type Res = "made" | "miss";
const SHOT_KINDS: ShotKind[] = ["fg", "tp", "ft"];
const SHOT: Record<ShotKind, { made: string[]; miss: string[]; word: string; ga: string }> = {
  fg: { made: ["201", "205", "207"], miss: ["202", "206", "208"], word: "야투", ga: "야투가" },
  tp: { made: ["205"], miss: ["206"], word: "3점슛", ga: "3점슛이" },
  ft: { made: ["203"], miss: ["204"], word: "자유투", ga: "자유투가" },
};
const RES_WORD: Record<Res, string> = { made: "성공", miss: "실패" };
/** 임박(near) 기준 - 다음 기록 선과의 차가 이 값 이하일 때만 패널에 올린다. */
const NEAR_GAP: Record<ShotKind, Record<Res, number>> = { fg: { made: 2, miss: 2 }, tp: { made: 1, miss: 2 }, ft: { made: 3, miss: 1 } };
const cnt: ValueFmt = (v) => `${v}개`;
const gameCnt: ValueFmt = (v) => `${v}경기`;
const levelOf = (i: RankInfo) => (i.breaks ? 0 : i.rank);
const whoOf = (res: Res) => (res === "miss" ? "불명예" : "KBL");
const crossKind = (kind: ShotKind, res: Res) => `x${kind}_${res}` as StreakKind;
const singleBoard = (kind: ShotKind, res: Res) => `pg.s${kind}_${res}.max`;

/** 연속 보드의 항목들을 순위 요약으로 - 비교할 "다른 연속들". 본인의 *진행 중* 행(지금 재고 있는 바로 그 연속)만 빼고, 본인이 예전에 끝낸 연속은 종전 기록으로 남긴다. */
export function summaryOf(entries: StreakEntry[], excludePcode?: string): BoardSummary {
  const list = entries.filter((e) => !(e.pcode === excludePcode && e.active)).sort((a, b) => b.v - a.v);
  const tops: number[] = [];
  const holders: BoardSummary["holders"] = [];
  let rank = 0;
  let last: number | null = null;
  list.forEach((e, i) => {
    if (e.v !== last) {
      rank = i + 1;
      last = e.v;
    }
    if (rank <= TOP_RANKS) tops.push(e.v);
    if (rank <= 3 && holders.length < 6) holders.push({ v: e.v, who: e.who, d: e.d });
  });
  return { tops, holders };
}

/**
 * 연속 출장 N경기째를 알릴 만한가 - 순위가 좋아졌거나(10위 안 처음 진입 포함) 50경기 단위 이정표일 때만.
 * 이정현처럼 신기록을 매 경기 이어가는 것은 알리지 않는다(토스트·패널·리포트·경기 전 도전 모두).
 */
export function streakVerdict(entries: StreakEntry[], pcode: string, n: number, milestone: boolean, before = n - 1) {
  const s = summaryOf(entries, pcode);
  const info = rankInfo(s.tops, n, "max");
  const beforeInfo = before > 0 ? rankInfo(s.tops, before, "max") : null;
  const ranked = info != null && info.rank <= TOP_RANKS ? info : null;
  const improved = ranked != null && (beforeInfo == null || beforeInfo.rank > TOP_RANKS || ranked.rank < beforeInfo.rank || (ranked.breaks && !beforeInfo.breaks));
  return { s, ranked, worthy: improved || milestone };
}
const gpVerdict = (entries: StreakEntry[], pcode: string, n: number) => streakVerdict(entries, pcode, n, isMilestone(n));

type PState = {
  run: Record<ShotKind, Record<Res, number>>;
  carried: Record<ShotKind, Record<Res, boolean>>;
  single: Record<ShotKind, Record<Res, number>>;
  best: Record<ShotKind, Record<Res, number>>;
};
const zero = <T,>(v: T): Record<ShotKind, Record<Res, T>> => ({ fg: { made: v, miss: v }, tp: { made: v, miss: v }, ft: { made: v, miss: v } });

/**
 * 연속 기록 순간들. ctx는 한 경기 안 보드(pg.s{fg,tp,ft}_{made,miss}.max)의 요약이고 streaks는 연속 출장·경기 간 연속의 보드와 이 경기 직전 상태다(둘 다 null일 수 있다).
 * 종료 경기: 한 경기 안 보드는 ctx.validated(테이블에 이 경기 행이 있는 것)만, 연속 출장·경기 간 연속은 이 경기 로그 행이 있는 것만 남긴다.
 * finals를 주면 파이썬 후보·로그와 맞출 값을 채운다 - 한 경기 안 최대 연속(5 이상) `${board}|G|${pcode}|`, 경기 간 연속의 경기 끝 길이 `${종류}|${pcode}`.
 */
export function buildStreakMoments(
  ctx: RecordContext | null,
  streaks: StreakContext | null,
  events: RecordEvent[],
  opts: RecordTimelineOptions,
  finals?: Map<string, number>
): RecordMoment[] {
  const out: RecordMoment[] = [];
  const provisional = !opts.final;
  const validated = ctx?.validated ? new Set(ctx.validated) : null;
  const known = new Set(streaks?.known ?? []);
  const players = new Map<string, PState>();
  const seen = new Set<string>();
  const lastEmit = new Map<string, { level: number; value: number }>();
  const openNear = new Map<string, RecordMoment>();

  const closeNear = (key: string, at: number) => {
    const open = openNear.get(key);
    if (open) {
      open.until = at;
      openNear.delete(key);
    }
  };
  const pstate = (pcode: string): PState => {
    let ps = players.get(pcode);
    if (!ps) {
      const st = known.has(pcode) ? streaks?.state[pcode] : undefined;
      const run = zero(0);
      for (const kind of SHOT_KINDS) for (const res of ["made", "miss"] as Res[]) run[kind][res] = st?.[crossKind(kind, res)]?.before ?? 0;
      const carried = zero(false);
      for (const kind of SHOT_KINDS) for (const res of ["made", "miss"] as Res[]) carried[kind][res] = run[kind][res] > 0;
      ps = { run, carried, single: zero(0), best: zero(0) };
      players.set(pcode, ps);
    }
    return ps;
  };

  type Who = { pcode: string; name: string; tcode: string; idx: number; clock: string };

  /** 순위 보드 판정 - 상위 10위 안이고 순위가 좋아질 때(신기록 이후엔 값이 늘 때마다)만 알린다. */
  const emit = (a: Who & { key: string; board: string; summary: BoardSummary; value: number; label: string; fmt: ValueFmt; who: string }) => {
    const info = rankInfo(a.summary.tops, a.value, "max");
    if (!info || info.rank > TOP_RANKS) return;
    const level = levelOf(info);
    const prev = lastEmit.get(a.key);
    if (prev && !(level < prev.level || (level === 0 && a.value > prev.value))) return;
    lastEmit.set(a.key, { level, value: a.value });
    closeNear(a.key, a.idx);
    out.push({
      id: `${a.key}|${level}|${a.value}|done`, idx: a.idx, until: Infinity, clock: a.clock, phase: "done",
      board: a.board, bucket: "G", subject: a.pcode, period: "", scope: "p", name: a.name, tcode: a.tcode, value: a.value,
      rank: info.rank, tie: info.tie, breaks: info.breaks, remaining: 0,
      text: `${a.label} ${verdictText(info, a.fmt, a.who)}`, detail: holdersLine(a.summary, info, a.fmt),
      provisional, sig: level,
    });
  };

  /** 임박 - 현재 값이 다음 기록 선(상위 3위 값·신기록)과 gap 이내이면 패널용 near를 새로 연다. */
  const near = (a: Who & { key: string; board: string; summary: BoardSummary; value: number; label: string; fmt: ValueFmt; who: string; gap: number }) => {
    closeNear(a.key, a.idx);
    if (a.summary.tops.length === 0) return;
    const target = nextTarget(a.summary.tops, a.value);
    if (target == null || target - a.value > a.gap) return;
    const tInfo = rankInfo(a.summary.tops, target, "max");
    if (!tInfo) return;
    const m: RecordMoment = {
      id: `${a.key}|${target}|near|${a.value}`, idx: a.idx, until: Infinity, clock: a.clock, phase: "near",
      board: a.board, bucket: "G", subject: a.pcode, period: "", scope: "p", name: a.name, tcode: a.tcode, value: a.value,
      rank: tInfo.rank, tie: tInfo.tie, breaks: tInfo.breaks, remaining: target - a.value,
      text: `${a.label} · ${target - a.value}개 더하면 ${verdictText(tInfo, a.fmt, a.who)}`, detail: holdersLine(a.summary, tInfo, a.fmt),
      provisional, sig: levelOf(tInfo),
    };
    openNear.set(a.key, m);
    out.push(m);
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (!e.pcode || !e.tcode || !e.action_code || !e.quarter || e.quarter === "PRE") continue;
    const pcode = e.pcode;
    const name = opts.names.player(pcode);
    const w = { pcode, name, tcode: e.tcode, idx, clock: clockOf(e) };

    // 연속 출장 - 그 선수의 첫 이벤트에서 "N경기째"(이 경기를 뛰었으니 before + 1)
    if (!seen.has(pcode)) {
      seen.add(pcode);
      const st = streaks && known.has(pcode) ? streaks.state[pcode]?.gp : undefined;
      if (streaks && st && (!streaks.final || st.after != null)) {
        const n = streaks.final ? (st.after as number) : st.before + 1;
        const { s, ranked, worthy } = gpVerdict(streaks.boards.gp, pcode, n);
        finals?.set(`gp|${pcode}`, n);
        if (worthy) {
          out.push({
            id: `gp|${pcode}|${n}`, idx, until: Infinity, clock: w.clock, phase: "done",
            board: STREAK_BOARD.gp, bucket: "G", subject: pcode, period: "", scope: "p", name, tcode: e.tcode, value: n,
            rank: ranked ? ranked.rank : TOP_RANKS + 1, tie: ranked ? ranked.tie : false, breaks: ranked ? ranked.breaks : false, remaining: 0,
            text: ranked ? `연속 출장 ${n}경기째 ${verdictText(ranked, gameCnt, "KBL")}` : `연속 출장 ${n}경기 달성`,
            detail: ranked ? holdersLine(s, ranked, gameCnt) : "",
            provisional, sig: ranked ? levelOf(ranked) : 50,
          });
        }
      }
    }

    // 슛 연속
    for (const kind of SHOT_KINDS) {
      const res: Res | null = SHOT[kind].made.indexOf(e.action_code) >= 0 ? "made" : SHOT[kind].miss.indexOf(e.action_code) >= 0 ? "miss" : null;
      if (!res) continue;
      const oth: Res = res === "made" ? "miss" : "made";
      const ps = pstate(pcode);
      ps.run[kind][res] += 1;
      ps.run[kind][oth] = 0;
      ps.carried[kind][oth] = false;
      ps.single[kind][res] += 1;
      ps.single[kind][oth] = 0;
      ps.best[kind][res] = Math.max(ps.best[kind][res], ps.single[kind][res]);

      // 한 경기 안(요약기 보드). 종료 경기는 테이블에 이 경기 행이 있는 것만.
      const sBoard = singleBoard(kind, res);
      const sSummary = ctx?.boards[`${sBoard}|G`];
      if (sSummary && (!opts.final || (validated != null && validated.has(`${sBoard}|G|${pcode}|`)))) {
        const base = { ...w, key: `${sBoard}|${pcode}`, board: sBoard, summary: sSummary, value: ps.single[kind][res], label: `한 경기 ${SHOT[kind].word} 연속 ${RES_WORD[res]} ${ps.single[kind][res]}개`, fmt: cnt, who: whoOf(res) };
        emit(base);
        near({ ...base, gap: NEAR_GAP[kind][res] });
      }

      // 경기 간 - 앞 경기에서 이어진 연속만(이 경기 안에서 시작한 연속은 위의 한 경기 보드가 알린다)
      const ckind = crossKind(kind, res);
      if (streaks && known.has(pcode) && ps.carried[kind][res] && (!streaks.final || streaks.state[pcode]?.[ckind] != null)) {
        const cSummary = summaryOf(streaks.boards[ckind], pcode);
        const base = { ...w, key: `${STREAK_BOARD[ckind]}|${pcode}`, board: STREAK_BOARD[ckind], summary: cSummary, value: ps.run[kind][res], label: `${SHOT[kind].word} 연속 ${RES_WORD[res]} ${ps.run[kind][res]}개(경기 간)`, fmt: cnt, who: whoOf(res) };
        emit(base);
        near({ ...base, gap: NEAR_GAP[kind][res] });
      }
    }
  }

  if (finals) {
    for (const [pcode, ps] of players) {
      for (const kind of SHOT_KINDS) {
        for (const res of ["made", "miss"] as Res[]) {
          if (ps.best[kind][res] >= 5) finals.set(`${singleBoard(kind, res)}|G|${pcode}|`, ps.best[kind][res]);
          if (known.has(pcode)) finals.set(`${crossKind(kind, res)}|${pcode}`, ps.run[kind][res]);
        }
      }
    }
  }
  for (const key of [...openNear.keys()]) closeNear(key, events.length);
  return out;
}

/** 경기 전 "기록 도전" 한 줄(이름·팀 칩은 recordChanceList가 붙인다). */
export type StreakChance = { id: string; pcode: string; name: string; tcode?: string; text: string; detail: string; sig: number };

/**
 * 경기 전 도전: 오늘 출전하면 연속 출장이 순위에 오르는 선수, 성공 연속이 이어져 다음 개수로 순위가 좋아지는 선수.
 * 상태를 믿을 수 없는 선수(known 밖)는 만들지 않는다. 알릴 만한 순(신기록 먼저)으로 최대 6개.
 */
export function buildStreakChances(streaks: StreakContext): StreakChance[] {
  const out: StreakChance[] = [];
  for (const pcode of streaks.known) {
    const st = streaks.state[pcode];
    const p = streaks.players[pcode];
    if (!st || !p) continue;
    const who = { pcode, name: p.name, ...(p.tcode ? { tcode: p.tcode } : {}) };
    const gp = st.gp?.before ?? 0;
    if (gp > 0) {
      const { s, ranked, worthy } = gpVerdict(streaks.boards.gp, pcode, gp + 1);
      if (worthy && ranked) out.push({ ...who, id: `gp|${pcode}`, text: `오늘 출전하면 연속 출장 ${gp + 1}경기째 ${verdictText(ranked, gameCnt, "KBL")}`, detail: holdersLine(s, ranked, gameCnt), sig: levelOf(ranked) });
      else if (worthy) out.push({ ...who, id: `gp|${pcode}`, text: `오늘 출전하면 연속 출장 ${gp + 1}경기 달성`, detail: "", sig: 50 });
    }
    for (const kind of SHOT_KINDS) {
      const before = st[crossKind(kind, "made")]?.before ?? 0;
      if (before <= 0) continue;
      const s = summaryOf(streaks.boards[crossKind(kind, "made")], pcode);
      const info = rankInfo(s.tops, before + 1, "max");
      const beforeInfo = rankInfo(s.tops, before, "max");
      if (!info || info.rank > TOP_RANKS) continue;
      if (beforeInfo && beforeInfo.rank <= TOP_RANKS && !(info.rank < beforeInfo.rank || (info.breaks && !beforeInfo.breaks))) continue;
      out.push({ ...who, id: `${crossKind(kind, "made")}|${pcode}`, text: `다음 ${SHOT[kind].ga} 들어가면 연속 성공 ${before + 1}개째 ${verdictText(info, cnt, "KBL")}`, detail: holdersLine(s, info, cnt), sig: levelOf(info) + 100 });
    }
  }
  return out.sort((a, b) => a.sig - b.sig || a.name.localeCompare(b.name, "ko")).slice(0, 6);
}
