import type { ReactNode } from "react";
import { teamInkStyle } from "@/lib/teamAccent";
import { eunNeun, iGa } from "@/lib/josa";
import { fmtDuration, type ReportTeamMeta } from "@/lib/report/renderKit";
import type { AceDuel } from "@/lib/report/aceDuel";

// AI 코트사이드 리포트 8.9 "에이스 정면승부" - 기존 문자열 조립(lib/postgameReport.ts가
// `html: '<p class="report-text">...'`로 만들어 dangerouslySetInnerHTML로 렌더)을 선언적
// 컴포넌트로 옮긴 것. 렌더 결과는 기존과 **바이트 단위로 같다**(AceDuelSection.test.tsx가
// 고정 - 리팩터링과 문구 변경을 섞지 않기 위해 일부러 한 글자도 바꾸지 않았다).
//
// 왜 컴포넌트인가: 이 파일은 escHtml()을 부르지 않는다. 선수/팀 이름은 Supabase에서 온
// 값인데, 문자열 조립 쪽에서는 태그를 만드는 자리마다 escHtml()을 잊지 않는 게 사람 몫이고
// (실제로 report-text 안 순수 텍스트 보간에는 안 붙어 있는 자리가 있다), JSX에서는 React가
// 항상 이스케이프한다. 구조도 타입으로 고정돼서 <b> 짝이 안 맞는 HTML을 만들 수가 없다.

/**
 * 문장 속 팀 이름 - 칩 없이 색만(팀명 자체가 이미 텍스트 단서다). renderKit의 teamTag()와
 * 같은 마크업이고, 서버가 테마를 모르므로 --ti-l/--ti-d 두 색을 같이 내려보내 CSS
 * 미디어쿼리가 고르는 규약도 그대로다(lib/teamAccent.ts의 teamInkStyle - 이미 있던 것 재사용).
 */
export function TeamInk({ team, children }: { team: ReportTeamMeta; children?: ReactNode }) {
  return <b className="report-team" style={teamInkStyle(team.color)}>{children ?? team.name}</b>;
}

export function AceDuelSection({ duel }: { duel: AceDuel }) {
  const { home, away, seconds, margin, verdict } = duel;
  if (verdict === "home") {
    return (
      <p className="report-text">
        🥊 <TeamInk team={home.team} />{iGa(home.team.name)} <b>{home.star}</b>{eunNeun(home.star)} <b>{away.star}</b>와의 에이스 맞대결 구간({fmtDuration(seconds)})에서 팀을 <b>+{margin}점</b>({home.pts}-{away.pts}) 우위로 이끌며 자존심 싸움에서 판정승을 거두었습니다.
      </p>
    );
  }
  if (verdict === "away") {
    return (
      <p className="report-text">
        🥊 <TeamInk team={away.team} />{iGa(away.team.name)} <b>{away.star}</b>{eunNeun(away.star)} <b>{home.star}</b>와의 에이스 정면승부 구간({fmtDuration(seconds)})에서 팀을 <b>+{Math.abs(margin)}점</b>({away.pts}-{home.pts}) 우위로 이끌며 완승했습니다.
      </p>
    );
  }
  return (
    <p className="report-text">
      🥊 양 팀의 에이스 <b>{home.star}</b>와 <b>{away.star}</b>{eunNeun(away.star)} 코트에 동시 출전한 {fmtDuration(seconds)} 동안 스코어 <b>{home.pts}-{away.pts}</b>로 우열을 가리기 힘든 호각세를 보였습니다.
    </p>
  );
}
