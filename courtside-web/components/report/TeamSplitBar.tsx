import type { ReactNode } from "react";
import {
  teamInkStyle,
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

const pctOf = (made: number, att: number) => (att > 0 ? Math.round((made / att) * 100) : 0);

/**
 * 성공률 막대 - 요청: "같은 40%라도 3점 10개 들어간 40%랑 3개 들어간 40%는 다른 느낌을 주도록". 막대 "길이"는 두 팀 시도 합 대비
 * 비중이고(볼륨 차이가 먼저 보인다), 그 안의 "채움"만 성공률이다. 경기 후 '팀 스탯'(app/games/[gmkey]/page.tsx)과 실시간
 * '팀 스탯'(components/LiveTeamStats.tsx)이 같이 쓴다 - 두 벌이면 한쪽만 손봐 같은 경기 화면의 막대가 서로 달라진다.
 */
export function TeamPctBar({
  label,
  hMade,
  hAtt,
  aMade,
  aAtt,
  hColor,
  aColor,
}: {
  label: string;
  hMade: number;
  hAtt: number;
  aMade: number;
  aAtt: number;
  hColor: string;
  aColor: string;
}) {
  const hPct = pctOf(hMade, hAtt);
  const aPct = pctOf(aMade, aAtt);
  const totalAtt = hAtt + aAtt;
  const hShare = totalAtt > 0 ? (hAtt / totalAtt) * 100 : 50;
  return (
    <div className="ts-row">
      <div className="ts-nums">
        <span className="ts-home team-ink" style={teamInkStyle(hColor)}>
          {hPct}% <span className="ts-raw">{hMade}-{hAtt}</span>
        </span>
        <span className="ts-label">{label}</span>
        <span className="ts-away team-ink" style={teamInkStyle(aColor)}>
          <span className="ts-raw">{aMade}-{aAtt}</span> {aPct}%
        </span>
      </div>
      <div className="ts-bar">
        <div className="ts-bar-seg" style={{ width: `${hShare}%` }}>
          <div className="ts-bar-seg-fill" style={{ width: `${hPct}%`, right: 0, background: hColor }} />
        </div>
        <div className="ts-bar-seg" style={{ width: `${100 - hShare}%` }}>
          <div className="ts-bar-seg-fill" style={{ width: `${aPct}%`, left: 0, background: awayFillBackground(hColor, aColor) }} />
        </div>
      </div>
    </div>
  );
}
