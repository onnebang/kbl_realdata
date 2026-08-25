// tools/export_live_winprob_lookup.py가 뽑아낸 격자를 그대로 읽어서, sklearn 없이 순수 JS로
// "객관적 승률"(팀 전력 제외, 점수차·잔여시간만 반영)을 근사. 파이썬 검증 결과 실제 경기
// 540개 이벤트 기준 평균 오차 0.07%p, 최대 2.87%p(export_live_winprob_lookup.py 주석 참고).
import lookupData from './lookup.json' with { type: 'json' };

interface LookupTable {
  scoreDiffMin: number;
  scoreDiffMax: number;
  scoreDiffStep: number;
  remainingSecMax: number;
  remainingSecStep: number;
  probTable: number[][]; // [remainingIdx][scoreDiffIdx] -> 홈 승률
}

const LUT = lookupData as unknown as LookupTable;

// scoreDiffHome = home - away, remainingSec = 정규/연장 포함 남은 시간(courtside의
// cumulativeElapsedJs와 같은 정의 - 연장 중이면 300초씩 더 얹어서 호출하는 쪽 책임).
export function objectiveWinProb(scoreDiffHome: number, remainingSec: number): number {
  const sd = Math.max(LUT.scoreDiffMin, Math.min(LUT.scoreDiffMax, Math.round(scoreDiffHome)));
  const rem = Math.max(0, Math.min(LUT.remainingSecMax, remainingSec));
  const ri = Math.round(rem / LUT.remainingSecStep);
  const si = sd - LUT.scoreDiffMin;
  return LUT.probTable[ri][si];
}
