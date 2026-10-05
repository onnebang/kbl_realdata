import type { Metadata } from "next";
import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getLeaderboardSeasons } from "@/lib/seasonLeaders";
import { getRoundMvp, type RoundMvpRow } from "@/lib/roundAwards";
import styles from "@/app/leaderboards/season/season-leaders.module.css";

// 라운드 MVP(국내/용병/아시아쿼터) - 기존 시즌 리더보드와 같은 카드 뼈대(hero + 압축 행)를
// 그대로 쓴다. 계산은 lib/roundAwards.ts: 라운드 경기들의 game_player_stats를
// aggregateSeasonPlayers(시즌 리더보드와 같은 함수)로 집계하고, 출전시간 가중 PER 평균으로
// 줄 세운다. 선정은 순수 스탯 기준이고 팀 성적·서사는 반영하지 않는다는 점을 캡션에 남긴다.
export const dynamic = "force-dynamic";

function ppg(r: RoundMvpRow) {
  return r.gp ? (r.pts / r.gp).toFixed(1) : "0.0";
}
function rpg(r: RoundMvpRow) {
  return r.gp ? (r.reb / r.gp).toFixed(1) : "0.0";
}
function apg(r: RoundMvpRow) {
  return r.gp ? (r.ast / r.gp).toFixed(1) : "0.0";
}

function HeroCard({ r }: { r: RoundMvpRow }) {
  const badge = r.team ? { name: r.team.name, abbr: r.team.abbr, color: r.team.color, logoUrl: r.team.logoUrl } : null;
  return (
    <div className={styles.hero}>
      <div className={styles.heroValue}>
        {r.perW.toFixed(1)}
        <span className={styles.heroUnit}>PER</span>
      </div>
      <div className={styles.heroBody}>
        <Link href={`/players/${r.pcode}`} className={styles.heroName}>
          {r.name}
        </Link>
        <div className={styles.heroMeta}>
          {badge && <TeamBadge team={badge} size={16} />}
          <span className={styles.heroTeam}>
            {[r.team?.name, r.posLabel || null].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className={styles.heroSample}>
          {r.gp}경기 · {ppg(r)} PPG · {rpg(r)} RPG · {apg(r)} APG
        </div>
      </div>
    </div>
  );
}

function CompactRow({ r, rank }: { r: RoundMvpRow; rank: number }) {
  return (
    <Link href={`/players/${r.pcode}`} className={styles.row}>
      <div className={styles.rank}>{rank}</div>
      <div className={styles.rowBody}>
        <div className={styles.rowName}>{r.name}</div>
        <div className={styles.rowSub}>
          {[r.team?.abbr, r.posLabel || null, `${r.gp}경기`].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className={styles.rowValue}>{r.perW.toFixed(1)}</div>
    </Link>
  );
}

export default async function RoundMvpPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; round?: string }>;
}) {
  const { season, round } = await searchParams;

  const seasons = await getLeaderboardSeasons();
  if (!seasons.length) {
    return (
      <div className="wrap">
        <div className="title">라운드 MVP</div>
        <div className="empty-note">종료된 정규시즌 경기가 아직 없어 라운드 MVP를 만들 수 없습니다.</div>
      </div>
    );
  }
  const requested = (season ?? "").trim();
  const activeSeason = seasons.includes(requested) ? requested : seasons[0];
  const fellBack = requested && requested !== activeSeason ? requested : null;

  const requestedRound = Number(round);
  const result = await getRoundMvp(activeSeason, Number.isFinite(requestedRound) && requestedRound > 0 ? requestedRound : undefined);

  const linkTo = (opts: { season?: string; round?: number }) =>
    `/awards/round-mvp?season=${encodeURIComponent(opts.season ?? activeSeason)}&round=${opts.round ?? result.round}`;

  return (
    <div className="wrap">
      <div className={styles.headRow}>
        <div>
          <span className={styles.kicker}>ROUND MVP</span>
          <div className="title">라운드 MVP</div>
        </div>
        <form className={styles.seasonForm} action="/awards/round-mvp">
          <select name="season" defaultValue={activeSeason} aria-label="시즌 선택">
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s} 시즌
              </option>
            ))}
          </select>
          <select name="round" defaultValue={result.round} aria-label="라운드 선택">
            {Array.from({ length: result.roundCount }, (_, i) => i + 1).map((r) => (
              <option key={r} value={r}>
                {r}라운드
              </option>
            ))}
          </select>
          <button type="submit" className="btn-primary">
            보기
          </button>
        </form>
      </div>

      <p className={styles.lede}>
        그 라운드 종료 경기의 출전시간 가중 PER 평균 기준입니다(팀 성적·서사는 반영하지 않습니다).
        자격: {result.qualify.gp}경기 또는 {result.qualify.minutes}분 이상 - 시즌 리더보드 자격(15경기 또는
        300분)을 라운드 최대 경기 수에 맞춰 스케일했습니다.
      </p>

      {fellBack && (
        <div className={styles.fallback}>
          {fellBack} 시즌은 아직 종료된 정규시즌 경기가 없어 라운드 MVP를 만들 수 없습니다. 대신 가장
          최근 시즌인 <strong>{activeSeason}</strong> 기록을 보여줍니다.
        </div>
      )}

      <div className={styles.basis}>
        <span className={styles.basisLine}>
          <strong>{result.round}라운드</strong> ({result.roundCount}라운드 중) · 종료 경기 {result.gamesEnded}/
          {result.gamesTotal}
        </span>
      </div>

      {result.gamesEnded === 0 ? (
        <div className="empty-note">이 라운드는 아직 끝난 경기가 없습니다.</div>
      ) : (
        <div className={styles.grid}>
          {result.boards.map((b) => (
            <section key={b.role} className={styles.card}>
              <header className={styles.cardHead}>
                <h3 className={styles.cardTitle}>{b.label} MVP</h3>
                <span className={styles.cardPool}>{b.poolN.toLocaleString()}명 중</span>
              </header>
              {b.rows.length === 0 ? (
                <div className={styles.note}>이 라운드엔 자격을 통과한 {b.label} 선수가 없습니다.</div>
              ) : (
                <>
                  <HeroCard r={b.rows[0]} />
                  {b.rows.length > 1 && (
                    <div className={styles.rows}>
                      {b.rows.slice(1).map((r, i) => (
                        <CompactRow key={r.pcode} r={r} rank={i + 2} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          ))}
        </div>
      )}

      <div className={styles.foot}>
        <p>
          <strong>PER</strong>은 경기별 PER의 출전시간 가중 평균입니다(짧게 뛴 경기가 과대 반영되지
          않도록).
        </p>
        <p>
          <Link href={linkTo({ round: Math.max(1, result.round - 1) })}>← {Math.max(1, result.round - 1)}라운드</Link>
          {" · "}
          <Link href={linkTo({ round: Math.min(result.roundCount, result.round + 1) })}>
            {Math.min(result.roundCount, result.round + 1)}라운드 →
          </Link>
        </p>
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  title: "라운드 MVP",
  description: "라운드별 국내/용병/아시아쿼터 MVP - 출전시간 가중 PER 평균 기준",
};
