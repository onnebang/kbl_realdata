import {
  buildRecordTimeline,
  clockOf,
  holdersLine,
  nextTarget,
  rankInfo,
  TOP_RANKS,
  validatedKey,
  verdictText,
  type RankInfo,
  type RecordContext,
  type RecordEvent,
  type RecordMoment,
  type RecordTimelineOptions,
  type ValueFmt,
} from "./records";
import type { StreakContext } from "./streakKinds";
import { buildStreakMoments } from "./streakMoments";

// 역대 기록 2단계 라이브 엔진(순간 기록 14개 보드) - 설계: docs/superpowers/specs/2026-10-10-record-book-phase2-design.md §3·§5
//
// 이벤트를 한 번 훑으며 코트 출전 초(101 투입 / 102 퇴장), 선수별 누적(득점·리바·어시·스틸·블락·파울), 득점 창, 팀 런, 점수차, 선발 5명을 쌓고
// 그 값이 서버가 내려준 "이 경기 이전" 보드 요약(RecordContext)의 TOP10에 닿는 순간을 RecordMoment로 뽑는다. 파이썬 정의(tools/record_book.py)와 같은
// 값을 내는지는 records.moments.parity.test.ts가 실제 경기로 고정한다. 순수 함수 - 클라이언트 번들에 들어가도 가볍다.

export const BURST_WINDOWS = [10, 35, 60] as const;
const CLOCK_SCOPE = "2017-18 이후";

const PERIOD_LEN: Record<string, number> = { Q1: 600, Q2: 600, Q3: 600, Q4: 600, X1: 300, X2: 300, X3: 300, X4: 300 };
const PERIOD_START: Record<string, number> = { Q1: 0, Q2: 600, Q3: 1200, Q4: 1800, X1: 2400, X2: 2700, X3: 3000, X4: 3300 };
const CATS = ["pts", "reb", "ast", "stl", "blk"] as const;
type Cat = (typeof CATS)[number];
const CAT_NAME: Record<Cat, { name: string; unit: string }> = {
  pts: { name: "득점", unit: "점" },
  reb: { name: "리바운드", unit: "개" },
  ast: { name: "어시스트", unit: "개" },
  stl: { name: "스틸", unit: "개" },
  blk: { name: "블락", unit: "개" },
};
const POINTS: Record<string, number> = { "201": 2, "207": 2, "205": 3, "203": 1 };
const CAT_OF_CODE: Record<string, Cat> = { "209": "reb", "210": "reb", "211": "ast", "212": "stl", "213": "blk" };
const FOUL_CODES = new Set(["215", "216"]);

const mmss = (v: number) => (v >= 60 ? `${Math.floor(v / 60)}분 ${v % 60}초` : `${v}초`);
const fmtPts: ValueFmt = (v) => `${v}점`;
const fmtCnt: ValueFmt = (v) => `${v}개`;

type BoardDef = { label: (v: number) => string; fmt: ValueFmt; unit: string; who?: string; scope?: string };
const BOARDS: Record<string, BoardDef> = {
  "tg.margin.max": { label: (v) => `점수차 ${v}점`, fmt: fmtPts, unit: "점" },
  "pg.benchpts.max": { label: (v) => `벤치 득점 ${v}점`, fmt: fmtPts, unit: "점" },
  "pg.nopts_reb.max": { label: (v) => `무득점 리바운드 ${v}개`, fmt: fmtCnt, unit: "개" },
  "pg.nopts_ast.max": { label: (v) => `무득점 어시스트 ${v}개`, fmt: fmtCnt, unit: "개" },
  "pg.dd_time.min": { label: (v) => `출전 ${mmss(v)} 만에 더블더블`, fmt: mmss, unit: "초" },
  "pg.td_time.min": { label: (v) => `출전 ${mmss(v)} 만에 트리플더블`, fmt: mmss, unit: "초" },
  "pg.foul5_time.min": { label: (v) => `출전 ${mmss(v)} 만에 5반칙 퇴장`, fmt: mmss, unit: "초", who: "불명예" },
  "pg.burst10.max": { label: (v) => `10초 동안 ${v}득점`, fmt: fmtPts, unit: "점", scope: CLOCK_SCOPE },
  "pg.burst35.max": { label: (v) => `35초 동안 ${v}득점`, fmt: fmtPts, unit: "점", scope: CLOCK_SCOPE },
  "pg.burst60.max": { label: (v) => `60초 동안 ${v}득점`, fmt: fmtPts, unit: "점", scope: CLOCK_SCOPE },
  "tg.run.max": { label: (v) => `${v}-0 런`, fmt: (v) => `${v}-0`, unit: "점", scope: CLOCK_SCOPE },
};
/** 임박(near) 기준 - 다음 기록 선과의 차가 이 값 이하일 때만 패널에 올린다(초 단위 창과 시간 보드는 임박이 없다). */
const NEAR_GAP2: Record<string, number> = { "tg.margin.max": 6, "pg.benchpts.max": 5, "tg.run.max": 4 };
const CLUBS = {
  td: { board: "pg.club_td.max", label: "트리플더블", sig: 2 },
  qd: { board: "pg.club_qd.max", label: "쿼드러플더블", sig: 0 },
  x5: { board: "pg.club_x5.max", label: "5x5", sig: 0 },
} as const;
type ClubKind = keyof typeof CLUBS;

const levelOf = (i: RankInfo) => (i.breaks ? 0 : i.rank);

function timeOf(e: RecordEvent): number | null {
  const len = PERIOD_LEN[e.quarter];
  if (len == null || e.clock_min == null || e.clock_sec == null) return null;
  return PERIOD_START[e.quarter] + len - (e.clock_min * 60 + e.clock_sec);
}

type PlayerState = {
  tcode: string;
  tot: Record<Cat, number>;
  foul: number;
  onSince: number | null;
  acc: number;
  done: Set<string>;
  win: { t: number; q: string; pts: number }[];
  lo: number[];
  sum: number[];
  best: number[];
  bad: boolean;
  lastQ: string | null;
  lastT: number;
};
const freshPlayer = (tcode: string): PlayerState => ({
  tcode, tot: { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 }, foul: 0, onSince: null, acc: 0, done: new Set(),
  win: [], lo: BURST_WINDOWS.map(() => 0), sum: BURST_WINDOWS.map(() => 0), best: BURST_WINDOWS.map(() => 0), bad: false, lastQ: null, lastT: 0,
});

/**
 * 순간 기록(2단계)만 뽑는다. finals를 주면 파이썬 후보 행과 맞출 값(`${board}|G|${대상}|` -> 값)도 채운다(대조 테스트용).
 * 종료 경기(opts.final)는 점수차와 무득점 보드를 마지막 값 하나로만 판정한다(중간에 더 컸어도 최종이 아니면 기록이 아니다).
 */
export function buildMomentTimeline(ctx: RecordContext, events: RecordEvent[], opts: RecordTimelineOptions, finals?: Map<string, number>): RecordMoment[] {
  const out: RecordMoment[] = [];
  const provisional = ctx.validated === undefined;
  const players = new Map<string, PlayerState>();
  const starters = new Map<string, Set<string>>();
  const lastEmit = new Map<string, { level: number; value: number }>();
  const openNear = new Map<string, RecordMoment>();
  const clubCount: Record<ClubKind, number> = { td: 0, qd: 0, x5: 0 };
  const lastScoreT = new Map<string, number>();
  const bestRun = new Map<string, number>();
  let run: { tcode: string | null; pts: number } = { tcode: null, pts: 0 };
  let runBad = false;
  let scoreH: number | null = null;
  let scoreA: number | null = null;
  let lastLead = -1;
  let lastIdx = -1;

  const closeNear = (key: string, at: number) => {
    const open = openNear.get(key);
    if (open) {
      open.until = at;
      openNear.delete(key);
    }
  };

  type Subject = { board: string; scope: "p" | "t"; subject: string; name: string; tcode: string | null; value: number; idx: number; clock: string };

  /** 순위 보드 판정 - 상위 10위 안이고 순위가 좋아질 때(신기록 이후엔 값이 좋아질 때마다)만 알린다. */
  const emitBoard = (a: Subject & { dir: "max" | "min"; sig?: number }) => {
    const s = ctx.boards[`${a.board}|G`];
    const info = s ? rankInfo(s.tops, a.value, a.dir) : null;
    if (!s || !info || info.rank > TOP_RANKS) return;
    const level = levelOf(info);
    const key = `${a.board}|${a.subject}`;
    const prev = lastEmit.get(key);
    if (prev && !(level < prev.level || (level === 0 && (a.dir === "max" ? a.value > prev.value : a.value < prev.value)))) return;
    lastEmit.set(key, { level, value: a.value });
    closeNear(key, a.idx);
    const def = BOARDS[a.board];
    out.push({
      id: `${key}|${level}|${a.value}|done`, idx: a.idx, until: Infinity, clock: a.clock, phase: "done",
      board: a.board, bucket: "G", subject: a.subject, period: "", scope: a.scope, name: a.name, tcode: a.tcode, value: a.value,
      rank: info.rank, tie: info.tie, breaks: info.breaks, remaining: 0,
      text: `${def.label(a.value)} ${verdictText(info, def.fmt, def.who, def.scope)}`,
      detail: holdersLine(s, info, def.fmt),
      provisional, sig: a.sig ?? level,
    });
  };

  /** 최다 보드의 임박 - 현재 값이 다음 기록 선(상위 3위 값·신기록)과 gap 이내이면 패널용 near를 새로 연다. */
  const trackNear = (a: Subject) => {
    const key = `${a.board}|${a.subject}`;
    closeNear(key, a.idx);
    const s = ctx.boards[`${a.board}|G`];
    if (!s || s.tops.length === 0) return;
    const target = nextTarget(s.tops, a.value);
    if (target == null) return;
    const gap = target - a.value;
    if (gap > (NEAR_GAP2[a.board] ?? 0)) return;
    const tInfo = rankInfo(s.tops, target, "max");
    if (!tInfo) return;
    const def = BOARDS[a.board];
    const m: RecordMoment = {
      id: `${key}|${target}|near|${a.value}`, idx: a.idx, until: Infinity, clock: a.clock, phase: "near",
      board: a.board, bucket: "G", subject: a.subject, period: "", scope: a.scope, name: a.name, tcode: a.tcode, value: a.value,
      rank: tInfo.rank, tie: tInfo.tie, breaks: tInfo.breaks, remaining: gap,
      text: `${def.label(a.value)} · ${gap}${def.unit} 더하면 ${verdictText(tInfo, def.fmt, def.who, def.scope)}`,
      detail: holdersLine(s, tInfo, def.fmt),
      provisional, sig: levelOf(tInfo),
    };
    openNear.set(key, m);
    out.push(m);
  };

  const emitClub = (kind: ClubKind, pcode: string, st: PlayerState, idx: number, clock: string) => {
    const def = CLUBS[kind];
    const s = ctx.boards[`${def.board}|G`];
    clubCount[kind] += 1;
    const n = (s ? s.tops.length : 0) + clubCount[kind];
    const prior = s && s.tops.length <= 3 ? s.holders.map((h) => `${h.who}(${h.d})`) : [];
    closeNear(`${def.board}|${pcode}`, idx);
    out.push({
      id: `${def.board}|${pcode}|club`, idx, until: Infinity, clock, phase: "done",
      board: def.board, bucket: "G", subject: pcode, period: "", scope: "p", name: opts.names.player(pcode), tcode: st.tcode, value: 1,
      rank: 1, tie: false, breaks: false, remaining: 0,
      text: `${def.label} 달성 — KBL 역대 ${n}번째`,
      detail: prior.length ? `앞선 기록: ${prior.join(" · ")}` : "",
      provisional, sig: def.sig, club: def.label,
    });
  };

  /** 클럽 임박(패널 전용): 트리플더블 = 두 부문 10 이상 + 나머지 중 가장 높은 것 8 이상, 5x5 = 네 부문 5 이상 + 나머지 3 이상. */
  const nearClub = (pcode: string, st: PlayerState, idx: number, clock: string) => {
    const open = (kind: ClubKind, cat: Cat, goal: number, label: string) => {
      const key = `${CLUBS[kind].board}|${pcode}`;
      const v = st.tot[cat];
      const id = `${key}|near|${cat}|${v}`;
      if (openNear.get(key)?.id === id) return; // 같은 상태면 새로 열지 않는다(이벤트마다 호출된다)
      closeNear(key, idx);
      const m: RecordMoment = {
        id, idx, until: Infinity, clock, phase: "near",
        board: CLUBS[kind].board, bucket: "G", subject: pcode, period: "", scope: "p", name: opts.names.player(pcode), tcode: st.tcode, value: v,
        rank: 1, tie: false, breaks: false, remaining: goal - v,
        text: `${CAT_NAME[cat].name} ${v}${CAT_NAME[cat].unit} · ${goal - v}${CAT_NAME[cat].unit} 더하면 ${label}`,
        detail: "", provisional, sig: 3, club: CLUBS[kind].label,
      };
      openNear.set(key, m);
      out.push(m);
    };
    const rest = (min: number) => CATS.filter((c) => st.tot[c] < min).sort((x, y) => st.tot[y] - st.tot[x])[0];
    if (!st.done.has("td") && CATS.filter((c) => st.tot[c] >= 10).length === 2) {
      const c = rest(10);
      if (c && st.tot[c] >= 8) open("td", c, 10, "트리플더블");
    }
    if (!st.done.has("x5") && CATS.filter((c) => st.tot[c] >= 5).length === 4) {
      const c = rest(5);
      if (c && st.tot[c] >= 3) open("x5", c, 5, "5x5");
    }
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    lastIdx = idx;
    const clock = clockOf(e);

    // 점수차 - 라이브는 점수가 바뀔 때마다(종료 경기는 아래에서 마지막 값 하나로)
    if (typeof e.home_score === "number" && typeof e.away_score === "number") {
      scoreH = e.home_score;
      scoreA = e.away_score;
      if (!opts.final && opts.home && opts.away && scoreH !== scoreA) {
        const leader = scoreH > scoreA ? opts.home : opts.away;
        const lead = Math.abs(scoreH - scoreA);
        if (lead !== lastLead) {
          lastLead = lead;
          const base = { board: "tg.margin.max", scope: "t" as const, subject: leader, name: opts.names.team(leader), tcode: leader, value: lead, idx, clock };
          emitBoard({ ...base, dir: "max" });
          trackNear(base);
        }
      }
    }

    const q = e.quarter;
    if (!q || q === "PRE" || !e.pcode || !e.tcode || !e.action_code) continue;
    const pcode = e.pcode;
    const tcode = e.tcode;
    const code = e.action_code;
    const t = timeOf(e);
    const st = players.get(pcode) ?? freshPlayer(tcode);
    if (!players.has(pcode)) players.set(pcode, st);

    if (code === "101") {
      if (t != null) st.onSince = t;
      if (q === "Q1" && t === 0) starters.set(tcode, (starters.get(tcode) ?? new Set<string>()).add(pcode));
      continue;
    }
    if (code === "102") {
      if (st.onSince != null && t != null) st.acc += Math.max(0, t - st.onSince);
      st.onSince = null;
      continue;
    }

    const cur = st.acc + (st.onSince != null && t != null ? t - st.onSince : 0);
    const pts = POINTS[code] ?? 0;
    const name = opts.names.player(pcode);
    if (pts) st.tot.pts += pts;
    else if (CAT_OF_CODE[code]) st.tot[CAT_OF_CODE[code]] += 1;
    else if (FOUL_CODES.has(code)) st.foul += 1;

    // 최단 시간 더블더블 / 트리플더블 / 5반칙(출전 초 - 코트에 있었다는 기록이 없어 0이면 시간을 모르므로 건너뛴다)
    const doubles = CATS.filter((c) => st.tot[c] >= 10).length;
    if (cur > 0) {
      const timed = (key: string, board: string, value: number) => {
        if (st.done.has(key)) return;
        st.done.add(key);
        finals?.set(`${board}|G|${pcode}|`, value);
        emitBoard({ board, scope: "p", subject: pcode, name, tcode, value, dir: "min", idx, clock });
      };
      if (doubles >= 2) timed("time_dd", "pg.dd_time.min", cur);
      if (doubles >= 3) timed("time_td", "pg.td_time.min", cur);
      if (st.foul >= 5) timed("time_foul5", "pg.foul5_time.min", cur);
    }

    // 클럽(시간 보드와 done 키가 겹치지 않게 time_ 접두사를 따로 쓴다)
    const clubs: [ClubKind, boolean][] = [["td", doubles >= 3], ["qd", doubles >= 4], ["x5", CATS.every((c) => st.tot[c] >= 5)]];
    for (const [kind, ok] of clubs) {
      if (!ok || st.done.has(kind)) continue;
      st.done.add(kind);
      finals?.set(`${CLUBS[kind].board}|G|${pcode}|`, 1);
      emitClub(kind, pcode, st, idx, clock);
    }
    nearClub(pcode, st, idx, clock);

    if (!pts) continue;

    // 벤치 득점 - 그 팀 선발 5명이 확인된 경기에서 선발이 아닌 선수
    const five = starters.get(tcode);
    if (five && five.size === 5 && !five.has(pcode)) {
      const base = { board: "pg.benchpts.max", scope: "p" as const, subject: pcode, name, tcode, value: st.tot.pts, idx, clock };
      emitBoard({ ...base, dir: "max" });
      trackNear(base);
    }

    // N초 득점 - 한 선수의 득점 시각이 쿼터 안에서 거꾸로 가면 그 선수는 이후 알리지 않는다(파이썬은 선수 전체 제외)
    if (!st.bad) {
      if (t == null || (st.lastQ === q && t < st.lastT)) st.bad = true;
      else {
        st.lastQ = q;
        st.lastT = t;
        st.win.push({ t, q, pts });
        BURST_WINDOWS.forEach((w, i) => {
          st.sum[i] += pts;
          while (st.win[st.lo[i]].q !== q || t - st.win[st.lo[i]].t > w) {
            st.sum[i] -= st.win[st.lo[i]].pts;
            st.lo[i] += 1;
          }
          if (st.sum[i] > st.best[i]) {
            st.best[i] = st.sum[i];
            emitBoard({ board: `pg.burst${w}.max`, scope: "p", subject: pcode, name, tcode, value: st.sum[i], dir: "max", idx, clock });
          }
        });
      }
    }

    // 팀 런 - 두 팀 득점 이벤트가 쿼터마다 시계 순서일 때만(어긋나면 이후 런은 알리지 않는다)
    if (!runBad) {
      if (t == null || t < (lastScoreT.get(q) ?? 0)) runBad = true;
      else lastScoreT.set(q, t);
    }
    if (run.tcode === tcode) run.pts += pts;
    else {
      if (run.tcode) closeNear(`tg.run.max|${run.tcode}`, idx);
      run = { tcode, pts };
    }
    if (!runBad) {
      bestRun.set(tcode, Math.max(bestRun.get(tcode) ?? 0, run.pts));
      const base = { board: "tg.run.max", scope: "t" as const, subject: tcode, name: opts.names.team(tcode), tcode, value: run.pts, idx, clock };
      emitBoard({ ...base, dir: "max" });
      trackNear(base);
    }
  }

  // 경기 끝 판정 + finals
  const lastClock = lastIdx >= 0 ? clockOf(events[lastIdx]) : "";
  if (scoreH != null && scoreA != null && scoreH !== scoreA && opts.home && opts.away) {
    const leader = scoreH > scoreA ? opts.home : opts.away;
    const lead = Math.abs(scoreH - scoreA);
    finals?.set(`tg.margin.max|G|${leader}|`, lead);
    if (opts.final) emitBoard({ board: "tg.margin.max", scope: "t", subject: leader, name: opts.names.team(leader), tcode: leader, value: lead, dir: "max", idx: lastIdx, clock: lastClock });
  }
  for (const [pcode, st] of players) {
    if (st.tot.pts === 0) {
      for (const [cat, board] of [["reb", "pg.nopts_reb.max"], ["ast", "pg.nopts_ast.max"]] as const) {
        const v = st.tot[cat];
        if (v <= 0) continue;
        finals?.set(`${board}|G|${pcode}|`, v);
        if (opts.final) emitBoard({ board, scope: "p", subject: pcode, name: opts.names.player(pcode), tcode: st.tcode, value: v, dir: "max", idx: lastIdx, clock: lastClock });
      }
    }
    const five = starters.get(st.tcode);
    if (five && five.size === 5 && !five.has(pcode) && st.tot.pts > 0) finals?.set(`pg.benchpts.max|G|${pcode}|`, st.tot.pts);
    if (!st.bad) {
      BURST_WINDOWS.forEach((w, i) => {
        if (st.best[i] > 0) finals?.set(`pg.burst${w}.max|G|${pcode}|`, st.best[i]);
      });
    }
  }
  if (!runBad) for (const [tcode, v] of bestRun) finals?.set(`tg.run.max|G|${tcode}|`, v);
  for (const key of [...openNear.keys()]) closeNear(key, events.length);
  return out;
}

/**
 * 1단계(쿼터·경기 최다/최소)와 2단계(순간 기록)와 3단계(연속 기록)를 합쳐 시간순으로. 종료 경기는 1·2단계 순간을 테이블에 있는(validated) 항목만 남기고,
 * 3단계(streakMoments)는 스스로 같은 기준(한 경기 안 = validated, 연속 출장·경기 간 = 이 경기 로그 행)으로 거른다.
 */
export function buildAllRecordMoments(ctx: RecordContext, events: RecordEvent[], opts: RecordTimelineOptions, streaks?: StreakContext | null): RecordMoment[] {
  const base = buildRecordTimeline(ctx, events, opts);
  const extra = buildMomentTimeline(ctx, events, opts);
  const validated = ctx.validated ? new Set(ctx.validated) : null;
  const kept = validated ? extra.filter((m) => validated.has(validatedKey(m))) : extra;
  const streak = buildStreakMoments(ctx, streaks ?? null, events, opts);
  return [...base, ...kept, ...streak].sort((a, b) => a.idx - b.idx);
}
