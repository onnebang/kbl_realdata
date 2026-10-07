import { describe, expect, it, vi } from "vitest";
import marks from "./career_marks.json";

// Next 데이터 캐시는 vitest에서 못 돌므로 cachedFn은 통과시키고, DB는 항상 실패시킨다.
vi.mock("./cachePolicy", () => ({ cachedFn: <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => fn, TTL: { scheduled: 0, batchDaily: 0 } }));
vi.mock("./supabaseServer", () => {
  const chain: unknown = new Proxy(
    {},
    { get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "boom" } }) : () => chain) }
  );
  return { supabaseServer: { from: () => chain } };
});
vi.mock("./playerPageData", () => ({ getTeamRoster: async () => [] }));

import { getMilestoneContext } from "./careerMarks";

const game = { game_date: marks.asOf, season_category: "정규시즌", season_name: "2026-27", home_team: { tcode: "01" }, away_team: { tcode: "02" } };

describe("getMilestoneContext - 실패 처리", () => {
  it("델타 조회가 에러면 []로 삼켜 틀린 합계로 이어 가지 않고 던진다(빈 로스터도 던지되 호출부가 흡수)", async () => {
    await expect(getMilestoneContext(game, [{ pcode: "P1", name: "가" }])).rejects.toThrow("careerMarksDelta: boom");
  });

  it("스냅샷에서 60일 넘게 먼 경기는 DB를 건드리기 전에 null(DB가 죽어 있어도 던지지 않는다)", async () => {
    await expect(getMilestoneContext({ ...game, game_date: "2020-01-01" }, [])).resolves.toBeNull();
  });

  it("정규/플레이오프가 아닌 경기(오픈매치 등)는 통산에 안 들어가므로 null", async () => {
    await expect(getMilestoneContext({ ...game, season_category: "오픈매치" }, [])).resolves.toBeNull();
  });
});
