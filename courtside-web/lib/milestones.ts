import { applyBoxEvent, emptyBoxLine, type BoxLine } from "./boxEvents";

// 라이브 경기 "기록 워치" - 이 경기에서 어떤 선수가 (1) 올타임/현역 순위를 앞선 선수를 넘는지, (2) 100개 단위 통산
// 이정표를 채우는지, (3) 커리어 하이에 근접/도달하는지를 알려준다(요청 2026-10-07).
//
// 재료(MilestoneContext)는 서버가 "이 경기 직전까지의 통산 합계·순위·커리어 하이"로 미리 만들어 내려주고
// (lib/careerMarks.ts), 여기는 그 재료와 경기 중 기록(박스/이벤트)만으로 계산하는 순수 함수들이다 -
// JSON·Supabase를 import하지 않아 클라이언트 번들에 들어가도 가볍다.

export const MILESTONE_CATS = ["pts", "reb", "ast", "stl", "blk", "threep"] as const;
export type MilestoneCat = (typeof MILESTONE_CATS)[number];

/** 부문별 표기: name=통산 표 이름, unit=단위, verb=임박 문구의 동사("3점만 더 넣으면"). */
export const CAT_TEXT: Record<MilestoneCat, { name: string; unit: string; verb: string }> = {
  pts: { name: "득점", unit: "점", verb: "넣으면" },
  reb: { name: "리바운드", unit: "개", verb: "잡으면" },
  ast: { name: "어시스트", unit: "개", verb: "기록하면" },
  stl: { name: "스틸", unit: "개", verb: "기록하면" },
  blk: { name: "블록", unit: "개", verb: "기록하면" },
  threep: { name: "3점슛", unit: "개", verb: "성공하면" },
};

/** 한 경기에서 현실적으로 더할 수 있는 최대치 - 서버가 이보다 멀리 있는 목표는 아예 안 내려보낸다. */
export const MAX_GAIN: Record<MilestoneCat, number> = { pts: 60, reb: 30, ast: 25, stl: 10, blk: 10, threep: 12 };

/** "임박" 기준 - 목표까지 남은 수가 이 값 이하일 때만 화면에 올린다(커리어 하이는 한 경기 안의 값이라 더 좁다). */
export const NEAR: Record<"rank" | "step" | "high" | "avg", Record<MilestoneCat, number>> = {
  avg: { pts: 10, reb: 6, ast: 5, stl: 3, blk: 3, threep: 3 },
  rank: { pts: 10, reb: 6, ast: 5, stl: 3, blk: 3, threep: 3 },
  step: { pts: 10, reb: 6, ast: 5, stl: 3, blk: 3, threep: 3 },
  high: { pts: 6, reb: 3, ast: 3, stl: 1, blk: 1, threep: 1 },
};

export type MilestoneTarget =
  /** 순위표에서 앞선 rival(총합 at-1)을 넘는 목표. rank = 넘은 뒤 차지하는 순위(= rival의 현재 순위). */
  | { kind: "rank"; cat: MilestoneCat; scope: "all" | "active"; at: number; rank: number; rival: { pcode: string; name: string; value: number }; /** 같은 rival을 현역 순위에서도 넘을 때 그 순위 */ activeRank?: number }
  /** 100개 단위 통산 이정표(at = 100의 배수). */
  | { kind: "step"; cat: MilestoneCat; at: number }
  /** 한 경기 커리어 하이(high). 같으면 타이, 넘으면 경신. */
  | { kind: "high"; cat: MilestoneCat; high: number }
  /**
   * 통산 평균 순위 돌파(정규리그, 300경기 이상) - 이 경기에서 `need` 이상을 기록하면 평균이 앞선 rival의 평균을 엄밀히 넘어 `rank`위가 된다.
   * 평균은 경기 중 오르내리므로 "지금 평균"이 아니라 이 경기 한 번의 값(need)으로 판정한다(basis game). rival.avg = 그 선수의 통산 평균.
   */
  | { kind: "avg"; cat: MilestoneCat; scope: "all" | "active"; rank: number; need: number; rival: { pcode: string; name: string; avg: number }; activeRank?: number };

export type MilestonePlayer = {
  name: string;
  /** 팀 표시용(점 색) - 모르면 생략 */
  tcode?: string;
  /** 이 통산표(정규/플레이오프)의 출전 경기 수 - 경기 전 "현실적으로 닿는 기록"을 가르는 경기당 평균에 쓴다. 없으면 평균 0으로 본다. */
  gp?: number;
  before: Record<MilestoneCat, number>;
  targets: MilestoneTarget[];
};

export type MilestoneContext = {
  /** 이 경기가 속한 통산표 - 정규시즌 경기는 정규리그, 플레이오프/챔프전은 플레이오프 통산. */
  split: "regular" | "playoffs";
  /** 통산 합계가 반영한 마지막 경기 날짜(스냅샷 기준일, 디버깅/표기용). */
  asOf: string;
  players: Record<string, MilestonePlayer>;
};

/** 패널·리포트가 같이 쓰는 기준 안내 한 줄. */
export const basisNote = (split: MilestoneContext["split"]) =>
  `${split === "regular" ? "정규리그" : "플레이오프"} 통산 기준 · 순위는 올타임 리더스와 같은 기준 · 합계는 이 경기 직전까지`;

/** 알릴 만한 정도(작을수록 크다): 100개 단위 통산 < 커리어 하이 < 순위 돌파(숫자가 작은 순위일수록 앞 - 현역은 풀이 작아 같은 숫자여도 한 단계 약하게 본다). */
export function significance(t: MilestoneTarget): number {
  if (t.kind === "step") return 0;
  if (t.kind === "high") return 1_000;
  return (t.kind === "avg" ? 1_500 : 2_000) + (t.scope === "all" ? t.rank : t.rank * 2);
}

export type GameStats = Record<MilestoneCat, number>;

export function gameStatsFromBox(b: Pick<BoxLine, "pts" | "reb" | "ast" | "stl" | "blk" | "threePM"> | undefined | null): GameStats {
  return { pts: b?.pts ?? 0, reb: b?.reb ?? 0, ast: b?.ast ?? 0, stl: b?.stl ?? 0, blk: b?.blk ?? 0, threep: b?.threePM ?? 0 };
}

export type MilestoneItem = {
  /** 같은 목표 한 건을 가리키는 안정 키(타임라인·패널·토스트 중복 방지). */
  id: string;
  pcode: string;
  name: string;
  cat: MilestoneCat;
  kind: MilestoneTarget["kind"];
  phase: "done" | "near";
  /** 이름을 뺀 본문 - 화면은 이름을 따로 강조하고, 토스트는 이름을 앞에 붙인다. */
  text: string;
  detail: string;
  /** near: 목표까지 남은 수 / done: 0. */
  remaining: number;
  /** near 정렬용(남은 수 / 임박 기준). 작을수록 가깝다. */
  ratio: number;
  /** 알릴 만한 정도(significance) - 리포트가 많은 달성 중 무엇을 먼저 보여줄지 가른다. */
  sig: number;
};

const fmt = (n: number) => n.toLocaleString("ko-KR");

// 목표 하나를 "확인 항목"으로 푼다 - 커리어 하이는 타이(=high)와 경신(=high+1) 두 단계라 둘로 나눈다.
type Check = { id: string; target: MilestoneTarget; cat: MilestoneCat; at: number; basis: "career" | "game"; variant?: "tie" | "break" };

function checksOf(pcode: string, p: MilestonePlayer): Check[] {
  return p.targets.flatMap((t, i): Check[] => {
    if (t.kind === "high") {
      return [
        { id: `${pcode}:${i}:tie`, target: t, cat: t.cat, at: t.high, basis: "game", variant: "tie" },
        { id: `${pcode}:${i}:break`, target: t, cat: t.cat, at: t.high + 1, basis: "game", variant: "break" },
      ];
    }
    if (t.kind === "avg") return [{ id: `${pcode}:${i}`, target: t, cat: t.cat, at: t.need, basis: "game" }];
    return [{ id: `${pcode}:${i}`, target: t, cat: t.cat, at: t.at, basis: "career" }];
  });
}

const valueOf = (c: Check, p: MilestonePlayer, g: GameStats) => (c.basis === "career" ? p.before[c.cat] + g[c.cat] : g[c.cat]);
const nearWindow = (c: Check) => NEAR[c.target.kind][c.cat];

function describe(c: Check, p: MilestonePlayer, g: GameStats, phase: "done" | "near", remaining: number): { text: string; detail: string } {
  const t = c.target;
  const cat = CAT_TEXT[c.cat];
  const today = `오늘 ${g[c.cat]}${cat.unit}째`;
  if (t.kind === "avg") {
    const scope = t.scope === "all" ? "올타임" : "현역";
    const active = t.activeRank != null ? ` · 현역 ${t.activeRank}위` : "";
    const rival = `기존 ${t.rank}위 ${t.rival.name}(${t.rival.avg.toFixed(2)}${cat.unit})`;
    if (phase === "done") {
      const after = (p.before[c.cat] + g[c.cat]) / ((p.gp ?? 0) + 1);
      const by = cat.unit === "점" ? "으로" : "로";
      // 평균은 오늘 기록이 경기 전 평균보다 많을 때만 오른다(x > before/gp). 300경기를 이 경기로 채우는 첫 진입은 평균이 내려가며 순위표에 들 수 있다.
      const rose = g[c.cat] * (p.gp ?? 0) > p.before[c.cat];
      return { text: `통산 평균 ${cat.name} ${after.toFixed(2)}${cat.unit}${by}${rose ? " 올라" : ""} ${scope} ${t.rank}위 진입${active}`, detail: `${rival} 추월 · 오늘 ${g[c.cat]}${cat.unit}` };
    }
    return { text: `${remaining}${cat.unit}만 더 ${cat.verb} 통산 평균 ${cat.name} ${scope} ${t.rank}위${active}`, detail: `${rival} · ${today}` };
  }
  if (t.kind === "rank") {
    const scope = t.scope === "all" ? "올타임" : "현역";
    const target = `${scope} ${cat.name} ${t.rank}위`;
    const rival = `기존 ${t.rank}위 ${t.rival.name}(${fmt(t.rival.value)})`;
    const active = t.activeRank != null ? ` · 현역 ${t.activeRank}위` : "";
    return phase === "done"
      ? { text: `${target} 진입${active}`, detail: `${rival} 추월 · 통산 ${fmt(valueOf(c, p, g))}${cat.unit}` }
      : { text: `${remaining}${cat.unit}만 더 ${cat.verb} ${target} 달성${active}`, detail: `${rival} · ${today}` };
  }
  if (t.kind === "step") {
    const goal = `통산 ${cat.name} ${fmt(t.at)}${cat.unit}`;
    return phase === "done"
      ? { text: `${goal} 달성!`, detail: today }
      : { text: `${remaining}${cat.unit}만 더 ${cat.verb} ${goal}`, detail: `현재 통산 ${fmt(valueOf(c, p, g))}${cat.unit} · ${today}` };
  }
  const high = `${cat.name} 커리어 하이`;
  const by = cat.unit === "점" ? "으로" : "로"; // 받침 있는 "점" -> 으로, 모음으로 끝나는 "개" -> 로
  if (c.variant === "tie") {
    return phase === "done"
      ? { text: `${g[c.cat]}${cat.unit}${by} ${high} 타이`, detail: `기존 하이 ${t.high}${cat.unit}` }
      : { text: `${remaining}${cat.unit}만 더 ${cat.verb} ${high} 타이`, detail: `하이 ${t.high}${cat.unit} · 현재 ${g[c.cat]}${cat.unit}` };
  }
  return phase === "done"
    ? { text: `${g[c.cat]}${cat.unit}${by} ${high} 경신!`, detail: `종전 하이 ${t.high}${cat.unit}` }
    : { text: `${remaining}${cat.unit}만 더 ${cat.verb} ${high} 경신`, detail: `하이 ${t.high}${cat.unit} · 현재 ${g[c.cat]}${cat.unit}` };
}

function itemOf(pcode: string, p: MilestonePlayer, c: Check, g: GameStats, phase: "done" | "near"): MilestoneItem {
  const remaining = phase === "done" ? 0 : c.at - valueOf(c, p, g);
  const { text, detail } = describe(c, p, g, phase, remaining);
  return { id: c.id, pcode, name: p.name, cat: c.cat, kind: c.target.kind, phase, text, detail, remaining, ratio: remaining / nearWindow(c), sig: significance(c.target) };
}

/** 지금 박스 기준으로 "아직 안 이뤘고 곧 이룰 수 있는" 목표들 - 가까운 순, 선수당 최대 perPlayer개. */
export function evaluateApproaching(
  ctx: MilestoneContext,
  statsOf: (pcode: string) => GameStats,
  opts: { limit?: number; perPlayer?: number; /** false를 돌려주는 선수는 뺀다(아직 코트에 안 나온 벤치 선수 등). */ include?: (pcode: string) => boolean } = {}
): MilestoneItem[] {
  const out: MilestoneItem[] = [];
  for (const [pcode, p] of Object.entries(ctx.players)) {
    if (opts.include && !opts.include(pcode)) continue;
    const g = statsOf(pcode);
    const cand: MilestoneItem[] = [];
    for (const c of checksOf(pcode, p)) {
      const needed = c.at - valueOf(c, p, g);
      if (needed <= 0 || needed > nearWindow(c)) continue;
      // 커리어 하이는 타이를 먼저 - 타이 전에 경신을 같이 올리면 같은 말이 두 줄이 된다.
      if (c.variant === "break" && g[c.cat] < c.at - 1) continue;
      cand.push(itemOf(pcode, p, c, g, "near"));
    }
    cand.sort((a, b) => a.ratio - b.ratio);
    out.push(...cand.slice(0, opts.perPlayer ?? 2));
  }
  out.sort((a, b) => a.ratio - b.ratio || a.name.localeCompare(b.name, "ko"));
  return out.slice(0, opts.limit ?? 8);
}

export type MilestoneMoment = MilestoneItem & {
  /** 이 이벤트의 events 배열 인덱스(GameReplay의 idx와 같은 축). */
  idx: number;
  /** "Q3 4:12" 같은 경기 시각. */
  clock: string;
};

export type TimelineEvent = { pcode: string | null; action_code: string | null; quarter?: string; clock_min?: number | null; clock_sec?: number | null };

function clockOf(e: TimelineEvent): string {
  if (!e.quarter || e.quarter === "PRE") return "경기 시작 전";
  return `${e.quarter} ${e.clock_min ?? 0}:${String(e.clock_sec ?? 0).padStart(2, "0")}`;
}

/**
 * 경기 이벤트를 처음부터 한 번 훑어 "언제 무엇을 달성했는지(done)"와 "언제 임박 구간에 들어섰는지(near)"를 뽑는다.
 * 박스 계산은 GameReplay와 같은 lib/boxEvents.applyBoxEvent라 화면의 박스와 어긋나지 않는다. near는 경기 시작 전부터
 * 이미 임박이던 목표는 만들지 않는다("들어섰다"가 아니라 "원래 그랬다" - 패널이 보여주면 된다).
 */
export function buildMilestoneTimeline(ctx: MilestoneContext, events: TimelineEvent[]): MilestoneMoment[] {
  const checks = new Map<string, { p: MilestonePlayer; checks: Check[] }>();
  for (const [pcode, p] of Object.entries(ctx.players)) checks.set(pcode, { p, checks: checksOf(pcode, p) });
  const lines = new Map<string, BoxLine>();
  const done = new Set<string>();
  const near = new Set<string>();
  const nearGroups = new Set<string>();
  const out: MilestoneMoment[] = [];

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (!e.pcode || !e.action_code) continue;
    const entry = checks.get(e.pcode);
    if (!entry) continue;
    let line = lines.get(e.pcode);
    if (!line) lines.set(e.pcode, (line = emptyBoxLine()));
    const prev = gameStatsFromBox(line);
    applyBoxEvent(line, e.action_code);
    const now = gameStatsFromBox(line);
    for (const c of entry.checks) {
      if (now[c.cat] === prev[c.cat] || done.has(c.id)) continue;
      const before = valueOf(c, entry.p, prev);
      const after = valueOf(c, entry.p, now);
      if (after >= c.at) {
        // 한 이벤트로 타이를 건너뛰고 바로 경신하면(3점슛 등) 타이는 따로 안 알린다.
        if (c.variant === "tie" && now[c.cat] > c.at) {
          done.add(c.id);
          continue;
        }
        done.add(c.id);
        out.push({ ...itemOf(e.pcode, entry.p, c, now, "done"), idx, clock: clockOf(e) });
      } else if (!near.has(c.id) && after >= c.at - nearWindow(c) && before < c.at - nearWindow(c)) {
        // 커리어 하이 경신 임박은 타이를 먼저 이룬 뒤에만 - evaluateApproaching과 같은 규칙.
        if (c.variant === "break" && now[c.cat] < c.at - 1) continue;
        near.add(c.id);
        // 같은 선수·부문·종류의 순위 계단(31위 -> 30위 -> 29위)이 줄줄이 임박 알림을 쏘지 않게 첫 한 번만 - 나머지는 패널이 보여준다.
        const groupKey = `${e.pcode}:${c.cat}:${c.target.kind}`;
        if (nearGroups.has(groupKey)) continue;
        nearGroups.add(groupKey);
        out.push({ ...itemOf(e.pcode, entry.p, c, now, "near"), idx, clock: clockOf(e) });
      }
    }
  }
  return out;
}

// ── 경기 전 "이만큼 하면 기록" ────────────────────────────────────────────────────────────────
// 라이브 임박 알림과 같은 재료(targets)에서, 한 경기에 현실적으로 닿는 것만 골라 "누가 몇 점을 하면 어떤 기록"으로 푼다(요청 2026-10-07).

export type RecordChance = {
  id: string;
  pcode: string;
  name: string;
  tcode?: string;
  cat: MilestoneCat;
  kind: MilestoneTarget["kind"];
  /** 이 경기에서 채워야 하는 기록 수(득점이면 점수). */
  need: number;
  /** 이름 뒤에 이어 붙는 서술 - "9점 이상 넣으면 올타임 득점 10위에 오른다". */
  text: string;
  /** 보조 설명 - "기존 10위 자밀 워니(8,411점) 추월 · 현재 통산 8,403점". */
  detail: string;
  sig: number;
};

/** 한 경기 현실 도달선 = 통산 경기당 평균 × REACH_MULT를 부문별 [floor, cap]로 조인 값 - 평균 5점 선수에게 25점짜리 기록을 내놓지 않고, 평균 20점 선수에게도 40점짜리는 내놓지 않는다. */
const REACH_MULT = 1.7;
const REACH: Record<MilestoneCat, { floor: number; cap: number }> = {
  pts: { floor: 8, cap: 30 },
  reb: { floor: 4, cap: 14 },
  ast: { floor: 3, cap: 12 },
  stl: { floor: 2, cap: 4 },
  blk: { floor: 2, cap: 4 },
  threep: { floor: 2, cap: 6 },
};
const reachOf = (cat: MilestoneCat, p: MilestonePlayer) => {
  const avg = p.gp ? p.before[cat] / p.gp : 0;
  return Math.min(REACH[cat].cap, Math.max(REACH[cat].floor, Math.round(avg * REACH_MULT)));
};
const objectParticle = (unit: string) => (unit === "점" ? "을" : "를"); // 점 + 을 / 개 + 를

function chanceOf(pcode: string, p: MilestonePlayer, t: MilestoneTarget, need: number, i: number): RecordChance {
  const cat = CAT_TEXT[t.cat];
  const ask = need === 1 ? `1${cat.unit}만 ${cat.verb}` : `${need}${cat.unit} 이상 ${cat.verb}`;
  const base = { id: `${pcode}:${i}`, pcode, name: p.name, ...(p.tcode ? { tcode: p.tcode } : {}), cat: t.cat, kind: t.kind, need, sig: significance(t) };
  const now = `현재 통산 ${fmt(p.before[t.cat])}${cat.unit}`;
  if (t.kind === "avg") {
    const scope = t.scope === "all" ? "올타임" : "현역";
    const active = t.activeRank != null ? `(현역 ${t.activeRank}위)` : "";
    const avgNow = p.gp ? (p.before[t.cat] / p.gp).toFixed(2) : "-";
    return {
      ...base,
      text: `${ask} 통산 평균 ${cat.name} ${scope} ${t.rank}위${active}에 오른다`,
      detail: `기존 ${t.rank}위 ${t.rival.name}(${t.rival.avg.toFixed(2)}${cat.unit}) 추월 · 현재 평균 ${avgNow}${cat.unit}`,
    };
  }
  if (t.kind === "rank") {
    const active = t.activeRank != null ? `(현역 ${t.activeRank}위)` : "";
    return {
      ...base,
      text: `${ask} ${t.scope === "all" ? "올타임" : "현역"} ${cat.name} ${t.rank}위${active}에 오른다`,
      detail: `기존 ${t.rank}위 ${t.rival.name}(${fmt(t.rival.value)}${cat.unit}) 추월 · ${now}`,
    };
  }
  if (t.kind === "step") return { ...base, text: `${ask} 통산 ${cat.name} ${fmt(t.at)}${cat.unit}${objectParticle(cat.unit)} 달성한다`, detail: now };
  return { ...base, text: `${ask} ${cat.name} 커리어 하이를 경신한다`, detail: `종전 하이 ${t.high}${cat.unit}` };
}

/**
 * 경기 전 "기록 도전" 목록 - 한 경기에 닿을 만한(reachOf 이내) 목표만, 알릴 만한 순(significance)으로.
 * (부문, 종류, 범위)마다 닿는 것 중 가장 큰 기록 하나만 남기고(순위 계단을 줄줄이 늘어놓지 않는다 - 그 밑 계단은 그 과정에서 함께 넘는다),
 * 선수당 perPlayer개·팀당 perTeam개까지. 커리어 하이는 타이가 아니라 경신(하이 + 1)만 올린다.
 */
export function buildRecordChances(ctx: MilestoneContext, opts: { perPlayer?: number; perTeam?: number } = {}): RecordChance[] {
  const perPlayer = opts.perPlayer ?? 2;
  const perTeam = opts.perTeam ?? 5;
  const cand: RecordChance[] = [];
  for (const [pcode, p] of Object.entries(ctx.players)) {
    const best = new Map<string, RecordChance>();
    p.targets.forEach((t, i) => {
      const need = t.kind === "high" ? t.high + 1 : t.kind === "avg" ? t.need : t.at - p.before[t.cat];
      if (need < 1 || need > reachOf(t.cat, p)) return;
      const key = `${t.cat}:${t.kind}:${t.kind === "rank" || t.kind === "avg" ? t.scope : ""}`;
      const sig = significance(t);
      const prev = best.get(key);
      if (!prev || sig < prev.sig || (sig === prev.sig && need < prev.need)) best.set(key, chanceOf(pcode, p, t, need, i));
    });
    cand.push(...best.values());
  }
  cand.sort((a, b) => a.sig - b.sig || a.need - b.need || a.name.localeCompare(b.name, "ko"));
  const byPlayer = new Map<string, number>();
  const byTeam = new Map<string, number>();
  return cand.filter((c) => {
    const team = c.tcode ?? "";
    if ((byPlayer.get(c.pcode) ?? 0) >= perPlayer || (byTeam.get(team) ?? 0) >= perTeam) return false;
    byPlayer.set(c.pcode, (byPlayer.get(c.pcode) ?? 0) + 1);
    byTeam.set(team, (byTeam.get(team) ?? 0) + 1);
    return true;
  });
}
