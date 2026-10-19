import { describe, expect, it } from "vitest";
import { projectStandings, type BaseStanding } from "./liveStandings";
import { computeStandings, type StandingsGameRow } from "./matchups";

// 이 경기 전 순위(정렬 끝난 상태): A 5-1, B 4-2(+5), C 4-2(+2), D 3-3, E 2-4, F 1-5.
const row = (tcode: string, wins: number, losses: number, diff: number): BaseStanding => ({ tcode, wins, losses, pct: wins / (wins + losses), diff });
const base = [row("A", 5, 1, 8), row("B", 4, 2, 5), row("C", 4, 2, 2), row("D", 3, 3, 0), row("E", 2, 4, -4), row("F", 1, 5, -9)];
const brief = (rows: ReturnType<typeof projectStandings>) => rows.map((r) => `${r.rank}:${r.tcode} ${r.wins}-${r.losses}`);

describe("projectStandings - 지금 스코어로 끝나면", () => {
  it("홈(C)이 3점 차로 이기면 C 5-2가 B 4-3을 앞지른다 - 순위 변동(prevRank)과 1위 기준 게임차", () => {
    const got = projectStandings(base, "C", "B", 3);
    expect(brief(got)).toEqual(["1:A 5-1", "2:C 5-2", "3:B 4-3", "4:D 3-3", "5:E 2-4", "6:F 1-5"]);
    expect(got.find((r) => r.tcode === "C")).toMatchObject({ rank: 2, prevRank: 3, gb: 0.5 });
    expect(got.find((r) => r.tcode === "B")).toMatchObject({ rank: 3, prevRank: 2, gb: 1.5 });
    expect(got.find((r) => r.tcode === "C")!.diff).toBeCloseTo((2 * 6 + 3) / 7); // 평균 득실마진에 이 경기 마진을 더한다
  });

  it("동점(마진 0)이면 결과를 더하지 않는다 - 이 경기 전 순위 그대로", () => {
    const got = projectStandings(base, "C", "B", 0);
    expect(brief(got)).toEqual(["1:A 5-1", "2:B 4-2", "3:C 4-2", "4:D 3-3", "5:E 2-4", "6:F 1-5"]);
    expect(got.every((r) => r.rank === r.prevRank)).toBe(true);
  });

  it("아직 경기가 없던 팀(시즌 첫 경기)도 표에 넣는다 - 이전 순위는 없음(null)", () => {
    const got = projectStandings(base, "G", "F", 5);
    expect(got[0]).toMatchObject({ tcode: "G", wins: 1, losses: 0, rank: 1, prevRank: null });
    expect(got.find((r) => r.tcode === "F")).toMatchObject({ wins: 1, losses: 6, rank: 7, prevRank: 6 });
  });

  it("정렬 규칙은 사이트 순위표(computeStandings)와 같다 - 마진 0 투영이 그 순서를 그대로 돌려준다", () => {
    const g = (home: string, away: string, hs: number, as: number, d: string): StandingsGameRow => ({ home_tcode: home, away_tcode: away, home_score: hs, away_score: as, game_date: d, game_start: null });
    const rows = computeStandings([g("P", "Q", 80, 70, "2026-10-03"), g("R", "S", 75, 74, "2026-10-03"), g("Q", "R", 90, 60, "2026-10-04"), g("S", "P", 66, 65, "2026-10-04")]);
    expect(projectStandings(rows, "P", "Q", 0).map((r) => r.tcode)).toEqual(rows.map((r) => r.tcode));
  });
});
