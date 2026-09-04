import Link from "next/link";
import { displayTeamName } from "@/lib/teamNames";
import type { WinImpact, WinImpactMoment } from "@/lib/winImpact";
import styles from "./WinImpact.module.css";

// 결정적 순간 득점 · 커리어 - 요청: "클러치 프로필에서, 승률에 + 되는 행동이 재미있는데,
// 클러치가 아니더라도, 승률 올랐던 내용들에 대해서 표시".
//
// 바로 위 클러치 패널은 경기의 마지막 5분·5점차 안만 본다. 이 패널이 그 바깥을 채운다.
// 실측이 정한 세 가지 설계(자세한 근거는 lib/winImpact.ts 상단):
//  1. 클러치 순간과 클러치 밖 순간을 **나란히** 놓는다. 한 목록에 섞어 정렬하면 주전은
//     상위 10개가 전부 클러치라 요청한 "클러치가 아니더라도"가 화면에서 사라진다.
//  2. 헤드라인은 합계가 아니라 가비지타임 할인이다. 이 지표가 원점수에 더하는 유일한 정보다.
//  3. 이름을 "승률 기여"라 하지 않는다. 득점 이벤트에만 붙고 실패에 페널티가 없어서
//     구조적으로 음수가 안 나온다. 부호가 있는 값은 온코트 양면 WPA로 따로 적는다.
//
// 서버 컴포넌트다. 접기는 <details>, 막대는 CSS 폭이고 클라이언트 JS가 없다.

const pctP = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%p`;
const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;

function periodOf(m: WinImpactMoment): string {
  return m.quarter.startsWith("X") ? `연장${m.quarter.slice(1)}` : m.quarter;
}

function MomentCard({ m, teamName }: { m: WinImpactMoment; teamName: string }) {
  const clock = `${String(m.clockMin).padStart(2, "0")}:${String(m.clockSec).padStart(2, "0")}`;
  return (
    <Link href={`/games/${m.gmkey}`} className={styles.card}>
      <span className={styles.wpa}>{pctP(m.wpa)}</span>
      <span className={styles.body}>
        {/* margin은 '이 득점 직전' 점수차다 - 옆의 점수는 득점 반영 후라서 둘이 다르다. */}
        {periodOf(m)} {clock} 남기고 <b>{m.actionLabel}</b> ({m.homeScore}-{m.awayScore}
        {m.clutch ? "" : ` · 직전 ${m.margin}점차`})
        <br />
        <span className={styles.when}>
          {m.gameDate} vs {teamName}
        </span>
      </span>
    </Link>
  );
}

export function WinImpactPanel({
  impact,
  teamNameByTcode,
}: {
  impact: WinImpact;
  /** tcode -> 팀 이름(원본). 시즌 기준 표기는 displayTeamName이 붙인다. */
  teamNameByTcode: Map<string, string>;
}) {
  const oppName = (m: WinImpactMoment) => {
    const opp = m.tcode === m.homeTcode ? m.awayTcode : m.homeTcode;
    return displayTeamName(opp, teamNameByTcode.get(opp) ?? opp, m.seasonName);
  };

  const total = Math.abs(impact.wpaTotal);
  const openPct = total > 0 ? Math.max(0, Math.min(100, (Math.abs(impact.wpaOpen) / total) * 100)) : 0;
  const clutchPct = 100 - openPct;
  const maxMargin = Math.max(1e-6, ...impact.byMargin.map((b) => Math.abs(b.wpa)));

  const gp = impact.garbagePtsShare;
  const gw = impact.garbageWpaShare;
  const hasGarbage = gp != null && gw != null && gp > 0.005;

  return (
    <>
      <p className={styles.lede}>
        {impact.openShare != null ? (
          <>
            커리어 {impact.pts.toLocaleString()}득점 중 승률을 올린 몫의 <b>{Math.round(impact.openShare * 100)}%</b>가{" "}
            <b>클러치 밖</b>에서 나왔습니다. 위 클러치 패널이 보는 구간은 득점 {impact.scores.toLocaleString()}개 중{" "}
            {impact.scoresClutch.toLocaleString()}개({Math.round((impact.scoresClutch / Math.max(1, impact.scores)) * 100)}%)
            뿐입니다.
          </>
        ) : (
          <>표본이 작아 클러치 안팎 비중을 문장으로 만들지 않습니다(득점 이벤트 {impact.scores.toLocaleString()}개).</>
        )}
      </p>

      <div className={styles.splitBar}>
        <div className={`${styles.splitSeg} ${styles.segOutside}`} style={{ width: `${openPct}%` }}>
          {openPct >= 18 ? `클러치 밖 ${Math.round(openPct)}%` : ""}
        </div>
        <div className={`${styles.splitSeg} ${styles.segClutch}`} style={{ width: `${clutchPct}%` }}>
          {clutchPct >= 18 ? `클러치 ${Math.round(clutchPct)}%` : ""}
        </div>
      </div>
      <div className={styles.splitLegend}>
        <span>
          <span className={styles.swatch} style={{ background: "var(--away)" }} />
          클러치 밖 {signed(impact.wpaOpen)} · {(impact.pts - impact.ptsClutch).toLocaleString()}점
        </span>
        <span>
          <span className={styles.swatch} style={{ background: "var(--gold)" }} />
          클러치 {signed(impact.wpaClutch)} · {impact.ptsClutch.toLocaleString()}점
        </span>
        <span>{impact.games.toLocaleString()}경기</span>
      </div>

      {/* 두 목록을 나란히. 왼쪽만 있으면 요청("클러치가 아니더라도")이 화면에서 사라진다. */}
      <div className={styles.momentCols}>
        <div>
          <div className={styles.momentsHead}>클러치 밖 최고 순간</div>
          {impact.momentsOpen.length ? (
            impact.momentsOpen.map((m) => (
              <MomentCard key={`${m.gmkey}-${m.quarter}-${m.clockMin}-${m.clockSec}`} m={m} teamName={oppName(m)} />
            ))
          ) : (
            <div className="empty-note">클러치 밖 득점 기록이 없습니다.</div>
          )}
        </div>
        <div>
          <div className={styles.momentsHead}>클러치 최고 순간</div>
          {impact.momentsClutch.length ? (
            impact.momentsClutch.map((m) => (
              <MomentCard key={`${m.gmkey}-${m.quarter}-${m.clockMin}-${m.clockSec}`} m={m} teamName={oppName(m)} />
            ))
          ) : (
            <div className="empty-note">클러치 득점 기록이 없습니다.</div>
          )}
        </div>
      </div>

      {impact.byMargin.length > 0 && (
        <>
          <div className={styles.momentsHead}>점수차 구간별 · 같은 1점이 같은 값이 아니다</div>
          {impact.byMargin.map((b) => (
            <div className={styles.typeRow} key={b.key}>
              <span className={styles.typeLabel}>{b.label}</span>
              <span className={styles.typeTrack}>
                <span className={styles.typeFill} style={{ width: `${(Math.abs(b.wpa) / maxMargin) * 100}%` }} />
              </span>
              <span className={styles.typeVal}>
                <b>{signed(b.wpa)}</b> · {b.pts.toLocaleString()}점
                {impact.pts > 0 ? ` (${Math.round((b.pts / impact.pts) * 100)}%)` : ""}
              </span>
            </div>
          ))}
          {hasGarbage && (
            <div className={styles.callout}>
              21점차 이상에서 <b>{impact.pts.toLocaleString()}점 중 {Math.round(gp * 100)}%</b>를 넣었지만, 승률로는{" "}
              <b>{(gw * 100).toFixed(1)}%</b>밖에 안 됩니다. 이 <b>가비지타임 할인</b>이 이 지표가 원점수에 더하는 거의
              유일한 정보입니다 — 실제로 커리어 합계와 커리어 득점의 상관은 0.997(R²=0.994)입니다.
            </div>
          )}
        </>
      )}

      <div className={styles.note}>
        <b>이 숫자가 보는 것과 못 보는 것.</b> 승률은 (점수차, 잔여시간, 시즌 전력)만 보는 모델이 매기므로{" "}
        <b>점수가 움직일 때만 값이 움직입니다.</b> 그래서 위 목록에는 득점만 올라옵니다 — 어시스트·리바운드·스틸·블록·수비는
        커리어 합이 전부 0 근처입니다(리그 전체: 어시스트 +1.2, 스틸 −0.1, 블록 +0.6). <b>그 일을 안 했다는 뜻이 아니라 이
        지표가 그쪽을 못 본다는 뜻입니다.</b> 슛 실패에도 페널티가 없어 이 값은 구조적으로 음수가 나오지 않습니다(리그에서
        커리어 값이 음수인 선수는 사실상 없습니다). 그래서 &quot;승률 기여&quot;가 아니라 <b>&quot;결정적 순간 득점&quot;</b>
        이라고 부릅니다.
        {impact.onCourtWpa != null && (
          <>
            {" "}
            부호가 실제로 있는 값은 <b>온코트 양면 WPA</b>입니다 — 이 선수가 코트 위에 있는 동안 팀 승률이 오르내린 전부를
            더한 값으로, 커리어 <b>{signed(impact.onCourtWpa, 1)}</b>
            {impact.onCourtPos != null && impact.onCourtNeg != null
              ? ` (올린 쪽 ${signed(impact.onCourtPos, 1)} / 내린 쪽 ${signed(impact.onCourtNeg, 1)})`
              : ""}
            입니다. 다만 이건 팀 전체의 값이라 개인 공로가 아닙니다.
          </>
        )}
      </div>
    </>
  );
}
