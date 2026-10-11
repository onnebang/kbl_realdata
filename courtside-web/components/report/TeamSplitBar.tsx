import type { ReactNode } from "react";
import { teamInkStyle, relativeLuminance } from "@/lib/teamAccent";

// 홈/원정이 가운데서 마주보는 비교 막대 한 줄. 원래 app/games/[gmkey]/page.tsx 안의
// tsBarRow()였고, 리포트 섹션(FourFactorsSection)도 같은 막대를 써야 해서 여기로 꺼냈다.
// .ts-row/.ts-nums/.ts-bar 스타일은 app/globals.css에 이미 있는 것을 그대로 쓴다(새 CSS 없음).
//
// hexToRgb/colorDistance/awayFillBackground도 같이 옮겼다 - tsBarRow가 원정 막대 배경을
// 만들 때 쓰는 것이라 떼어놓으면 두 벌이 된다.

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [parseInt(clean.slice(0, 2), 16) || 0, parseInt(clean.slice(2, 4), 16) || 0, parseInt(clean.slice(4, 6), 16) || 0];
}

/**
 * redmean 색상거리 - 단순 유클리드보다 사람 눈 인지에 가깝다.
 */
export function colorDistance(hex1: string, hex2: string): number {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  const rMean = (r1 + r2) / 2;
  const dr = r1 - r2,
    dg = g1 - g2,
    db = b1 - b2;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

// 110: 안양 정관장 #C8102E vs 창원 LG #8E1B3D(거리 99.9), 서울 SK #E4002B vs 창원 LG(거리 104) 등
// 유사 색상 매치업을 정확히 감지하면서, KCC(남색 #0C2340) vs 한국가스공사(파랑 #0072CE, 거리 291)처럼
// 명도 대비가 뚜렷한 다른 색상은 제외하는 최적 임계값.
export const SIMILAR_COLOR_THRESHOLD = 110;

/**
 * 두 팀 색이 비슷해 한눈에 구분이 안 되는지 판별(Kit / Color Clash).
 */
export function isColorSimilar(hex1: string, hex2: string): boolean {
  if (!hex1 || !hex2) return false;
  return colorDistance(hex1, hex2) < SIMILAR_COLOR_THRESHOLD;
}

/**
 * 원정 막대 배경 - 색이 비슷하면 팀 색 그대로 위에 흰색 대각선 줄무늬를 겹쳐서(그 팀 색
 * 자체는 유지한 채 질감만 다르게) 홈과 눈으로 구분되게. 안 비슷하면 그냥 단색.
 */
export function awayFillBackground(homeColor: string, awayColor: string): string {
  if (!isColorSimilar(homeColor, awayColor)) return awayColor;
  return `repeating-linear-gradient(45deg, transparent 0 4px, rgba(255,255,255,0.45) 4px 8px), ${awayColor}`;
}

/**
 * 막대 길이는 두 값의 **비중**으로 나눈다(합이 100%). 둘 다 0이면 반반.
 * hDisp/aDisp는 막대 위에 찍히는 표시값이라 막대 길이와 다른 값이어도 된다 - 예를 들어
 * TOV%는 낮을수록 좋으므로 막대만 (1-비율)로 뒤집고 숫자는 실제 비율을 찍는다.
 */
export function TeamSplitBar({
  label,
  hVal,
  aVal,
  hDisp,
  aDisp,
  hColor,
  aColor,
}: {
  label: string;
  hVal: number;
  aVal: number;
  hDisp: ReactNode;
  aDisp: ReactNode;
  hColor: string;
  aColor: string;
}) {
  const total = hVal + aVal;
  const hPct = total > 0 ? (hVal / total) * 100 : 50;
  return (
    <div className="ts-row">
      <div className="ts-nums">
        <span className="ts-home team-ink" style={teamInkStyle(hColor)}>
          {hDisp}
        </span>
        <span className="ts-label">{label}</span>
        <span className="ts-away team-ink" style={teamInkStyle(aColor)}>
          {aDisp}
        </span>
      </div>
      <div className="ts-bar">
        <div className="ts-bar-fill" style={{ width: `${hPct}%`, background: hColor }} />
        <div className="ts-bar-fill" style={{ width: `${100 - hPct}%`, background: awayFillBackground(hColor, aColor) }} />
      </div>
    </div>
  );
}
