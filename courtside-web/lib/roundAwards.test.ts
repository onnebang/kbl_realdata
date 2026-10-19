import { describe, expect, it } from "vitest";
import {
  buildAllStarTeams,
  buildPositionBestBoards,
  buildRoundMvpBoards,
  qualifyRoundAggs,
  type PlayerDirectoryInfo,
} from "./roundAwards";
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

describe("qualifyRoundAggs", () => {
  // 라운드 중간: A팀은 6경기, B팀은 2경기를 치른 상태. 기준은 시즌 리더보드의 시즌 초반 기준과 같다
  // (소속팀 경기의 절반 이상·최소 2경기 출전 AND 누적 팀 경기당 8분 이상).
  const TEAM_GAMES = new Map([
    ["A", 6],
    ["B", 2],
  ]);
  const keep = (aggs: SeasonPlayerAgg[]) => qualifyRoundAggs(aggs, TEAM_GAMES).map((a) => a.pcode);

  it("1~2분씩 3번 뛴 벤치는 경기 수만 채워도 제외한다(예전 '3경기 또는 50분'이 통과시키던 구멍)", () => {
    expect(keep([agg("bench", "A", { gp: 3, minutes: 4.5, perW: 42.2 })])).toEqual([]);
  });

  it("소속팀 경기의 절반 이상 출전하고 팀 경기당 8분 이상이면 통과한다(A팀 6경기 → 3경기·48분)", () => {
    expect(keep([agg("ok", "A", { gp: 3, minutes: 48 })])).toEqual(["ok"]);
    expect(keep([agg("fewMin", "A", { gp: 3, minutes: 47.9 })])).toEqual([]);
    expect(keep([agg("fewGp", "A", { gp: 2, minutes: 90 })])).toEqual([]);
  });

  it("라운드 초반(소속팀 2경기)엔 기준도 낮다 - 2경기·16분", () => {
    expect(keep([agg("early", "B", { gp: 2, minutes: 16 })])).toEqual(["early"]);
    expect(keep([agg("oneGame", "B", { gp: 1, minutes: 38 })])).toEqual([]);
  });

  it("팀 경기 수를 모르는 tcode는 가장 많이 치른 팀 기준으로 본다(느슨하게 통과시키지 않는다)", () => {
    expect(keep([agg("lost", "ZZZ", { gp: 3, minutes: 20 })])).toEqual([]);
    expect(keep([agg("lostOk", "ZZZ", { gp: 3, minutes: 48 })])).toEqual(["lostOk"]);
  });
});

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

  it("회귀: 1~2분짜리 3경기로 경기 PER이 부풀려진 벤치(가중 PER 42.2)가 있어도 MVP는 실제 주전이다", () => {
    // 2026-27 1라운드 실측: 최강민 3경기 4.5분, 한 경기(0.98분)에서 3점 하나로 경기 PER 193.3.
    const qualified = qualifyRoundAggs(
      [agg("bench", "A", { gp: 3, minutes: 4.5, perW: 42.2 }), agg("starter", "A", { gp: 5, minutes: 120, perW: 14.1 })],
      new Map([["A", 6]])
    );
    const boards = buildRoundMvpBoards(
      qualified,
      info([
        ["bench", { role: null, name: "벤치", photoUrl: null }],
        ["starter", { role: null, name: "주전", photoUrl: null }],
      ]),
      TEAMS
    );
    const domestic = boards.find((b) => b.role === "domestic")!;
    expect(domestic.rows.map((r) => r.pcode)).toEqual(["starter"]);
    expect(domestic.poolN).toBe(1);
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

  it("기본 topN은 3이다(1~3위)", () => {
    const aggs = Array.from({ length: 5 }, (_, i) => agg(`g${i}`, "A", { pos: "G", perW: i }));
    const infos = info(aggs.map((a) => [a.pcode, { role: null, name: a.pcode, photoUrl: null } as PlayerDirectoryInfo]));
    const boards = buildPositionBestBoards(aggs, infos, TEAMS);
    const g = boards.find((b) => b.pos === "G")!;
    expect(g.rows.map((r) => r.pcode)).toEqual(["g4", "g3", "g2"]);
    expect(g.poolN).toBe(5);
  });
});

describe("buildAllStarTeams", () => {
  it("가드·포워드 2명 + 센터 1명씩 퍼스트/세컨드/써드팀에 PER 순으로 나눠 담는다", () => {
    const aggs = [
      ...Array.from({ length: 6 }, (_, i) => agg(`g${i}`, "A", { pos: "G", perW: 10 - i })),
      ...Array.from({ length: 6 }, (_, i) => agg(`f${i}`, "A", { pos: "F", perW: 10 - i })),
      ...Array.from({ length: 3 }, (_, i) => agg(`c${i}`, "A", { pos: "C", perW: 10 - i })),
    ];
    const infos = info(aggs.map((a) => [a.pcode, { role: null, name: a.pcode, photoUrl: null } as PlayerDirectoryInfo]));
    const teamsOut = buildAllStarTeams(aggs, infos, TEAMS);

    expect(teamsOut.map((t) => t.tier)).toEqual([1, 2, 3]);
    expect(teamsOut[0].players.map((r) => r.pcode)).toEqual(["g0", "g1", "f0", "f1", "c0"]);
    expect(teamsOut[1].players.map((r) => r.pcode)).toEqual(["g2", "g3", "f2", "f3", "c1"]);
    expect(teamsOut[2].players.map((r) => r.pcode)).toEqual(["g4", "g5", "f4", "f5", "c2"]);
  });

  it("포지션 자격자가 모자라면 그 자리는 비운다(억지로 채우지 않음)", () => {
    const aggs = [agg("g0", "A", { pos: "G", perW: 10 }), agg("c0", "A", { pos: "C", perW: 5 })];
    const infos = info(aggs.map((a) => [a.pcode, { role: null, name: a.pcode, photoUrl: null } as PlayerDirectoryInfo]));
    const teamsOut = buildAllStarTeams(aggs, infos, TEAMS);
    expect(teamsOut[0].players.map((r) => r.pcode)).toEqual(["g0", "c0"]);
    expect(teamsOut[1].players).toEqual([]);
    expect(teamsOut[2].players).toEqual([]);
  });
});
