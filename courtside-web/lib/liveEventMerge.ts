// 라이브 이벤트 병합 - **Supabase를 import하지 않는다.**
//
// 이 파일이 따로 있는 이유: components/GameReplay.tsx가 mergeEventRows(순수 함수)와
// LiveEventRow 타입만 쓰는데, 예전에는 lib/useLiveGame.ts에서 가져왔다. 그 파일은 실시간
// 구독 때문에 Supabase 클라이언트를 만들어서, 종료된 경기 페이지에서도 브라우저 번들에
// @supabase/supabase-js와 **공개 키가 실려 나갔다.** 조회의 대부분은 종료 경기다.
//
// 규칙: 여기에는 네트워크를 넣지 마라. 순수 함수와 타입만.

export type LiveEventRow = {
  event_order: number;
  quarter: string;
  clock_min: number | null;
  clock_sec: number | null;
  action_code: string | null;
  pcode: string | null;
  tcode: string | null;
  home_score: number;
  away_score: number;
  home_win_prob: number | null;
  wpa_home: number | null;
  objective_prob: number | null;
};


/**
 * 유일한 병합 함수 - realtime과 폴링, 그리고 GameReplay가 서버 prop을 다시 받았을 때까지
 * 전부 이걸 쓴다. event_order가 키이고 incoming이 이긴다(수집기의 upsert = 정정 반영).
 * 내용이 하나도 안 바뀌었으면 prev를 "같은 참조로" 돌려준다 - 호출부가 useState/useMemo로
 * 들고 있을 때 무의미한 리렌더를 막기 위해서.
 */
function shallowSameRow(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  // b(새로 들어온 행)의 키만 본다 - realtime payload는 서버 select보다 컬럼이 많고,
  // 반대로 GameReplay가 들고 있는 행은 파생 필드(elapsed/runHome/...)가 더 많다.
  for (const k of Object.keys(b)) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export function mergeEventRows<T extends { event_order: number }>(prev: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return prev;
  const byOrder = new Map<number, T>();
  for (const r of prev) byOrder.set(r.event_order, r);

  let changed = false;
  for (const r of incoming) {
    const cur = byOrder.get(r.event_order);
    // 얕은 비교로 "정말 바뀐 UPDATE"만 반영 - 폴링이 같은 행을 다시 가져와도 리렌더가 안 난다.
    if (cur === undefined || !shallowSameRow(cur, r)) {
      byOrder.set(r.event_order, r);
      changed = true;
    }
  }
  if (!changed) return prev;

  const out = Array.from(byOrder.values());
  out.sort((a, b) => a.event_order - b.event_order);
  return out;
}
