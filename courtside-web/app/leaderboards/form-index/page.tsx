import type { Metadata } from "next";
import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import {
  getSeasonsWithFormData,
  getFormIndexLeaderboard,
  type FormIndexRow,
  type FormSortKey,
  FORM_EVIDENCE,
  FORM_WINDOWS,
  formWindowLabel,
  per100Se,
} from "@/lib/formIndex";
import styles from "./form-index.module.css";

// "슛 결정력"(2026-09-15 개편, 옛 "폼 지수"). 슛 위치로 본 기대 득점(xPts)과 실제 득점의 차이를 100슛당으로.
// 옛 화면은 기본이 최근 5경기였고 맨 위에 "지금 가장 핫한 / 콜드한 선수"를 걸었다. 실측으로 직전 5경기 값이 다음 5경기를
// 맞히는 상관은 0.10, 시즌 나머지 경기는 0.25라(lib/formIndex.ts FORM_EVIDENCE) 최근 몇 경기의 핫·콜드는 대부분 표본
// 흔들림이다. 그래서 기본을 시즌 전체로 두고, 최근 창을 고르면 "시즌 수준에서 벗어난 폭"과 흔들림 폭을 함께 보여준다.

const COLUMNS: { key: FormSortKey; label: string }[] = [
  { key: "games", label: "GP" },
  { key: "attempts", label: "FGA" },
  { key: "actualPts", label: "실제" },
  { key: "expectedPts", label: "기대(xPts)" },
  { key: "delta", label: "델타" },
  // 기본 정렬. 원시 합계(델타)는 많이 던진 선수를 구조적으로 불리하게 만든다 - 25-26 시도 1위 자밀 워니가 합계 113/119위, 100슛당 74/119위.
  { key: "deltaPer100", label: "100슛당" },
];

/** 시즌 전체 상·하위 목록에 올릴 최소 시도 - 200슛이면 흔들림 폭(2SE)이 ±16점이다. */
const SEASON_LIST_MIN_ATTEMPTS = 200;

const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
const band = (attempts: number) => 2 * per100Se(attempts);

function SeasonRow({ r, rank, tone }: { r: FormIndexRow; rank: number; tone: "hot" | "cold" }) {
  const b = band(r.attempts);
  const within = Math.abs(r.deltaPer100) < b;
  return (
    <div className={styles.barRow}>
      <div className={styles.barRank}>{rank}</div>
      <div className={styles.barNameWrap}>
        <Link href={`/players/${r.pcode}`} className={styles.barName}>
          {r.playerName}
        </Link>
        <div className={styles.barTeam}>
          {r.teamName} · {r.attempts}슛
        </div>
      </div>
      <div className={`${styles.barVal} ${within ? styles.withinBand : tone === "hot" ? styles.lbDeltaHot : styles.lbDeltaCold}`}>
        {signed(r.deltaPer100)}
        <span className={styles.bandNote}>±{b.toFixed(0)}</span>
      </div>
    </div>
  );
}

type Deviation = { r: FormIndexRow; season: FormIndexRow; dev: number; band: number };

function DeviationRow({ d, rank, tone }: { d: Deviation; rank: number; tone: "hot" | "cold" }) {
  const within = Math.abs(d.dev) < d.band;
  return (
    <div className={styles.barRow}>
      <div className={styles.barRank}>{rank}</div>
      <div className={styles.barNameWrap}>
        <Link href={`/players/${d.r.pcode}`} className={styles.barName}>
          {d.r.playerName}
        </Link>
        <div className={styles.barTeam}>
          최근 {signed(d.r.deltaPer100)} · 시즌 {signed(d.season.deltaPer100)} · {d.r.attempts}슛
        </div>
      </div>
      <div className={`${styles.barVal} ${within ? styles.withinBand : tone === "hot" ? styles.lbDeltaHot : styles.lbDeltaCold}`}>
        {signed(d.dev)}
        <span className={styles.bandNote}>±{d.band.toFixed(0)}</span>
      </div>
    </div>
  );
}

export default async function FormIndexPage({ searchParams }: { searchParams: Promise<{ season?: string; sort?: string; dir?: string; win?: string }> }) {
  const { season, sort, dir, win } = await searchParams;
  const seasons = await getSeasonsWithFormData();
  const activeSeason = season && seasons.includes(season) ? season : seasons[0];
  const sortKey = (COLUMNS.find((c) => c.key === sort)?.key ?? "deltaPer100") as FormSortKey;
  // 창(경기 수). 0 = 시즌 전체(기본). 목록에 없는 값이 들어오면 시즌 전체.
  const parsedWin = Number(win);
  const activeWin = win != null && (FORM_WINDOWS as readonly number[]).includes(parsedWin) ? parsedWin : 0;
  const ascending = dir === "asc";
  const isSeason = activeWin === 0;

  const [rows, seasonRows] = await Promise.all([
    getFormIndexLeaderboard(activeSeason, activeWin, sortKey, ascending),
    isSeason ? Promise.resolve(null) : getFormIndexLeaderboard(activeSeason, 0, "deltaPer100", false),
  ]);

  const seasonByPcode = new Map((seasonRows ?? []).map((r) => [r.pcode, r]));
  const seasonPool = rows.filter((r) => r.attempts >= SEASON_LIST_MIN_ATTEMPTS).sort((a, b) => b.deltaPer100 - a.deltaPer100);
  const deviations: Deviation[] = isSeason
    ? []
    : rows
        .map((r) => ({ r, season: seasonByPcode.get(r.pcode) }))
        .filter((x): x is { r: FormIndexRow; season: FormIndexRow } => x.season != null)
        .map(({ r, season: s }) => ({ r, season: s, dev: r.deltaPer100 - s.deltaPer100, band: band(r.attempts) }))
        .sort((a, b) => b.dev - a.dev);
  const outside = deviations.filter((d) => Math.abs(d.dev) >= d.band).length;

  const sortLink = (key: FormSortKey) => `?season=${encodeURIComponent(activeSeason)}&win=${activeWin}&sort=${key}&dir=${sortKey === key && !ascending ? "asc" : "desc"}`;

  return (
    <div className={styles.pageRoot}>
      <div className={styles.wrap}>
        <h1 className={styles.title}>슛 결정력</h1>
        <div className={styles.subtitle}>
          던진 자리로 본 기대 득점(xPts)보다 실제로 얼마나 더 넣었는지를 <b>100슛당</b>으로 봅니다. 양수면 같은 자리에서 리그 평균보다 잘
          넣은 것이고, 옆의 <b>±</b>는 그만큼의 슛 수에서 운으로도 생기는 흔들림 폭(95%)입니다.
        </div>

        {/* 창 선택을 같은 폼에 둔다 - 따로 두면 시즌을 바꿀 때 창이 초기화된다. 정렬은 hidden으로 유지. */}
        <form className={styles.seasonForm}>
          <select name="season" defaultValue={activeSeason} className={styles.seasonSelect} aria-label="시즌">
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s} 시즌
              </option>
            ))}
          </select>
          <select name="win" defaultValue={String(activeWin)} className={styles.seasonSelect} aria-label="기간">
            {[0, ...FORM_WINDOWS.filter((w) => w > 0)].map((w) => (
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

        {isSeason ? (
          <div className={styles.panel}>
            <div className={styles.panelTitle}>
              {activeSeason} 슛 결정력 · 시즌 {SEASON_LIST_MIN_ATTEMPTS}슛 이상
            </div>
            {seasonPool.length ? (
              <div className={styles.divergeCols}>
                <div>
                  <div className={`${styles.divergeColTitle} ${styles.hot}`}>기대보다 잘 넣음</div>
                  {seasonPool.slice(0, 8).map((r, i) => (
                    <SeasonRow key={r.pcode} r={r} rank={i + 1} tone="hot" />
                  ))}
                </div>
                <div>
                  <div className={`${styles.divergeColTitle} ${styles.cold}`}>기대보다 못 넣음</div>
                  {seasonPool
                    .slice(-8)
                    .reverse()
                    .map((r, i) => (
                      <SeasonRow key={r.pcode} r={r} rank={i + 1} tone="cold" />
                    ))}
                </div>
              </div>
            ) : (
              <div className={styles.emptyNote}>이 시즌은 {SEASON_LIST_MIN_ATTEMPTS}슛 이상 던진 선수가 아직 없음</div>
            )}
            <p className={styles.panelNote}>회색 값은 ± 흔들림 폭 안 - 그 슛 수에서는 운과 구분되지 않는다.</p>
          </div>
        ) : (
          <div className={styles.panel}>
            <div className={styles.panelTitle}>
              {formWindowLabel(activeWin)}, 시즌 수준에서 벗어난 폭
            </div>
            {deviations.length ? (
              <>
                <p className={styles.panelLead}>
                  {deviations.length}명 중 <b>{outside}명</b>만 흔들림 폭 밖으로 벗어났습니다. 최근 몇 경기의 값은 다음 경기를 거의 예고하지 못합니다 -
                  직전 5경기 값과 다음 5경기의 상관은 {FORM_EVIDENCE.rPrev5Next5.toFixed(2)}, 시즌 나머지 경기와의 상관은{" "}
                  {FORM_EVIDENCE.rSeasonNext5.toFixed(2)}입니다(최근 3시즌 {FORM_EVIDENCE.pairs.toLocaleString()}쌍).
                </p>
                <div className={styles.divergeCols}>
                  <div>
                    <div className={`${styles.divergeColTitle} ${styles.hot}`}>시즌보다 잘 넣는 중</div>
                    {deviations.slice(0, 8).map((d, i) => (
                      <DeviationRow key={d.r.pcode} d={d} rank={i + 1} tone="hot" />
                    ))}
                  </div>
                  <div>
                    <div className={`${styles.divergeColTitle} ${styles.cold}`}>시즌보다 못 넣는 중</div>
                    {deviations
                      .slice(-8)
                      .reverse()
                      .map((d, i) => (
                        <DeviationRow key={d.r.pcode} d={d} rank={i + 1} tone="cold" />
                      ))}
                  </div>
                </div>
                <p className={styles.panelNote}>큰 숫자 = 최근 값 − 시즌 값(100슛당). 회색은 ± 흔들림 폭 안.</p>
              </>
            ) : (
              <div className={styles.emptyNote}>이 시즌은 표본 기준을 충족하는 선수가 없음</div>
            )}
          </div>
        )}

        <div className={styles.panel}>
          <div className={styles.panelTitle}>전체 표 · {formWindowLabel(activeWin)} (열 제목을 누르면 정렬)</div>
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
                        {sortKey === c.key && <span className={styles.arrow}>{ascending ? "▴" : "▾"}</span>}
                      </Link>
                    </th>
                  ))}
                  <th>± 흔들림</th>
                  {!isSeason && <th>시즌 100슛당</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const b = band(r.attempts);
                  const within = Math.abs(r.deltaPer100) < b;
                  const s = seasonByPcode.get(r.pcode);
                  return (
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
                      <td className={r.delta >= 0 ? styles.lbDeltaHot : styles.lbDeltaCold}>{signed(r.delta)}</td>
                      <td className={within ? styles.withinBand : r.deltaPer100 >= 0 ? styles.lbDeltaHot : styles.lbDeltaCold}>
                        <b>{signed(r.deltaPer100)}</b>
                      </td>
                      <td className={styles.withinBand}>±{b.toFixed(0)}</td>
                      {!isSeason && <td>{s ? signed(s.deltaPer100) : "-"}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!rows.length && <div className={styles.emptyNote}>이 시즌은 표본 기준을 충족하는 선수가 없음</div>}

          <div className={styles.explainBox}>
            <b>xPts(기대 득점)</b> - 15시즌 전체 슛을 코트 구역(골밑·근거리·짧은/긴 중거리·3점)으로 나눠, 그 구역에서 평균적으로 몇 점이
            나오는지를 슛 하나의 값으로 삼은 것입니다. 던진 슛의 xPts 합이 &ldquo;기대&rdquo;, 실제로 넣은 점수 합이 &ldquo;실제&rdquo;,
            그 차이를 100슛당으로 바꾼 것이 이 표의 기본 값입니다. 수비 압박·슛 종류(캐치앤슛/드리블)는 기록에 없어 반영하지 못합니다.
            <br />
            <br />
            <b>± 흔들림</b> - 슛 한 개의 (실제 − 기대)는 표준편차 약 1.17점이라, 100슛당 값은 운만으로도 ±{(2 * per100Se(100)).toFixed(0)}
            (100슛) · ±{(2 * per100Se(400)).toFixed(0)}(400슛) 정도 흔들립니다. 합계(델타)는 많이 던진 선수일수록 절댓값이 커져 에이스가
            불리해지므로 100슛당을 기본 정렬로 둡니다.
          </div>
        </div>

        <footer className={styles.foot}>
          {activeSeason} 정규시즌 · {formWindowLabel(activeWin)} · xPts 구역표는 15시즌(2011-12~2025-26) 평균
        </footer>
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  title: "슛 결정력",
  description: "던진 자리로 본 기대 득점보다 얼마나 더 넣었나 - 100슛당, 운으로 생기는 흔들림 폭과 함께",
};
