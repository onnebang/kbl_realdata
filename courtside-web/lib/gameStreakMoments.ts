import { applyBoxEvent, emptyBoxLine, type BoxLine } from "./boxEvents";
import { clockOf, holdersLine, TOP_RANKS, verdictText, type RecordEvent, type RecordMoment, type RecordTimelineOptions, type ValueFmt } from "./records";
import { CG_KINDS, STREAK_BOARD, type CgKind, type StreakContext } from "./streakKinds";
import { streakVerdict } from "./streakMoments";

// 역대 기록 4단계 A 라이브 엔진 - 선수 연속 경기 6종(정규시즌 명단 기준)과 팀 연승·연패. 설계: docs/superpowers/specs/2026-10-11-record-book-phase4a-design.md §4
//
// 선수: 이벤트로 이 경기 누적(박스)을 쌓다가 **조건을 처음 채우는 이벤트**에서 N = (이 경기 직전 연속) + 1경기째를 판정한다. 종료 경기는 공식 박스를 담은 로그 행(after > before)이 있는 선수만 알리고,
//       이벤트가 조건을 못 채웠으면(이벤트-공식 불일치) 그 선수의 마지막 이벤트에서 보정한다.
// 팀:   경기 결과는 끝나야 알 수 있어 종료 경기(리포트·종료 경기 재생)와 경기 전 줄에서만 쓴다.
// 알릴 만한 순간은 streakVerdict(순위가 좋아지거나 이정표)뿐이다. 순수 함수 - 서버 전용 모듈을 import하지 않는다.

const gameCnt: ValueFmt = (v) => `${v}경기`;
const ddCount = (b: BoxLine) => [b.pts, b.reb, b.ast, b.stl, b.blk].filter((v) => v >= 10).length;

const CG: Record<CgKind, { short: string; cond: string; ok: (b: BoxLine) => boolean; from: number; step: number }> = {
  cg_pts10: { short: "득점 10+", cond: "오늘 10점 이상 넣으면", ok: (b) => b.pts >= 10, from: 50, step: 50 },
  cg_pts20: { short: "득점 20+", cond: "오늘 20점 이상 넣으면", ok: (b) => b.pts >= 20, from: 20, step: 10 },
  cg_dd: { short: "더블더블", cond: "오늘 더블더블을 하면", ok: (b) => ddCount(b) >= 2, from: 20, step: 10 },
  cg_reb10: { short: "리바운드 10+", cond: "오늘 리바운드 10개를 잡으면", ok: (b) => b.reb >= 10, from: 20, step: 10 },
  cg_tpm1: { short: "3점슛 성공", cond: "오늘 3점슛을 넣으면", ok: (b) => b.threePM >= 1, from: 20, step: 10 },
  cg_ast5: { short: "어시스트 5+", cond: "오늘 어시스트 5개를 하면", ok: (b) => b.ast >= 5, from: 20, step: 10 },
};
const isCgMilestone = (kind: CgKind, n: number) => n >= CG[kind].from && n % CG[kind].step === 0;
const levelOf = (rank: number, breaks: boolean) => (breaks ? 0 : rank);

export function buildGameStreakMoments(
  streaks: StreakContext | null,
  events: RecordEvent[],
  opts: RecordTimelineOptions,
  finals?: Map<string, number>
): RecordMoment[] {
  const out: RecordMoment[] = [];
  if (!streaks) return out;
  const provisional = !opts.final;
  const known = new Set(streaks.known);
  const boxes = new Map<string, BoxLine>();
  const reached = new Set<string>();
  const lastAt = new Map<string, { idx: number; tcode: string; clock: string }>();

  /** 선수 pcode의 kind 연속이 이 경기에서 이어졌다고 확정하는 순간(조건 충족 이벤트 또는 종료 경기 보정 위치). */
  const reach = (kind: CgKind, pcode: string, idx: number, tcode: string, clock: string) => {
    const key = `${kind}|${pcode}`;
    if (reached.has(key)) return;
    const st = known.has(pcode) ? streaks.state[pcode]?.[kind] : undefined;
    if (streaks.final && !(st && st.after != null && st.after > st.before)) return;      // 종료 경기: 공식 박스(로그)가 연속이 이어졌다고 한 선수만
    const n = streaks.final && st && st.after != null ? st.after : (st?.before ?? 0) + 1;
    reached.add(key);
    finals?.set(key, n);
    if (!known.has(pcode)) return;
    const v = streakVerdict(streaks.boards[kind], pcode, n, isCgMilestone(kind, n));
    if (!v.worthy) return;
    const r = v.ranked;
    out.push({
      id: `${kind}|${pcode}|${n}`, idx, until: Infinity, clock, phase: "done",
      board: STREAK_BOARD[kind], bucket: "G", subject: pcode, period: "", scope: "p", name: opts.names.player(pcode), tcode, value: n,
      rank: r ? r.rank : TOP_RANKS + 1, tie: r ? r.tie : false, breaks: r ? r.breaks : false, remaining: 0,
      text: r ? `${CG[kind].short} 연속 ${n}경기째 ${verdictText(r, gameCnt, "KBL")}` : `${CG[kind].short} 연속 ${n}경기 달성`,
      detail: r ? holdersLine(v.s, r, gameCnt) : "",
      provisional, sig: r ? levelOf(r.rank, r.breaks) : 50,
    });
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (!e.pcode || !e.tcode || !e.action_code || !e.quarter || e.quarter === "PRE") continue;
    const clock = clockOf(e);
    let box = boxes.get(e.pcode);
    if (!box) {
      box = emptyBoxLine();
      boxes.set(e.pcode, box);
    }
    applyBoxEvent(box, e.action_code);
    lastAt.set(e.pcode, { idx, tcode: e.tcode, clock });
    for (const kind of CG_KINDS) if (CG[kind].ok(box)) reach(kind, e.pcode, idx, e.tcode, clock);
  }
  for (const pcode of Object.keys(streaks.state)) {
    if (!known.has(pcode)) continue;
    const at = lastAt.get(pcode);
    for (const kind of CG_KINDS) {
      const st = streaks.state[pcode]?.[kind];
      if (!st) continue;
      if (streaks.final && at && st.after != null && st.after > st.before && !reached.has(`${kind}|${pcode}`)) reach(kind, pcode, at.idx, at.tcode, at.clock);   // 이벤트-공식 불일치 보정
      if (st.before > 0 && !reached.has(`${kind}|${pcode}`)) finals?.set(`${kind}|${pcode}`, 0);                                                             // 이어지던 연속이 이 경기에서 끊겼다
    }
  }

  // --- 팀 연승·연패: 마지막 이벤트의 점수로 승패를 가른다(점수가 없으면 건너뜀)
  const last = events.length > 0 ? events[events.length - 1] : null;
  if (opts.home && opts.away && last && last.home_score != null && last.away_score != null && last.home_score !== last.away_score) {
    const win = last.home_score > last.away_score ? opts.home : opts.away;
    const lose = win === opts.home ? opts.away : opts.home;
    for (const [tc, kind, oth, isWin] of [[win, "tw", "tl", true], [lose, "tl", "tw", false]] as const) {
      if (!known.has(tc)) continue;
      const st = streaks.state[tc]?.[kind];
      finals?.set(`${kind}|${tc}`, (st?.before ?? 0) + 1);
      if ((streaks.state[tc]?.[oth]?.before ?? 0) > 0) finals?.set(`${oth}|${tc}`, 0);
      if (!streaks.final || !st || st.after == null || st.after <= st.before) continue;       // 라이브에서는 결과를 모른다 - 종료 경기의 로그 행만
      const n = st.after;
      const v = streakVerdict(streaks.boards[kind], tc, n, false);
      if (!v.worthy || !v.ranked) continue;
      const r = v.ranked;
      const fmt: ValueFmt = (x) => (isWin ? `${x}연승` : `${x}연패`);
      out.push({
        id: `${kind}|${tc}|${n}`, idx: events.length - 1, until: Infinity, clock: clockOf(last), phase: "done",
        board: STREAK_BOARD[kind], bucket: "G", subject: tc, period: "", scope: "t", name: opts.names.team(tc), tcode: tc, value: n,
        rank: r.rank, tie: r.tie, breaks: r.breaks, remaining: 0,
        text: `${opts.names.team(tc)} 시즌 ${n}${isWin ? "연승" : "연패"}째 ${verdictText(r, fmt, isWin ? "KBL" : "불명예")}`,
        detail: holdersLine(v.s, r, fmt), provisional: false, sig: levelOf(r.rank, r.breaks),
      });
    }
  }
  return out;
}

/** 경기 전 "기록 도전" 한 줄(이름·팀 칩은 recordChanceList가 붙인다). */
export type GameStreakChance = { id: string; name: string; tcode?: string; text: string; detail: string; sig: number };

/**
 * 경기 전 도전: 오늘 조건을 채우면 순위가 좋아지는 선수(연속 경기 6종)와, 이기면/지면 순위가 좋아지는 팀. 상태를 믿을 수 없는 대상(known 밖)은 만들지 않는다.
 * 알릴 만한 순(신기록 먼저)으로 최대 4개.
 */
export function buildGameStreakChances(streaks: StreakContext): GameStreakChance[] {
  const out: GameStreakChance[] = [];
  for (const id of streaks.known) {
    const st = streaks.state[id];
    if (!st) continue;
    const team = streaks.teams?.[id];
    if (team != null) {
      for (const [kind, label, who, verb] of [["tw", "연승", "KBL", "이기면"], ["tl", "연패", "불명예", "지면"]] as const) {
        const before = st[kind]?.before ?? 0;
        if (before <= 0) continue;
        const v = streakVerdict(streaks.boards[kind], id, before + 1, false);
        if (!v.worthy || !v.ranked) continue;
        const fmt: ValueFmt = (x) => `${x}${label}`;
        out.push({ id: `${kind}|${id}`, name: team, tcode: id, text: `${verb} 시즌 ${before + 1}${label}째 ${verdictText(v.ranked, fmt, who)}`, detail: holdersLine(v.s, v.ranked, fmt), sig: levelOf(v.ranked.rank, v.ranked.breaks) });
      }
      continue;
    }
    const p = streaks.players[id];
    if (!p) continue;
    for (const kind of CG_KINDS) {
      const before = st[kind]?.before ?? 0;
      if (before <= 0) continue;
      const n = before + 1;
      const v = streakVerdict(streaks.boards[kind], id, n, isCgMilestone(kind, n));
      if (!v.worthy) continue;
      const r = v.ranked;
      out.push({
        id: `${kind}|${id}`, name: p.name, ...(p.tcode ? { tcode: p.tcode } : {}),
        text: r ? `${CG[kind].cond} ${CG[kind].short} 연속 ${n}경기째 ${verdictText(r, gameCnt, "KBL")}` : `${CG[kind].cond} ${CG[kind].short} 연속 ${n}경기 달성`,
        detail: r ? holdersLine(v.s, r, gameCnt) : "", sig: r ? levelOf(r.rank, r.breaks) : 50,
      });
    }
  }
  return out.sort((a, b) => a.sig - b.sig || a.name.localeCompare(b.name, "ko")).slice(0, 4);
}
