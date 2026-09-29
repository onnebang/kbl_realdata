import { describe, expect, it } from "vitest";
import {
  attachDerivedFields,
  SURGE_MIN_DIFF,
  SURGE_WINDOW_SEC,
  type GameEvent,
  type Surge,
} from "./postgameReport";

// computeSurgeAt()의 스캔을 O(N²) 전수에서 "창 크기만큼"으로 줄인 변경(ElapsedIndex)이
// **결과를 바꾸지 않는다**는 걸 잠가 두는 테스트.
//
// 실경기 26건(880행짜리 3차 연장 3경기 + 전체 4,192경기 중 시계 역행이 가장 많은 12경기
// 포함)으로 파생 필드를 바이트 단위 대조해 0건 차이를 확인했지만, 그건 그때의 데이터일 뿐이다.
// 여기서는 (1) 무작위 생성 경기에서 최적화 전 알고리즘과 전수 대조하고, (2) 순진하게
// break로 끊었을 때 실제로 틀리는 모양을 한 건 만들어 가드가 일하고 있음을 보인다.

type Raw = Omit<GameEvent, "elapsed" | "runHome" | "runAway" | "surge">;

function ev(p: Partial<Raw> & Pick<Raw, "event_order" | "quarter" | "home_score" | "away_score">): Raw {
  return {
    clock_min: null,
    clock_sec: null,
    action_code: null,
    action_label: null,
    pcode: null,
    player_name: null,
    tcode: null,
    home_win_prob: null,
    wpa_home: null,
    objective_prob: null,
    ...p,
  };
}

/**
 * 최적화 **전** computeSurgeAt - events[0..i-1] 전수를 거꾸로 훑는다(창 밖은 continue).
 * 최적화된 구현이 이것과 같은 값을 내야 한다.
 */
function surgeBrute(events: GameEvent[], i: number): Surge | null {
  const cur = events[i];
  if (cur.quarter === "PRE") return null;
  const mNow = cur.home_score - cur.away_score;
  let lowIdx = i,
    highIdx = i;
  for (let j = i - 1; j >= 0; j--) {
    const p = events[j];
    if (p.quarter === "PRE") continue;
    if (cur.elapsed - p.elapsed > SURGE_WINDOW_SEC) continue;
    const m = p.home_score - p.away_score;
    if (m < events[lowIdx].home_score - events[lowIdx].away_score) lowIdx = j;
    if (m > events[highIdx].home_score - events[highIdx].away_score) highIdx = j;
  }
  const homeSurge = mNow - (events[lowIdx].home_score - events[lowIdx].away_score);
  const awaySurge = events[highIdx].home_score - events[highIdx].away_score - mNow;
  const homeSide = homeSurge >= awaySurge;
  const diff = homeSide ? homeSurge : awaySurge;
  if (diff < SURGE_MIN_DIFF) return null;
  const start = events[homeSide ? lowIdx : highIdx];
  return {
    side: homeSide ? "home" : "away",
    lead: homeSide ? cur.home_score - start.home_score : cur.away_score - start.away_score,
    opp: homeSide ? cur.away_score - start.away_score : cur.home_score - start.home_score,
    seconds: Math.max(0, cur.elapsed - start.elapsed),
  };
}

/** 같은 스캔을 "창을 벗어나면 break"로 끊은 것 - 고치면 안 되는 쪽(반례 확인용). */
function surgeNaiveBreak(events: GameEvent[], i: number): Surge | null {
  const cur = events[i];
  if (cur.quarter === "PRE") return null;
  const mNow = cur.home_score - cur.away_score;
  let lowIdx = i,
    highIdx = i;
  for (let j = i - 1; j >= 0; j--) {
    const p = events[j];
    if (p.quarter === "PRE") continue;
    if (cur.elapsed - p.elapsed > SURGE_WINDOW_SEC) break; // ← 이게 창을 자른다
    const m = p.home_score - p.away_score;
    if (m < events[lowIdx].home_score - events[lowIdx].away_score) lowIdx = j;
    if (m > events[highIdx].home_score - events[highIdx].away_score) highIdx = j;
  }
  const homeSurge = mNow - (events[lowIdx].home_score - events[lowIdx].away_score);
  const awaySurge = events[highIdx].home_score - events[highIdx].away_score - mNow;
  const homeSide = homeSurge >= awaySurge;
  if ((homeSide ? homeSurge : awaySurge) < SURGE_MIN_DIFF) return null;
  const start = events[homeSide ? lowIdx : highIdx];
  return {
    side: homeSide ? "home" : "away",
    lead: homeSide ? cur.home_score - start.home_score : cur.away_score - start.away_score,
    opp: homeSide ? cur.away_score - start.away_score : cur.home_score - start.home_score,
    seconds: Math.max(0, cur.elapsed - start.elapsed),
  };
}

/** 쿼터 안 남은 시간(분:초)으로 이벤트를 만든다 - elapsed는 attachDerivedFields가 계산한다. */
function at(order: number, quarter: string, min: number, sec: number, home: number, away: number): Raw {
  return ev({ event_order: order, quarter, clock_min: min, clock_sec: sec, home_score: home, away_score: away });
}

describe("서지 스캔(ElapsedIndex) - 최적화 전후 동일성", () => {
  it("시계가 뒤로 가는 무작위 경기 전수 대조 - 모든 행의 surge가 전수 스캔과 같다", () => {
    // 선형 합동 생성기(고정 시드) - 테스트가 매 실행 같은 경기를 본다.
    let seed = 20260929;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    const raw: Raw[] = [ev({ event_order: 0, quarter: "PRE", home_score: 0, away_score: 0 })];
    let home = 0,
      away = 0,
      order = 1;
    for (const q of ["Q1", "Q2", "Q3", "Q4", "X1"]) {
      const len = q === "X1" ? 300 : 600;
      let t = 0; // 쿼터 경과 초
      while (t < len) {
        t += 1 + Math.floor(rnd() * 12);
        // 시계 흔들림: 8%의 행에서 최대 250초까지 뒤로 간다(실측 최대 240초보다 크게).
        let shown = t;
        if (rnd() < 0.08) shown = Math.max(0, t - Math.floor(rnd() * 250));
        if (shown > len) shown = len;
        // 한쪽이 몰아치는 구간을 일부러 만들어 서지가 실제로 켜지게 한다.
        const r = rnd();
        if (r < 0.34) home += rnd() < 0.3 ? 3 : 2;
        else if (r < 0.62) away += rnd() < 0.3 ? 3 : 2;
        const remain = len - shown;
        raw.push(at(order++, q, Math.floor(remain / 60), remain % 60, home, away));
      }
    }

    const events = attachDerivedFields(raw);
    expect(events.length).toBeGreaterThan(300);

    // 흔들림이 실제로 들어갔는지(대조가 의미 있으려면 elapsed가 단조증가가 아니어야 한다)
    let backSteps = 0;
    for (let i = 1; i < events.length; i++) if (events[i].elapsed < events[i - 1].elapsed) backSteps++;
    expect(backSteps).toBeGreaterThan(5);

    // 서지가 한 번은 켜져야 대조에 의미가 있다
    expect(events.some((e) => e.surge !== null)).toBe(true);

    for (let i = 0; i < events.length; i++) {
      expect(events[i].surge, `event_order ${events[i].event_order} (i=${i})`).toEqual(surgeBrute(events, i));
    }
  });

  it("창 밖 행 하나에서 break로 끊으면 실제로 틀린다 - prefix-max 가드가 막는 지점", () => {
    // Q2 안에서 elapsed 900 -> 950 -> 640(310초 역행) -> 1000.
    // 1000 시점의 창(700 이상)에는 950·900이 들어 있는데, 거꾸로 훑다가 640에서 break하면
    // 둘을 못 본다 -> 홈의 20점 서지가 통째로 사라진다.
    const raw: Raw[] = [
      ev({ event_order: 0, quarter: "PRE", home_score: 0, away_score: 0 }),
      at(1, "Q2", 5, 0, 40, 55), // elapsed 900, 마진 -15 (창 안 최저)
      at(2, "Q2", 4, 10, 42, 55), // elapsed 950, 마진 -13
      at(3, "Q2", 9, 20, 42, 55), // elapsed 640 - 시계 역행, 창 밖(1000-640=360>300)
      at(4, "Q2", 3, 20, 60, 55), // elapsed 1000, 마진 +5
    ];
    const events = attachDerivedFields(raw);
    expect(events.map((e) => e.elapsed)).toEqual([0, 900, 950, 640, 1000]);

    const last = events.length - 1;
    // 실제 구현 == 전수 스캔: 900행부터 20-0으로 벌린 서지를 잡는다.
    expect(events[last].surge).toEqual({ side: "home", lead: 20, opp: 0, seconds: 100 });
    expect(events[last].surge).toEqual(surgeBrute(events, last));
    // 그리고 순진한 break는 이걸 놓친다 - 두 방식이 갈리는 실제 반례가 존재한다는 증거.
    expect(surgeNaiveBreak(events, last)).toBeNull();
  });
});
