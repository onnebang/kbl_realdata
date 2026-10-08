import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RecordAccumulator } from "./records";

// 파이썬(tools/record_book.py)이 실제 경기에서 만든 후보 행과 웹 엔진(RecordAccumulator)의 누적이 같은지 대조한다 - 두 언어로 따로 구현한
// 기록 정의(득점·리바·어시·스틸·블락·3점·턴오버·야투, 쿼터·연장·경기 구분)가 어긋나면 여기서 잡힌다.
// 픽스처는 tools/dump_record_fixtures.py --parity 로 만든다(공식 합계와 이벤트 합계가 전부 같은 경기만 들어간다).

const DIRS = (process.env.RECORD_PARITY_DIR ?? join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "recordParity")).split(",");

type Fixture = { gmkey: string; events: [string | null, string | null, string, string, number | null, number | null][]; rows: [string, string, string, string, number][] };

const files = DIRS.filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => join(d, f)));

describe("파이썬 후보 행 vs 웹 엔진 누적", () => {
  it("픽스처가 있다", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    it(file.split(/[\\/]/).slice(-1)[0], () => {
      const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
      const acc = new RecordAccumulator();
      for (const [pcode, tcode, action_code, quarter, clock_min, clock_sec] of fx.events) acc.apply({ pcode, tcode, action_code, quarter, clock_min, clock_sec });
      const got = acc.finalValues();
      const bad = fx.rows.filter(([board, bucket, subject, period, value]) => got.get(`${board}|${bucket}|${subject}|${period}`) !== value);
      expect(bad.slice(0, 5).map((r) => ({ row: r, got: got.get(`${r[0]}|${r[1]}|${r[2]}|${r[3]}`) }))).toEqual([]);
      expect(fx.rows.length).toBeGreaterThan(100);
    });
  }
});
