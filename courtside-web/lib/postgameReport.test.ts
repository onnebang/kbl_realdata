import { describe, expect, it } from "vitest";
import {
  type GameEvent,
  type PlayerBox,
  type ReportSection,
  attachDerivedFields,
  buildPostgameReport,
  clockStr,
  dramaticSwingKind,
  estimatePossessions,
  isOvertimeQuarter,
  recordBookSection,
  recordChanceList,
  recordsSection,
} from "./postgameReport";
import type { RecordContext } from "./records";
import type { MilestoneContext, MilestoneTarget } from "./milestones";
import { createReportTags } from "./report/renderKit";
import { shotXPTS } from "./zoneCompare";

/**
 * buildPostgameReport()는 문자열 HTML 섹션과 타입 있는 data 섹션을 섞어 돌려준다
 * (lib/report/renderKit.ts의 ReportSection 주석). 아래에서 보는 섹션들은 전부 html 쪽이고,
 * data 섹션의 렌더 결과는 그 컴포넌트 테스트가 따로 고정한다
 * (components/report/AceDuelSection.test.tsx).
 */
function htmlOf(s: ReportSection | undefined): string {
  if (!s) return "";
  return "html" in s ? s.html : `[data:${s.data.kind}]`;
}

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
    expect(htmlOf(clutch)).toContain("클러치 구간 득점 <b>4점</b>");
    expect(htmlOf(clutch)).toContain("클러치 구간 득점 <b>3점</b>");
    expect(htmlOf(clutch)).not.toContain("null");
    for (const s of sections) expect(htmlOf(s)).not.toContain(">null<");
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
    expect(htmlOf(pace)).toContain("40분당 70 포제션");
  });

  it("연장 경기임을 문구에 밝힌다", () => {
    expect(htmlOf(pace)).toContain("연장 포함 55분 → 40분 환산");
  });

  it("회귀: 연장 경기가 자동으로 '빠름'이 되지 않는다", () => {
    expect(htmlOf(pace)).toContain("보통 (Average)");
    expect(htmlOf(pace)).not.toContain("빠름");
  });
});

// '극적인 흐름' 마지막 절 - 두 번 틀린 자리라 세 갈래를 고정한다(dramaticSwingKind 주석 참고).
describe("dramaticSwingKind", () => {
  it("이미 앞서 있던 팀이 더 달아나면 extend - 따라붙었다고 쓰면 안 된다", () => {
    // 제보 실측: 대구 한국가스공사 54% -> 99%인데 "맹렬히 따라붙었지만 역전선까지 닿지 못함"이 나갔다.
    expect(dramaticSwingKind(54, 99)).toBe("extend");
    expect(dramaticSwingKind(50, 51)).toBe("extend");
  });

  it("50% 아래에서 50% 이상으로 넘어서면 flip", () => {
    expect(dramaticSwingKind(31, 74)).toBe("flip");
    expect(dramaticSwingKind(49, 50)).toBe("flip");
  });

  it("끝까지 50% 아래면 chase", () => {
    // 1차 버그의 경기(S49G14N4): KCC 8% -> 41%, 한 번도 50%를 넘지 못했다.
    expect(dramaticSwingKind(8, 41)).toBe("chase");
    expect(dramaticSwingKind(1, 49)).toBe("chase");
  });
});

describe("기록 달성 섹션 / 기록 도전 목록 (요청 2026-10-07)", () => {
  const home = { tcode: "H", name: "홈팀", abbr: "홈", color: "#111111" };
  const away = { tcode: "A", name: "원정팀", abbr: "원정", color: "#222222" };
  const tags = createReportTags(home, away);
  const zero = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, threep: 0 };
  const step = (cat: "pts" | "reb", at: number): MilestoneTarget => ({ kind: "step", cat, at });
  const mkEvents = (rows: { pcode: string; tcode: string; code: string; q?: string; m?: number; s?: number }[]) =>
    attachDerivedFields([
      ev({ event_order: 0, quarter: "PRE", home_score: 0, away_score: 0, home_win_prob: 0.5 }),
      ...rows.map((r, i) => ev({ event_order: i + 1, quarter: r.q ?? "Q1", clock_min: r.m ?? 8, clock_sec: r.s ?? 30, home_score: 2 * (i + 1), away_score: 0, action_code: r.code, pcode: r.pcode, player_name: r.pcode, tcode: r.tcode, home_win_prob: 0.5 })),
    ]);

  it("달성한 기록을 시각 점프 링크와 함께 쓰고, '!'는 떼고, 이름 뒤 조사를 맞춘다", () => {
    const ctx: MilestoneContext = { split: "regular", asOf: "2026-10-06", players: { p1: { name: "양홍석", tcode: "H", before: { ...zero, pts: 4598 }, targets: [step("pts", 4600)] } } };
    const events = mkEvents([{ pcode: "p1", tcode: "H", code: "201", q: "Q3", m: 3, s: 26 }]); // 2점슛 -> 4,600점
    const sec = recordsSection(ctx, events, tags)!;
    expect(sec.title).toBe("기록 달성");
    const html = htmlOf(sec);
    expect(html).toContain('<a href="#" class="report-jump-link" data-jump-idx="1">Q3 3:26</a>');
    expect(html).toContain("양홍석</b></span>이 "); // 받침 있는 이름 + 이
    expect(html).toContain("통산 득점 4,600점 달성(오늘 2점째).");
    expect(html).not.toContain("!");
    expect(html).toContain("정규리그 통산 기준"); // 기준 안내
  });

  it("달성이 없으면 null - 섹션 자체를 만들지 않는다", () => {
    const ctx: MilestoneContext = { split: "regular", asOf: "2026-10-06", players: { p1: { name: "양홍석", tcode: "H", before: { ...zero, pts: 4000 }, targets: [step("pts", 4600)] } } };
    expect(recordsSection(ctx, mkEvents([{ pcode: "p1", tcode: "H", code: "201" }]), tags)).toBeNull();
  });

  it("달성이 많으면 알릴 만한 순 10건만 시간순으로 쓰고 나머지는 개수만 말한다", () => {
    const players: MilestoneContext["players"] = {};
    const rows: { pcode: string; tcode: string; code: string }[] = [];
    for (let i = 0; i < 12; i++) {
      players[`p${i}`] = { name: `선수${i}`, tcode: "H", before: { ...zero, pts: 98 }, targets: [step("pts", 100)] };
      rows.push({ pcode: `p${i}`, tcode: "H", code: "201" });
    }
    const html = htmlOf(recordsSection({ split: "regular", asOf: "2026-10-06", players }, mkEvents(rows), tags)!);
    expect(html.match(/<li /g)).toHaveLength(10);
    expect(html).toContain("그 밖에 2건의 기록이 더 있었음");
  });

  it("buildPostgameReport - milestones를 주면 '경기 결과' 바로 다음에 들어가고, 안 주면 섹션이 없다", () => {
    const homeTeam = { ...home };
    const awayTeam = { ...away };
    const box = [{ pcode: "p1", tcode: "H", name: "홈선수", is_starter: true, pts: 2, fgm: 1, fga: 1, ftm: 0, fta: 0, reb: 0, ast: 0, stl: 0, blk: 0, fouls: 0, turnovers: 0 }];
    const events = mkEvents([{ pcode: "p1", tcode: "H", code: "201" }]);
    const base = { events, box, homeTeam, awayTeam, homeScore: 2, awayScore: 0, rarity: null };
    const ctx: MilestoneContext = { split: "regular", asOf: "2026-10-06", players: { p1: { name: "홈선수", tcode: "H", before: { ...zero, pts: 99 }, targets: [step("pts", 100)] } } };
    const titles = buildPostgameReport({ ...base, milestones: ctx }).map((s) => s.title);
    expect(titles[titles.indexOf("경기 결과") + 1]).toBe("기록 달성");
    expect(buildPostgameReport(base).map((s) => s.title)).not.toContain("기록 달성");
    expect(buildPostgameReport({ ...base, milestones: null }).map((s) => s.title)).not.toContain("기록 달성");
  });

  it("recordChanceList - 팀 칩·조사·문장·보조 설명, 이름의 HTML은 이스케이프", () => {
    const html = recordChanceList(
      [
        { id: "a", pcode: "p1", name: "양홍석", tcode: "H", cat: "pts", kind: "step", need: 9, text: "9점 이상 넣으면 통산 득점 4,600점을 달성한다", detail: "현재 통산 4,591점", sig: 0 },
        { id: "b", pcode: "p2", name: "마레이<b>", tcode: "A", cat: "blk", kind: "rank", need: 1, text: "1개만 기록하면 올타임 블록 59위에 오른다", detail: "기존 59위 오용준(121개) 추월 · 현재 통산 121개", sig: 2059 },
      ],
      home,
      away
    );
    expect(html.startsWith('<ul class="report-list">')).toBe(true);
    expect(html).toContain("양홍석</b></span>이 9점 이상 넣으면 통산 득점 4,600점을 달성한다(현재 통산 4,591점).</li>");
    expect(html).toContain("마레이&lt;b&gt;</b></span>가 1개만 기록하면"); // 받침 없는 마지막 글자 '>' 는 '가'
    expect(html).not.toContain("마레이<b>");
  });
});

describe("역대 기록 섹션 (요청 2026-10-08)", () => {
  const home = { tcode: "H", name: "홈팀", abbr: "홈", color: "#111111" };
  const away = { tcode: "A", name: "원정팀", abbr: "원정", color: "#222222" };
  const tags = createReportTags(home, away);
  const names = { player: (p: string) => (p === "p1" ? "허훈" : p), team: (t: string) => (t === "H" ? "홈팀" : "원정팀") };
  const board = (tops: number[]) => ({ tops, holders: [{ v: tops[0], who: "문태종", d: "2010-12-15" }] });
  const EIGHTS = [8, 8, 8, 8, 8, 8, 7, 7, 7, 7];
  const ctx = (validated?: string[]): RecordContext => ({
    asOf: "2026-10-07 19:00",
    boards: { "pq.ast.max|Q1": board(EIGHTS), "pq.ast.max|ALL": board(EIGHTS) },
    ...(validated ? { validated } : {}),
  });
  // PRE 행 + 1쿼터 어시스트 9개(허훈 = p1). 어시스트 k번째 이벤트의 인덱스 = k, 9번째의 남은 시간 = 1:00.
  const events = attachDerivedFields([
    ev({ event_order: 0, quarter: "PRE", home_score: 0, away_score: 0, home_win_prob: 0.5 }),
    ...Array.from({ length: 9 }, (_, i) =>
      ev({ event_order: i + 1, quarter: "Q1", clock_min: 9 - i, clock_sec: 0, home_score: 0, away_score: 0, action_code: "211", pcode: "p1", player_name: "허훈", tcode: "H", home_win_prob: 0.5 })
    ),
  ]);

  it("같은 선수·보드의 7개 -> 8개 -> 9개는 마지막(신기록) 한 줄만, 점프 링크와 팀 칩과 조사를 붙인다", () => {
    const sec = recordBookSection(ctx(["pq.ast.max|Q1|p1|Q1"]), events, tags, names)!;
    expect(sec.title).toBe("역대 기록");
    const html = htmlOf(sec);
    expect(html.match(/<li /g)).toHaveLength(1);
    expect(html).toContain('<a href="#" class="report-jump-link" data-jump-idx="9">Q1 1:00</a>');
    expect(html).toContain("허훈</b></span>이 "); // 받침 있는 이름 + 이
    expect(html).toContain("1쿼터 어시스트 9개 KBL 신기록(종전 8개)");
    expect(html).toContain("1쿼터 기준 신기록 · 종전 최고 8개: 문태종");
    expect(html).toContain("KBL 역대 TOP10 기준");
  });

  it("종료 경기에서 테이블에 없는 항목(validated 밖)은 쓰지 않고, 아무것도 없으면 null", () => {
    expect(recordBookSection(ctx([]), events, tags, names)).toBeNull();
    expect(recordBookSection(ctx(["pq.ast.max|Q2|p1|Q2"]), events, tags, names)).toBeNull();
    expect(recordBookSection({ asOf: "x", boards: {}, validated: [] }, events, tags, names)).toBeNull();
  });

  it("buildPostgameReport - records를 주면 '경기 결과'와 '기록 달성' 사이에 들어가고, 안 주면 섹션이 없다", () => {
    const box = [{ pcode: "p1", tcode: "H", name: "허훈", is_starter: true, pts: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, reb: 0, ast: 9, stl: 0, blk: 0, fouls: 0, turnovers: 0 }];
    const base = { events, box, homeTeam: home, awayTeam: away, homeScore: 2, awayScore: 0, rarity: null };
    const milestones = {
      split: "regular" as const,
      asOf: "2026-10-06",
      players: { p1: { name: "허훈", tcode: "H", before: { pts: 0, reb: 0, ast: 98, stl: 0, blk: 0, threep: 0 }, targets: [{ kind: "step" as const, cat: "ast" as const, at: 100 }] } },
    };
    const titles = buildPostgameReport({ ...base, milestones, records: ctx(["pq.ast.max|Q1|p1|Q1"]) }).map((s) => s.title);
    expect(titles.indexOf("역대 기록")).toBe(titles.indexOf("경기 결과") + 1);
    expect(titles.indexOf("기록 달성")).toBe(titles.indexOf("역대 기록") + 1);
    expect(buildPostgameReport(base).map((s) => s.title)).not.toContain("역대 기록");
    expect(buildPostgameReport({ ...base, records: null }).map((s) => s.title)).not.toContain("역대 기록");
  });
});
