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
import { getPlayerCombos, getPlayerSeasonCombos, failedCombos } from "@/lib/lineupCombos";
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
import { getCareerGrain, type CareerGrain, type CareerNight } from "@/lib/careerGrain";
import { buildCareerStripSvg, buildCareerStripRowsSvg, CELL_MAX_W, GAP_RESERVE } from "@/lib/careerStrip";
import { getPlayerForm, type PlayerForm } from "@/lib/playerForm";
import { getPlayerGlance, type PlayerGlance } from "@/lib/playerGlance";
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

// 세 파도 21개 조회가 콜드 캐시에서 겹치면(커리어 슛 전체 페이지네이션 + 팀 경기 페이지 +
// RPC 셋) Vercel 기본 서버리스 제한을 넘길 수 있다 - app/page.tsx·leaderboards와 같은 안전장치.
export const maxDuration = 60;

// 선택적 패널 전용 soft 폴백(감사 지적: 세 파도 21개 조회가 하나의 실패 도메인이라 클러치 RPC
// 하나가 타임아웃 나도 선수 페이지 전체가 error.tsx가 됐다). 여기서만 삼키되 조용히 삼키지는
// 않는다 - 반드시 console.error로 남긴다. 본체는 이 헬퍼로 감싸지 않는다: 선수 존재(getPlayerInfo
// → notFound), 커리어 경기·최근 경기·팀 목록·명단 상태(히어로 정체성)는 그대로 throw → app/error.tsx.
// NoInfer: T는 조회 함수의 반환 타입에서만 정해진다(`new Map()`이 T를 any로 넓히지 않게).
function soft<T>(label: string, p: Promise<T>, fallback: NoInfer<T>): Promise<T> {
  return p.catch((e: unknown) => {
    console.error("[player]", label, e);
    return fallback;
  });
}

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
        {/* 눈금 머리줄 - 막대 칸과 같은 격자라 0/25/50/75/100이 막대 위 정확한 자리에 선다.
            "79"가 무엇 대비 79인지(리그 중앙값 50에서 얼마나 떨어졌나)를 숫자 없이도 읽게. */}
        <div className={`${styles.pctRow} ${styles.pctScaleRow}`} aria-hidden="true">
          <div />
          <div className={styles.pctScale}>
            {[0, 25, 50, 75, 100].map((t) => (
              <span key={t} className={t === 50 ? styles.pctScaleMid : t === 25 || t === 75 ? styles.pctScaleQuart : undefined} style={{ left: `${t}%` }}>
                {t === 50 ? "50 리그 중앙" : t}
              </span>
            ))}
          </div>
          <div className={styles.pctScaleHead}>기록</div>
          <div className={styles.pctScaleHead}>백분위</div>
        </div>
        {profile.axes.map((a) => (
          <div className={styles.pctRow} key={a.key}>
            <div className={styles.pctLabel}>{a.label}</div>
            <div className={styles.pctTrack}>
              <div className={styles.pctFill} style={{ width: `${a.percentile}%`, background: percentileColor(a.percentile) }} />
              <div className={styles.pctQuart} style={{ left: "25%" }} />
              <div className={styles.pctQuart} style={{ left: "75%" }} />
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

  // 요청: "그래프 글자가 너무 크다 - 주변과 어울리게". 예전엔 640단위 뷰박스를 지면 폭(최대
  // ~1100px)으로 늘려 12단위 라벨이 데스크톱에서 20px대 모노로 커졌다. 밴드(면)만 늘어나는 SVG로
  // 두고, 존 라벨·시즌 눈금·축 라벨은 실제 px인 HTML로 올린다(본문 서체 Pretendard, 라벨 단).
  // 좌표는 0~1 비율로 계산해 CSS 퍼센트 위치에 그대로 쓴다.
  const n = mix.length;
  const xFrac = (i: number) => i / (n - 1);
  // 누적 상단선 - rim부터 아래에서 위로. SVG는 0~100 뷰박스(preserveAspectRatio="none").
  const cumAt = (i: number, uptoZoneIdx: number) => DNA_ZONES.slice(0, uptoZoneIdx + 1).reduce((s, z) => s + mix[i].shares[z], 0);
  const bandPath = (zoneIdx: number) => {
    const top = mix.map((_, i) => `${(xFrac(i) * 100).toFixed(2)},${((1 - cumAt(i, zoneIdx)) * 100).toFixed(2)}`);
    const bottom = mix
      .map((_, i) => `${(xFrac(i) * 100).toFixed(2)},${((1 - (zoneIdx === 0 ? 0 : cumAt(i, zoneIdx - 1))) * 100).toFixed(2)}`)
      .reverse();
    return `M ${top.join(" L ")} L ${bottom.join(" L ")} Z`;
  };

  // 시즌 눈금. 플롯 폭은 데스크톱에서 최소 ~440px(이 레이아웃은 641px 이상에서만 보인다)이라
  // "21-22" 한 개(~40px)가 차지하는 비율은 최대 0.095 - 그보다 가까우면 앞 라벨을 솎아낸다
  // (마지막 시즌 라벨은 언제나 남는다).
  const tickEvery = Math.max(1, Math.ceil(n / 8));
  const TICK_GAP = 0.095;
  const tickIdx: number[] = [];
  for (let i = 0; i < n; i++) if (i % tickEvery === 0) tickIdx.push(i);
  if (tickIdx[tickIdx.length - 1] !== n - 1) tickIdx.push(n - 1);
  for (let i = tickIdx.length - 1; i > 0; i--) {
    if (xFrac(tickIdx[i]) - xFrac(tickIdx[i - 1]) < TICK_GAP) tickIdx.splice(i - 1, 1);
  }

  // 오른쪽 라벨 - 마지막 시즌 기준 밴드의 세로 중앙(0=위, 1=아래). 3% 미만 밴드는 생략.
  // 플롯 높이 238px에서 라벨 한 줄(~17px)이 0.072 - 그보다 붙으면 아래로 밀고, 넘치면 바닥에서 위로 되민다.
  const last = n - 1;
  const LABEL_GAP = 0.075;
  const labels = DNA_ZONES.map((z, zi) => {
    const top = cumAt(last, zi);
    const bottom = zi === 0 ? 0 : cumAt(last, zi - 1);
    return { z, share: mix[last].shares[z], y: 1 - (top + bottom) / 2 };
  })
    .filter((l) => l.share >= 0.03)
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y - labels[i - 1].y < LABEL_GAP) labels[i].y = labels[i - 1].y + LABEL_GAP;
  }
  for (let i = labels.length - 1; i >= 0; i--) {
    const maxY = i === labels.length - 1 ? 0.96 : labels[i + 1].y - LABEL_GAP;
    if (labels[i].y > maxY) labels[i].y = maxY;
  }

  // "DNA"라고 이름 붙였으면 변화가 읽혀야 한다(제보). 밴드는 모양으로만 말하니 숫자로 두 번 더 말한다:
  // (1) 첫 시즌 → 최근 시즌 존별 비율(양쪽 레이아웃 공통 캡션, 5pp 이상은 굵게)
  // (2) 모바일 행마다 전 시즌 대비 가장 크게 움직인 존(3pp 미만은 안 적는다 - 시즌당 슛 30개 컷에서
  //     1~2pp는 슛 한두 개 차이라 방향을 말할 수 없다)
  const pp = (v: number) => Math.round(v * 100);
  const first = mix[0];
  const latest = mix[n - 1];
  const biggestShift = (i: number): { zone: (typeof DNA_ZONES)[number]; pp: number } | null => {
    if (i === 0) return null;
    let best: { zone: (typeof DNA_ZONES)[number]; pp: number } | null = null;
    for (const z of DNA_ZONES) {
      const d = pp(mix[i].shares[z]) - pp(mix[i - 1].shares[z]);
      if (!best || Math.abs(d) > Math.abs(best.pp)) best = { zone: z, pp: d };
    }
    return best && Math.abs(best.pp) >= 3 ? best : null;
  };
  return (
    <div>
      <div className={styles.dnaWide}>
      <div className={styles.dnaChart}>
        <div className={styles.dnaAxis} aria-hidden="true">
          <span style={{ top: 0 }}>100%</span>
          <span style={{ bottom: 0 }}>0%</span>
        </div>
        <div className={styles.dnaPlot}>
          <svg className={styles.dnaSvg} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {/* 밴드 사이에 패널색 실선을 얇게 둘러 인접 밴드가 서로 번지지 않게. */}
            {DNA_ZONES.map((z, zi) => (
              <path key={z} d={bandPath(zi)} fill={DNA_COLORS[z]} opacity={0.9} stroke="var(--surface)" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
            ))}
            {[25, 50, 75].map((g) => (
              <line key={g} x1={0} y1={g} x2={100} y2={g} stroke="var(--surface)" strokeWidth={0.6} opacity={0.5} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
        </div>
        <div className={styles.dnaLabels}>
          {labels.map((l) => (
            <span key={l.z} style={{ top: `${l.y * 100}%`, color: DNA_COLORS[l.z] }}>
              {DNA_ZONE_LABELS[l.z]} {Math.round(l.share * 100)}%
            </span>
          ))}
        </div>
        <div className={styles.dnaTicks} aria-hidden="true">
          {tickIdx.map((i) => (
            <span key={mix[i].season} style={{ left: `${xFrac(i) * 100}%` }} className={i === n - 1 ? styles.dnaTickEnd : i === 0 ? styles.dnaTickStart : undefined}>
              {shortSeason(mix[i].season)}
            </span>
          ))}
        </div>
      </div>
      <div className={styles.pctNote}>오른쪽 라벨 = {shortSeason(latest.season)} 비율</div>
      </div>
      {/* 모바일: 시즌 행 × 존 열. 640단위 뷰박스를 303px로 줄이면 밴드 라벨이 4px가 되어 안 읽힌다(제보).
          행은 위가 오래된 시즌 - 데스크톱 밴드의 왼→오와 같은 시간 방향이라 변화를 같은 순서로 읽는다. */}
      <div className={styles.dnaTall}>
        {mix.map((m, i) => {
          const shift = biggestShift(i);
          return (
            <div className={styles.dnaTallRow} key={m.season}>
              <div className={styles.dnaTallSeason}>{shortSeason(m.season)}</div>
              <div className={styles.dnaTallBar} title={`${m.season} 슛 ${m.total.toLocaleString()}개`}>
                {DNA_ZONES.map((z) =>
                  m.shares[z] > 0 ? (
                    <div key={z} className={styles.dnaTallSeg} style={{ width: `${m.shares[z] * 100}%`, background: DNA_COLORS[z] }}>
                      {m.shares[z] >= 0.12 ? pp(m.shares[z]) : ""}
                    </div>
                  ) : null
                )}
              </div>
              <div className={styles.dnaTallDelta} style={shift ? { color: DNA_COLORS[shift.zone] } : undefined}>
                {shift ? `${DNA_ZONE_LABELS[shift.zone]} ${shift.pp > 0 ? "▲" : "▼"}${Math.abs(shift.pp)}` : i === 0 ? "" : "·"}
              </div>
            </div>
          );
        })}
        <div className={styles.pctNote}>
          행 = 시즌(위가 오래된 시즌) · 칸 안 숫자 = 비율(%) · 오른쪽 = 전 시즌 대비 가장 크게 움직인 존(퍼센트포인트, 3 미만은 · )
        </div>
      </div>
      <div className={styles.dnaLegend}>
        {DNA_ZONES.map((z) => (
          <span key={z}>
            <span className={styles.sw} style={{ background: DNA_COLORS[z] }} />
            {DNA_ZONE_LABELS[z]}
          </span>
        ))}
      </div>
      <div className={styles.dnaCaption}>
        {shortSeason(first.season)} → {shortSeason(latest.season)} 변화:{" "}
        {DNA_ZONES.map((z, i) => {
          const a = pp(first.shares[z]);
          const b = pp(latest.shares[z]);
          const big = Math.abs(b - a) >= 5;
          return (
            <span key={z}>
              {i ? " · " : ""}
              {DNA_ZONE_LABELS[z]} {big ? <b>{a}→{b}%</b> : `${a}→${b}%`}
            </span>
          );
        })}
        {" "}· 굵게 = 5pp 이상 · 시즌당 슛 30개 이상인 {n}시즌 기준
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
  // 앞 셋(커리어 경기·최근 경기·팀)은 본체 - 실패하면 throw. 나머지는 선택적 패널이라 soft().
  const [careerRows, recentGames, teamByTcode, careerShots, clutch, combos, onOffMap, zoneExpectedPts, winImpact] =
    await Promise.all([
      getPlayerCareerGames(pcode),
      getPlayerRecentGames(pcode),
      getAllTeams(),
      // 히어로 밀도 지도·슈팅 DNA·슛 임팩트용. 빈 배열이면 세 빌더 모두 "슛 없음" 경로로 간다.
      soft("careerShots", getCareerShots(pcode), []),
      soft("clutchProfile", getClutchProfile(pcode), null),
      // 2인만 보던 시너지 카드를 2·3·4·5인 조합표로 교체(요청: "3인/4인/5인 조합도").
      // 크기별 임계값·정렬 근거는 lib/lineupCombos.ts 주석에 실측과 함께 있다.
      // 실패 센티널(failed: true)은 여기서 만든다 - compute 안에서 돌려주면 cachedFn이 6시간
      // 캐시해 버린다(lib/lineupCombos.ts PlayerCombos.failed 주석). 컴포넌트가 "조합 없음"과
      // 다른 문장("불러오지 못했습니다")으로 그린다.
      soft("playerCombos", getPlayerCombos(pcode), failedCombos()),
      soft("onOffRatings", getPlayerOnOffRatings([pcode]), new Map()),
      // 빈 Map이면 buildImpactDots가 기대값 0으로 잔차를 계산한다 - 점은 찍히되 색 판정만 평평해진다.
      soft("zoneExpectedPts", getZoneExpectedPts(), new Map()),
      // 미리 구운 1행(tools/build_player_win_impact.py) - 실시간 집계는 콜드 1.1~2.1초라 못 얹는다.
      soft("winImpact", getWinImpact(pcode), null),
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
  // 명단 상태는 본체(팀·등번호·포지션·시즌 목록 = 히어로 정체성과 focus의 입력) - throw.
  // 결 띠와 폼은 패널이라 soft(null). null이면 아래에서 그 패널만 "불러오지 못함"으로 그리고,
  // 한눈 카드에는 undefined로 넘겨 카드가 스스로 재조회하게 둔다(그것도 실패하면 카드가 soft).
  const [status, grain, form] = await Promise.all([
    getPlayerRosterStatus(pcode, careerRows),
    soft<CareerGrain | null>("careerGrain", getCareerGrain(pcode, careerRows), null),
    soft<PlayerForm | null>("playerForm", getPlayerForm(pcode, { careerRows, recentN: windowN }), null),
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
  // soft()는 정의 시점에 건다 - 아래 Promise.all 안에서만 걸면 glancePercentileP가 같은 프로미스를
  // 공유하므로 퍼센타일 RPC 하나의 실패가 한눈 카드까지 함께 거부시킨다.
  const percentileP = soft(
    "percentileProfile",
    shotSeason ? getPercentileProfile(pcode, shotSeason) : Promise.resolve(null),
    null
  );
  const glancePercentileP: Promise<PercentileProfile | null | undefined> =
    shotSeason === focus.statSeason ? percentileP : Promise.resolve(undefined);
  // Promise.all 배열 순서 == 구조분해 순서: boxTotals, percentile, wpaRank, wpaBySeason,
  // seasonCombos(방금 추가), glance(제일 마지막 - glancePercentileP.then(...)).
  // 이 파도는 전부 선택적 패널이라 하나씩 soft() - null/빈 Map/failedCombos()는 각 패널이 이미
  // "없음"과 구분해서 그리는 값이다(글랜스만 카드 자리에 "불러오지 못함"을 따로 세운다).
  const [boxTotals, percentile, wpaRank, wpaBySeason, seasonCombos, glance] = await Promise.all([
    soft("seasonBoxTotals", shotSeason ? getPlayerSeasonBoxTotals(pcode, shotSeason) : Promise.resolve(null), null),
    percentileP,
    soft("seasonWpaRank", shotSeason ? getSeasonWpaRank(pcode, shotSeason) : Promise.resolve(null), null),
    soft("wpaBySeason", getPlayerWpaBySeason(pcode, seasonNames), new Map()),
    // 요청: "최고의 조합에서, 커리어 통산과 함께 시즌별 최고의 조합도 제공". lineup_combo에는
    // 시즌 컬럼이 없어(파일 상단 주석) 이 조회만 lineup_stints에서 즉석 계산한다 - 다른 패널과
    // 같은 shotSeason을 쓰므로 ?season=을 바꾸면 조합표도 같이 따라간다.
    // 실패 센티널은 커리어 조합과 같은 이유로 여기서 만든다(compute 안에서 돌려주면 1시간 캐시).
    soft("seasonCombos", shotSeason ? getPlayerSeasonCombos(pcode, shotSeason) : Promise.resolve(null), failedCombos()),
    // 한눈 카드: 페이지가 이미 가진 것(커리어 경기·폼·커리어 슛·클러치·커리어 결)을 전부 주입해
    // 재조회를 없앤다. 남는 조회는 온/오프 + 시즌 WPA + 분 가중 고급지표 세 갈래뿐이고, 그것도
    // 이 파도의 나머지와 동시에 돈다(직렬 waterfall 추가 없음).
    // form/grain이 soft로 null이 됐으면 undefined로 넘긴다 - 옵션 계약이 "주면 재조회 안 함"이라
    // null을 그대로 넘기면 카드가 그걸 값으로 받는다.
    soft<PlayerGlance | null>(
      "playerGlance",
      glancePercentileP.then((p) =>
        getPlayerGlance(pcode, focus.statSeason, {
          careerRows,
          form: form ?? undefined,
          careerShots,
          percentile: p,
          clutch,
          grain: grain ?? undefined,
        })
      ),
      null
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
  // 히어로 발치 밴드: 폭 800 · 높이 72(= 라벨 줄 13 + 막대 47 + 레일 12)를 요청하면 빌더가
  // 구간별 글자에 맞춰 라벨 줄과 최종 뷰박스 높이를 잡는다(막대 47은 그대로 남는다).
  // fit은 이 SVG가 화면에서 그려지는 방식이다 - CSS 높이 --strip-h(79px)·가로 크롬 92px
  // (.wrap 18+18 + .heroFoot 28+28)·≤620px에서는 행으로 바뀌므로 보이는 최소 뷰포트 621px.
  // 이 세 숫자는 player-profile.module.css의 --strip-h/.heroFoot과 짝이다 - 한쪽만 바꾸면
  // 글자가 조용히 12px 아래로 내려간다.
  // 밤이 0개면 빌더가 null을 돌려주고 밴드 자체를 안 그린다
  // (커리어 기록이 없는 선수 - 26-27 명단 중 pcode가 없는 15명이 여기에 해당).
  // grain이 null(soft 폴백)이면 히어로 발치 밴드를 그리지 않는다 - "밤이 0개"와는 다른 상태지만
  // 히어로에는 빈 밴드 대신 아무것도 안 그리는 게 맞고, 사실은 아래 확대판 패널이 문장으로 밝힌다.
  const heroStrip = grain
    ? buildCareerStripSvg(grain, {
        uid: `hero${pcode}`,
        teamColors,
        teamAbbrs,
        width: 800,
        height: 72,
        tone: "hero",
        fit: { cssHeight: 79, chrome: 92, minVp: 621 },
      })
    : null;
  // 모바일(≤620px)용 시즌별 행. 실측: 26-27 명단 198명의 커리어 총 경기 p50 122·max 739라 한 줄 띠를
  // 303px에 넣으면 칸이 2.5px·0.4px다 - 키워서 될 일이 아니라 시즌별로 접는다(최장 시즌 64경기도 칸
  // ≥4.7px). 한 줄 띠와 행 둘 다 그려 보내고 CSS가 폭으로 하나만 보인다(.heroFootSvg / .heroFootRows).
  // 행은 시즌 히트존 모드(칸당 ~26B)라 둘 다 보내는 비용은 작다.
  // 행의 fit: 행 높이는 .heroFootRow가 56px로 고정하고, ≤620px에서만 보이며(그 위는 한 줄 띠),
  // 그 폭에서 .heroFoot 패딩이 18+18이라 가로 크롬은 72px(.wrap 36 + 36)다.
  const heroRows = grain
    ? buildCareerStripRowsSvg(grain, {
        uid: `herorow${pcode}`,
        teamColors,
        teamAbbrs,
        tone: "hero",
        fit: { cssHeight: 56, chrome: 72, maxVp: 620 },
      })
    : null;
  // §9 확대판: 마지막 windowN "출전"까지 거슬러 올라간 구간. 뷰박스 폭을 칸 수에 딱 맞춰 요청해
  // (칸 상한 9 × 칸 수 + 좌우 여백) 오른쪽에 빈 공간이 남지 않게 한다. 커리어 끝에 공백 시즌
  // 표식이 붙는 선수(배스)는 빌더가 오른쪽에 GAP_RESERVE만큼 예약하므로 그만큼 더 요청한다
  // (숫자를 여기 베껴 두면 빌더 쪽이 바뀔 때 딱 맞는 폭이 조용히 어긋난다 - 그래서 상수를 가져온다).
  const zoomCells = grain?.nights.length ? nightsForRecentAppearances(grain.nights, windowN) : 0;
  const lastNightYear = grain?.nights.length ? Number(grain.nights[grain.nights.length - 1].seasonName.slice(0, 4)) : 0;
  const zoomGapReserve = grain?.gapSeasons.some((s) => Number(s.slice(0, 4)) > lastNightYear) ? GAP_RESERVE : 0;
  const zoomStrip = grain && zoomCells
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
        // 제보 "L15·L30 가시성": 칸 위에 그날 득점을 적는다(칸 8단위 이상·40칸 이하일 때만 - 빌더가 판단).
        // 이 패널은 CSS 높이가 뷰박스 높이보다 커서 배율이 1을 넘지만(168/92 = 1.83) 그게 곧 상한이다 -
        // 폭이 아무리 넓어도 6.5단위 값 라벨은 11.87px에서 멈췄다. 그래서 크기 상수를 곱하는 대신
        // fit을 넘겨 구간마다 정확한 font-size를 빌더가 계산하게 한다.
        // cssHeight는 보이는 구간의 **최솟값**(데스크톱 168 / ≤620px 176 중 168) - 작게 잡으면
        // 실제 글자가 계산보다 커지는 쪽으로만 틀린다. 크롬 74 = .wrap 36 + .panel 36 + 테두리 2.
        fit: { cssHeight: 168, chrome: 74 },
        valueLabels: true,
      })
    : null;

  const clutchFgm = clutch ? clutch.totals.fg2m + clutch.totals.fg3m : 0;
  const clutchFga = clutch ? clutch.totals.fg2a + clutch.totals.fg3a : 0;

  return (
    <div className={`wrap ${styles.pageRoot}`} style={{ "--team": teamColor } as CSSProperties}>
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
            {/* 모바일: 시즌별 행(최신 시즌이 위 - 스크롤 없이 지금 시즌이 먼저). 행 높이는 CSS가 고정하고
                xMinYMid meet이라 모든 행이 같은 배율로 그려진다(짧은 시즌은 짧게). */}
            {heroRows && (
              <div className={styles.heroFootRows}>
                {[...heroRows.rows].reverse().map((r) => (
                  <svg
                    key={r.seasonName}
                    className={styles.heroFootRow}
                    viewBox={r.result.viewBox}
                    preserveAspectRatio="xMinYMid meet"
                    dangerouslySetInnerHTML={{ __html: r.result.svg }}
                  />
                ))}
                <div className={styles.heroFootNote}>{heroRows.note} · 최신 시즌이 위</div>
              </div>
            )}
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
      {/* glance가 null이면 soft 폴백(위 console.error) - "기록 없음"이 아니라 "불러오지 못함"으로 적는다.
          카드 자리를 비워 두지 않는 이유: 첫 화면이 조용히 짧아지면 사용자는 "원래 카드가 없는 선수"로 읽는다. */}
      {glance ? (
        <PlayerGlanceCard glance={glance} focus={focus} teams={teamByTcode} />
      ) : (
        <div className={styles.panel}>
          <div className={styles.panelTitle}>한눈에 보기</div>
          <div className="empty-note">한눈 카드를 불러오지 못했습니다. 아래 패널은 그대로 볼 수 있고, 잠시 후 새로고침하면 카드도 열립니다.</div>
        </div>
      )}

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
        <div className={styles.pctNote}>온/오프는 15시즌 통산 범위입니다 · 아래 조합표는 시즌·커리어 통산 두 범위를 같이 보여줍니다</div>
        {/* 조합표는 표본·임계값·±·정렬 근거를 자기 캡션으로 달고 나온다 - components/SynergyCombos.tsx */}
        <SynergyCombos
          data={combos}
          seasonData={shotSeason ? seasonCombos : undefined}
          seasonLabel={shotSeason ? (statChip ?? `${shortSeason(shotSeason)} 시즌`) : undefined}
          playerName={info.name}
        />
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
        {/* grain이 없으면(soft 폴백) 출전 수를 모르므로 커리어 행 수로 상한을 잡는다 - 같은 "실제 표본" 규칙. */}
        <div className={styles.panelTitle}>최근 {Math.min(windowN, grain ? grain.playedCount : careerGp)}경기 결 · 커리어 띠 확대</div>
        {!grain ? (
          // 조회 실패를 "경기 기록 없음"으로 적으면 거짓이 된다(이 저장소 규칙) - 실패는 실패라고 쓴다.
          <div className="empty-note">커리어 띠를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>
        ) : zoomStrip ? (
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
      {form ? (
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
      ) : (
        // soft 폴백 - 패널 자체는 남겨 "원래 없는 표"가 아니라 "지금 못 불러온 표"로 읽히게 한다.
        <div className={styles.panel} id="form">
          <div className={styles.panelTitle}>시즌별 폼</div>
          <div className="empty-note">시즌별 폼을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>
        </div>
      )}

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
        2011-12~2025-26 시즌 전체 경기 기준 · 게임로그는 최근 30경기까지만 보관 · 실시간 조회
      </footer>
    </div>
  );
}
