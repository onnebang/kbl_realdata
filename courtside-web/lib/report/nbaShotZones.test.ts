import { describe, expect, it } from "vitest";
import {
  classifyNbaZone,
  computeNbaZoneStats,
  getZoneColorStyle,
  buildNbaDualCourtSvg,
  buildNbaSingleCourtSvg,
  fallbackZoneTotalsToNbaMap,
  RIGHT_HALF_PATHS,
  LEFT_HALF_PATHS,
} from "./nbaShotZones";
import type { ShotRow } from "../zoneCompare";

describe("nbaShotZones", () => {
  it("골밑 슛은 rim 구역으로 분류된다", () => {
    // 골대 오른쪽: [681, 205.5]
    expect(classifyNbaZone(680, 205, "1")).toBe("rim");
  });

  it("코너 3점과 윙/탑 3점이 정확히 분류된다", () => {
    // 상단 코너 3점 (y <= 48.8, mx >= 634.6)
    expect(classifyNbaZone(650, 35, "1")).toBe("three_corner_top");
    // 하단 코너 3점 (y >= 362.2, mx >= 634.6)
    expect(classifyNbaZone(650, 370, "1")).toBe("three_corner_bottom");
    // 정면 탑 3점 (dist >= 6.75m, midY 근처)
    expect(classifyNbaZone(450, 205, "1")).toBe("three_top");
  });

  it("페인트존과 미드레인지가 정확히 분류된다", () => {
    // 자유투 라인 근처 중앙 페인트 (플로터)
    expect(classifyNbaZone(620, 205, "1")).toBe("paint_center");
    // 페인트 바깥 미드레인지 정면
    expect(classifyNbaZone(550, 205, "1")).toBe("mid_center");
  });

  it("성공률에 따라 올바른 핫/콜드 스타일을 반환한다", () => {
    // 100% 림 -> HOT
    const hotRim = getZoneColorStyle({ made: 4, att: 4 }, "rim");
    expect(hotRim.tag).toBe("hot");
    expect(hotRim.fill).toBe("#c92a2a");

    // 0% (0/1) -> COLD
    const coldThree = getZoneColorStyle({ made: 0, att: 1 }, "three_top");
    expect(coldThree.tag).toBe("cold");
    expect(coldThree.fill).toBe("#1565c0");

    // 시도 0회 -> NONE
    const none = getZoneColorStyle({ made: 0, att: 0 }, "mid_top");
    expect(none.tag).toBe("none");
  });

  it("듀얼 코트 및 싱글 코트 SVG가 정상 생성된다", () => {
    const dummyShots: ShotRow[] = [
      { x: 680, y: 205, d: "1", made: true, tcode: "H" },
      { x: 450, y: 205, d: "1", made: false, tcode: "A" },
    ];
    const hStats = computeNbaZoneStats(dummyShots, "H");
    const aStats = computeNbaZoneStats(dummyShots, "A");

    expect(hStats.rim.made).toBe(1);
    expect(hStats.rim.att).toBe(1);
    expect(aStats.three_top.made).toBe(0);
    expect(aStats.three_top.att).toBe(1);

    const homeTeam = { tcode: "SK", name: "서울 SK", abbr: "SK", color: "#e11932" };
    const awayTeam = { tcode: "DB", name: "원주 DB", abbr: "DB", color: "#006738" };
    const dualSvg = buildNbaDualCourtSvg(hStats, aStats, homeTeam, awayTeam);
    expect(dualSvg).toContain('data-zone="rim"');
    expect(dualSvg).toContain("1-1");
    expect(dualSvg).toContain("100%");
    expect(dualSvg).toContain("0-1");
    expect(dualSvg).toContain("0%");
    // 팀 워터마크 및 외곽 테두리선 검증
    expect(dualSvg).toContain('fill="#e11932"');
    expect(dualSvg).toContain('fill="#006738"');
    expect(dualSvg).toContain('stroke="#e11932"');
    expect(dualSvg).toContain('stroke="#006738"');
    expect(dualSvg).toContain("SK");
    expect(dualSvg).toContain("DB");

    const singleSvg = buildNbaSingleCourtSvg(hStats, homeTeam);
    expect(singleSvg).toContain('data-zone="rim"');
    expect(singleSvg).toContain('stroke="#e11932"');
  });

  it("하단 윙과 미드레인지 사이 빈틈(Gap) 없이 아크가 일치한다", () => {
    // RIGHT_HALF_PATHS에서 three_wing_bottom과 mid_bottom의 아크 sweep 방향 일치 검증
    const rightWingBot = RIGHT_HALF_PATHS.find((p) => p.key === "three_wing_bottom")!;
    const rightMidBot = RIGHT_HALF_PATHS.find((p) => p.key === "mid_bottom")!;
    expect(rightWingBot.d).toContain("A 163.4 163.4 0 0 1 634.6,362.2");
    expect(rightMidBot.d).toContain("A 163.4 163.4 0 0 1 634.6,362.2");

    // LEFT_HALF_PATHS에서도 일치 검증
    const leftWingBot = LEFT_HALF_PATHS.find((p) => p.key === "three_wing_bottom")!;
    const leftMidBot = LEFT_HALF_PATHS.find((p) => p.key === "mid_bottom")!;
    expect(leftWingBot.d).toContain("A 163.4 163.4 0 0 0 115.4,362.2");
    expect(leftMidBot.d).toContain("A 163.4 163.4 0 0 0 115.4,362.2");
  });

  it("5구역 폴백 매핑이 안전하게 동작한다", () => {
    const fallback = fallbackZoneTotalsToNbaMap([
      { key: "rim", made: 5, att: 6 },
      { key: "close", made: 6, att: 9 },
      { key: "midShort", made: 3, att: 6 },
      { key: "midLong", made: 1, att: 4 },
      { key: "three", made: 10, att: 25 },
    ]);
    expect(fallback.rim.att).toBe(6);
    expect(fallback.paint_center.att).toBeGreaterThan(0);
    expect(fallback.three_top.att).toBeGreaterThan(0);
  });
});
