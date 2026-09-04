import Link from "next/link";
import type { CSSProperties } from "react";
import { notFound } from "next/navigation";
import {
  getPlayerInfo,
  getPlayerCareerGames,
  getPlayerRecentGames,
  getAllTeams,
  WINDOWS,
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
  getSeasonWpaRank,
  computeShootingDna,
  DNA_ZONES,
  DNA_ZONE_LABELS,
  PERCENTILE_MIN_GP,
  PERCENTILE_MIN_MINUTES,
  type SeasonZoneMix,
  type PercentileProfile,
} from "@/lib/playerDataScience";
import { getPlayerCombos } from "@/lib/lineupCombos";
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
import { aggregateCareer, getPlayerWpaBySeason } from "@/lib/playerPageData";
import { getCareerGrain, type CareerNight } from "@/lib/careerGrain";
import { buildCareerStripSvg, CELL_MAX_W, GAP_RESERVE } from "@/lib/careerStrip";
import { getPlayerForm } from "@/lib/playerForm";
import { getPlayerGlance } from "@/lib/playerGlance";
import { displayTeamName } from "@/lib/teamNames";
import { TeamBadge } from "@/components/TeamBadge";
import { PlayerGlanceCard } from "@/components/PlayerGlance";
import { PlayerFormPanel, resolveFormUnit } from "@/components/PlayerForm";
import { RecentWindow } from "@/components/RecentWindow";
import { RECENT_RATE_PARAM, resolveRecentRate } from "@/lib/recentWindow";
import { SynergyCombos } from "@/components/SynergyCombos";
import { WinImpactPanel } from "@/components/WinImpact";
import { getWinImpact } from "@/lib/winImpact";
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

// ── 커리어 결 띠(lib/careerGrain.ts + lib/careerStrip.ts)를 페이지에 붙일 때의 두 결정 ──────
//
// (1) 히어로 발치 밴드가 옛 "커리어 아크"(시즌별 PPG 곡선)를 대체한다. 아크는 시즌당 점 하나라
//     결장·이적·0분 출전이 전부 평균 안으로 사라졌고, 무엇보다 커리어 기록이 있는 명단 198명
//     전원에게 그려지지 않았다(2시즌 미만이면 "곡선을 그리지 않음" 문구만 남았다). 띠는 밤 하나가
//     칸 하나라 1경기 커리어도 그대로 그려진다.
// (2) §9의 L5/L10/L15/L30 토글은 그대로 살아서 recentN을 몬다. 다만 창의 단위는 "밤"이 아니라
//     "출전"이다 - 그래야 L15가 바로 아래 '최근 15경기 평균' 패널과 같은 15경기를 가리킨다.
//     그 15번째 출전까지 거슬러 올라가는 동안 낀 결장 칸은 함께 그린다(그게 띠의 문법이다).
function nightsForRecentAppearances(nights: CareerNight[], wantPlayed: number): number {
  let seen = 0;
  for (let i = nights.length - 1; i >= 0; i--) {
    if (nights[i].kind !== "played") continue;
    seen += 1;
    if (seen >= wantPlayed) return nights.length - i;
  }
  return nights.length;
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
// 요청: "림과 근거리 중거리 색상이 비슷해서, 구분이 조금 어려움, 좀더 다채로운 색상으로".
// 실제로 그랬다 - 예전 값은 림 --hot(#e8590c) / 근거리 --home(#d9640a) / 중거리 --gold(#9a6b00)로
// 셋 다 주황·갈색이었다(색상 23°/27°/42°). 이제 거리 순서를 그대로 따라가는 5단 램프를 쓴다:
// 진홍 → 주황 → 호박 → 초록 → 남색. 토큰 정의는 player-profile.module.css(두 테마 각각).
// 색만으로 읽히지 않도록 밴드 오른쪽 끝과 100% 바 안에 이름·비율을 직접 적는다.
const DNA_COLORS: Record<(typeof DNA_ZONES)[number], string> = {
  rim: "var(--dna-rim)",
  close: "var(--dna-close)",
  midShort: "var(--dna-mid)",
  midLong: "var(--dna-long)",
  three: "var(--dna-three)",
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
              <div
                key={z}
                className={styles.dnaSingleSeg}
                style={{ width: `${m.shares[z] * 100}%`, background: DNA_COLORS[z] }}
                title={`${DNA_ZONE_LABELS[z]} ${(m.shares[z] * 100).toFixed(1)}%`}
              >
                {/* 칸이 좁으면 글자가 잘려 오히려 안 읽힌다 - 8% 이상일 때만 안에 적는다. */}
                {m.shares[z] >= 0.08 ? `${Math.round(m.shares[z] * 100)}%` : ""}
              </div>
            ) : null
          )}
        </div>
        <div className={styles.dnaLegend}>
          {DNA_ZONES.map((z) => (
            <span key={z}>
              <span className={styles.sw} style={{ background: DNA_COLORS[z] }} />
              {DNA_ZONE_LABELS[z]} <b>{(m.shares[z] * 100).toFixed(0)}%</b>
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
    H = 230,
    PAD_L = 30,
    // 오른쪽에 밴드 이름·최신 비율을 직접 적는다(범례와 스와치를 눈으로 맞추지 않게).
    PAD_R = 78,
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

  // 오른쪽 끝 라벨 - 마지막 시즌 기준 밴드의 세로 중앙에 존 이름과 비율. 3% 미만 밴드는
  // 적을 자리가 없어 생략하고(범례가 대신 든다), 남은 라벨끼리 겹치면 아래로 밀어 뗀다.
  const last = n - 1;
  const labels = DNA_ZONES.map((z, zi) => {
    const top = cumAt(last, zi);
    const bottom = zi === 0 ? 0 : cumAt(last, zi - 1);
    return { z, share: mix[last].shares[z], y: yAt((top + bottom) / 2) };
  })
    .filter((l) => l.share >= 0.03)
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y - labels[i - 1].y < 12) labels[i].y = labels[i - 1].y + 12;
  }

  return (
    <div>
      <svg className={styles.dnaSvg} viewBox={`0 0 ${W} ${H}`}>
        {/* 밴드 사이에 패널색 실선을 얇게 둘러 인접 밴드가 서로 번지지 않게. */}
        {DNA_ZONES.map((z, zi) => (
          <path key={z} d={bandPath(zi)} fill={DNA_COLORS[z]} opacity={0.9} stroke="var(--surface)" strokeWidth={0.7} />
        ))}
        {labels.map((l) => (
          <text
            key={l.z}
            x={W - PAD_R + 6}
            y={l.y + 3.5}
            fontSize={10}
            fill={DNA_COLORS[l.z]}
            fontFamily="IBM Plex Mono, monospace"
            fontWeight={700}
          >
            {DNA_ZONE_LABELS[l.z]} {Math.round(l.share * 100)}%
          </text>
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
        <span>오른쪽 라벨 = {shortSeason(mix[n - 1].season)} 비율</span>
      </div>
    </div>
  );
}

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ pcode: string }>;
  searchParams: Promise<{ w?: string; season?: string; rate?: string; rw?: string }>;
}) {
  const { pcode } = await params;
  const { w, season, rate, rw } = await searchParams;
  const info = await getPlayerInfo(pcode);
  if (!info) notFound();

  // 창(L5/L10/L15/L30)과 폼 단위(75포제션당/40분당)는 쿼리만 보면 정해진다 - 조회보다 먼저
  // 확정해 둬야 2차 파도에서 getPlayerForm(recentN)을 나란히 띄울 수 있다(직렬 대기 방지).
  // 두 값 모두 화이트리스트를 통과한 것만 쓴다(?w=아무말 / ?rate=아무말이 그대로 화면에
  // 찍히거나 링크로 되돌아가지 않도록 - ?season=과 같은 규칙).
  const windowN = WINDOWS.includes(Number(w) as (typeof WINDOWS)[number]) ? Number(w) : 15;
  const formUnit = resolveFormUnit(rate);
  // 최근 창의 단위(경기당/36분당). ?rate=는 아래 폼 패널이 이미 per75/per40으로 점유하고 있어
  // 이 패널은 ?rw=를 쓴다 - 같은 파라미터를 나눠 쓰면 한쪽 토글이 다른 쪽 선택을 조용히 지운다.
  const recentRate = resolveRecentRate(rw);

  // 1차: 시즌 선택과 무관한 조회(클러치/시너지/온오프/존 기대값 포함)를 전부 병렬로. 커리어 경기
  // 행(getPlayerCareerGames)은 로스터 상태 판정·히어로 타일·커리어 아크·시즌별 기록표가 모두
  // 공유하므로 한 번만 읽는다(기존 getPlayerCareerBySeason과 중복 조회하지 않기 위해 교체).
  const [careerRows, recentGames, teamByTcode, careerShots, clutch, combos, onOffMap, zoneExpectedPts, winImpact] =
    await Promise.all([
      getPlayerCareerGames(pcode),
      getPlayerRecentGames(pcode),
      getAllTeams(),
      getCareerShots(pcode),
      getClutchProfile(pcode),
      // 2인만 보던 시너지 카드를 2·3·4·5인 조합표로 교체(요청: "3인/4인/5인 조합도").
      // 크기별 임계값·정렬 근거는 lib/lineupCombos.ts 주석에 실측과 함께 있다.
      getPlayerCombos(pcode),
      getPlayerOnOffRatings([pcode]),
      getZoneExpectedPts(),
      // 미리 구운 1행(tools/build_player_win_impact.py) - 실시간 집계는 콜드 1.1~2.1초라 못 얹는다.
      getWinImpact(pcode),
    ]);

  // 2차: 확정 명단(season_roster) 대조 - 히어로 정체성(팀·등번호·포지션)의 유일한 출처다.
  // recentGames[0]에서 신분을 추론하면 이적 선수가 옛 팀 배지·옛 등번호를 단 채로 렌더된다
  // (해먼즈 291698 실측: 마지막 경기 tcode 10 울산 현대모비스 #2 'FD' vs 26-27 명단 tcode 16
  // 원주 DB · back_num NULL · note '외국인 2옵션 | MOB→DB 이적'). 커리어 행은 그대로 넘겨 재조회 없음.
  // 커리어 결 띠도 같은 careerRows를 재사용한다(출전 절반은 추가 왕복 0). 남는 비용은 팀 경기
  // 1~2페이지 + season_roster 1건 + 공백 시즌 확인 몇 건뿐이라 로스터 상태 조회와 나란히 돈다.
  // 다중 시즌 폼(75포제션당)도 같은 파도에 넣는다 - careerRows를 주입하므로 커리어 경기 재조회는
  // 0이고, 남는 비용은 팀-경기 한 갈래(4시즌 약 2,280행/3페이지, 15시즌 김선형도 병렬 9페이지)뿐이라
  // 로스터 상태·커리어 결과 나란히 돌면 벽시계 시간이 늘지 않는다. 한눈 카드가 이 form을 재사용한다.
  const [status, grain, form] = await Promise.all([
    getPlayerRosterStatus(pcode, careerRows),
    getCareerGrain(pcode, careerRows),
    getPlayerForm(pcode, { careerRows, recentN: windowN }),
  ]);
  // "이번 시즌"의 정의는 lib/seasonFocus.ts 한 곳에서만 - 추정 패널(평균·퍼센타일·슛)은 statSeason을
  // 받아 개막일 밤에 1경기 평균이 시즌 수치로 승격되는 일이 없게 한다(선수 임계 10GP).
  const focus = resolvePlayerSeasons(pcode, status.seasonsPlayedDesc, status.state === "active");

  const { lines: seasonLines, seasonsAsc } = aggregateCareer(careerRows);
  const careerGp = careerRows.length;
  const seasonNames = seasonsAsc.map((s) => s.seasonName);
  // 시즌별 기록표에서 "가장 최근 시즌" 행을 강조 - 사실(출전 기록이 있는 최신 시즌)이라 첫 경기부터 바뀐다.
  const latestSeason = seasonLines.length ? seasonLines[0].seasonName : null;

  const windowGames = recentGames.slice(0, windowN);

  const headerTeam = status.tcode ? (teamByTcode.get(status.tcode) ?? null) : null;

  // ?season= 쿼리로 직접 고른 시즌이 있으면 그 시즌, 없으면 statSeason(개막 전·표본 미달이면 마지막 시즌).
  // 쿼리 값은 반드시 화이트리스트로 검증한다 - 그러지 않으면 ?season=아무말이 그대로 기준 칩에
  // 찍혀서 페이지가 없는 시즌을 근거로 단언하는 것처럼 보인다(검증 지적).
  const selectableSeasons = new Set<string>([...seasonNames, PRESEASON_SEASON]);
  const seasonQuery = season && selectableSeasons.has(season) ? season : undefined;
  const shotSeason = seasonQuery ?? focus.statSeason;
  // 세 쿼리(?w= 창 · ?season= 시즌 · ?rate= 폼 단위)는 서로를 지우지 않아야 한다 - 예전 창 토글은
  // href="?w=15"라 시즌을 고른 뒤 L30을 누르는 순간 시즌 선택이 조용히 초기화됐다. 검증을 통과한
  // 값만 다시 싣는다(?season=아무말이 링크를 타고 되돌아오지 않도록).
  const windowHref = (wn: number) => {
    const q = new URLSearchParams({ w: String(wn) });
    if (seasonQuery) q.set("season", seasonQuery);
    if (rate) q.set("rate", formUnit);
    // 창을 바꿔도 36분당 선택이 풀리지 않게(세 토글이 서로를 지우지 않는다).
    if (rw) q.set(RECENT_RATE_PARAM, recentRate);
    return `?${q.toString()}`;
  };
  // 3차: 선택 시즌 의존 조회(퍼센타일 RPC는 실측 29ms) + 시즌별 WPA(히어로 WPA 타일·정규시즌 집계)
  // + 한눈 카드. 퍼센타일 RPC는 한 번만 쏘고 §1과 한눈 카드가 같은 결과를 나눠 쓴다 - 단, 카드가
  // 집계하는 시즌은 언제나 focus.statSeason이므로 ?season=으로 다른 시즌을 고른 순간 이 퍼센타일은
  // 카드와 다른 표본이 된다. 그때는 넘기지 않고(undefined) 카드가 자기 시즌 것을 따로 받게 둔다 -
  // 값과 퍼센타일의 기준이 어긋난 칸을 만들지 않기 위해서다.
  const percentileP = shotSeason ? getPercentileProfile(pcode, shotSeason) : Promise.resolve(null);
  const glancePercentileP: Promise<PercentileProfile | null | undefined> =
    shotSeason === focus.statSeason ? percentileP : Promise.resolve(undefined);
  const [boxTotals, percentile, wpaRank, wpaBySeason, glance] = await Promise.all([
    shotSeason ? getPlayerSeasonBoxTotals(pcode, shotSeason) : Promise.resolve(null),
    percentileP,
    shotSeason ? getSeasonWpaRank(pcode, shotSeason) : Promise.resolve(null),
    getPlayerWpaBySeason(pcode, seasonNames),
    // 한눈 카드: 페이지가 이미 가진 것(커리어 경기·폼·커리어 슛·클러치·커리어 결)을 전부 주입해
    // 재조회를 없앤다. 남는 조회는 온/오프 + 시즌 WPA + 분 가중 고급지표 세 갈래뿐이고, 그것도
    // 이 파도의 나머지와 동시에 돈다(직렬 waterfall 추가 없음).
    glancePercentileP.then((p) =>
      getPlayerGlance(pcode, focus.statSeason, {
        careerRows,
        form,
        careerShots,
        percentile: p,
        clutch,
        grain,
      })
    ),
  ]);

  // 시즌 의존 패널의 기준 칩은 전부 여기서 만든다(shared_design_language (2) - 다섯 어휘만 존재).
  const panelChip = (s: string | null): string | null => {
    if (!s) return null;
    if (s === focus.statSeason) return statSeasonChip(focus);
    // ?season=2026-2027처럼 아직 진행 중인 시즌을 직접 고른 경우 - "최종"이라고 쓰면 거짓이 된다.
    if (s === PRESEASON_SEASON) return basisChip("inprogress", { n: focus.focusGp, threshold: focus.thresholdLabel });
    // "마지막 KBL 시즌"은 그 선수가 그 뒤로 뛰지 않았을 때만 참이다. 예전 조건(s가 현재 시즌보다
    // 옛 시즌인가)은 선수와 무관해서, 워니에게 ?season=2024-2025를 걸면 25-26을 50경기 뛴 선수의
    // 24-25가 '마지막 KBL 시즌'으로 찍혔다(실측). 실제 기준은 "그 선수의 최신 출전 시즌인가".
    const isPlayersLast = s === latestSeason && s < prevSeasonName(PRESEASON_SEASON);
    return basisChip("final", { season: s, last: isPlayersLast });
  };
  const statChip = panelChip(shotSeason ?? null);
  // 개막 후·임계 전에만 붙는 두 번째 칩('26-27 진행 중 · 3경기 (임계 10경기)'). 다른 시즌을 직접 고른 경우엔 생략.
  const statProgressChip = shotSeason === focus.statSeason ? progressChip(focus) : null;
  // ?season=으로 기준 시즌이 아닌 시즌을 고른 경우 = 화면 맨 위 한눈 카드(언제나 focus.statSeason)와
  // 그 아래 모든 패널(선택 시즌)이 서로 다른 시즌을 답하는 상태. 실측: /players/291248?season=2024-2025
  // 는 카드 칩 '25-26 최종' 바로 아래에서 패널 칩이 전부 '24-25 최종'으로 찍힌다. 칩 두 개가 각자
  // 자기 시즌을 밝히긴 하지만 세로로 붙어 있어 차이가 오히려 눈에 안 띄고, 스크롤하지 않은 독자가
  // 카드 숫자를 "내가 고른 24-25"로 읽을 여지가 남는다. 그래서 두 기준이 갈리는 자리(카드와 §1 사이)에
  // 그 사실을 문장으로 한 줄 세운다. seasonQuery에서 유도해야 값이 string으로 좁혀진다
  // (shotSeason은 seasonQuery가 없으면 focus.statSeason과 같으므로 어긋남 자체가 성립하지 않는다).
  const glanceSeasonMismatch: string | null =
    seasonQuery && seasonQuery !== focus.statSeason ? seasonQuery : null;

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

  // ── 커리어 결 띠 ─────────────────────────────────────────────────────────────────────
  // 팀 색은 원본(teams.color)을 그대로 넘긴다 - 빌더 안에서 lib/teamAccent.ts accentFor를 태운다
  // (KT #1A1A1A를 날것으로 쓰면 히어로의 딥다크 배경에서 사라진다).
  const teamColors = new Map<string, string | null | undefined>();
  const teamAbbrs = new Map<string, string>();
  for (const [tc, t] of teamByTcode) {
    teamColors.set(tc, t.color);
    teamAbbrs.set(tc, t.abbr);
  }
  // 히어로 발치 밴드: 폭 800 · 높이 72는 --strip-h(72px)와 1:1로 맞춘 값이라 데스크톱(.wrap 900px)
  // 에서 뷰박스가 거의 등배로 그려진다. 밤이 0개면 빌더가 null을 돌려주고 밴드 자체를 안 그린다
  // (커리어 기록이 없는 선수 - 26-27 명단 중 pcode가 없는 15명이 여기에 해당).
  const heroStrip = buildCareerStripSvg(grain, {
    uid: `hero${pcode}`,
    teamColors,
    teamAbbrs,
    width: 800,
    height: 72,
    tone: "hero",
  });
  // §9 확대판: 마지막 windowN "출전"까지 거슬러 올라간 구간. 뷰박스 폭을 칸 수에 딱 맞춰 요청해
  // (칸 상한 9 × 칸 수 + 좌우 여백) 오른쪽에 빈 공간이 남지 않게 한다. 커리어 끝에 공백 시즌
  // 표식이 붙는 선수(배스)는 빌더가 오른쪽에 GAP_RESERVE만큼 예약하므로 그만큼 더 요청한다
  // (숫자를 여기 베껴 두면 빌더 쪽이 바뀔 때 딱 맞는 폭이 조용히 어긋난다 - 그래서 상수를 가져온다).
  const zoomCells = grain.nights.length ? nightsForRecentAppearances(grain.nights, windowN) : 0;
  const lastNightYear = grain.nights.length ? Number(grain.nights[grain.nights.length - 1].seasonName.slice(0, 4)) : 0;
  const zoomGapReserve = grain.gapSeasons.some((s) => Number(s.slice(0, 4)) > lastNightYear) ? GAP_RESERVE : 0;
  const zoomStrip = zoomCells
    ? buildCareerStripSvg(grain, {
        uid: `zoom${pcode}`,
        teamColors,
        teamAbbrs,
        recentN: zoomCells,
        width: zoomCells * CELL_MAX_W + 6 + zoomGapReserve,
        height: 92,
        tone: "surface",
        // 확대판은 언제나 경기 단위(칸 = 클릭 가능한 한 경기). "띠는 질감, 패널은 개별 경기".
        detail: "cell",
      })
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
        {/* ── 히어로 발치: 커리어 결 띠 ──────────────────────────────────────────────────
            칸 하나 = 하룻밤, 왼쪽부터 날짜순. 높이 = 그날 득점, 색 = 그날의 소속팀(이적하면 띠
            중간에서 색이 바뀐다), 빈칸 = 등록 기간 안의 결장. SVG는 조각 문자열이라 뷰박스는
            반드시 빌더가 준 값을 쓴다(칸이 많으면 800보다 넓어진다 - 김선형 1297.2). */}
        {heroStrip && (
          <div className={styles.heroFoot}>
            <svg
              className={styles.heroFootSvg}
              viewBox={heroStrip.viewBox}
              preserveAspectRatio="xMidYMid meet"
              dangerouslySetInnerHTML={{ __html: heroStrip.svg }}
            />
            <div className={styles.heroFootCaption}>{heroStrip.caption}</div>
            <div className={styles.heroFootNote}>{heroStrip.note}</div>
          </div>
        )}
      </section>

      {/* ── 0. 한눈 카드 - 히어로 바로 아래, 기존 패널 전부보다 위 ──────────────────────
          요청 그대로("첫 화면에 한눈에 볼 수 있는 개인별 시각화, 밑에는 이제 우리가 만든
          자세한 내용"): "이 선수가 어떤 선수인가"를 한 화면에서 답하는 22칸 고정 격자가 먼저
          오고, 아래의 기존 패널들은 순서 그대로 남아 '자세한 내용'을 맡는다.
          기준 칩은 카드가 focus로 직접 만든다(이 페이지 panelChip과 같은 규칙) - ?season=으로
          다른 시즌을 골라도 카드는 언제나 focus.statSeason 하나만 집계하므로 statChip(선택 시즌
          기준)을 넘기면 칩과 값의 기준이 어긋난다. 그래서 넘기지 않는다.
          chip prop으로 "선택 시즌과 다름"을 덧붙이는 길도 있었지만, chip을 넘기는 순간 카드가
          두 번째 칩(개막 후·임계 전 '26-27 진행 중 · N경기')을 스스로 지운다. 그 정보를 잃지 않으려고
          카드 칩은 건드리지 않고, 대신 기준이 갈리는 자리에 아래 한 줄을 세운다.
          카드가 자기 .card 래퍼를 들고 오므로 styles.panel로 한 겹 더 감싸지 않는다. */}
      <PlayerGlanceCard glance={glance} focus={focus} teams={teamByTcode} />

      {/* 카드(기준 시즌)와 아래 패널(선택 시즌)의 기준이 갈렸을 때만 뜨는 이음새 문장.
          카드를 선택 시즌으로 재집계하지 않는 이유까지 같이 밝힌다 - 퍼센타일은 그 시즌 리그 풀에서만
          계산되므로 시즌을 바꿔 끼우면 값과 순위의 기준이 서로 어긋난 칸이 생긴다. */}
      {glanceSeasonMismatch && (
        <p className={styles.glanceSeasonNote}>
          <span className={styles.glanceSeasonNoteChip}>{statSeasonChip(focus)}</span>
          위 한눈 카드의 기준 시즌입니다. 선택한 {shortSeason(glanceSeasonMismatch)} 시즌은 아래 패널부터 적용됩니다 - 카드의 리그
          퍼센타일이 기준 시즌 풀에서만 계산되는 값이라, 카드는 선택 시즌으로 다시 집계하지 않습니다.
        </p>
      )}

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
          {/* GET 폼은 제출 시 쿼리를 통째로 갈아끼운다 - 창(?w=)과 폼 단위(?rate=)를 숨은 필드로
              같이 실어야 시즌을 바꿔도 두 토글 상태가 살아남는다. 값은 검증을 통과한 것만. */}
          {w && <input type="hidden" name="w" value={String(windowN)} />}
          {rate && <input type="hidden" name="rate" value={formUnit} />}
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

      {/* ── 4-B. 결정적 순간 득점(커리어) - 요청: "클러치가 아니더라도, 승률 올랐던 내용들에
             대해서 표시". 위 패널은 마지막 5분·5점차 안만 보므로 그 바깥을 여기서 채운다.
             이름을 "승률 기여"라 하지 않는 이유는 components/WinImpact.tsx 상단 주석 참고. ── */}
      {winImpact && (
        <div className={styles.panel}>
          <div className={styles.panelTitle}>결정적 순간 득점 · 커리어</div>
          <WinImpactPanel
            impact={winImpact}
            teamNameByTcode={new Map([...teamByTcode].map(([tc, t]) => [tc, t.name]))}
          />
        </div>
      )}

      {/* ── 5. 시너지 & 임팩트 ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>시너지 & 임팩트</div>
        <div className={styles.miniStatGrid}>
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
        <div className={styles.pctNote}>온/오프는 15시즌 통산 · 아래 조합표도 같은 15시즌 통산 범위입니다</div>
        {/* 조합표는 표본·임계값·±·정렬 근거를 자기 캡션으로 달고 나온다 - components/SynergyCombos.tsx */}
        <SynergyCombos data={combos} playerName={info.name} />
      </div>

      {/* ── 6. 커리어 아크(시즌별 PPG 곡선)는 히어로 발치의 커리어 결 띠로 대체됨 ── */}

      {/* 창 토글 하나가 세 가지를 함께 몬다: 커리어 띠 확대판의 크롭 · 그 아래 경기당 평균 ·
          다중 시즌 폼 패널의 '최근 N경기' 행(75포제션당). 창의 단위는 '밤'이 아니라 '출전'이라
          세 곳이 정확히 같은 N경기를 가리킨다. */}
      {recentGames.length > 0 && (
        <div className={styles.windowRow}>
          {WINDOWS.map((wn) => (
            <Link
              key={wn}
              href={windowHref(wn)}
              className={`${styles.wtoggle} ${windowN === wn ? styles.wtoggleActive : ""}`}
            >
              L{wn}
            </Link>
          ))}
        </div>
      )}

      {/* ── 최근 구간: 히어로 발치 띠를 그대로 확대(다른 차트가 아니라 같은 문법의 줌)
             + 같은 창의 경기당 평균 ─────────────────────────────────────────────────
          옛 '최근 N경기 평균' 패널을 여기로 접었다. 창 토글 하나가 모는 두 그림(띠 확대 ·
          경기당 평균)이 패널 둘로 갈려 있을 이유가 없고, 같은 창의 '비율' 읽기는 바로 아래
          다중 시즌 폼 패널의 '최근 N경기' 행이 이어받는다(75포제션당). FG%/3P%/FT%는 폼 패널이
          TS%·eFG%로 대체하지 않고 여기 그대로 남는다 - 원자료를 지우지 않기 위해서. */}
      <div className={styles.panel}>
        {/* 제목의 숫자는 "요청한 창"이 아니라 "실제로 그린 출전 수"다 - 커리어가 창보다 짧은
            선수(1경기 커리어)에게 '최근 15경기'라고 쓰면 없는 표본을 주장하게 된다. */}
        <div className={styles.panelTitle}>최근 {Math.min(windowN, grain.playedCount)}경기 결 · 커리어 띠 확대</div>
        {zoomStrip ? (
          <>
            <svg
              className={styles.stripZoomSvg}
              viewBox={zoomStrip.viewBox}
              preserveAspectRatio="xMinYMid meet"
              dangerouslySetInnerHTML={{ __html: zoomStrip.svg }}
            />
            <div className={styles.stripCaption}>{zoomStrip.caption}</div>
            <div className={styles.pctNote}>
              {zoomStrip.note}
              {zoomStrip.mode === "cell" ? " · 칸 클릭 → 그 경기" : ""}
            </div>
          </>
        ) : (
          <div className="empty-note">경기 기록 없음</div>
        )}
      </div>

      {/* ── 최근 N경기 기록(components/RecentWindow.tsx) ────────────────────────────
          옛 타일 10개를 대체한다(요청: "최근 5,10,15,30경기가 보기가 좀 어려운데, 가시성 좋게,
          디자인 좋게 변경"). 타일이 감춘 세 가지를 이 패널이 드러낸다:
          (1) 분포 - 워니 L15는 평균 21.5점이지만 실제 6~38점이다(실측 2026-09-04). 행마다
              경기별 점 스트립이 붙고 평균은 그 위의 눈금 하나로 내려간다.
          (2) 창의 정체 - 실제 경기 수·날짜 범위·시즌·정규/PO 구성·결장 수를 헤더가 인쇄한다
              (현 시점 코호트의 57.7%가 정규+PO 혼재, 30.6%가 결장 포함).
          (3) 출전 시간 - 창 차이의 73%가 출전 시간 변화다(corr(ΔMIN,ΔPTS)=0.856). MIN이 첫 행이고
              ?rw=per36 링크가 그 둘을 가른다.
          창 토글(L5/L10/L15/L30)은 위에서 페이지가 이미 그리므로 이 컴포넌트는 다시 그리지 않는다. */}
      <RecentWindow
        careerRows={careerRows}
        windowN={windowN}
        rate={recentRate}
        query={{ w: w ? String(windowN) : undefined, season: seasonQuery, rate: rate ? formUnit : undefined }}
        teamAbbrs={teamAbbrs}
        id="recent"
      />

      {/* ── 다중 시즌 폼(75포제션당 / 40분당) ─────────────────────────────────────────
          요청("선수들 폼을, 최근 5경기가 아닌, 많은 시즌을 비교, 그리고 그 이전 시즌을 비교하는
          느낌으로"). 위 패널이 '최근 창'을 경기당으로 읽는다면, 이 패널은 커리어 전 시즌을 비율로
          세워 직전 시즌 대비 변화를 명시한다 - 워니의 어시스트가 4.5→6.0으로 오르는 동안 리바운드가
          15.3→13.6으로 내려간 것처럼, 경기당 뷰의 어느 패널도 보여주지 못하는 사실이 여기서만 보인다.
          레퍼런스가 말한 'Per 75'는 75경기가 아니라 75포제션이다 - 라벨·캡션은 전부 컴포넌트가
          '75포제션당'으로 인쇄하고, 추정 포제션이라는 사실도 캡션이 직접 들고 있다.
          기준 칩(chip)은 넘기지 않는다 - 이 표는 한 시즌이 아니라 모든 시즌이라 단일 시즌 기준 칩을
          달면 거짓이 된다. 패널이 스스로 단위·시즌 수 칩을 만든다.
          ?season=은 검증을 통과한 값만 넘겨 단위 토글이 잘못된 시즌을 링크로 되살리지 않게 한다. */}
      <PlayerFormPanel
        form={form}
        unit={formUnit}
        query={{
          w: w ? String(windowN) : undefined,
          season: seasonQuery,
          rate: rate ? formUnit : undefined,
          [RECENT_RATE_PARAM]: rw ? recentRate : undefined,
        }}
        teamAbbrs={teamAbbrs}
        id="form"
      />

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
