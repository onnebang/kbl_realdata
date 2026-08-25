// 계정/실시간 API 없이 이벤트 감지 로직을 검증하는 드라이런. 이미 만들어둔
// raw/analysis/live_replay_demo.json의 실제 경기 하나를 처음부터 리플레이하면서:
//  1) lookup.ts로 계산한 objectiveWinProb가 그 경기에 이미 저장된 objectiveProb와 얼마나
//     가까운지(파이썬 검증과 동일한 방식, 이번엔 TS 쪽 구현을 검증)
//  2) alerts.ts의 detectEvents가 실제로 몇 건의 쿼터종료/스윙/역전 이벤트를 잡아내는지
// 를 출력한다. `npm run dryrun -- <gmkey>` (생략 시 첫 번째 경기).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectEvents, formatAlertText, type GameSnapshot } from '../src/alerts.ts';
import { objectiveWinProb } from '../src/lookup.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_PATH = join(__dirname, '..', '..', 'raw', 'analysis', 'live_replay_demo.json');

const QUARTER_LEN_SEC: Record<string, number> = { Q1: 600, Q2: 600, Q3: 600, Q4: 600, X1: 300, X2: 300, X3: 300, X4: 300 };
const QUARTER_ORDER = ['Q1', 'Q2', 'Q3', 'Q4', 'X1', 'X2', 'X3', 'X4'];

function cumulativeElapsed(q: string, m: number, s: number): number {
  const idx = QUARTER_ORDER.indexOf(q);
  let prior = 0;
  for (let i = 0; i < (idx === -1 ? QUARTER_ORDER.length : idx); i++) prior += QUARTER_LEN_SEC[QUARTER_ORDER[i]];
  return prior + ((QUARTER_LEN_SEC[q] ?? 300) - (m * 60 + s));
}

interface TimelineRow {
  q: string; m: number | null; s: number | null;
  homeScore: number; awayScore: number; objectiveProb: number;
}

const demo = JSON.parse(readFileSync(DEMO_PATH, 'utf-8'));
const gmkeyArg = process.argv[2];
const gmkey = gmkeyArg ?? Object.keys(demo.games)[0];
const game = demo.games[gmkey];
if (!game) {
  console.error(`gmkey ${gmkey} not found. available:`, Object.keys(demo.games).join(', '));
  process.exit(1);
}

console.log(`경기: ${gmkey} - ${game.homeTname} vs ${game.awayTname} (최종 ${game.finalHome}:${game.finalAway})`);

let prev: GameSnapshot | null = null;
const errs: number[] = [];
const eventLog: string[] = [];

for (const row of game.timeline as TimelineRow[]) {
  if (!QUARTER_ORDER.includes(row.q)) continue; // PRE, 연장 없는 쿼터코드 등 스킵
  const elapsed = cumulativeElapsed(row.q, row.m as number, row.s as number);
  const regulationTotal = 2400 + Math.max(0, QUARTER_ORDER.indexOf(row.q) - 3) * 300;
  const remainingSec = Math.max(0, regulationTotal - elapsed);
  const homeProb = objectiveWinProb(row.homeScore - row.awayScore, remainingSec);
  errs.push(Math.abs(homeProb - row.objectiveProb));

  const cur: GameSnapshot = { quarter: row.q as GameSnapshot['quarter'], homeScore: row.homeScore, awayScore: row.awayScore, homeProb };
  const events = detectEvents(prev, cur);
  for (const ev of events) eventLog.push(formatAlertText(ev, game.homeTname, game.awayTname));
  prev = cur;
}

const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
const max = Math.max(...errs);
console.log(`\nlookup.ts 정확도 - n=${errs.length}, 평균오차=${(mean * 100).toFixed(2)}%p, 최대오차=${(max * 100).toFixed(2)}%p`);
console.log(`\n감지된 알림 이벤트 ${eventLog.length}건:`);
for (const line of eventLog) console.log(`  - ${line}`);
