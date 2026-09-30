import type { ReactNode } from "react";
import type { ReportTeamMeta } from "@/lib/report/renderKit";
import type { StockWatch } from "@/lib/report/stockWatch";
import { PlayerTag, ReportLi } from "./tags";

// 주가 변동 리포트 (8.10) - 기존 문자열 조립을 선언적 컴포넌트로 옮긴 것. 렌더 결과는
// 기존과 바이트 단위로 같다(StockWatchSection.test.tsx가 고정 - 리팩터링과 문구 변경을
// 섞지 않으려고 한 글자도 바꾸지 않았다).

/**
 * 팀 메타가 없는 행의 폴백 - 원본 liOpen()/playerTag()가 그 경우 클래스도 색도 없는 <li>와
 * 칩 없는 맨 이름을 내보냈다. 이 경기 박스스코어라 실제로는 일어나지 않지만, 마이그레이션이
 * 바꾸는 것은 마크업을 만드는 방법뿐이어야 해서 폴백까지 그대로 옮긴다(테스트로 고정).
 */
function StockLi({ team, children }: { team: ReportTeamMeta | null; children: ReactNode }) {
  return team ? <ReportLi team={team}>{children}</ReportLi> : <li>{children}</li>;
}
function StockName({ team, name }: { team: ReportTeamMeta | null; name: string }) {
  return team ? <PlayerTag team={team} name={name} /> : <>{name}</>;
}

export function StockWatchSection({ stock }: { stock: StockWatch }) {
  const { up, down } = stock;
  // 하한가 근거는 실제로 나쁜 값만 든다(stockWatch.ts의 StockDown 주석 - 0개 턴오버를
  // "그치며 고전"의 근거로 대던 실측 버그). 둘 다 없으면 야투 한 줄로만 말한다.
  const extras = [
    down.turnovers != null ? `턴오버 ${down.turnovers}개` : null,
    down.fouls != null ? `${down.fouls}반칙` : null,
  ].filter((x): x is string => x !== null);
  return (
    <ul className="report-list">
      <StockLi team={up.team}>
        📈 <b>상한가: <StockName team={up.team} name={up.name} /></b> - 오늘 <b>{up.pts}점 {up.reb}리바운드 {up.ast}어시스트</b>로 게임스코어 <b>{up.gameScore.toFixed(1)}</b>, 이 경기 양 팀 최고치입니다.
      </StockLi>
      <StockLi team={down.team}>
        📉 <b>하한가: <StockName team={down.team} name={down.name} /></b> - 오늘 <b>{down.pts}점 (야투 {down.fgm}/{down.fga})</b>{extras.length ? <>, <b>{extras.join(" · ")}</b></> : null}로 이 경기에서는 고전했습니다.
      </StockLi>
    </ul>
  );
}
