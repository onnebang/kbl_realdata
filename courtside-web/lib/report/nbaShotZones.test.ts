import { describe, expect, it } from "vitest";
import {
  classifyNbaZone,
  computeNbaZoneStats,
  getZoneColorStyle,
  buildNbaDualCourtSvg,
  buildNbaSingleCourtSvg,
  fallbackZoneTotalsToNbaMap,
  computeZonePlayerBreakdowns,
  renderZoneInspectorHtml,
  ensureReadableColor,
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
    // 팀 워터마크 및 통일된 코트 라인 검증
    expect(dualSvg).toContain('fill="#e11932"');
    expect(dualSvg).toContain('fill="#006738"');
    expect(dualSvg).toContain('<rect x="30" y="27" width="690" height="357"');
    expect(dualSvg).toContain("SK");
    expect(dualSvg).toContain("DB");

    const singleSvg = buildNbaSingleCourtSvg(hStats, homeTeam);
    expect(singleSvg).toContain('data-zone="rim"');
    expect(singleSvg).toContain('<path d="M 375,27 L 720,27 L 720,384 L 375,384 Z"');
  });

  it("하단 윙과 미드레인지 사이 빈틈(Gap) 없이 공식 3점 라인 호와 일치한다", () => {
    // RIGHT_HALF_PATHS에서 three_wing_bottom과 mid_bottom의 아크 sweep 방향(0) 일치 검증
    const rightWingBot = RIGHT_HALF_PATHS.find((p) => p.key === "three_wing_bottom")!;
    const rightMidBot = RIGHT_HALF_PATHS.find((p) => p.key === "mid_bottom")!;
    expect(rightWingBot.d).toContain("A 163.4 163.4 0 0 0 634.6,362.2");
    expect(rightMidBot.d).toContain("A 163.4 163.4 0 0 0 634.6,362.2");

    // LEFT_HALF_PATHS에서도 sweep 방향(1) 일치 검증
    const leftWingBot = LEFT_HALF_PATHS.find((p) => p.key === "three_wing_bottom")!;
    const leftMidBot = LEFT_HALF_PATHS.find((p) => p.key === "mid_bottom")!;
    expect(leftWingBot.d).toContain("A 163.4 163.4 0 0 1 115.4,362.2");
    expect(leftMidBot.d).toContain("A 163.4 163.4 0 0 1 115.4,362.2");
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

  it("선수별 슈팅 브레이크다운(득점 주도 및 실패 많은 선수)을 정확히 계산한다", () => {
    const shots: ShotRow[] = [
      // 선수 1: 림 3시도 3성공
      { x: 680, y: 205, d: "1", made: true, tcode: "SONO", pcode: "P1" },
      { x: 680, y: 205, d: "1", made: true, tcode: "SONO", pcode: "P1" },
      { x: 680, y: 205, d: "1", made: true, tcode: "SONO", pcode: "P1" },
      // 선수 2: 림 2시도 0성공
      { x: 680, y: 205, d: "1", made: false, tcode: "SONO", pcode: "P2" },
      { x: 680, y: 205, d: "1", made: false, tcode: "SONO", pcode: "P2" },
    ];
    const playerNames = { P1: "이정현", P2: "전성현" };
    const breakdowns = computeZonePlayerBreakdowns(shots, "SONO", "고양 소노", "#002b49", playerNames);

    const rim = breakdowns.rim;
    expect(rim.totalMade).toBe(3);
    expect(rim.totalAtt).toBe(5);
    expect(rim.totalPct).toBe(60);

    // 선수 리스트 정렬 (시도 많은 순)
    expect(rim.players[0].name).toBe("이정현");
    expect(rim.players[0].made).toBe(3);
    expect(rim.players[1].name).toBe("전성현");
    expect(rim.players[1].missed).toBe(2);

    // 득점 주도 & 실패 난조
    expect(rim.topMakers[0].name).toBe("이정현");
    expect(rim.topMissers[0].name).toBe("전성현");

    // SVG 렌더링 시 data 속성과 <title> 툴팁 포함 검증
    const homeTeam = { tcode: "SONO", name: "고양 소노", abbr: "소노", color: "#002b49" };
    const awayTeam = { tcode: "KT", name: "수원 KT", abbr: "KT", color: "#000000" };
    const stats = computeNbaZoneStats(shots, "SONO");
    const dualSvg = buildNbaDualCourtSvg(stats, stats, homeTeam, awayTeam, breakdowns, breakdowns);

    expect(dualSvg).toContain('data-makers=');
    expect(dualSvg).toContain("이정현");
    expect(dualSvg).toContain('data-missers=');
    expect(dualSvg).toContain("전성현");
    expect(dualSvg).toContain("<title>");
  });

  it("인스펙터 패널 HTML이 정상적으로 생성된다", () => {
    const html = renderZoneInspectorHtml("test123");
    expect(html).toContain('id="nba-insp-test123"');
    expect(html).toContain('document.getElementById("nba-card-test123")');
    expect(html).toContain("선수별 슈팅 구성률");
    expect(html).toContain("nba-zone-path");
  });

  it("어두운 팀 색상(KT #000000 등)은 다크 배경에서 읽히는 밝은 색상으로 안전하게 보정된다", () => {
    // 검은색 -> fallback 반환
    expect(ensureReadableColor("#000000", "#ffffff")).toBe("#ffffff");
    expect(ensureReadableColor("#000", "#ffffff")).toBe("#ffffff");
    // 어두운 남색 계열 -> fallback 반환
    expect(ensureReadableColor("#091f2c", "#f1f5f9")).toBe("#f1f5f9");
    // 밝은 색상(빨강, 하늘색 등) -> 원본 유지
    expect(ensureReadableColor("#e11932")).toBe("#e11932");
    expect(ensureReadableColor("#3b82f6")).toBe("#3b82f6");
  });
});
