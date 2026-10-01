import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { computeFourFactors, type FourFactors, type TeamStatLine } from "@/lib/report/fourFactors";
import type { ZoneTotal } from "@/lib/report/shotHotZone";
import { ScoreSourceChart } from "./ScoreSourceChart";

// 픽스처는 사용자가 스크린샷으로 올린 경기 S49G14N10(전주 KCC(홈) 67 : 80 대구 한국가스공사)의 실측값이다.
// 계산 규칙 자체는 lib/report/scoreSourceChart.test.ts가 고정하고, 여기서는 **화면이 그 모델을 그대로
// 그리는지**(눈금·칩·접근성·다크 색 쌍·줄무늬)를 고정한다.
const KCC = { tcode: "60", name: "부산 KCC", abbr: "KCC", color: "#0C2340" };
const GAS = { tcode: "64", name: "대구 한국가스공사", abbr: "GAS", color: "#0072CE" };
const kccStats: TeamStatLine = { tcode: "60", score: 67, fgm: 15, fga: 38, tpm: 10, tpa: 29, ftm: 7, fta: 8, reb: 30, ast: 12, turnovers: 14, fouls: 17, pace: null };
const gasStats: TeamStatLine = { tcode: "64", score: 80, fgm: 22, fga: 43, tpm: 7, tpa: 27, ftm: 15, fta: 21, reb: 38, ast: 17, turnovers: 8, fouls: 15, pace: null };
const z = (key: string, hm: number, ha: number, am: number, aa: number): ZoneTotal => ({
  key,
  home: { made: hm, att: ha, pts: hm * 2 },
  away: { made: am, att: aa, pts: am * 2 },
});
const zones = (over: Partial<Record<string, ZoneTotal>> = {}): ZoneTotal[] =>
  [z("rim", 4, 6, 6, 10), z("close", 9, 19, 11, 23), z("midShort", 1, 8, 3, 6), z("midLong", 1, 4, 2, 4)].map((x) => over[x.key] ?? x);

const ff = (zs: ZoneTotal[] | null, teams?: { home?: typeof KCC; away?: typeof GAS }): FourFactors =>
  computeFourFactors({
    home: teams?.home ?? KCC, away: teams?.away ?? GAS, homeStats: kccStats, awayStats: gasStats,
    homeOreb: 9, homeDreb: 24, awayOreb: 11, awayDreb: 28, homeScore: 67, awayScore: 80, zones: zs,
  })!;

const html = (f: FourFactors) => renderToStaticMarkup(<ScoreSourceChart ff={f} />);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe("ScoreSourceChart", () => {
  const out = html(ff(zones()));

  it("구역 6줄 + 최종 점수 행을 코트 순서로 그린다", () => {
    const labels = [...out.matchAll(/<span class="ss-label">([^<]*)/g)].map((m) => m[1]);
    expect(labels).toEqual(["림", "근거리", "중거리", "롱2", "3점", "자유투", "최종 점수"]);
  });

  it("막대 폭이 모든 줄에서 같은 눈금이다 - 3점 30점이 반 폭 전체, 림 8점은 26.67%", () => {
    expect(out).toContain("width:100%");
    expect(out).toContain(`width:${(8 / 30) * 100}%`); // 림 홈
    expect(out).toContain(`width:${(22 / 30) * 100}%`); // 근거리 원정
    expect(out).toContain(`width:${(15 / 30) * 100}%`); // 자유투 원정 - 근거리 22보다 짧다
  });

  it("눈금선 간격(--ss-step)을 내려준다 - 10점 = 눈금 30점의 33.33%", () => {
    expect(out).toContain(`--ss-step:${(10 / 30) * 100}%`);
  });

  it("우세한 쪽에만 +N 칩이 붙고 최종 점수 행에도 마진 +13이 붙는다", () => {
    expect(out).toContain('ss-chip">+9<'); // 3점 홈 우세
    expect(out).toContain('ss-chip">+8<'); // 자유투 원정 우세
    expect(out).toContain('ss-chip">+13<'); // 최종 점수 원정
    // 6줄 + 최종 점수 행에서 칩이 7개(6줄 모두 점수가 달라 우세 쪽이 있다).
    expect(count(out, /class="ss-chip"/g)).toBe(7);
  });

  it("막대는 보조기기에 읽히지 않는다 - 같은 정보가 글자에 이미 있다", () => {
    expect(count(out, /class="ss-track" aria-hidden="true"/g)).toBe(6);
  });

  it("팀 색은 라이트/다크 두 색을 같이 내려준다(다크에서 남색 막대가 묻히지 않게)", () => {
    expect(out).toMatch(/--tb-l:#[0-9a-fA-F]{6}/);
    expect(out).toMatch(/--tb-d:#[0-9a-fA-F]{6}/);
    // 원색 남색(#0C2340)을 막대 배경에 그대로 박지 않는다.
    expect(out).not.toMatch(/background:#0C2340/i);
  });

  it("색이 다른 팀이면 줄무늬가 없다", () => {
    expect(out).not.toContain("ss-fill-striped");
  });

  it("정상 경기의 설명은 한 단락(눈금 설명)뿐이다 - 구역이 맞으면 조용하다", () => {
    expect(count(out, /class="report-caveat"/g)).toBe(1);
    expect(out).toContain("모든 줄이 같은 눈금");
    expect(out).toContain("점선 한 칸 = 10점");
  });
});

describe("ScoreSourceChart - 상태별", () => {
  it("두 팀 색이 비슷하면 원정 막대에만 줄무늬를 얹는다", () => {
    const sk = { tcode: "60", name: "서울 SK", abbr: "SK", color: "#E4002B" };
    const kgc = { tcode: "64", name: "안양 정관장", abbr: "KGC", color: "#C8102E" };
    const o = html(ff(zones(), { home: sk, away: kgc as unknown as typeof GAS }));
    expect(o).toContain("ss-fill ss-fill-away ss-fill-striped");
    expect(o).not.toContain("ss-fill ss-fill-home ss-fill-striped");
  });

  it("어긋남이 있으면 '구역 미확인' 줄이 빗금 클래스로 들어가고 설명이 붙는다", () => {
    const o = html(ff(zones({ close: z("close", 8, 19, 11, 23) })));
    expect(o).toContain("ss-row-unplaced");
    expect(o).toContain("구역 미확인");
    expect(o).toContain("부산 KCC의 2점 득점 중 2점은");
    expect(count(o, /class="report-caveat"/g)).toBe(2);
  });

  it("구역 합이 공식보다 많으면 줄은 만들지 않고 설명만 한다", () => {
    const o = html(ff(zones({ midLong: z("midLong", 3, 4, 2, 4) })));
    expect(o).not.toContain("ss-row-unplaced");
    expect(o).toContain("4점 많습니다");
  });

  it("3분류로 물러나면 줄이 3개이고 구역 경계 설명을 빼며 사유를 적는다", () => {
    const o = html(ff(null));
    const labels = [...o.matchAll(/<span class="ss-label">([^<]*)/g)].map((m) => m[1]);
    expect(labels).toEqual(["2점 득점", "3점 득점", "자유투 득점", "최종 점수"]);
    expect(o).not.toContain("림 1.2m");
    expect(o).not.toContain("합이 2점 득점");
    expect(o).toContain("슛 위치 자료 없이");
  });

  it("0점·동점은 태그로 말하고 0 폭 막대를 그리지 않는다", () => {
    const edgeStats = {
      home: { ...kccStats, score: 53, fgm: 7, fga: 19, tpm: 12, tpa: 30, ftm: 3, fta: 4 },
      away: { ...gasStats, score: 61, fgm: 10, fga: 21, tpm: 9, tpa: 25, ftm: 14, fta: 16 },
    };
    const f = computeFourFactors({
      home: KCC, away: GAS, homeStats: edgeStats.home, awayStats: edgeStats.away,
      homeOreb: 9, homeDreb: 24, awayOreb: 11, awayDreb: 28, homeScore: 53, awayScore: 61,
      zones: [z("rim", 0, 0, 4, 5), z("close", 6, 9, 6, 11), z("midShort", 1, 7, 0, 4), z("midLong", 0, 3, 0, 1)],
    })!;
    const o = html(f);
    expect(o).toContain("동점");
    expect(o).toContain("득점 없음");
    expect(o).not.toContain("width:0%");
    // 림 홈 0점: 홈 반에는 fill 요소가 아예 없다.
    const rimRow = o.split('<div class="ss-row">')[1];
    expect(rimRow.split("ss-half-away")[0]).not.toContain("ss-fill ");
  });

  it("NaN/undefined가 마크업에 새지 않는다", () => {
    for (const f of [ff(zones()), ff(null), ff(zones({ close: z("close", 8, 19, 11, 23) }))]) {
      expect(html(f)).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});
