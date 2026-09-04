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
  getSeasonProjection,
  type ProjectionTeam,
  type SeasonProjection,
} from "@/lib/seasonProjection";
import { DepartureImpact } from "@/components/DepartureImpact";
import { ImportRule } from "@/components/ImportRule";
import { getDepartureReport } from "@/lib/departureImpact";
import { getImportRuleReport } from "@/lib/importRule";
import styles from "./preseason.module.css";

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
        <span className={styles.outlookValBig}>{t.expWins.toFixed(1)}승</span>
        <span className={styles.outlookValSub}>/ {t.gp}경기 · {pct(t.expPct)}</span>
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
  const max = Math.max(...t.rankDist);
  return (
    <div className={styles.rankStrip} title={`순위 분포 · 최빈 ${t.modalRank}위`}>
      {t.rankDist.map((p, i) => (
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
  const span = Math.max(1, hi - lo);
  const left = ((t.winsLo - lo) / span) * 100;
  const width = ((t.winsHi - t.winsLo) / span) * 100;
  const dot = ((t.fullExp - lo) / span) * 100;
  const half = ((GAMES_FULL / 2 - lo) / span) * 100;
  return (
    // --tc: 팀 색을 원색 그대로 쓰면 남색 계열(부산 KCC)이 다크 배경에서 사라진다.
    // CSS 쪽에서 잉크와 섞어 두 테마 모두 최소 대비를 갖게 한다.
    <Link
      href={`/teams/${t.tcode}?season=${PRESEASON_SEASON}`}
      className={styles.projRow}
      style={{ "--tc": t.color } as CSSProperties}
    >
      <div className={styles.outlookRank}>{t.expRank}</div>
      <div className={styles.outlookTeam}>
        <TeamBadge team={badgeOf(t)} size={22} />
        <span>{t.name}</span>
      </div>
      <div className={styles.projHalf}>{t.halfExp.toFixed(1)}</div>
      <div className={styles.projFull}>{t.fullExp.toFixed(1)}</div>
      <div className={styles.projTrack} title={`80% 구간 ${t.winsLo}~${t.winsHi}승 · 기대 ${t.fullExp.toFixed(1)}승`}>
        {half >= 0 && half <= 100 && <span className={styles.projEven} style={{ left: `${half}%` }} />}
        <span className={styles.projBand} style={{ left: `${left}%`, width: `${width}%` }} />
        <span className={styles.projDot} style={{ left: `${dot}%` }} />
      </div>
      <RankStrip t={t} />
      <div className={styles.projOdds}>{Math.round(t.titleOdds * 100)}%</div>
      <div className={styles.projOdds}>{Math.round(t.playoffOdds * 100)}%</div>
      <div className={styles.outlookPrev}>
        {t.prevW}-{t.prevL}
      </div>
    </Link>
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
  const lo = Math.min(...proj.teams.map((t) => t.winsLo)) - 1;
  const hi = Math.max(...proj.teams.map((t) => t.winsHi)) + 1;
  const m = proj.matrix;
  return (
    <div className={styles.panel}>
      <div className={styles.panelTitle}>
        <span className={styles.sectionNum}>1</span>코트사이드 시즌 전망 - 정규시즌 {GAMES_FULL}경기 기대승수와 AI 예상 순위
      </div>
      <p className={styles.panelLede}>
        KBL 정규시즌은 상대별 홈 3 · 원정 3으로 {ROUNDS_TOTAL}라운드 {GAMES_FULL}경기입니다. KBL이 지금까지 공개한 일정은{" "}
        {proj.scheduledN}경기로 팀당 24~27경기라, 그대로 더하면 팀끼리 비교가 안 됩니다. 그래서 두 기준을 나란히 놓습니다 — 전반기{" "}
        {ROUNDS_HALF}라운드({GAMES_HALF}경기)와 정규시즌 전체({GAMES_FULL}경기).
      </p>
      <div className={styles.outlookGrid}>
        <div className={`${styles.projRow} ${styles.outlookHead}`}>
          <div />
          <div>팀</div>
          <div style={{ textAlign: "right" }}>전반기 {GAMES_HALF}G</div>
          <div style={{ textAlign: "right" }}>전체 {GAMES_FULL}G</div>
          <div>승수 80% 구간 (가운데 눈금 27승)</div>
          <div>순위 분포 1→{proj.teams.length}위</div>
          <div style={{ textAlign: "right" }}>1위</div>
          <div style={{ textAlign: "right" }}>PO</div>
          <div className={styles.outlookPrev}>{prev} 정규</div>
        </div>
        {proj.teams.map((t) => (
          <ProjectionRow key={t.tcode} t={t} lo={lo} hi={hi} />
        ))}
      </div>
      <div className={styles.note}>
        전반기는 공개된 일정 {proj.scheduledN}경기에 매겨진 승률 그대로이고, 상대별 3경기를 못 채운 {proj.halfFilledN}경기만 보탠 것입니다 —
        그 경기들은 홈/원정이 아직 안 정해져 양쪽 홈 승률의 평균을 썼습니다. 전체 {GAMES_FULL}경기는 일정과 무관하게 매치업 승률만으로
        결정됩니다({m.tcodes.length}팀 × 9상대 × {ROUNDS_TOTAL}). 매치업 {m.tcodes.length * (m.tcodes.length - 1)}쌍 중 {m.fromModel}쌍은
        모델이 직접 매긴 값이고, 아직 그 방향으로 편성되지 않은 {m.filled}쌍은 반대 방향 승률을 홈코트 이점(동급 팀끼리 홈{" "}
        {Math.round(m.hcaProb * 1000) / 10}%)으로 뒤집어 채운 추정입니다.
      </div>
      <div className={styles.note}>
        1위·PO 확률과 승수 구간은 같은 {GAMES_FULL}경기 일정을 {proj.sims.toLocaleString()}번 돌린 결과입니다(6강 플레이오프 기준). 기대승수가
        비슷해도 순위 분포는 다를 수 있고, 실제 시즌은 이 분포 안 어느 한 점입니다.
      </div>
      <div className={styles.note}>
        <b>이 표가 아직 모르는 것.</b> 승률은 {prev} 전력(넷레이팅·라인업 시너지·홈코트)으로만 계산됩니다. 그래서{" "}
        {knows.departures != null && <>{cur}에 뛰지 않는 것이 확정된 {knows.departures}명도, </>}
        {knows.ruleChange && <>2·3쿼터 외국인 2명 동시 출전을 허용하는 규정 변경도, </>}로스터 이동도 반영되어 있지 않습니다. 아래 섹션들이 그
        차이를 각각 측정합니다 - 다만 그 어느 것도 승수로 환산되지 않으니, 이 표의 숫자를 손으로 더하거나 빼지 마십시오(왜 그럴 수 없는지는 각
        섹션 각주에 적어 두었습니다). {cur} 개막 후 경기가 쌓이면 모델이 실제 결과로 다시 계산됩니다.
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
      <div className={styles.demoCta}>리플레이 열기 →</div>
    </Link>
  );
}

export default async function PreseasonPage() {
  const [outlook, roster, demos, proj, departures, importRule] = await Promise.all([
    getSeasonOutlook(PRESEASON_SEASON),
    getRosterChangeReport(PRESEASON_SEASON),
    getDemoGames(),
    getSeasonProjection(PRESEASON_SEASON),
    // 둘 다 없으면 해당 섹션만 빠지고 나머지 페이지는 그대로 - 확정 명단/슬롯 집계가 아직
    // 없는 시즌에도 개막 리포트는 열려야 한다.
    getDepartureReport(PRESEASON_SEASON),
    getImportRuleReport(PRESEASON_SEASON),
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
