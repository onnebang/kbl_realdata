import { beforeEach, describe, expect, it, vi } from "vitest";

// 공개 키로는 teams / game_player_stats가 비어(RLS) 로컬에서 실제 DB로 끝까지 돌 수 없다. 운영은 서버 전용 키를 쓴다.
// 그래서 조회 배선(어떤 필터·정렬로 묻는지, MVP를 어떻게 잇는지, 오류가 어디로 가는지)은 가짜 클라이언트로 시험한다.
// 행의 모양과 값은 2026-10-20 운영 데이터를 옮긴 것이다(원주 DB 16: 10/19 대구전 104:78 승, 이후 두 경기는 원정).
type Call = [method: string, ...args: unknown[]];
const state = vi.hoisted(() => ({
  team: null as { tcode: string; name: string } | null,
  fail: null as Error | null,
  rows: { live: [], last: [], upcoming: [] } as { live: unknown[]; last: unknown[]; upcoming: unknown[] },
  seen: [] as { table: string; calls: Call[] }[],
}));

vi.mock("./supabaseServer", () => {
  const from = (table: string) => {
    const calls: Call[] = [];
    state.seen.push({ table, calls });
    const b: Record<string, unknown> = {};
    for (const m of ["select", "or", "not", "eq", "is", "gte", "order", "limit"]) {
      b[m] = (...args: unknown[]) => (calls.push([m, ...args]), b);
    }
    const result = () => {
      if (state.fail) throw state.fail;
      if (table === "teams") return { data: state.team };
      const has = (m: string, ...a: unknown[]) => calls.some((c) => c[0] === m && a.every((x, i) => c[i + 1] === x));
      const kind = has("is", "home_score", null) ? "upcoming" : has("eq", "is_ended", true) ? "last" : "live";
      return { data: state.rows[kind] };
    };
    b.maybeSingle = async () => result();
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve().then(result).then(ok, bad);
    return b;
  };
  return { supabaseServer: { from } };
});
vi.mock("./homeGames", () => ({
  GAME_SELECT: "gmkey",
  kstToday: () => "2026-10-20",
  getGameMvps: vi.fn(async (games: { gmkey: string }[]) =>
    new Map([
      [
        games[0].gmkey,
        { winnerTop: { pcode: "P1", name: "이선 알바노", pts: 16 }, loserTop: { pcode: "P2", name: "라건아", pts: 17 }, sixthMan: null },
      ],
    ])
  ),
}));

import { getGameMvps } from "./homeGames";
import { getHeroPayload } from "./fansiteHero";

const team = (tcode: string, name: string) => ({ tcode, name, abbr: "", color: "", logo_url: null });
const WONJU = team("16", "원주 DB");
const row = (over: Record<string, unknown>) => ({
  game_start: "19:00:00",
  home_score: null,
  away_score: null,
  is_ended: false,
  season_category: "정규시즌",
  season_name: "2026-2027",
  ...over,
});
const LAST = row({
  gmkey: "S49G01N29",
  game_date: "2026-10-19",
  stadium: "원주DB프로미아레나",
  home_score: 104,
  away_score: 78,
  is_ended: true,
  home_team: WONJU,
  away_team: team("64", "대구 한국가스공사"),
});
const NEXT1 = row({ gmkey: "S49G01N33", game_date: "2026-10-23", stadium: "수원 KT 소닉붐 아레나", home_team: team("06", "수원 KT"), away_team: WONJU });
const NEXT2 = row({
  gmkey: "S49G01N38",
  game_date: "2026-10-25",
  game_start: "14:00:00",
  stadium: "안양 정관장 아레나",
  home_team: team("70", "안양 정관장"),
  away_team: WONJU,
});

beforeEach(() => {
  state.team = { tcode: "16", name: "원주 DB" };
  state.fail = null;
  state.rows = { live: [], last: [LAST], upcoming: [NEXT1, NEXT2] };
  state.seen.length = 0;
  vi.mocked(getGameMvps).mockClear();
});

describe("getHeroPayload", () => {
  it("builds the payload from the three game queries and the last game's MVP", async () => {
    const p = (await getHeroPayload("16"))!;
    expect(p.team).toEqual({ tcode: "16", name: "원주 DB" });
    expect(p.live).toBeNull();
    expect(p.last).toMatchObject({
      gmkey: "S49G01N29",
      home: true,
      us: 104,
      them: 78,
      status: "final",
      stadium: "원주DB프로미아레나",
      opponent: { tcode: "64", name: "대구 한국가스공사" },
      mvp: { name: "이선 알바노", pts: 16 },
      ourTop: { name: "이선 알바노", pts: 16 },
    });
    expect(p.upcoming.map((g) => [g.gmkey, g.home, g.time, g.stadium])).toEqual([
      ["S49G01N33", false, "19:00", "수원 KT 소닉붐 아레나"],
      ["S49G01N38", false, "14:00", "안양 정관장 아레나"],
    ]);
    expect(getGameMvps).toHaveBeenCalledWith([LAST]);
  });

  it("asks for live, last and upcoming games of the team with the filters the contract names", async () => {
    await getHeroPayload("16");
    const games = state.seen.filter((s) => s.table === "games").map((s) => s.calls);
    expect(games).toHaveLength(3);
    for (const calls of games) expect(calls).toContainEqual(["or", "home_tcode.eq.16,away_tcode.eq.16"]);
    const [live, last, upcoming] = [
      games.find((c) => c.some((x) => x[0] === "eq" && x[1] === "is_ended" && x[2] === false))!,
      games.find((c) => c.some((x) => x[0] === "eq" && x[1] === "is_ended" && x[2] === true))!,
      games.find((c) => c.some((x) => x[0] === "is"))!,
    ];
    // 진행 중은 어제(KST)까지만, 다가오는 경기는 오늘부터 기간 제한 없이 2건
    expect(live).toContainEqual(["not", "home_score", "is", null]);
    expect(live).toContainEqual(["gte", "game_date", "2026-10-19"]);
    expect(live).toContainEqual(["limit", 1]);
    expect(last).toContainEqual(["order", "game_date", { ascending: false }]);
    expect(last).toContainEqual(["limit", 1]);
    expect(upcoming).toContainEqual(["gte", "game_date", "2026-10-20"]);
    expect(upcoming).toContainEqual(["limit", 2]);
    expect(upcoming.some((x) => x[0] === "lte")).toBe(false);
  });

  it("returns null for an unknown team and reads no box score", async () => {
    state.team = null;
    expect(await getHeroPayload("00")).toBeNull();
    expect(getGameMvps).not.toHaveBeenCalled();
  });

  it("looks up no MVP when the team has not finished a game yet", async () => {
    state.rows = { live: [], last: [], upcoming: [NEXT1] };
    const p = (await getHeroPayload("16"))!;
    expect(p.last).toBeNull();
    expect(p.upcoming).toHaveLength(1);
    expect(getGameMvps).not.toHaveBeenCalled();
  });

  it("lets database errors through so the route can answer 502", async () => {
    state.fail = new Error("boom");
    await expect(getHeroPayload("16")).rejects.toThrow("boom");
  });
});
