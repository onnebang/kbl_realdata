import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { PRESEASON_SEASON, shortSeason } from "@/lib/preseason";
import { PROVEN_MINUTES, type DepartureReport, type TeamDeparture } from "@/lib/departureImpact";
import panel from "@/app/preseason/preseason.module.css";
import styles from "./PreseasonShift.module.css";

// 요청: "해당 인원들을 제외하고! ... 시즌 리포트와 예상을 적어줘야 할 것 같아"
//
// ── 이 섹션이 하는 말과 하지 않는 말 ────────────────────────────────────────────────
// 하는 말: "이 선수들이 지난 시즌 그 팀 합계에서 이만큼을 차지했다." 나눗셈이라 사실이다.
// 하지 않는 말: "그래서 몇 승을 잃는다." KBL 15시즌(137개 팀-시즌 전환)을 실측한 결과,
//   빠진 출전시간 비중으로 다음 시즌 득실차 변화를 설명한 R²는 0.001이었다. PER 기반
//   손실가치를 써도 0.071이고, 최적 축소를 해도 "작년과 같다고 찍기"를 이기지 못했다.
//   실제로 이 13명에게 승수 환산을 적용하면 전원의 PER이 리그평균 아래라 **10팀 전부가
//   이득을 본다**는 결과가 나온다 - 산출식이 틀렸다는 증거다.
// 그래서 크기는 3단계 범주로만 말한다(순서는 주장하고 크기는 주장하지 않는다).
//
// ── 총량보다 자리 ─────────────────────────────────────────────────────────────
// 팀 합계만 보면 가스공사가 1위지만, 같은 포지션 안에서 보면 순서가 뒤집힌다. KCC는 팀
// 출전시간의 14.2%를 잃었는데 그게 포워드 한 자리에 몰려 포워드 출전시간의 48%였다.
// 총량은 "얼마나", 포지션은 "메울 사람이 있나"를 말한다.

const TIER_BIG = 0.1;
const TIER_MID = 0.05;

function tierOf(share: number): { label: string; cls: string } {
  if (share >= TIER_BIG) return { label: "타격 큼", cls: styles.tierBig };
  if (share >= TIER_MID) return { label: "타격 있음", cls: styles.tierMid };
  return { label: "영향 미미", cls: styles.tierNone };
}

const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;

function POS_LABEL(pos: string): string {
  return pos === "GD" ? "가드" : pos === "FD" ? "포워드" : pos === "C" ? "센터" : pos;
}

function LossRow({ t, max }: { t: TeamDeparture; max: number }) {
  const tier = tierOf(t.share.minutes);
  const names = t.players.map((p) => p.name).join(" · ");
  return (
    <Link href={`/teams/${t.team.tcode}?season=${PRESEASON_SEASON}`} className={styles.lossRow}>
      <div className={styles.lossTeam}>
        <TeamBadge team={t.team} size={20} />
        <span className={styles.lossTeamName}>{t.team.name}</span>
      </div>
      <div className={styles.lossTrack}>
        <div
          className={styles.lossFill}
          style={{ width: `${max > 0 ? (t.share.minutes / max) * 100 : 0}%`, background: t.team.color }}
        />
        <div className={styles.lossNames}>{names || "확정 결장 없음"}</div>
      </div>
      <div className={styles.lossNum}>
        {t.players.length ? pct1(t.share.minutes) : "-"}
        <span className={`${styles.tier} ${tier.cls}`}>{t.players.length ? tier.label : "없음"}</span>
      </div>
      <div className={`${styles.lossNum} ${styles.lossNumMuted}`}>{t.players.length ? pct1(t.share.pts) : "-"}</div>
      <div className={`${styles.lossNum} ${styles.lossNumMuted}`}>{t.starts > 0 ? pct1(t.startShare) : "-"}</div>
    </Link>
  );
}

export function DepartureImpact({ report, num }: { report: DepartureReport; num: number }) {
  const prev = shortSeason(report.prevSeason);
  const cur = shortSeason(report.season);
  const withLoss = report.teams.filter((t) => t.players.length > 0);
  const max = Math.max(...report.teams.map((t) => t.share.minutes), 0.01);
  const top = report.teams[0];
  const reasonText = [
    report.reasonCounts.military && `군 입대 ${report.reasonCounts.military}`,
    report.reasonCounts.overseas && `해외 진출 ${report.reasonCounts.overseas}`,
    report.reasonCounts.unsigned && `FA 미계약 ${report.reasonCounts.unsigned}`,
    report.reasonCounts.retired && `은퇴 ${report.reasonCounts.retired}`,
  ]
    .filter(Boolean)
    .join(" · ");

  // 자리 구멍 - 같은 포지션 분류 안에서 30% 이상 빠진 팀만. 총량 표가 이미 말한 것을
  // 반복하지 않고, 총량과 순서가 달라지는 팀만 남긴다.
  const holes = report.teams
    .filter((t) => t.topPos && t.topPos.minuteShare >= 0.3)
    .sort((a, b) => (b.topPos?.minuteShare ?? 0) - (a.topPos?.minuteShare ?? 0));
  const notPlayed = report.teams.filter((t) => t.zeroKind === "notPlayed");
  const thin = [...report.teams].sort((a, b) => a.provenN - b.provenN).slice(0, 3);

  return (
    <div className={panel.panel}>
      <div className={panel.panelTitle}>
        <span className={panel.sectionNum}>{num}</span>
        {cur} 확정 결장 {report.players.length}명 - 지난 시즌 이만큼이 빠진다
      </div>
      <p className={panel.panelLede}>
        군 입대·해외 진출·미계약으로 {cur} 시즌에 뛰지 않는 것이 확인된 {report.players.length}명({reasonText})이 {prev} 정규시즌에 각 팀에서
        차지하던 몫입니다. KBL 등록 명부에는 군 복무 중인 선수도 그대로 남아 있어 명부만으로는 셀 수 없는 값이라, 사람이 확인한 명단을 따로
        겹쳐 계산했습니다.
      </p>

      <div className={styles.figureRow}>
        <div className={styles.figure}>
          <div className={styles.figureLabel}>결장 확정</div>
          <div className={styles.figureVal}>
            {report.players.length}
            <span className={styles.figureUnit}>명</span>
          </div>
          <div className={styles.figureSub}>{reasonText}. 2026-05-18 입대 10명은 2027-11-17 전역 예정이라 이번 시즌 전체를 빠집니다.</div>
        </div>
        <div className={styles.figure}>
          <div className={styles.figureLabel}>리그 전체 출전시간 중</div>
          <div className={styles.figureVal}>
            {(report.leagueShare.minutes * 100).toFixed(1)}
            <span className={styles.figureUnit}>%</span>
          </div>
          <div className={styles.figureSub}>
            리그 전체로는 작지만 두 팀에 몰려 있습니다 - 빠진 출전시간의 {Math.round(report.topTwoConcentration * 100)}%가 상위 두 팀
            것입니다.
          </div>
        </div>
        {top && top.players.length > 0 && (
          <div className={styles.figure}>
            <div className={styles.figureLabel}>가장 많이 빠진 팀</div>
            <div className={styles.figureVal}>
              {(top.share.minutes * 100).toFixed(1)}
              <span className={styles.figureUnit}>%</span>
            </div>
            <div className={styles.figureSub}>
              {top.team.name} · {top.players.map((p) => p.name).join(", ")} · {prev} 팀 출전시간 기준
            </div>
          </div>
        )}
      </div>

      <div className={styles.lossGrid}>
        <div className={`${styles.lossRow} ${styles.lossHead}`}>
          <div>팀</div>
          <div>결장 선수 (막대 = 팀 출전시간 몫)</div>
          <div style={{ textAlign: "right" }}>출전시간</div>
          <div style={{ textAlign: "right" }}>득점</div>
          <div style={{ textAlign: "right" }}>선발</div>
        </div>
        {report.teams.map((t) => (
          <LossRow key={t.team.tcode} t={t} max={max} />
        ))}
      </div>

      {holes.length > 0 && (
        <>
          <div className={panel.panelTitle} style={{ marginTop: 16 }}>
            총량보다 자리 - 같은 포지션 안에서 빈 몫
          </div>
          <div className={styles.holeList}>
            {holes.map((t) => (
              <div key={t.team.tcode} className={styles.holeItem}>
                <span className={styles.holeTeam}>{t.team.name}</span>
                <span>
                  {POS_LABEL(t.topPos!.pos)} 출전시간의 <span className={styles.holeVal}>{pct1(t.topPos!.minuteShare)}</span>, 득점의{" "}
                  <span className={styles.holeVal}>{pct1(t.topPos!.ptsShare)}</span>가 한꺼번에 빠집니다 (
                  {Math.round(t.topPos!.lostMinutes)}분 / {Math.round(t.topPos!.posMinutes)}분). 팀 전체로는 {pct1(t.share.minutes)}입니다.
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className={panel.note}>
        <b>이 표는 &quot;얼마나 빠졌는가&quot;이지 &quot;몇 승을 잃는가&quot;가 아닙니다.</b> KBL 15시즌 137개 팀-시즌 전환을 실측한 결과,
        이탈 선수의 출전시간 비중으로 다음 시즌 팀 득실차 변화를 설명한 설명력은 0.1% 미만이었고(PER 기반 손실가치를 써도 7% 미만), 어떤 축소
        계수를 써도 &quot;작년과 같다&quot;고 찍는 것보다 나은 예측을 만들지 못했습니다. 그래서 크기는 세 범주(타격 큼 {TIER_BIG * 100}% 이상 ·
        타격 있음 {TIER_MID * 100}~{TIER_BIG * 100}% · 영향 미미 {TIER_MID * 100}% 미만)로만 표시하고, 승수 환산은 하지 않습니다.
      </div>
      <div className={panel.note}>
        분모는 {prev} 정규시즌 팀 합계입니다(플레이오프는 팀마다 경기 수가 달라 제외). 선발은 팀 경기 수 × 5 슬롯 대비 결장 선수의 선발 횟수.
        {notPlayed.length > 0 && (
          <>
            {" "}
            {notPlayed.map((t) => t.team.abbr).join(", ")}의 0.0%는 &quot;잃은 것이 없다&quot;가 아니라 &quot;{prev} 출전 기록이 없어 이
            방식으로는 잴 수 없다&quot;는 뜻입니다(
            {notPlayed
              .flatMap((t) => t.players.map((p) => p.name))
              .join(", ")}
            ).
          </>
        )}{" "}
        결장 확정 선수를 뺀 {cur} 등록 인원과 그중 {prev}에 {PROVEN_MINUTES}분 이상 뛴 인원:{" "}
        {thin.map((t) => `${t.team.abbr} ${t.rosterN}명(검증 ${t.provenN})`).join(" · ")} 순으로 얇습니다.
      </div>
      {withLoss.length === 0 && <div className="empty-note">확정 결장 명단이 아직 입력되지 않았습니다.</div>}
    </div>
  );
}
