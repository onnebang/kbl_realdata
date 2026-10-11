import { describe, expect, it } from "vitest";
import { buildAllRecordMoments } from "./recordsMoments";
import type { RecordEvent } from "./records";
import { buildSeasonChances, buildSeasonMoments } from "./seasonMoments";
import { STREAK_KINDS, type StreakContext, type StreakEntry, type StreakKind } from "./streakKinds";

const names = { player: (p: string) => `선수${p}`, team: (t: string) => `팀${t}` };
const OPTS = { names, final: false, home: "H", away: "A" };
const ent = (v: number, pcode: string, who: string): StreakEntry => ({ v, pcode, who, active: false, d: "2022-04-01" });
function ctxOf(o: { boards?: Partial<Record<StreakKind, StreakEntry[]>>; state?: StreakContext["state"]; known?: string[]; final?: boolean; players?: StreakContext["players"] }): StreakContext {
  const boards = Object.fromEntries(STREAK_KINDS.map((k) => [k, o.boards?.[k] ?? []])) as Record<StreakKind, StreakEntry[]>;
  return { asOf: "2026-10-11", final: o.final ?? false, boards, state: o.state ?? {}, known: o.known ?? [], players: o.players ?? {} };
}
const ev = (pcode: string, code: string, n = 0): RecordEvent => ({ pcode, tcode: "H", action_code: code, quarter: "Q1", clock_min: 9, clock_sec: 59 - n });
const shots = (pcode: string, codes: string[]) => codes.map((c, i) => ev(pcode, c, i));

// 시즌 득점 보드: 순위 1~11 (TOP10 문턱 1,353)
const PTS = [1826, 1517, 1484, 1421, 1389, 1380, 1370, 1365, 1360, 1353, 1295].map((v, i) => ent(v, `p${i}`, `선수${i}(2020-2021)`));

describe("시즌 누적 - 이벤트로 누적이 늘 때마다 순위를 비교", () => {
  it("순위가 처음 10위 안에 드는 이벤트에서 알린다(아직 11위인 이벤트는 건너뛴다)", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350 } } }, known: ["z"] });
    const m = buildSeasonMoments(s, shots("z", ["201", "201"]), OPTS).filter((x) => x.phase === "done");     // 1352(11위) -> 1354(10위)
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ board: "pg.season_pts.max", bucket: "S", subject: "z", value: 1354, idx: 1, rank: 10, provisional: true, scope: "p", tcode: "H" });
    expect(m[0].text).toBe("시즌 득점 1,354점째 KBL 역대 시즌 10위");
    expect(m[0].detail).toBe("역대 1위 1,826점: 선수0(2020-2021)");
  });
  it("한 이벤트로 여러 점이 늘어도 직전 값과 비교한다(3점슛으로 11위 -> 10위)", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1352 } } }, known: ["z"] });
    const m = buildSeasonMoments(s, shots("z", ["205", "201"]), OPTS).filter((x) => x.phase === "done");   // 1355(10위) 이후 1357도 10위
    expect(m.map((x) => x.value)).toEqual([1355]);
  });
  it("순위가 그대로면 알리지 않고, 타이·신기록은 순위가 좋아지는 첫 돌파에서 한 번씩", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1824 } } }, known: ["z"] });
    const m = buildSeasonMoments(s, shots("z", ["201", "201", "201"]), OPTS).filter((x) => x.phase === "done");   // 1826(타이) -> 1828(신기록) -> 1830(그대로)
    expect(m.map((x) => x.value)).toEqual([1826, 1828]);
    expect(m[0].text).toBe("시즌 득점 1,826점째 KBL 역대 시즌 타이 기록(공동 1위)");
    expect(m[1].text).toBe("시즌 득점 1,828점째 KBL 역대 시즌 신기록(종전 1,826점)");
  });
  it("지표별로 따로 본다 - 3점슛 성공은 3점슛 보드로", () => {
    const TPM = [177, 171, 143, 142, 141, 140, 139, 138, 137, 133, 129].map((v, i) => ent(v, `t${i}`, `선수${i}(2021-2022)`));
    const s = ctxOf({ boards: { ss_tpm: TPM }, state: { z: { ss_tpm: { before: 130 } } }, known: ["z"] });
    const m = buildSeasonMoments(s, shots("z", ["205", "205", "205"]), OPTS).filter((x) => x.phase === "done" && x.board === "pg.season_tpm.max");   // 131(11위) 132(11위) 133(공동 10위)
    expect(m.map((x) => [x.value, x.text])).toEqual([[133, "시즌 3점슛 133개째 KBL 역대 시즌 공동 10위"]]);
  });
  it("본인의 진행 중 행은 비교에서 뺀다", () => {
    const own = [{ ...ent(1400, "z", "제트(2026-2027)"), active: true }, ...PTS];
    const s = ctxOf({ boards: { ss_pts: own }, state: { z: { ss_pts: { before: 1350 } } }, known: ["z"] });
    const m = buildSeasonMoments(s, shots("z", ["201", "201"]), OPTS).filter((x) => x.phase === "done");
    expect(m.map((x) => x.value)).toEqual([1354]);
  });
  it("상태를 믿을 수 없는 선수(known 밖)나 이벤트에 없는 선수는 만들지 않는다", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350 } } }, known: [] });
    expect(buildSeasonMoments(s, shots("z", ["201", "201"]), OPTS)).toEqual([]);
  });
});

describe("종료 경기 - 공식 로그 행이 기준", () => {
  const events = shots("z", ["201", "201"]);                                                  // 이벤트 합계 4점
  it("로그 행이 있고 이벤트 합계가 공식 증가분과 같으면 이벤트 위치에서, 잠정 아님", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350, after: 1354 } } }, known: ["z"], final: true });
    const m = buildSeasonMoments(s, events, { ...OPTS, final: true }).filter((x) => x.phase === "done");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ idx: 1, value: 1354, provisional: false });
  });
  it("이벤트가 공식과 다르면 그 선수의 마지막 이벤트에서 공식 값으로 한 번", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350, after: 1354 } } }, known: ["z"], final: true });
    const m = buildSeasonMoments(s, events.slice(0, 1), { ...OPTS, final: true }).filter((x) => x.phase === "done");           // 이벤트 2점 vs 공식 4점
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ idx: 0, value: 1354 });
  });
  it("로그 행이 없으면(공식에서 값이 늘지 않음) 알리지 않는다", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: {}, known: ["z"], final: true });
    expect(buildSeasonMoments(s, events, { ...OPTS, final: true })).toEqual([]);
  });
});

describe("finals(대조용)", () => {
  it("이 경기에서 늘어난 지표는 before + 이 경기 합계, 늘지 않은 지표와 출전 경기 수는 채우지 않는다", () => {
    const finals = new Map<string, number>();
    const s = ctxOf({ boards: {}, state: { z: { ss_pts: { before: 1350 }, ss_ast: { before: 200 } } }, known: ["z"] });
    buildSeasonMoments(s, shots("z", ["201", "201", "211"]), OPTS, finals);
    expect(Object.fromEntries(finals)).toEqual({ "ss_pts|z": 1354, "ss_ast|z": 201 });
  });
});

describe("경기 전 기록 도전", () => {
  it("한 경기 안에 닿는 거리 - 순위가 좋아지는 가장 작은 증가분", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350 }, ss_gp: { before: 30 } } }, known: ["z"], players: { z: { name: "제트", tcode: "H" } } });
    const c = buildSeasonChances(s);
    expect(c.map((x) => x.text)).toEqual(["오늘 3점 더하면 시즌 득점 1,353점 KBL 역대 시즌 공동 10위"]);
    expect(c[0]).toMatchObject({ name: "제트", tcode: "H" });
  });
  it("페이스 - 10경기 이상 뛴 선수의 54경기 환산이 5위 안이면(거리 줄이 우선)", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { w: { ss_pts: { before: 1100 }, ss_gp: { before: 40 } }, y: { ss_pts: { before: 1100 }, ss_gp: { before: 9 } } }, known: ["w", "y"],
      players: { w: { name: "더블유", tcode: "H" }, y: { name: "와이", tcode: "A" } } });
    const c = buildSeasonChances(s);
    expect(c.map((x) => x.text)).toEqual(["시즌 득점 1,100점(40경기) · 이 페이스면 54경기 1,485점 — KBL 역대 시즌 3위"]);       // y는 9경기라 페이스 줄이 없다
  });
  it("상한 4와 known 밖 제외", () => {
    const state: StreakContext["state"] = {};
    const players: StreakContext["players"] = {};
    const known: string[] = [];
    for (let i = 0; i < 6; i++) {
      state[`q${i}`] = { ss_pts: { before: 1350 }, ss_gp: { before: 30 } };
      players[`q${i}`] = { name: `큐${i}`, tcode: "H" };
      if (i < 5) known.push(`q${i}`);
    }
    const c = buildSeasonChances(ctxOf({ boards: { ss_pts: PTS }, state, known, players }));
    expect(c).toHaveLength(4);
  });
});

describe("buildAllRecordMoments", () => {
  it("시즌 누적 순간도 합쳐져 시간순이다", () => {
    const s = ctxOf({ boards: { ss_pts: PTS }, state: { z: { ss_pts: { before: 1350 } } }, known: ["z"] });
    expect(buildAllRecordMoments({ asOf: "x", boards: {} }, shots("z", ["201", "201"]), OPTS, s).map((x) => x.board)).toContain("pg.season_pts.max");
  });
});
