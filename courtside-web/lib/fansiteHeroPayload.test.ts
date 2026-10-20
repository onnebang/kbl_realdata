import { describe, expect, it } from "vitest";
import { buildHeroPayload, parseTeamParam, type HeroRow } from "./fansiteHeroPayload";
import { SITE_URL } from "./site";

const WONJU = { tcode: "16", name: "원주 DB" };
const SEOUL = { tcode: "10", name: "서울 SK" };
const NOW = new Date("2026-10-20T03:00:00Z");

const row = (over: Partial<HeroRow> = {}): HeroRow => ({
  gmkey: "S01G01N0100",
  game_date: "2026-10-25",
  game_start: "15:00:00",
  stadium: "원주종합체육관",
  home_score: null,
  away_score: null,
  is_ended: false,
  season_name: "2026-2027",
  home_team: WONJU,
  away_team: SEOUL,
  ...over,
});
const build = (over: Partial<Parameters<typeof buildHeroPayload>[0]> = {}) =>
  buildHeroPayload({ team: WONJU, live: null, last: null, upcoming: [], mvps: new Map(), now: NOW, ...over });
// getGameMvps가 주는 모양(pcode 포함) - 응답에는 name·pts만 나가야 한다
const top = (name: string, pts: number) => ({ pcode: `P-${name}`, name, pts });

describe("buildHeroPayload", () => {
  it("is a version 1 payload with nothing in it when there are no games", () => {
    expect(build()).toEqual({
      version: 1,
      team: WONJU,
      generatedAt: "2026-10-20T03:00:00.000Z",
      live: null,
      last: null,
      upcoming: [],
    });
  });

  it("describes an upcoming home game from our side", () => {
    expect(build({ upcoming: [row()] }).upcoming).toEqual([
      {
        gmkey: "S01G01N0100",
        date: "2026-10-25",
        time: "15:00",
        stadium: "원주종합체육관",
        home: true,
        opponent: SEOUL,
        us: null,
        them: null,
        status: "scheduled",
        url: `${SITE_URL}/games/S01G01N0100`,
      },
    ]);
  });

  it("flips home/away so us and them always mean the requested team", () => {
    const away = row({ home_team: SEOUL, away_team: WONJU, home_score: 70, away_score: 80, is_ended: true });
    expect(build({ last: away }).last).toMatchObject({ home: false, us: 80, them: 70, status: "final", opponent: SEOUL });
  });

  it("leaves time and stadium null when the row has none or junk", () => {
    const [a, b] = build({
      upcoming: [row({ game_start: null, stadium: null }), row({ game_start: "TBD", stadium: "  " })],
    }).upcoming;
    expect([a.time, a.stadium]).toEqual([null, null]);
    expect([b.time, b.stadium]).toEqual([null, null]);
    expect(build({ upcoming: [row({ game_start: "19:30:00" })] }).upcoming[0].time).toBe("19:30");
  });

  it("reports a game with a score that has not ended as live", () => {
    expect(build({ live: row({ home_score: 41, away_score: 38 }) }).live).toMatchObject({ status: "live", us: 41, them: 38 });
  });

  it("gives the winner's best as MVP and the same player as ours after a win, without extra fields", () => {
    const won = row({ home_score: 86, away_score: 79, is_ended: true });
    const mvps = new Map([[won.gmkey, { winnerTop: top("김승리", 21), loserTop: top("박패배", 18) }]]);
    const last = build({ last: won, mvps }).last!;
    expect(last.mvp).toEqual({ name: "김승리", pts: 21 });
    expect(last.ourTop).toEqual({ name: "김승리", pts: 21 });
  });

  it("after a loss the MVP is the opponent's and ourTop is our own best", () => {
    const lost = row({ home_score: 79, away_score: 86, is_ended: true });
    const mvps = new Map([[lost.gmkey, { winnerTop: top("김상대", 27), loserTop: top("박원주", 18) }]]);
    const last = build({ last: lost, mvps }).last!;
    expect(last.mvp).toEqual({ name: "김상대", pts: 27 });
    expect(last.ourTop).toEqual({ name: "박원주", pts: 18 });
  });

  it("has no player lines until the box score exists", () => {
    const last = build({ last: row({ home_score: 86, away_score: 79, is_ended: true }) }).last!;
    expect(last.mvp).toBeNull();
    expect(last.ourTop).toBeNull();
  });

  it("keeps at most two scheduled games in order and drops anything that is not scheduled", () => {
    const rows = [row({ gmkey: "L", home_score: 10, away_score: 8 }), row({ gmkey: "A" }), row({ gmkey: "B" }), row({ gmkey: "C" })];
    expect(build({ upcoming: rows }).upcoming.map((g) => g.gmkey)).toEqual(["A", "B"]);
  });

  it("uses the name the opponent had in that season", () => {
    const kcc = { tcode: "60", name: "전주 KCC" };
    const g = build({ upcoming: [row({ away_team: kcc, season_name: "2024-2025" })] }).upcoming[0];
    expect(g.opponent).toEqual({ tcode: "60", name: "부산 KCC" });
  });

  it("skips a game whose team join is missing", () => {
    const rows = [row({ gmkey: "X", home_team: null }), row({ gmkey: "OK" })];
    expect(build({ upcoming: rows }).upcoming.map((g) => g.gmkey)).toEqual(["OK"]);
  });
});

describe("parseTeamParam", () => {
  it("accepts a two digit team code only", () => {
    expect(parseTeamParam("16")).toBe("16");
    for (const bad of [null, "", "1", "160", "ab", "1a", " 16", "16 ", "16;"]) expect(parseTeamParam(bad)).toBeNull();
  });
});
