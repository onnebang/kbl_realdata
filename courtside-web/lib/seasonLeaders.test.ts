import { describe, expect, it } from "vitest";
import { LEADER_QUALIFY, isQualified, qualifyRule } from "./seasonLeaders";

describe("qualifyRule", () => {
  it("개막 직후(팀 3경기): 2경기 + 24분으로 완화", () => {
    expect(qualifyRule(3)).toMatchObject({ gp: 2, min: 24, relaxed: true, fullAt: 29 });
  });

  it("기준은 경기 수에 따라 자라고 15경기/300분을 넘지 않는다", () => {
    expect(qualifyRule(10)).toMatchObject({ gp: 5, min: 80 });
    expect(qualifyRule(28)).toMatchObject({ gp: 14, relaxed: true });
    expect(qualifyRule(29)).toMatchObject({ gp: 15, relaxed: false });
    expect(qualifyRule(54)).toMatchObject({ gp: 15, min: 300, relaxed: false });
  });

  it("개막 첫 경기(팀 1경기)에는 2경기 하한이라 아무도 못 넘는다 - 비는 게 정직", () => {
    expect(isQualified({ gp: 1, minutes: 40 }, qualifyRule(1))).toBe(false);
  });
});

describe("isQualified", () => {
  const early = qualifyRule(3);

  it("규칙 없이 부르면 예전과 똑같다(15경기 또는 300분)", () => {
    expect(isQualified({ gp: 4, minutes: 120 })).toBe(false);
    expect(isQualified({ gp: LEADER_QUALIFY.gp, minutes: 0 })).toBe(true);
    expect(isQualified({ gp: 1, minutes: LEADER_QUALIFY.min })).toBe(true);
  });

  it("시즌 초반: 2경기 이상 + 24분 이상만 통과(3분짜리 벤치는 컷)", () => {
    expect(isQualified({ gp: 3, minutes: 60 }, early)).toBe(true);
    expect(isQualified({ gp: 2, minutes: 24 }, early)).toBe(true);
    expect(isQualified({ gp: 2, minutes: 6 }, early)).toBe(false); // 경기만 채운 벤치
    expect(isQualified({ gp: 1, minutes: 38 }, early)).toBe(false); // 한 경기짜리
  });

  it("완화가 끝난 시즌에서는 규칙을 줘도 기존 기준과 같다", () => {
    const full = qualifyRule(54);
    expect(isQualified({ gp: 10, minutes: 200 }, full)).toBe(false);
    expect(isQualified({ gp: 15, minutes: 10 }, full)).toBe(true);
  });
});
