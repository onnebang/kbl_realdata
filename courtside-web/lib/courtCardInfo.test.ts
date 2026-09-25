import { describe, expect, it } from "vitest";
import { buildCourtCardInfo, pickRecord } from "./courtCardInfo";
import { getOvrHistoryCache } from "./ovr";
import { orderOnCourt, ovrTier, type OnCourtCardPlayer } from "./onCourtCards";

// OVR 파일은 파이프라인이 다시 만들 때마다 바뀌므로 숫자를 박지 않고 파일에서 골라 대조한다.
const all = getOvrHistoryCache();
const real = all.find((r) => !r.pcode.startsWith("tbd_") && r.season === "2026-2027")!;
const tbd = all.find((r) => r.pcode.startsWith("tbd_"));

describe("pickRecord", () => {
  it("이 경기 시즌 기록, 없으면 가장 최근 기록", () => {
    const recs = [{ season: "2024-2025" }, { season: "2026-2027" }, { season: "2025-2026" }];
    expect(pickRecord(recs, "2025-2026")?.season).toBe("2025-2026");
    expect(pickRecord(recs, "2030-2031")?.season).toBe("2026-2027");
    expect(pickRecord([], "2025-2026")).toBeNull();
  });

  it("같은 시즌 동명이인은 팀으로만 가른다 - 팀을 모르거나 못 맞추면 추측하지 않고 null", () => {
    const recs = [
      { season: "2026-2027", team: "전주 KCC" },
      { season: "2026-2027", team: "창원 LG" },
    ];
    expect(pickRecord(recs, "2026-2027", "창원 LG")?.team).toBe("창원 LG");
    expect(pickRecord(recs, "2026-2027", "서울 SK")).toBeNull();
    expect(pickRecord(recs, "2026-2027")).toBeNull();
  });
});

describe("buildCourtCardInfo (실제 OVR 파일)", () => {
  it("진짜 pcode -> 그 시즌 기록, 시즌이 없으면 최신 기록", () => {
    const players = [{ pcode: real.pcode, name: real.name, tcode: "x" }];
    expect(buildCourtCardInfo(players, "2026-2027")[real.pcode].ovr).toBe(real.OVR);
    const latest = all.filter((r) => r.pcode === real.pcode).reduce((a, b) => (b.season > a.season ? b : a));
    expect(buildCourtCardInfo(players, "1999-2000")[real.pcode].ovr).toBe(latest.OVR);
  });

  it.skipIf(!tbd)("파일에서는 tbd_ 키인 신입 선수를 경기의 진짜 pcode + 이름으로 잇는다", () => {
    const out = buildCourtCardInfo([{ pcode: "999999", name: tbd!.name, tcode: "x" }], tbd!.season);
    expect(out["999999"]?.ovr).toBe(tbd!.OVR);
  });

  it("기록이 없는 선수는 키가 없다(카드는 OVR '-'로 그린다)", () => {
    expect(buildCourtCardInfo([{ pcode: "0", name: "기록 없는 선수", tcode: "x" }], "2026-2027")).toEqual({});
  });

  it("현 시즌 전원: NaN/undefined 없이 숫자 또는 null, 스타일은 한글(영문 그대로는 안 나간다)", () => {
    const roster = all
      .filter((r) => r.season === "2026-2027")
      .map((r) => ({ pcode: r.pcode.startsWith("tbd_") ? `game_${r.pcode}` : r.pcode, name: r.name, tcode: r.team ?? "?" }));
    for (const info of Object.values(buildCourtCardInfo(roster, "2026-2027"))) {
      for (const n of [info.ovr, info.off, info.def]) expect(n === null || Number.isFinite(n)).toBe(true);
      for (const s of [info.archetype, info.archetype2]) expect(s === null || !/^[\x20-\x7e]+$/.test(s)).toBe(true);
    }
  });
});

describe("카드 표시 규칙", () => {
  it("OVR 등급 문턱 92/89/85/75 (CourtsidePlayerCard와 동일)", () => {
    expect([92, 91, 89, 88, 85, 84, 75, 74].map(ovrTier)).toEqual(["elite", "gold", "gold", "silver", "silver", "bronze", "bronze", "base"]);
  });

  it("순서: 포지션 G→F→C(모르면 맨 뒤) -> OVR 높은 순, 스탯이 바뀌어도 그대로", () => {
    const p = (name: string, position: "G" | "F" | "C" | null, ovr: number | null, pts = 0): OnCourtCardPlayer => ({
      pcode: name,
      name,
      backNum: null,
      photoUrl: null,
      info: { ovr, off: null, def: null, position, archetype: null, archetype2: null, projected: false },
      pts,
      reb: 0,
      ast: 0,
      fouls: 0,
      sec: 0,
      isTop: false,
    });
    const five = [p("센터", "C", 80), p("무포지션", null, 90), p("가드B", "G", 70), p("가드A", "G", 85), p("포워드", "F", 60)];
    const order = orderOnCourt(five).map((x) => x.name);
    expect(order).toEqual(["가드A", "가드B", "포워드", "센터", "무포지션"]);
    expect(orderOnCourt(five.map((x) => ({ ...x, pts: 30 }))).map((x) => x.name)).toEqual(order);
  });
});
