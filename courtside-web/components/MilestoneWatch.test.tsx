import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecordMoment } from "@/lib/records";
import { MilestoneWatch } from "./MilestoneWatch";

const moment = (o: Partial<RecordMoment>): RecordMoment => ({
  id: "m", idx: 5, until: Infinity, clock: "Q1 2:10", phase: "done", board: "pq.ast.max", bucket: "Q1", subject: "290001", period: "Q1", scope: "p",
  name: "허훈", tcode: "H", value: 9, rank: 1, tie: false, breaks: true, remaining: 0, text: "1쿼터 어시스트 9개 KBL 신기록(종전 8개)",
  detail: "종전 최고 8개: 문태종", provisional: true, sig: 0, ...o,
});

const render = (records: RecordMoment[], idx: number, hideNear = false) =>
  renderToStaticMarkup(
    <MilestoneWatch ctx={null} moments={[]} idx={idx} box={new Map()} teamOf={() => null} hideNear={hideNear} records={records} recordTeamOf={() => ({ abbr: "KCC", color: "#123456" })} />
  );

describe("MilestoneWatch - 역대 기록 그룹", () => {
  it("통산 기록 재료(ctx)가 없어도 역대 기록만으로 패널이 나온다 - 선수는 프로필 링크, 라이브는 '잠정'", () => {
    const out = render([moment({})], 5);
    expect(out).toContain("🏆 역대 기록");
    expect(out).toContain('href="/players/290001"');
    expect(out).toContain("1쿼터 어시스트 9개 KBL 신기록(종전 8개)");
    expect(out).toContain("잠정 · 종전 최고 8개: 문태종");
    expect(out).toContain("Q1 2:10");
    expect(out).not.toContain("🏅 달성"); // 통산 그룹은 ctx가 있을 때만
  });

  it("스크럽 위치가 달성 이전이면 아무것도 그리지 않는다, 종료 경기(잠정 아님)는 '잠정'이 없다", () => {
    expect(render([moment({})], 4)).toBe("");
    expect(render([moment({ provisional: false })], 9)).not.toContain("잠정 · "); // 패널 안내 문구의 '잠정'과 달리 줄 앞 접두사는 없다
  });

  it("팀 기록은 링크 없이 이름만", () => {
    const out = render([moment({ scope: "t", subject: "H", name: "부산 KCC", board: "tq.pts.max", text: "1쿼터 득점 42점 KBL 신기록(종전 41점)" })], 9);
    expect(out).toContain("부산 KCC");
    expect(out).not.toContain('href="/players/H"');
  });

  it("임박은 유효한 구간에서만 남은 수 배지와 함께, 끝난 경기를 끝까지 본 상태(hideNear)에선 숨긴다", () => {
    const near = moment({ id: "n", phase: "near", idx: 3, until: 6, remaining: 1, text: "1쿼터 어시스트 7개 · 1개 더하면 KBL 타이 기록(공동 1위)", detail: "역대 1위 8개: 문태종" });
    const mid = render([near], 4);
    expect(mid).toContain("1개 더하면 KBL 타이 기록");
    expect(mid).toContain(">1개<");                    // 배지: 남은 1개
    expect(render([near], 6)).toBe("");                // 구간이 끝났다(until=6)
    expect(render([near], 4, true)).toBe("");          // hideNear
  });
});
