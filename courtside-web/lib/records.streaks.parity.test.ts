import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RecordEvent } from "./records";
import { STREAK_KINDS, type StreakContext, type StreakKind } from "./streakKinds";
import { buildGameStreakMoments } from "./gameStreakMoments";
import { buildSeasonMoments } from "./seasonMoments";
import { buildStreakMoments } from "./streakMoments";

// 파이썬 상태기계(tools/record_streaks.py)가 실제 경기에서 계산한 (선수, 종류)별 [경기 전, 경기 후] 연속 길이와 한 경기 안 연속 후보 행을 웹 엔진이
// "경기 전 상태 + 이 경기 이벤트"만으로 똑같이 재현하는지 대조한다. 픽스처는 tools/dump_record_fixtures.py --streaks 로 만든다.

const DIR = process.env.RECORD_STREAK_PARITY_DIR ?? join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "streakParity");
type Fixture = {
  gmkey: string; home: string; away: string;
  events: [string | null, string | null, string, string, number | null, number | null, number, number][];
  state: Record<string, Record<string, [number, number]>>;
  single: [string, string, number][];
};
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => join(DIR, f)) : [];

describe("파이썬 연속 상태 vs 웹 엔진(경기 전 상태 + 이벤트)", () => {
  it("픽스처가 있고 앞 경기에서 10개 이상 이어져 들어온 슛 연속이 충분히 덮인다", () => {
    expect(files.length).toBeGreaterThan(3);
    let carried = 0;
    for (const f of files) for (const kinds of Object.values((JSON.parse(readFileSync(f, "utf8")) as Fixture).state)) for (const [k, [b]] of Object.entries(kinds)) if (k !== "gp" && b >= 10) carried++;
    expect(carried).toBeGreaterThanOrEqual(3);
  });
  for (const file of files) {
    it(file.split(/[\\/]/).slice(-1)[0], () => {
      const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
      const events: RecordEvent[] = fx.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score]) => ({ pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score }));
      const state: StreakContext["state"] = {};
      for (const [pcode, kinds] of Object.entries(fx.state)) for (const [kind, [before]] of Object.entries(kinds)) (state[pcode] ??= {})[kind as StreakKind] = { before };
      const boards = Object.fromEntries(STREAK_KINDS.map((k) => [k, []])) as unknown as StreakContext["boards"];
      const streaks: StreakContext = { asOf: "x", final: false, boards, state, known: Object.keys(fx.state), players: {} };
      const finals = new Map<string, number>();
      const opts = { names: { player: (p: string) => p, team: (t: string) => t }, final: false, home: fx.home, away: fx.away };
      buildStreakMoments({ asOf: "x", boards: {} }, streaks, events, opts, finals);
      buildGameStreakMoments(streaks, events, opts, finals);
      buildSeasonMoments(streaks, events, opts, finals);
      // 경기 간 연속: 파이썬 로그가 있는 (선수, 종류) - 슛 종류는 경기 끝 길이가 같고, 연속 출장은 N경기째 = after
      const bad: unknown[] = [];
      for (const [pcode, kinds] of Object.entries(fx.state)) {
        for (const [kind, [, after]] of Object.entries(kinds)) {
          const key = kind === "gp" ? `gp|${pcode}` : `${kind}|${pcode}`;
          if (finals.get(key) !== after) bad.push({ pcode, kind, want: after, got: finals.get(key) });
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
      // 한 경기 안 연속(5 이상): 파이썬 후보 행과 값이 같다
      const badSingle = fx.single.filter(([board, subject, value]) => finals.get(`${board}|G|${subject}|`) !== value);
      expect(badSingle.slice(0, 5)).toEqual([]);
    });
  }
});
