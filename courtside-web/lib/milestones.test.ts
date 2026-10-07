import { describe, expect, it } from "vitest";
import { buildMilestoneTimeline, evaluateApproaching, gameStatsFromBox, type GameStats, type MilestoneContext, type TimelineEvent } from "./milestones";

const zeros: GameStats = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, threep: 0 };

const ctx: MilestoneContext = {
  split: "regular",
  asOf: "2026-10-06",
  players: {
    A: {
      name: "김선형",
      before: { ...zeros, pts: 8403 },
      targets: [
        { kind: "rank", cat: "pts", scope: "all", at: 8412, rank: 10, rival: { pcode: "R", name: "자밀 워니", value: 8411 } },
        { kind: "step", cat: "pts", at: 8500 },
      ],
    },
    B: {
      name: "강상재",
      before: { ...zeros, reb: 5185 },
      targets: [
        { kind: "step", cat: "reb", at: 5200 },
        { kind: "high", cat: "reb", high: 19 },
      ],
    },
    C: { name: "이정현", before: { ...zeros }, targets: [{ kind: "high", cat: "pts", high: 22 }] },
  },
};

const ev = (pcode: string, code: string, quarter = "Q1", min = 5, sec = 0): TimelineEvent => ({ pcode, action_code: code, quarter, clock_min: min, clock_sec: sec });
const stats = (over: Record<string, Partial<GameStats>>) => (pcode: string): GameStats => ({ ...zeros, ...(over[pcode] ?? {}) });

describe("evaluateApproaching", () => {
  it("임박 기준 밖의 목표는 안 올린다", () => {
    // A: 순위 목표는 9점 남음(기준 10점 이내) / 8500점 이정표는 97점 남음. B: 이정표 15개, 커리어 하이 19개 남음.
    const items = evaluateApproaching(ctx, stats({}));
    expect(items.map((i) => `${i.pcode}:${i.kind}`)).toEqual(["A:rank"]);
    expect(items[0].text).toBe("9점만 더 넣으면 올타임 득점 10위 달성");
    expect(items[0].detail).toContain("기존 10위 자밀 워니(8,411)");
  });

  it("경기 중 기록이 쌓일수록 가까운 순으로 올라온다", () => {
    const items = evaluateApproaching(ctx, stats({ A: { pts: 8 }, B: { reb: 12 } }));
    expect(items.map((i) => i.pcode)).toEqual(["A", "B"]); // A: 1점 남음(비율 0.1) < B: 이정표 3개 남음(0.5)
    expect(items[1].text).toBe("3개만 더 잡으면 통산 리바운드 5,200개");
  });

  it("커리어 하이는 타이가 먼저, 타이 뒤에 경신이 나온다", () => {
    const tie = evaluateApproaching(ctx, stats({ B: { reb: 17 } })).find((i) => i.pcode === "B" && i.kind === "high")!;
    expect(tie.text).toBe("2개만 더 잡으면 리바운드 커리어 하이 타이");
    expect(tie.detail).toBe("하이 19개 · 현재 17개");
    const brk = evaluateApproaching(ctx, stats({ B: { reb: 19 } })).find((i) => i.pcode === "B" && i.kind === "high")!;
    expect(brk.text).toBe("1개만 더 잡으면 리바운드 커리어 하이 경신");
  });

  it("이미 이룬 목표는 임박 목록에서 빠진다", () => {
    const items = evaluateApproaching(ctx, stats({ A: { pts: 9 }, B: { reb: 15 } }));
    expect(items.some((i) => i.pcode === "A" && i.kind === "rank")).toBe(false);
    expect(items.some((i) => i.pcode === "B" && i.kind === "step")).toBe(false);
  });

  it("include가 false인 선수(아직 안 나온 벤치 등)는 뺀다", () => {
    const items = evaluateApproaching(ctx, stats({ A: { pts: 8 }, B: { reb: 17 } }), { include: (p) => p !== "A" });
    expect(items.every((i) => i.pcode !== "A")).toBe(true);
    expect(items.some((i) => i.pcode === "B")).toBe(true);
  });

  it("limit/perPlayer로 줄인다", () => {
    expect(evaluateApproaching(ctx, stats({ A: { pts: 8 }, B: { reb: 17 } }), { limit: 1 })).toHaveLength(1);
  });
});

describe("buildMilestoneTimeline", () => {
  it("순위 돌파 - 득점 9점째에 done, 임박 구간은 경기 전부터라 near를 따로 안 만든다", () => {
    const events = [ev("A", "201"), ev("A", "201"), ev("A", "201"), ev("A", "201"), ev("A", "203", "Q2", 7, 40)];
    const moments = buildMilestoneTimeline(ctx, events);
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ idx: 4, phase: "done", pcode: "A", kind: "rank", clock: "Q2 7:40" });
    expect(moments[0].text).toBe("올타임 득점 10위 진입");
    expect(moments[0].detail).toBe("기존 10위 자밀 워니(8,411) 추월 · 통산 8,412점");
  });

  it("100개 단위 이정표 - 임박 구간 진입(near)과 달성(done)이 각각 한 번씩", () => {
    // 5185 -> 9번째 리바운드에 5194(= 5200 - 6)로 임박 진입, 15번째에 5200 달성.
    const events = Array.from({ length: 15 }, (_, i) => ev("B", "210", "Q3", 10 - i, 0));
    const step = buildMilestoneTimeline(ctx, events).filter((m) => m.kind === "step");
    expect(step.map((m) => [m.idx, m.phase])).toEqual([
      [8, "near"],
      [14, "done"],
    ]);
    expect(step[1].text).toBe("통산 리바운드 5,200개 달성!");
  });

  it("커리어 하이 - 타이 임박(16개)과 타이(19개), 경신(20개)", () => {
    const events = Array.from({ length: 20 }, () => ev("B", "209"));
    const high = buildMilestoneTimeline(ctx, events).filter((m) => m.kind === "high");
    expect(high.map((m) => [m.idx, m.phase, m.text])).toEqual([
      [15, "near", "3개만 더 잡으면 리바운드 커리어 하이 타이"],
      [18, "done", "19개로 리바운드 커리어 하이 타이"],
      [19, "done", "20개로 리바운드 커리어 하이 경신!"],
    ]);
  });

  it("한 번에 타이를 건너뛰고 경신하면 경신만 알린다(3점슛으로 20 -> 23, 하이 22)", () => {
    const events = [...Array.from({ length: 10 }, () => ev("C", "201")), ev("C", "205")]; // 20점 -> 23점
    const high = buildMilestoneTimeline(ctx, events).filter((m) => m.pcode === "C" && m.phase === "done");
    expect(high.map((m) => m.text)).toEqual(["23점으로 득점 커리어 하이 경신!"]);
  });

  it("같은 선수·부문의 순위 계단(31위 -> 30위 -> 29위)은 임박 알림을 한 번만 낸다 - 달성은 각각", () => {
    const rank = (at: number, rank: number) => ({ kind: "rank" as const, cat: "pts" as const, scope: "all" as const, at, rank, rival: { pcode: `R${rank}`, name: `선수${rank}`, value: at - 1 } });
    const ladder: MilestoneContext = { split: "regular", asOf: "2026-10-06", players: { X: { name: "엑스", before: { ...zeros, pts: 80 }, targets: [rank(100, 31), rank(105, 30), rank(108, 29)] } } };
    const events = Array.from({ length: 15 }, () => ev("X", "201")); // 30점 -> 통산 110
    const moments = buildMilestoneTimeline(ladder, events);
    expect(moments.filter((m) => m.phase === "near")).toHaveLength(1);
    expect(moments.filter((m) => m.phase === "done").map((m) => m.text)).toEqual(["올타임 득점 31위 진입", "올타임 득점 30위 진입", "올타임 득점 29위 진입"]);
  });

  it("컨텍스트에 없는 선수·선수 없는 이벤트는 무시한다", () => {
    expect(buildMilestoneTimeline(ctx, [ev("Z", "201"), { pcode: null, action_code: "201" }, ev("A", "")])).toEqual([]);
  });
});

describe("gameStatsFromBox", () => {
  it("박스 한 줄을 부문별 값으로(3점슛 = threePM), 없으면 0", () => {
    expect(gameStatsFromBox({ pts: 22, reb: 8, ast: 5, stl: 2, blk: 1, threePM: 3 })).toEqual({ pts: 22, reb: 8, ast: 5, stl: 2, blk: 1, threep: 3 });
    expect(gameStatsFromBox(undefined)).toEqual(zeros);
  });
});
