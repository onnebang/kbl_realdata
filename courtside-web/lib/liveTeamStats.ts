import { emptyBoxLine, type BoxLine } from "./boxEvents";

// 실시간 중계 '팀 스탯'(요청 2026-10-19: "팀 전체가 3점을 몇 개 쐈고, 지금 경기가 어느 부분에서 밀리는지") - 스크럽 시점의 선수 박스
// (lib/boxEvents.ts, GameReplay와 같은 규칙)를 팀별로 더하고, 지고 있는 팀이 어디서 밀리는지 고른다. 순수 함수 - 클라이언트 번들용.
//
// 선수 합만 쓴다: 이번 시즌 종료 56팀-경기에서 득점·3점·자유투·리바운드·어시·스틸·블록·턴오버가 공식 game_team_stats와 전부 일치했고,
// 팀 리바운드(218)·팀 턴오버(223) 이벤트를 더하면 오히려 어긋났다(공식 합계에 안 들어간다).

/** 그 팀 선수들의 박스 한 줄 합. */
export function teamLine(box: Map<string, BoxLine>, players: { pcode: string; tcode: string }[], tcode: string): BoxLine {
  const t = emptyBoxLine();
  const keys = Object.keys(t) as (keyof BoxLine)[];
  for (const p of players) {
    if (p.tcode !== tcode) continue;
    const b = box.get(p.pcode);
    if (b) for (const k of keys) t[k] += b[k];
  }
  return t;
}

/** 득점원별 점수 차(t 기준, t - l) - 2점·3점·자유투. 셋을 더하면 정확히 두 팀 득점 차다. */
export function scoringSplit(t: BoxLine, l: BoxLine) {
  return { two: 2 * (t.fgm - t.threePM - (l.fgm - l.threePM)), three: 3 * (t.threePM - l.threePM), ft: t.ftm - l.ftm };
}

export type Gap = { key: "two" | "three" | "ft" | "to" | "oreb"; label: string; value: string; detail: string };

const signed = (n: number, unit: string) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}${unit}`;

// ponytail: 문턱(득점원 3점, 턴오버·공격 리바운드 3개)은 눈대중 고정값 - 1쿼터 초반에도 같은 문턱이다. 시끄러우면 경기 시간에 비례시킨다.
const GAP_PTS = 3;
const GAP_POSS = 3;

/**
 * 지고 있는 팀(t)이 이기는 팀(l)에게 밀리는 곳 - 득점원별로 GAP_PTS점 이상 뒤진 것(크게 뒤진 순), 그다음 공격 기회
 * (턴오버를 GAP_POSS개 이상 더 했거나 공격 리바운드를 그만큼 덜 잡았으면, 차이가 큰 순). 최대 3개, 없으면 빈 배열.
 */
export function whereBehind(t: BoxLine, l: BoxLine): Gap[] {
  const s = scoringSplit(t, l);
  const shots: (Gap & { d: number })[] = [
    { key: "two" as const, label: "2점", d: s.two, detail: `${t.fgm - t.threePM}/${t.fga - t.threePA} vs ${l.fgm - l.threePM}/${l.fga - l.threePA}` },
    { key: "three" as const, label: "3점", d: s.three, detail: `${t.threePM}/${t.threePA} vs ${l.threePM}/${l.threePA}` },
    { key: "ft" as const, label: "자유투", d: s.ft, detail: `${t.ftm}/${t.fta} vs ${l.ftm}/${l.fta}` },
  ]
    .filter((g) => g.d <= -GAP_PTS)
    .sort((a, b) => a.d - b.d)
    .map((g) => ({ ...g, value: signed(g.d, "점") }));
  const poss: (Gap & { d: number })[] = [
    { key: "to" as const, label: "턴오버", d: t.to - l.to, value: signed(t.to - l.to, "개"), detail: `${t.to} vs ${l.to}` },
    { key: "oreb" as const, label: "공격 리바운드", d: l.oreb - t.oreb, value: signed(t.oreb - l.oreb, "개"), detail: `${t.oreb} vs ${l.oreb}` },
  ]
    .filter((g) => g.d >= GAP_POSS)
    .sort((a, b) => b.d - a.d);
  return [...shots, ...poss].slice(0, 3).map(({ key, label, value, detail }) => ({ key, label, value, detail }));
}
