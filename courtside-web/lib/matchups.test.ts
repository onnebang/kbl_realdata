import { describe, expect, it } from "vitest";
import { computeStandings, type StandingsGameRow } from "./matchups";

function game(date: string, home: string, away: string, homeScore: number, awayScore: number): StandingsGameRow {
  return { home_tcode: home, away_tcode: away, home_score: homeScore, away_score: awayScore, game_date: date, game_start: null };
}

describe("computeStandings", () => {
  it("빈 경기 목록이면 빈 배열", () => {
    expect(computeStandings([])).toEqual([]);
  });

  it("승-패-승률을 집계하고 승률 내림차순으로 정렬한다", () => {
    const rows = computeStandings([
      game("2026-01-01", "A", "B", 100, 90), // A승
      game("2026-01-02", "A", "B", 80, 95), // B승
      game("2026-01-03", "A", "B", 100, 95), // A승
    ]);
    const a = rows.find((r) => r.tcode === "A")!;
    const b = rows.find((r) => r.tcode === "B")!;
    expect(a.wins).toBe(2);
    expect(a.losses).toBe(1);
    expect(b.wins).toBe(1);
    expect(b.losses).toBe(2);
    expect(rows[0].tcode).toBe("A"); // 승률 높은 쪽이 1위
  });

  it("연속 승/패 스트릭은 날짜순 마지막 경기 기준으로 뒤에서부터 센다", () => {
    const rows = computeStandings([
      game("2026-01-01", "A", "B", 80, 100), // A패
      game("2026-01-02", "A", "B", 100, 90), // A승
      game("2026-01-03", "A", "B", 100, 95), // A승
    ]);
    const a = rows.find((r) => r.tcode === "A")!;
    expect(a.streak).toEqual({ result: "W", length: 2 });
    const b = rows.find((r) => r.tcode === "B")!;
    expect(b.streak).toEqual({ result: "L", length: 2 });
  });

  it("입력 배열의 날짜 순서와 무관하게 game_date로 다시 정렬해서 스트릭을 센다", () => {
    const rows = computeStandings([
      game("2026-01-03", "A", "B", 100, 95), // A승(가장 최근)
      game("2026-01-01", "A", "B", 80, 100), // A패(가장 이전)
      game("2026-01-02", "A", "B", 100, 90), // A승
    ]);
    const a = rows.find((r) => r.tcode === "A")!;
    expect(a.streak).toEqual({ result: "W", length: 2 });
  });

  it("승률이 같으면 경기 수가 달라도 게임차가 음수로 떨어지지 않는다(1승0패 vs 2승0패)", () => {
    const rows = computeStandings([
      game("2026-01-01", "A", "X", 100, 90), // A 1승0패
      game("2026-01-01", "B", "Y", 100, 90), // B 1승
      game("2026-01-02", "B", "Y", 100, 90), // B 2승0패
    ]);
    const a = rows.find((r) => r.tcode === "A")!;
    const b = rows.find((r) => r.tcode === "B")!;
    expect(a.pct).toBe(1);
    expect(b.pct).toBe(1);
    expect(a.gb).toBe(0);
    expect(b.gb).toBe(0);
  });

  it("게임차는 (승수차+패수차)/2, 1위는 0", () => {
    const rows = computeStandings([
      game("2026-01-01", "A", "B", 100, 90),
      game("2026-01-02", "A", "B", 100, 90),
      game("2026-01-03", "A", "B", 80, 100),
      game("2026-01-04", "A", "B", 80, 100),
    ]);
    // A: 2승 2패, B: 2승 2패 -> 동률(승률 같음), 게임차 0
    expect(rows[0].gb).toBe(0);
    expect(rows[1].gb).toBe(0);
  });

  it("최근10경기/홈/원정 분리와 득실마진 평균을 계산한다", () => {
    const rows = computeStandings([
      game("2026-01-01", "A", "B", 110, 100), // A 홈 10점차 승
      game("2026-01-02", "B", "A", 100, 90), // A 원정 10점차 패
    ]);
    const a = rows.find((r) => r.tcode === "A")!;
    expect(a.home).toEqual({ wins: 1, losses: 0 });
    expect(a.away).toEqual({ wins: 0, losses: 1 });
    expect(a.last10).toEqual({ wins: 1, losses: 1 });
    expect(a.diff).toBe(0); // +10, -10 평균 0
  });
});
