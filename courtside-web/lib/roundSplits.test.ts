import { describe, expect, it } from "vitest";
import type { CareerGameRow } from "./playerProfile";
import { buildRoundSplits, roundDelta } from "./roundSplits";

const base: Omit<CareerGameRow, "gmkey"> = {
  gameDate: "2026-10-03",
  seasonName: "2026-2027",
  seasonCategory: "정규시즌",
  tcode: "60",
  oppTcode: "50",
  isHome: true,
  teamScore: 80,
  oppScore: 70,
  isEnded: true,
  backNum: "1",
  pos: "G",
  isStarter: true,
  min: 30,
  pts: 10,
  reb: 5,
  oreb: null,
  dreb: null,
  ast: 3,
  stl: 1,
  blk: 0,
  tov: 2,
  fgm: 3,
  fga: 6,
  tpm: 1,
  tpa: 3,
  ftm: 1,
  fta: 2,
};
const row = (no: number, over: Partial<CareerGameRow> = {}): CareerGameRow => ({ ...base, gmkey: `S49G01N${no}`, ...over });
const info = { perRound: 45, roundCount: 6, currentRound: 2 };

describe("buildRoundSplits", () => {
  it("경기 순번을 라운드 크기로 끊어 담고 라운드별 경기당 평균을 낸다", () => {
    const s = buildRoundSplits([row(1, { pts: 10 }), row(2, { pts: 20 }), row(46, { pts: 30 })], "2026-2027", info)!;
    expect(s.rounds).toHaveLength(6);
    expect(s.rounds[0].agg?.gp).toBe(2);
    expect(s.rounds[0].agg?.ppg).toBe(15);
    expect(s.rounds[1].agg?.ppg).toBe(30);
    expect(s.rounds.slice(2).every((r) => r.agg === null && r.se === null)).toBe(true);
  });

  it("라운드 경계 - N45는 1라운드, N46은 2라운드, N270은 6라운드", () => {
    const s = buildRoundSplits([row(45), row(46), row(270)], "2026-2027", info)!;
    expect([0, 1, 5].map((i) => s.rounds[i].agg?.gp)).toEqual([1, 1, 1]);
    expect(s.rounds[2].agg).toBeNull();
  });

  it("오픈매치·플레이오프·안 끝난 경기·다른 시즌은 안 센다", () => {
    const rows = [
      row(1),
      row(2, { seasonCategory: "OPEN MATCH DAY" }),
      row(3, { seasonCategory: "플레이오프" }),
      row(4, { isEnded: false }),
      row(5, { seasonName: "2025-2026" }),
    ];
    expect(buildRoundSplits(rows, "2026-2027", info)!.rounds[0].agg?.gp).toBe(1);
  });

  it("이 시즌 종료 정규시즌 경기가 없으면 null", () => {
    expect(buildRoundSplits([row(1, { seasonName: "2025-2026" })], "2026-2027", info)).toBeNull();
    expect(buildRoundSplits([], "2026-2027", info)).toBeNull();
  });

  it("표준오차는 2경기부터 - 1경기 라운드는 판정 불가(null)", () => {
    const s = buildRoundSplits([row(1, { pts: 10 }), row(2, { pts: 20 }), row(46, { pts: 30 })], "2026-2027", info)!;
    expect(s.rounds[0].se?.pts).toBeCloseTo(5, 5); // sd 7.07 / sqrt(2)
    expect(s.rounds[1].se?.pts).toBeNull();
  });
});

describe("roundDelta", () => {
  it("노이즈(두 라운드 표준오차 합성) 안의 변화는 방향을 말하지 않는다", () => {
    expect(roundDelta(12, 10, 2, 2).tone).toBe("flat"); // 변화 2 < 노이즈 2.83
  });
  it("노이즈를 넘으면 방향이 붙는다", () => {
    expect(roundDelta(16, 10, 1, 1)).toEqual({ value: 6, tone: "up" });
    expect(roundDelta(4, 10, 1, 1).tone).toBe("down");
  });
  it("표본이 부족해 표준오차를 모르면 flat, 사실상 같은 값도 flat", () => {
    expect(roundDelta(16, 10, null, 1).tone).toBe("flat");
    expect(roundDelta(10.02, 10, 0, 0).tone).toBe("flat");
  });
});
