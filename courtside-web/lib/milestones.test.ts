import { describe, expect, it } from "vitest";
import { basisNote, buildMilestoneTimeline, buildRecordChances, evaluateApproaching, gameStatsFromBox, significance, type GameStats, type MilestoneContext, type MilestoneTarget, type TimelineEvent } from "./milestones";

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

describe("통산 평균 순위(avg) 목표", () => {
  const avgPlayer = (): MilestoneContext["players"][string] => ({
    name: "김선형", gp: 299, before: { pts: 5660, reb: 0, ast: 0, stl: 0, blk: 0, threep: 0 },
    targets: [{ kind: "avg", cat: "pts", scope: "all", rank: 3, need: 41, rival: { pcode: "C", name: "씨", avg: 19 }, activeRank: 1 }],
  });
  const avgCtx: MilestoneContext = { split: "regular", asOf: "2026-10-06", players: { P: avgPlayer() } };
  it("need 이상을 기록하는 순간 '통산 평균 득점 N점으로 올라 올타임 3위 진입'(done), 직전엔 임박(near)", () => {
    const ev = (code: string, i: number) => ({ pcode: "P", action_code: code, quarter: "Q4", clock_min: 9, clock_sec: 50 - i });
    const events = [...Array.from({ length: 20 }, (_, i) => ev("201", i)), ev("203", 20)];
    const m = buildMilestoneTimeline(avgCtx, events);
    const done = m.filter((x) => x.phase === "done");
    expect(done).toHaveLength(1);
    expect(done[0].text).toBe("통산 평균 득점 19.00점으로 올라 올타임 3위 진입 · 현역 1위");
    expect(done[0].detail).toBe("기존 3위 씨(19.00점) 추월 · 오늘 41점");
    const near = m.find((x) => x.phase === "near");
    expect(near?.text).toBe("9점만 더 넣으면 통산 평균 득점 올타임 3위 · 현역 1위");        // 임박 구간(남은 10점 이내)에 처음 든 순간은 32점째 - 남은 9점
  });
  it("평균이 실제로 오를 때만 '올라' - 300경기 첫 진입처럼 평균이 내려가며 순위표에 드는 경우는 '…으로 N위 진입'", () => {
    // 299경기 5,690점(19.03)이 오늘 11점이면 5,701/300 = 19.00 - 순위표 첫 진입(3위)이지만 평균은 내려갔다(오늘 11점 < 경기 전 평균 19.03).
    const entry: MilestoneContext = {
      split: "regular",
      asOf: "2026-10-06",
      players: { P: { ...avgPlayer(), before: { pts: 5690, reb: 0, ast: 0, stl: 0, blk: 0, threep: 0 }, targets: [{ kind: "avg", cat: "pts", scope: "all", rank: 3, need: 11, rival: { pcode: "C", name: "씨", avg: 19 }, activeRank: 1 }] } },
    };
    const events = [...Array.from({ length: 5 }, (_, i) => ({ pcode: "P", action_code: "201", quarter: "Q4", clock_min: 9, clock_sec: 50 - i })), { pcode: "P", action_code: "203", quarter: "Q4", clock_min: 9, clock_sec: 40 }];
    const done = buildMilestoneTimeline(entry, events).filter((x) => x.phase === "done");
    expect(done.map((x) => x.text)).toEqual(["통산 평균 득점 19.00점으로 올타임 3위 진입 · 현역 1위"]);
  });
  it("경기 전 '기록 도전': 41점은 평균 18.9 x 1.7 = 32 > 30(cap)이라 닿지 않고, need가 작으면 문장으로", () => {
    expect(buildRecordChances(avgCtx)).toEqual([]);
    const near: MilestoneContext = { ...avgCtx, players: { P: { ...avgPlayer(), targets: [{ kind: "avg", cat: "pts", scope: "all", rank: 3, need: 12, rival: { pcode: "C", name: "씨", avg: 19 } }] } } };
    const [c] = buildRecordChances(near);
    expect(c).toMatchObject({ kind: "avg", need: 12, text: "12점 이상 넣으면 통산 평균 득점 올타임 3위에 오른다", detail: "기존 3위 씨(19.00점) 추월 · 현재 평균 18.93점" });
  });
  it("중요도는 통산 합계 순위 돌파보다 위, 커리어 하이보다 아래", () => {
    const avg = significance({ kind: "avg", cat: "pts", scope: "all", rank: 3, need: 5, rival: { pcode: "x", name: "x", avg: 1 } });
    expect(avg).toBeGreaterThan(significance({ kind: "high", cat: "pts", high: 20 }));
    expect(avg).toBeLessThan(significance({ kind: "rank", cat: "pts", scope: "all", at: 10, rank: 1, rival: { pcode: "x", name: "x", value: 1 } }));
  });
});

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

describe("buildRecordChances (경기 전 기록 도전)", () => {
  const rankT = (at: number, rank: number, extra: Partial<Extract<MilestoneTarget, { kind: "rank" }>> = {}): MilestoneTarget => ({
    kind: "rank", cat: "pts", scope: "all", at, rank, rival: { pcode: `R${rank}`, name: `선수${rank}`, value: at - 1 }, ...extra,
  });
  // 김선형: 경기당 14점(8403/600) -> 현실 도달선 24점. 순위 목표는 9점(10위)과 27점(9위), 하이는 22점(경신은 23점).
  const star = { name: "김선형", tcode: "T1", gp: 600, before: { ...zeros, pts: 8403 }, targets: [rankT(8412, 10, { rival: { pcode: "R", name: "자밀 워니", value: 8411 } }), rankT(8430, 9), { kind: "step", cat: "pts", at: 8500 } as MilestoneTarget, { kind: "high", cat: "pts", high: 22 } as MilestoneTarget] };
  const ctx = (players: MilestoneContext["players"]): MilestoneContext => ({ split: "regular", asOf: "2026-10-06", players });

  it("한 경기에 닿는 목표만 - 현실 도달선(경기당 평균 x 1.7, 부문별 [floor, cap]) 밖은 뺀다", () => {
    const got = buildRecordChances(ctx({ A: star }));
    // 9점(순위 10위) / 23점(하이 경신)만. 27점(9위)·97점(8,500)은 24점 도달선 밖.
    expect(got.map((c) => `${c.kind}:${c.need}`).sort()).toEqual(["high:23", "rank:9"]);
  });

  it("알릴 만한 순 - 100개 단위 통산 > 커리어 하이 > 순위(작은 숫자가 앞)", () => {
    const b = { name: "강상재", tcode: "T1", gp: 500, before: { ...zeros, reb: 5190 }, targets: [{ kind: "step", cat: "reb", at: 5200 } as MilestoneTarget] }; // 경기당 10.4 -> 도달선 14, 필요 10
    const got = buildRecordChances(ctx({ A: star, B: b }), { perPlayer: 2 });
    expect(got.map((c) => c.kind)).toEqual(["step", "high", "rank"]);
    expect(significance({ kind: "step", cat: "pts", at: 100 })).toBeLessThan(significance({ kind: "high", cat: "pts", high: 20 }));
  });

  it("같은 (부문·종류·범위)에선 닿는 가장 큰 순위 하나만 - 아래 계단은 그 과정에서 함께 넘는다", () => {
    const ladder = { name: "엑스", tcode: "T1", gp: 600, before: { ...zeros, pts: 8403 }, targets: [rankT(8412, 31), rankT(8416, 30), rankT(8421, 29)] };
    const got = buildRecordChances(ctx({ X: ladder }));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ need: 18, text: expect.stringContaining("올타임 득점 29위") });
  });

  it("선수당 2개, 팀당 5개로 자른다", () => {
    const mk = (n: number, tcode: string) => ({ name: `선수${n}`, tcode, gp: 100, before: { ...zeros, pts: 98, reb: 98, ast: 98 }, targets: (["pts", "reb", "ast"] as const).map((cat) => ({ kind: "step", cat, at: 100 }) as MilestoneTarget) });
    const players = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`P${i}`, mk(i, "T1")]).concat([["Q0", mk(9, "T2")]]));
    const got = buildRecordChances(ctx(players));
    expect(got.filter((c) => c.tcode === "T1")).toHaveLength(5); // 6명 x 최대 2개 = 12개 중 팀당 5
    expect(got.filter((c) => c.pcode === "Q0")).toHaveLength(2);
    for (const pcode of new Set(got.map((c) => c.pcode))) expect(got.filter((c) => c.pcode === pcode).length).toBeLessThanOrEqual(2);
  });

  it("gp를 모르면 평균 0 - 부문별 floor까지만 닿는 것으로 본다", () => {
    const noGp = { name: "신인", tcode: "T1", before: { ...zeros, pts: 94 }, targets: [{ kind: "step", cat: "pts", at: 100 } as MilestoneTarget, rankT(110, 90)] }; // 필요 6점(floor 8 이내) / 16점(밖)
    expect(buildRecordChances(ctx({ N: noGp })).map((c) => c.need)).toEqual([6]);
  });

  it("문장 - 필요 수에 따라 '만/이상', 목적격 조사(점+을 / 개+를), 현역 병기, 하이는 경신", () => {
    const chances = buildRecordChances(
      ctx({
        A: { ...star, targets: [rankT(8412, 10, { rival: { pcode: "R", name: "자밀 워니", value: 8411 }, activeRank: 3 }), { kind: "high", cat: "pts", high: 22 }] },
        B: { name: "강상재", tcode: "T2", gp: 500, before: { ...zeros, reb: 5199 }, targets: [{ kind: "step", cat: "reb", at: 5200 }] },
        C: { name: "양홍석", tcode: "T2", gp: 600, before: { ...zeros, pts: 4591 }, targets: [{ kind: "step", cat: "pts", at: 4600 }] },
      })
    );
    const byId = (needle: string) => chances.find((c) => c.text.includes(needle))!;
    expect(byId("올타임 득점 10위").text).toBe("9점 이상 넣으면 올타임 득점 10위(현역 3위)에 오른다");
    expect(byId("올타임 득점 10위").detail).toBe("기존 10위 자밀 워니(8,411점) 추월 · 현재 통산 8,403점");
    expect(byId("리바운드").text).toBe("1개만 잡으면 통산 리바운드 5,200개를 달성한다");
    expect(byId("4,600").text).toBe("9점 이상 넣으면 통산 득점 4,600점을 달성한다");
    expect(byId("커리어 하이").text).toBe("23점 이상 넣으면 득점 커리어 하이를 경신한다");
    expect(byId("커리어 하이").detail).toBe("종전 하이 22점");
  });

  it("기준 안내 문구는 통산표(정규/플레이오프)를 따른다", () => {
    expect(basisNote("regular")).toContain("정규리그 통산 기준");
    expect(basisNote("playoffs")).toContain("플레이오프 통산 기준");
  });
});
