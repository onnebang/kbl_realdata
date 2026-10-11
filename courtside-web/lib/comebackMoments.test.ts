import { describe, expect, it } from "vitest";
import { buildComebackMoments } from "./comebackMoments";
import { buildAllRecordMoments } from "./recordsMoments";
import type { BoardSummary, RecordContext, RecordEvent } from "./records";

const names = { player: (p: string) => `선수${p}`, team: (t: string) => `팀${t}` };
const LIVE = { names, final: false, home: "H", away: "A" };
const FINAL = { ...LIVE, final: true };
const KEY = "tg.comeback.max|G";
const TOPS = [29, 28, 26, 25, 24, 24, 23, 23, 23, 23];     // 순위 1,2,3,4,5,5,7,7,7,7 - TOP10 문턱 23
function board(tops: number[]): BoardSummary {
  const holders: BoardSummary["holders"] = [];
  let rank = 0;
  let last: number | null = null;
  tops.forEach((v, i) => {
    if (v !== last) {
      rank = i + 1;
      last = v;
    }
    if (rank <= 3 && holders.length < 6) holders.push({ v, who: `보유${i}`, d: "2022-01-09" });
  });
  return { tops, holders };
}
const ctxOf = (validated?: string[], tops = TOPS): RecordContext => ({ asOf: "2026-10-09", boards: { [KEY]: board(tops) }, ...(validated ? { validated } : {}) });
const ev = (home: number, away: number, i: number): RecordEvent => ({ pcode: "p", tcode: "H", action_code: "201", quarter: "Q1", clock_min: 9, clock_sec: 59 - (i % 50), home_score: home, away_score: away });
const seq = (pairs: [number, number][]) => pairs.map(([h, a], i) => ev(h, a, i));

/** H가 24점 뒤진 뒤(원정 2점씩 12번) 3점씩 9번으로 27-24 역전 - idx 0..11 열세, idx 12..20 추격, idx 20이 리드 탈환 */
const awayRun = Array.from({ length: 12 }, (_, i): [number, number] => [0, 2 * (i + 1)]);
const homeRun = Array.from({ length: 9 }, (_, i): [number, number] => [3 * (i + 1), 24]);
const COMEBACK = seq([...awayRun, ...homeRun]);

describe("임박(near) - 큰 열세 중인 팀", () => {
  it("20점에서 열리고 열세가 늘 때마다 새로 열리며 리드를 잡으면 닫힌다", () => {
    const m = buildComebackMoments(ctxOf(), COMEBACK, LIVE).filter((x) => x.phase === "near");
    expect(m.map((x) => x.value)).toEqual([20, 22, 24]);
    expect(m.map((x) => x.until)).toEqual([10, 11, 20]);
    expect(m[0].text).toBe("팀H 최대 20점 열세 · 23점차가 되면 역전승 KBL 역대 공동 7위");
    expect(m[0].remaining).toBe(3);
    expect(m[2].text).toBe("팀H 최대 24점 열세 · 이기면 역전승 KBL 역대 공동 5위");
    expect(m[2]).toMatchObject({ scope: "t", subject: "H", tcode: "H", board: "tg.comeback.max", bucket: "G", provisional: true, remaining: 0 });
  });
  it("19점 열세까지는 아무것도 없다", () => {
    const small = seq([...Array.from({ length: 9 }, (_, i): [number, number] => [0, 2 * (i + 1)]), [0, 19]]);
    expect(buildComebackMoments(ctxOf(), small, LIVE)).toEqual([]);
  });
  it("보드 요약이 없으면 만들지 않는다", () => {
    expect(buildComebackMoments(null, COMEBACK, LIVE)).toEqual([]);
    expect(buildComebackMoments({ asOf: "x", boards: {} }, COMEBACK, LIVE)).toEqual([]);
  });
});

describe("확정(done) - 리드 탈환", () => {
  it("라이브: TOP10 열세를 뒤집고 리드를 잡는 이벤트에서 잠정으로", () => {
    const m = buildComebackMoments(ctxOf(), COMEBACK, LIVE).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ idx: 20, value: 24, rank: 5, tie: true, provisional: true, scope: "t", subject: "H" });
    expect(m[0].text).toBe("팀H 24점차 열세를 뒤집고 리드 · 이대로 이기면 KBL 역대 공동 5위");
  });
  it("라이브: 순위가 같으면 다시 알리지 않고, 열세가 더 깊어진 뒤 뒤집으면 좋아진 순위로 다시 알린다", () => {
    const again = seq([...awayRun, ...homeRun, [27, 28], [30, 28]]);                      // 같은 24점 열세로 한 번 더 리드 탈환
    expect(buildComebackMoments(ctxOf(), again, LIVE).filter((x) => x.phase === "done")).toHaveLength(1);
    const deeper = seq([...awayRun, ...homeRun, [27, 28], [27, 54], [57, 54]]);            // 54-27 = 27점 열세 뒤 역전
    const m = buildComebackMoments(ctxOf(), deeper, LIVE).filter((x) => x.phase === "done");
    expect(m.map((x) => x.value)).toEqual([24, 27]);
    expect(m[1].text).toBe("팀H 27점차 열세를 뒤집고 리드 · 이대로 이기면 KBL 역대 3위");
  });
  it("라이브: 열세가 TOP10 밖(22점)이면 확정은 없다", () => {
    const small = seq([...Array.from({ length: 11 }, (_, i): [number, number] => [0, 2 * (i + 1)]), [3, 22], [24, 22]]);
    expect(buildComebackMoments(ctxOf(), small, LIVE).filter((x) => x.phase === "done")).toEqual([]);
  });
  it("종료 경기: 이긴 팀의 마지막 리드 탈환 이벤트에서 한 번, 이 경기 행(validated)이 있을 때만, 잠정 아님", () => {
    const m = buildComebackMoments(ctxOf([`${KEY}|H|`]), COMEBACK, FINAL).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ idx: 20, value: 24, provisional: false });
    expect(m[0].text).toBe("팀H 24점차 열세를 뒤집은 역전승 KBL 역대 공동 5위");
    expect(m[0].detail).toBe("팀A 24점 리드를 날림 · 역대 1위 29점: 보유0");
    expect(buildComebackMoments(ctxOf([]), COMEBACK, FINAL).filter((x) => x.phase === "done")).toEqual([]);
  });
  it("종료 경기: 뒤지던 팀이 끝내 졌으면 확정은 없다(임박만 남는다)", () => {
    const lost = seq([...awayRun, [3, 24], [6, 24]]);
    const m = buildComebackMoments(ctxOf([`${KEY}|H|`, `${KEY}|A|`]), lost, FINAL);
    expect(m.filter((x) => x.phase === "done")).toEqual([]);
    expect(m.filter((x) => x.phase === "near").length).toBeGreaterThan(0);
  });
  it("종료 경기: 열세가 TOP10 밖이면 행이 있어도 알리지 않는다", () => {
    const small = seq([...Array.from({ length: 11 }, (_, i): [number, number] => [0, 2 * (i + 1)]), [3, 22], [24, 22]]);
    expect(buildComebackMoments(ctxOf([`${KEY}|H|`]), small, FINAL).filter((x) => x.phase === "done")).toEqual([]);
  });
});

describe("점수 처리와 대조(finals)", () => {
  it("점수가 없는 이벤트와 홈/원정을 모르는 호출은 건너뛴다", () => {
    const withGap = COMEBACK.map((e, i) => (i === 5 ? { ...e, home_score: null } : e));
    expect(buildComebackMoments(ctxOf(), withGap, LIVE).filter((x) => x.phase === "done")).toHaveLength(1);
    expect(buildComebackMoments(ctxOf(), COMEBACK, { names, final: false })).toEqual([]);
  });
  it("finals: 이긴 팀의 최대 열세(15 이상)만 파이썬 행과 맞출 키로", () => {
    const finals = new Map<string, number>();
    buildComebackMoments(null, COMEBACK, FINAL, finals);
    expect(Object.fromEntries(finals)).toEqual({ "tg.comeback.max|G|H|": 24 });
    const small = new Map<string, number>();
    buildComebackMoments(null, seq([...Array.from({ length: 7 }, (_, i): [number, number] => [0, 2 * (i + 1)]), [18, 14]]), FINAL, small);   // 14점 열세 뒤 역전
    expect(small.size).toBe(0);
  });
  it("buildAllRecordMoments의 한 갈래로 합쳐진다", () => {
    const all = buildAllRecordMoments(ctxOf(), COMEBACK, LIVE);
    expect(all.some((x) => x.board === "tg.comeback.max" && x.phase === "done")).toBe(true);
  });
});
