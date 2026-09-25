import { describe, expect, it } from "vitest";
import { initialGameTab } from "./gameTabs";

describe("initialGameTab", () => {
  it("defaults by status when there is no ?tab", () => {
    expect(initialGameTab("scheduled", undefined)).toBe("pre");
    expect(initialGameTab("live", undefined)).toBe("live");
    expect(initialGameTab("final", undefined)).toBe("post");
  });

  it("?tab wins over the status default, even for a tab that is not open yet", () => {
    expect(initialGameTab("final", "pre")).toBe("pre");
    expect(initialGameTab("scheduled", "post")).toBe("post");
  });

  it("ignores unknown / empty / inherited-property values", () => {
    expect(initialGameTab("live", "nope")).toBe("live");
    expect(initialGameTab("final", "")).toBe("post");
    expect(initialGameTab("final", "constructor")).toBe("post");
  });

  it("repeated ?tab=a&tab=b uses the first value", () => {
    expect(initialGameTab("final", ["live", "pre"])).toBe("live");
    expect(initialGameTab("final", ["nope", "live"])).toBe("post");
  });
});
