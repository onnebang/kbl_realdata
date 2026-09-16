import { describe, expect, it } from "vitest";
import { currentTeamName, displayTeamName } from "./teamNames";

describe("displayTeamName", () => {
  it("개명 이력이 없는 팀은 원래 이름 그대로", () => {
    expect(displayTeamName("10", "서울 SK", "2023-2024")).toBe("서울 SK");
  });

  it("개명 시즌 이전에는 옛 이름(원본 팀명) 그대로", () => {
    expect(displayTeamName("60", "전주 KCC", "2022-2023")).toBe("전주 KCC");
  });

  it("개명 시즌부터는 새 이름", () => {
    expect(displayTeamName("60", "전주 KCC", "2023-2024")).toBe("부산 KCC");
  });

  it("개명 시즌 이후로도 계속 새 이름", () => {
    expect(displayTeamName("60", "전주 KCC", "2025-2026")).toBe("부산 KCC");
  });

  it("tcode나 season이 없으면 폴백 이름 그대로(문맥 없이는 판단 불가)", () => {
    expect(displayTeamName(null, "전주 KCC", "2023-2024")).toBe("전주 KCC");
    expect(displayTeamName("60", "전주 KCC", null)).toBe("전주 KCC");
  });
});

describe("currentTeamName", () => {
  it("시즌 무관하게 최신 개명 결과를 적용", () => {
    expect(currentTeamName("60", "전주 KCC")).toBe("부산 KCC");
  });

  it("개명 이력 없는 팀은 원래 이름", () => {
    expect(currentTeamName("10", "서울 SK")).toBe("서울 SK");
  });

  it("tcode 없으면 폴백 이름", () => {
    expect(currentTeamName(null, "서울 SK")).toBe("서울 SK");
  });
});
