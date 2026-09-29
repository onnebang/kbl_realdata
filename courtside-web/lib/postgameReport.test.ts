import { describe, expect, it } from "vitest";
import { attachDerivedFields, clockStr, isOvertimeQuarter, buildPostgameReport, type GameEvent } from "./postgameReport";

describe("isOvertimeQuarter", () => {
  it("real overtime tags seen in the data (X1-X3, 3rd-OT games S23G01N219/S37G01N5/S41G01N171)", () => {
    expect(isOvertimeQuarter("X1")).toBe(true);
    expect(isOvertimeQuarter("X2")).toBe(true);
    expect(isOvertimeQuarter("X3")).toBe(true);
    expect(isOvertimeQuarter("X4")).toBe(true);
  });
  it("EQ-family is declared in QUARTER_ORDER even though unseen in data yet - must also count", () => {
    expect(isOvertimeQuarter("EQ1")).toBe(true);
    expect(isOvertimeQuarter("EQ4")).toBe(true);
  });
  it("regulation and PRE are not overtime", () => {
    expect(isOvertimeQuarter("PRE")).toBe(false);
    expect(isOvertimeQuarter("Q1")).toBe(false);
    expect(isOvertimeQuarter("Q4")).toBe(false);
  });
  it("the bug this replaces: 'OT' prefix never matched any real tag", () => {
    expect("X3".startsWith("OT")).toBe(false);
    expect("EQ1".startsWith("OT")).toBe(false);
  });
});

describe("clockStr", () => {
  it("null clock_min/clock_sec degrades to the quarter name, never literal 'null'", () => {
    const s = clockStr({ quarter: "Q3", clock_min: null, clock_sec: null });
    expect(s).toBe("Q3");
    expect(s).not.toContain("null");
  });
  it("a normal row still renders M:SS", () => {
    expect(clockStr({ quarter: "Q3", clock_min: 5, clock_sec: 7 })).toBe("Q3 5:07");
  });
});

function ev(partial: Partial<GameEvent> & Pick<GameEvent, "event_order" | "quarter" | "home_score" | "away_score">): Omit<GameEvent, "elapsed" | "runHome" | "runAway" | "surge"> {
  return {
    clock_min: null,
    clock_sec: null,
    action_code: null,
    action_label: null,
    pcode: null,
    player_name: null,
    tcode: null,
    home_win_prob: null,
    wpa_home: null,
    objective_prob: null,
    ...partial,
  };
}

describe("buildPostgameReport with a 3rd-overtime game", () => {
  const homeTeam = { tcode: "H", name: "홈팀", abbr: "홈", color: "#111111" };
  const awayTeam = { tcode: "A", name: "원정팀", abbr: "원정", color: "#222222" };
  const box = [
    { pcode: "p1", tcode: "H", name: "홈선수", is_starter: true, pts: 20, fgm: 8, fga: 15, ftm: 2, fta: 2, reb: 5, ast: 3, stl: 1, blk: 0, fouls: 2, turnovers: 2 },
    { pcode: "p2", tcode: "A", name: "원정선수", is_starter: true, pts: 22, fgm: 9, fga: 16, ftm: 2, fta: 2, reb: 4, ast: 2, stl: 0, blk: 1, fouls: 3, turnovers: 1 },
  ];

  it("does not crash and (regression) counts OT clutch stats instead of silently dropping them", () => {
    const raw = [
      ev({ event_order: 0, quarter: "PRE", home_score: 0, away_score: 0, home_win_prob: 0.5 }),
      ev({ event_order: 1, quarter: "Q4", clock_min: 0, clock_sec: 10, home_score: 90, away_score: 90, action_code: "201", action_label: "2점슛 성공", pcode: "p1", player_name: "홈선수", tcode: "H", wpa_home: 0.05, home_win_prob: 0.5 }),
      // X3 사흘 이상 연장(3차 연장) - 실측 S41G01N171 등과 같은 태그.
      ev({ event_order: 2, quarter: "X3", clock_min: 2, clock_sec: 30, home_score: 100, away_score: 98, action_code: "201", action_label: "2점슛 성공", pcode: "p1", player_name: "홈선수", tcode: "H", home_win_prob: 0.7 }),
      ev({ event_order: 3, quarter: "X3", clock_min: 0, clock_sec: 0, home_score: 102, away_score: 100, action_code: "205", action_label: "3점슛 성공", pcode: "p2", player_name: "원정선수", tcode: "A", home_win_prob: 0.65 }),
    ];
    const events = attachDerivedFields(raw);
    const sections = buildPostgameReport({
      events,
      box,
      homeTeam,
      awayTeam,
      homeScore: 102,
      awayScore: 100,
      rarity: null,
    });

    const clutch = sections.find((s) => s.title.includes("클러치"));
    expect(clutch).toBeTruthy();
    // 홈은 Q4 막판 2점 + X3 2점 = 4점, 원정은 X3 3점뿐 = 3점. "OT" 접두사 버그였다면
    // X3 이벤트가 전부 빠져 홈 2점/원정 0점으로 나왔을 것(회귀 증명).
    expect(clutch!.html).toContain("클러치 구간 득점 <b>4점</b>");
    expect(clutch!.html).toContain("클러치 구간 득점 <b>3점</b>");
    expect(clutch!.html).not.toContain("null");
    for (const s of sections) expect(s.html).not.toContain(">null<");
  });
});
