import { fmtDuration, type HtmlSection, type ReportTags, type ReportTeamMeta } from "./renderKit";
// 타입만 가져온다(런타임 import 아님) - postgameReport.ts가 이 모듈을 import하므로
// 값을 가져오면 순환이 된다. buildLineupSegments()는 호출부(postgameReport.ts)가 이미
// 돌려서 세그먼트를 넘겨주므로 여기선 계산 결과만 받는다.
import type { LineupSegment } from "../postgameReport";

// ---------------------------------------------------------------------------
// 라인업 시너지 흥망성쇠 (Best & Worst 5-Man Units)
//
// 같은 5인이 함께 있던 구간을 전부 합쳐 득실마진을 내고, 팀별로 최고/최악 조합 하나씩만 말한다.
// 이 파일 안에서 두 층이 나뉜다: computeLineupSynergy()는 HTML을 모르는 순수 계산이고,
// renderLineupSynergySection()은 그 결과만 문장으로 바꾼다(숫자를 고치려면 앞을, 문구를
// 고치려면 뒤만 만지면 된다).
//
// 주의(원래 postgameReport.ts 6-1절 주석과 같은 이유): 상대 라인업을 통제하지 않은 한 경기
// 스플릿이라 "이 조합이 잘했다"는 인과로 읽으면 안 된다. per-40 환산도 하지 않는다 -
// 120~600초 표본을 2400초로 늘리면 노이즈가 4~20배가 된다.
// ---------------------------------------------------------------------------

/** 최소 가동 시간. 아래 MIN_DIFF와 함께 인라인 상수였던 값을 그대로 옮긴 것(분포 실측 기반인
 *  CORE_FIVE_* 임계와 달리 이 둘은 눈대중 값이다 - 흔들고 싶으면 여기만 보면 된다). */
export const SYNERGY_MIN_SEC = 120;
/** 최고/최악으로 부를 최소 득실마진(절댓값). */
export const SYNERGY_MIN_DIFF = 8;

/** 5인 조합 하나의 합계. my/opp는 그 조합이 코트에 있던 동안의 자기팀/상대 득점. */
export type FiveManUnit = { key: string; pcodes: string[]; seconds: number; my: number; opp: number };

export type SynergyUnit = { pcodes: string[]; diff: number; dur: number };
export type LineupSynergy = { best: SynergyUnit | null; worst: SynergyUnit | null };

/** 세그먼트를 5인 조합별로 접는다. 온코트가 5명이 아닌 구간(교체 누락·퇴장 등)은 버린다. */
export function aggregateFiveManUnits(segs: LineupSegment[], side: "home" | "away"): FiveManUnit[] {
  const acc = new Map<string, FiveManUnit>();
  for (const s of segs) {
    const lu = side === "home" ? s.homeOn : s.awayOn;
    if (lu.length !== 5) continue;
    const sorted = [...lu].sort();
    const key = sorted.join(",");
    const cur = acc.get(key) ?? { key, pcodes: sorted, seconds: 0, my: 0, opp: 0 };
    cur.seconds += s.seconds;
    cur.my += side === "home" ? s.homePts : s.awayPts;
    cur.opp += side === "home" ? s.awayPts : s.homePts;
    acc.set(key, cur);
  }
  return [...acc.values()];
}

/**
 * units를 넘기면 그걸 쓴다(세그먼트를 다시 접지 않는다) - 호출부(postgameReport.ts)가 주력
 * 5인·온오프 때문에 이미 같은 집계를 들고 있어서, 안 넘기면 같은 순회를 한 번 더 하게 된다.
 * 안 넘기면 예전처럼 segs에서 직접 접는다(테스트·단독 호출 하위호환).
 */
export function computeLineupSynergy(segs: LineupSegment[], side: "home" | "away", units?: FiveManUnit[]): LineupSynergy {
  let best: SynergyUnit | null = null;
  let worst: SynergyUnit | null = null;
  for (const v of units ?? aggregateFiveManUnits(segs, side)) {
    if (v.seconds < SYNERGY_MIN_SEC) continue;
    const diff = v.my - v.opp;
    if (diff >= SYNERGY_MIN_DIFF && (!best || diff > best.diff)) best = { pcodes: v.pcodes, diff, dur: v.seconds };
    if (diff <= -SYNERGY_MIN_DIFF && (!worst || diff < worst.diff)) worst = { pcodes: v.pcodes, diff, dur: v.seconds };
  }
  return { best, worst };
}

export type SynergyEntry = { team: ReportTeamMeta; synergy: LineupSynergy };

/** 양 팀 결과를 한 섹션으로. 말할 게 하나도 없으면 null(섹션을 아예 안 만든다). */
export function renderLineupSynergySection(
  entries: SynergyEntry[],
  ctx: { tags: ReportTags; nameOf: (pcode: string) => string }
): HtmlSection | null {
  const { tags, nameOf } = ctx;
  const items: string[] = [];
  for (const { team, synergy } of entries) {
    const { tcode, name: tname } = team;
    const names = (u: SynergyUnit) => u.pcodes.map((pc) => tags.playerTag(nameOf(pc), tcode)).join(" · ");
    if (synergy.best) {
      items.push(
        `${tags.liOpen(tcode)}📈 ${tags.teamTag(tcode, tname)} <b>최고의 5인 조합</b>: ${names(synergy.best)} - 이 라인업이 코트에 있던 ${fmtDuration(synergy.best.dur)} 동안 득실마진 <b>+${synergy.best.diff}점</b>입니다.</li>`
      );
    }
    if (synergy.worst) {
      items.push(
        `${tags.liOpen(tcode)}📉 ${tags.teamTag(tcode, tname)} <b>최악의 5인 조합</b>: ${names(synergy.worst)} - 이 조합이 가동된 ${fmtDuration(synergy.worst.dur)} 동안 득실마진 <b>${synergy.worst.diff}점</b>입니다.</li>`
      );
    }
  }
  if (!items.length) return null;
  // "상대를 압도하며" / "공수가 무너지며 … 뼈아픈 타격" 같은 수사를 뺐다: 임계값이 ±8점이고
  // 표본이 2~3분인 조합도 걸리므로(SYNERGY_MIN_SEC=120) 그 정도 득실을 압도라고 부르면 데이터
  // 보다 센 주장이 된다. 게다가 한 경기 스플릿이라 인과도 아니다 - 그 한계를 말로 한 번 적고
  // 문장은 숫자만 말하게 둔다(이 모듈 머리주석의 한계 설명과 같은 취지).
  return {
    title: "라인업 시너지 흥망성쇠",
    html:
      `<ul class="report-list">${items.join("")}</ul>` +
      `<p class="report-caveat">상대 라인업을 통제하지 않은 한 경기 득실입니다. 가동 시간이 짧은 조합일수록 잡음이 큽니다.</p>`,
  };
}
