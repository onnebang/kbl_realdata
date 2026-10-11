import { applyBoxEvent, emptyBoxLine, type BoxLine } from "./boxEvents";
import { clockOf, holdersLine, rankInfo, TOP_RANKS, verdictText, type RankInfo, type RecordEvent, type RecordMoment, type RecordTimelineOptions, type ValueFmt } from "./records";
import { SEASON_KINDS, STREAK_BOARD, type SeasonKind, type StreakContext } from "./streakKinds";
import { streakVerdict, summaryOf } from "./streakMoments";

// 역대 기록 4단계 C 엔진 - 선수 시즌 누적(정규시즌 합계). 설계: docs/superpowers/specs/2026-10-11-record-book-phase4c-design.md §4
//
// 순간 기록: 이벤트로 선수의 이 경기 누적(applyBoxEvent)이 지표별로 늘 때마다 n = (이 경기 직전 시즌 누적) + 이 경기 누적을 만들고,
//   직전 값과 순위를 비교해 **순위가 좋아질 때만**(10위 안 첫 진입, 한 칸 상승, 신기록 첫 돌파) 알린다. 종료 경기는 공식 로그 행(after > before)이 있는 지표만.
// 경기 전 도전: ① 한 경기 안에 닿는 거리(순위가 좋아지는 가장 작은 증가분) ② 페이스(10경기 이상 뛴 선수의 54경기 환산이 5위 안).
// 순수 함수 - 서버 전용 모듈을 import하지 않는다.

export const REGULAR_GAMES = 54;
export const PACE_MIN_GP = 10;
export const PACE_TOP = 5;
const SCOPE = "역대 시즌";
const levelOf = (i: RankInfo) => (i.breaks ? 0 : i.rank);
const num = (v: number) => (v >= 1000 ? `${Math.floor(v / 1000)},${String(v % 1000).padStart(3, "0")}` : String(v));

const SEASON: Record<SeasonKind, { label: string; unit: string; of: (b: BoxLine) => number; reach: number }> = {
  ss_pts: { label: "득점", unit: "점", of: (b) => b.pts, reach: 25 },
  ss_reb: { label: "리바운드", unit: "개", of: (b) => b.reb, reach: 12 },
  ss_ast: { label: "어시스트", unit: "개", of: (b) => b.ast, reach: 10 },
  ss_stl: { label: "스틸", unit: "개", of: (b) => b.stl, reach: 4 },
  ss_blk: { label: "블록", unit: "개", of: (b) => b.blk, reach: 4 },
  ss_tpm: { label: "3점슛", unit: "개", of: (b) => b.threePM, reach: 5 },
};
const fmtOf = (kind: SeasonKind): ValueFmt => (v) => `${num(v)}${SEASON[kind].unit}`;

export function buildSeasonMoments(
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
  const lastAt = new Map<string, { idx: number; tcode: string; clock: string }>();
  const pending = new Map<string, RecordMoment[]>();        // 종료 경기: `${kind}|${pcode}` -> 이벤트 위치에서 만든 순간 기록(공식 증가분과 같을 때만 채택)

  const make = (kind: SeasonKind, pcode: string, idx: number, tcode: string, clock: string, n: number, v: ReturnType<typeof streakVerdict>): RecordMoment | null => {
    const r = v.ranked;
    if (!v.worthy || !r) return null;
    const fmt = fmtOf(kind);
    return {
      id: `${kind}|${pcode}|${n}`, idx, until: Infinity, clock, phase: "done",
      board: STREAK_BOARD[kind], bucket: "S", subject: pcode, period: "", scope: "p", name: opts.names.player(pcode), tcode, value: n,
      rank: r.rank, tie: r.tie, breaks: r.breaks, remaining: 0,
      text: `시즌 ${SEASON[kind].label} ${num(n)}${SEASON[kind].unit}째 ${verdictText(r, fmt, "KBL", SCOPE)}`,
      detail: holdersLine(v.s, r, fmt), provisional, sig: levelOf(r),
    };
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (!e.pcode || !e.tcode || !e.action_code || !e.quarter || e.quarter === "PRE") continue;
    let box = boxes.get(e.pcode);
    if (!box) {
      box = emptyBoxLine();
      boxes.set(e.pcode, box);
    }
    const was: Record<string, number> = {};
    for (const kind of SEASON_KINDS) was[kind] = SEASON[kind].of(box);
    applyBoxEvent(box, e.action_code);
    const clock = clockOf(e);
    lastAt.set(e.pcode, { idx, tcode: e.tcode, clock });
    if (!known.has(e.pcode)) continue;
    for (const kind of SEASON_KINDS) {
      const now = SEASON[kind].of(box);
      if (now <= was[kind]) continue;
      const st = streaks.state[e.pcode]?.[kind];
      if (streaks.final && !(st && st.after != null)) continue;                    // 종료 경기: 공식 로그 행이 있는 지표만
      const base = st?.before ?? 0;
      const m = make(kind, e.pcode, idx, e.tcode, clock, base + now, streakVerdict(streaks.boards[kind], e.pcode, base + now, false, base + was[kind]));
      if (!m) continue;
      if (streaks.final) {
        const key = `${kind}|${e.pcode}`;
        const list = pending.get(key);
        if (list) list.push(m);
        else pending.set(key, [m]);
      } else out.push(m);
    }
  }

  for (const pcode of Object.keys(streaks.state)) {
    if (!known.has(pcode)) continue;
    const box = boxes.get(pcode);
    for (const kind of SEASON_KINDS) {
      const st = streaks.state[pcode]?.[kind];
      const got = box ? SEASON[kind].of(box) : 0;
      if (got > 0) finals?.set(`${kind}|${pcode}`, (st?.before ?? 0) + got);
      if (!streaks.final || !st || st.after == null) continue;
      const key = `${kind}|${pcode}`;
      if (st.after - st.before === got) {
        for (const m of pending.get(key) ?? []) out.push(m);
      } else {
        const at = lastAt.get(pcode);                                              // 이벤트와 공식 박스가 다르다 - 공식 값으로 마지막 이벤트에서 한 번
        const m = at ? make(kind, pcode, at.idx, at.tcode, at.clock, st.after, streakVerdict(streaks.boards[kind], pcode, st.after, false, st.before)) : null;
        if (m) out.push(m);
      }
    }
  }
  return out;
}

/** 경기 전 "기록 도전" 한 줄(이름·팀 칩은 recordChanceList가 붙인다). */
export type SeasonChance = { id: string; name: string; tcode?: string; text: string; detail: string; sig: number };

/** 경기 전 도전 - 한 경기 안에 닿는 거리(우선)와 페이스. 상태를 믿을 수 없는 선수(known 밖)는 만들지 않는다. 알릴 만한 순으로 최대 4개. */
export function buildSeasonChances(streaks: StreakContext): SeasonChance[] {
  const out: SeasonChance[] = [];
  for (const pcode of streaks.known) {
    const st = streaks.state[pcode];
    const p = streaks.players[pcode];
    if (!st || !p) continue;
    const gp = st.ss_gp?.before ?? 0;
    for (const kind of SEASON_KINDS) {
      const total = st[kind]?.before ?? 0;
      if (total <= 0) continue;
      const fmt = fmtOf(kind);
      const who = { name: p.name, ...(p.tcode ? { tcode: p.tcode } : {}) };
      let found = false;
      for (let step = 1; step <= SEASON[kind].reach; step++) {
        const v = streakVerdict(streaks.boards[kind], pcode, total + step, false, total);
        if (v.worthy && v.ranked) {
          out.push({ ...who, id: `${kind}|${pcode}|reach`, text: `오늘 ${step}${SEASON[kind].unit} 더하면 시즌 ${SEASON[kind].label} ${fmt(total + step)} ${verdictText(v.ranked, fmt, "KBL", SCOPE)}`, detail: holdersLine(v.s, v.ranked, fmt), sig: levelOf(v.ranked) });
          found = true;
          break;
        }
      }
      if (found || gp < PACE_MIN_GP) continue;
      const pace = Math.round((total / gp) * REGULAR_GAMES);
      if (pace <= total) continue;
      const s = summaryOf(streaks.boards[kind], pcode);
      const info = rankInfo(s.tops, pace, "max");
      if (!info || info.rank > TOP_RANKS || !(info.breaks || info.rank <= PACE_TOP)) continue;
      out.push({ ...who, id: `${kind}|${pcode}|pace`, text: `시즌 ${SEASON[kind].label} ${fmt(total)}(${gp}경기) · 이 페이스면 ${REGULAR_GAMES}경기 ${fmt(pace)} — ${verdictText(info, fmt, "KBL", SCOPE)}`, detail: holdersLine(s, info, fmt), sig: 100 + levelOf(info) });
    }
  }
  return out.sort((a, b) => a.sig - b.sig || a.name.localeCompare(b.name, "ko")).slice(0, 4);
}
