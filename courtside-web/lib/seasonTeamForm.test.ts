import { describe, expect, it } from "vitest";
import type { SeasonGameRow } from "./seasonBrowser";
import {
  buildTeamLines,
  categoryTag,
  involves,
  koDayOfWeek,
  listTeams,
  orderCategories,
  perspective,
  relayHref,
} from "./seasonTeamForm";

const A = { tcode: "01", name: "에이", abbr: "AAA", color: "#111111", logo_url: null };
const B = { tcode: "02", name: "비", abbr: "BBB", color: "#222222", logo_url: null };
const C = { tcode: "03", name: "씨", abbr: "CCC", color: "#333333", logo_url: null };

function game(n: number, home: typeof A, away: typeof A, hs: number | null, as: number | null): SeasonGameRow {
  return {
    gmkey: `G${n}`,
    game_date: `2026-10-${String(n).padStart(2, "0")}`,
    home_score: hs,
    away_score: as,
    season_category: "정규시즌",
    home_team: home,
    away_team: away,
  };
}

// A: W(홈 80-70 vs B) W(원정 90-60 vs C) L(홈 50-55 vs B) -> 2-1, 최근 W W L, 연속 1패
const games = [game(1, A, B, 80, 70), game(2, C, A, 60, 90), game(3, A, B, 50, 55), game(4, B, C, 70, 70), game(5, B, C, null, null)];

describe("buildTeamLines", () => {
  const lines = buildTeamLines(games, listTeams(games));
  const a = lines.find((l) => l.tcode === "01")!;

  it("전적·득실·홈원정을 센다", () => {
    expect([a.w, a.l]).toEqual([2, 1]);
    expect(a.home).toEqual({ w: 1, l: 1 });
    expect(a.away).toEqual({ w: 1, l: 0 });
    expect(a.diff).toBe(80 + 90 + 50 - (70 + 60 + 55));
    expect(a.pf).toBeCloseTo(220 / 3);
  });

  it("최근 폼은 오래된 순, 연속은 마지막 결과 기준", () => {
    expect(a.form).toEqual(["W", "W", "L"]);
    expect(a.streak).toEqual({ type: "L", n: 1 });
  });

  it("동점·무점수(진행 중) 경기는 건너뛴다", () => {
    const c = lines.find((l) => l.tcode === "03")!;
    expect([c.w, c.l]).toEqual([0, 1]);
  });

  it("승률 순으로 정렬하고, 경기 없는 팀도 0전적으로 남긴다", () => {
    expect(lines.map((l) => l.tcode)).toEqual(["01", "02", "03"]);
    const withExtra = buildTeamLines(games.slice(0, 1), [A, B, C]);
    expect(withExtra[2].tcode).toBe("03");
    expect([withExtra[2].w, withExtra[2].l, withExtra[2].streak]).toEqual([0, 0, null]);
  });

  it("최근 폼은 5경기까지만", () => {
    const many = Array.from({ length: 7 }, (_, i) => game(i + 1, A, B, 80, 70));
    expect(buildTeamLines(many, [A, B])[0].form).toHaveLength(5);
    expect(buildTeamLines(many, [A, B])[0].streak).toEqual({ type: "W", n: 7 });
  });
});

describe("helpers", () => {
  it("perspective: 원정팀 기준으로 뒤집는다", () => {
    expect(perspective(games[1], "01")).toMatchObject({ isHome: false, us: 90, them: 60, won: true });
    expect(perspective(games[1], "01").opp?.tcode).toBe("03");
    expect(involves(games[1], "02")).toBe(false);
  });

  it("relayHref: 경기 페이지의 실시간 중계 탭으로", () => {
    expect(relayHref("S49G14N1")).toBe("/games/S49G14N1?tab=live");
    expect(relayHref("a b")).toBe("/games/a%20b?tab=live");
  });

  it("koDayOfWeek / categoryTag / orderCategories", () => {
    expect(koDayOfWeek("2026-10-12")).toBe("월");
    expect(categoryTag("정규시즌")).toBeNull();
    expect(categoryTag("OPEN MATCH DAY")).toBe("OMD");
    expect(orderCategories(["OPEN MATCH DAY", "플레이오프", "정규시즌"])).toEqual(["정규시즌", "플레이오프", "OPEN MATCH DAY"]);
  });
});
