import { describe, expect, it } from "vitest";
import { deriveGameStatus } from "./gameStatus";

describe("deriveGameStatus", () => {
  it("scheduled - no score yet", () => {
    expect(deriveGameStatus({ home_score: null, is_ended: false })).toBe("scheduled");
  });

  it("live - score exists, not ended", () => {
    expect(deriveGameStatus({ home_score: 42, is_ended: false })).toBe("live");
  });

  it("final - ended", () => {
    expect(deriveGameStatus({ home_score: 88, is_ended: true })).toBe("final");
  });

  it("home_score: 0 is a real score, not 'no score yet' (nullish, not falsy)", () => {
    expect(deriveGameStatus({ home_score: 0, is_ended: false })).toBe("live");
  });
});
