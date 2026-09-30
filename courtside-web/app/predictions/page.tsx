import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  SCORECARD_EVIDENCE,
  SERIES_LABEL,
  SERIES_NOTE,
  calibrationBins,
  cumulativeLogLoss,
  getScoredGames,
  scoreSeries,
  seasonsOf,
  seriesRows,
  type CalibrationBin,
  type CumulativePoint,
  type ScoredGame,
  type SeriesKey,
  type SeriesMetrics,
} from "@/lib/predictionScorecard";
import styles from "./predictions.module.css";

// 예측 성적표 - 요청: "시즌 내내 log-loss·Brier·캘리브레이션 곡선을 누적해 보여주는".
// 계산과 근거 수치는 lib/predictionScorecard.ts 머리주석에 있다. 이 파일은 표시만 한다.
//
// 이 페이지의 논지: 적중률은 이분법 찍기 점수라 그것만으로는 실력을 말할 수 없다. 확률 예측은
// "58%라고 말한 경기들이 실제로 58% 비율로 일어났는가"로 평가해야 하고, 그래서 기준선(동전,
// 홈 승률만 아는 예측)을 항상 옆에 붙인다.

export const metadata: Metadata = {
  title: "예측 성적표 | 코트사이드",
  description: "코트사이드 승률 예측의 log-loss·Brier·캘리브레이션을 시즌별로 누적해 보여줍니다. 적중률이 아니라 확률이 맞았는지를 봅니다.",
  // 운영자 전용 - 검색에 걸리지 않게(robots.ts의 disallow와 이중으로).
  robots: { index: false, follow: false },
};

/**
 * 운영자 전용 게이트. 사용자 결정(2026-09-30): "예측 성적표는 우리만 가지고 있고, 유저들에게
 * 공개를 하지 않는게 좋을것 같아 - 우리의 핵심 내용들을 스스로 유출시키는것 같아서". 모델의
 * 캘리브레이션과 실력 수준(기준선 대비 skill)이 그대로 드러나는 내부 지표다.
 *
 * 새 환경변수를 만들지 않고 REVALIDATE_TOKEN을 재사용한다 - 이미 Vercel에 서버 전용으로 있고
 * (app/api/revalidate/route.ts가 쓴다) NEXT_PUBLIC_ 접두사가 없어 클라이언트로 내려가지 않는다.
 *
 * 토큰이 없는 환경(로컬 개발)에서는 그냥 열어 준다 - 프로덕션에서 토큰이 비면 fail-closed로
 * 404다(열린 채로 방치되는 쪽보다 안 보이는 쪽이 낫다).
 */
function gateOk(key: string | undefined): boolean {
  const token = process.env.REVALIDATE_TOKEN;
  if (!token) return process.env.NODE_ENV !== "production";
  return key === token;
}

const SERIES_ORDER: SeriesKey[] = ["live", "pregame", "entry"];
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const f4 = (v: number) => v.toFixed(4);

/** 기준선보다 나으면 아래쪽이 좋은 지표(log-loss/Brier)라 ▼가 개선이다. */
function Delta({ value, base }: { value: number; base: number }) {
  const diff = value - base;
  if (Math.abs(diff) < 0.0005) return <span className={styles.tileSub}>기준선과 같음</span>;
  const better = diff < 0;
  return (
    <span className={`${styles.tileSub} ${better ? styles.better : styles.worse}`}>
      {better ? "▼" : "▲"} 기준선 대비 {diff > 0 ? "+" : "−"}
      {Math.abs(diff).toFixed(4)} {better ? "(더 좋음)" : "(더 나쁨)"}
    </span>
  );
}

function MetricTiles({ m }: { m: SeriesMetrics }) {
  return (
    <div className={styles.tiles}>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>경기 수</div>
        <div className={styles.tileValue}>{m.n}</div>
        <div className={styles.tileSub}>이 표본 홈 승률 {pct(m.baseRate)}</div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>log-loss (낮을수록 좋음)</div>
        <div className={styles.tileValue}>{f4(m.logLoss)}</div>
        <Delta value={m.logLoss} base={m.baseLogLoss} />
        <div className={styles.tileSub}>
          홈 승률만 아는 예측 {f4(m.baseLogLoss)} · 동전 {f4(m.coinLogLoss)}
        </div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Brier (낮을수록 좋음)</div>
        <div className={styles.tileValue}>{f4(m.brier)}</div>
        <Delta value={m.brier} base={m.baseBrier} />
        <div className={styles.tileSub}>
          홈 승률만 아는 예측 {f4(m.baseBrier)} · 동전 {f4(m.coinBrier)}
        </div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Brier skill score</div>
        <div className={`${styles.tileValue} ${m.skill > 0 ? styles.better : styles.worse}`}>
          {(m.skill * 100).toFixed(1)}%
        </div>
        <div className={styles.tileSub}>
          홈 승률만 아는 예측 대비. 0%면 그것과 같고, 음수면 더 못합니다.
        </div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>적중률 (참고용)</div>
        <div className={styles.tileValue}>{pct(m.hitRate)}</div>
        <div className={styles.tileSub}>
          홈팀만 찍어도 {pct(m.baseRate)}입니다. 이분법 점수라 위 지표와 같이 읽어야 합니다.
        </div>
      </div>
    </div>
  );
}

/**
 * 캘리브레이션 곡선. 가로 = 예측 확률, 세로 = 실제 승률, 점선 대각선이 완벽한 캘리브레이션.
 * 점 크기는 그 구간의 경기 수, 세로 막대는 Wilson 95% 구간(표본이 얇은 구간이 얼마나 못 믿을
 * 값인지 눈에 보이게). 아래 옅은 막대는 구간별 경기 수 분포.
 */
function CalibrationChart({ bins }: { bins: CalibrationBin[] }) {
  const S = 100;
  const pad = 9;
  const x = (p: number) => pad + p * (S - pad * 2);
  const y = (p: number) => S - pad - p * (S - pad * 2);
  const maxN = Math.max(1, ...bins.map((b) => b.n));
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className={styles.calSvg} role="img" aria-label="캘리브레이션 곡선">
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(0)} className={styles.axisLine} />
      <line x1={x(0)} y1={y(0)} x2={x(0)} y2={y(1)} className={styles.axisLine} />
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className={styles.refLine} />
      {/* 구간별 경기 수 - 축 바로 위에 옅은 막대로. */}
      {bins.map((b) => {
        const h = (b.n / maxN) * 10;
        return b.n > 0 ? (
          <rect
            key={`n${b.lo}`}
            x={x(b.lo) + 0.4}
            y={y(0) - h}
            width={Math.max(0.6, x(b.hi) - x(b.lo) - 0.8)}
            height={h}
            className={styles.calBar}
          />
        ) : null;
      })}
      {bins.map((b) =>
        b.observed == null ? null : (
          <g key={b.lo}>
            <line x1={x(b.meanPred)} y1={y(b.ciLo)} x2={x(b.meanPred)} y2={y(b.ciHi)} className={styles.calCi} />
            <circle cx={x(b.meanPred)} cy={y(b.observed)} r={1 + 2.4 * Math.sqrt(b.n / maxN)} className={styles.calDot}>
              <title>
                {`예측 ${Math.round(b.lo * 100)}~${Math.round(b.hi * 100)}% · ${b.n}경기 · 실제 ${(b.observed * 100).toFixed(0)}% (95% ${(b.ciLo * 100).toFixed(0)}~${(b.ciHi * 100).toFixed(0)}%)`}
              </title>
            </circle>
          </g>
        )
      )}
      <text x={x(0)} y={S - 2} className={styles.svgLabel}>0%</text>
      <text x={x(1) - 7} y={S - 2} className={styles.svgLabel}>100%</text>
      <text x={1} y={y(1) + 1} className={styles.svgLabel}>100%</text>
      <text x={1} y={y(0)} className={styles.svgLabel}>0%</text>
    </svg>
  );
}

/** 누적 평균 log-loss. 곡선이 점선(기준선) 아래에 있는 동안만 실력이 있다는 뜻. */
function CumulativeChart({ points }: { points: CumulativePoint[] }) {
  const W = 100;
  const H = 56;
  const pad = 9;
  if (points.length < 2) return <div className="empty-note">경기가 2건 이상 쌓이면 그려집니다.</div>;
  const all = points.flatMap((p) => [p.logLoss, p.baseline]);
  const lo = Math.min(...all) * 0.95;
  const hi = Math.max(...all) * 1.05;
  const x = (i: number) => pad + ((i - 1) / Math.max(1, points.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - pad * 2);
  const path = (get: (p: CumulativePoint) => number) =>
    "M " + points.map((p) => `${x(p.i).toFixed(2)} ${y(get(p)).toFixed(2)}`).join(" L ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.cumSvg} role="img" aria-label="누적 log-loss">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className={styles.axisLine} />
      <path d={path((p) => p.baseline)} className={styles.cumBase} />
      <path d={path((p) => p.logLoss)} className={styles.cumModel} />
      <text x={pad} y={H - 2} className={styles.svgLabel}>1경기</text>
      <text x={W - pad - 12} y={H - 2} className={styles.svgLabel}>{points.length}경기</text>
      <text x={1} y={pad - 2} className={styles.svgLabel}>{hi.toFixed(2)}</text>
      <text x={1} y={H - pad} className={styles.svgLabel}>{lo.toFixed(2)}</text>
    </svg>
  );
}

function SeasonTable({ games, series }: { games: ScoredGame[]; series: SeriesKey }) {
  const rows = seasonsOf(games)
    .map((s) => {
      const m = scoreSeries(series, seriesRows(games.filter((g) => g.seasonName === s), series));
      return m ? { season: s, m } : null;
    })
    .filter((r): r is { season: string; m: SeriesMetrics } => r !== null);
  if (!rows.length) return null;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">시즌</th>
          <th scope="col">경기</th>
          <th scope="col">log-loss</th>
          <th scope="col">기준선</th>
          <th scope="col">Brier</th>
          <th scope="col">skill</th>
          <th scope="col">적중률</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ season, m }) => (
          <tr key={season} className={season === SCORECARD_EVIDENCE.outOfSampleSeason ? styles.rowOut : undefined}>
            <th scope="row">{season}</th>
            <td>{m.n}</td>
            <td className={m.logLoss < m.baseLogLoss ? styles.better : styles.worse}>{f4(m.logLoss)}</td>
            <td>{f4(m.baseLogLoss)}</td>
            <td>{f4(m.brier)}</td>
            <td className={m.skill > 0 ? styles.better : styles.worse}>{(m.skill * 100).toFixed(1)}%</td>
            <td>{pct(m.hitRate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function PredictionsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; series?: string; key?: string }>;
}) {
  const { season, series, key } = await searchParams;
  // 게이트를 데이터 조회보다 먼저 - 404가 될 요청으로 4,000행씩 세 번 긁지 않는다.
  if (!gateOk(key)) notFound();
  const games = await getScoredGames();
  const seasons = seasonsOf(games);
  const activeSeries: SeriesKey = SERIES_ORDER.includes(series as SeriesKey) ? (series as SeriesKey) : "live";
  // 기본은 학습에서 빠진 시즌(진짜 성적표). 아직 없으면 최신 시즌.
  const defaultSeason = seasons.includes(SCORECARD_EVIDENCE.outOfSampleSeason)
    ? SCORECARD_EVIDENCE.outOfSampleSeason
    : seasons[0];
  const activeSeason = season && (season === "all" || seasons.includes(season)) ? season : defaultSeason;

  const scoped = activeSeason === "all" ? games : games.filter((g) => g.seasonName === activeSeason);
  const rows = seriesRows(scoped, activeSeries);
  const metrics = scoreSeries(activeSeries, rows);
  const bins = calibrationBins(rows);
  const dates = scoped
    .filter((g) => (activeSeries === "live" ? g.live : activeSeries === "pregame" ? g.pregame : g.entry) != null)
    .map((g) => g.gameDate);
  const cum = cumulativeLogLoss(rows, dates);
  const isOutOfSample = activeSeason === SCORECARD_EVIDENCE.outOfSampleSeason;

  const tabHref = (next: { season?: string; series?: string }) => {
    const q = new URLSearchParams({ season: next.season ?? activeSeason, series: next.series ?? activeSeries });
    // 게이트 키를 링크에 유지하지 않으면 탭을 누르는 순간 404가 된다.
    if (key) q.set("key", key);
    return `/predictions?${q.toString()}`;
  };

  // 루트 레이아웃이 이미 <main id="main">으로 감싸므로 여기서 또 <main>을 두지 않는다.
  // 컨테이너는 다른 페이지와 같은 .wrap(globals.css).
  return (
    <div className="wrap">
      <div className="title">예측 성적표</div>
      <div className="panel">
        <p className={styles.intro}>
          적중률만 보면 확률 예측을 평가할 수 없습니다. &quot;이깁니다/집니다&quot;를 잘 맞히는 것은 이분법 찍기 점수이고,
          홈팀만 찍어도 15시즌 기준 <b>{pct(SCORECARD_EVIDENCE.homeWinRate)}</b>가 나옵니다. 확률 예측이 쓸모 있는지는{" "}
          <b>&quot;58%라고 말한 경기들이 실제로 58% 비율로 일어났는가&quot;</b>로 봐야 하고, 그것을 재는 것이 log-loss와
          Brier, 그리고 캘리브레이션 곡선입니다. 그래서 이 표는 기준선을 항상 옆에 붙입니다.
        </p>

        <div className={styles.tabs}>
          <span className={styles.tabsLabel}>시즌</span>
          {[...seasons, "all"].map((s) => (
            <Link key={s} href={tabHref({ season: s })} className={`${styles.tab} ${s === activeSeason ? styles.tabOn : ""}`}>
              {s === "all" ? "전체" : s}
            </Link>
          ))}
        </div>
        <div className={styles.tabs}>
          <span className={styles.tabsLabel}>예측 계열</span>
          {SERIES_ORDER.map((k) => (
            <Link key={k} href={tabHref({ series: k })} className={`${styles.tab} ${k === activeSeries ? styles.tabOn : ""}`}>
              {SERIES_LABEL[k]}
            </Link>
          ))}
        </div>

        <p className={styles.note}>{SERIES_NOTE[activeSeries]}</p>

        {!metrics ? (
          <div className="empty-note">이 시즌·계열에는 채점할 예측이 없습니다.</div>
        ) : (
          <>
            {isOutOfSample ? (
              <p className={styles.note}>
                <b>{activeSeason}은 모델 학습에서 제외된 시즌입니다</b>(save_pregame_model.py의 CURRENT_SEASON_EXCLUDE).
                즉 여기 숫자가 진짜 성적표이고, 아래 과거 시즌 표는 학습에 쓰인 구간이라 낙관적으로 나옵니다.
              </p>
            ) : (
              <p className={styles.note}>
                이 시즌은 모델 학습에 쓰인 구간이라 성적이 낙관적으로 나옵니다(in-sample). 진짜 성적표는{" "}
                {SCORECARD_EVIDENCE.outOfSampleSeason} 이후입니다.
              </p>
            )}
            <MetricTiles m={metrics} />
            {metrics.n < 30 && (
              <p className={styles.note}>
                경기 {metrics.n}건은 어느 쪽 결론도 내기 어려운 표본입니다. 캘리브레이션 곡선의 세로 막대(95% 구간)가
                넓은 것이 그 뜻입니다.
              </p>
            )}
            <div className={styles.charts}>
              <div className={styles.chartCol}>
                <div className={styles.chartTitle}>
                  캘리브레이션 — 가로 예측 확률, 세로 실제 승률. 점선 대각선에 붙을수록 정확합니다.
                </div>
                <CalibrationChart bins={bins} />
                <p className={styles.note}>
                  점 크기는 그 구간의 경기 수, 세로 막대는 Wilson 95% 구간입니다. 아래 옅은 막대는 구간별 경기 수 분포 -
                  대부분의 예측이 40~60%에 몰려 있으면 모델이 확신을 거의 내지 않는다는 뜻입니다.
                </p>
              </div>
              <div className={styles.chartCol}>
                <div className={styles.chartTitle}>누적 log-loss — 실선 모델, 점선 기준선(그 시점까지의 홈 승률)</div>
                <CumulativeChart points={cum} />
                <p className={styles.note}>
                  실선이 점선 아래에 있는 동안만 &quot;홈팀만 찍는 것보다 낫다&quot;는 뜻입니다. 시즌 초반에는 두 곡선 모두
                  크게 흔들립니다.
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">시즌별 ({SERIES_LABEL[activeSeries]})</div>
        <SeasonTable games={games} series={activeSeries} />
        <p className={styles.note}>
          금색 표시가 학습에서 제외된 시즌입니다. log-loss·Brier는 낮을수록, skill은 높을수록 좋습니다. 기준선은 각
          시즌의 홈 승률을 아는 상수 예측이라 시즌마다 조금씩 다릅니다.
        </p>
      </div>
    </div>
  );
}
