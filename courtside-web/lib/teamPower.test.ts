import { describe, expect, it } from "vitest";
import { getOvrHistoryCache } from "./ovr";
import { getAllTeamPowers } from "./teamPower";

// OVR 파일은 파이프라인이 다시 만들 때마다 바뀌므로 숫자를 박지 않고 파일에서 골라 대조한다.
describe("getAllTeamPowers", () => {
  it("로스터 밖 추정 행(offRoster: 군 복무/해외 진출)은 팀 전력에 안 센다", () => {
    const off = new Set(
      getOvrHistoryCache()
        .filter((r) => r.offRoster)
        .map((r) => `${r.pcode}|${r.season}`),
    );
    for (const power of getAllTeamPowers()) {
      for (const r of power.roster) expect(off.has(`${r.pcode}|${r.season}`)).toBe(false);
    }
  });
});
