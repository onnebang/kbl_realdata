import { iGa } from "@/lib/josa";
import type { FourFactors } from "@/lib/report/fourFactors";
import { TeamInk } from "./tags";
import { TeamSplitBar } from "./TeamSplitBar";

// 리포트 '네 가지 요인 & 득점 출처' - 계산은 lib/report/fourFactors.ts(그 파일 머리주석에 왜
// 이 섹션이 생겼는지 실측 근거가 있다: 자유투로 +10점이 난 경기의 리포트에 자유투가 한 줄도
// 없었다).
//
// 막대는 화면 아래 '팀 스탯' 블록과 **같은** TeamSplitBar를 쓴다 - 같은 페이지에서 같은 뜻의
// 막대가 두 종류로 보이지 않게. 그룹 제목도 새 CSS 없이 .report-section-title을 그대로 쓴다.

const signedPts = (v: number) => (v > 0 ? `+${v}점` : `${v}점`);

export function FourFactorsSection({ ff }: { ff: FourFactors }) {
  const { home, away, factors, scoring, decisive, conceded, margin, winnerIsHome, ft } = ff;
  const hColor = home.color ?? "#888888";
  const aColor = away.color ?? "#888888";
  const winner = winnerIsHome ? home : away;
  const loser = winnerIsHome ? away : home;
  // 자유투가 승부를 갈랐으면 시도 수와 파울을 근거로 같이 댄다(그게 자유투 득점차의 원인이다).
  const ftDecided = decisive.label === "자유투 득점";
  const winFta = winnerIsHome ? ft.homeFta : ft.awayFta;
  const loseFta = winnerIsHome ? ft.awayFta : ft.homeFta;
  const winFouls = winnerIsHome ? ft.homeFouls : ft.awayFouls;
  const loseFouls = winnerIsHome ? ft.awayFouls : ft.homeFouls;

  return (
    <>
      <p className="report-text">
        <TeamInk team={winner} />{iGa(winner.name)} 가장 크게 앞선 항목은 <b>{decisive.label} {signedPts(decisive.pts)}</b>
        {decisive.pts > margin ? <> - 최종 마진({margin}점)보다 큽니다.</> : <>입니다(최종 마진 {margin}점).</>}
        {conceded.length > 0 ? (
          <> 반대로 {conceded.map((c) => `${c.label}에서는 ${Math.abs(c.pts)}점`).join(", ")} 밀렸습니다.</>
        ) : (
          <> 세 가지 득점 출처 모두에서 앞섰습니다.</>
        )}
        {ftDecided ? (
          <> 자유투 시도가 {winFta}회 대 {loseFta}회였고, 파울은 <TeamInk team={loser} /> {loseFouls}개 · <TeamInk team={winner} /> {winFouls}개였습니다.</>
        ) : null}
      </p>

      <div className="ts-group">
        <div className="report-section-title">
          득점 출처 · 합이 최종 점수 (왼쪽 <TeamInk team={home} /> 홈 / 오른쪽 <TeamInk team={away} /> 원정)
        </div>
        {scoring.map((s) => (
          <TeamSplitBar
            key={s.label}
            label={s.label}
            hVal={s.home}
            aVal={s.away}
            hDisp={`${s.home}점`}
            aDisp={`${s.away}점`}
            hColor={hColor}
            aColor={aColor}
          />
        ))}
      </div>

      <div className="ts-group">
        <div className="report-section-title">네 가지 요인 (Four Factors)</div>
        {factors.map((f) => (
          <TeamSplitBar
            key={f.label}
            label={f.label}
            hVal={f.homeBar}
            aVal={f.awayBar}
            hDisp={f.homeDisp}
            aDisp={f.awayDisp}
            hColor={hColor}
            aColor={aColor}
          />
        ))}
      </div>

      <p className="report-caveat">
        eFG% = (야투성공 + 0.5×3점성공) ÷ 야투시도. TOV% = 턴오버 ÷ (야투시도 + 0.44×자유투시도 + 턴오버) -
        낮을수록 좋은 항목이라 <b>막대만 뒤집어 그렸고 숫자는 실제 비율</b>입니다. ORB% = 공격리바운드 ÷ (내 공격리바운드 + 상대 수비리바운드),
        중계 이벤트로 직접 셉니다. 자유투 의존도 = 자유투 성공 ÷ 야투시도. 한 경기 값이라 시즌 성향은 아닙니다.
      </p>
    </>
  );
}
