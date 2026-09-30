import { iGa, waGwa } from "@/lib/josa";
import { fmtDuration } from "@/lib/report/renderKit";
import type { AceDuel } from "@/lib/report/aceDuel";
import { TeamInk } from "./tags";

// AI 코트사이드 리포트 8.9 "에이스 정면승부" - 기존 문자열 조립(lib/postgameReport.ts가
// `html: '<p class="report-text">...'`로 만들어 dangerouslySetInnerHTML로 렌더)을 선언적
// 컴포넌트로 옮긴 것. 옮길 당시에는 렌더 결과가 기존과 바이트 단위로 같았다(리팩터링과 문구
// 변경을 섞지 않으려고). 호각세 문장은 지금도 그대로고, 우열이 갈린 문장만 아래 이유로 한 번
// 손봤다 - AceDuelSection.test.tsx가 세 문장 모두 고정한다.
//
// 홈/원정 문구 통일(사용자 확인: 비대칭은 의도가 아니었음): 원래 홈이 이기면 "에이스 **맞대결**
// 구간 … 자존심 싸움에서 판정승", 원정이 이기면 "에이스 **정면승부** 구간 … **완승**"으로 갈렸다.
// 같은 사건을 이긴 쪽에 따라 다르게 부르던 것이라 한 문장으로 합쳤다:
//  - "정면승부": 섹션 제목("에이스 정면승부 성적표")과 같은 말을 쓴다.
//  - "판정승": 임계값이 ±5점(aceDuel.ts의 DUEL_DECISIVE_PTS)이다. 5점 차를 "완승"이라고 하면
//    데이터보다 센 주장이 된다 - 점수로 갈린 우열이니 판정승이 맞는 말이고 🥊와도 맞는다.
// 합치고 나니 두 분기가 "누가 이겼나"만 달라서 한 분기로 접혔다.
//
// 왜 컴포넌트인가: 이 파일은 escHtml()을 부르지 않는다. 선수/팀 이름은 Supabase에서 온
// 값인데, 문자열 조립 쪽에서는 태그를 만드는 자리마다 escHtml()을 잊지 않는 게 사람 몫이고
// (실제로 report-text 안 순수 텍스트 보간에는 안 붙어 있는 자리가 있다), JSX에서는 React가
// 항상 이스케이프한다. 구조도 타입으로 고정돼서 <b> 짝이 안 맞는 HTML을 만들 수가 없다.

// TeamInk는 ./tags.tsx로 옮겼다(두 번째 섹션 UnsungHeroSection도 같은 태그를 쓴다 - 섹션
// 파일에서 공유 태그를 import하는 방향이 거꾸로라서).

export function AceDuelSection({ duel }: { duel: AceDuel }) {
  const { home, away, seconds, margin, verdict } = duel;
  // 숫자 뒤에 조사를 붙이지 않는다 - josa()는 마지막 글자가 한글이 아니면 받침 없는 쪽으로
  // 폴백하므로 "50-46는"처럼 틀린 조사가 나온다(46은 '사십육'이라 '은'이어야 한다).
  const caveat = (
    <p className="report-caveat">두 선수 개인 득점이 아니라 둘이 함께 코트에 있던 시간의 팀 득실입니다.</p>
  );
  if (verdict !== "even") {
    const [win, lose] = verdict === "home" ? [home, away] : [away, home];
    return (
      <>
        <p className="report-text">
          🥊 <TeamInk team={win.team} />의 <b>{win.star}</b>{iGa(win.star)} <b>{lose.star}</b>{waGwa(lose.star)}의 에이스 정면승부 구간({fmtDuration(seconds)})에서 팀을 <b>+{Math.abs(margin)}점</b>({win.pts}-{lose.pts}) 우위로 이끌며 판정승을 거두었습니다.
        </p>
        {caveat}
      </>
    );
  }
  return (
    <>
      <p className="report-text">
        🥊 양 팀의 에이스 <b>{home.star}</b>{waGwa(home.star)} <b>{away.star}</b>{iGa(away.star)} 코트에 동시 출전한 {fmtDuration(seconds)} 동안 팀 스코어 <b>{home.pts}-{away.pts}</b>, 우열을 가릴 만한 차이가 나지 않았습니다.
      </p>
      {caveat}
    </>
  );
}
