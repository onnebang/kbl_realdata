import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRecordTimeline, type RecordMoment } from "./records";
import { summarizeRecordBook, type RecordEntry } from "./recordBook";

// 알림 빈도 실측 - 한 시즌 전 경기를 "그 경기 이전" 기록으로 재생해 경기당 기록 알림(done) 수의 분포를 본다(설계 §10-5).
// 입력은 tools/dump_record_fixtures.py --freq OUTDIR --prefix S47 --entries PATH 가 만든다. 환경변수가 없으면 건너뛴다.
//   RECORD_FREQ_EVENTS=<OUTDIR> RECORD_FREQ_ENTRIES=<PATH> npx vitest run lib/records.frequency.test.ts --disableConsoleIntercept
// 2025-26 정규시즌 270경기 실측(2026-10-08): 경기당 평균 0.55개, 상위 5% 2개, 최대 23개(허웅 51점·3점슛 11개+ 경기) -> TOP10 전부 토스트로 알려도 된다.

const EV_DIR = process.env.RECORD_FREQ_EVENTS;
const ENTRIES = process.env.RECORD_FREQ_ENTRIES;
const suite = EV_DIR && ENTRIES && existsSync(EV_DIR) && existsSync(ENTRIES) ? describe : describe.skip;

type Game = { gmkey: string; date: string; start: string; names: Record<string, string>; teams: Record<string, string>; events: [string | null, string | null, string, string, number | null, number | null][] };

suite("알림 빈도 실측", () => {
  it("경기당 달성 알림 수", { timeout: 300_000 }, () => {
    const entries: RecordEntry[] = (JSON.parse(readFileSync(ENTRIES!, "utf8")) as Record<string, string | number>[]).map((r) => ({
      board: r.board as string, bucket: r.bucket as string, gmkey: r.gmkey as string, subject: r.subject as string, period: r.period as string,
      value: r.value as number, date: r.game_date as string, start: r.game_start as string, name: r.subject_name as string,
    }));
    const perGame: { gmkey: string; done: RecordMoment[] }[] = [];
    for (const f of readdirSync(EV_DIR!).filter((x) => x.endsWith(".json")).sort()) {
      const g = JSON.parse(readFileSync(join(EV_DIR!, f), "utf8")) as Game;
      const ctx = summarizeRecordBook(entries, { date: g.date, start: g.start, gmkey: g.gmkey }, false);
      const events = g.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec]) => ({ pcode, tcode, action_code, quarter, clock_min, clock_sec }));
      const done = ctx ? buildRecordTimeline(ctx, events, { names: { player: (p) => g.names[p] ?? p, team: (t) => g.teams[t] ?? t }, final: true }).filter((m) => m.phase === "done") : [];
      perGame.push({ gmkey: g.gmkey, done });
    }
    const stat = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      return { n: s.length, mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2), p50: q(0.5), p90: q(0.9), p95: q(0.95), max: s[s.length - 1], atLeast1: xs.filter((x) => x >= 1).length, atLeast3: xs.filter((x) => x >= 3).length };
    };
    const byRank = { first: 0, top3: 0, top5: 0, top10: 0 };
    const byBoard = new Map<string, number>();
    for (const { done } of perGame) {
      for (const m of done) {
        if (m.breaks || m.rank === 1) byRank.first++;
        else if (m.rank <= 3) byRank.top3++;
        else if (m.rank <= 5) byRank.top5++;
        else byRank.top10++;
        byBoard.set(m.board, (byBoard.get(m.board) ?? 0) + 1);
      }
    }
    console.log("전체(TOP10) 달성 알림/경기:", JSON.stringify(stat(perGame.map((p) => p.done.length))));
    console.log("순위 5위 이내만(신기록·타이·2~5위):", JSON.stringify(stat(perGame.map((p) => p.done.filter((m) => m.breaks || m.rank <= 5).length))));
    console.log("순위별 합계:", JSON.stringify(byRank));
    console.log("보드별 상위:", JSON.stringify([...byBoard].sort((a, b) => b[1] - a[1]).slice(0, 12)));
    for (const { gmkey, done } of [...perGame].sort((a, b) => b.done.length - a.done.length).slice(0, 3)) {
      console.log("알림이 가장 많은 경기", gmkey, done.length);
      for (const m of done.slice(0, 25)) console.log("   ", m.idx, m.clock, m.board, m.bucket, m.name, "-", m.text);
    }
    expect(perGame.length).toBeGreaterThan(100);
  });
});
