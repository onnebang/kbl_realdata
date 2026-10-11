import type { ReactNode } from "react";
import {
  teamInkStyle,
  relativeLuminance,
  colorDistance,
  SIMILAR_COLOR_THRESHOLD,
  isColorSimilar,
  awayFillBackground,
} from "@/lib/teamAccent";

// colorDistance/SIMILAR_COLOR_THRESHOLD/isColorSimilar/awayFillBackground는 lib/teamAccent.ts로
// 옮겼다(postgameReport·InsightCard 등 다른 모듈에서도 쓰기 위해). 하위 호환을 위해 여기서 re-export.
export { colorDistance, SIMILAR_COLOR_THRESHOLD, isColorSimilar, awayFillBackground };


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
