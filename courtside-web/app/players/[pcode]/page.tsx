import Link from "next/link";
import type { CSSProperties } from "react";
import { notFound } from "next/navigation";
import {
  getPlayerInfo,
  getPlayerCareerGames,
  getPlayerRecentGames,
  getAllTeams,
  computeWindowAverages,
  WINDOWS,
  type GameLogRow,
} from "@/lib/playerProfile";
import {
  getZoneExpectedPts,
  getPlayerSeasonBoxTotals,
  countRimAndThreeFga,
  buildHeaderStats,
  buildImpactDots,
  buildImpactCourtSvg,
  computeDrawnFoulProxy,
} from "@/lib/shotImpactChart";
import {
  getCareerShots,
  buildConstellationSvg,
  getPercentileProfile,
  getClutchProfile,
  getTopPairCombos,
  getSeasonWpaRank,
  computeShootingDna,
  DNA_ZONES,
  DNA_ZONE_LABELS,
  PERCENTILE_MIN_GP,
  PERCENTILE_MIN_MINUTES,
  COMBO_MIN_MINUTES,
  type SeasonZoneMix,
  type PercentileProfile,
} from "@/lib/playerDataScience";
import { getPlayerOnOffRatings } from "@/lib/lineupNetRating";
import { getPlayerRosterStatus } from "@/lib/playerStatus";
import {
  resolvePlayerSeasons,
  statSeasonChip,
  progressChip,
  basisChip,
  emptyState,
  seasonShort as shortSeason,
  prevSeasonName,
  PRESEASON_SEASON,
} from "@/lib/seasonFocus";
import { aggregateCareer, getPlayerWpaBySeason, type SeasonAgg } from "@/lib/playerPageData";
import { displayTeamName } from "@/lib/teamNames";
import { TeamBadge } from "@/components/TeamBadge";
import styles from "./player-profile.module.css";

// "데이터 사이언스 + 데이터로 아름다움" 대개편(요청) - sportsjobs.online 레퍼런스의
// 포스터형 히어로를 "선수 사진" 대신 "그 선수의 커리어 슛 전체를 별자리처럼 깐 배경
// 아트"로 적응(players.photo_url이 773명 전원 null - 실측). 히어로 밴드만 테마와 무관한
// 위임적 다크(모든 색을 직접 칠함)이고, 그 아래 본문은 기존 테마 토큰 그대로.

function pct(v: number | null) {
  return v == null ? "-" : `${(v * 100).toFixed(1)}%`;
}

function signed(v: number, decimals = 1) {
  return `${v > 0 ? "+" : ""}${v.toFixed(decimals)}`;
}

// 시즌 축 라벨("2021-2022" -> "21-22")과 시즌 단위 집계(시즌 중 이적은 경기수 가중으로 한 시즌에
// 합쳐짐)는 lib/seasonFocus.ts seasonShort / lib/playerPageData.ts aggregateCareer를 그대로 쓴다 -
// 페이지마다 다른 정의가 생기지 않도록(중복 구현 금지).

// 템플릿 renderPerfChart() 포팅 - 막대=득점(홈 컬러), 선=출전시간(골드), viewBox 640x160.
function PerfChart({ games }: { games: GameLogRow[] }) {
  const chrono = games.slice().reverse();
  const W = 640,
    H = 160,
    PAD_L = 24,
    PAD_R = 8,
    PAD_T = 10,
    PAD_B = 18;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = chrono.length;
  if (!n) return <svg className={styles.perfChartSvg} viewBox={`0 0 ${W} ${H}`} />;
  const maxPts = Math.max(10, ...chrono.map((g) => g.pts));
  const maxMin = Math.max(20, ...chrono.map((g) => g.min));
  const bw = plotW / n;
  const linePts = chrono
    .map((g, i) => {
      const x = PAD_L + i * bw + bw / 2;
      const y = PAD_T + plotH - (g.min / maxMin) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className={styles.perfChartSvg} viewBox={`0 0 ${W} ${H}`}>
      {chrono.map((g, i) => {
        const bh = (g.pts / maxPts) * plotH;
        const x = PAD_L + i * bw;
        return (
          <rect
            key={g.gmkey}
            x={x + bw * 0.14}
            y={PAD_T + plotH - bh}
            width={bw * 0.72}
            height={bh}
            fill="var(--home)"
            rx={2}
          />
        );
      })}
      <polyline points={linePts} fill="none" stroke="var(--gold)" strokeWidth={2} />
      <line x1={PAD_L} y1={PAD_T + plotH} x2={W - PAD_R} y2={PAD_T + plotH} stroke="var(--ink-faint)" strokeWidth={1} />
      <text x={2} y={PAD_T + 8} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
        {maxPts}
      </text>
      <text x={2} y={PAD_T + plotH} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
        0
      </text>
    </svg>
  );
}

// 리그 퍼센타일 바(NBA.com 스타일 - 레이더보다 축별 비교가 명확). 색은 기존 시맨틱 토큰:
// 상위 30% 이상 --positive / 하위 30% 이하 --negative / 그 사이 --gold.
function percentileColor(p: number) {
  return p >= 70 ? "var(--positive)" : p <= 30 ? "var(--negative)" : "var(--gold)";
}

function PercentilePanel({ profile, seasonName }: { profile: PercentileProfile | null; seasonName: string }) {
  if (!profile) return <div className="empty-note">이 시즌 리그 집계 없음</div>;
  if (!profile.qualified) {
    return (
      <div className="empty-note">
        표본 부족 - 퍼센타일은 시즌 {PERCENTILE_MIN_GP}경기 또는 {PERCENTILE_MIN_MINUTES}분 이상 출전 선수 기준
        (이 선수: {profile.gp}경기 · {Math.round(profile.minTotal)}분)
      </div>
    );
  }
  return (
    <>
      <div className={styles.pctGrid}>
        {profile.axes.map((a) => (
          <div className={styles.pctRow} key={a.key}>
            <div className={styles.pctLabel}>{a.label}</div>
            <div className={styles.pctTrack}>
              <div className={styles.pctFill} style={{ width: `${a.percentile}%`, background: percentileColor(a.percentile) }} />
              <div className={styles.pctMid} />
            </div>
            <div className={styles.pctValue}>{a.display}</div>
            <div className={styles.pctNum} style={{ color: percentileColor(a.percentile) }}>
              {a.percentile}
            </div>
          </div>
        ))}
      </div>
      <div className={styles.pctNote}>
        {seasonName} 시즌 자격 선수 {profile.poolN}명 대비 퍼센타일(0-100, TS%·USG%처럼 값이 없는 선수가 있는
        축은 해당 스탯 보유 선수 기준) · 자격: {PERCENTILE_MIN_GP}경기 또는 {PERCENTILE_MIN_MINUTES}분 이상 ·
        TOV%는 낮을수록 높은 퍼센타일
      </div>
    </>
  );
}

// 슈팅 DNA - 시즌별 존 구성비 스택 밴드(존 색: 림→3점 순서로 아래에서 위로 쌓음).
const DNA_COLORS: Record<(typeof DNA_ZONES)[number], string> = {
  rim: "var(--hot)",
  close: "var(--home)",
  midShort: "var(--gold)",
  midLong: "var(--ink-faint)",
  three: "var(--away)",
};

function ShootingDnaChart({ mix }: { mix: SeasonZoneMix[] }) {
  if (!mix.length) {
    return <div className="empty-note">시즌당 슛 30개 이상인 시즌이 없어 존 구성비를 그리지 않음</div>;
  }
  if (mix.length === 1) {
    // 시즌이 하나뿐이면 "변화"가 없으니 밴드 대신 단일 100% 바.
    const m = mix[0];
    return (
      <div>
        <div className={styles.dnaSingleBar}>
          {DNA_ZONES.map((z) =>
            m.shares[z] > 0 ? (
              <div key={z} style={{ width: `${m.shares[z] * 100}%`, background: DNA_COLORS[z] }} title={`${DNA_ZONE_LABELS[z]} ${(m.shares[z] * 100).toFixed(1)}%`} />
            ) : null
          )}
        </div>
        <div className={styles.dnaLegend}>
          {DNA_ZONES.map((z) => (
            <span key={z}>
              <span className={styles.sw} style={{ background: DNA_COLORS[z] }} />
              {DNA_ZONE_LABELS[z]} {(m.shares[z] * 100).toFixed(0)}%
            </span>
          ))}
        </div>
        <div className={styles.pctNote}>
          {shortSeason(m.season)} 시즌 {m.total.toLocaleString()}개 슛 기준(단일 시즌)
        </div>
      </div>
    );
  }

  const W = 640,
    H = 220,
    PAD_L = 30,
    PAD_R = 10,
    PAD_T = 10,
    PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = mix.length;
  const xAt = (i: number) => PAD_L + (i / (n - 1)) * plotW;
  const yAt = (share: number) => PAD_T + plotH - share * plotH;

  // 존별 누적 상단선 - rim부터 아래에서 위로.
  const cumAt = (i: number, uptoZoneIdx: number) => DNA_ZONES.slice(0, uptoZoneIdx + 1).reduce((s, z) => s + mix[i].shares[z], 0);
  const bandPath = (zoneIdx: number) => {
    const top = mix.map((_, i) => `${xAt(i).toFixed(1)},${yAt(cumAt(i, zoneIdx)).toFixed(1)}`);
    const bottom = mix
      .map((_, i) => `${xAt(i).toFixed(1)},${yAt(zoneIdx === 0 ? 0 : cumAt(i, zoneIdx - 1)).toFixed(1)}`)
      .reverse();
    return `M ${top.join(" L ")} L ${bottom.join(" L ")} Z`;
  };

  const tickEvery = Math.max(1, Math.ceil(n / 8));
  return (
    <div>
      <svg className={styles.dnaSvg} viewBox={`0 0 ${W} ${H}`}>
        {DNA_ZONES.map((z, zi) => (
          <path key={z} d={bandPath(zi)} fill={DNA_COLORS[z]} opacity={0.82} />
        ))}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={PAD_L} y1={yAt(g)} x2={W - PAD_R} y2={yAt(g)} stroke="var(--surface)" strokeWidth={0.6} opacity={0.5} />
        ))}
        {mix.map((m, i) =>
          i % tickEvery === 0 || i === n - 1 ? (
            <text key={m.season} x={xAt(i)} y={H - 8} fontSize={9} textAnchor="middle" fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
              {shortSeason(m.season)}
            </text>
          ) : null
        )}
        <text x={2} y={yAt(1) + 8} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
          100%
        </text>
        <text x={2} y={yAt(0)} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
          0%
        </text>
      </svg>
      <div className={styles.dnaLegend}>
        {DNA_ZONES.map((z) => (
          <span key={z}>
            <span className={styles.sw} style={{ background: DNA_COLORS[z] }} />
            {DNA_ZONE_LABELS[z]}
          </span>
        ))}
      </div>
    </div>
  );
}

// 커리어 아크 - 시즌별 PPG(굵은 선) + 출전시간(가는 선), 커리어 하이 시즌 주석.
function CareerArcChart({ seasonsAsc }: { seasonsAsc: SeasonAgg[] }) {
  if (seasonsAsc.length < 2) {
    return <div className="empty-note">시즌이 2개 이상일 때 커리어 곡선을 그림 (현재 {seasonsAsc.length}시즌)</div>;
  }
  const W = 640,
    H = 200,
    PAD_L = 30,
    PAD_R = 14,
    PAD_T = 20,
    PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = seasonsAsc.length;
  const maxPpg = Math.max(10, ...seasonsAsc.map((s) => s.ppg));
  const maxMin = Math.max(20, ...seasonsAsc.map((s) => s.minPg));
  const xAt = (i: number) => PAD_L + (i / (n - 1)) * plotW;
  const yPpg = (v: number) => PAD_T + plotH - (v / maxPpg) * plotH;
  const yMin = (v: number) => PAD_T + plotH - (v / maxMin) * plotH;

  const ppgPts = seasonsAsc.map((s, i) => `${xAt(i).toFixed(1)},${yPpg(s.ppg).toFixed(1)}`).join(" ");
  const minPts = seasonsAsc.map((s, i) => `${xAt(i).toFixed(1)},${yMin(s.minPg).toFixed(1)}`).join(" ");
  const hiIdx = seasonsAsc.reduce((best, s, i) => (s.ppg > seasonsAsc[best].ppg ? i : best), 0);
  const hi = seasonsAsc[hiIdx];
  const tickEvery = Math.max(1, Math.ceil(n / 8));
  // 커리어 하이 라벨이 차트 밖으로 나가지 않게 끝 시즌이면 앵커를 당김.
  const hiAnchor = hiIdx === 0 ? "start" : hiIdx === n - 1 ? "end" : "middle";

  return (
    <div>
      <svg className={styles.arcSvg} viewBox={`0 0 ${W} ${H}`}>
        <line x1={PAD_L} y1={PAD_T + plotH} x2={W - PAD_R} y2={PAD_T + plotH} stroke="var(--ink-faint)" strokeWidth={1} />
        <polyline points={minPts} fill="none" stroke="var(--gold)" strokeWidth={1.4} opacity={0.75} />
        <polyline points={ppgPts} fill="none" stroke="var(--home)" strokeWidth={2.6} />
        {seasonsAsc.map((s, i) => (
          <circle key={s.seasonName} cx={xAt(i)} cy={yPpg(s.ppg)} r={i === hiIdx ? 4.4 : 2.6} fill="var(--home)" />
        ))}
        <text
          x={xAt(hiIdx)}
          y={yPpg(hi.ppg) - 10}
          fontSize={10.5}
          fontWeight={700}
          textAnchor={hiAnchor}
          fill="var(--home)"
          fontFamily="IBM Plex Mono, monospace"
        >
          커리어 하이 {hi.ppg.toFixed(1)} ({shortSeason(hi.seasonName)})
        </text>
        {seasonsAsc.map((s, i) =>
          i % tickEvery === 0 || i === n - 1 ? (
            <text key={s.seasonName} x={xAt(i)} y={H - 8} fontSize={9} textAnchor="middle" fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
              {shortSeason(s.seasonName)}
            </text>
          ) : null
        )}
        <text x={2} y={PAD_T + 6} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
          {maxPpg.toFixed(0)}
        </text>
      </svg>
      <div className={styles.perfLegend}>
        <span>
          <span className={styles.sw} style={{ background: "var(--home)" }} />
          시즌 평균 득점(PPG)
        </span>
        <span>
          <span className={styles.sw} style={{ background: "var(--gold)" }} />
          출전시간(MIN)
        </span>
      </div>
    </div>
  );
}

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ pcode: string }>;
  searchParams: Promise<{ w?: string; season?: string }>;
}) {
  const { pcode } = await params;
  const { w, season } = await searchParams;
  const info = await getPlayerInfo(pcode);
  if (!info) notFound();

  // 1차: 시즌 선택과 무관한 조회(클러치/시너지/온오프/존 기대값 포함)를 전부 병렬로. 커리어 경기
  // 행(getPlayerCareerGames)은 로스터 상태 판정·히어로 타일·커리어 아크·시즌별 기록표가 모두
  // 공유하므로 한 번만 읽는다(기존 getPlayerCareerBySeason과 중복 조회하지 않기 위해 교체).
  const [careerRows, recentGames, teamByTcode, careerShots, clutch, combos, onOffMap, zoneExpectedPts] =
    await Promise.all([
      getPlayerCareerGames(pcode),
      getPlayerRecentGames(pcode),
      getAllTeams(),
      getCareerShots(pcode),
      getClutchProfile(pcode),
      getTopPairCombos(pcode),
      getPlayerOnOffRatings([pcode]),
      getZoneExpectedPts(),
    ]);

  // 2차: 확정 명단(season_roster) 대조 - 히어로 정체성(팀·등번호·포지션)의 유일한 출처다.
  // recentGames[0]에서 신분을 추론하면 이적 선수가 옛 팀 배지·옛 등번호를 단 채로 렌더된다
  // (해먼즈 291698 실측: 마지막 경기 tcode 10 울산 현대모비스 #2 'FD' vs 26-27 명단 tcode 16
  // 원주 DB · back_num NULL · note '외국인 2옵션 | MOB→DB 이적'). 커리어 행은 그대로 넘겨 재조회 없음.
  const status = await getPlayerRosterStatus(pcode, careerRows);
  // "이번 시즌"의 정의는 lib/seasonFocus.ts 한 곳에서만 - 추정 패널(평균·퍼센타일·슛)은 statSeason을
  // 받아 개막일 밤에 1경기 평균이 시즌 수치로 승격되는 일이 없게 한다(선수 임계 10GP).
  const focus = resolvePlayerSeasons(pcode, status.seasonsPlayedDesc, status.state === "active");

  const { lines: seasonLines, seasonsAsc } = aggregateCareer(careerRows);
  const careerGp = careerRows.length;
  const seasonNames = seasonsAsc.map((s) => s.seasonName);
  // 시즌별 기록표에서 "가장 최근 시즌" 행을 강조 - 사실(출전 기록이 있는 최신 시즌)이라 첫 경기부터 바뀐다.
  const latestSeason = seasonLines.length ? seasonLines[0].seasonName : null;

  const windowN = WINDOWS.includes(Number(w) as (typeof WINDOWS)[number]) ? Number(w) : 15;
  const windowGames = recentGames.slice(0, windowN);
  const windowAvg = computeWindowAverages(recentGames, windowN);

  const headerTeam = status.tcode ? (teamByTcode.get(status.tcode) ?? null) : null;

  // ?season= 쿼리로 직접 고른 시즌이 있으면 그 시즌, 없으면 statSeason(개막 전·표본 미달이면 마지막 시즌).
  // 쿼리 값은 반드시 화이트리스트로 검증한다 - 그러지 않으면 ?season=아무말이 그대로 기준 칩에
  // 찍혀서 페이지가 없는 시즌을 근거로 단언하는 것처럼 보인다(검증 지적).
  const selectableSeasons = new Set<string>([...seasonNames, PRESEASON_SEASON]);
  const shotSeason = season && selectableSeasons.has(season) ? season : focus.statSeason;
  // 3차: 선택 시즌 의존 조회(퍼센타일 RPC는 실측 29ms) + 시즌별 WPA(히어로 WPA 타일·정규시즌 집계).
  const [boxTotals, percentile, wpaRank, wpaBySeason] = await Promise.all([
    shotSeason ? getPlayerSeasonBoxTotals(pcode, shotSeason) : Promise.resolve(null),
    shotSeason ? getPercentileProfile(pcode, shotSeason) : Promise.resolve(null),
    shotSeason ? getSeasonWpaRank(pcode, shotSeason) : Promise.resolve(null),
    getPlayerWpaBySeason(pcode, seasonNames),
  ]);

  // 시즌 의존 패널의 기준 칩은 전부 여기서 만든다(shared_design_language (2) - 다섯 어휘만 존재).
  const panelChip = (s: string | null): string | null => {
    if (!s) return null;
    if (s === focus.statSeason) return statSeasonChip(focus);
    // ?season=2026-2027처럼 아직 진행 중인 시즌을 직접 고른 경우 - "최종"이라고 쓰면 거짓이 된다.
    if (s === PRESEASON_SEASON) return basisChip("inprogress", { n: focus.focusGp, threshold: focus.thresholdLabel });
    return basisChip("final", { season: s, last: s < prevSeasonName(PRESEASON_SEASON) });
  };
  const statChip = panelChip(shotSeason ?? null);
  // 개막 후·임계 전에만 붙는 두 번째 칩('26-27 진행 중 · 3경기 (임계 10경기)'). 다른 시즌을 직접 고른 경우엔 생략.
  const statProgressChip = shotSeason === focus.statSeason ? progressChip(focus) : null;

  // 슛 임팩트 리포트의 시즌 슛 = 커리어 슛에서 필터(별자리/DNA와 요청 1회 공유).
  const seasonShots = careerShots.filter((s) => s.season === shotSeason);
  const { rimFga, threeFga } = countRimAndThreeFga(seasonShots);
  const headerStats = boxTotals && boxTotals.gp > 0 ? buildHeaderStats(boxTotals, rimFga, threeFga) : null;
  const impactDots = buildImpactDots(seasonShots, zoneExpectedPts);
  const impactSvg = impactDots.length > 0 ? buildImpactCourtSvg(impactDots) : null;
  const totalMade = seasonShots.filter((s) => s.made).length;
  const drawnFoulProxy = boxTotals && boxTotals.gp > 0 ? computeDrawnFoulProxy(boxTotals.fta, boxTotals.fga) : null;
  const astPerGame = boxTotals && boxTotals.gp > 0 ? boxTotals.ast / boxTotals.gp : null;
  const tovPerGame = boxTotals && boxTotals.gp > 0 ? boxTotals.tov / boxTotals.gp : null;

  // 히어로 타일의 기준 시즌 = statSeason. statSeason이 없는 신입(직전 출전 시즌 없음)은 26-27 표본이
  // 있을 때만 그 시즌을 쓰고, 칩이 "진행 중 · N경기 (임계 10경기)"라고 표본을 밝힌다.
  const heroSeasonName = focus.statSeason ?? (focus.focusGp > 0 ? focus.focusSeason : null);
  const heroSeason = heroSeasonName ? (seasonsAsc.find((s) => s.seasonName === heroSeasonName) ?? null) : null;
  const heroWpa = heroSeasonName ? (wpaBySeason.get(heroSeasonName) ?? null) : null;
  const heroChip = panelChip(heroSeasonName);
  const dnaMix = computeShootingDna(careerShots);
  const constellationSvg = buildConstellationSvg(careerShots);
  const teamColor = headerTeam?.color ?? "#d9640a";
  const onOff = onOffMap.get(pcode) ?? null;

  // 히어로 배경의 두 번째 모티프 - 시즌 PPG 궤적을 아주 옅은 폴리라인으로(3시즌 이상일 때만).
  const heroArcPts =
    seasonsAsc.length >= 3
      ? seasonsAsc
          .map((s, i) => {
            const maxPpg = Math.max(...seasonsAsc.map((x) => x.ppg), 1);
            const x = (i / (seasonsAsc.length - 1)) * 100;
            const y = 22 - (s.ppg / maxPpg) * 20;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : null;

  const clutchFgm = clutch ? clutch.totals.fg2m + clutch.totals.fg3m : 0;
  const clutchFga = clutch ? clutch.totals.fg2a + clutch.totals.fg3a : 0;

  return (
    <div className={`wrap ${styles.pageRoot}`}>
      <Link href="/" className="back-link">
        ← 경기 목록
      </Link>

      {/* ── 히어로: 커리어 슛 별자리 포스터(위임적 다크 - 모든 색을 직접 칠함) ── */}
      <section className={styles.hero} style={{ "--hero-team": teamColor } as CSSProperties}>
        <svg className={styles.heroArt} viewBox="345 27 375 357" preserveAspectRatio="xMidYMid slice" aria-hidden dangerouslySetInnerHTML={{ __html: constellationSvg }} />
        {heroArcPts && (
          <svg className={styles.heroArc} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden>
            <polyline points={heroArcPts} fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <div className={styles.heroScrim} />
        {status.backNum && <div className={styles.heroNum}>{status.backNum}</div>}
        <div className={styles.heroContent}>
          <div className={styles.heroKicker}>COURTSIDE PLAYER PROFILE</div>
          <h1 className={styles.heroName}>{info.name}</h1>
          <div className={styles.heroMeta}>
            <TeamBadge team={headerTeam} size={22} />
            <span>{status.teamName ?? "-"}</span>
            <span className={styles.heroMetaDot}>·</span>
            {/* 포지션은 G/F/C 정규화 값만(game_player_stats.pos 원문 'FD'/'GD' 노출 금지 - playerStatus.normalizePos). */}
            <span>{status.pos ?? "-"}</span>
            {status.backNum && (
              <>
                <span className={styles.heroMetaDot}>·</span>
                {/* 외국인 행은 season_roster.back_num이 NULL이라 같은 팀이면 마지막 경기 번호를 시즌
                    라벨과 함께 쓴다(팀이 바뀌면 playerStatus가 null로 돌려줘 여기까지 오지 않음). */}
                <span>
                  {status.backNumAsLastSeason && status.backNumSeason ? `${shortSeason(status.backNumSeason)} ` : ""}#
                  {status.backNum}
                </span>
              </>
            )}
            <span className={styles.heroMetaDot}>·</span>
            <span>커리어 {careerGp}경기</span>
            <span className={styles.heroMetaDot}>·</span>
            {/* 히어로 배경은 점 구름이 아니라 밀도 장(lib/shotDensityField.ts) - 밝기는 "시도 밀도"이지
                성공률이 아니다. 표본 수와 함께 그 사실을 캡션에 남긴다. */}
            <span>슛 {careerShots.length.toLocaleString()}개의 밀도 지도 · 밝을수록 시도가 많은 자리</span>
          </div>
          {heroSeason && (
            <div className={styles.heroStatRow}>
              {(
                [
                  ["PPG", heroSeason.ppg.toFixed(1)],
                  ["RPG", heroSeason.rpg.toFixed(1)],
                  ["APG", heroSeason.apg.toFixed(1)],
                  ["TS%", heroSeason.tsPct != null ? `${(heroSeason.tsPct * 100).toFixed(1)}` : "-"],
                ] as const
              ).map(([label, val]) => (
                <div className={styles.heroStat} key={label}>
                  <div className={styles.heroStatVal}>{val}</div>
                  <div className={styles.heroStatLabel}>
                    {label} · {shortSeason(heroSeason.seasonName)}
                  </div>
                  {/* 값 + 표본 + 기준 시즌(thesis (3)) - 타일 하나가 53경기인지 3경기인지 보이게. */}
                  <div className={styles.heroStatSample}>정규+PO {heroSeason.gpReg + heroSeason.gpPo}경기</div>
                </div>
              ))}
              {heroWpa && (
                <div className={styles.heroStat}>
                  <div className={styles.heroStatVal}>{signed(heroWpa.totalWpa)}</div>
                  <div className={styles.heroStatLabel}>WPA · {shortSeason(heroWpa.seasonName)}</div>
                  {/* player_season_wpa.games는 정규시즌 GP(워니 25-26 50 vs 정규+PO 53 - 검증) → '정규' 라벨 필수. */}
                  <div className={styles.heroStatSample}>
                    정규 {heroWpa.games}경기 · 리그 {heroWpa.rank}위/{heroWpa.outOf}
                  </div>
                </div>
              )}
            </div>
          )}
          {heroSeason && heroChip && <div className={styles.heroBasis}>{heroChip}</div>}
        </div>
      </section>

      {/* ── 1. 리그 퍼센타일 프로필 ── */}
      <div className={styles.panel}>
        {/* 제목의 기준 시즌은 항상 칩으로(원문 시즌 문자열 금지) - 같은 헬퍼가 두 페이지의 문구를 만든다. */}
        <div className={styles.panelTitle}>
          리그 퍼센타일 프로필
          {statChip && <span className={styles.panelChip}>{statChip}</span>}
          {statProgressChip && <span className={styles.panelChip}>{statProgressChip}</span>}
        </div>
        <PercentilePanel profile={percentile} seasonName={shotSeason ?? "-"} />
      </div>

      {/* ── 2. 슛 임팩트 리포트(기존 유지) ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          슛 임팩트 리포트
          {statChip && <span className={styles.panelChip}>{statChip}</span>}
          {statProgressChip && <span className={styles.panelChip}>{statProgressChip}</span>}
        </div>
        <form className={styles.heatRow}>
          <label>시즌</label>
          <select name="season" defaultValue={shotSeason ?? undefined} className={styles.heatSelect} disabled={!seasonNames.length}>
            {seasonNames.length ? (
              [...seasonNames].reverse().map((sn) => (
                <option key={sn} value={sn}>
                  {sn}
                </option>
              ))
            ) : (
              <option>데이터 없음</option>
            )}
          </select>
          <button type="submit" className="btn-primary">
            조회
          </button>
        </form>
        {headerStats && (
          <div className={`${styles.statGrid} ${styles.impactHeaderRow}`}>
            {(
              [
                ["PTS", headerStats.pts.toLocaleString()],
                ["TSA", headerStats.tsa.toFixed(1)],
                ["PSA", headerStats.psa != null ? headerStats.psa.toFixed(2) : "-"],
                ["USG%", headerStats.usgPct != null ? `${headerStats.usgPct.toFixed(1)}%` : "-"],
                ["MOREY%", headerStats.moreyPct != null ? `${(headerStats.moreyPct * 100).toFixed(1)}%` : "-"],
              ] as const
            ).map(([label, val]) => (
              <div className={styles.statTile} key={label}>
                <div className={styles.sv}>{val}</div>
                <div className={styles.sl}>{label}</div>
              </div>
            ))}
          </div>
        )}
        <div className={styles.courtTilt}>
          {/* 점 하나 = 슛 하나(성공=채운 원/실패=테두리만, zoneCompare.ts 관례), 색은 그 슛이
              존 기대값보다 이득(--positive)인지 손해(--negative)인지 - lib/shotImpactChart.ts. */}
          <svg
            className={styles.courtSvg}
            viewBox="345 27 375 357"
            dangerouslySetInnerHTML={{ __html: impactSvg ?? "" }}
          />
        </div>
        <div className={styles.heatStat}>
          {impactSvg
            ? `${seasonShots.length.toLocaleString()}회 시도 · ${totalMade.toLocaleString()}회 성공 (${Math.round(
                (totalMade / seasonShots.length) * 100
              )}%)`
            : "이 시즌 슛 데이터 없음"}
        </div>
      </div>

      {/* ── 3. 슈팅 DNA - 존 구성비의 커리어 변화 ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>슈팅 DNA · 존 구성비 변화</div>
        <ShootingDnaChart mix={dnaMix} />
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          유발 파울 · 어시스트 · 턴오버
          {statChip && <span className={styles.panelChip}>{statChip}</span>}
          {statProgressChip && <span className={styles.panelChip}>{statProgressChip}</span>}
        </div>
        {boxTotals && boxTotals.gp > 0 ? (
          <div className={styles.miniStatGrid}>
            <div className={styles.miniStatCard}>
              <div className={styles.miniStatLabel}>유발 파울(추정)</div>
              <div className={styles.miniStatMain}>{drawnFoulProxy!.fta.toLocaleString()}</div>
              <div className={styles.miniStatSub}>
                FTr {drawnFoulProxy!.ftr != null ? drawnFoulProxy!.ftr.toFixed(2) : "-"}
              </div>
              <div className={styles.miniStatNote}>
                이벤트 로그(파울자유투)에는 &quot;파울을 당한&quot; 선수가 아니라 &quot;파울을 범한&quot; 선수만 기록돼
                있어, 정확한 유발 파울 횟수 대신 자유투 시도 수(FTA)를 근사치로 표시 · FTr = FTA/FGA
              </div>
            </div>
            <div className={styles.miniStatCard}>
              <div className={styles.miniStatLabel}>어시스트</div>
              <div className={styles.miniStatMain}>{boxTotals.ast.toLocaleString()}</div>
              <div className={styles.miniStatSub}>{astPerGame != null ? `${astPerGame.toFixed(1)} / 경기` : "-"}</div>
            </div>
            <div className={styles.miniStatCard}>
              <div className={styles.miniStatLabel}>턴오버</div>
              <div className={styles.miniStatMain}>{boxTotals.tov.toLocaleString()}</div>
              <div className={styles.miniStatSub}>{tovPerGame != null ? `${tovPerGame.toFixed(1)} / 경기` : "-"}</div>
            </div>
          </div>
        ) : (
          <div className="empty-note">{emptyState("none")}</div>
        )}
      </div>

      {/* ── 4. 클러치 프로필(커리어) ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>클러치 프로필 · 커리어</div>
        {clutch && clutch.totals.plays > 0 ? (
          <>
            <div className={styles.statGrid}>
              {(
                [
                  ["클러치 PTS", clutch.totals.pts.toLocaleString()],
                  ["FG", `${clutchFgm}/${clutchFga}`],
                  ["3PT", `${clutch.totals.fg3m}/${clutch.totals.fg3a}`],
                  ["FT", `${clutch.totals.ftm}/${clutch.totals.fta}`],
                  ["WPA 합", signed(clutch.totals.wpaTotal)],
                  ["경기", clutch.totals.games.toLocaleString()],
                ] as const
              ).map(([label, val]) => (
                <div className={styles.statTile} key={label}>
                  <div className={styles.sv}>{val}</div>
                  <div className={styles.sl}>{label}</div>
                </div>
              ))}
            </div>
            {clutch.moments.length > 0 && (
              <div className={styles.momentList}>
                {clutch.moments.map((m) => {
                  const oppTcode = m.tcode === m.homeTcode ? m.awayTcode : m.homeTcode;
                  const oppTeam = teamByTcode.get(oppTcode);
                  const oppName = displayTeamName(oppTcode, oppTeam?.name ?? oppTcode, m.seasonName);
                  const clock = `${String(m.clockMin).padStart(2, "0")}:${String(m.clockSec).padStart(2, "0")}`;
                  const period = m.quarter.startsWith("X") ? `연장${m.quarter.slice(1)}` : m.quarter;
                  return (
                    <Link href={`/games/${m.gmkey}`} className={styles.momentCard} key={`${m.gmkey}-${clock}`}>
                      <span className={styles.momentWpa} style={{ color: m.wpaTeam >= 0 ? "var(--positive)" : "var(--negative)" }}>
                        {signed(m.wpaTeam * 100, 1)}%p
                      </span>
                      <span className={styles.momentText}>
                        {m.gameDate} vs {oppName} · {period} {clock} 남기고 {m.actionLabel} ({m.homeScore}-{m.awayScore})
                      </span>
                      <span className={styles.momentGo}>경기 보기 →</span>
                    </Link>
                  );
                })}
              </div>
            )}
            <div className={styles.pctNote}>
              클러치 = 4쿼터·연장 잔여 5:00 이내 & 그 순간 5점차 이내 · WPA = 그 플레이로 움직인 팀 승률의 누적(%p는 승률
              변화폭)
            </div>
          </>
        ) : (
          <div className="empty-note">클러치 상황 기록 없음</div>
        )}
      </div>

      {/* ── 5. 시너지 & 임팩트 ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>시너지 & 임팩트</div>
        <div className={styles.miniStatGrid}>
          {combos.length > 0 ? (
            combos.map((c, i) => (
              <Link href={`/players/${c.partnerPcode}`} className={`${styles.miniStatCard} ${styles.comboCard}`} key={c.partnerPcode}>
                <div className={styles.miniStatLabel}>베스트 2인 조합 #{i + 1}</div>
                <div className={styles.miniStatMain}>{c.partnerName}</div>
                <div className={styles.miniStatSub}>
                  <span style={{ color: c.netRatingPer40 >= 0 ? "var(--positive)" : "var(--negative)" }}>
                    NET {signed(c.netRatingPer40)}
                  </span>{" "}
                  /40분 · 함께 {Math.round(c.minutes)}분
                </div>
              </Link>
            ))
          ) : (
            <div className={styles.miniStatCard}>
              <div className={styles.miniStatLabel}>베스트 2인 조합</div>
              <div className={styles.miniStatSub}>함께 {COMBO_MIN_MINUTES}분 이상 뛴 조합 없음</div>
            </div>
          )}
          <div className={styles.miniStatCard}>
            {/* player_onoff엔 오프코트 컬럼이 없어 진짜 온-오프 차이는 계산 불가 - 온코트
                넷레이팅만 있는 그대로 표기(검증 지적 반영, 제목이 과장하지 않게). */}
            <div className={styles.miniStatLabel}>온코트 넷레이팅 (커리어)</div>
            <div className={styles.miniStatMain} style={onOff ? { color: onOff.netRatingPer40 >= 0 ? "var(--positive)" : "var(--negative)" } : undefined}>
              {onOff ? signed(onOff.netRatingPer40) : "-"}
            </div>
            <div className={styles.miniStatSub}>{onOff ? `코트 위 NET/40분 · ${Math.round(onOff.minutes)}분 표본` : "표본 없음"}</div>
          </div>
          <div className={styles.miniStatCard}>
            {/* player_season_wpa는 정규시즌만 집계 - 옆의 정규+PO 라인과 섞이지 않도록 라벨에 '정규'를 박는다. */}
            <div className={styles.miniStatLabel}>
              승리 기여 WPA(정규)
              {statChip && <span className={styles.panelChip}>{statChip}</span>}
            </div>
            <div className={styles.miniStatMain} style={wpaRank ? { color: wpaRank.totalWpa >= 0 ? "var(--positive)" : "var(--negative)" } : undefined}>
              {wpaRank ? signed(wpaRank.totalWpa) : "-"}
            </div>
            <div className={styles.miniStatSub}>
              {wpaRank
                ? `리그 ${wpaRank.rank}위 / ${wpaRank.outOf}명 · 정규 ${wpaRank.games}경기 · 경기당 ${signed(wpaRank.wpaPerGame, 2)}`
                : shotSeason === PRESEASON_SEASON
                  ? emptyState("offline")
                  : "이 시즌 WPA 집계 없음"}
            </div>
          </div>
        </div>
        <div className={styles.pctNote}>
          2인 조합은 커리어 통산 넷레이팅(/40분) 상위, 함께 뛴 시간 {COMBO_MIN_MINUTES}분 이상만 · 온/오프는 15시즌 통산
        </div>
      </div>

      {/* ── 6. 커리어 아크 ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>커리어 아크 · 시즌별 궤적</div>
        <CareerArcChart seasonsAsc={seasonsAsc} />
      </div>

      {recentGames.length > 0 && (
        <div className={styles.windowRow}>
          {WINDOWS.map((wn) => (
            <Link
              key={wn}
              href={`?w=${wn}`}
              className={`${styles.wtoggle} ${windowN === wn ? styles.wtoggleActive : ""}`}
            >
              L{wn}
            </Link>
          ))}
        </div>
      )}

      <div className={styles.panel}>
        <div className={styles.panelTitle}>최근 경기 득점 · 출전시간</div>
        <PerfChart games={windowGames} />
        <div className={styles.perfLegend}>
          <span>
            <span className={styles.sw} style={{ background: "var(--home)" }} />
            득점(PTS)
          </span>
          <span>
            <span className={styles.sw} style={{ background: "var(--gold)" }} />
            출전시간(MIN)
          </span>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>{windowAvg ? `최근 ${windowAvg.gp}경기 평균` : "선택 구간 평균"}</div>
        {windowAvg ? (
          <div className={styles.statGrid}>
            {(
              [
                ["MIN", windowAvg.min.toFixed(1)],
                ["PTS", windowAvg.pts.toFixed(1)],
                ["REB", windowAvg.reb.toFixed(1)],
                ["AST", windowAvg.ast.toFixed(1)],
                ["STL", windowAvg.stl.toFixed(1)],
                ["BLK", windowAvg.blk.toFixed(1)],
                ["TOV", windowAvg.tov.toFixed(1)],
                ["FG%", windowAvg.fgPct != null ? `${windowAvg.fgPct.toFixed(1)}%` : "-"],
                ["3P%", windowAvg.tpPct != null ? `${windowAvg.tpPct.toFixed(1)}%` : "-"],
                ["FT%", windowAvg.ftPct != null ? `${windowAvg.ftPct.toFixed(1)}%` : "-"],
              ] as const
            ).map(([label, val]) => (
              <div className={styles.statTile} key={label}>
                <div className={styles.sv}>{val}</div>
                <div className={styles.sl}>{label}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-note">경기 기록 없음</div>
        )}
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>게임 로그</div>
        {windowGames.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>상대</th>
                  <th>결과</th>
                  <th>MIN</th>
                  <th>PTS</th>
                  <th>REB</th>
                  <th>AST</th>
                  <th>STL</th>
                  <th>BLK</th>
                  <th>TOV</th>
                  <th>FG</th>
                  <th>3P</th>
                  <th>FT</th>
                </tr>
              </thead>
              <tbody>
                {windowGames.map((g) => {
                  const oppTeam = teamByTcode.get(g.oppTcode);
                  return (
                    <tr key={g.gmkey}>
                      <td>
                        <Link href={`/games/${g.gmkey}`}>{g.gameDate}</Link>
                      </td>
                      <td>
                        <span className={styles.glOpp}>
                          {g.isHome ? "vs" : "@"}
                          <TeamBadge team={oppTeam ?? null} size={16} />
                          {g.oppName}
                        </span>
                      </td>
                      <td>
                        <span className={`${styles.glResult} ${g.win ? styles.glResultWin : styles.glResultLoss}`}>
                          {g.win ? "W" : "L"}
                        </span>
                      </td>
                      <td>{g.min.toFixed(1)}</td>
                      <td>{g.pts}</td>
                      <td>{g.reb}</td>
                      <td>{g.ast}</td>
                      <td>{g.stl}</td>
                      <td>{g.blk}</td>
                      <td>{g.tov}</td>
                      <td>
                        {g.fgm}/{g.fga}
                      </td>
                      <td>
                        {g.tpm}/{g.tpa}
                      </td>
                      <td>
                        {g.ftm}/{g.fta}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-note">게임 로그 없음</div>
        )}
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>시즌별 기록</div>
        {seasonLines.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>시즌</th>
                  <th>팀</th>
                  <th>GP</th>
                  <th>MIN</th>
                  <th>PTS</th>
                  <th>REB</th>
                  <th>AST</th>
                  <th>STL</th>
                  <th>BLK</th>
                  <th>TOV</th>
                  <th>FG%</th>
                  <th>3P%</th>
                  <th>FT%</th>
                </tr>
              </thead>
              <tbody>
                {seasonLines.map((l) => {
                  const team = teamByTcode.get(l.tcode);
                  const b = l.all;
                  return (
                    <tr key={`${l.seasonName}-${l.tcode}`} className={l.seasonName === latestSeason ? styles.curSeason : ""}>
                      <td>{l.seasonName}</td>
                      <td>
                        <span className={styles.glOpp}>
                          <TeamBadge team={team ?? null} size={16} />
                          {/* 팀명은 그 시즌 표기 기준(전주 KCC → 부산 KCC) - displayTeamName. */}
                          {displayTeamName(l.tcode, team?.name ?? l.tcode, l.seasonName)}
                        </span>
                      </td>
                      <td>{b.gp}</td>
                      <td>{b.minPg.toFixed(1)}</td>
                      <td>{b.ppg.toFixed(1)}</td>
                      <td>{b.rpg.toFixed(1)}</td>
                      <td>{b.apg.toFixed(1)}</td>
                      <td>{b.spg.toFixed(1)}</td>
                      <td>{b.bpg.toFixed(1)}</td>
                      <td>{b.tovPg.toFixed(1)}</td>
                      <td>{pct(b.fgPct)}</td>
                      <td>{pct(b.tpPct)}</td>
                      <td>{pct(b.ftPct)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-note">시즌 기록 없음</div>
        )}
      </div>

      <footer className="foot">
        2011-12~2025-26 시즌 전체 경기 기준 · 게임로그는 최근 30경기까지만 보관 · Supabase에서 실시간 조회
      </footer>
    </div>
  );
}
