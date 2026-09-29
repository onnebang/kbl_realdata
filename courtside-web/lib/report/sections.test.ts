import { describe, expect, it } from "vitest";
import { computeLineupSynergy, renderLineupSynergySection } from "./lineupSynergy";
import { computeHotZoneEdge, renderHotZoneSection } from "./shotHotZone";
import { createReportTags } from "./renderKit";
import type { LineupSegment } from "../postgameReport";
import type { ShotRow } from "../zoneCompare";

// postgameReport.ts에서 떼어낸 두 섹션의 **계산 층**을 직접 고정한다. 예전엔
// buildPostgameReport() 전체를 돌리지 않으면 이 임계값들을 확인할 방법이 없었다.

const homeTeam = { tcode: "H", name: "홈팀", abbr: "홈", color: "#111111" };
const awayTeam = { tcode: "A", name: "원정팀", abbr: "원정", color: "#222222" };
const tags = createReportTags(homeTeam, awayTeam);

describe("computeLineupSynergy", () => {
  const A = ["p1", "p2", "p3", "p4", "p5"];
  const B = ["p1", "p2", "p3", "p4", "p6"];
  const C = ["p1", "p2", "p3", "p7", "p8"];
  const X = ["a1", "a2", "a3", "a4", "a5"];
  const segs: LineupSegment[] = [
    { homeOn: A, awayOn: X, seconds: 200, homePts: 20, awayPts: 5 },
    { homeOn: B, awayOn: X, seconds: 180, homePts: 5, awayPts: 20 },
    // 60초짜리 - SYNERGY_MIN_SEC(120) 미달. 마진 +30이라 임계가 없으면 A를 밀어내고 최고가 된다.
    { homeOn: C, awayOn: X, seconds: 60, homePts: 30, awayPts: 0 },
  ];

  it("최고/최악을 득실마진으로 고르고, 짧게 가동된 조합은 버린다", () => {
    const { best, worst } = computeLineupSynergy(segs, "home");
    expect(best).toEqual({ pcodes: A, diff: 15, dur: 200 });
    expect(worst).toEqual({ pcodes: B, diff: -15, dur: 180 });
    expect(best!.pcodes).not.toContain("p7"); // 60초 조합이 아님
  });

  it("같은 5인이 여러 구간에 흩어져 있어도 합쳐서 본다(원정 라인업은 세 구간 전부 X)", () => {
    const { best, worst } = computeLineupSynergy(segs, "away");
    expect(best).toBeNull(); // 합계 25-55
    expect(worst).toEqual({ pcodes: X, diff: -30, dur: 440 });
  });

  it("|마진| < 8이면 아무것도 말하지 않는다", () => {
    const flat: LineupSegment[] = [{ homeOn: A, awayOn: X, seconds: 600, homePts: 50, awayPts: 43 }];
    expect(computeLineupSynergy(flat, "home")).toEqual({ best: null, worst: null });
  });

  it("렌더는 계산 결과가 비면 섹션을 만들지 않는다", () => {
    const empty = renderLineupSynergySection([{ team: homeTeam, synergy: { best: null, worst: null } }], {
      tags,
      nameOf: (pc) => pc,
    });
    expect(empty).toBeNull();

    const section = renderLineupSynergySection(
      [{ team: homeTeam, synergy: computeLineupSynergy(segs, "home") }],
      { tags, nameOf: (pc) => `선수${pc}` }
    );
    expect(section!.title).toBe("라인업 시너지 흥망성쇠");
    expect(section!.html).toContain("최고의 5인 조합");
    expect(section!.html).toContain("+15점");
    expect(section!.html).toContain("선수p5");
    expect(section!.html).not.toContain("undefined");
  });
});

describe("computeHotZoneEdge", () => {
  // 골대(681,205) 위 슛 = 림 구역. d="1"이면 미러링 없음(zoneCompare.mirrorShotX).
  const rim = (tcode: string, made: boolean): ShotRow => ({ x: 681, y: 205, d: "1", made, tcode });
  const oneRimEach: ShotRow[] = [rim("H", true), rim("A", true)];
  const threes = (hTpm: number, aTpm: number) => [
    { tcode: "H", tpm: hTpm, tpa: 20 },
    { tcode: "A", tpm: aTpm, tpa: 20 },
  ];

  it("3점은 좌표가 아니라 공식 기록(teamThrees)으로 집계한다", () => {
    const edge = computeHotZoneEdge({
      shots: oneRimEach,
      teamThrees: threes(10, 2),
      homeTcode: "H",
      awayTcode: "A",
      homeScore: 80,
      awayScore: 78,
    })!;
    expect(edge.top.key).toBe("three");
    expect(edge.top.home).toEqual({ att: 20, made: 10, pts: 30 });
    expect(edge.diff).toBe(24);
    expect(edge.zoneWinner).toBe("home");
    expect(edge.paradox).toBe(false);
    expect(renderHotZoneSection(edge, { homeTeam, awayTeam, tags }).html).toContain("3점 핫존 지배");
  });

  it("구역 격차가 최종 마진보다 크지 않으면 null(그냥 경기 결과일 뿐이라 말하지 않는다)", () => {
    expect(
      computeHotZoneEdge({
        shots: oneRimEach,
        teamThrees: threes(10, 2), // 격차 24점
        homeTcode: "H",
        awayTcode: "A",
        homeScore: 110,
        awayScore: 80, // 마진 30 > 24
      })
    ).toBeNull();
  });

  it("구역을 이기고도 진 경기는 역설로 잡고, 승자가 벌린 구역을 같이 든다", () => {
    const shots: ShotRow[] = [rim("H", true), rim("H", true), rim("H", true), rim("H", true), rim("A", false)];
    const edge = computeHotZoneEdge({
      shots,
      teamThrees: threes(2, 10), // 3점은 원정이 24점 우위
      homeTcode: "H",
      awayTcode: "A",
      homeScore: 80,
      awayScore: 78, // 경기는 홈이 이겼다
    })!;
    expect(edge.top.key).toBe("three");
    expect(edge.zoneWinner).toBe("away");
    expect(edge.paradox).toBe(true);
    expect(edge.madeUp.map((z) => z.key)).toEqual(["rim"]); // 홈이 림에서 +8
    const html = renderHotZoneSection(edge, { homeTeam, awayTeam, tags }).html;
    expect(html).toContain("핫존의 역설");
    expect(html).toContain("<b>림</b>(0/1 vs 4/4)"); // 패자 기록 vs 승자 기록
  });

  it("슛 로그가 없으면 null", () => {
    expect(
      computeHotZoneEdge({ shots: [], teamThrees: threes(10, 0), homeTcode: "H", awayTcode: "A", homeScore: 80, awayScore: 70 })
    ).toBeNull();
  });
});
