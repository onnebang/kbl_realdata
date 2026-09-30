import { eunNeun } from "@/lib/josa";
import { fmtDuration } from "@/lib/report/renderKit";
import {
  ENTRY_TOP_N,
  REGULAR_STARTER_SHARE_P50,
  type EntryPlayer,
  type EntryUsage,
  type EntryUsageSide,
} from "@/lib/report/entryUsage";
import { PlayerTag, ReportLi, TeamInk } from "./tags";

// 리포트 '엔트리 대비 실제 출전' - 계산은 lib/report/entryUsage.ts(그 파일 머리주석에 요청과
// 실측 사례, 그리고 **왜 이유를 추정하지 않는지**가 있다).
//
// 문구 원칙 둘:
//  1) 이유를 고르지 않는다. "부상이라서" "주전 보호라서" "시범경기라서" 모두 쓰지 않는다 -
//     출전 시간 배분은 감독 결정이고 기록에 이유가 남지 않는다.
//  2) 그렇다고 얼버무리지도 않는다. 누가 몇 분 뛰었는지는 확정된 사실이므로 그대로 적고,
//     "엔트리에 든 전력을 쓰지 못했다"까지는 분명히 말한다(요청의 결론).

/** "0분"과 "짧게 뛰다 빠졌다"는 다른 사건이라 다르게 적는다. */
function usageOf(p: EntryPlayer): string {
  if (p.neverEntered || p.onSec === 0) return "출전 없음";
  const base = fmtDuration(p.onSec);
  if (p.isStarter && p.leftForGoodAt) return `${base} (선발, ${p.leftForGoodAt} 이후 재투입 없음)`;
  if (p.leftForGoodAt) return `${base} (${p.leftForGoodAt} 이후 재투입 없음)`;
  return p.isStarter ? `${base} (선발)` : base;
}

function SideBlock({ side, lost }: { side: EntryUsageSide; lost: boolean }) {
  const { team, unusedTop, unusedTopSec, starterShare, absentBeforeEntry } = side;
  return (
    <ReportLi team={team}>
      <TeamInk team={team} />{eunNeun(team.name)} 엔트리 OVR 상위 {ENTRY_TOP_N}인 가운데{" "}
      <b>{unusedTop.length}명</b>이 사실상 뛰지 않았습니다
      {unusedTop.length > 1 ? <> (합계 <b>{fmtDuration(unusedTopSec)}</b>)</> : null}:
      <ul className="entry-usage-list">
        {unusedTop.map((p) => (
          <li key={p.pcode}>
            <PlayerTag team={team} name={p.name} />
            {p.ovr != null ? <span className="entry-usage-ovr">OVR {p.ovr}</span> : null}
            <span className="entry-usage-min">{usageOf(p)}</span>
          </li>
        ))}
      </ul>
      {starterShare != null && (
        <>
          선발 5인이 소화한 시간은 팀 전체의 <b>{Math.round(starterShare * 100)}%</b>입니다
          (정규시즌 중앙값 {Math.round(REGULAR_STARTER_SHARE_P50 * 100)}%).{" "}
        </>
      )}
      {absentBeforeEntry.length > 0 && (
        <>
          엔트리 발표 시점에 이미 빠져 있던 {absentBeforeEntry.join(" · ")}
          {eunNeun(absentBeforeEntry[absentBeforeEntry.length - 1])} 엔트리 기준 예측이 이미 반영한 결장자입니다.{" "}
        </>
      )}
      {lost ? <b>엔트리에 든 전력을 쓰지 못한 것이 예측이 깨진 이유의 하나입니다.</b> : null}
    </ReportLi>
  );
}

export function EntryUsageSection({ usage }: { usage: EntryUsage }) {
  const { sides, lineupProb, home, away, loserTcode } = usage;
  const homeIsLoser = loserTcode === home.tcode;
  const loser = homeIsLoser ? home : away;
  // 엔트리 기준 예측은 홈 기준 확률이라, 진 팀 쪽으로 돌려서 보여준다.
  const loserLineupPct = lineupProb == null ? null : Math.round((homeIsLoser ? lineupProb : 1 - lineupProb) * 100);

  return (
    <>
      <p className="report-text">
        엔트리 기준 예측{loserLineupPct != null ? <>(<TeamInk team={loser} /> {loserLineupPct}%)</> : null}은 발표된 12인이
        정규 로테이션대로 뛴다고 보고 계산한 값입니다. 실제 출전은 이렇게 갈렸습니다.
      </p>
      <ul className="report-list">
        {sides.map((s) => (
          <SideBlock key={s.team.tcode} side={s} lost={s.team.tcode === loserTcode} />
        ))}
      </ul>
      <p className="report-caveat">
        출전 시간 배분은 감독 결정이고, 그 이유는 기록에 남지 않습니다 - 부상·컨디션·일정·전략 등 어느 쪽인지 데이터로는
        구분할 수 없어서 이 리포트는 이유를 추정하지 않습니다. 위 숫자는 교체 기록으로 재구성한 실제 코트 체류 시간이고,
        OVR은 이 경기 시즌 기준입니다. &quot;사실상 뛰지 않았다&quot;의 기준은 {fmtDuration(360)} 미만입니다(정규시즌
        7,986 팀-경기에서 선발 최저 출전이 그보다 짧은 경우는 11.7%).
      </p>
    </>
  );
}
