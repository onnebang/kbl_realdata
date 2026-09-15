import { HOOP_RIGHT, mirrorShotX, SCALE_M_PER_UNIT } from "./zoneCompare";

// 3D 코트 뷰(요청: "슛 지도가 그냥 디자인처럼 보인다 - 확장하면 3D로, 슛 색상을") 좌표 변환 +
// 코트 치수. 서버(팀·선수 페이지)에서 원시 shot_log 행을 미터 단위 반코트 좌표로 미리 바꿔서
// 넘긴다 - 클라이언트 번들에 zoneCompare.ts를 끌고 갈 필요가 없고, three.js 쪽은 숫자만 받는다.
// 좌표계는 기존 히어로 별자리(lib/shotDensityField.ts)와 같다: mirrorShotX로 모든 슛을 한쪽
// 골대(HOOP_RIGHT)에 몰아준다 - 히어로와 3D 뷰가 "같은 반코트"를 보여준다.
//
// 코트 선(3점·키·자유투 서클·베이스라인)은 FIBA 규격 숫자를 직접 쓴다(이 프로젝트가 이미
// classifyShot에서 쓰는 3점 거리 6.75m와 같은 출처) - shot_log 픽셀 여백에서 역산하지 않는다.
// 슛 좌표만 SCALE_M_PER_UNIT(0.0413m/단위, zoneCompare.ts에서 검증된 값)으로 실측 환산하면
// 골대를 원점으로 한 이 규격선들과 자동으로 맞아떨어진다(3점슛으로 기록된 슛은 실제로
// 원점에서 6.75m 이상 떨어진 자리에 찍힌다).
export const THREE_PT_M = 6.75;
export const RIM_HEIGHT_M = 3.05;
export const RIM_RADIUS_M = 0.225;
export const BASELINE_TO_RIM_M = 1.575;
export const BACKBOARD_TO_RIM_M = 0.15;
export const KEY_WIDTH_M = 4.9;
export const KEY_LENGTH_M = 5.8; // 베이스라인 - 자유투 라인
export const FT_CIRCLE_R_M = 1.8;
export const HALF_WIDTH_M = 7.5; // 코트 중앙(사이드라인까지 절반)
export const HALFCOURT_LINE_Z = 14 - BASELINE_TO_RIM_M; // 골대 기준 하프라인까지

export type Court3DShot = { x: number; z: number; made: boolean };

/**
 * z=0을 골대(림) 중심으로 둔다. z<0은 베이스라인 쪽(골대 뒤), z>0은 하프라인 쪽으로 멀어지는
 * 방향. x=0은 림과 같은 좌우 위치(코트 정중앙), 좌우로 ±HALF_WIDTH_M.
 */
export function toCourt3D(shots: { x: number; y: number; d: string; made: boolean }[]): Court3DShot[] {
  return shots.map((s) => {
    const mx = mirrorShotX(s.x, s.d);
    return {
      x: (s.y - HOOP_RIGHT[1]) * SCALE_M_PER_UNIT,
      z: (HOOP_RIGHT[0] - mx) * SCALE_M_PER_UNIT,
      made: s.made,
    };
  });
}
