import { iGa } from "@/lib/josa";
import { VERDICT_TEXT, fmtProbPct, gradePredictions } from "@/lib/predictionVerdict";
import type { AuditCheck, PredictionAudit } from "@/lib/report/predictionAudit";
import { TeamInk } from "./tags";

// 리포트 '예측 오차 진단' - 계산은 lib/report/predictionAudit.ts(그 파일 머리주석에 왜 이
// 섹션이 생겼는지와 실측 근거가 있다).
//
// 차트는 서버에서 인라인 SVG로 그린다(클라이언트 JS 없음 - 이 프로젝트 컨벤션). 좌표 규칙은
// components/GameReplay.tsx의 WinProbLiveChart와 같게 맞췄다(W=640/H=150, y=(1-p)*H,
// x=이벤트 순서) - 같은 페이지의 두 승률 차트가 서로 다른 모양으로 읽히면 안 된다.

const W = 640;
const H = 150;

const path = (pts: [number, number][]) =>
  pts.length ? "M " + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ") : "";

/** %p 표기. 부호를 항상 붙여서 방향이 보이게 한다. */
const pp = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%p`;

function CheckRow({ c }: { c: AuditCheck }) {
  return (
    <tr className={c.flipped ? "audit-flip" : undefined}>
      <th scope="row">{c.label}</th>
      <td>{pp(c.expectedEdge)}</td>
      <td>{pp(c.actualEdge)}</td>
      <td>{c.kind === "flipped" ? "반대로 나옴" : c.kind === "negligible" ? "차이 미미" : "방향 일치"}</td>
    </tr>
  );
}

export function PredictionAuditSection({ audit }: { audit: PredictionAudit }) {
  const { home, away, preProb, entryProb, homeWon, trace, quarterTicks, homeAheadShare, homeMaxProb, objMaxProb, checks, modelSplit } = audit;
  const hColor = home.color ?? "#888888";
  const winner = homeWon ? home : away;

  const yOf = (p: number) => (1 - p) * H;
  const xOf = (x: number) => x * W;
  const actualPts = trace.map((t) => [xOf(t.x), yOf(t.actual)] as [number, number]);
  const objPts = trace.filter((t) => t.objective != null).map((t) => [xOf(t.x), yOf(t.objective as number)] as [number, number]);

  const flips = checks.filter((c) => c.flipped);
  // "한 번도 앞선 적이 없다"는 강한 문장이라 실제로 0일 때만 쓴다.
  const neverAhead = homeAheadShare === 0;
  const aheadPct = Math.round(homeAheadShare * 100);
  // 최고치는 **반올림하면 안 된다**: 실측 S49G14N4의 최고치가 0.4977이어서 그냥 반올림하면
  // "한 번도 50%를 넘지 않았습니다(최고 50%)"라는 자기모순 문장이 나온다. 50%에 가까우면
  // 소수 첫째 자리까지 보여 문장과 숫자가 어긋나지 않게 한다.
  const maxDisp = fmtProbPct(homeMaxProb, Math.abs(homeMaxProb - 0.5) < 0.005);
  // 점수판만 보면 앞섰는데 전력 보정 승률은 끝까지 50%를 못 넘은 경우(실측 S49G14N4).
  const objCrossedButActualDidNot = neverAhead && objMaxProb != null && objMaxProb > 0.5;
  const graded = gradePredictions(preProb, entryProb, homeWon);
  // 두 예측의 판정이 갈린 경기는 그 사실 자체가 정보다(오픈매치 10경기 중 5경기가 그랬다).
  const verdictsDiffer = graded.length > 1 && graded[0].verdict !== graded[1].verdict;

  return (
    <>
      {/* 경기 전 예측이 두 개(시즌 기준 / 엔트리 반영)라 둘 다 채점한다 - 예전엔 시즌 기준만
          채점해서 엔트리로 맞춘 경기가 "빗나감"으로 보였다(제보 2026-10-01). */}
      <ul className="report-list">
        {graded.map((g) => (
          <li key={g.label}>
            {g.label} <b>{VERDICT_TEXT[g.verdict]}</b> - <TeamInk team={home} /> {g.homePct}% : <TeamInk team={away} /> {g.awayPct}%
            {g.verdict === "coinflip" ? <> (어느 쪽도 우세라고 부를 수 없는 차이)</> : null}
          </li>
        ))}
      </ul>
      <p className="report-text">
        경기 중 <TeamInk team={home} /> 승률은{" "}
        {neverAhead ? (
          <><b>한 번도 50%를 넘지 않았습니다</b>(최고 {maxDisp}%)</>
        ) : (
          <>전체 이벤트의 <b>{aheadPct}%</b> 구간에서 50%를 넘었습니다(최고 {maxDisp}%)</>
        )}
        . 최종 승자는 <TeamInk team={winner} />입니다.
      </p>

      <div className="audit-chart">
        <div className="report-section-title">
          승률 궤적 — 굵은 선 <TeamInk team={home} /> 승률, 옅은 선은 점수·시간만 본 값
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="audit-chart-svg" role="img" aria-label={`${home.name} 승률 궤적`}>
          {/* 50% 기준선 - 이 선을 넘었는지가 '역전했는가'다. */}
          <line x1="0" y1={H / 2} x2={W} y2={H / 2} className="audit-mid" />
          {quarterTicks.map((t) => (
            <line key={t.q} x1={xOf(t.x)} y1="0" x2={xOf(t.x)} y2={H} className="audit-tick" />
          ))}
          {objPts.length > 1 && <path d={path(objPts)} className="audit-line-obj" />}
          <path d={path(actualPts)} className="audit-line-actual" style={{ stroke: hColor }} />
        </svg>
        <div className="audit-chart-axis">
          {quarterTicks.map((t) => (
            <span key={t.q} style={{ left: `${t.x * 100}%` }}>
              {t.q}
            </span>
          ))}
        </div>
      </div>
      {/* 두 선이 50% 선을 두고 갈린 경우 - 이게 "예측이 어긋났다"의 가장 구체적인 모습이다.
          점수판만 보면 이 팀이 앞선 순간이 있었는데, 시즌 전력 보정이 그걸 끝까지 눌렀다는 뜻. */}
      {objCrossedButActualDidNot && (
        <p className="report-text">
          두 선이 갈린 지점이 이 경기의 핵심입니다: 점수와 남은 시간만 보면 <TeamInk team={home} />{iGa(home.name)} 한때{" "}
          <b>{Math.round((objMaxProb as number) * 100)}%</b>까지 앞섰지만, 시즌 전력을 반영한 승률은 끝까지 50%를 넘지 못했습니다 -
          모델이 경기 내내 <TeamInk team={away} />를 더 강한 팀으로 보고 있었다는 뜻입니다.
        </p>
      )}

      {verdictsDiffer && (
        <p className="report-text">
          두 예측의 판정이 갈렸습니다 - <b>엔트리 발표 뒤 승률이 달라진 것이 결과와 더 가까웠는지</b>가 여기서 갈립니다.
          엔트리 반영 승률은 결장자를 빼고 다시 계산한 값이라, 시즌 기준과 다른 쪽을 가리켰다면 그 차이가 실제로 유효했다는
          뜻입니다(경기 하나로는 확인되지 않습니다).
        </p>
      )}

      {checks.length > 0 && (
        <>
          <div className="report-section-title audit-table-title">
            경기 전 기대 vs 실제 (<TeamInk team={home} /> 기준, +면 <TeamInk team={home} /> 유리)
          </div>
          <table className="audit-table">
            <thead>
              <tr>
                <th scope="col">항목</th>
                <th scope="col">경기 전 기대</th>
                <th scope="col">이 경기 실제</th>
                <th scope="col">판정</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <CheckRow key={c.label} c={c} />
              ))}
            </tbody>
          </table>
          <p className="report-text">
            {flips.length > 0 ? (
              <>
                기대와 <b>반대 방향</b>으로 나온 항목은 {flips.map((f) => f.label).join(", ")}입니다 - 예측이 어긋난 지점은 여기입니다.
              </>
            ) : (
              <>기대와 반대 방향으로 뒤집힌 항목은 없습니다 - 지표 방향이 아니라 크기에서 갈린 경기입니다.</>
            )}
          </p>
        </>
      )}

      {modelSplit && (
        <p className="report-caveat">
          이 경기는 경기 전 예측이 두 갈래로 갈렸습니다: 위 카드에 찍힌 값은 {fmtProbPct(modelSplit.cardProb, true)}%
          (중계 데이터에 기록된 경기 전 승률)이고, 프리뷰 불릿을 만든 쪽은 {fmtProbPct(modelSplit.featuresProb, true)}%로
          <b> 반대 팀을 우세</b>로 봤습니다. 이번 시즌 경기 기록이 아직 없어 두 계산이 서로 다르게 폴백한 경우입니다.
        </p>
      )}
      <p className="report-caveat">
        경기 하나로는 모델의 정확도를 평가할 수 없습니다(표본 1). 여기서 말하는 것은 &quot;이 경기에서 어떤 입력이 기대와
        반대로 나왔는가&quot;까지이고, 그것이 곧 모델의 결함이라는 뜻은 아닙니다. 기대값은 경기 전 시점 기준이며, 시즌 개막
        직후에는 지난 시즌 값이 쓰입니다.
      </p>
    </>
  );
}
