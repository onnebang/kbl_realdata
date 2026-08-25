// KBL 실시간 알림 백엔드 (Cloudflare Worker). 두 진입점:
//  - scheduled(): Cron으로 깨어나서 진행 중인 경기를 폴링, 이벤트 감지, 구독자에게 푸시.
//  - fetch(): 앱이 (expoPushToken, tcode, swingThreshold)를 등록하는 REST 엔드포인트.
//
// !!! 미검증 구간 표시(TODO-LIVE) !!! - tools/fetch_kbl_data.py는 지금까지 전부 isEnded===1
// (종료된) 경기만 받아봤음. "진행 중" 경기에서 이 엔드포인트들이 정확히 어떤 값을 주는지
// (isEnded가 0인지, text-cast가 마지막 쿼터까지만 오는지 등) 비시즌이라 아직 실제로 확인 못함
// - 시즌 시작 후 반드시 실제 라이브 경기로 재검증 필요(plan 파일 참고).

import { detectEvents, formatAlertText, SWING_THRESHOLD_DEFAULT, type GameSnapshot } from './alerts';
import { objectiveWinProb } from './lookup';

export interface Env {
  ALERTS_KV: KVNamespace;
}

const API_BASE = 'https://api.kbl.or.kr';
const API_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Channel: 'WEB',
  TeamCode: 'XX',
  lang: 'ko',
  Referer: 'https://www.kbl.or.kr/',
} as const; // tools/fetch_kbl_data.py의 HEADERS와 동일 - 이 3개면 인증 없이 호출 가능함을 이미 확인함

const SCORE_CODES: Record<string, number> = { '201': 2, '205': 3, '203': 1, '207': 2 };
const QUARTER_LEN_SEC: Record<string, number> = { Q1: 600, Q2: 600, Q3: 600, Q4: 600, X1: 300, X2: 300, X3: 300, X4: 300 };
const QUARTER_ORDER = ['Q1', 'Q2', 'Q3', 'Q4', 'X1', 'X2', 'X3', 'X4'];

// courtside_template.html의 cumulativeElapsedJs와 동일한 정의 - "지금까지 흐른 시간"
function cumulativeElapsed(q: string, m: number, s: number): number {
  const idx = QUARTER_ORDER.indexOf(q);
  let prior = 0;
  for (let i = 0; i < (idx === -1 ? QUARTER_ORDER.length : idx); i++) prior += QUARTER_LEN_SEC[QUARTER_ORDER[i]];
  return prior + ((QUARTER_LEN_SEC[q] ?? 300) - (m * 60 + s));
}

interface TextCastEvent {
  a: string; // action code
  t?: string; // team tcode
  p?: string; // player name
  q: string; m: number; s: number;
}

interface GameMeta {
  game: { tcodeH: string; tcodeA: string; tnameH: string; tnameA: string; gmkey: string };
}

async function kblGet<T>(path: string): Promise<T> {
  const resp = await fetch(API_BASE + path, { headers: API_HEADERS });
  if (!resp.ok) throw new Error(`KBL API ${path} -> ${resp.status}`);
  return resp.json();
}

// TODO-LIVE: isEnded===0을 "진행 중"으로 가정 - 실제 라이브 값 확인되면 이 조건 검증/수정.
async function fetchLiveGmkeys(): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const list = await kblGet<Array<{ gmkey: string; isEnded: number }>>(
    `/match/list?fromDate=${today}&toDate=${today}&tcodeList=all`,
  );
  return list.filter((g) => g.isEnded === 0).map((g) => g.gmkey);
}

async function computeSnapshot(gmkey: string): Promise<{ snap: GameSnapshot; meta: GameMeta } | null> {
  const meta = await kblGet<GameMeta>(`/match/${gmkey}`);
  const events = await kblGet<TextCastEvent[]>(
    `/match/${gmkey}/text-cast?quarterList=Q1,Q2,Q3,Q4,X1,X2,X3,X4`,
  );
  if (!events.length) return null;

  let homeScore = 0, awayScore = 0;
  const { tcodeH, tcodeA } = meta.game;
  for (const evt of events) {
    const pts = SCORE_CODES[evt.a];
    if (pts && evt.t === tcodeH) homeScore += pts;
    else if (pts && evt.t === tcodeA) awayScore += pts;
  }
  const last = events[events.length - 1];
  const elapsed = cumulativeElapsed(last.q, last.m, last.s);
  // 정규 4쿼터=2400초 기준 남은 시간 + 진행 중인 연장은 300초씩 얹음(lookup.ts 주석의
  // "사전적 정의" - export_live_winprob_lookup.py가 만든 격자와 같은 정의라야 정확함).
  const regulationTotal = 2400 + Math.max(0, QUARTER_ORDER.indexOf(last.q) - 3) * 300;
  const remainingSec = Math.max(0, regulationTotal - elapsed);
  const homeProb = objectiveWinProb(homeScore - awayScore, remainingSec);

  return { snap: { quarter: last.q as GameSnapshot['quarter'], homeScore, awayScore, homeProb }, meta };
}

interface PushSubscription {
  expoPushToken: string;
  tcode: string;
  swingThreshold: number;
}

async function subscribersFor(env: Env, tcode: string): Promise<PushSubscription[]> {
  const raw = await env.ALERTS_KV.get(`subs:${tcode}`);
  return raw ? (JSON.parse(raw) as PushSubscription[]) : [];
}

async function sendExpoPush(tokens: string[], title: string, body: string): Promise<void> {
  if (!tokens.length) return;
  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(tokens.map((to) => ({ to, title, body, sound: 'default' }))),
  });
}

async function pollOneGame(env: Env, gmkey: string): Promise<void> {
  const result = await computeSnapshot(gmkey);
  if (!result) return;
  const { snap, meta } = result;

  const prevRaw = await env.ALERTS_KV.get(`snap:${gmkey}`);
  const prev = prevRaw ? (JSON.parse(prevRaw) as GameSnapshot) : null;

  const events = detectEvents(prev, snap);
  if (events.length) {
    const { tcodeH, tcodeA, tnameH, tnameA } = meta.game;
    const homeSubs = await subscribersFor(env, tcodeH);
    const awaySubs = await subscribersFor(env, tcodeA);
    for (const ev of events) {
      const body = formatAlertText(ev, tnameH, tnameA);
      const threshold = ev.type === 'prob_swing' ? Math.abs((ev as any).deltaHome) : Infinity;
      const eligible = (subs: PushSubscription[]) =>
        subs.filter((s) => ev.type !== 'prob_swing' || threshold >= s.swingThreshold).map((s) => s.expoPushToken);
      await sendExpoPush([...eligible(homeSubs), ...eligible(awaySubs)], `${tnameH} vs ${tnameA}`, body);
    }
  }

  await env.ALERTS_KV.put(`snap:${gmkey}`, JSON.stringify(snap), { expirationTtl: 60 * 60 * 6 });
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const gmkeys = await fetchLiveGmkeys();
    await Promise.all(gmkeys.map((gmkey) => pollOneGame(env, gmkey).catch((e) => console.error(gmkey, e))));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/register' && request.method === 'POST') {
      const body = (await request.json()) as Partial<PushSubscription>;
      if (!body.expoPushToken || !body.tcode) {
        return new Response('expoPushToken, tcode required', { status: 400 });
      }
      const sub: PushSubscription = {
        expoPushToken: body.expoPushToken,
        tcode: body.tcode,
        swingThreshold: body.swingThreshold ?? SWING_THRESHOLD_DEFAULT,
      };
      const key = `subs:${sub.tcode}`;
      const existing = await subscribersFor(env, sub.tcode);
      const next = [...existing.filter((s) => s.expoPushToken !== sub.expoPushToken), sub];
      await env.ALERTS_KV.put(key, JSON.stringify(next));
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },
};
