import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildRecordTimeline, recordLine } from "./records";
import { summarizeRecordBook, type RecordEntry } from "./recordBook";

// 실전 재현(설계 §10-4): 2026-10-07 S49G01N9(KCC-가스공사)의 실제 이벤트를 "그 경기 이전" 기록으로 재생하면
// 허훈의 8번째 어시스트는 타이 기록(공동 1위), 9번째는 신기록(종전 8개)으로 알려야 한다.
// 이전 기록 = 검증을 통과한 쿼터 어시스트 8개 6건(문태종 2010, 박지현 2011, 이정현 2019, 허훈 2020, 마레이 2025, 박지훈 2026) + 7개 몇 건.

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "recordParity", "S49G01N9.json");
type Fixture = { events: [string | null, string | null, string, string, number | null, number | null][] };

const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
const events = fx.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec]) => ({ pcode, tcode, action_code, quarter, clock_min, clock_sec }));

// 이 경기 1쿼터에서 어시스트가 가장 많은 KCC(tcode 60) 선수 = 허훈
const q1Assists = new Map<string, number>();
for (const ev of events) if (ev.action_code === "211" && ev.quarter === "Q1" && ev.tcode === "60" && ev.pcode) q1Assists.set(ev.pcode, (q1Assists.get(ev.pcode) ?? 0) + 1);
const HOON = [...q1Assists.entries()].sort((a, b) => b[1] - a[1])[0][0];

const entry = (subject: string, name: string, gmkey: string, date: string, bucket: string, value: number): RecordEntry => ({
  board: "pq.ast.max", bucket, gmkey, subject, period: bucket, value, date, start: "", name,
});
const ENTRIES: RecordEntry[] = [
  entry("p1", "문태종", "S17G01N93", "2010-12-15", "Q1", 8),
  entry("p2", "박지현", "S19G01N30", "2011-10-27", "Q3", 8),
  entry("p3", "이정현", "S35G01N46", "2019-11-01", "Q2", 8),
  entry("p4", "허훈", "S35G01N201", "2020-02-09", "Q1", 8),
  entry("p5", "아셈 마레이", "S45G01N231", "2025-03-20", "Q1", 8),
  entry("p6", "박지훈", "S47G01N224", "2026-03-09", "Q3", 8),
  ...["이상민", "김학섭", "주희정", "김승현"].map((n, i) => entry(`s${i}`, n, `S1${i}G01N1`, `2008-01-0${i + 1}`, "Q1", 7)),
  // 이 경기 자신의 행(종료 후 테이블에 들어간 것) - "그 경기 이전" 요약에서는 빠져야 한다
  entry(HOON, "허훈", "S49G01N9", "2026-10-07", "Q1", 9),
];
const AT = { date: "2026-10-07", start: "19:00", gmkey: "S49G01N9" };
const names = { player: (p: string) => p, team: (t: string) => t };
const hoonMoments = (ms: ReturnType<typeof buildRecordTimeline>) => ms.filter((x) => x.phase === "done" && x.board === "pq.ast.max" && x.period === "Q1" && x.subject === HOON && x.value >= 8);

describe("실전 재현 - S49G01N9 허훈 1쿼터 9어시스트", () => {
  it("라이브(잠정): 8번째 어시스트 타이 기록(공동 1위), 9번째 신기록(종전 8개)", () => {
    const ctx = summarizeRecordBook(ENTRIES, AT, false)!;
    expect(ctx.boards["pq.ast.max|ALL"].tops.slice(0, 6)).toEqual([8, 8, 8, 8, 8, 8]); // 자기 자신의 9는 요약에 없다
    const m = hoonMoments(buildRecordTimeline(ctx, events, { names, final: false }));
    expect(m.map((x) => [x.value, x.rank, x.tie, x.breaks])).toEqual([
      [8, 1, true, false],
      [9, 1, false, true],
    ]);
    expect(m[0].text).toBe("1쿼터 어시스트 8개 KBL 타이 기록(공동 1위)");
    expect(m[1].text).toBe("1쿼터 어시스트 9개 KBL 신기록(종전 8개)");
    expect(m[1].detail).toBe("문태종·박지현·이정현 외 3건 보유");
    expect(recordLine(m[1])).toBe("1쿼터 어시스트 9개 KBL 신기록(종전 8개 · 문태종·박지현·이정현 외 3건 보유)");
    expect(m[1].provisional).toBe(true);
    expect(m[1].idx).toBeGreaterThan(m[0].idx);
  });

  it("종료 경기: 정산된 행(이 경기의 허훈)이 validated에 있으면 같은 알림이 '잠정' 없이 남는다", () => {
    const ctx = summarizeRecordBook(ENTRIES, AT, true)!;
    expect(ctx.validated).toEqual([`pq.ast.max|Q1|${HOON}|Q1`]);
    const m = hoonMoments(buildRecordTimeline(ctx, events, { names, final: true }));
    expect(m.map((x) => x.value)).toEqual([8, 9]);
    expect(m.every((x) => x.provisional === false)).toBe(true);
  });

  it("종료 경기라도 테이블에 이 경기 행이 없으면(검증 탈락·정산 전) 기록을 주장하지 않는다", () => {
    const ctx = summarizeRecordBook(ENTRIES.filter((x) => x.gmkey !== "S49G01N9"), AT, true)!;
    expect(ctx.validated).toEqual([]);
    expect(buildRecordTimeline(ctx, events, { names, final: true })).toEqual([]);
  });
});
