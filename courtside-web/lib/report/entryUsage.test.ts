import { describe, expect, it } from "vitest";
import { computeEntryUsage, ENTRY_BARELY_PLAYED_SEC, ENTRY_TOP_N, type EntryPlayer } from "./entryUsage";

// 픽스처는 실측 경기다 - S49G14N10(2026-09-27, 홈 전주 KCC 67 : 원정 대구 한국가스공사 80).
// 엔트리 기준 예측은 KCC 65%였고, OVR 상위 6인 중 셋이 사실상 뛰지 않았다.
const home = { tcode: "60", name: "전주 KCC", abbr: "KCC", color: "#111111" };
const away = { tcode: "64", name: "대구 한국가스공사", abbr: "GAS", color: "#222222" };

const mk = (name: string, ovr: number | null, minutes: number, isStarter = false, over: Partial<EntryPlayer> = {}): EntryPlayer => ({
  pcode: name,
  name,
  isStarter,
  onSec: Math.round(minutes * 60),
  ovr,
  neverEntered: minutes === 0,
  leftForGoodAt: null,
  ...over,
});

// 실제 OVR·출전시간(min_played) 그대로.
const kcc: EntryPlayer[] = [
  mk("숀 롱", 86, 30.4, true),
  mk("허웅", 83, 0),
  mk("루이스 킹", 83, 29.6),
  mk("윤기찬", 82, 4.57, true, { neverEntered: false, leftForGoodAt: "Q2 10:00" }),
  mk("장재석", 81, 0),
  mk("김동현", 79, 28.87, true),
  mk("최진광", 74, 16.1, true),
  mk("이호현", 67, 23.9),
  mk("김훈", 66, 30.4, true),
  mk("이주영", 60, 15.95),
  mk("서정현", 55, 9.6),
  mk("이찬영", 54, 10.62),
];
// 가스공사는 엔트리를 정상적으로 썼다 - 0분은 OVR 하위인 손준 한 명뿐.
const gas: EntryPlayer[] = [
  mk("케베 알루마", 88, 35.03, true),
  mk("라건아", 84, 24.97),
  mk("샘조세프 벨란겔", 82, 26.8, true),
  mk("김민규", 75, 34.8, true),
  mk("정성우", 72, 12.4),
  mk("박준영", 70, 23.42, true),
  mk("전현우", 66, 16.77, true),
  mk("양우혁", 62, 14.9),
  mk("최승욱", 60, 2.5),
  mk("박준은", 58, 4.57),
  mk("양준우", 55, 3.85),
  mk("손준", 50, 0),
];

const build = () =>
  computeEntryUsage({
    home,
    away,
    lineupProb: 0.6543,
    loserTcode: "60",
    sides: [
      { team: home, players: kcc, absentBeforeEntry: ["허훈"] },
      { team: away, players: gas, absentBeforeEntry: ["A", "B"] },
    ],
  });

describe("computeEntryUsage", () => {
  it("OVR 상위 6인 중 사실상 안 뛴 선수만 잡는다 - KCC는 허웅·윤기찬·장재석", () => {
    const u = build()!;
    const kccSide = u.sides.find((s) => s.team.tcode === "60")!;
    expect(kccSide.unusedTop.map((p) => p.name)).toEqual(["허웅", "윤기찬", "장재석"]);
    // 셋 합계 4분 34초(=274초). 사용자가 확인한 값과 같아야 한다.
    expect(kccSide.unusedTopSec).toBe(274);
  });

  it("엔트리를 정상적으로 쓴 팀은 섹션에서 빠진다 - 가스공사의 0분은 OVR 하위 한 명뿐", () => {
    const u = build()!;
    expect(u.sides.map((s) => s.team.tcode)).toEqual(["60"]);
  });

  it("선발 시간 비중을 팀 전체 출전 시간 대비로 센다", () => {
    const kccSide = build()!.sides[0];
    // 선발 5인: 숀 롱 30.4 + 윤기찬 4.57 + 김동현 28.87 + 최진광 16.1 + 김훈 30.4 = 110.34분
    // 전체 200.01분 -> 55.2%
    expect(kccSide.starterShare).toBeCloseTo(110.34 / 200.01, 3);
  });

  it("0분 출전 인원 수로 판정하지 않는다(정규시즌 평균 1.51명이라 거의 매 경기 걸린다)", () => {
    // OVR 하위만 0분인 팀은 0분이 셋이어도 걸리지 않는다.
    const benchOnly = kcc.map((p) => (p.ovr != null && p.ovr < 62 ? { ...p, onSec: 0, neverEntered: true } : p));
    const used = benchOnly.map((p) => (["허웅", "장재석"].includes(p.name) ? { ...p, onSec: 1200, neverEntered: false } : p));
    const withPlayedStarter = used.map((p) => (p.name === "윤기찬" ? { ...p, onSec: 1500, leftForGoodAt: null } : p));
    const u = computeEntryUsage({
      home, away, lineupProb: 0.5, loserTcode: "60",
      sides: [{ team: home, players: withPlayedStarter, absentBeforeEntry: [] }],
    });
    expect(u).toBeNull();
  });

  it("경계값 - 정확히 기준 시간을 뛴 선수는 '안 뛰었다'가 아니다", () => {
    const edge = kcc.map((p) => (p.name === "허웅" ? { ...p, onSec: ENTRY_BARELY_PLAYED_SEC, neverEntered: false } : p));
    const side = computeEntryUsage({
      home, away, lineupProb: 0.5, loserTcode: "60",
      sides: [{ team: home, players: edge, absentBeforeEntry: [] }],
    })!.sides[0];
    expect(side.unusedTop.map((p) => p.name)).toEqual(["윤기찬", "장재석"]);
  });

  it("OVR이 없는 선수는 상위 판정에서 뒤로 밀린다(신인·신규 영입)", () => {
    const noOvr = kcc.map((p) => (p.name === "허웅" ? { ...p, ovr: null } : p));
    const side = computeEntryUsage({
      home, away, lineupProb: 0.5, loserTcode: "60",
      sides: [{ team: home, players: noOvr, absentBeforeEntry: [] }],
    })!.sides[0];
    expect(side.unusedTop.map((p) => p.name)).toEqual(["윤기찬", "장재석"]);
  });

  it("엔트리가 상위 N명보다 적어도 터지지 않는다", () => {
    // 허웅(0분) + 윤기찬(선발 4분 34초) 둘이라 게이트를 통과한다.
    const tiny = kcc.slice(0, 4);
    expect(tiny.length).toBeLessThan(ENTRY_TOP_N);
    const u = computeEntryUsage({
      home, away, lineupProb: null, loserTcode: "60",
      sides: [{ team: home, players: tiny, absentBeforeEntry: [] }],
    })!;
    expect(u.sides[0].unusedTop.map((p) => p.name)).toEqual(["허웅", "윤기찬"]);
    expect(u.lineupProb).toBeNull();
  });

  // 실측 반례 S49G14N4(2026-09-25 KCC 82 : 88 LG): 상위 6인 중 0분은 장재석 한 명뿐이고
  // 선발 시간 비중은 66%로 정상이었다. 그걸로 "예측이 깨진 이유"라고 쓰면 과장이다.
  it("상위 6인 중 비선발 한 명만 안 뛰었으면 섹션을 만들지 않는다", () => {
    const onlyOne = kcc.map((p) => (p.name === "허웅" ? { ...p, onSec: 1800, neverEntered: false } : p))
      .map((p) => (p.name === "윤기찬" ? { ...p, onSec: 1900, leftForGoodAt: null } : p));
    expect(
      computeEntryUsage({
        home, away, lineupProb: 0.5, loserTcode: "60",
        sides: [{ team: home, players: onlyOne, absentBeforeEntry: [] }],
      })
    ).toBeNull();
  });

  it("선발 한 명만 사실상 안 뛰어도 말할 거리다(정규시즌 11.7% 꼬리)", () => {
    const starterOnly = kcc
      .map((p) => (p.name === "허웅" ? { ...p, onSec: 1800, neverEntered: false } : p))
      .map((p) => (p.name === "장재석" ? { ...p, onSec: 1500, neverEntered: false } : p));
    const u = computeEntryUsage({
      home, away, lineupProb: 0.5, loserTcode: "60",
      sides: [{ team: home, players: starterOnly, absentBeforeEntry: [] }],
    })!;
    expect(u.sides[0].unusedTop.map((p) => p.name)).toEqual(["윤기찬"]);
  });
});
