import { describe, expect, it } from "vitest";
import { isRecordEligible, summarizeRecordBook, type RecordEntry } from "./recordBook";

const e = (o: Partial<RecordEntry> & Pick<RecordEntry, "value">): RecordEntry => ({
  board: "pq.ast.max", bucket: "Q1", gmkey: "G0", subject: "p", period: "Q1", date: "2020-02-09", start: "14:00", name: "허훈", ...o,
});
const AT = { date: "2026-10-07", start: "19:00", gmkey: "S49G01N9" };

describe("summarizeRecordBook - 그 경기 이전 기준", () => {
  it("이전 날짜·같은 날 이른 경기만 포함하고, 같은 시각·늦은 시각·자기 자신은 뺀다", () => {
    const rows = [
      e({ value: 8, gmkey: "A", date: "2026-10-06" }),
      e({ value: 7, gmkey: "B", date: "2026-10-07", start: "16:00" }),   // 같은 날 이른 경기 - 포함
      e({ value: 9, gmkey: "C", date: "2026-10-07", start: "19:00" }),   // 같은 시각 - 제외
      e({ value: 9, gmkey: "D", date: "2026-10-07", start: "20:00" }),   // 늦은 경기 - 제외
      e({ value: 9, gmkey: "S49G01N9", date: "2026-10-07", start: "19:00" }), // 자기 자신 - 제외
      e({ value: 9, gmkey: "E", date: "2026-10-08" }),                    // 미래 - 제외
    ];
    const ctx = summarizeRecordBook(rows, AT, false)!;
    expect(ctx.boards["pq.ast.max|Q1"].tops).toEqual([8, 7]);
    expect(ctx.asOf).toBe("2026-10-07 19:00");
    expect(ctx.validated).toBeUndefined();
  });

  it("공동 순위로 TOP10까지(동률은 모두), 보유자는 순위 3위까지 최대 6개", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => e({ value: 8, gmkey: `E${i}`, name: `선수${i}` })),
      ...Array.from({ length: 5 }, (_, i) => e({ value: 7, gmkey: `S${i}` })),     // 순위 7 (6건 뒤)
      ...Array.from({ length: 3 }, (_, i) => e({ value: 6, gmkey: `X${i}` })),     // 순위 12 -> TOP10 밖
    ];
    const s = summarizeRecordBook(rows, AT, false)!.boards["pq.ast.max|Q1"];
    expect(s.tops).toEqual([8, 8, 8, 8, 8, 8, 7, 7, 7, 7, 7]);   // 순위 1 x6, 순위 7 x5 (순위 12의 6은 제외)
    expect(s.holders).toHaveLength(6);                            // 순위 <= 3은 8의 6건뿐(7은 순위 7)
    expect(s.holders.every((h) => h.v === 8)).toBe(true);
  });

  it("쿼터 보드는 구간별 + ALL(Q1~Q4 합집합), 연장(OT)은 따로, 경기 보드는 G", () => {
    const rows = [
      e({ value: 9, bucket: "Q1", gmkey: "A" }),
      e({ value: 8, bucket: "Q3", period: "Q3", gmkey: "B" }),
      e({ value: 20, bucket: "OT", period: "X1", gmkey: "C", board: "pq.pts.max" }),
      e({ value: 21, bucket: "G", period: "", gmkey: "D", board: "pg.ast.max" }),
    ];
    const b = summarizeRecordBook(rows, AT, false)!.boards;
    expect(b["pq.ast.max|Q1"].tops).toEqual([9]);
    expect(b["pq.ast.max|Q3"].tops).toEqual([8]);
    expect(b["pq.ast.max|ALL"].tops).toEqual([9, 8]);
    expect(b["pq.pts.max|OT"].tops).toEqual([20]);
    expect(b["pq.pts.max|ALL"]).toBeUndefined();                  // 연장은 ALL에 섞이지 않는다
    expect(b["pg.ast.max|G"].tops).toEqual([21]);
  });

  it("최소 보드는 작은 값이 좋은 순", () => {
    const rows = [5, 2, 3, 2].map((v, i) => e({ value: v, board: "tq.pts.min", bucket: "Q2", period: "Q2", gmkey: `M${i}` }));
    expect(summarizeRecordBook(rows, AT, false)!.boards["tq.pts.min|Q2"].tops).toEqual([2, 2, 3, 5]);
  });

  it("종료 경기는 이 경기의 행 키를 validated로(자기 행은 기록 요약에서는 빠진다)", () => {
    const rows = [e({ value: 8, gmkey: "A", date: "2026-10-06" }), e({ value: 9, gmkey: "S49G01N9", date: "2026-10-07", start: "19:00", subject: "h" })];
    const ctx = summarizeRecordBook(rows, AT, true)!;
    expect(ctx.validated).toEqual(["pq.ast.max|Q1|h|Q1"]);
    expect(ctx.boards["pq.ast.max|Q1"].tops).toEqual([8]);
  });

  it("이전 기록이 하나도 없으면 null", () => {
    expect(summarizeRecordBook([], AT, false)).toBeNull();
    expect(summarizeRecordBook([e({ value: 9, gmkey: "S49G01N9", date: "2026-10-07" })], AT, true)).toBeNull();
  });
});

describe("isRecordEligible", () => {
  const now = Date.parse("2026-10-08T12:00:00+09:00");
  it("정규/플레이오프/챔프전, 60일 이내만", () => {
    expect(isRecordEligible({ game_date: "2026-10-07", season_category: "정규시즌" }, now)).toBe(true);
    expect(isRecordEligible({ game_date: "2026-10-09", season_category: "정규시즌" }, now)).toBe(true);     // 예정 경기
    expect(isRecordEligible({ game_date: "2026-10-07", season_category: "OPEN MATCH DAY" }, now)).toBe(false);
    expect(isRecordEligible({ game_date: "2026-07-01", season_category: "정규시즌" }, now)).toBe(false);     // 60일 초과
    expect(isRecordEligible({ game_date: "2026-05-01", season_category: "챔피언결정전" }, now)).toBe(false);
  });
});
