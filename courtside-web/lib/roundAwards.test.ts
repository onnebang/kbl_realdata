import { describe, expect, it } from "vitest";
import { buildPositionBestBoards, buildRoundMvpBoards, ROUND_QUALIFY, type PlayerDirectoryInfo } from "./roundAwards";
import type { SeasonPlayerAgg } from "./seasonLeaders";
import type { TeamInfo } from "./preseason";

function agg(pcode: string, tcode: string, over: Partial<SeasonPlayerAgg> = {}): SeasonPlayerAgg {
  return {
    pcode,
    tcode,
    gp: 5,
    minutes: 150,
    pts: 100,
    reb: 30,
    ast: 20,
    stl: 5,
    blk: 2,
    fgm: 40,
    fga: 80,
    tpm: 10,
    tpa: 20,
    ftm: 10,
    fta: 12,
    perW: 15,
    usgW: 20,
    pos: "G",
    ...over,
  };
}

const TEAMS = new Map<string, TeamInfo>([
  ["A", { tcode: "A", name: "A팀", abbr: "A", color: "#111111", logoUrl: null }],
  ["B", { tcode: "B", name: "B팀", abbr: "B", color: "#222222", logoUrl: null }],
]);

function info(entries: [string, PlayerDirectoryInfo][]) {
  return new Map(entries);
}

describe("buildRoundMvpBoards", () => {
  it("role이 없으면(null) 국내로, '외국인'이 들어있으면 용병으로, '아시아'면 아시아쿼터로 분류한다", () => {
    const boards = buildRoundMvpBoards(
      [agg("p1", "A"), agg("p2", "A"), agg("p3", "A")],
      info([
        ["p1", { role: null, name: "국내선수", photoUrl: null }],
        ["p2", { role: "외국인 1옵션", name: "용병선수", photoUrl: null }],
        ["p3", { role: "아시아쿼터", name: "아시아선수", photoUrl: null }],
      ]),
      TEAMS
    );
    expect(boards.find((b) => b.role === "domestic")!.rows.map((r) => r.pcode)).toEqual(["p1"]);
    expect(boards.find((b) => b.role === "import")!.rows.map((r) => r.pcode)).toEqual(["p2"]);
    expect(boards.find((b) => b.role === "asiaQuota")!.rows.map((r) => r.pcode)).toEqual(["p3"]);
  });

  it(`자격 미달(${ROUND_QUALIFY.gp}경기 미만 그리고 ${ROUND_QUALIFY.minutes}분 미만)은 제외한다`, () => {
    const boards = buildRoundMvpBoards(
      [agg("ok", "A", { gp: ROUND_QUALIFY.gp, minutes: 10 }), agg("short", "A", { gp: 1, minutes: 10 })],
      info([
        ["ok", { role: null, name: "출전만족", photoUrl: null }],
        ["short", { role: null, name: "미달", photoUrl: null }],
      ]),
      TEAMS
    );
    const domestic = boards.find((b) => b.role === "domestic")!;
    expect(domestic.rows.map((r) => r.pcode)).toEqual(["ok"]);
    expect(domestic.poolN).toBe(1);
  });

  it("경기 수가 모자라도 출전시간이 기준을 넘으면 통과한다(둘 중 하나만)", () => {
    const boards = buildRoundMvpBoards(
      [agg("minutesOnly", "A", { gp: 1, minutes: ROUND_QUALIFY.minutes })],
      info([["minutesOnly", { role: null, name: "장시간", photoUrl: null }]]),
      TEAMS
    );
    expect(boards.find((b) => b.role === "domestic")!.rows.map((r) => r.pcode)).toEqual(["minutesOnly"]);
  });

  it("PER 가중 평균 내림차순, 동률이면 출전시간 많은 쪽이 위", () => {
    const boards = buildRoundMvpBoards(
      [
        agg("low", "A", { perW: 10, minutes: 300 }),
        agg("high", "A", { perW: 20, minutes: 100 }),
        agg("tieA", "B", { perW: 15, minutes: 200 }),
        agg("tieB", "B", { perW: 15, minutes: 250 }),
      ],
      info([
        ["low", { role: null, name: "로우", photoUrl: null }],
        ["high", { role: null, name: "하이", photoUrl: null }],
        ["tieA", { role: null, name: "타이A", photoUrl: null }],
        ["tieB", { role: null, name: "타이B", photoUrl: null }],
      ]),
      TEAMS
    );
    const domestic = boards.find((b) => b.role === "domestic")!;
    expect(domestic.rows.map((r) => r.pcode)).toEqual(["high", "tieB", "tieA", "low"]);
  });

  it("topN만큼만 자른다", () => {
    const aggs = Array.from({ length: 10 }, (_, i) => agg(`p${i}`, "A", { perW: i }));
    const infos = info(aggs.map((a) => [a.pcode, { role: null, name: a.pcode, photoUrl: null } as PlayerDirectoryInfo]));
    const boards = buildRoundMvpBoards(aggs, infos, TEAMS, 3);
    expect(boards.find((b) => b.role === "domestic")!.rows).toHaveLength(3);
    expect(boards.find((b) => b.role === "domestic")!.poolN).toBe(10);
  });

  it("팀 정보가 없는 tcode는 team이 null이고, 사진 없는 선수는 photoUrl이 null이다", () => {
    const boards = buildRoundMvpBoards(
      [agg("noTeam", "ZZZ")],
      info([["noTeam", { role: null, name: "무소속", photoUrl: null }]]),
      TEAMS
    );
    const row = boards.find((b) => b.role === "domestic")!.rows[0];
    expect(row.team).toBeNull();
    expect(row.photoUrl).toBeNull();
  });
});

describe("buildPositionBestBoards", () => {
  it("pos로 G/F/C에 나눠 담고, 포지션 미확인(null)은 어느 보드에도 넣지 않는다", () => {
    const boards = buildPositionBestBoards(
      [agg("g1", "A", { pos: "G" }), agg("f1", "A", { pos: "F" }), agg("c1", "A", { pos: "C" }), agg("unk", "A", { pos: null })],
      info([
        ["g1", { role: null, name: "가드", photoUrl: null }],
        ["f1", { role: null, name: "포워드", photoUrl: null }],
        ["c1", { role: null, name: "센터", photoUrl: null }],
        ["unk", { role: null, name: "미확인", photoUrl: null }],
      ]),
      TEAMS
    );
    expect(boards.find((b) => b.pos === "G")!.rows.map((r) => r.pcode)).toEqual(["g1"]);
    expect(boards.find((b) => b.pos === "F")!.rows.map((r) => r.pcode)).toEqual(["f1"]);
    expect(boards.find((b) => b.pos === "C")!.rows.map((r) => r.pcode)).toEqual(["c1"]);
    expect(boards.every((b) => b.rows.every((r) => r.pcode !== "unk"))).toBe(true);
  });

  it("MVP와 같은 자격 기준을 쓴다(라운드 내 3경기 또는 50분 미달은 제외)", () => {
    const boards = buildPositionBestBoards(
      [agg("ok", "A", { pos: "G", gp: ROUND_QUALIFY.gp, minutes: 10 }), agg("short", "A", { pos: "G", gp: 1, minutes: 10 })],
      info([
        ["ok", { role: null, name: "출전만족", photoUrl: null }],
        ["short", { role: null, name: "미달", photoUrl: null }],
      ]),
      TEAMS
    );
    const g = boards.find((b) => b.pos === "G")!;
    expect(g.rows.map((r) => r.pcode)).toEqual(["ok"]);
    expect(g.poolN).toBe(1);
  });

  it("기본 topN은 3이다(1~3위)", () => {
    const aggs = Array.from({ length: 5 }, (_, i) => agg(`g${i}`, "A", { pos: "G", perW: i }));
    const infos = info(aggs.map((a) => [a.pcode, { role: null, name: a.pcode, photoUrl: null } as PlayerDirectoryInfo]));
    const boards = buildPositionBestBoards(aggs, infos, TEAMS);
    const g = boards.find((b) => b.pos === "G")!;
    expect(g.rows.map((r) => r.pcode)).toEqual(["g4", "g3", "g2"]);
    expect(g.poolN).toBe(5);
  });
});
