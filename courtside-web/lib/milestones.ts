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
export const NEAR: Record<"rank" | "step" | "high", Record<MilestoneCat, number>> = {
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
  | { kind: "high"; cat: MilestoneCat; high: number };

export type MilestonePlayer = { name: string; /** 팀 표시용(점 색) - 모르면 생략 */ tcode?: string; before: Record<MilestoneCat, number>; targets: MilestoneTarget[] };

export type MilestoneContext = {
  /** 이 경기가 속한 통산표 - 정규시즌 경기는 정규리그, 플레이오프/챔프전은 플레이오프 통산. */
  split: "regular" | "playoffs";
  /** 통산 합계가 반영한 마지막 경기 날짜(스냅샷 기준일, 디버깅/표기용). */
  asOf: string;
  players: Record<string, MilestonePlayer>;
};

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
};

const fmt = (n: number) => n.toLocaleString("ko-KR");

// 목표 하나를 "확인 항목"으로 푼다 - 커리어 하이는 타이(=high)와 경신(=high+1) 두 단계라 둘로 나눈다.
type Check = { id: string; target: MilestoneTarget; cat: MilestoneCat; at: number; basis: "career" | "game"; variant?: "tie" | "break" };

function checksOf(pcode: string, p: MilestonePlayer): Check[] {
  return p.targets.flatMap((t, i): Check[] =>
    t.kind === "high"
      ? [
          { id: `${pcode}:${i}:tie`, target: t, cat: t.cat, at: t.high, basis: "game", variant: "tie" },
          { id: `${pcode}:${i}:break`, target: t, cat: t.cat, at: t.high + 1, basis: "game", variant: "break" },
        ]
      : [{ id: `${pcode}:${i}`, target: t, cat: t.cat, at: t.at, basis: "career" }]
  );
}

const valueOf = (c: Check, p: MilestonePlayer, g: GameStats) => (c.basis === "career" ? p.before[c.cat] + g[c.cat] : g[c.cat]);
const nearWindow = (c: Check) => NEAR[c.target.kind][c.cat];

function describe(c: Check, p: MilestonePlayer, g: GameStats, phase: "done" | "near", remaining: number): { text: string; detail: string } {
  const t = c.target;
  const cat = CAT_TEXT[c.cat];
  const today = `오늘 ${g[c.cat]}${cat.unit}째`;
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
  return { id: c.id, pcode, name: p.name, cat: c.cat, kind: c.target.kind, phase, text, detail, remaining, ratio: remaining / nearWindow(c) };
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
