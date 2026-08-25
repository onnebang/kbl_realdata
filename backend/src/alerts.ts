// 이벤트 감지 로직 - courtside_template.html의 기존 임계값을 그대로 재사용(새로 발명하지
// 않음): NOTABLE_WPA_THRESHOLD=0.05가 스윙 알림 기본값, 쿼터 경계는 qBounds/QUARTER_ORDER_JS
// 개념 그대로. Cloudflare/KBL API와 무관한 순수 함수라 계정 없이 dryrun으로 검증 가능.

export const QUARTERS_ORDER = ['Q1', 'Q2', 'Q3', 'Q4', 'X1', 'X2', 'X3', 'X4'] as const;
export type Quarter = (typeof QUARTERS_ORDER)[number] | 'PRE';

export const SWING_THRESHOLD_DEFAULT = 0.05; // courtside의 NOTABLE_WPA_THRESHOLD와 동일

export interface GameSnapshot {
  quarter: Quarter;
  homeScore: number;
  awayScore: number;
  homeProb: number; // 0~1, objectiveWinProb() 결과
}

export type AlertEvent =
  | { type: 'quarter_end'; quarter: Quarter; homeScore: number; awayScore: number; homeProb: number }
  | { type: 'prob_swing'; deltaHome: number; homeScore: number; awayScore: number; homeProb: number; quarter: Quarter }
  | { type: 'favorite_flip'; newFavorite: 'home' | 'away'; homeScore: number; awayScore: number; homeProb: number; quarter: Quarter };

// prev -> cur 한 스텝 사이에 발생한 알림 이벤트를 전부 반환(한 스텝에 여러 개 겹칠 수 있음 -
// 예: 쿼터 종료 버저비터가 동시에 큰 스윙이거나 역전인 경우).
export function detectEvents(
  prev: GameSnapshot | null,
  cur: GameSnapshot,
  swingThreshold: number = SWING_THRESHOLD_DEFAULT,
): AlertEvent[] {
  if (!prev) return [];
  const events: AlertEvent[] = [];

  if (prev.quarter !== cur.quarter && QUARTERS_ORDER.includes(prev.quarter as any)) {
    events.push({
      type: 'quarter_end', quarter: prev.quarter,
      homeScore: prev.homeScore, awayScore: prev.awayScore, homeProb: prev.homeProb,
    });
  }

  const delta = cur.homeProb - prev.homeProb;
  if (Math.abs(delta) >= swingThreshold) {
    events.push({
      type: 'prob_swing', deltaHome: delta,
      homeScore: cur.homeScore, awayScore: cur.awayScore, homeProb: cur.homeProb, quarter: cur.quarter,
    });
  }

  const prevFavorite = prev.homeProb >= 0.5 ? 'home' : 'away';
  const curFavorite = cur.homeProb >= 0.5 ? 'home' : 'away';
  if (prevFavorite !== curFavorite) {
    events.push({
      type: 'favorite_flip', newFavorite: curFavorite,
      homeScore: cur.homeScore, awayScore: cur.awayScore, homeProb: cur.homeProb, quarter: cur.quarter,
    });
  }

  return events;
}

// courtside_template.html의 josa()/iGa()와 동일한 로직(받침 유무로 이/가 선택) - 표시
// 문구가 두 군데서 갈라지지 않도록 같은 판정 규칙을 그대로 씀.
function iGa(word: string): string {
  if (!word) return '가';
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return '가';
  return (code - 0xac00) % 28 !== 0 ? '이' : '가';
}

export function formatAlertText(ev: AlertEvent, homeTname: string, awayTname: string): string {
  const score = `${homeTname} ${ev.homeScore} - ${ev.awayScore} ${awayTname}`;
  const pct = Math.round(ev.homeProb * 100);
  switch (ev.type) {
    case 'quarter_end':
      return `${ev.quarter} 종료 · ${score} · ${homeTname} 승률 ${pct}%`;
    case 'prob_swing': {
      const pts = Math.round(ev.deltaHome * 100);
      const dir = pts >= 0 ? `${homeTname} +${pts}%p` : `${awayTname} +${-pts}%p`;
      return `승률 급변(${dir}) · ${score} · ${homeTname} 승률 ${pct}%`;
    }
    case 'favorite_flip': {
      const fav = ev.newFavorite === 'home' ? homeTname : awayTname;
      return `승부 역전 - 이제 ${fav}${iGa(fav)} 우세 · ${score} · ${homeTname} 승률 ${pct}%`;
    }
  }
}
