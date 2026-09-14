import type { Metadata } from "next";
import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getTeams, shortSeason, PRESEASON_SEASON } from "@/lib/preseason";
import {
  LEADER_CATEGORIES,
  LEADER_QUALIFY,
  getLeaderboardSeasons,
  getSeasonLeaderboards,
  type LeaderCategoryKey,
  type LeaderGroup,
  type LeaderRow,
  type Leaderboard,
} from "@/lib/seasonLeaders";
import styles from "./season-leaders.module.css";

// 시즌 리더보드 - 요청("시즌별 리더보드 추가"), 참고 이미지는 Basketball-Reference의
// "League Leaders" 격자. 카테고리마다 1위를 크게 세우고 2~5위를 압축해서 붙인 뒤 나머지는
// <details>로 접는다. 이 사이트 규칙대로 클라이언트 컴포넌트/JS는 하나도 쓰지 않는다 -
// 시즌 선택은 GET 폼, 그룹 탭은 query string 링크, 펼침은 순수 <details>.
//
// 이 페이지에서 절대 지우면 안 되는 것: 카드 하단의 자격 문장(board.qualifyText)과 상단의
// 표본 캡션. 자격 규칙 없는 리더보드는 거짓말이다("3점 5/10 = 50%"가 1위로 올라온다).
export const dynamic = "force-dynamic";

/**
 * 그룹 탭은 URL에 한글이 들어가지 않게 라틴 키로 주고받는다(퍼센트 인코딩된 주소를
 * 사용자가 복사해 나눠도 읽히도록). 값은 lib의 LeaderGroup으로 매핑.
 */
const GROUP_TABS: { key: string; label: string; group: LeaderGroup | null }[] = [
  { key: "all", label: "전체", group: null },
  { key: "basic", label: "기본", group: "기본" },
  { key: "shoot", label: "슈팅", group: "슈팅" },
  { key: "adv", label: "고급", group: "고급" },
];

const GROUP_BLURB: Record<LeaderGroup, string> = {
  기본: "박스스코어 경기당 평균. 출전 경기는 0분 엔트리를 뺀 실제 출전만 셉니다.",
  슈팅: "성공률은 시즌 길이에 맞춰 최소 시도를 요구합니다(팀 경기 수 × 경기당 시도).",
  고급: "출전 시간 가중 평균 또는 사전 집계 지표. 산식은 카드마다 적어 뒀습니다.",
};

/** 값 옆에 붙는 % - LeaderRow.display에는 % 기호가 없다(lib 계약). */
function valueText(board: Leaderboard, row: LeaderRow) {
  return board.unit === "%" ? `${row.display}%` : row.display;
}

/** 압축 행 아래 한 줄: 팀 약어 · 포지션 · 표본. */
function subText(row: LeaderRow) {
  return [row.teamAbbr, row.posLabel || null, row.sample].filter(Boolean).join(" · ");
}

type TeamLogos = Map<string, string | null>;

function badgeFor(row: LeaderRow, logos: TeamLogos) {
  if (!row.teamName || !row.teamAbbr) return null;
  return {
    name: row.teamName,
    abbr: row.teamAbbr,
    color: row.teamColor ?? "#888888",
    logoUrl: row.tcode ? (logos.get(row.tcode) ?? null) : null,
  };
}

function CompactRow({ row, board, tied }: { row: LeaderRow; board: Leaderboard; tied: boolean }) {
  return (
    <Link href={row.href} className={styles.row}>
      <div className={styles.rank}>
        {/* 공동 순위는 숫자를 그대로 반복하고 앞에 =를 붙인다. 임의로 순서를 매겨 감추지 않는다. */}
        {tied && <span className={styles.tie}>=</span>}
        {row.rank}
      </div>
      <div className={styles.rowBody}>
        <div className={styles.rowName}>{row.name}</div>
        <div className={styles.rowSub}>{subText(row)}</div>
      </div>
      <div className={styles.rowValue}>{valueText(board, row)}</div>
    </Link>
  );
}

function LeaderCard({ board, logos }: { board: Leaderboard; logos: TeamLogos }) {
  const top = board.rows[0];
  if (!top) return null;

  // 같은 rank가 두 번 이상 나오면 공동 순위 - 화면에 =로 표시하고 카드 하단에 범례를 단다.
  const rankCount = new Map<number, number>();
  for (const r of board.rows) rankCount.set(r.rank, (rankCount.get(r.rank) ?? 0) + 1);
  const tiedRank = (r: LeaderRow) => (rankCount.get(r.rank) ?? 0) > 1;
  const hasTie = board.rows.some(tiedRank);

  const next = board.rows.slice(1, 5);
  const more = board.rows.slice(5);
  const topBadge = badgeFor(top, logos);

  return (
    <section className={styles.card}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{board.label}</h3>
        {board.unit && board.unit !== "%" && <span className={styles.cardUnit}>{board.unit}</span>}
        <span className={styles.cardPool}>{board.poolN.toLocaleString()}명 중</span>
      </header>

      <div className={styles.hero}>
        <div className={styles.heroValue}>
          {/* Big Shoulders Display는 라틴/숫자 전용 폰트다. 여기에는 숫자만 들어온다. */}
          {top.display}
          {board.unit === "%" && <span className={styles.heroUnit}>%</span>}
        </div>
        <div className={styles.heroBody}>
          <Link href={top.href} className={styles.heroName}>
            {top.name}
          </Link>
          <div className={styles.heroMeta}>
            {topBadge && <TeamBadge team={topBadge} size={16} />}
            <span className={styles.heroTeam}>
              {[top.teamName, top.posLabel || null].filter(Boolean).join(" · ")}
            </span>
            {tiedRank(top) && <span className={styles.tie}>공동 1위</span>}
          </div>
          <div className={styles.heroSample}>{top.sample}</div>
        </div>
      </div>

      {next.length > 0 && (
        <div className={styles.rows}>
          {next.map((r) => (
            <CompactRow key={r.pcode} row={r} board={board} tied={tiedRank(r)} />
          ))}
        </div>
      )}

      {more.length > 0 && (
        <details className={styles.more}>
          <summary className={styles.moreSummary}>
            {more[0].rank}-{more[more.length - 1].rank}위 보기
            <span className={styles.moreCount}>+{more.length}명</span>
          </summary>
          <div className={styles.rows}>
            {more.map((r) => (
              <CompactRow key={r.pcode} row={r} board={board} tied={tiedRank(r)} />
            ))}
          </div>
        </details>
      )}

      <div className={styles.qual}>
        <span className={`${styles.qualTag} ${board.rate ? "" : styles.qualTagOpen}`}>
          {board.rate ? "자격" : "누적"}
        </span>
        {board.qualifyText}
        {board.note && <div className={styles.note}>{board.note}</div>}
        {hasTie && <div className={styles.tieLegend}>= 는 공동 순위(원값이 같아 같은 등수).</div>}
      </div>
    </section>
  );
}

export default async function SeasonLeadersPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; g?: string }>;
}) {
  const { season, g } = await searchParams;

  // 기본 시즌 = "실제로 경기가 있는" 최신 시즌. 개막 전인 2026-2027은 getLeaderboardSeasons가
  // 애초에 빼고 주므로 여기 걸릴 일이 없지만, 사용자가 주소로 직접 넣을 수 있어 폴백을 명시한다.
  const seasons = await getLeaderboardSeasons();
  if (!seasons.length) {
    return (
      <div className="wrap">
        <div className="title">시즌 리더보드</div>
        <div className="empty-note">종료된 정규시즌 경기가 아직 없어 리더보드를 만들 수 없습니다.</div>
      </div>
    );
  }
  const requested = (season ?? "").trim();
  const activeSeason = seasons.includes(requested) ? requested : seasons[0];
  const fellBack = requested && requested !== activeSeason ? requested : null;

  const tab = GROUP_TABS.find((t) => t.key === g) ?? GROUP_TABS[0];
  // 그룹 탭이 걸려 있으면 그 그룹만 계산한다(원본 행 조회는 어차피 한 번, 집계만 줄어든다).
  const wantedKeys: LeaderCategoryKey[] | undefined = tab.group
    ? LEADER_CATEGORIES.filter((c) => c.group === tab.group).map((c) => c.key)
    : undefined;

  const [data, teams] = await Promise.all([
    getSeasonLeaderboards(activeSeason, wantedKeys ? { categories: wantedKeys } : undefined),
    getTeams(activeSeason),
  ]);
  const logos: TeamLogos = new Map([...teams].map(([tcode, t]) => [tcode, t.logoUrl]));

  const groupsShown: LeaderGroup[] = ["기본", "슈팅", "고급"];
  const linkTo = (opts: { season?: string; g?: string }) => {
    const s = opts.season ?? activeSeason;
    const key = opts.g ?? tab.key;
    return key === "all"
      ? `/leaderboards/season?season=${encodeURIComponent(s)}`
      : `/leaderboards/season?season=${encodeURIComponent(s)}&g=${key}`;
  };

  return (
    <div className="wrap">
      <div className={styles.headRow}>
        <div>
          <span className={styles.kicker}>SEASON LEADERS</span>
          <div className="title">시즌 리더보드</div>
        </div>
        <form className={styles.seasonForm} action="/leaderboards/season">
          {tab.key !== "all" && <input type="hidden" name="g" value={tab.key} />}
          <select name="season" defaultValue={activeSeason} aria-label="시즌 선택">
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s} 시즌
              </option>
            ))}
          </select>
          <button type="submit" className="btn-primary">
            시즌 보기
          </button>
        </form>
      </div>

      <p className={styles.lede}>
        한 시즌의 부문별 상위 20명입니다. 이름을 누르면 선수 프로필로 들어갑니다. 평균·성공률
        부문에는 자격 기준을 걸었고, 그 기준과 통과 인원을 카드마다 그대로 적어 뒀습니다 - 기준
        없는 순위표는 3점 5/10을 성공률 1위로 만들기 때문입니다.
      </p>

      <div className={styles.tabs}>
        {GROUP_TABS.map((t) => (
          <Link
            key={t.key}
            href={linkTo({ g: t.key })}
            className={`${styles.tab} ${t.key === tab.key ? styles.tabActive : ""}`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {fellBack && (
        <div className={styles.fallback}>
          {fellBack} 시즌은 아직 종료된 정규시즌 경기가 없어 리더보드를 만들 수 없습니다
          {fellBack === PRESEASON_SEASON ? "(개막 전)" : ""}. 대신 가장 최근 시즌인{" "}
          <strong>{activeSeason}</strong> 기록을 보여줍니다.
        </div>
      )}

      {!data ? (
        <div className="empty-note">{activeSeason} 시즌 정규시즌 기록을 찾지 못했습니다.</div>
      ) : (
        <>
          <div className={styles.basis}>
            <span className={styles.basisLine}>
              <strong>표본</strong> {data.caption}
            </span>
            <span className={styles.basisLine}>
              <strong>자격</strong> {data.qualifyCaption}
            </span>
          </div>

          {groupsShown
            .filter((grp) => !tab.group || tab.group === grp)
            .map((grp) => {
              const boards = data.boards.filter((b) => b.group === grp);
              if (!boards.length) return null;
              return (
                <section key={grp}>
                  <div className={styles.groupHead}>
                    <h2 className={styles.groupName}>{grp}</h2>
                    <span className={styles.groupMeta}>{boards.length}개 부문</span>
                  </div>
                  <p className={styles.lede}>{GROUP_BLURB[grp]}</p>
                  <div className={styles.grid}>
                    {boards.map((b) => (
                      <LeaderCard key={b.key} board={b} logos={logos} />
                    ))}
                  </div>
                </section>
              );
            })}

          <div className={styles.foot}>
            <p>
              <strong>표본</strong> {shortSeason(data.seasonName)} 정규시즌만 집계합니다(플레이오프
              제외). 팀마다 경기 수가 다른 플레이오프를 섞으면 같은 잣대로 순위를 매길 수 없고,
              WPA의 원천 테이블이 애초에 정규시즌 전용이라 부문마다 표본이 달라지는 것을 막았습니다.
            </p>
            <p>
              <strong>출전 경기</strong> 엔트리만 들고 0분을 뛴 경기는 출전으로 세지 않습니다. 그래서
              경기당 평균의 분모는 실제로 코트를 밟은 경기 수입니다.
            </p>
            <p>
              <strong>자격</strong> 평균·성공률 부문은 {LEADER_QUALIFY.gp}경기 <em>또는</em>{" "}
              {LEADER_QUALIFY.min}분 이상. 성공률은 여기에 최소 시도(팀 {data.teamGames}경기 기준)를
              더 요구합니다. 누적 부문(3P 성공, WPA)에는 자격 기준이 없습니다.
            </p>
            <p>
              <strong>동률</strong> 순위는 반올림 전 원값으로 매깁니다. 화면의 소수 1자리가 같아
              보여도 등수가 다를 수 있고(예: 44.4% 36/81 vs 44.4% 59/133), 원값까지 같으면 =를 붙여
              공동 순위로 표시합니다. 값 옆의 표본(성공/시도, 경기·분)이 그 차이를 보여 줍니다.
            </p>
            <p>
              {data.seasonName} 정규시즌 {data.teamGames}경기 기준 · 출전 {data.playersN}명 중 자격
              통과 {data.qualifiedN}명 · 부문당 최대 {data.topN}명 · 경기별 선수 기록과 시즌 WPA
              집계에서 실시간 조회
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export const metadata: Metadata = {
  title: "시즌 리더보드",
  description: "득점·리바운드·어시스트 등 부문별 시즌 순위",
};
