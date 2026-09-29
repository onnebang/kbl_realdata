import type { ReportTeamMeta } from "./renderKit";

// ---------------------------------------------------------------------------
// 스탯에 보이지 않은 선수 (2.5)
//
// 득점은 적은데 그가 코트에 있을 때 팀 마진이 좋았던 선수. 팀당 최대 한 명.
//
// aceDuel.ts와 같이 render* 함수가 없다 - 문장은 components/report/UnsungHeroSection.tsx가
// JSX로 만든다(renderKit.ts의 ReportSection 주석 참고).
//
// 한계(lineupSynergy.ts와 동일): 상대 라인업을 통제하지 않은 한 경기 온/오프 스플릿이다.
// "이 선수가 팀을 살렸다"는 인과가 아니라 "있을 때 이랬고 없을 때 저랬다"까지만 말한다.
// 그래서 주체를 고를 때도 온/오프 격차 최댓값 하나만 쓰고(팀당 1명), 여러 명을 줄세우지 않는다.
// ---------------------------------------------------------------------------

/** 이 점수 이상이면 '스탯에 보이지 않은' 선수가 아니다(에이스 제외). 인라인 상수였던 12 그대로. */
export const UNSUNG_MAX_PTS = 12;
/** 최소 출전 시간 - 이보다 짧으면 마진이 표본이 아니라 잡음이다. */
export const UNSUNG_MIN_ON_SEC = 300;
/** 온-오프 마진 격차. 이만큼 벌어져야 말할 거리가 된다. */
export const UNSUNG_MIN_ONOFF_DIFF = 10;

/**
 * 후보 한 명. 온/오프는 호출부가 이미 만들어 둔 집계에서 꺼내 넘긴다(SideRollup/onOffOf) -
 * 이 모듈이 세그먼트를 다시 훑지 않게, 그리고 LineupSegment 타입을 몰라도 되게.
 */
export type UnsungCandidate = {
  name: string;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  onSec: number;
  onMargin: number;
  offSec: number;
  offMargin: number;
};

/** 문장에 나갈 '궂은일' 한 항목. 0인 스탯은 애초에 담지 않는다(컴포넌트에 분기를 안 넘긴다). */
export type UnsungChore = { label: string; value: number };

export type UnsungHero = {
  team: ReportTeamMeta;
  name: string;
  pts: number;
  chores: UnsungChore[];
  onSec: number;
  onMargin: number;
  offSec: number;
  offMargin: number;
};

export type UnsungHeroes = { kind: "unsung_heroes"; heroes: UnsungHero[] };

function choresOf(c: UnsungCandidate): UnsungChore[] {
  // 순서는 원본 문장 그대로(리바운드 -> 어시스트 -> 스틸 -> 블록).
  return (
    [
      { label: "리바운드", value: c.reb },
      { label: "어시스트", value: c.ast },
      { label: "스틸", value: c.stl },
      { label: "블록", value: c.blk },
    ] as const
  ).filter((x) => x.value > 0);
}

/** 한 팀에서 한 명. 조건을 만족하는 후보가 없으면 null. 동점이면 먼저 온 후보(박스스코어 순서). */
export function pickUnsungHero(team: ReportTeamMeta, candidates: UnsungCandidate[]): UnsungHero | null {
  let best: UnsungCandidate | null = null;
  let bestDiff = 0;
  for (const c of candidates) {
    if (c.pts >= UNSUNG_MAX_PTS) continue;
    if (c.onSec < UNSUNG_MIN_ON_SEC) continue;
    const diff = c.onMargin - c.offMargin;
    // 코트에 있을 땐 +, 없을 땐 - 인 선수만. 부호 조건이 없으면 "둘 다 +인데 덜 +"인 경우까지 걸린다.
    if (diff < UNSUNG_MIN_ONOFF_DIFF || c.onMargin <= 0 || c.offMargin >= 0) continue;
    if (!best || diff > bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  if (!best) return null;
  return {
    team,
    name: best.name,
    pts: best.pts,
    chores: choresOf(best),
    onSec: best.onSec,
    onMargin: best.onMargin,
    offSec: best.offSec,
    offMargin: best.offMargin,
  };
}

/** 양 팀을 합쳐 한 섹션으로. 아무도 없으면 null(섹션을 아예 안 만든다). */
export function computeUnsungHeroes(
  sides: { team: ReportTeamMeta; candidates: UnsungCandidate[] }[]
): UnsungHeroes | null {
  const heroes = sides.map((s) => pickUnsungHero(s.team, s.candidates)).filter((h): h is UnsungHero => h !== null);
  return heroes.length ? { kind: "unsung_heroes", heroes } : null;
}
