import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { getSeasonsWithFormData, getFormIndexLeaderboard, type FormSortKey } from "@/lib/formIndex";
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
];

function fmtDelta(v: number) {
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

export default async function FormIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; sort?: string; dir?: string }>;
}) {
  const { season, sort, dir } = await searchParams;
  const seasons = await getSeasonsWithFormData();
  const activeSeason = season ?? seasons[0];
  const sortKey = (COLUMNS.find((c) => c.key === sort)?.key ?? "delta") as FormSortKey;
  const ascending = dir === "asc";

  const rows = await getFormIndexLeaderboard(activeSeason, sortKey, ascending);

  // 다이버징 HOT/COLD 리스트는 테이블 정렬 상태와 무관하게 항상 delta 내림차순 기준(템플릿의
  // renderDivergeLists()와 동일 - byDeltaDesc를 테이블 정렬과 별도로 계산).
  const byDeltaDesc = rows.slice().sort((a, b) => b.delta - a.delta);
  const hot = byDeltaDesc.slice(0, 8);
  const cold = byDeltaDesc.slice(-8).reverse();

  const sortLink = (key: FormSortKey) => {
    const nextDir = sortKey === key && !ascending ? "asc" : "desc";
    return `?season=${encodeURIComponent(activeSeason)}&sort=${key}&dir=${nextDir}`;
  };

  const barRow = (r: (typeof rows)[number], i: number, tone: "hot" | "cold") => (
    <div className={styles.barRow} key={r.pcode}>
      <div className={styles.barRank}>{i + 1}</div>
      <div className={styles.barNameWrap}>
        <div className={styles.barName}>{r.playerName}</div>
        <div className={styles.barTeam}>{r.teamName}</div>
      </div>
      <div className={`${styles.barVal} ${tone === "hot" ? styles.lbDeltaHot : styles.lbDeltaCold}`}>
        {fmtDelta(r.delta)}
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
          기준(최소 3경기 데이터거나 시도 15회 미만인 선수는 제외).
        </div>

        <form className={styles.seasonForm}>
          <select name="season" defaultValue={activeSeason} className={styles.seasonSelect}>
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s} 시즌
              </option>
            ))}
          </select>
          <button type="submit" className={styles.seasonSubmit}>
            시즌 보기
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && <div className={styles.emptyNote}>이 시즌은 표본 기준을 충족하는 선수가 없음</div>}

          <div className={styles.explainBox}>
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
