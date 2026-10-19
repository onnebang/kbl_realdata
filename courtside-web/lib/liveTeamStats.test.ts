import { describe, expect, it } from "vitest";
import { emptyBoxLine, type BoxLine } from "./boxEvents";
import { scoringSplit, teamLine, whereBehind } from "./liveTeamStats";

// 2점/3점/자유투 성공·시도로 박스 한 줄(fgm/fga는 boxEvents 규칙대로 3점 포함, 득점은 그 합).
const line = (s: { two?: [number, number]; three?: [number, number]; ft?: [number, number]; to?: number; oreb?: number; reb?: number }): BoxLine => {
  const [tm, ta] = s.two ?? [0, 0];
  const [hm, ha] = s.three ?? [0, 0];
  const [fm, fa] = s.ft ?? [0, 0];
  return { ...emptyBoxLine(), fgm: tm + hm, fga: ta + ha, threePM: hm, threePA: ha, ftm: fm, fta: fa, pts: tm * 2 + hm * 3 + fm, to: s.to ?? 0, oreb: s.oreb ?? 0, reb: s.reb ?? s.oreb ?? 0 };
};

describe("teamLine", () => {
  it("그 팀 선수들의 박스만 더한다(박스에 없는 선수는 건너뛴다)", () => {
    const box = new Map([
      ["a", line({ two: [3, 5], to: 1 })],
      ["b", line({ three: [2, 4], oreb: 2 })],
      ["c", line({ two: [9, 9] })],
    ]);
    const players = [{ pcode: "a", tcode: "H" }, { pcode: "b", tcode: "H" }, { pcode: "c", tcode: "A" }, { pcode: "x", tcode: "H" }];
    expect(teamLine(box, players, "H")).toMatchObject({ pts: 12, fgm: 5, fga: 9, threePM: 2, threePA: 4, to: 1, oreb: 2 });
  });
});

describe("밀리는 곳", () => {
  // 지는 팀: 2점 16/30 · 3점 4/20 · 자유투 6/10 = 50점, 턴오버 9, 공격리바 3. 이기는 팀: 14/28 · 8/21 · 8/9 = 60점, 턴오버 4, 공격리바 7.
  const trail = line({ two: [16, 30], three: [4, 20], ft: [6, 10], to: 9, oreb: 3 });
  const lead = line({ two: [14, 28], three: [8, 21], ft: [8, 9], to: 4, oreb: 7 });

  it("득점원별 점수 차(지는 팀 기준)는 셋을 더하면 정확히 점수 차다", () => {
    const s = scoringSplit(trail, lead);
    expect(s).toEqual({ two: 4, three: -12, ft: -2 });
    expect(s.two + s.three + s.ft).toBe(trail.pts - lead.pts);
  });

  it("3점 이상 뒤진 득점원(큰 순) 다음 공격 기회(턴오버 +3개 이상, 공격 리바운드 -3개 이상), 최대 3개", () => {
    expect(whereBehind(trail, lead)).toEqual([
      { key: "three", label: "3점", value: "−12점", detail: "4/20 vs 8/21" },
      { key: "to", label: "턴오버", value: "+5개", detail: "9 vs 4" },
      { key: "oreb", label: "공격 리바운드", value: "−4개", detail: "3 vs 7" },
    ]);
  });

  it("작은 차이(득점 -2점, 턴오버 +2개)는 올리지 않는다 - 크게 밀리는 데가 없으면 빈 목록", () => {
    expect(whereBehind(line({ two: [10, 20], ft: [2, 2], to: 6 }), line({ two: [10, 20], ft: [4, 4], to: 4 }))).toEqual([]);
  });

  it("득점원 두 곳이 같이 밀리면 더 크게 밀린 쪽이 먼저", () => {
    const got = whereBehind(line({ two: [5, 20], three: [5, 15] }), line({ two: [9, 20], three: [6, 15] }));
    expect(got.map((g) => `${g.label} ${g.value}`)).toEqual(["2점 −8점", "3점 −3점"]);
  });
});
