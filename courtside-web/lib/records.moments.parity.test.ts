import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMomentTimeline } from "./recordsMoments";
import type { RecordEvent } from "./records";

// 파이썬(tools/record_book.py moment_candidates)이 실제 경기에서 만든 2단계 후보 행과 웹 엔진(recordsMoments)의 최종 값이 같은지 대조한다.
// 픽스처는 tools/dump_record_fixtures.py --moments 로 만든다(이벤트 쿼터 득점 = 공식 쿼터 점수인 경기만).

const DIR = process.env.RECORD_MOMENT_PARITY_DIR ?? join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "momentParity");
type Fixture = {
  gmkey: string; home: string; away: string;
  events: [string | null, string | null, string, string, number | null, number | null, number, number][];
  rows: [string, string, string, string, number][];
};

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => join(DIR, f)) : [];

describe("파이썬 2단계 후보 행 vs 웹 순간 기록 최종 값", () => {
  it("픽스처가 있다", () => {
    expect(files.length).toBeGreaterThan(5);
  });
  for (const file of files) {
    it(file.split(/[\\/]/).slice(-1)[0], () => {
      const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
      const events: RecordEvent[] = fx.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score]) => ({
        pcode, tcode, action_code, quarter, clock_min, clock_sec, home_score, away_score,
      }));
      const finals = new Map<string, number>();
      buildMomentTimeline({ asOf: "x", boards: {} }, events, { names: { player: (p) => p, team: (t) => t }, final: true, home: fx.home, away: fx.away }, finals);
      const bad = fx.rows.filter(([board, bucket, subject, period, value]) => finals.get(`${board}|${bucket}|${subject}|${period}`) !== value);
      expect(bad.slice(0, 5).map((r) => ({ row: r, got: finals.get(`${r[0]}|${r[1]}|${r[2]}|${r[3]}`) }))).toEqual([]);
      expect(fx.rows.length).toBeGreaterThan(0);
    });
  }
  it("보드 종류가 고루 덮인다(점수차·벤치·클럽·시간·창·런 중 대부분)", () => {
    const seen = new Set<string>();
    for (const file of files) for (const r of (JSON.parse(readFileSync(file, "utf8")) as Fixture).rows) seen.add(r[0]);
    for (const b of ["tg.margin.max", "pg.benchpts.max", "pg.club_td.max", "pg.dd_time.min", "pg.td_time.min", "pg.burst35.max", "tg.run.max"]) expect(seen.has(b)).toBe(true);
  });
});
