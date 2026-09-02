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

// ── 2. 로스터 이동 지도 - 한 줄 렌더(ChangeLine/statLine)는 팀 프로필과 공유(components/RosterChangeLine.tsx) ──
function TeamCard({ t, abbrOf }: { t: TeamRosterChanges; abbrOf: (tcode: string | null) => string | null }) {
  const rows = [...t.in, ...t.new, ...t.stay, ...t.out];
  const summary = [t.in.length && `영입 ${t.in.length}`, t.new.length && `신입 ${t.new.length}`, t.stay.length && `잔류 ${t.stay.length}`, t.out.length && `이탈 ${t.out.length}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={styles.teamCard} style={{ borderTopColor: t.team.color }}>
      <Link href={`/teams/${t.team.tcode}?season=${PRESEASON_SEASON}`} className={styles.teamCardHead}>
        <TeamBadge team={badgeOf(t.team)} size={22} />
        {t.team.name}
        <span className={styles.teamCardSum}>{summary}</span>
      </Link>
      {rows.map((r) => (
        <ChangeLine key={`${r.change}-${r.name}`} r={r} abbrOf={abbrOf} />
      ))}
    </div>
  );
}

function RosterSection({ report }: { report: RosterChangeReport }) {
  const abbrByTcode = new Map(report.teams.map((t) => [t.team.tcode, t.team.abbr]));
  const abbrOf = (tcode: string | null) => (tcode ? (abbrByTcode.get(tcode) ?? tcode) : null);
  const prev = shortSeason(report.prevSeason);
  return (
    <div className={styles.panel}>
      <div className={styles.panelTitle}>
        <span className={styles.sectionNum}>2</span>외국인 선수 이동 지도
      </div>
      <p className={styles.panelLede}>
        확정 로스터를 {prev} 시즌 출전 기록과 대조한 결과입니다. 이적한 선수는 옛 팀엔 &quot;이탈&quot;, 새 팀엔 &quot;영입&quot;으로 두 번 나타나고, 성적은 그
        선수가 마지막으로 뛴 시즌 기준입니다.
      </p>

      <div className={styles.headlineRow}>
        <div className={styles.headlineTile}>
          <div className={styles.headlineLabel}>팀 간 이동</div>
          <div className={styles.headlineVal}>{report.moves.length}건</div>
          <div className={styles.headlineSub}>
            영입 {report.counts.in} · 신입 {report.counts.new} · 잔류 {report.counts.stay} · 이탈 {report.counts.out}
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
          ? `국내 선수 확정 로스터는 아직 입력 전입니다 - 입력되면 같은 지도에 자동으로 반영되고, 그때까지 이탈 판정은 외국인 선수에 한정합니다. `
          : ""}
        {prev} 시즌 5경기 미만 출전 선수는 이탈 목록에서 제외. &quot;신입&quot;은 KBL 출전 기록이 없는 선수로, 첫 경기 출전 시 프로필이 자동 연결됩니다.
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
  const [outlook, roster, demos] = await Promise.all([getSeasonOutlook(PRESEASON_SEASON), getRosterChangeReport(PRESEASON_SEASON), getDemoGames()]);
  const dday = outlook.firstGameDate ? daysUntilKst(outlook.firstGameDate) : null;
  const ddayLabel = dday == null ? "" : dday > 0 ? `D-${dday}` : dday === 0 ? "D-DAY" : `D+${-dday}`;
  const prev = shortSeason(outlook.prevSeason);
  const cur = shortSeason(outlook.season);
  const foreignCount = roster.counts.in + roster.counts.new + roster.counts.stay;

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
              <div className={styles.heroStatVal}>{foreignCount}</div>
              <div className={styles.heroStatLabel}>확정 외국인·아시아쿼터</div>
            </div>
            <div>
              <div className={styles.heroStatVal}>{roster.moves.length}</div>
              <div className={styles.heroStatLabel}>팀 간 이동</div>
            </div>
          </div>
        </div>
      </div>

      {/* 1. 시즌 전망 */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          <span className={styles.sectionNum}>1</span>코트사이드 시즌 전망 - 기대승수
        </div>
        <p className={styles.panelLede}>
          경기 전 승률 모델이 {cur} 예정 경기 {outlook.nGames}개 각각에 매긴 승률을 팀별로 더한 값입니다. 오른쪽은 {prev} 정규시즌 성적과
          승률 차이(%p).
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

      {/* 2. 로스터 이동 지도 */}
      <RosterSection report={roster} />

      {/* 3. 데모 경기 */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          <span className={styles.sectionNum}>3</span>개막하면 이렇게 보입니다 - {prev} 실제 경기 10선
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
