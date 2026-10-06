import type { Metadata } from "next";
import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getLeaderboardSeasons } from "@/lib/seasonLeaders";
import { getRoundAwards, type AllStarTeam, type RoundAwardRow } from "@/lib/roundAwards";
import type { BigPlay, Comeback } from "@/lib/winMoments";
import styles from "@/app/leaderboards/season/season-leaders.module.css";

// 라운드 어워드 - MVP(국내/용병/아시아쿼터) + 포지션별 베스트(G/F/C 1~3위) + 코트사이드
// 올스타팀(퍼스트/세컨드/써드, 2가드+2포워드+1센터) + 최고의 순간(역전승 top5) + 가장
// 임팩트있는 장면(개인 플레이 top10, 2026-10-06 사용자 요청). 올스타팀까지는 기존 시즌
// 리더보드와 같은 카드 뼈대(hero + 압축 행)를 그대로 쓴다. 계산은 lib/roundAwards.ts:
// 라운드 경기들의 game_player_stats를 aggregateSeasonPlayers(시즌 리더보드와 같은 함수)로
// 집계하고, 출전시간 가중 PER 평균으로 줄 세운다. 선정은 순수 스탯 기준이고 팀 성적·서사는
// 반영하지 않는다는 점을 캡션에 남긴다. 최고의 순간/임팩트있는 장면은 lib/winMoments.ts의
// season_big_plays·season_comebacks RPC(기존 "승부를 가른 순간" 페이지가 쓰는 것과 동일)를
// 그 라운드 gmkey로만 걸러서 재사용 - 새 RPC를 만들지 않았다.
export const dynamic = "force-dynamic";

type Board = { label: string; poolN: number; rows: RoundAwardRow[] };

function ppg(r: RoundAwardRow) {
  return r.gp ? (r.pts / r.gp).toFixed(1) : "0.0";
}
function rpg(r: RoundAwardRow) {
  return r.gp ? (r.reb / r.gp).toFixed(1) : "0.0";
}
function apg(r: RoundAwardRow) {
  return r.gp ? (r.ast / r.gp).toFixed(1) : "0.0";
}

function HeroCard({ r }: { r: RoundAwardRow }) {
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

function CompactRow({ r, rank }: { r: RoundAwardRow; rank: number }) {
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

function BoardCard({ board, titleSuffix }: { board: Board; titleSuffix: string }) {
  return (
    <section className={styles.card}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>
          {board.label} {titleSuffix}
        </h3>
        <span className={styles.cardPool}>{board.poolN.toLocaleString()}명 중</span>
      </header>
      {board.rows.length === 0 ? (
        <div className={styles.note}>이 라운드엔 자격을 통과한 {board.label} 선수가 없습니다.</div>
      ) : (
        <>
          <HeroCard r={board.rows[0]} />
          {board.rows.length > 1 && (
            <div className={styles.rows}>
              {board.rows.slice(1).map((r, i) => (
                <CompactRow key={r.pcode} r={r} rank={i + 2} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** 올스타팀 한 팀(5명) - 순위가 아니라 포지션 배정이라 번호 대신 포지션을 왼쪽에 쓴다. */
function AllStarRow({ r }: { r: RoundAwardRow }) {
  return (
    <Link href={`/players/${r.pcode}`} className={styles.row}>
      <div className={styles.rank}>{r.pos ?? "-"}</div>
      <div className={styles.rowBody}>
        <div className={styles.rowName}>{r.name}</div>
        <div className={styles.rowSub}>{[r.team?.abbr, `${r.gp}경기`].filter(Boolean).join(" · ")}</div>
      </div>
      <div className={styles.rowValue}>{r.perW.toFixed(1)}</div>
    </Link>
  );
}

function AllStarCard({ team }: { team: AllStarTeam }) {
  return (
    <section className={styles.card}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{team.label}</h3>
        <span className={styles.cardPool}>PER</span>
      </header>
      {team.players.length === 0 ? (
        <div className={styles.note}>이 라운드엔 자격을 통과한 선수가 모자라 팀을 채우지 못했습니다.</div>
      ) : (
        <div className={styles.rows}>
          {team.players.map((r) => (
            <AllStarRow key={r.pcode} r={r} />
          ))}
        </div>
      )}
    </section>
  );
}

function MomentRow({ c, rank }: { c: Comeback; rank: number }) {
  const winnerBadge = { name: c.winner.name, abbr: c.winner.abbr, color: c.winner.color ?? "#888888", logoUrl: c.winner.logoUrl };
  return (
    <Link href={`/games/${c.gmkey}`} className={styles.row}>
      <div className={styles.rank}>{rank}</div>
      <div className={styles.rowBody}>
        <div className={styles.rowName}>
          <TeamBadge team={winnerBadge} size={16} /> {c.winner.name} {c.finalWinner}-{c.finalLoser} {c.loser.name}
        </div>
        <div className={styles.rowSub}>
          {c.period} {c.clock} 승률 {(c.minProb * 100).toFixed(1)}%까지 떨어졌다가 역전승
        </div>
      </div>
      <div className={styles.rowValue}>{(c.minProb * 100).toFixed(0)}%</div>
    </Link>
  );
}

function ImpactRow({ p, rank }: { p: BigPlay; rank: number }) {
  const badge = { name: p.team.name, abbr: p.team.abbr, color: p.team.color ?? "#888888", logoUrl: p.team.logoUrl };
  return (
    <Link href={`/players/${p.pcode}`} className={styles.row}>
      <div className={styles.rank}>{rank}</div>
      <div className={styles.rowBody}>
        <div className={styles.rowName}>
          <TeamBadge team={badge} size={16} /> {p.playerName}
        </div>
        <div className={styles.rowSub}>
          {p.team.abbr} {p.period} {p.clock} {p.shot} vs {p.opp.abbr} · {p.teamScore}-{p.oppScore}
        </div>
      </div>
      <div className={styles.rowValue}>+{(p.wpa * 100).toFixed(1)}%p</div>
    </Link>
  );
}

export default async function RoundAwardsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; round?: string }>;
}) {
  const { season, round } = await searchParams;

  const seasons = await getLeaderboardSeasons();
  if (!seasons.length) {
    return (
      <div className="wrap">
        <div className="title">라운드 어워드</div>
        <div className="empty-note">종료된 정규시즌 경기가 아직 없어 라운드 어워드를 만들 수 없습니다.</div>
      </div>
    );
  }
  const requested = (season ?? "").trim();
  const activeSeason = seasons.includes(requested) ? requested : seasons[0];
  const fellBack = requested && requested !== activeSeason ? requested : null;

  const requestedRound = Number(round);
  const result = await getRoundAwards(activeSeason, Number.isFinite(requestedRound) && requestedRound > 0 ? requestedRound : undefined);

  const linkTo = (opts: { season?: string; round?: number }) =>
    `/awards/round?season=${encodeURIComponent(opts.season ?? activeSeason)}&round=${opts.round ?? result.round}`;

  return (
    <div className="wrap">
      <div className={styles.headRow}>
        <div>
          <span className={styles.kicker}>ROUND AWARDS</span>
          <div className="title">라운드 어워드</div>
        </div>
        <form className={styles.seasonForm} action="/awards/round">
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
          {fellBack} 시즌은 아직 종료된 정규시즌 경기가 없어 라운드 어워드를 만들 수 없습니다. 대신 가장
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
        <>
          <div className={styles.groupHead}>
            <h2 className={styles.groupName}>라운드 MVP</h2>
            <span className={styles.groupMeta}>국내 · 용병 · 아시아쿼터</span>
          </div>
          <div className={styles.grid}>
            {result.mvpBoards.map((b) => (
              <BoardCard key={b.role} board={b} titleSuffix="MVP" />
            ))}
          </div>

          <div className={styles.groupHead}>
            <h2 className={styles.groupName}>포지션별 베스트</h2>
            <span className={styles.groupMeta}>가드 · 포워드 · 센터, 포지션별 1~3위</span>
          </div>
          <div className={styles.grid}>
            {result.positionBoards.map((b) => (
              <BoardCard key={b.pos} board={b} titleSuffix="베스트" />
            ))}
          </div>

          <div className={styles.groupHead}>
            <h2 className={styles.groupName}>코트사이드 올스타팀</h2>
            <span className={styles.groupMeta}>퍼스트 · 세컨드 · 써드, 가드 2 · 포워드 2 · 센터 1</span>
          </div>
          <div className={styles.grid}>
            {result.allStarTeams.map((t) => (
              <AllStarCard key={t.tier} team={t} />
            ))}
          </div>

          <div className={styles.groupHead}>
            <h2 className={styles.groupName}>코트사이드 최고의 순간</h2>
            <span className={styles.groupMeta}>이 라운드 가장 극적인 역전승 top{Math.min(5, result.bestMoments.length)}</span>
          </div>
          {result.bestMoments.length === 0 ? (
            <div className="empty-note">이 라운드엔 역전승 기록이 없습니다(한쪽이 쭉 앞선 경기들뿐).</div>
          ) : (
            <div className={styles.rows}>
              {result.bestMoments.map((c, i) => (
                <MomentRow key={c.gmkey} c={c} rank={i + 1} />
              ))}
            </div>
          )}

          <div className={styles.groupHead}>
            <h2 className={styles.groupName}>코트사이드 가장 임팩트있는 장면</h2>
            <span className={styles.groupMeta}>경기당 승률을 가장 크게 끌어올린 플레이 top{Math.min(10, result.impactPlays.length)}</span>
          </div>
          {result.impactPlays.length === 0 ? (
            <div className="empty-note">이 라운드엔 집계된 장면이 없습니다.</div>
          ) : (
            <div className={styles.rows}>
              {result.impactPlays.map((p, i) => (
                <ImpactRow key={`${p.gmkey}-${p.pcode}-${p.elapsed}`} p={p} rank={i + 1} />
              ))}
            </div>
          )}
        </>
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
  title: "라운드 어워드",
  description: "라운드별 MVP·포지션별 베스트·코트사이드 올스타팀(퍼스트/세컨드/써드)·최고의 순간·가장 임팩트있는 장면",
};
