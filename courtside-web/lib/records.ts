import { applyBoxEvent, emptyBoxLine, type BoxLine } from "./boxEvents";

// 역대 기록(Record Book) 라이브 엔진 - 설계: docs/superpowers/specs/2026-10-08-record-book-design.md §8.2
//
// 서버가 "이 경기 이전" 기준으로 보드별 TOP10 값을 요약해 내려주면(lib/recordBook.ts RecordContext), 여기서는 경기 이벤트를 한 번 훑으며
// 선수·팀의 쿼터/경기 누적을 쌓고 그 값이 TOP10에 닿는 순간을 기록 이벤트(RecordMoment)로 뽑는다. 순수 함수라 클라이언트 번들에 들어가도 가볍다.
// 누적 규칙은 lib/boxEvents.ts applyBoxEvent 하나(화면 박스와 같은 규칙)이고, 파이썬 쪽 정의(tools/record_book.py)와 어긋나지 않는지는
// 대조 테스트(records.parity.test.ts)가 실제 경기로 고정한다.

export type RecordMetric = "pts" | "reb" | "ast" | "stl" | "blk" | "tpm" | "to" | "fgm" | "fgmiss";
export type RecordDir = "max" | "min";
export const TOP_RANKS = 10;

/** 보드 하나의 요약 - key는 RecordContext.boards의 `${board}|${bucket}`. */
export type BoardSummary = {
  /** 순위 <= 10 항목의 값, 좋은 순(동률은 항목 수만큼 중복). */
  tops: number[];
  /** 순위 <= 3 항목의 보유자(문구용, 최대 6개). */
  holders: { v: number; who: string; d: string }[];
};

export type RecordContext = {
  /** 요약 기준(경기 시각 이전) - 표기·디버깅용. */
  asOf: string;
  boards: Record<string, BoardSummary>;
  /** 종료 경기만: 테이블에 이 경기의 행이 있는 `${board}|${bucket}|${subject}|${period}`. 없으면(라이브·예정) 전부 "잠정"이다. */
  validated?: string[];
};

export type RecordEvent = {
  pcode: string | null;
  tcode: string | null;
  action_code: string | null;
  quarter: string;
  clock_min?: number | null;
  clock_sec?: number | null;
};
export type RecordNames = { player: (pcode: string) => string; team: (tcode: string) => string };

const P_METRICS: RecordMetric[] = ["pts", "reb", "ast", "stl", "blk", "tpm", "to"];
const TQ_METRICS: RecordMetric[] = ["pts", "reb", "ast", "stl", "blk"];
const TG_METRICS: RecordMetric[] = ["pts", "fgm", "fgmiss", "tpm", "reb", "ast", "stl", "blk"];

const METRIC_TEXT: Record<RecordMetric, { name: string; unit: string }> = {
  pts: { name: "득점", unit: "점" },
  reb: { name: "리바운드", unit: "개" },
  ast: { name: "어시스트", unit: "개" },
  stl: { name: "스틸", unit: "개" },
  blk: { name: "블락", unit: "개" },
  tpm: { name: "3점슛", unit: "개" },
  to: { name: "턴오버", unit: "개" },
  fgm: { name: "야투 성공", unit: "개" },
  fgmiss: { name: "야투 실패", unit: "개" },
};
const BUCKET_WORD: Record<string, string> = { Q1: "1쿼터", Q2: "2쿼터", Q3: "3쿼터", Q4: "4쿼터", OT: "연장", ALL: "한 쿼터", G: "한 경기" };

/** 임박 기준 - 현재 값과 다음 기록 선의 차가 이 값 이하일 때만 패널에 올린다. */
export const NEAR_GAP: Record<"p" | "t", Record<RecordMetric, number>> = {
  p: { pts: 5, reb: 2, ast: 2, stl: 1, blk: 1, tpm: 1, to: 1, fgm: 3, fgmiss: 3 },
  t: { pts: 6, reb: 3, ast: 2, stl: 2, blk: 1, tpm: 2, to: 1, fgm: 4, fgmiss: 4 },
};

function metricValue(line: BoxLine, m: RecordMetric): number {
  switch (m) {
    case "pts":
      return line.pts;
    case "reb":
      return line.reb;
    case "ast":
      return line.ast;
    case "stl":
      return line.stl;
    case "blk":
      return line.blk;
    case "tpm":
      return line.threePM;
    case "to":
      return line.to;
    case "fgm":
      return line.fgm;
    case "fgmiss":
      return line.fga - line.fgm;
  }
}

const isRegular = (period: string) => /^Q[1-4]$/.test(period);
const isOvertime = (period: string) => /^X[1-4]$/.test(period);
const bucketOfPeriod = (period: string) => (isRegular(period) ? period : isOvertime(period) ? "OT" : null);

// ── 누적 ────────────────────────────────────────────────────────────────────────────────────────

export type Change = { scope: "p" | "t"; unit: "q" | "g"; metric: RecordMetric; subject: string; period: string; value: number };

/**
 * 이벤트를 하나씩 먹으며 (선수·쿼터) (선수·경기) (팀·쿼터) (팀·경기) 누적 줄을 갱신한다. **선수 귀속 이벤트만**(pcode·tcode 둘 다 있는 것) 센다 -
 * 팀 리바운드 같은 팀 단위 이벤트는 공식 팀 합계와 어긋난다(tools/record_book.py가 같은 규칙).
 */
export class RecordAccumulator {
  private lines = new Map<string, BoxLine>();

  /** 이 이벤트로 값이 바뀐 (대상, 단위, 종목) 목록. */
  apply(e: RecordEvent): Change[] {
    if (!e.pcode || !e.tcode || !e.action_code || !e.quarter || e.quarter === "PRE") return [];
    const out: Change[] = [];
    const code = e.action_code;
    const touch = (scope: "p" | "t", unit: "q" | "g", subject: string, period: string, metrics: RecordMetric[]) => {
      const key = `${scope}${unit}|${subject}|${period}`;
      const line = this.lines.get(key) ?? emptyBoxLine();
      this.lines.set(key, line);
      const before = metrics.map((m) => metricValue(line, m));
      applyBoxEvent(line, code);
      metrics.forEach((m, i) => {
        const value = metricValue(line, m);
        if (value !== before[i]) out.push({ scope, unit, metric: m, subject, period, value });
      });
    };
    touch("p", "q", e.pcode, e.quarter, P_METRICS);
    touch("p", "g", e.pcode, "", P_METRICS);
    touch("t", "q", e.tcode, e.quarter, TQ_METRICS);
    touch("t", "g", e.tcode, "", TG_METRICS);
    return out;
  }

  /** 한 쿼터에 득점한 팀들의 그 쿼터 득점(최소 보드 판정용). */
  teamPeriodPoints(period: string): { tcode: string; pts: number }[] {
    const out: { tcode: string; pts: number }[] = [];
    for (const [key, line] of this.lines) {
      const [kind, subject, p] = key.split("|");
      if (kind === "tq" && p === period) out.push({ tcode: subject, pts: line.pts });
    }
    return out;
  }

  teamGamePoints(): { tcode: string; pts: number }[] {
    const out: { tcode: string; pts: number }[] = [];
    for (const [key, line] of this.lines) {
      const [kind, subject] = key.split("|");
      if (kind === "tg") out.push({ tcode: subject, pts: line.pts });
    }
    return out;
  }

  /** 지금까지의 값을 테이블 행 키(`${board}|${bucket}|${subject}|${period}`)로 - 파이썬 후보 행과 대조하는 데 쓴다. 최소 보드 키도 같이 넣는다. */
  finalValues(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [key, line] of this.lines) {
      const [kind, subject, period] = key.split("|");
      const scope = kind[0] as "p" | "t";
      const unit = kind[1] as "q" | "g";
      const metrics = scope === "p" ? P_METRICS : unit === "q" ? TQ_METRICS : TG_METRICS;
      const bucket = unit === "g" ? "G" : bucketOfPeriod(period);
      if (!bucket) continue;
      for (const m of metrics) {
        const v = metricValue(line, m);
        out.set(`${scope}${unit}.${m}.max|${bucket}|${subject}|${period}`, v);
        if (scope === "t" && m === "pts" && bucket !== "OT") out.set(`${scope}${unit}.${m}.min|${bucket}|${subject}|${period}`, v);
      }
    }
    return out;
  }
}

// ── 순위 ────────────────────────────────────────────────────────────────────────────────────────

export type RankInfo = { rank: number; tie: boolean; breaks: boolean; best: number; n1: number };

/** value가 보드(tops, 좋은 순)에 들어가면 몇 위인지(공동 순위). 보드가 비었으면 null. */
export function rankInfo(tops: number[], value: number, dir: RecordDir): RankInfo | null {
  if (tops.length === 0) return null;
  const rank = tops.filter((t) => (dir === "max" ? t > value : t < value)).length + 1;
  const best = tops[0];
  return { rank, tie: tops.includes(value), breaks: dir === "max" ? value > best : value < best, best, n1: tops.filter((t) => t === best).length };
}

const levelOf = (info: RankInfo) => (info.breaks ? 0 : info.rank);

/** 다음에 노릴 기록 선 - 상위 3위 값들과 "신기록(1위 + 1)" 중 현재 값 바로 위. 없으면 null. (최다 보드 전용) */
export function nextTarget(tops: number[], value: number): number | null {
  const lines = new Set<number>([tops[0] + 1]);
  let rank = 0;
  let last: number | null = null;
  tops.forEach((t, i) => {
    if (t !== last) {
      rank = i + 1;
      last = t;
    }
    if (rank <= 3) lines.add(t);
  });
  const above = [...lines].filter((t) => t > value).sort((a, b) => a - b);
  return above.length ? above[0] : null;
}

// ── 기록 이벤트 ────────────────────────────────────────────────────────────────────────────────

export type RecordMoment = {
  /** 같은 사건을 가리키는 안정 키(토스트·패널 중복 방지). */
  id: string;
  /** 이벤트 인덱스(GameReplay idx와 같은 축). */
  idx: number;
  /** near: 이 인덱스 직전까지만 임박 상태(미포함). done: Infinity. */
  until: number;
  clock: string;
  phase: "done" | "near";
  /** 'pq.ast.max' 같은 보드 키와, 테이블에 저장되는 구간('Q1'~'Q4'|'OT'|'G') - validated 키 조립용. */
  board: string;
  bucket: string;
  subject: string;
  period: string;
  scope: "p" | "t";
  name: string;
  tcode: string | null;
  value: number;
  rank: number;
  tie: boolean;
  breaks: boolean;
  /** near: 다음 기록 선까지 남은 수 / done: 0. */
  remaining: number;
  /** 이름을 뺀 본문(토스트는 이름을 앞에 붙인다). */
  text: string;
  detail: string;
  provisional: boolean;
  /** 정렬용 - 낮을수록 중요(신기록 0, 아니면 순위). */
  sig: number;
};

export const validatedKey = (m: Pick<RecordMoment, "board" | "bucket" | "subject" | "period">) => `${m.board}|${m.bucket}|${m.subject}|${m.period}`;

function clockOf(e: RecordEvent): string {
  if (!e.quarter || e.quarter === "PRE") return "경기 시작 전";
  return `${e.quarter} ${e.clock_min ?? 0}:${String(e.clock_sec ?? 0).padStart(2, "0")}`;
}

const whenWord = (unit: "q" | "g", period: string) => (unit === "g" ? "한 경기" : isRegular(period) ? `${period[1]}쿼터` : "연장");
const metricWord = (m: RecordMetric, dir: RecordDir) => (dir === "min" ? `최소 ${METRIC_TEXT[m].name}` : METRIC_TEXT[m].name);
const who = (m: RecordMetric) => (m === "to" ? "불명예" : "KBL");

function verdict(info: RankInfo, m: RecordMetric): string {
  const unit = METRIC_TEXT[m].unit;
  if (info.breaks) return `${who(m)} 신기록(종전 ${info.best}${unit})`;
  if (info.rank === 1) return `${who(m)} 타이 기록(공동 1위)`;
  return `${who(m)} 역대 ${info.tie ? "공동 " : ""}${info.rank}위`;
}
const shortVerdict = (info: RankInfo) => (info.breaks ? "신기록" : `${info.tie ? "공동 " : ""}${info.rank}위`);

function holdersText(s: BoardSummary, info: RankInfo, m: RecordMetric): string {
  const unit = METRIC_TEXT[m].unit;
  const names = [...new Set(s.holders.filter((h) => h.v === info.best).map((h) => h.who))];
  if (names.length === 0) return "";
  const shown = names.slice(0, 3).join("·");
  const more = info.n1 > 3 ? ` 외 ${info.n1 - 3}건` : "";
  // 신기록·타이면 본문이 이미 "(종전 N개)"·"(공동 1위)"로 값을 말하므로 값을 되풀이하지 않고 보유자만 적는다.
  return info.breaks || info.rank === 1 ? `${shown}${more} 보유` : `역대 1위 ${info.best}${unit}: ${shown}${more}`;
}

/** 본문과 설명을 한 줄로. 본문이 "…(종전 8개)"처럼 괄호로 끝나면 같은 괄호 안에 이어 붙여 괄호가 연달아 나오지 않게 한다. */
export function recordLine(m: Pick<RecordMoment, "text" | "detail">): string {
  if (!m.detail) return m.text;
  return m.text.endsWith(")") ? `${m.text.slice(0, -1)} · ${m.detail})` : `${m.text}(${m.detail})`;
}

export type RecordTimelineOptions = { names: RecordNames; /** 종료된 경기면 true - 마지막 쿼터·경기 끝 판정(최소 보드)까지 한다. */ final: boolean };

/**
 * 이벤트를 처음부터 한 번 훑어 "언제 TOP10에 닿았는지(done)"와 "언제 기록 선 가까이 갔는지(near)"를 뽑는다.
 * 최다 보드는 값이 바뀔 때마다, 최소 보드(팀 쿼터·경기 득점)는 쿼터·경기가 끝나는 시점에 판정한다.
 * 종료 경기(ctx.validated 있음)는 테이블에 있는 항목만 남긴다 - 검증을 통과하지 못한 기록은 주장하지 않는다.
 */
export function buildRecordTimeline(ctx: RecordContext, events: RecordEvent[], opts: RecordTimelineOptions): RecordMoment[] {
  const acc = new RecordAccumulator();
  const out: RecordMoment[] = [];
  const lastEmit = new Map<string, { level: number; value: number }>();
  const openNear = new Map<string, RecordMoment>();
  const provisional = ctx.validated === undefined;
  let curPeriod = "";
  let lastIdx = -1;

  const nameOf = (scope: "p" | "t", subject: string) => (scope === "p" ? opts.names.player(subject) : opts.names.team(subject));
  const closeNear = (key: string, at: number) => {
    const open = openNear.get(key);
    if (open) {
      open.until = at;
      openNear.delete(key);
    }
  };

  const push = (m: RecordMoment) => out.push(m);

  const emitDone = (args: {
    board: string; scope: "p" | "t"; unit: "q" | "g"; metric: RecordMetric; dir: RecordDir; subject: string; period: string; value: number; idx: number; clock: string; tcode: string | null;
  }) => {
    const buckets = args.unit === "g" ? ["G"] : isRegular(args.period) ? [args.period, "ALL"] : isOvertime(args.period) ? ["OT"] : [];
    const hits = buckets
      .map((b) => {
        const s = ctx.boards[`${args.board}|${b}`];
        const info = s ? rankInfo(s.tops, args.value, args.dir) : null;
        return s && info && info.rank <= TOP_RANKS ? { b, s, info, level: levelOf(info) } : null;
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);
    if (hits.length === 0) return;
    // 같은 값이 구간 보드와 전체(ALL) 보드에 모두 걸리면 한 사건으로 - 더 높은 쪽(동률이면 ALL)이 본문, 나머지는 설명에 붙인다.
    hits.sort((a, c) => a.level - c.level || (a.b === "ALL" ? -1 : c.b === "ALL" ? 1 : 0));
    const primary = hits[0];
    const key = `${args.board}|${args.subject}|${args.period}`;
    // 순위가 좋아질 때만 알린다. 신기록(level 0)을 깬 뒤에는 값이 오를 때마다 다시 알린다(11개 -> 12개 -> 13개처럼 기록을 계속 늘리는 경기).
    const prev = lastEmit.get(key);
    if (prev && !(primary.level < prev.level || (primary.level === 0 && args.value > prev.value))) return;
    lastEmit.set(key, { level: primary.level, value: args.value });
    closeNear(key, args.idx);
    const unit = METRIC_TEXT[args.metric].unit;
    const stored = args.unit === "g" ? "G" : bucketOfPeriod(args.period)!;
    // 다른 구간 판정이 본문과 같으면("1쿼터 기준 신기록" + 본문 "신기록") 덧붙일 정보가 없다.
    const extra = hits.slice(1).filter((h) => shortVerdict(h.info) !== shortVerdict(primary.info)).map((h) => `${BUCKET_WORD[h.b]} 기준 ${shortVerdict(h.info)}`);
    const holders = holdersText(primary.s, primary.info, args.metric);
    push({
      id: `${key}|${primary.level}|${args.value}|done`,
      idx: args.idx, until: Infinity, clock: args.clock, phase: "done",
      board: args.board, bucket: stored, subject: args.subject, period: args.period, scope: args.scope,
      name: nameOf(args.scope, args.subject), tcode: args.tcode, value: args.value,
      rank: primary.info.rank, tie: primary.info.tie, breaks: primary.info.breaks, remaining: 0,
      text: `${whenWord(args.unit, args.period)} ${metricWord(args.metric, args.dir)} ${args.value}${unit} ${verdict(primary.info, args.metric)}`,
      detail: [...extra, holders].filter(Boolean).join(" · "),
      provisional, sig: primary.level,
    });
  };

  const trackNear = (args: {
    board: string; scope: "p" | "t"; unit: "q" | "g"; metric: RecordMetric; subject: string; period: string; value: number; idx: number; clock: string; tcode: string | null;
  }) => {
    const key = `${args.board}|${args.subject}|${args.period}`;
    const buckets = args.unit === "g" ? ["G"] : isRegular(args.period) ? [args.period, "ALL"] : isOvertime(args.period) ? ["OT"] : [];
    let best: { b: string; s: BoardSummary; target: number; gap: number } | null = null;
    for (const b of buckets) {
      const s = ctx.boards[`${args.board}|${b}`];
      if (!s || s.tops.length === 0) continue;
      const target = nextTarget(s.tops, args.value);
      if (target == null) continue;
      const gap = target - args.value;
      if (gap > NEAR_GAP[args.scope][args.metric]) continue;
      if (!best || gap < best.gap || (gap === best.gap && b === "ALL")) best = { b, s, target, gap };
    }
    closeNear(key, args.idx); // 값이 바뀔 때마다 새로 연다 - 패널은 키당 지금 유효한 하나만 보여준다
    if (!best) return;
    const id = `${key}|${best.target}|near|${args.value}`;
    const unit = METRIC_TEXT[args.metric].unit;
    const tInfo = rankInfo(best.s.tops, best.target, "max")!;
    const stored = args.unit === "g" ? "G" : bucketOfPeriod(args.period)!;
    const m: RecordMoment = {
      id, idx: args.idx, until: Infinity, clock: args.clock, phase: "near",
      board: args.board, bucket: stored, subject: args.subject, period: args.period, scope: args.scope,
      name: nameOf(args.scope, args.subject), tcode: args.tcode, value: args.value,
      rank: tInfo.rank, tie: tInfo.tie, breaks: tInfo.breaks, remaining: best.gap,
      text: `${whenWord(args.unit, args.period)} ${metricWord(args.metric, "max")} ${args.value}${unit} · ${best.gap}${unit} 더하면 ${verdict(tInfo, args.metric)}`,
      detail: holdersText(best.s, tInfo, args.metric),
      provisional, sig: levelOf(tInfo),
    };
    openNear.set(key, m);
    push(m);
  };

  // 쿼터가 끝났을 때(다음 쿼터 첫 이벤트가 오거나 종료 경기의 마지막): 그 쿼터의 임박 상태를 닫고 팀 쿼터 최소 득점을 판정한다.
  const finishPeriod = (period: string, atIdx: number, clock: string) => {
    for (const [key, m] of [...openNear]) if (m.period === period) closeNear(key, atIdx + 1);
    if (!isRegular(period)) return;
    for (const t of acc.teamPeriodPoints(period)) {
      emitDone({ board: "tq.pts.min", scope: "t", unit: "q", metric: "pts", dir: "min", subject: t.tcode, period, value: t.pts, idx: atIdx, clock, tcode: t.tcode });
    }
  };

  events.forEach((e, idx) => {
    const q = e.quarter;
    if (!q || q === "PRE" || !e.pcode || !e.tcode || !e.action_code) return;
    if (curPeriod && q !== curPeriod) finishPeriod(curPeriod, lastIdx, clockOf(events[lastIdx]));
    curPeriod = q;
    lastIdx = idx;
    const clock = clockOf(e);
    for (const c of acc.apply(e)) {
      const tcode = c.scope === "p" ? e.tcode : c.subject;
      const board = `${c.scope}${c.unit}.${c.metric}.max`;
      const base = { board, scope: c.scope, unit: c.unit, metric: c.metric, subject: c.subject, period: c.period, value: c.value, idx, clock, tcode } as const;
      emitDone({ ...base, dir: "max" });
      trackNear(base);
    }
  });

  if (opts.final && curPeriod) {
    const clock = clockOf(events[lastIdx]);
    finishPeriod(curPeriod, lastIdx, clock);
    for (const t of acc.teamGamePoints()) {
      emitDone({ board: "tg.pts.min", scope: "t", unit: "g", metric: "pts", dir: "min", subject: t.tcode, period: "", value: t.pts, idx: lastIdx, clock, tcode: t.tcode });
    }
  }
  for (const key of [...openNear.keys()]) closeNear(key, events.length);

  const validated = ctx.validated ? new Set(ctx.validated) : null;
  return (validated ? out.filter((m) => validated.has(validatedKey(m))) : out).sort((a, b) => a.idx - b.idx);
}

/** 스크럽 위치 idx까지의 달성(최근 것이 위). */
export const doneUpTo = (moments: RecordMoment[], idx: number) => moments.filter((m) => m.phase === "done" && m.idx <= idx).reverse();
/** 스크럽 위치 idx에서 임박 상태인 것(가까운 순). */
export const nearAt = (moments: RecordMoment[], idx: number) =>
  moments.filter((m) => m.phase === "near" && m.idx <= idx && idx < m.until).sort((a, b) => a.remaining - b.remaining || a.sig - b.sig);

/** 토스트 문구 - 달성(done)만 알린다(임박은 패널 전용). */
export function recordToast(m: RecordMoment): { icon: string; title: string; msg: string } {
  const icon = m.rank === 1 || m.breaks ? "🏆" : m.rank <= 3 ? "🥈" : "🏅";
  const title = m.breaks ? (m.board.includes(".to.") ? "불명예 신기록!" : "KBL 신기록!") : m.rank === 1 ? (m.board.includes(".to.") ? "불명예 타이 기록" : "KBL 타이 기록") : "역대 기록";
  return { icon, title, msg: `${m.provisional ? "(잠정) " : ""}${m.name} ${m.text}` };
}
