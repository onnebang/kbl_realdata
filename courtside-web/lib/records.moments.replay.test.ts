import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAllRecordMoments } from "./recordsMoments";
import type { BoardSummary, RecordContext, RecordEvent } from "./records";

// 실전 재현: 실제 경기 이벤트를 "그 경기 이전" 가상 기록판으로 재생해 문구와 시점을 고정한다.
//  - S45G01N231 2025-03-20 아셈 마레이 트리플더블(출전 20:25 = 1225초)
//  - S37G01N269 2021-04-06 24-0 런(2017-18 이후 최대 타이)

const DIR = join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "momentParity");
type Fixture = { home: string; away: string; events: [string | null, string | null, string, string, number | null, number | null, number, number][]; rows: [string, string, string, string, number][] };
const load = (gmkey: string) => JSON.parse(readFileSync(join(DIR, `${gmkey}.json`), "utf8")) as Fixture;
const toEvents = (fx: Fixture): RecordEvent[] =>
  fx.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score]) => ({ pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score }));
const board = (tops: number[], who: string[]): BoardSummary => ({ tops, holders: tops.slice(0, 3).map((v, i) => ({ v, who: who[i % who.length], d: "2020-01-12" })) });
const names = { player: (p: string) => p, team: (t: string) => t };

describe("실전 재생 - 마레이 트리플더블(S45G01N231)", () => {
  const fx = load("S45G01N231");
  const marey = fx.rows.find(([b]) => b === "pg.td_time.min")!;
  const ctx = (validated?: string[]): RecordContext => ({
    asOf: "2025-03-19",
    boards: {
      "pg.td_time.min|G": board([1168, 1310, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100], ["애런 헤인즈"]),
      "pg.club_td.max|G": { tops: Array<number>(76).fill(1), holders: [] },
    },
    ...(validated ? { validated } : {}),
  });
  it("라이브(잠정): 3번째 부문이 10에 닿는 순간 '출전 N분 만에 트리플더블 KBL 역대 2위'와 클럽 77번째", () => {
    expect(marey[4]).toBe(1225);
    const ms = buildAllRecordMoments(ctx(), toEvents(fx), { names, final: false, home: fx.home, away: fx.away }).filter((m) => m.subject === marey[2]);
    const td = ms.find((m) => m.board === "pg.td_time.min")!;
    expect(td.text).toBe("출전 20분 25초 만에 트리플더블 KBL 역대 2위");
    expect(td.detail).toBe("역대 1위 19분 28초: 애런 헤인즈");
    expect(td.provisional).toBe(true);
    const club = ms.find((m) => m.phase === "done" && m.board === "pg.club_td.max")!;
    expect(club.text).toBe("트리플더블 달성 — KBL 역대 77번째");
    expect(club.idx).toBe(td.idx);
  });
  it("종료 경기: 테이블에 이 경기 행이 있으면 같은 알림이 '잠정' 없이 남고, 없으면 사라진다", () => {
    const keys = [`pg.td_time.min|G|${marey[2]}|`, `pg.club_td.max|G|${marey[2]}|`];
    const fin = buildAllRecordMoments(ctx(keys), toEvents(fx), { names, final: true, home: fx.home, away: fx.away }).filter((m) => m.subject === marey[2]);
    expect(fin.filter((m) => m.phase === "done").map((m) => m.board).sort()).toEqual(["pg.club_td.max", "pg.td_time.min"]);
    expect(fin.every((m) => m.provisional === false)).toBe(true);
    expect(buildAllRecordMoments(ctx([]), toEvents(fx), { names, final: true, home: fx.home, away: fx.away }).filter((m) => m.board.startsWith("pg.td_time"))).toEqual([]);
  });
});

describe("실전 재생 - 24-0 런(S37G01N269)", () => {
  const fx = load("S37G01N269");
  it("21-0(공동 7위)·23-0(공동 3위)은 순위 알림, 24-0은 타이 기록(공동 1위) - 3점슛·자유투가 섞여 값이 홀수로도 뛴다", () => {
    const tops = [24, 24, 23, 23, 22, 22, 21, 21, 20, 20];
    const ctx: RecordContext = { asOf: "2021-04-05", boards: { "tg.run.max|G": board(tops, ["안양 정관장"]) } };
    const runs = buildAllRecordMoments(ctx, toEvents(fx), { names, final: false, home: fx.home, away: fx.away }).filter((m) => m.phase === "done" && m.board === "tg.run.max");
    expect(runs.map((m) => [m.value, m.rank])).toEqual([[21, 7], [23, 3], [24, 1]]);
    expect(runs[runs.length - 1].text).toBe("24-0 런 KBL 2017-18 이후 타이 기록(공동 1위)");
  });
});
