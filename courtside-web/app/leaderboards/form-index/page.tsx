import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import {
  getSeasonsWithFormData,
  getFormIndexLeaderboard,
  type FormSortKey,
  FORM_WINDOWS,
  formWindowLabel,
  MIN_ATTEMPTS,
  MIN_RECENT_GAMES,
} from "@/lib/formIndex";
import styles from "./form-index.module.css";

// web/form_index_template.html 리디자인 이식. 원본은 정적 스냅샷(2025-26 시즌 고정, JS로
// delta 내림차순 클라이언트 정렬)이었지만 이 프로젝트는 시즌 선택형 + 서버 쿼리파라미터
// 정렬(다른 리더보드 페이지들과 동일 컨벤션)로 일반화. 비주얼(--hot/--cold 다이버징 컬러,
// HOT/COLD 2컬럼 바 리스트, 정렬 가능 테이블, explain-box 문구)은 템플릿 그대로.
const COLUMNS: { key: FormSortKey; label: string }[] = [
  { key: "games", label: "GP" },
  { key: "attempts", label: "FGA" },
  { key: "actualPts", label: "실제" },
  { key: "expectedPts", label: "기대(xPts)" },
  { key: "delta", label: "델타" },
  // 기본 정렬이 되는 열. 원시 합계(델타)는 많이 던진 선수를 구조적으로 불리하게 만든다 -
  // 25-26에서 시도 1위(1,091개) 자밀 워니가 합계로는 113/119위, 100슛당으로는 74/119위다.
  { key: "deltaPer100", label: "100슛당" },
];

function fmtDelta(v: number) {
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

export default async function FormIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; sort?: string; dir?: string; win?: string }>;
}) {
  const { season, sort, dir, win } = await searchParams;
  const seasons = await getSeasonsWithFormData();
  const activeSeason = season ?? seasons[0];
  const sortKey = (COLUMNS.find((c) => c.key === sort)?.key ?? "deltaPer100") as FormSortKey;
  // 창(경기 수). 0 = 시즌 전체. 목록에 없는 값이 들어오면 기본 5경기.
  const parsedWin = Number(win);
  const activeWin = (FORM_WINDOWS as readonly number[]).includes(parsedWin) ? parsedWin : 5;
  const ascending = dir === "asc";

  const rows = await getFormIndexLeaderboard(activeSeason, activeWin, sortKey, ascending);

  // 다이버징 HOT/COLD 리스트는 테이블 정렬 상태와 무관하게 항상 delta 내림차순 기준(템플릿의
  // renderDivergeLists()와 동일 - byDeltaDesc를 테이블 정렬과 별도로 계산).
  const byDeltaDesc = rows.slice().sort((a, b) => b.deltaPer100 - a.deltaPer100);
  const hot = byDeltaDesc.slice(0, 8);
  const cold = byDeltaDesc.slice(-8).reverse();

  const sortLink = (key: FormSortKey) => {
    const nextDir = sortKey === key && !ascending ? "asc" : "desc";
    return `?season=${encodeURIComponent(activeSeason)}&win=${activeWin}&sort=${key}&dir=${nextDir}`;
  };

  const barRow = (r: (typeof rows)[number], i: number, tone: "hot" | "cold") => (
    <div className={styles.barRow} key={r.pcode}>
      <div className={styles.barRank}>{i + 1}</div>
      <div className={styles.barNameWrap}>
        <div className={styles.barName}>{r.playerName}</div>
        <div className={styles.barTeam}>{r.teamName}</div>
      </div>
      <div className={`${styles.barVal} ${tone === "hot" ? styles.lbDeltaHot : styles.lbDeltaCold}`}>
        {fmtDelta(r.deltaPer100)}
      </div>
    </div>
  );

  return (
    <div className={styles.pageRoot}>
      <div className={styles.wrap}>
        <div className={styles.title}>폼 지수</div>
        <div className={styles.subtitle}>
          Form Index - 최근 5경기 동안 이 선수가 시도한 슛들의 <b>난이도 대비 기대득점(xPts)</b>과{" "}
          <b>실제 득점</b>을 비교. 양수가 클수록 &ldquo;어려운 슛도 잘 들어가는 중&rdquo;(핫), 음수가
          클수록 &ldquo;쉬운 찬스도 놓치는 중&rdquo;(콜드). {activeSeason} 시즌 각 선수의 최근 5경기
          기준(최소 {MIN_RECENT_GAMES}경기 데이터거나 시도 {MIN_ATTEMPTS}회 미만인 선수는 제외).
        </div>

        {/* 창 선택을 같은 폼에 둔다 - 따로 두면 시즌을 바꿀 때 창이 초기화된다.
            정렬(sort/dir)은 hidden으로 실어 보내 제출해도 정렬이 풀리지 않게 한다. */}
        <form className={styles.seasonForm}>
          <select name="season" defaultValue={activeSeason} className={styles.seasonSelect}>
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s} 시즌
              </option>
            ))}
          </select>
          <select name="win" defaultValue={String(activeWin)} className={styles.seasonSelect}>
            {FORM_WINDOWS.map((w) => (
              <option key={w} value={w}>
                {formWindowLabel(w)}
              </option>
            ))}
          </select>
          <input type="hidden" name="sort" value={sortKey} />
          <input type="hidden" name="dir" value={ascending ? "asc" : "desc"} />
          <button type="submit" className={styles.seasonSubmit}>
            보기
          </button>
        </form>

        <div className={styles.panel}>
          <div className={styles.panelTitle}>지금 가장 핫한 / 콜드한 선수</div>
          {rows.length ? (
            <div className={styles.divergeCols}>
              <div>
                <div className={`${styles.divergeColTitle} ${styles.hot}`}>🔥 HOT</div>
                <div>{hot.map((r, i) => barRow(r, i, "hot"))}</div>
              </div>
              <div>
                <div className={`${styles.divergeColTitle} ${styles.cold}`}>🧊 COLD</div>
                <div>{cold.map((r, i) => barRow(r, i, "cold"))}</div>
              </div>
            </div>
          ) : (
            <div className={styles.emptyNote}>이 시즌은 표본 기준을 충족하는 선수가 없음</div>
          )}
        </div>

        <div className={styles.panel}>
          <div className={styles.panelTitle}>전체 순위 (열 제목을 클릭하면 정렬)</div>
          <div className={styles.tableScroll}>
            <table className={styles.lbTable}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>선수</th>
                  <th>팀</th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={sortKey === c.key ? styles.active : undefined}>
                      <Link href={sortLink(c.key)}>
                        {c.label}
                        {sortKey === c.key && (
                          <span className={styles.arrow}>{ascending ? "▴" : "▾"}</span>
                        )}
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.pcode}>
                    <td>{i + 1}</td>
                    <td>
                      <Link href={`/players/${r.pcode}`} className={styles.lbPlayerLink}>
                        {r.playerName}
                      </Link>
                    </td>
                    <td>
                      <span className={styles.lbTeamCell}>
                        <TeamBadge team={{ name: r.teamName, abbr: r.teamAbbr, color: r.teamColor, logoUrl: r.teamLogoUrl }} size={20} />
                        <span className={styles.lbTeamName}>{r.teamName}</span>
                      </span>
                    </td>
                    <td>{r.games}</td>
                    <td>{r.attempts}</td>
                    <td>{r.actualPts.toFixed(1)}</td>
                    <td>{r.expectedPts.toFixed(1)}</td>
                    <td className={r.delta >= 0 ? styles.lbDeltaHot : styles.lbDeltaCold}>{fmtDelta(r.delta)}</td>
                    <td className={r.deltaPer100 >= 0 ? styles.lbDeltaHot : styles.lbDeltaCold}>
                      <b>{fmtDelta(r.deltaPer100)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && <div className={styles.emptyNote}>이 시즌은 표본 기준을 충족하는 선수가 없음</div>}

          <div className={styles.explainBox}>
            <b>100슛당</b>으로 보는 이유 - 델타(합계)는 많이 던진 선수일수록 절댓값이 커져서, 슛을 많이 맡는
            에이스가 구조적으로 불리해집니다. 실제로 25-26 시즌 시도 1위(1,091개) 자밀 워니는 합계로는 119명 중
            113위지만 100슛당으로는 74위입니다. 그래서 기본 정렬을 100슛당으로 두었습니다 — 합계도 열로 같이 두니
            둘을 나란히 비교해 보세요. 창(최근 N경기)을 바꿔 가며 보면 &quot;지금 반짝&quot;인지 &quot;원래 그런&quot;인지가
            갈립니다.
            <br />
            <br />
            <b>xPts(기대득점)</b>란 - 15시즌 전체 리그 평균 기준, 그 슛이 던져진 코트 위치(구역)에서
            평균적으로 얼마나 성공하는지를 근거로 &ldquo;이 슛 하나가 평균적으로 몇 점짜리인가&rdquo;를
            계산한 값(<code>build_xpts_shot_quality.py</code>). 최근 5경기 동안 던진 모든 슛(성공+실패)의
            xPts를 더한 게 &ldquo;기대득점&rdquo;, 실제로 넣은 슛만 점수로 환산해 더한 게
            &ldquo;실제&rdquo;. 이 둘의 차이가 &ldquo;슛 난이도로는 설명 안 되는, 지금 이 선수의
            결정력/컨디션&rdquo;에 가까운 신호.
          </div>
        </div>

        <footer className={styles.foot}>
          {activeSeason} 시즌 기준 · 선수별 최근 5경기 롤링 윈도우 · xPts 존 테이블은 15시즌(2011-12~2025-26)
          전체 평균.
        </footer>
      </div>
    </div>
  );
}
