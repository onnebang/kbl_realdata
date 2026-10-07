import { describe, expect, it } from "vitest";
import { buildMilestoneContext, type DeltaGame, type Snapshot } from "./careerMarks";

const row = (pcode: string, pts: number, extra: Partial<DeltaGame["rows"][number]> = {}) => ({ pcode, pts, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, ...extra });
const game = (gmkey: string, game_date: string, rows: DeltaGame["rows"], season_category = "정규시즌"): DeltaGame => ({ gmkey, game_date, season_category, rows });

// 득점 순위표: 13000 ... 8500, 8411(워니, 현역), 8000 + 이정현(S) 9990. P(김선형)는 8403 - 8411 위로는 10명(S 포함)이라 워니를 넘으면 11위.
const ladder = [13000, 11000, 10800, 10200, 10019, 9500, 9000, 8800, 8500, 8411, 8000];
const players: Snapshot["players"] = {
  P: { n: "김선형", a: 1, reg: [8403, 2000, 3000, 500, 100, 900, 600], po: [481, 100, 200, 30, 5, 40, 60], hi: [40, 12, 14, 5, 3, 7] },
  ...Object.fromEntries(
    ladder.map((v, i) => [`L${i + 1}`, { n: i === 9 ? "자밀 워니" : `레전드${i + 1}`, a: (i === 9 ? 1 : 0) as 0 | 1, reg: [v, 0, 0, 0, 0, 0, 500], po: [0, 0, 0, 0, 0, 0, 0], hi: null }])
  ),
  S: { n: "이정현", a: 1, reg: [9990, 3951, 500, 100, 20, 200, 700], po: [0, 0, 0, 0, 0, 0, 0], hi: [45, 9, 9, 4, 2, 8] },
};
const snapshot: Snapshot = { asOf: "2026-10-06", recentFrom: "2026-09-15", recentGmkeys: ["G1", "G2"], players };
const base = { snapshot, split: "regular" as const, players: [{ pcode: "P", name: "김선형" }, { pcode: "S", name: "이정현" }] };
const targetsOf = (ctx: ReturnType<typeof buildMilestoneContext>, pcode: string) => ctx.players[pcode]?.targets ?? [];

describe("buildMilestoneContext - 순위 돌파", () => {
  it("나보다 앞선 가장 가까운 선수를 넘는 목표(넘으려면 값 + 1)와 넘은 뒤 순위", () => {
    const ctx = buildMilestoneContext({ ...base, games: [], gameDate: "2026-10-07" });
    const rank = targetsOf(ctx, "P").filter((t) => t.kind === "rank");
    // 8411(워니)을 넘으면 11위(그 위로 10명). 그 위 8500은 98점 남아 한 경기에 못 미치므로 목표가 아니다.
    expect(rank).toHaveLength(1);
    expect(rank[0]).toMatchObject({ cat: "pts", scope: "all", at: 8412, rank: 11, rival: { pcode: "L10", name: "자밀 워니", value: 8411 }, activeRank: expect.any(Number) });
  });

  it("같은 선수를 현역 순위에서도 넘으면 한 줄로 합치고 현역 순위를 붙인다", () => {
    const rank = targetsOf(buildMilestoneContext({ ...base, games: [], gameDate: "2026-10-07" }), "P").filter((t) => t.kind === "rank");
    // 현역 중에는 이정현(9990)·워니(8411)만 김선형(8403) 앞이라 워니를 넘으면 현역 2위.
    expect(rank[0]).toMatchObject({ activeRank: 2 });
  });
});

describe("buildMilestoneContext - 경기 수", () => {
  it("선수별 경기 수(gp)를 내려준다(경기 전 '현실적으로 닿는 기록' 판정의 평균 재료) - 보정 경기도 반영", () => {
    const g = { gmkey: "G9", game_date: "2026-10-06", season_category: "정규시즌", rows: [row("P", 10)] };
    expect(buildMilestoneContext({ ...base, games: [], gameDate: "2026-10-07" }).players.P.gp).toBe(600);
    expect(buildMilestoneContext({ ...base, games: [g], gameDate: "2026-10-07" }).players.P.gp).toBe(601);
  });
});

describe("buildMilestoneContext - 100개 단위 이정표 / 커리어 하이", () => {
  it("한 경기 안에 닿을 수 있는 가장 가까운 100의 배수만 목표로 둔다", () => {
    const ctx = buildMilestoneContext({ ...base, games: [], gameDate: "2026-10-07" });
    expect(targetsOf(ctx, "S")).toContainEqual({ kind: "step", cat: "pts", at: 10000 });
    expect(targetsOf(ctx, "S")).not.toContainEqual({ kind: "step", cat: "reb", at: 4000 }); // 3951 -> 49개 남음 > 30이라 제외
  });

  it("커리어 하이 - 하이가 노이즈 컷 이상이고 경기 수가 충분할 때만", () => {
    const ctx = buildMilestoneContext({ ...base, games: [], gameDate: "2026-10-07" });
    const high = targetsOf(ctx, "P").filter((t) => t.kind === "high");
    // 득점 40/리바 12/어시 14/스틸 5/블록 3/3점 7 모두 노이즈 컷(15/8/6/3/3/4) 이상.
    expect(high.map((t) => (t as { high: number }).high).sort((a, b) => a - b)).toEqual([3, 5, 7, 12, 14, 40]);
    expect(targetsOf(ctx, "S").filter((t) => t.kind === "high").some((t) => t.cat === "blk")).toBe(false); // 하이 2 < 컷 3
  });
});

describe("buildMilestoneContext - 스냅샷 보정", () => {
  it("스냅샷에 없는 이전 경기는 더하고, 이 경기와 같은 날 이후 경기는 안 센다", () => {
    const g3 = game("G3", "2026-10-08", [row("P", 20)]);
    const after = buildMilestoneContext({ ...base, games: [g3], gameDate: "2026-10-10" });
    expect(after.players.P.before.pts).toBe(8423);
    const before = buildMilestoneContext({ ...base, games: [g3], gameDate: "2026-10-08" });
    expect(before.players.P.before.pts).toBe(8403);
  });

  it("스냅샷에 이미 들어 있는데 이 경기 이후인 경기는 뺀다 - 낡지도 앞서가지도 않게 이 경기 직전 기준", () => {
    const g2 = game("G2", "2026-10-05", [row("P", 25)]);
    const ctx = buildMilestoneContext({ ...base, games: [g2], gameDate: "2026-10-05" });
    expect(ctx.players.P.before.pts).toBe(8378);
  });

  it("뺀 경기가 커리어 하이 자리일 수 있으면 그 부문 하이 목표는 접는다(모름)", () => {
    const g1 = game("G1", "2026-10-04", [row("P", 40)]); // 하이 40을 낸 경기를 빼야 하는 상황
    const ctx = buildMilestoneContext({ ...base, games: [g1], gameDate: "2026-10-04" });
    const pts = targetsOf(ctx, "P").filter((t) => t.kind === "high" && t.cat === "pts");
    const reb = targetsOf(ctx, "P").filter((t) => t.kind === "high" && t.cat === "reb");
    expect(pts).toHaveLength(0);
    expect(reb).toHaveLength(1); // 리바운드 하이는 그 경기와 무관
  });

  it("추가 경기가 하이를 올리면 새 하이를 쓴다", () => {
    const g3 = game("G3", "2026-10-08", [row("P", 44, { reb: 15 })]);
    const ctx = buildMilestoneContext({ ...base, games: [g3], gameDate: "2026-10-10" });
    expect(targetsOf(ctx, "P")).toContainEqual({ kind: "high", cat: "pts", high: 44 });
    expect(targetsOf(ctx, "P")).toContainEqual({ kind: "high", cat: "reb", high: 15 });
  });

  it("플레이오프 경기는 플레이오프 통산표를 쓴다", () => {
    const ctx = buildMilestoneContext({ ...base, games: [], gameDate: "2026-10-07", split: "playoffs" });
    expect(ctx.split).toBe("playoffs");
    expect(ctx.players.P.before.pts).toBe(481);
  });

  it("전시경기 등 통산에 안 들어가는 카테고리는 무시한다", () => {
    const open = game("G9", "2026-10-02", [row("P", 99)], "OPEN MATCH DAY");
    expect(buildMilestoneContext({ ...base, games: [open], gameDate: "2026-10-07" }).players.P.before.pts).toBe(8403);
  });
});
