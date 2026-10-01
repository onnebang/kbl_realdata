import type { FourFactors } from "./fourFactors";

// ---------------------------------------------------------------------------
// 득점 출처 차트의 계산부 - 화면(components/report/ScoreSourceChart.tsx)은 이 모델만 그린다.
//
// 왜 다시 그렸나 (요청 2026-10-01, 스크린샷 S49G14N10): 예전 차트는 줄마다 **두 팀 합 대비
// 비율**로 막대를 나눴다(TeamSplitBar). 그래서 막대 길이가 "점수"가 아니라 "점유율"이었고,
// 자유투 7:15(점유율 68%)가 2점 30:44(59%)보다 더 긴 색 막대로 보였다 - 줄끼리 비교가 안 된다.
// 줄마다 합이 달라도 같은 점유율이면 같은 모양이 되는 구조라, 점수가 작은 줄이 큰 줄만큼
// 극적으로 보이는 것이 근본 문제다.
//
// 고친 방식: **모든 줄이 하나의 눈금**을 쓴다. 가운데 기준 좌우 막대(홈 왼쪽 / 원정 오른쪽)이고
// 막대 길이 = 점수 ÷ 눈금 최댓값이다. 줄마다 다시 정규화하지 않는다.
//
// 디자인은 세 안(안 A 두 톤 막대 / 안 B 최종 점수차 분해 / 안 C 단색 버터플라이)을 같은 데이터로
// 헤드리스 Chrome에서 렌더해 비교했고, 스크린샷만 보고 푸는 이해도 퀴즈를 3명에게 냈다. 정답률은
// 셋 다 4/4(숫자가 적혀 있으니 당연하다)라 변별이 안 됐고, 오히려 **막힌 지점**이 갈랐다:
//   C: 줄별 차이가 안 적혀 있어 3명 모두 직접 뺄셈 / 다크에서 남색 막대가 배경에 묻힘(1명)
//   A: "+N" 칩은 빨랐지만 연함/진함 두 톤 막대를 해석하기 어렵다 / 칩 위치가 들쭉날쭉 / 다크 대비 부족(3명)
//   B: 두 톤 범례를 해독해야 함 / 3점 줄만 달라 보임
// 그래서 C의 단색 막대 + A·B의 "+N 우세 칩" + 최종 점수 행으로 합성했다(두 톤은 쓰지 않는다).
// ---------------------------------------------------------------------------

/** 눈금선 간격(점). 모든 줄이 같은 눈금이라는 걸 눈으로 확인하게 해 주는 점선 한 칸. */
export const SCORE_GRID_STEP_PTS = 10;

/** 0이 아닌데 막대가 안 보이면 "득점 없음"으로 읽힌다 - 최소 길이(눈금 대비 %). 0은 그대로 0이다. */
const MIN_VISIBLE_PCT = 1.6;

export type Lead = "home" | "away" | "tie";

export type ChartRow = {
  key: string;
  label: string;
  home: number;
  away: number;
  homeMade: number;
  homeAtt: number;
  awayMade: number;
  awayAtt: number;
  /** 막대 길이 - 한쪽 반(가운데~바깥 끝)의 몇 %인가. 모든 줄이 같은 눈금이다. */
  homePct: number;
  awayPct: number;
  lead: Lead;
  /** |홈 - 원정|. */
  margin: number;
  /** "tie": 같은 점수 / "none": 둘 다 득점 없음. */
  tag: "tie" | "none" | null;
  /** '구역 미확인' 줄 - 공식 2점 득점 중 슛 좌표로 구역을 못 정한 몫. */
  unplaced: boolean;
};

export type ScoreChartModel = {
  rows: ChartRow[];
  /** 눈금 최댓값(점). 한쪽 반 폭 전체가 이 점수다. */
  axisMax: number;
  /** 눈금선 한 칸이 한쪽 반 폭의 몇 %인가. */
  stepPct: number;
  /** 최종 점수(공식 3분류의 합 - 항상 정확하다). */
  total: { home: number; away: number; lead: Lead; margin: number };
};

function leadOf(home: number, away: number): Lead {
  return home > away ? "home" : away > home ? "away" : "tie";
}

function pct(pts: number, axisMax: number): number {
  if (pts <= 0 || axisMax <= 0) return 0;
  return Math.max(MIN_VISIBLE_PCT, (pts / axisMax) * 100);
}

/**
 * ff.scoring(구역 6줄 또는 3분류 3줄)을 그릴 모델로 바꾼다.
 *
 * - 공식 2점 득점 중 구역으로 못 놓은 몫(부족분)이 있으면 3점 줄 뒤에 '구역 미확인' 줄을 넣는다.
 *   그래야 줄을 다 더하면 최종 점수가 된다(합 = 최종 점수를 거짓으로 약속하지 않고, 숨기지도 않는다).
 *   반대로 구역 합이 공식보다 **많은** 경우(좌표가 3점을 2점으로 센 경우)는 음수 막대를 그릴 수
 *   없어서 줄을 만들지 않고 화면의 주석이 말한다(scoreSourceNotes).
 */
export function buildScoreChart(ff: FourFactors): ScoreChartModel {
  const base = ff.scoring.map((s) => ({ ...s, unplaced: false }));

  const rc = ff.zoneReconcile;
  if (ff.zoneStatus === "zones" && rc) {
    const homeUn = Math.max(0, rc.home.official - rc.home.zone);
    const awayUn = Math.max(0, rc.away.official - rc.away.zone);
    if (homeUn > 0 || awayUn > 0) {
      const at = base.findIndex((r) => r.key === "ft");
      const row = {
        key: "unplaced",
        label: "구역 미확인",
        home: homeUn,
        away: awayUn,
        homeMade: 0,
        homeAtt: 0,
        awayMade: 0,
        awayAtt: 0,
        unplaced: true,
      };
      base.splice(at < 0 ? base.length : at, 0, row);
    }
  }

  const maxPts = base.reduce((m, r) => Math.max(m, r.home, r.away), 0);
  // 눈금 최댓값은 5의 배수로 올린다 - 점선(10점)이 항상 정수 칸으로 떨어지고 최대 막대가 끝에 딱 붙지 않는다.
  const axisMax = Math.max(SCORE_GRID_STEP_PTS, Math.ceil(maxPts / 5) * 5);

  const rows: ChartRow[] = base.map((r) => ({
    key: r.key,
    label: r.label,
    home: r.home,
    away: r.away,
    homeMade: r.homeMade,
    homeAtt: r.homeAtt,
    awayMade: r.awayMade,
    awayAtt: r.awayAtt,
    homePct: pct(r.home, axisMax),
    awayPct: pct(r.away, axisMax),
    lead: leadOf(r.home, r.away),
    margin: Math.abs(r.home - r.away),
    tag: r.home === 0 && r.away === 0 ? "none" : r.home === r.away ? "tie" : null,
    unplaced: r.unplaced,
  }));

  const totalHome = ff.categories.reduce((t, r) => t + r.home, 0);
  const totalAway = ff.categories.reduce((t, r) => t + r.away, 0);
  return {
    rows,
    axisMax,
    stepPct: (SCORE_GRID_STEP_PTS / axisMax) * 100,
    total: { home: totalHome, away: totalAway, lead: leadOf(totalHome, totalAway), margin: Math.abs(totalHome - totalAway) },
  };
}

/**
 * 구역 분해에 대해 독자가 알아야 할 것. 비어 있으면 아무 말도 하지 않는다.
 *
 * 구역 줄은 슛 좌표라 공식 2점 득점과 어긋나는 경기가 있다(실측 8,444 팀-경기 중 정확히 일치
 * 71.4% - fourFactors.ts의 ZONE_MAX_GAP_PTS). 경기 단위로는 최근 시즌 약 1/3에서 노트가 뜬다.
 */
export function scoreSourceNotes(ff: FourFactors): string[] {
  const out: string[] = [];
  const { home, away, zoneStatus, zoneReconcile: rc } = ff;

  if (zoneStatus === "unavailable") {
    // "기록이 없어"라고 단정하지 않는다 - 슛 조회가 실패해 빈 배열로 폴백된 경우(page.tsx의 soft)와
    // 정말 없는 경우를 여기서는 구분할 수 없다. 두 경우 모두 참인 말만 한다.
    out.push("이 경기는 슛 위치 자료 없이 공식 기록 3가지(2점·3점·자유투)로만 나눴습니다.");
  } else if (zoneStatus === "too_far" && rc) {
    out.push(
      `슛 위치 기록이 공식 기록과 크게 어긋나(${home.name} 구역 합 ${rc.home.zone}점 · 공식 2점 득점 ${rc.home.official}점, ` +
        `${away.name} 구역 합 ${rc.away.zone}점 · 공식 ${rc.away.official}점) 구역 없이 공식 기록 3가지(2점·3점·자유투)로만 나눴습니다.`
    );
  } else if (zoneStatus === "zones" && rc) {
    for (const [team, r] of [
      [home, rc.home],
      [away, rc.away],
    ] as const) {
      const gap = r.official - r.zone;
      if (gap > 0) {
        out.push(`${team.name}의 2점 득점 중 ${gap}점은 슛 위치 기록이 공식 기록에 모자라 구역을 정하지 못했습니다('구역 미확인'). 구역 합에 더해야 최종 점수와 같아집니다.`);
      } else if (gap < 0) {
        out.push(
          `${team.name}의 림~롱2 구역 합(${r.zone}점)이 공식 2점 득점(${r.official}점)보다 ${-gap}점 많습니다 - 슛 위치 판정과 공식 기록의 차이이며, 이 팀의 줄 합계는 최종 점수보다 ${-gap}점 많게 보입니다.`
        );
      }
    }
  }
  return out;
}
