import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { SeasonNav } from "@/components/SeasonNav";
import { DribbleBall } from "@/components/DribbleBall";
import { TeamPlate } from "@/components/TeamPlate";
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
import { teamBarStyle, teamInkStyle } from "@/lib/teamAccent";
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
const GROUP_TABS: { key: string; label: string; group: LeaderGroup | null; categories?: LeaderCategoryKey[] }[] = [
  { key: "overview", label: "핵심", group: null, categories: ["totalPts", "totalReb", "totalAst", "tpm"] },
  { key: "basic", label: "경기당", group: "기본" },
  { key: "total", label: "총량", group: "총량" },
  { key: "shoot", label: "슈팅", group: "슈팅" },
  { key: "adv", label: "고급", group: "고급" },
  { key: "all", label: "전체", group: null },
];

const GROUP_BLURB: Record<LeaderGroup, string> = {
  기본: "박스스코어 경기당 평균. 출전 경기는 0분 엔트리를 뺀 실제 출전만 셉니다.",
  총량: "시즌 누적 합계(자격 기준 없음). 시즌 초반엔 경기당 평균보다 왜곡이 적습니다 - 적게 뛰고 한두 경기 잘한 선수가 평균에서는 과장되지만, 누적 총량은 많이·꾸준히 뛰어야 쌓입니다.",
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

/** 1위 값 대비 비율(%) - 행 뒤 막대 길이. 1위가 0 이하면 막대를 그리지 않는다. */
function barPct(row: LeaderRow, top: LeaderRow) {
  return top.value > 0 ? Math.max(0, Math.min(100, (row.value / top.value) * 100)) : 0;
}

function CompactRow({ row, board, tied, logos }: { row: LeaderRow; board: Leaderboard; tied: boolean; logos: TeamLogos }) {
  const badge = badgeFor(row, logos);
  return (
    <Link
      href={row.href}
      className={styles.row}
      style={{ ...teamBarStyle(row.teamColor), "--w": `${barPct(row, board.rows[0])}%` } as CSSProperties}
    >
      <div className={styles.rank}>
        {/* 공동 순위는 숫자를 그대로 반복하고 앞에 =를 붙인다. 임의로 순서를 매겨 감추지 않는다. */}
        {tied && <span className={styles.tie}>=</span>}
        {row.rank}
      </div>
      {badge ? <TeamPlate team={badge} size={20} /> : <span />}
      <div className={styles.rowBody}>
        <div className={styles.rowName}>{row.name}</div>
        <div className={styles.rowSub}>{subText(row)}</div>
      </div>
      <div className={styles.rowValue}>{valueText(board, row)}</div>
    </Link>
  );
}

function LeaderCard({ board, logos, index }: { board: Leaderboard; logos: TeamLogos; index: number }) {
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
    <section
      className={styles.card}
      style={{ ...teamBarStyle(top.teamColor), ...teamInkStyle(top.teamColor), "--i": Math.min(index, 8) } as CSSProperties}
    >
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
            <span className={styles.heroTeam}>
              {[top.teamName, top.posLabel || null].filter(Boolean).join(" · ")}
            </span>
            {tiedRank(top) && <span className={styles.tie}>공동 1위</span>}
          </div>
          <div className={styles.heroSample}>{top.sample}</div>
        </div>
        {topBadge && <TeamPlate team={topBadge} size={38} />}
      </div>

      {next.length > 0 && (
        <div className={styles.rows}>
          {next.map((r) => (
            <CompactRow key={r.pcode} row={r} board={board} tied={tiedRank(r)} logos={logos} />
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
              <CompactRow key={r.pcode} row={r} board={board} tied={tiedRank(r)} logos={logos} />
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
  const wantedKeys: LeaderCategoryKey[] | undefined = tab.categories ?? (tab.group
    ? LEADER_CATEGORIES.filter((c) => c.group === tab.group).map((c) => c.key)
    : undefined);

  const [data, teams] = await Promise.all([
    getSeasonLeaderboards(activeSeason, wantedKeys ? { categories: wantedKeys } : undefined),
    getTeams(activeSeason),
  ]);
  const logos: TeamLogos = new Map([...teams].map(([tcode, t]) => [tcode, t.logoUrl]));

  const groupsShown: LeaderGroup[] = ["기본", "총량", "슈팅", "고급"];
  const linkTo = (opts: { season?: string; g?: string }) => {
    const s = opts.season ?? activeSeason;
    const key = opts.g ?? tab.key;
    return key === "all"
      ? `/leaderboards/season?season=${encodeURIComponent(s)}`
      : `/leaderboards/season?season=${encodeURIComponent(s)}&g=${key}`;
  };

  return (
    <div className="wrap">
      <SeasonNav
        active="leaders"
        activeSeason={activeSeason}
        seasons={seasons}
        action="/leaderboards/season"
        kicker="SEASON LEADERS"
        title="선수 리더"
        description="득점·리바운드·어시스트부터 슈팅 효율과 고급 지표까지, 표본과 자격 기준을 함께 확인합니다."
        hiddenFields={{ g: tab.key }}
      />

      <p className={styles.lede}>
        {tab.key === "overview"
          ? "먼저 봐야 할 누적 핵심 부문입니다. 아래 탭에서 경기당 평균·성공률·고급 지표 또는 전체 부문으로 넓혀 보세요."
          : "부문별 상위 20명입니다. 평균·성공률에는 최소 출전과 시도 자격을 적용하고, 카드마다 표본을 함께 표시합니다."}
      </p>

      <div className={styles.tabs}>
        {GROUP_TABS.map((t) => (
          <Link
            key={t.key}
            href={linkTo({ g: t.key })}
            className={`${styles.tab} ${t.key === tab.key ? styles.tabActive : ""}`}
            aria-current={t.key === tab.key ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {data?.qualify.relaxed && (
        <aside className={styles.early} aria-label="시즌 초반 자격 기준">
          <DribbleBall />
          <div className={styles.earlyBody}>
            <strong>시즌 초반이라 자격 기준을 낮춰 적용 중입니다</strong>
            <p>
              팀 {data.teamGames}경기 시점 · {data.qualify.gp}경기 이상 출전 + 누적 {data.qualify.min}분 이상이면 순위에 오릅니다.
              경기가 쌓이면 기준이 자동으로 올라가 팀 {data.qualify.fullAt}경기부터 원래 기준({LEADER_QUALIFY.gp}경기 또는{" "}
              {LEADER_QUALIFY.min}분)이 됩니다.
            </p>
            <div
              className={styles.meter}
              role="progressbar"
              aria-label="원래 자격 기준 복귀까지"
              aria-valuemin={0}
              aria-valuemax={data.qualify.fullAt}
              aria-valuenow={Math.min(data.teamGames, data.qualify.fullAt)}
            >
              <i style={{ width: `${Math.min(100, (data.teamGames / data.qualify.fullAt) * 100)}%` }} />
            </div>
            <small>
              {data.teamGames} / {data.qualify.fullAt}경기
            </small>
          </div>
        </aside>
      )}

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
                    {boards.map((b, i) => (
                      <LeaderCard key={b.key} board={b} logos={logos} index={i} />
                    ))}
                    {grp === "고급" && (
                      // 옛 WPA 카드 자리. 선수 시즌 WPA 합계는 득점과 r=0.991이라 득점 카드와 같은 순위였다.
                      <Link href={`/leaderboards/win-contribution?season=${encodeURIComponent(data.seasonName)}`} className={`${styles.card} ${styles.pointerCard}`}>
                        <span className={styles.cardTitle}>WPA는 여기로 옮겼습니다</span>
                        <span className={styles.pointerText}>
                          선수 시즌 WPA 합계는 득점과 거의 같은 순위(상관 0.99)라 순위표 대신, 경기 승률을 가장 크게 움직인 장면과 역전
                          경기로 보여 줍니다.
                        </span>
                        <span className={styles.pointerLink}>승부를 가른 순간 보기</span>
                      </Link>
                    )}
                  </div>
                </section>
              );
            })}

          <div className={styles.foot}>
            <p>
              <strong>표본</strong> {shortSeason(data.seasonName)} 정규시즌만 집계합니다(플레이오프
              제외). 팀마다 경기 수가 다른 플레이오프를 섞으면 같은 잣대로 순위를 매길 수 없기 때문입니다.
            </p>
            <p>
              <strong>출전 경기</strong> 엔트리만 들고 0분을 뛴 경기는 출전으로 세지 않습니다. 그래서
              경기당 평균의 분모는 실제로 코트를 밟은 경기 수입니다.
            </p>
            <p>
              <strong>자격</strong> 평균·성공률 부문은 {LEADER_QUALIFY.gp}경기 <em>또는</em>{" "}
              {LEADER_QUALIFY.min}분 이상.
              {data.qualify.relaxed && (
                <>
                  {" "}
                  단 시즌 초반(팀 {data.qualify.fullAt - 1}경기까지)에는 팀 경기 수에 맞춰 완화합니다: 현재 팀 {data.teamGames}경기
                  기준 <em>{data.qualify.gp}경기 이상 출전 + 누적 {data.qualify.min}분 이상</em>(경기만 채운 단시간 출전 제외).
                </>
              )}{" "}
              성공률은 여기에 최소 시도(팀 {data.teamGames}경기 기준)를 더 요구합니다. 누적 부문(총량·3P 성공)에는 자격 기준이
              없습니다.
            </p>
            <p>
              <strong>동률</strong> 순위는 반올림 전 원값으로 매깁니다. 화면의 소수 1자리가 같아
              보여도 등수가 다를 수 있고(예: 44.4% 36/81 vs 44.4% 59/133), 원값까지 같으면 =를 붙여
              공동 순위로 표시합니다. 값 옆의 표본(성공/시도, 경기·분)이 그 차이를 보여 줍니다.
            </p>
            <p>
              {data.seasonName} 정규시즌 {data.teamGames}경기 기준 · 출전 {data.playersN}명 중 자격
              통과 {data.qualifiedN}명 · 부문당 최대 {data.topN}명 · 경기별 선수 기록에서 집계
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
