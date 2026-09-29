import { describe, expect, it } from "vitest";
import { attachDerivedFields, clockStr, estimatePossessions, isOvertimeQuarter, buildPostgameReport, type GameEvent, type PlayerBox } from "./postgameReport";
import { shotXPTS } from "./zoneCompare";

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

describe("estimatePossessions", () => {
  // 실제 경기 S41G01N171(3차 연장, 55분)의 공식 박스스코어 숫자를 그대로 넣는다.
  // team-record.json: 55번 팀 fgtA90/fgt45/ftA28/to9/offr11/defr32, 64번 팀
  // fgtA90/fgt41/ftA29/to12/offr19/defr32, 양 팀 공식 poss = 96.0.
  const mkBox = (
    tcode: string,
    fga: number,
    fgm: number,
    fta: number,
    turnovers: number
  ): PlayerBox => ({
    pcode: `p${tcode}`,
    tcode,
    name: `t${tcode}`,
    is_starter: true,
    pts: 0,
    fgm,
    fga,
    ftm: 0,
    fta,
    reb: 0,
    ast: 0,
    stl: 0,
    blk: 0,
    fouls: 0,
    turnovers,
  });
  const rebEvents = (tcode: string, code: string, n: number) =>
    Array.from({ length: n }, () => ({ quarter: "Q1", action_code: code, tcode }));
  const events = [
    // 연장 3차까지 간 경기 - 쿼터 집합이 곧 경기 길이(정규 40분 + 연장 15분 = 55분)
    ...["PRE", "Q1", "Q2", "Q3", "Q4", "X1", "X2", "X3"].map((quarter) => ({
      quarter,
      action_code: "001",
      tcode: null as string | null,
    })),
    ...rebEvents("55", "209", 11),
    ...rebEvents("55", "210", 32),
    ...rebEvents("64", "209", 19),
    ...rebEvents("64", "210", 32),
  ];
  const box = [mkBox("55", 90, 45, 28, 9), mkBox("64", 90, 41, 29, 12)];

  it("KBL 공식 poss(96.0)를 재현한다", () => {
    const r = estimatePossessions(box, events, "55", "64");
    expect(r.raw).toBeCloseTo(96.0, 1);
  });

  it("연장 경기 길이를 읽어 40분 페이스로 환산한다 - 안 하면 96회가 그대로 '빠름'이 된다", () => {
    const r = estimatePossessions(box, events, "55", "64");
    expect(r.playedMin).toBe(55);
    expect(r.pacePer40).toBeCloseTo(69.8, 1);
    expect(r.pacePer40).toBeLessThan(75); // 리포트의 '빠름' 임계값
  });

  it("공격 리바운드를 상수 25%로 가정하지 않고 실제 209/210 이벤트를 쓴다", () => {
    const noOreb = estimatePossessions(
      box,
      events.filter((e) => e.action_code !== "209"),
      "55",
      "64"
    );
    const withOreb = estimatePossessions(box, events, "55", "64");
    // 공격 리바운드가 하나도 없으면 포제션이 늘어야 한다(리바운드로 공격이 연장되지 않으므로)
    expect(noOreb.raw).toBeGreaterThan(withOreb.raw);
  });

  it("리바운드 이벤트가 전혀 없어도 죽지 않는다(0으로 나누기 없음)", () => {
    const r = estimatePossessions(box, events.slice(0, 8), "55", "64");
    expect(Number.isFinite(r.raw)).toBe(true);
    expect(r.raw).toBeGreaterThan(0);
  });
});

describe("shotXPTS 존 테이블", () => {
  // raw/analysis/xpts_zone_table.json(15시즌 전수)의 expectedPtsPerShot과 일치해야 한다.
  // 골대(681,205)에서 거리(m) = 픽셀거리 * 0.0413.
  const atDistM = (m: number) => shotXPTS(681 - m / 0.0413, 205, "1");
  it("림/근거리는 실측 성공률(66.6%/53.8%)을 반영한다 - 예전 눈대중 값(60%/45%)이 아니라", () => {
    expect(atDistM(0.5)).toBeCloseTo(1.3327, 4);
    expect(atDistM(2.0)).toBeCloseTo(1.0758, 4);
  });
  it("중거리/롱2/3점", () => {
    expect(atDistM(4.0)).toBeCloseTo(0.7631, 4);
    expect(atDistM(6.0)).toBeCloseTo(0.7363, 4);
    expect(atDistM(7.5)).toBeCloseTo(0.9951, 4);
  });
  it("골밑이 롱2보다 확실히 비싸다(전에는 1.20 vs 0.76으로 격차가 실제보다 작았다)", () => {
    expect(atDistM(0.5) - atDistM(6.0)).toBeGreaterThan(0.55);
  });
});

describe("템포와 페이스 섹션의 렌더 결과 (연장 경기 회귀)", () => {
  // 실경기 S41G01N171(3차 연장, 55분, 118:116)의 공식 팀 합계를 그대로 넣는다.
  // 공식 poss = 96.0 → 40분 환산 69.8 → 반올림 70. 예전 코드는 원시 추정치 87을
  // 그대로 임계값 75와 비교해 이 경기를 "빠름"으로 찍었다(연장 19경기 19/19 오분류).
  const homeTeam = { tcode: "H", name: "홈팀", abbr: "홈", color: "#111111" };
  const awayTeam = { tcode: "A", name: "원정팀", abbr: "원정", color: "#222222" };
  const box: PlayerBox[] = [
    { pcode: "h1", tcode: "H", name: "홈선수", is_starter: true, pts: 118, fgm: 45, fga: 90, ftm: 19, fta: 28, reb: 43, ast: 16, stl: 5, blk: 5, fouls: 28, turnovers: 9 },
    { pcode: "a1", tcode: "A", name: "원정선수", is_starter: true, pts: 116, fgm: 41, fga: 90, ftm: 21, fta: 29, reb: 51, ast: 24, stl: 6, blk: 4, fouls: 25, turnovers: 12 },
  ];
  const QUARTERS = ["Q1", "Q2", "Q3", "Q4", "X1", "X2", "X3"];
  const raw = [
    ev({ event_order: 0, quarter: "PRE", home_score: 0, away_score: 0, home_win_prob: 0.5 }),
    ...QUARTERS.map((quarter, i) =>
      ev({ event_order: i + 1, quarter, clock_min: 0, clock_sec: 0, home_score: 10 * i, away_score: 10 * i, home_win_prob: 0.5 })
    ),
    // 공식 offr/defr: 홈 11/32, 원정 19/32.
    ...Array.from({ length: 11 }, (_, i) => ev({ event_order: 100 + i, quarter: "Q1", home_score: 0, away_score: 0, action_code: "209", tcode: "H" })),
    ...Array.from({ length: 32 }, (_, i) => ev({ event_order: 200 + i, quarter: "Q1", home_score: 0, away_score: 0, action_code: "210", tcode: "H" })),
    ...Array.from({ length: 19 }, (_, i) => ev({ event_order: 300 + i, quarter: "Q1", home_score: 0, away_score: 0, action_code: "209", tcode: "A" })),
    ...Array.from({ length: 32 }, (_, i) => ev({ event_order: 400 + i, quarter: "Q1", home_score: 0, away_score: 0, action_code: "210", tcode: "A" })),
  ];
  const sections = buildPostgameReport({
    events: attachDerivedFields(raw),
    box,
    homeTeam,
    awayTeam,
    homeScore: 118,
    awayScore: 116,
    rarity: null,
  });
  const pace = sections.find((s) => s.title.includes("템포"));

  it("40분 환산 포제션을 보여준다(공식 poss 96.0 / 55분 → 70)", () => {
    expect(pace).toBeTruthy();
    expect(pace!.html).toContain("40분당 70 포제션");
  });

  it("연장 경기임을 문구에 밝힌다", () => {
    expect(pace!.html).toContain("연장 포함 55분 → 40분 환산");
  });

  it("회귀: 연장 경기가 자동으로 '빠름'이 되지 않는다", () => {
    expect(pace!.html).toContain("보통 (Average)");
    expect(pace!.html).not.toContain("빠름");
  });
});
