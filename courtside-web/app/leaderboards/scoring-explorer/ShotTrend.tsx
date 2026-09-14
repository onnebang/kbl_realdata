import Link from "next/link";
import { getLeagueShotTrend, getTeamShotProfile, seasonShort, type SeasonShot, type ShotMix } from "@/lib/shotTrend";
import { getLeaderboardSeasons } from "@/lib/seasonLeaders";
import { teamBarStyle } from "@/lib/teamAccent";
import t from "./shot-trend.module.css";

// "KBL 슛의 15년" 탭(2026-09-15, 옛 "리그 슛 선택의 변화" 히트맵 재생을 대체).
// 옛 화면은 15x15 밀도 히트맵의 색 변화로만 15시즌을 보여줘 무엇이 바뀌었는지 읽히지 않았다. 숫자로 뽑으면 이야기가
// 뚜렷하다: 3점 비중 27.8% → 40.3%, 그런데 야투 1개당 득점은 0.99~1.06 사이에서 오르내릴 뿐(tools/rpc_shot_trend.sql).
// 서버 렌더만(클라이언트 JS 0). 코트 지도 재생(리그·감독)은 ?map=1로 열 때만 불러온다 - 마운트 즉시 무거운 조회를 한다.

const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
const pct0 = (v: number) => `${Math.round(v * 100)}%`;

function Legend() {
  return (
    <div className={t.legend}>
      <span>
        <i className={`${t.sw} ${t.three}`} /> 3점
      </span>
      <span>
        <i className={`${t.sw} ${t.mid}`} /> 중거리(3m~3점선)
      </span>
      <span>
        <i className={`${t.sw} ${t.paint}`} /> 페인트존(3m 이내)
      </span>
    </div>
  );
}

/** 15시즌 세로 막대(3점을 바닥에 붙여 키가 그대로 읽히게) + 같은 가로축의 야투당 득점 선. */
function TrendChart({ seasons }: { seasons: SeasonShot[] }) {
  const lo = 0.95;
  const hi = 1.1;
  const y = (v: number) => ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100;
  const n = seasons.length;
  const xc = (i: number) => ((i + 0.5) / n) * 100;
  const ppsMin = seasons.reduce((m, s) => (s.pps < m.pps ? s : m), seasons[0]);
  const ppsMax = seasons.reduce((m, s) => (s.pps > m.pps ? s : m), seasons[0]);
  const showLabel = (i: number) => i === 0 || i === n - 1 || i % 3 === 0;
  return (
    <div className={t.chartBlock}>
      <div className={t.chartTitle}>야투 구성(시즌별, 합 100%)</div>
      <div className={t.cols} role="img" aria-label={`3점 비중 ${pct1(seasons[0].three)}에서 ${pct1(seasons[n - 1].three)}로`}>
        {seasons.map((s, i) => (
          <div key={s.season} className={t.col} title={`${s.season} · 3점 ${pct1(s.three)} · 중거리 ${pct1(s.mid)} · 페인트존 ${pct1(s.paint)}`}>
            <div className={`${t.seg} ${t.three}`} style={{ height: `${s.three * 100}%` }}>
              {(i === 0 || i === n - 1) && <span className={t.segVal}>{pct0(s.three)}</span>}
            </div>
            <div className={`${t.seg} ${t.mid}`} style={{ height: `${s.mid * 100}%` }} />
            <div className={`${t.seg} ${t.paint}`} style={{ height: `${s.paint * 100}%` }} />
          </div>
        ))}
      </div>
      <Legend />

      <div className={t.chartTitle}>야투 1개당 득점(자유투 제외)</div>
      <div className={t.line} role="img" aria-label={`야투당 득점 ${seasons[0].pps.toFixed(2)}에서 ${seasons[n - 1].pps.toFixed(2)}로, 15시즌 범위 ${ppsMin.pps.toFixed(2)}~${ppsMax.pps.toFixed(2)}`}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {[1.0, 1.05].map((g) => (
            <line key={g} x1={0} x2={100} y1={100 - y(g)} y2={100 - y(g)} className={t.gridLine} vectorEffect="non-scaling-stroke" />
          ))}
          <polyline points={seasons.map((s, i) => `${xc(i)},${100 - y(s.pps)}`).join(" ")} className={t.ppsLine} vectorEffect="non-scaling-stroke" />
        </svg>
        {seasons.map((s, i) => (
          <span key={s.season} className={t.ppsDot} style={{ left: `${xc(i)}%`, bottom: `${y(s.pps)}%` }} title={`${s.season} · ${s.pps.toFixed(3)}`} />
        ))}
        {seasons.map((s, i) =>
          i === 0 || i === n - 1 || s === ppsMin || s === ppsMax ? (
            <span key={`v-${s.season}`} className={t.ppsVal} style={{ left: `${xc(i)}%`, bottom: `${y(s.pps)}%` }}>
              {s.pps.toFixed(2)}
            </span>
          ) : null
        )}
        <span className={t.gridTick} style={{ bottom: `${y(1.0)}%` }}>1.00</span>
        <span className={t.gridTick} style={{ bottom: `${y(1.05)}%` }}>1.05</span>
      </div>
      <div className={t.xLabels}>
        {seasons.map((s, i) => (
          <span key={s.season}>{showLabel(i) ? s.label : ""}</span>
        ))}
      </div>
    </div>
  );
}

/** 구역별 성공률 한 장 - 첫·마지막 값을 크게, 가운데는 추이 선. */
function RateCard({ title, seasons, pick }: { title: string; seasons: SeasonShot[]; pick: (s: ShotMix) => number }) {
  const vals = seasons.map(pick);
  const lo = Math.min(...vals) - 0.02;
  const hi = Math.max(...vals) + 0.02;
  const y = (v: number) => 100 - ((v - lo) / (hi - lo)) * 100;
  const n = vals.length;
  return (
    <div className={t.rateCard}>
      <div className={t.rateTitle}>{title}</div>
      <div className={t.rateNums}>
        <span className={t.rateNum}>{pct1(vals[0])}</span>
        <span className={t.rateArrow}>→</span>
        <span className={t.rateNum}>{pct1(vals[n - 1])}</span>
      </div>
      <svg className={t.rateSpark} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={vals.map((v, i) => `${((i + 0.5) / n) * 100},${y(v)}`).join(" ")} className={t.sparkLine} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className={t.rateRange}>
        {seasons[0].label}~{seasons[n - 1].label} 범위 {pct1(Math.min(...vals))}~{pct1(Math.max(...vals))}
      </div>
    </div>
  );
}

function MixBar({ m }: { m: ShotMix }) {
  return (
    <div className={t.mixBar} aria-hidden="true">
      <span className={`${t.three}`} style={{ width: `${m.three * 100}%` }} />
      <span className={`${t.mid}`} style={{ width: `${m.mid * 100}%` }} />
      <span className={`${t.paint}`} style={{ width: `${m.paint * 100}%` }} />
    </div>
  );
}

export default async function ShotTrend({ activeSeason, mapHref }: { activeSeason?: string; mapHref: string }) {
  const [seasons, teamSeasons] = await Promise.all([getLeagueShotTrend(), getLeaderboardSeasons()]);
  if (seasons.length < 2) return <div className={t.empty}>시즌 기록이 두 시즌 이상 쌓이면 추이를 그립니다.</div>;
  const first = seasons[0];
  const last = seasons[seasons.length - 1];
  const ppsVals = seasons.map((s) => s.pps);

  const teamSeason = activeSeason && teamSeasons.includes(activeSeason) ? activeSeason : teamSeasons[0];
  const teams = teamSeason ? await getTeamShotProfile(teamSeason) : [];
  const league = seasons.find((s) => s.season === teamSeason) ?? null;

  return (
    <>
      <section className={t.panel}>
        <div className={t.headline}>
          <div className={t.stat}>
            <div className={t.statNums}>
              <span className={t.statNum}>{pct1(first.three)}</span>
              <span className={t.statArrow}>→</span>
              <span className={`${t.statNum} ${t.statHot}`}>{pct1(last.three)}</span>
            </div>
            <div className={t.statLabel}>
              야투 중 3점 비중 · {first.label} → {last.label}
            </div>
          </div>
          <div className={t.stat}>
            <div className={t.statNums}>
              <span className={t.statNum}>{first.pps.toFixed(2)}</span>
              <span className={t.statArrow}>→</span>
              <span className={t.statNum}>{last.pps.toFixed(2)}</span>
            </div>
            <div className={t.statLabel}>
              야투 1개당 득점 · 15시즌 내내 {Math.min(...ppsVals).toFixed(2)}~{Math.max(...ppsVals).toFixed(2)}
            </div>
          </div>
        </div>
        <p className={t.lede}>
          3점이 늘어난 만큼 페인트존({pct0(first.paint)}→{pct0(last.paint)})과 중거리({pct0(first.mid)}→{pct0(last.mid)})가 함께
          줄었습니다. {last.label} 기준 슛 한 번의 값은 페인트존 {(last.paintFg * 2).toFixed(2)}점, 3점 {(last.threePct * 3).toFixed(2)}점,
          중거리 {(last.midFg * 2).toFixed(2)}점입니다. 중거리를 3점으로 바꾸면 이득이지만 페인트존을 3점으로 바꾸면 손해라, 둘이 상쇄돼 합계가
          제자리였습니다.
        </p>
        <TrendChart seasons={seasons} />
      </section>

      <section className={t.panel}>
        <div className={t.sectionTitle}>구역별 성공률은 15시즌 동안 거의 그대로</div>
        <div className={t.rateGrid}>
          <RateCard title="3점 성공률" seasons={seasons} pick={(s) => s.threePct} />
          <RateCard title="중거리 성공률" seasons={seasons} pick={(s) => s.midFg} />
          <RateCard title="페인트존 성공률" seasons={seasons} pick={(s) => s.paintFg} />
        </div>
      </section>

      {teams.length > 0 && league && (
        <section className={t.panel}>
          <div className={t.teamHead}>
            <div className={t.sectionTitle}>{seasonShort(teamSeason!)} 팀별 슛 구성</div>
            <form className={t.seasonForm}>
              <input type="hidden" name="tab" value="trend" />
              <select name="season" defaultValue={teamSeason} aria-label="시즌">
                {teamSeasons.map((s) => (
                  <option key={s} value={s}>
                    {s} 시즌
                  </option>
                ))}
              </select>
              <button type="submit" className={t.seasonSubmit}>
                시즌 보기
              </button>
            </form>
          </div>
          <div className={t.tableWrap}>
            <table className={t.teamTable}>
              <thead>
                <tr>
                  <th className={t.left}>팀</th>
                  <th className={t.left}>야투 구성</th>
                  <th>3점 비중</th>
                  <th>3점 성공률</th>
                  <th>야투당 득점</th>
                  <th>공격 효율</th>
                </tr>
              </thead>
              <tbody>
                <tr className={t.leagueRow}>
                  <td className={t.left}>리그 평균</td>
                  <td className={t.left}>
                    <MixBar m={league} />
                  </td>
                  <td>{pct1(league.three)}</td>
                  <td>{pct1(league.threePct)}</td>
                  <td>{league.pps.toFixed(3)}</td>
                  <td>{league.ortg.toFixed(1)}</td>
                </tr>
                {teams.map((tm) => (
                  <tr key={tm.tcode}>
                    <td className={`${t.left} ${t.teamCell}`} style={teamBarStyle(tm.color)}>
                      <Link href={`/teams/${tm.tcode}?season=${teamSeason}`}>{tm.name}</Link>
                    </td>
                    <td className={t.left}>
                      <MixBar m={tm} />
                    </td>
                    <td>{pct1(tm.three)}</td>
                    <td className={tm.threePct >= league.threePct ? undefined : t.dim}>{pct1(tm.threePct)}</td>
                    <td className={tm.pps >= league.pps ? undefined : t.dim}>{tm.pps.toFixed(3)}</td>
                    <td className={tm.ortg >= league.ortg ? undefined : t.dim}>{tm.ortg.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Legend />
          <p className={t.note}>3점 비중이 높은 팀부터. 회색 숫자는 그 시즌 리그 평균보다 낮은 값. 공격 효율은 100포제션당 득점이라 자유투·리바운드·실책까지 들어가 야투당 득점과 순서가 다를 수 있다.</p>
        </section>
      )}

      <ul className={t.captions}>
        <li>3점·2점 시도와 성공은 박스스코어(좌표와 무관), 2점 안의 페인트존/중거리 나눔만 슛 좌표(3m 기준)로 계산했습니다. 정규시즌만.</li>
        <li>
          골밑과 근거리를 따로 두지 않았습니다: 2017-18에 좌표 기록 방식이 바뀐 흔적이 있습니다(0.5m 이내 기록이 1.8%→4.8%로 세 배가 됐는데 골밑
          성공률은 오히려 내렸다). 3m 안을 합친 비중은 이 전후로 안정적입니다.
        </li>
        <li>2019-20은 코로나 중단으로 팀당 42~43경기입니다.</li>
      </ul>

      <div className={t.mapLink}>
        <Link href={mapHref}>코트 위 슛 분포를 시즌별로 재생하기(리그·감독)</Link>
      </div>
    </>
  );
}
