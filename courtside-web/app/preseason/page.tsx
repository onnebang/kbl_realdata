import Link from "next/link";
import type { CSSProperties } from "react";
import { TeamBadge } from "@/components/TeamBadge";
import { ChangeLine, statLine } from "@/components/RosterChangeLine";
import {
  PRESEASON_SEASON,
  getSeasonOutlook,
  getRosterChangeReport,
  getDemoGames,
  shortSeason,
  daysUntilKst,
  type TeamOutlook,
  type TeamRosterChanges,
  type RosterChangeReport,
  type DemoGame,
} from "@/lib/preseason";
import {
  GAMES_FULL,
  GAMES_HALF,
  PLAYOFF_SPOTS,
  ROUNDS_HALF,
  ROUNDS_TOTAL,
  formatOdds,
  getSeasonProjection,
  type ProjectionTeam,
  type SeasonProjection,
} from "@/lib/seasonProjection";
import { DepartureImpact } from "@/components/DepartureImpact";
import { ImportRule } from "@/components/ImportRule";
import { getDepartureReport } from "@/lib/departureImpact";
import { getImportRuleReport } from "@/lib/importRule";
import styles from "./preseason.module.css";

/**
 * 26-27 신인 드래프트일(사용자 확인 2026-09-05). 이 날 이후 신인이 각 팀 명부에 들어온다.
 * 그때는 tools/fetch_kbl_roster.py -> import_roster -> build_roster_changes ->
 * build_strength_adjustment 순으로 다시 돌리면 자동으로 반영된다(신인은 KBL 기록이 없어
 * 팀 뎁스 수준으로 채워지는데, 실측상 신인 PER 11.0이 뎁스 평균 9.8과 비슷해 타당한 처리다).
 */
const DRAFT_DATE = "11월 9일";

// 개막 리포트 - 요청: "시즌 시작전 리포트를 먼저 제공하고, 실제 시즌이 시작되면 실제 경기가
// 보일 수 있게, 그동안은 실제경기 10경기정도만 테스트로 보여주고, 이렇게 중계가 보일거다라는
// 것을 알려주면". 세 단락: 1) 시즌 전망(경기 전 모델 기대승수) 2) 로스터 이동 지도(확정
// 로스터 x 지난 시즌 기록) 3) 지난 시즌 데모 10경기.
//
// D-day가 요청 시각에 따라 달라지고 로스터/일정이 배치로 갱신되므로 정적 프리렌더 금지(다른
// 페이지들은 searchParams 때문에 자연히 동적이지만 이 페이지엔 그런 게 없어서 명시).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function fmtDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${y}.${m}.${day}`;
}
function fmtDateShort(d: string) {
  const [y, m, day] = d.split("-");
  return `${y.slice(2)}.${m}.${day}`;
}

function pct(v: number | null | undefined) {
  return v == null ? "-" : `${Math.round(v * 100)}%`;
}

function badgeOf(t: { name: string; abbr: string; color: string; logoUrl: string | null } | null) {
  return t ? { name: t.name, abbr: t.abbr, color: t.color, logoUrl: t.logoUrl } : null;
}

// ── 1. 시즌 전망 ────────────────────────────────────────────────────────────────
function OutlookRow({ t, rank }: { t: TeamOutlook; rank: number }) {
  const deltaPp = t.prevPct == null ? null : Math.round((t.expPct - t.prevPct) * 100);
  const deltaCls = deltaPp == null || deltaPp === 0 ? styles.deltaFlat : deltaPp > 0 ? styles.deltaUp : styles.deltaDown;
  return (
    <Link href={`/teams/${t.tcode}?season=${PRESEASON_SEASON}`} className={styles.outlookRow}>
      <div className={styles.outlookRank}>{rank}</div>
      <div className={styles.outlookTeam}>
        <TeamBadge team={badgeOf(t)} size={22} />
        <span>{t.name}</span>
      </div>
      <div className={styles.outlookTrack} title={`기대 승률 ${pct(t.expPct)}`}>
        <div className={styles.outlookFill} style={{ width: `${Math.round(t.expPct * 100)}%`, background: t.color }} />
        <div className={styles.outlookMid} />
      </div>
      <div className={styles.outlookVal}>
        {/* Big Shoulders Display에는 한글 글리프가 없다 - '승'을 숫자 span 안에 두면 숫자만
            콘덴스드로 그려지고 '승'만 sans-serif로 튄다(team-profile .rankSuffix와 같은 함정).
            단위는 본문 서체로 도는 옆 span에 붙인다. */}
        <span className={styles.outlookValBig}>{t.expWins.toFixed(1)}</span>
        <span className={styles.outlookValSub}>승 / {t.gp}경기 · {pct(t.expPct)}</span>
      </div>
      <div className={styles.outlookPrev}>
        {t.prevW}-{t.prevL}
        {deltaPp != null && (
          <span className={`${styles.delta} ${deltaCls}`}>
            {deltaPp > 0 ? "▲" : deltaPp < 0 ? "▼" : "="}
            {Math.abs(deltaPp)}
          </span>
        )}
      </div>
    </Link>
  );
}

// AI 예상 순위 - 시뮬레이션 10,000회의 순위 분포를 가로 10칸으로. 칸 진하기 = 그 순위가
// 나올 확률. 행 안에서 최댓값을 1로 잡아 모양이 보이게 하고(팀마다 분포의 날카로움이 다르다),
// 숫자는 옆 칸(1위 / PO)이 따로 말한다.
function RankStrip({ t }: { t: ProjectionTeam }) {
  // 조정이 있으면 조정 분포를 그린다 - 같은 행의 승수 구간·확률과 기준이 어긋나면 안 된다.
  const dist = t.adj ? t.adj.rankDist : t.rankDist;
  const max = Math.max(...dist);
  return (
    <div className={styles.rankStrip} title={`순위 분포 · 최빈 ${t.adj ? t.adj.modalRank : t.modalRank}위${t.adj ? " (조정 기준)" : ""}`}>
      {dist.map((p, i) => (
        <span
          key={i}
          className={`${styles.rankCell} ${i === PLAYOFF_SPOTS - 1 ? styles.rankCutoff : ""}`}
          style={{ opacity: max > 0 ? 0.12 + 0.88 * (p / max) : 0.12 }}
        />
      ))}
    </div>
  );
}

function ProjectionRow({ t, lo, hi }: { t: ProjectionTeam; lo: number; hi: number }) {
  // 조정 재료가 있으면 막대·분포·확률은 전부 조정 기준으로 그린다(요청: "AI 예상순위를 변경해줘").
  // 기대승수만 기본/조정 둘 다 보여준다(요청: "2가지 버전").
  const a = t.adj;
  const span = Math.max(1, hi - lo);
  const left = (((a ? a.winsLo : t.winsLo) - lo) / span) * 100;
  const width = (((a ? a.winsHi : t.winsHi) - (a ? a.winsLo : t.winsLo)) / span) * 100;
  const dot = (((a ? a.fullExp : t.fullExp) - lo) / span) * 100;
  const half = ((GAMES_FULL / 2 - lo) / span) * 100;
  const delta = a ? a.fullExp - t.fullExp : 0;
  // 순위는 작을수록 위다. 기본 3위 -> 조정 5위면 -2(두 계단 내려감).
  const rankMove = a ? t.expRank - a.expRank : 0;
  return (
    // --tc: 팀 색을 원색 그대로 쓰면 남색 계열(부산 KCC)이 다크 배경에서 사라진다.
    // CSS 쪽에서 잉크와 섞어 두 테마 모두 최소 대비를 갖게 한다.
    <Link
      href={`/teams/${t.tcode}?season=${PRESEASON_SEASON}`}
      className={styles.projRow}
      style={{ "--tc": t.color } as CSSProperties}
    >
      {/* 순위 변동은 스포츠 순위표에서 누구나 아는 기호라 설명 없이 읽힌다.
          "기본 2위"라는 개발자 어휘를 여기서 대체한다. */}
      <div className={styles.projRankCell}>
        <span className={styles.outlookRank}>{a ? a.expRank : t.expRank}</span>
        {a && rankMove !== 0 && (
          <span className={`${styles.projMove} ${rankMove > 0 ? styles.deltaUp : styles.deltaDown}`}>
            {rankMove > 0 ? "▲" : "▼"}
            {Math.abs(rankMove)}
          </span>
        )}
      </div>
      <div className={styles.outlookTeam}>
        <TeamBadge team={badgeOf(t)} size={22} />
        <span>{t.name}</span>
      </div>
      {/* 두 숫자를 한 칸에 넣어 "무엇에서 무엇으로"가 화살표 하나로 읽히게. */}
      {a ? (
        <div className={styles.projWins}>
          <span className={styles.projWinsBase}>{t.fullExp.toFixed(1)}</span>
          <span className={styles.projWinsArrow}>→</span>
          <span
            className={`${styles.projWinsFinal} ${delta > 0.05 ? styles.deltaUp : delta < -0.05 ? styles.deltaDown : ""}`}
          >
            {a.fullExp.toFixed(1)}
          </span>
          {Math.abs(delta) > 0.05 && (
            <span className={`${styles.projMove} ${delta > 0 ? styles.deltaUp : styles.deltaDown}`}>
              {delta > 0 ? "▲" : "▼"}
              {Math.abs(delta).toFixed(1)}
            </span>
          )}
        </div>
      ) : (
        <div className={styles.projWins}>
          <span className={styles.projWinsFinal}>{t.fullExp.toFixed(1)}</span>
        </div>
      )}
      <div
        className={styles.projTrack}
        title={`80% 구간 ${a ? a.winsLo : t.winsLo}~${a ? a.winsHi : t.winsHi}승 · 기대 ${(a ? a.fullExp : t.fullExp).toFixed(1)}승${a ? " (조정 기준)" : ""}`}
      >
        {half >= 0 && half <= 100 && <span className={styles.projEven} style={{ left: `${half}%` }} />}
        <span className={styles.projBand} style={{ left: `${left}%`, width: `${width}%` }} />
        <span className={styles.projDot} style={{ left: `${dot}%` }} />
      </div>
      <RankStrip t={t} />
      {/* 반올림해서 "0%"로 적으면 "1위 불가능"으로 읽힌다. 10만 번 돌려도 못 본 값은
          0이 아니라 "0.01% 미만"이다(lib/seasonProjection.ts formatOdds). */}
      <div className={styles.projOdds}>{formatOdds(a ? a.titleOdds : t.titleOdds)}</div>
      <div className={styles.projOdds}>{formatOdds(a ? a.playoffOdds : t.playoffOdds)}</div>
      <div className={styles.outlookPrev}>
        {t.prevW}-{t.prevL}
      </div>
    </Link>
  );
}

/** 조정 델타의 부호와 크기를 한 줄로. 리그 평균을 뺀 상대값이라 합이 0에 가깝다. */
function AdjBreakdown({ proj, cur, prev }: { proj: SeasonProjection; cur: string; prev: string }) {
  const adj = proj.adjustment;
  if (!adj) return null;
  const rows = [...proj.teams].filter((t) => t.adj).sort((x, y) => (y.adj as NonNullable<typeof y.adj>).relMargin - (x.adj as NonNullable<typeof x.adj>).relMargin);
  const max = Math.max(...rows.map((t) => Math.abs((t.adj as NonNullable<typeof t.adj>).relMargin)), 0.1);
  const priors = rows
    .flatMap((t) => (t.adj as NonNullable<typeof t.adj>).team.slots.filter((sl) => sl.tier).map((sl) => `${t.abbr} ${sl.name}(${sl.tier})`))
    .join(" · ");
  // 0.005 미만은 그냥 0으로 - "+0.00"은 부호가 있는 것처럼 읽힌다.
  // 뎁스 범위는 살아 있는 값에서 읽는다(하드코딩하면 팀 로스터가 바뀔 때 조용히 낡는다).
  const depths = adj.teams.map((t) => t.depthPer).filter((v) => v > 0);
  const depthLo = depths.length ? Math.min(...depths).toFixed(1) : "-";
  const depthHi = depths.length ? Math.max(...depths).toFixed(1) : "-";
  const depthAvg = depths.length ? (depths.reduce((a2, b2) => a2 + b2, 0) / depths.length).toFixed(1) : "-";
  const thinTeams = [...adj.teams]
    .sort((a2, b2) => a2.depthPer - b2.depthPer)
    .slice(0, 2)
    .map((t) => {
      const info = proj.teams.find((x) => x.tcode === t.tcode);
      return `${info?.name ?? t.tcode} ${t.depthPer.toFixed(1)}`;
    })
    .join(" · ");
  const sign = (v: number) => (Math.abs(v) < 0.005 ? "0.00" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`);
  return (
    <>
      <div className={styles.panelTitle} style={{ marginTop: 16 }}>
        조정의 내역 - 경기당 득실차 (점)
      </div>
      <p className={styles.panelLede}>
        앞의 네 칸은 그 팀이 얼마나 달라졌는지(절대값), 마지막 <b>상대</b> 칸은 거기서 리그 평균({adj.leagueMean.toFixed(2)}점)을 뺀 값입니다.
        순위는 팀 사이의 차이로만 정해지므로 표를 움직이는 건 <b>상대</b> 쪽입니다 — 예를 들어 규정 변경은 10팀 모두를 +0.5~+1.1점 올리기
        때문에, 그 자체로는 순위를 거의 바꾸지 않고 팀 간 격차만 남습니다.
      </p>
      <div className={styles.adjGrid}>
        <div className={`${styles.adjRow} ${styles.adjHead}`}>
          <div>팀</div>
          <div style={{ textAlign: "right" }}>이탈</div>
          <div style={{ textAlign: "right" }}>슬롯</div>
          <div style={{ textAlign: "right" }}>기타</div>
          <div style={{ textAlign: "right" }}>규정</div>
          <div style={{ textAlign: "right" }}>상대</div>
          <div>← 약해짐 · 강해짐 →</div>
        </div>
        {rows.map((t) => {
          const a = t.adj as NonNullable<typeof t.adj>;
          const w = (Math.abs(a.relMargin) / max) * 50;
          return (
            <div key={t.tcode} className={styles.adjRow}>
              <div className={styles.adjTeam}>
                <TeamBadge team={badgeOf(t)} size={16} />
                <span>{t.name}</span>
              </div>
              <div className={styles.adjNum}>{sign(a.team.dMarginDepart)}</div>
              <div className={styles.adjNum}>{sign(a.team.dMarginSlot)}</div>
              <div className={styles.adjNum}>{sign(a.team.dMarginOther)}</div>
              <div className={styles.adjNum}>{sign(a.team.dMarginRule)}</div>
              <div className={`${styles.adjNum} ${styles.adjTotal}`}>{sign(a.relMargin)}</div>
              <div className={styles.adjTrack}>
                <span className={styles.adjZero} />
                <span
                  className={`${styles.adjBar} ${a.relMargin >= 0 ? styles.adjBarUp : styles.adjBarDown}`}
                  style={a.relMargin >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.note}>
        <b>이탈</b>은 {cur}에 뛰지 않는 것이 확정된 선수의 자리를 그 팀의 뎁스(잔류 선수 중 출전분 9~14위)로 메웠을 때의 변화입니다.{" "}
        <b>슬롯</b>은 외국인·아시아쿼터 세 자리의 주인이 바뀐 몫, <b>기타</b>는 국내 영입·미계약 등 나머지 로스터 이동, <b>규정</b>은 2·3쿼터
        외국인 2명 허용으로 외국인 2옵션이 경기당 10분을 더 뛴다고 가정했을 때의 몫입니다. 순차 분해라 순서에 따라 배분이 조금 달라집니다.
      </div>
      {priors && (
        <div className={styles.note}>
          <b>KBL 기록이 없어 사전확률로 채운 자리 {adj.priorSlots}개</b> (전체 {adj.totalSlots}개 중): {priors}. 등급은 KBL 첫 시즌 비국내 선수
          195명(300분+)의 PER 분포 분위수에 배치한 값입니다 — 특급 30.7(상위 10%) · 상급 28.1(상위 25%) · 중급 24.1(중앙값) · 역할 20.8(하위
          25%) · 아시아쿼터 16.2(중앙값). <b>이 등급은 측정이 아니라 스카우팅 판단입니다.</b>
        </div>
      )}
      {/* 스카우팅 근거 - 사용자가 준 리그 스탯·EASL·연습경기 기사를 등급의 근거로 보여준다.
          "참고 정도로만"이라는 요청 그대로 접어 두고, 열면 선수별로 무엇을 보고 등급을 매겼는지 나온다.
          strength_adjustment_player.evidence는 이전까지 저장만 되고 어디에도 렌더되지 않았다. */}
      {priors && (
        <details className={styles.scoutDetails}>
          <summary className={styles.scoutSummary}>사전확률 {adj.priorSlots}자리의 스카우팅 근거 보기</summary>
          <div className={styles.scoutList}>
            {rows.flatMap((t) =>
              (t.adj as NonNullable<typeof t.adj>).team.slots
                .filter((sl) => sl.tier)
                .map((sl) => (
                  <div key={`${t.tcode}-${sl.slot}`} className={styles.scoutItem}>
                    <div className={styles.scoutHead}>
                      <TeamBadge team={badgeOf(t)} size={14} />
                      <b>{sl.name}</b>
                      <span className={styles.scoutTier}>
                        {sl.tier} · 투영 PER {sl.per.toFixed(1)}
                        {sl.prevName ? ` · 전임 ${sl.prevName}${sl.prevPer != null ? ` ${sl.prevPer.toFixed(1)}` : ""}` : ""}
                      </span>
                    </div>
                    {sl.evidence ? <div className={styles.scoutEv}>{sl.evidence}</div> : null}
                  </div>
                ))
            )}
          </div>
          <div className={styles.note}>
            위 근거는 해외 리그 기록·국제대회(EASL)·8~9월 연습경기 기사에서 옮긴 <b>참고 자료</b>이지 KBL 실측이 아닙니다. 리그 간
            수준 차이를 환산하는 검증된 계수가 없어 숫자를 그대로 쓰지 않고, <b>등급 하나</b>로만 반영했습니다. KBL 팀을 직접 상대한
            기록(EASL·연습경기)이 있는 선수는 그만큼 등급의 근거가 단단합니다.
          </div>
        </details>
      )}
      {/* 신인 드래프트 - 사용자: "11월 9일날 신인 드래프트가 있어서 그 이후로 신인이 들어오긴
          할건데 ... 작년에 신입들이 활약했던걸 생각하면 추가를 해야할것 같아".
          아직 누구인지 모르므로 넣을 수 없다. 대신 "빠져 있다"는 사실과, 들어왔을 때 얼마나
          움직일지를 실측으로 말한다. 신인 수치는 15시즌 집계(데이터 시작 왜곡이 있는 첫 두
          시즌 제외): 국내 출전시간의 1.4~14.0%, 25-26은 9.0%(6명이 500분 이상), 분가중 PER 11.0. */}
      <div className={styles.note}>
        <b>신인 드래프트({DRAFT_DATE}) 선수는 아직 이 표에 없습니다.</b> 누가 어느 팀에 갈지 정해지지 않아 넣을 수가 없습니다. 다만 얼마나
        움직일지는 지난 기록으로 가늠할 수 있습니다 — 최근 시즌 신인들은 국내 출전시간의 1.4~14.0%를 가져갔고({prev}은 9.0%로 그중 6명이
        500분 이상 뛰었습니다), 그때 신인들의 분가중 PER은 11.0이었습니다. 이 표가 빈자리를 메우는 데 쓰는 <b>팀 뎁스</b>가{" "}
        {depthLo}~{depthHi}(평균 {depthAvg})이라 <b>신인의 수준과 비슷합니다</b>. 그래서 신인이 합류해도 순서가 크게 바뀌지는 않을 것으로
        봅니다. 다만 뎁스가 특히 얇은 팀에서는 신인 한 명이 차지하는 몫이 상대적으로 큽니다({thinTeams}). 드래프트 후 명부가 갱신되면 이 표도
        다시 계산됩니다.
      </div>
      <div className={styles.note}>
        나머지 자리는 실측입니다: {prev} 기록이 있으면 그 값을, 공백 후 복귀면 마지막 KBL 시즌 값을 쓰되, 둘 다 &quot;다음 시즌 PER&quot;
        회귀를 통과시킵니다(비국내 연속 4.65+0.789p · n=131, 공백 복귀 12.29+0.491p · n=38, 국내 연속 3.76+0.690p · n=824). 공백이 있으면
        평균으로 회귀하는 힘이 훨씬 세다는 것이 15시즌 실측이라, 케베 알루마·게이지 프림·패리스 배스·라숀 토마스는 마지막 기록보다 2~4점 낮게
        잡힙니다.
      </div>
    </>
  );
}

function ProjectionSection({
  proj,
  prev,
  cur,
  knows,
}: {
  proj: SeasonProjection;
  prev: string;
  cur: string;
  /** 이 모델이 아직 모르는 변화들 - 각주에서 아래 섹션을 가리킨다. */
  knows: { departures: number | null; ruleChange: boolean };
}) {
  // 축은 두 시나리오를 모두 담아야 한다(조정 막대가 기본 범위를 벗어날 수 있다).
  const lo = Math.min(...proj.teams.map((t) => Math.min(t.winsLo, t.adj?.winsLo ?? t.winsLo))) - 1;
  const hi = Math.max(...proj.teams.map((t) => Math.max(t.winsHi, t.adj?.winsHi ?? t.winsHi))) + 1;
  const m = proj.matrix;
  const hasAdj = !!proj.adjustment;
  // 전반기/전체 비율 - 열을 뺀 근거를 각주가 숫자로 말한다(하드코딩하지 않는다).
  const halfRatios = proj.teams.filter((t) => t.fullExp > 0).map((t) => t.halfExp / t.fullExp);
  const halfRatioLo = halfRatios.length ? Math.min(...halfRatios).toFixed(3) : "-";
  const halfRatioHi = halfRatios.length ? Math.max(...halfRatios).toFixed(3) : "-";
  const halfMaxErr = proj.teams.length
    ? Math.max(...proj.teams.map((t) => Math.abs(t.halfExp - t.fullExp / 2))).toFixed(2)
    : "-";
  // 조정이 있으면 조정 기준 순위로 정렬한다 - 요청("AI 예상순위를 변경해줘").
  const ordered = hasAdj
    ? [...proj.teams].sort((a, b) => (a.adj?.expRank ?? a.expRank) - (b.adj?.expRank ?? b.expRank))
    : proj.teams;
  return (
    <div className={styles.panel}>
      <div className={styles.panelTitle}>
        <span className={styles.sectionNum}>1</span>코트사이드 시즌 전망 - 정규시즌 {GAMES_FULL}경기 기대승수와 AI 예상 순위
      </div>
      <p className={styles.panelLede}>
        KBL 정규시즌은 상대별 홈 3 · 원정 3으로 {ROUNDS_TOTAL}라운드 {GAMES_FULL}경기입니다.{" "}
        {proj.scheduleComplete ? (
          <>
            {cur} 정규시즌 {proj.scheduledN}경기 일정이 전부 공개되어 있어(
            {proj.firstGameDate ? fmtDate(proj.firstGameDate) : "-"} ~ {proj.lastGameDate ? fmtDate(proj.lastGameDate) : "-"}) 그대로
            계산했습니다.
          </>
        ) : (
          <>
            공개된 일정은 {proj.scheduledN}경기뿐이라 팀마다 경기 수가 달라, 모자란 만큼은 매치업 승률로 채워 {GAMES_FULL}경기 기준으로
            맞췄습니다.
          </>
        )}
      </p>
      {hasAdj && (
        <div className={styles.adjWarn}>
          <b>이 표는 맞히려고 만든 게 아닙니다.</b> 오른쪽 승수는 확정 결장 13명, 2·3쿼터 외국인 2명 허용, KBL 기록이 없는 신입 선수{" "}
          {proj.adjustment?.priorSlots}명의 스카우팅 등급을 넣어 로스터를 다시 조립한 <b>시나리오</b>입니다. KBL 15시즌을 확인해 보니{" "}
          <b>이탈 정보만으로 다음 시즌을 설명한 설명력은 0.1% 미만</b>이었습니다 — 순서를 보는 용도로만 봐 주세요. 그리고{" "}
          <b>신인 드래프트(11월 9일) 선수는 아직 이 표에 없습니다.</b> 개막 후 경기가 쌓이면 모델이 실제 결과로 다시 계산합니다.
        </div>
      )}
      {hasAdj && (
        <div className={styles.readMe}>
          <div className={styles.readMeItem}>
            <span className={styles.readMeChip}>
              <span className={styles.projWinsBase}>30.8</span>
              <span className={styles.projWinsArrow}>→</span>
              <span className={`${styles.projWinsFinal} ${styles.deltaUp}`}>31.0</span>
            </span>
            <span>
              왼쪽은 <b>작년 전력 그대로</b> 계산한 승수, 오른쪽은 <b>올해 변화를 반영</b>한 승수입니다.
            </span>
          </div>
          <div className={styles.readMeItem}>
            <span className={styles.readMeChip}>
              <span className={styles.outlookRank}>3</span>
              <span className={`${styles.projMove} ${styles.deltaUp}`}>▲2</span>
            </span>
            <span>
              순위는 <b>올해 변화를 반영한 기준</b>이고, 화살표는 작년 전력 기준 순위에서 몇 계단 움직였는지입니다.
            </span>
          </div>
          <div className={styles.readMeItem}>
            <span className={styles.readMeChip}>
              <span className={styles.readMeBar}>
                <span className={styles.readMeBarFill} />
              </span>
            </span>
            <span>
              막대는 <b>10번 중 8번이 들어가는 승수 범위</b>입니다. 길수록 어떻게 될지 모른다는 뜻입니다.
            </span>
          </div>
          <div className={styles.readMeItem}>
            <span className={styles.readMeChip}>
              <span className={styles.readMeStrip}>
                {[0.95, 0.7, 0.45, 0.3, 0.2, 0.14, 0.1, 0.07, 0.05, 0.04].map((o, i) => (
                  <span key={i} style={{ opacity: o }} />
                ))}
              </span>
            </span>
            <span>
              칸이 진할수록 <b>그 순위가 될 가능성이 큽니다</b>. 맨 왼쪽이 1위, 맨 오른쪽이 {proj.teams.length}위입니다.
            </span>
          </div>
        </div>
      )}
      <div className={styles.outlookGrid}>
        <div className={`${styles.projRow} ${styles.outlookHead}`}>
          <div />
          <div>팀</div>
          <div>{hasAdj ? `예상 승수 (${GAMES_FULL}경기)` : `기대 승수 (${GAMES_FULL}경기)`}</div>
          <div>승수 범위</div>
          <div>순위 가능성</div>
          <div style={{ textAlign: "right" }}>정규 1위</div>
          <div style={{ textAlign: "right" }}>6강</div>
          <div className={styles.outlookPrev}>{prev} 성적</div>
        </div>
        {ordered.map((t) => (
          <ProjectionRow key={t.tcode} t={t} lo={lo} hi={hi} />
        ))}
      </div>
      <div className={styles.note}>
        {/* 전반기 열을 뺀 이유를 숫자로 밝힌다 - 사용자가 "데이터 중복 같다"고 했고 실제로 그랬다. */}
        전반기({ROUNDS_HALF}라운드 {GAMES_HALF}경기) 기대승수는 따로 두지 않았습니다. 각 팀의 날짜순 앞 {GAMES_HALF}경기로 실제로
        계산해 보면 전체 {GAMES_FULL}경기 값의 {halfRatioLo}~{halfRatioHi}배로, <b>사실상 정확히 절반</b>이기 때문입니다(절반으로 봤을 때
        최대 오차 {halfMaxErr}승). 일정이 균형이라 그렇습니다 — 앞 {GAMES_HALF}경기 안에 상대별 {ROUNDS_HALF}경기가 들어갑니다.{" "}
        전체 {GAMES_FULL}경기는 일정 편성과 무관하게 매치업 승률만으로 결정됩니다({m.tcodes.length}팀 × 9상대 × {ROUNDS_TOTAL}). 매치업{" "}
        {m.tcodes.length * (m.tcodes.length - 1)}쌍{" "}
        {m.filled === 0 ? (
          <>전부 모델이 직접 매긴 값입니다(동급 팀끼리 홈 {Math.round(m.hcaProb * 1000) / 10}%).</>
        ) : (
          <>
            중 {m.fromModel}쌍은 모델이 직접 매긴 값이고, 아직 그 방향으로 편성되지 않은 {m.filled}쌍은 반대 방향 승률을 홈코트 이점(동급
            팀끼리 홈 {Math.round(m.hcaProb * 1000) / 10}%)으로 뒤집어 채운 추정입니다.
          </>
        )}
      </div>
      <div className={styles.note}>
        1위·PO 확률과 승수 구간은 같은 {GAMES_FULL}경기 일정을 {proj.sims.toLocaleString()}번 돌린 결과입니다(6강 플레이오프 기준). 기대승수가
        비슷해도 순위 분포는 다를 수 있고, 실제 시즌은 이 분포 안 어느 한 점입니다. 확률이 낮은 팀은 &quot;0%&quot;로 적지 않고{" "}
        <b>&lt;0.01%</b>로 적습니다 — {proj.sims.toLocaleString()}번 중 한 번도 안 나왔다는 뜻이지 불가능하다는 뜻이 아니기 때문입니다.
      </div>
      <AdjBreakdown proj={proj} cur={cur} prev={prev} />
      <div className={styles.note}>
        <b>&quot;기본&quot; 열이 아는 것과 모르는 것.</b> 기본 승률은 {prev} 전력(넷레이팅·라인업 시너지·홈코트)만으로 계산됩니다. 그래서{" "}
        {knows.departures != null && <>{cur}에 뛰지 않는 것이 확정된 {knows.departures}명도, </>}
        {knows.ruleChange && <>2·3쿼터 외국인 2명 동시 출전을 허용하는 규정 변경도, </>}로스터 이동도 기본 열에는 들어 있지 않습니다. 그
        차이를 넣어 본 것이 &quot;조정&quot; 열이고, 아래 섹션들이 각 재료를 하나씩 측정해 보여 줍니다. {cur} 개막 후 경기가 쌓이면 모델이
        실제 결과로 다시 계산됩니다.
      </div>
    </div>
  );
}

// ── 2. 로스터 이동 지도 - 한 줄 렌더(ChangeLine/statLine)는 팀 프로필과 공유(components/RosterChangeLine.tsx) ──
function TeamCard({ t, abbrOf }: { t: TeamRosterChanges; abbrOf: (tcode: string | null) => string | null }) {
  // 국내 로스터까지 들어오면 팀당 25행 안팎이 되는데, 그중 15~18행이 "잔류"라 카드가 잔류
  // 목록에 묻힌다. 변화(영입·신입·이탈)만 펼쳐 두고 잔류는 접어 둔다(순수 <details>, JS 없음).
  const changed = [...t.in, ...t.back, ...t.new, ...t.out];
  const summary = [
    t.in.length && `영입 ${t.in.length}`,
    t.back.length && `복귀 ${t.back.length}`,
    t.new.length && `신입 ${t.new.length}`,
    t.stay.length && `잔류 ${t.stay.length}`,
    t.out.length && `이탈 ${t.out.length}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={styles.teamCard} style={{ borderTopColor: t.team.color }}>
      <Link href={`/teams/${t.team.tcode}?season=${PRESEASON_SEASON}`} className={styles.teamCardHead}>
        <TeamBadge team={badgeOf(t.team)} size={22} />
        {/* 맨 텍스트 노드로 두면 익명 flex 아이템이 되어 최소 폭까지 줄어든다("원/주/DB").
            span으로 감싸 nowrap을 준다 - 좁아질 때 접혀야 하는 건 이름이 아니라 오른쪽 요약이다. */}
        <span className={styles.teamCardName}>{t.team.name}</span>
        <span className={styles.teamCardSum}>{summary}</span>
      </Link>
      {changed.map((r) => (
        <ChangeLine key={`${r.change}-${r.name}`} r={r} abbrOf={abbrOf} />
      ))}
      {changed.length === 0 && <div className={styles.changeStat}>영입·이탈 없음</div>}
      {t.stay.length > 0 && (
        <details className={styles.stayDetails}>
          <summary className={styles.staySummary}>잔류 {t.stay.length}명 보기</summary>
          {t.stay.map((r) => (
            <ChangeLine key={`stay-${r.name}`} r={r} abbrOf={abbrOf} />
          ))}
        </details>
      )}
    </div>
  );
}

function RosterSection({ report, num }: { report: RosterChangeReport; num: number }) {
  const abbrByTcode = new Map(report.teams.map((t) => [t.team.tcode, t.team.abbr]));
  const abbrOf = (tcode: string | null) => (tcode ? (abbrByTcode.get(tcode) ?? tcode) : null);
  const prev = shortSeason(report.prevSeason);

  // 대조 결과가 0행이면 "변화 없음"이 아니라 "아직 확정 로스터를 못 받음"이다. 헤드라인 타일을
  // 그대로 그리면 "팀 간 이동 0건 · 영입 0 · 이탈 0"이 되어, 하지도 않은 대조를 수행한 것처럼
  // 단언하게 된다(실측 지적) - 그래서 지도 전체를 그리지 않고 상태만 밝힌다.
  if (!report.hasData) {
    return (
      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          <span className={styles.sectionNum}>{num}</span>로스터 이동 지도
        </div>
        <div className="empty-note">
          {report.season} 확정 로스터가 아직 입력되지 않아 {prev} 시즌과의 대조를 수행하지 못했습니다 - 구단 발표가 확정되는 대로 이 자리에 이적·영입·이탈
          지도가 채워집니다.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelTitle}>
        <span className={styles.sectionNum}>{num}</span>로스터 이동 지도
      </div>
      <p className={styles.panelLede}>
        확정 로스터(국내는 KBL 등록 명부, 외국인·아시아쿼터는 구단 발표)를 {prev} 시즌 출전 기록과 대조한 결과입니다. 이적한 선수는 옛 팀엔 &quot;이탈&quot;,
        새 팀엔 &quot;영입&quot;으로 두 번 나타나고, 성적은 그 선수가 마지막으로 뛴 시즌 기준입니다. 카드는 변화만 펼쳐 두고 잔류는 접어 두었습니다.
      </p>

      <div className={styles.headlineRow}>
        <div className={styles.headlineTile}>
          <div className={styles.headlineLabel}>팀 간 이동</div>
          <div className={styles.headlineVal}>{report.moves.length}건</div>
          <div className={styles.headlineSub}>
            영입 {report.counts.in} · 복귀 {report.counts.back} · 신입 {report.counts.new} · 잔류 {report.counts.stay} · 이탈{" "}
            {report.counts.out}
          </div>
        </div>
        {report.topIn && (
          <div className={styles.headlineTile}>
            {/* 복귀 선수(예: 2년 만에 돌아온 경우)는 지난 시즌이 아니라 마지막 KBL 시즌 성적이라 "지난 시즌"이라 쓰지 않음 */}
            <div className={styles.headlineLabel}>가장 큰 영입 (마지막 KBL 시즌 득점 기준)</div>
            <div className={styles.headlineVal}>
              {report.topIn.name} → {report.topIn.team.abbr}
            </div>
            <div className={styles.headlineSub}>{statLine(report.topIn)}</div>
          </div>
        )}
        {report.topOut && (
          <div className={styles.headlineTile}>
            <div className={styles.headlineLabel}>가장 큰 이탈 ({prev} 득점 기준)</div>
            <div className={styles.headlineVal}>
              {report.topOut.team.abbr} ← {report.topOut.name}
            </div>
            <div className={styles.headlineSub}>{statLine(report.topOut)}</div>
          </div>
        )}
      </div>

      {report.moves.length > 0 && (
        <ul className={styles.moveList}>
          {report.moves.map((m) => (
            <li key={`${m.name}-${m.to.tcode}`}>
              <TeamBadge team={badgeOf(m.from)} size={16} />
              <span className={styles.moveArrow}>→</span>
              <TeamBadge team={badgeOf(m.to)} size={16} />
              {m.pcode ? <Link href={`/players/${m.pcode}`}>{m.name}</Link> : m.name}
              {m.ppg != null && <span className={styles.changeFrom}>{m.ppg.toFixed(1)}점</span>}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.teamGrid}>
        {report.teams.map((t) => (
          <TeamCard key={t.team.tcode} t={t} abbrOf={abbrOf} />
        ))}
      </div>

      <div className={styles.note}>
        {report.domesticPending
          ? `국내 선수 확정 로스터가 아직 입력되지 않은 팀: ${report.domesticPendingTeams.join(", ")} - 이 팀들은 이탈 판정을 외국인 선수에 한정하며, 로스터가 들어오면 같은 지도에 자동 반영됩니다. `
          : ""}
        성적은 {prev} 정규시즌+플레이오프 합산 평균입니다(위 시즌 전망표의 전적은 정규시즌 기준이라 분모가 다릅니다). {prev} 시즌 5경기 미만 출전
        선수는 이탈 목록에서 제외. &quot;신입&quot;은 KBL 출전 기록이 없는 선수로, 첫 경기 출전 시 프로필이 자동 연결됩니다.
      </div>
      <div className={styles.note}>
        &quot;복귀&quot;({report.counts.back}명)는 {prev} 시즌 KBL 기록이 없고 그 전엔 있는 선수입니다 — 상무(군) 복무 기간은 KBL 경기 기록에 남지
        않아 두 시즌이 통째로 비고, 1년 넘는 부상 공백도 같은 모양으로 비기 때문에 그동안 &quot;영입&quot;으로 잡히던 자리입니다. 다만 군 전역인지
        부상 복귀인지는 KBL 기록 어디에도 없어 이 페이지는 사유를 추정하지 않고 공백 시즌 수만 적습니다. 외국인 선수의 재영입(패리스 배스·게이지
        프림·케베 알루마·라숀 토마스)도 같은 모양이라 같은 칩을 쓰되 note에 &quot;재영입&quot;으로 남습니다.
      </div>
    </div>
  );
}

// ── 3. 데모 경기 ────────────────────────────────────────────────────────────────
function DemoCard({ g }: { g: DemoGame }) {
  const homeWon = g.homeScore != null && g.awayScore != null && g.homeScore > g.awayScore;
  const awayWon = g.homeScore != null && g.awayScore != null && g.awayScore > g.homeScore;
  return (
    <Link href={`/games/${g.gmkey}`} className={styles.demoCard}>
      <div className={styles.demoTop}>
        <span>{fmtDateShort(g.gameDate)}</span>
        <span>{g.seasonCategory}</span>
        {g.tag && <span className={styles.demoTag}>{g.tag.label}</span>}
      </div>
      <div className={styles.demoScore}>
        <div className={styles.demoTeam}>
          <TeamBadge team={badgeOf(g.home)} size={20} />
          <span>{g.home?.name ?? "-"}</span>
        </div>
        <div className={styles.demoNum}>
          <span className={homeWon ? undefined : styles.demoNumLose}>{g.homeScore ?? "-"}</span>
          <span className={styles.demoNumLose}> : </span>
          <span className={awayWon ? undefined : styles.demoNumLose}>{g.awayScore ?? "-"}</span>
        </div>
        <div className={`${styles.demoTeam} ${styles.demoTeamAway}`}>
          <span>{g.away?.name ?? "-"}</span>
          <TeamBadge team={badgeOf(g.away)} size={20} />
        </div>
      </div>
      <div className={styles.demoWhy}>{g.why}</div>
      <div className={styles.demoCta}>리플레이 열기</div>
    </Link>
  );
}

/**
 * 선택 섹션(시즌 전망 시뮬레이션·확정 결장·외국인 규정)은 "없으면 섹션만 빠진다"가 약속인데,
 * 지금까지는 null 반환만 그랬고 throw(네트워크·RPC 오류)는 페이지 전체를 죽였다(감사 2026-09-06).
 * 조용히 삼키지는 않는다 - console.error로 남기고 그 섹션만 뺀다. 본체(outlook·roster·demos)는
 * 그대로 throw.
 */
function optional<T>(what: string, p: Promise<T>): Promise<T | null> {
  return p.catch((e: unknown) => {
    console.error(`[preseason] ${what} 조회 실패 - 해당 섹션만 생략:`, e);
    return null;
  });
}

export default async function PreseasonPage() {
  const [outlook, roster, demos, proj, departures, importRule] = await Promise.all([
    getSeasonOutlook(PRESEASON_SEASON),
    getRosterChangeReport(PRESEASON_SEASON),
    getDemoGames(),
    optional("seasonProjection", getSeasonProjection(PRESEASON_SEASON)),
    // 둘 다 없으면 해당 섹션만 빠지고 나머지 페이지는 그대로 - 확정 명단/슬롯 집계가 아직
    // 없는 시즌에도 개막 리포트는 열려야 한다.
    optional("departureReport", getDepartureReport(PRESEASON_SEASON)),
    optional("importRuleReport", getImportRuleReport(PRESEASON_SEASON)),
  ]);
  // 섹션 번호는 실제로 그려지는 것만 세어 매긴다(빠진 섹션 때문에 번호가 건너뛰면 안 된다).
  let sectionNo = 1;
  const nextNo = () => ++sectionNo;
  const dday = outlook.firstGameDate ? daysUntilKst(outlook.firstGameDate) : null;
  const ddayLabel = dday == null ? "" : dday > 0 ? `D-${dday}` : dday === 0 ? "D-DAY" : `D+${-dday}`;
  const prev = shortSeason(outlook.prevSeason);
  const cur = shortSeason(outlook.season);
  const rosterCount = roster.counts.in + roster.counts.back + roster.counts.new + roster.counts.stay;

  return (
    <div className={`wrap ${styles.pageRoot}`}>
      <div className={styles.hero} style={{ "--hero-team": "#ffd166" } as CSSProperties}>
        <div className={styles.heroTicks} />
        <div className={styles.heroScrim} />
        {ddayLabel && <div className={styles.heroDday}>{ddayLabel}</div>}
        <div className={styles.heroContent}>
          <div className={styles.heroKicker}>COURTSIDE · {outlook.season} PRESEASON REPORT</div>
          <h1 className={styles.heroTitle}>{cur} 시즌 개막 리포트</h1>
          <p className={styles.heroLede}>
            {outlook.firstGameDate ? `${fmtDate(outlook.firstGameDate)} 개막. ` : ""}
            개막 전에는 이 페이지가 시즌 전망과 로스터 변화를 보여주고, 첫 경기가 시작되면 경기 목록의 예정 경기가 그대로 라이브 문자중계로
            바뀝니다. 그동안 지난 시즌 실제 경기 10개로 어떻게 보일지 미리 확인할 수 있습니다.
          </p>
          <div className={styles.heroStatRow}>
            {outlook.firstGameDate && (
              <div>
                <div className={styles.heroStatVal}>{fmtDateShort(outlook.firstGameDate).slice(3)}</div>
                <div className={styles.heroStatLabel}>개막일 (월.일)</div>
              </div>
            )}
            <div>
              <div className={styles.heroStatVal}>{outlook.nGames}</div>
              <div className={styles.heroStatLabel}>반영된 예정 경기</div>
            </div>
            <div>
              <div className={styles.heroStatVal}>{rosterCount}</div>
              <div className={styles.heroStatLabel}>확정 로스터 (국내+외국인)</div>
            </div>
            <div>
              <div className={styles.heroStatVal}>{roster.moves.length}</div>
              <div className={styles.heroStatLabel}>팀 간 이동</div>
            </div>
          </div>
        </div>
      </div>

      {/* 1. 시즌 전망 - 매치업 행렬이 완성되면 54경기 전망·예상 순위, 아니면 공개 일정 기준 표로 폴백 */}
      {proj ? (
        <ProjectionSection
          proj={proj}
          prev={prev}
          cur={cur}
          knows={{ departures: departures ? departures.players.length : null, ruleChange: !!importRule }}
        />
      ) : (
      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          <span className={styles.sectionNum}>1</span>코트사이드 시즌 전망 - 기대승수
        </div>
        <p className={styles.panelLede}>
          경기 전 승률 모델이 {cur} 예정 경기 {outlook.nPriced}개에 매긴 승률을 팀별로 더한 값입니다
          {outlook.nPriced < outlook.nGames ? ` (전체 ${outlook.nGames}경기 중 ${outlook.nGames - outlook.nPriced}경기는 아직 승률이 없어 제외)` : ""}. 오른쪽은{" "}
          {prev} 정규시즌 성적과 승률 차이(%p).
        </p>
        <div className={styles.outlookGrid}>
          <div className={`${styles.outlookRow} ${styles.outlookHead}`}>
            <div />
            <div>팀</div>
            <div>기대 승률 (가운데 눈금 50%)</div>
            <div style={{ textAlign: "right" }}>기대승수</div>
            <div className={styles.outlookPrev}>{prev} 정규</div>
          </div>
          {outlook.teams.map((t, i) => (
            <OutlookRow key={t.tcode} t={t} rank={i + 1} />
          ))}
        </div>
        <div className={styles.note}>
          이 모델은 {prev} 시즌 전력(넷레이팅·라인업 시너지·홈코트)으로 계산되어 아래 로스터 변화가 아직 반영되지 않았습니다. 개막 후 경기가
          쌓이면 경기마다 다시 계산됩니다. 반영된 일정은 {outlook.firstGameDate ? fmtDate(outlook.firstGameDate) : "-"} ~{" "}
          {outlook.lastGameDate ? fmtDate(outlook.lastGameDate) : "-"} (KBL 공개분).
        </div>
      </div>
      )}

      {/* 2. 확정 결장 - 명부에는 남아 있지만 이번 시즌엔 못 뛰는 선수들 */}
      {departures && <DepartureImpact report={departures} num={nextNo()} />}

      {/* 3. 외국인 출전 규정 변경 */}
      {importRule && <ImportRule report={importRule} num={nextNo()} />}

      {/* 4. 로스터 이동 지도 */}
      <RosterSection report={roster} num={nextNo()} />

      {/* 5. 데모 경기 */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          <span className={styles.sectionNum}>{nextNo()}</span>개막하면 이렇게 보입니다 - {prev} 실제 경기 10선
        </div>
        <p className={styles.panelLede}>
          경기 페이지는 세 막으로 구성됩니다. 아래 경기들은 지난 시즌에 실제로 열린 경기라 세 막이 전부 채워져 있어서, 개막 후 라이브 경기가
          어떤 모습으로 진행될지 미리 볼 수 있습니다.
        </p>
        <div className={styles.actRow}>
          <div className={styles.actCard}>
            <div className={styles.actNum}>1</div>
            <div className={styles.actTitle}>경기전 프리뷰</div>
            <div className={styles.actBody}>예상 승률, 직전 경기 기반 스카우팅 인사이트(주의할 선수·슛 존·조합), 시즌 평균 비교, 상대 전적.</div>
          </div>
          <div className={styles.actCard}>
            <div className={styles.actNum}>2</div>
            <div className={styles.actTitle}>경기중 문자중계</div>
            <div className={styles.actBody}>플레이마다 갱신되는 승률 그래프, 포제션 단위 피드와 슛 위치, 코트 위 5인 스탯, 중요 승률 변화 알림.</div>
          </div>
          <div className={styles.actCard}>
            <div className={styles.actNum}>3</div>
            <div className={styles.actTitle}>경기후 AI 리포트</div>
            <div className={styles.actBody}>결정적 장면, 흐름을 바꾼 교체, 팀별 스포트라이트, 그리고 경기전 예측이 얼마나 맞았는지 채점.</div>
          </div>
        </div>
        <div className={styles.demoGrid}>
          {demos.map((g) => (
            <DemoCard key={g.gmkey} g={g} />
          ))}
        </div>
        <div className={styles.note}>
          라이브 경기에서는 2막이 실시간으로 채워지고(약 30초 간격 갱신), 종료 후 3막이 생성됩니다. 데모 경기는 이미 종료된 경기라 세 막이 즉시
          열립니다.
        </div>
      </div>

      <footer className="foot">
        {outlook.season} 개막 리포트 · 로스터는 season_roster(확정분), 성적은 game_player_stats, 예정 경기 승률은 pregame_features에서 조회
      </footer>
    </div>
  );
}
