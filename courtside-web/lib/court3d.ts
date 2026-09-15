import { HOOP_RIGHT, mirrorShotX, SCALE_M_PER_UNIT } from "./zoneCompare";
import { classifyShot } from "./formIndex";

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
// 렌더 범위 - 진짜 코트 치수(위 상수들)보다 살짝 넓게 잡는다. 실측(2026-09-15): 골대 원점
// z가 20m를 넘는 "성공" 기록이 99건 있는데, 이 골대 기준 20m는 반대편 골대 페인트 근처까지
// 가야 나오는 거리라 물리적으로 말이 안 된다(이 좌표계에서 하프라인은 12.4m) - 좌표 기록
// 오류로 보인다(이 프로젝트가 이미 아는 shot_log 함정 중 하나, tools/rpc_shot_trend.sql 머리
// 주석의 2017-18 기록 변화와 같은 종류). 반대로 12.4~16m(하프라인 부근~살짝 넘김)는 25건으로
// 실제 하프코트 버저비터일 수 있어 지우지 않고 코트를 그만큼 늘려 담는다. x축은 최대
// 8.47m(사이드라인 밖 1m 이내)로 물리적으로 이상하지 않아 그대로 넓혀 담는다.
export const RENDER_MAX_Z = 16;
export const RENDER_HALF_WIDTH_M = 8.5;

export type Court3DShot = { x: number; z: number; made: boolean; value: 2 | 3; season?: string; team?: string; quarter?: string };

/**
 * z=0을 골대(림) 중심으로 둔다. z<0은 베이스라인 쪽(골대 뒤), z>0은 하프라인 쪽으로 멀어지는
 * 방향. x=0은 림과 같은 좌우 위치(코트 정중앙), 좌우로 ±HALF_WIDTH_M.
 *
 * season을 같이 넣으면(선수 커리어 뷰) 3D 코트가 "빌드업 재생"(요청 - ESPN 르브론 영상처럼
 * 시즌이 넘어가며 득점이 쌓이는 연출)에서 시즌 단위로 묶어 순서대로 보여준다. 팀 페이지처럼
 * season 없이 부르면 통째로 한 번에 보여준다(재생 없이).
 */
export function toCourt3D(
  shots: { x: number; y: number; d: string; made: boolean; season?: string; tcode?: string; quarter?: string }[]
): Court3DShot[] {
  const out: Court3DShot[] = [];
  for (const s of shots) {
    const mx = mirrorShotX(s.x, s.d);
    const x = (s.y - HOOP_RIGHT[1]) * SCALE_M_PER_UNIT;
    const z = (HOOP_RIGHT[0] - mx) * SCALE_M_PER_UNIT;
    // 코트 밖 좌표 오류로 보이는 소수만 뺀다(RENDER_MAX_Z 주석 참고) - 대부분은 그대로 남는다.
    if (z > RENDER_MAX_Z || z < -BASELINE_TO_RIM_M - 1.5 || Math.abs(x) > RENDER_HALF_WIDTH_M) continue;
    out.push({ x, z, made: s.made, value: classifyShot(s.x, s.y, s.d).value as 2 | 3, season: s.season, team: s.tcode, quarter: s.quarter });
  }
  return out;
}
