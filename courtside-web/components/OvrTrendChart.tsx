"use client";

import React, { useState } from "react";
import styles from "./OvrTrendChart.module.css";
import { OvrSeasonRecord } from "../lib/ovr";

export interface TeamMeta {
  abbr: string;
  color: string;
  logoUrl: string | null;
}

interface OvrTrendChartProps {
  history: OvrSeasonRecord[];
  teamColor?: string;
  /** 시즌별 소속팀(record.team, kbl540 team_name_current 표기) -> 팀 컬러/약어. 이적한
   * 선수의 구간별 팀 색·전환 칩을 그리는 데 쓴다. 없으면 팀 구분 없이 teamColor 하나로만
   * 그림. Map이 아니라 평범한 객체 - 서버->클라이언트 컴포넌트 경계를 넘는 props는 Map
   * 직렬화가 실측상 조용히 깨졌다(자세한 이유는 호출부 주석). */
  teamByName?: Record<string, TeamMeta>;
}

// 오버롤 등급별 배지 색 - 요청("오버롤 별로 색상을 다르게 표시해서 좀더 위압감을 주도록")에
// 따라 배지의 주 색상 채널은 이제 팀이 아니라 "이 시즌이 얼마나 강했는가"다(2K 레이팅 카드의
// 브론즈/실버/골드/다이아 색띠와 같은 발상). 팀 구분은 선/점/전환 칩으로 옮겼다(아래).
const OVR_TIERS: { min: number; color: string }[] = [
  { min: 90, color: "#ffb020" }, // 레전드
  { min: 85, color: "#c34cf0" }, // 엘리트
  { min: 80, color: "#3d8bff" }, // 우수
  { min: 75, color: "#22c98a" }, // 준수
  { min: 70, color: "#8fae4a" }, // 평균
  { min: 0, color: "#7a7f8a" }, // 그 이하
];
function tierColor(ovr: number): string {
  return (OVR_TIERS.find((t) => ovr >= t.min) ?? OVR_TIERS[OVR_TIERS.length - 1]).color;
}

export default function OvrTrendChart({ history, teamColor = "#542582", teamByName }: OvrTrendChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!history || history.length === 0) {
    return <div className={styles.empty}>OVR 트렌드 데이터가 없습니다.</div>;
  }

  const colorForTeam = (teamName?: string) => (teamName && teamByName?.[teamName]?.color) || teamColor;
  const abbrForTeam = (teamName?: string) => (teamName && teamByName?.[teamName]?.abbr) || null;

  // 차트 스케일링 설정
  const WIDTH = 1000;
  const HEIGHT = 460;
  const PADDING_TOP = 90;
  const PADDING_BOTTOM = 60;
  const PADDING_X = 90;

  // 고정 40-99 범위(리그 전체 스케일)는 한 선수의 실제 등락(보통 한 자리~10대 초반)을
  // 59점짜리 축에 욱여넣어 선이 거의 평평해 보였다. 그 선수의 실제 최저~최고를 기준으로
  // 축을 맞춰서(+여유), 변동이 작을수록 더 확대해서 보여준다.
  const values = history.map((r) => r.OVR);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max(4, (rawMax - rawMin) * 0.25);
  let MIN_OVR = Math.max(30, Math.floor((rawMin - pad) / 5) * 5);
  let MAX_OVR = Math.min(99, Math.ceil((rawMax + pad) / 5) * 5);
  // 변동이 거의 없는 선수까지 확대하면 축이 5점짜리가 되어 사소한 잡음을 큰 등락처럼
  // 과장한다 - 최소 폭 15점은 유지.
  if (MAX_OVR - MIN_OVR < 15) {
    const mid = (MAX_OVR + MIN_OVR) / 2;
    MIN_OVR = Math.max(30, Math.round(mid - 7.5));
    MAX_OVR = Math.min(99, MIN_OVR + 15);
  }

  const yRange = MAX_OVR - MIN_OVR;
  const gridVals = Array.from(new Set([MIN_OVR, Math.round(MIN_OVR + yRange / 3), Math.round(MIN_OVR + (yRange * 2) / 3), MAX_OVR]));
  const innerHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const innerWidth = WIDTH - PADDING_X * 2;

  // 커리어가 길수록(시즌 수가 많을수록) 점 사이 간격이 좁아진다 - 배지/글자 크기를 그
  // 간격에 맞춰 줄여서 겹치지 않게 한다. 예전 공식(spacing/2 - 4)은 15시즌 넘는 롱런
  // 선수에서 인접 배지 지름이 간격의 85%를 차지해 서로 겹쳤다(제보: "오버롤이 화면을
  // 가리는 문제") - 여유를 훨씬 더 준다.
  const spacing = history.length > 1 ? innerWidth / (history.length - 1) : innerWidth;
  const badgeR = Math.max(13, Math.min(26, spacing / 2 - 10));
  const badgeFont = Math.max(13, Math.round(badgeR * 0.8));
  const xLabelFont = Math.max(13, Math.min(26, spacing / 3.4));
  // 시즌 10개 이상이면 인접 배지를 위아래로 지그재그 배치한다 - 가로 간격이 좁아도
  // OVR 값이 비슷한 이웃끼리 세로로도 겹치지 않게(지그재그는 촘촘한 타임라인 차트의
  // 표준적인 라벨 겹침 방지 기법).
  const dense = history.length > 9;
  const staggerGap = dense ? badgeR * 1.5 : 0;

  // 좌표 계산 함수
  const getX = (index: number) => {
    if (history.length === 1) return WIDTH / 2;
    return PADDING_X + (index / (history.length - 1)) * innerWidth;
  };

  const getY = (val: number) => {
    const clamped = Math.max(MIN_OVR, Math.min(MAX_OVR, val));
    return PADDING_TOP + innerHeight - ((clamped - MIN_OVR) / yRange) * innerHeight;
  };

  // 예상/추정(다음 시즌 예상 + 군 복무·부상 등 공백 시즌 보간) 구간은 확정 구간과 선을
  // 분리해 점선으로 그린다. 공백 보간은 커리어 중간에도 낄 수 있어서 두 점 사이 구간마다
  // 따로 실선/점선을 정한다(둘 중 하나라도 projected면 그 구간은 점선).
  const anyProjected = history.some((r) => r.projected);
  // 이적 여부 - 팀 구분을 선 색으로 보여줄지 자체를 여기서 판단(전부 같은 팀이면 굳이
  // 세그먼트마다 색을 나눌 필요가 없다).
  const hasTeamChange = teamByName && history.some((r, i) => i > 0 && r.team && r.team !== history[i - 1].team);

  // Area Path (Fill) - 전체 구간(예상 포함) 채우기
  const areaPath = `
    M ${getX(0)},${HEIGHT - PADDING_BOTTOM}
    ${history.map((r, i) => `L ${getX(i)},${getY(r.OVR)}`).join(" ")}
    L ${getX(history.length - 1)},${HEIGHT - PADDING_BOTTOM}
    Z
  `;

  // 꺾은선: 구간마다 실선/점선 + (이적 있으면) 그 구간이 속한 팀 색. 팀 색은 구간의 "나중"
  // 시즌 기준(그 시즌으로 넘어가면서 그 팀이 됐다는 뜻).
  const lineSegments = [];
  for (let i = 0; i < history.length - 1; i++) {
    lineSegments.push({
      path: `M ${getX(i)},${getY(history[i].OVR)} L ${getX(i + 1)},${getY(history[i + 1].OVR)}`,
      dashed: !!(history[i].projected || history[i + 1].projected),
      color: hasTeamChange ? colorForTeam(history[i + 1].team) : teamColor,
    });
  }

  // 시즌 라벨 (ex: 2024-2025 -> 24/25)
  const formatSeason = (season: string) => {
    const parts = season.split("-");
    if (parts.length === 2) {
      return `${parts[0].slice(-2)}/${parts[1].slice(-2)}`;
    }
    return season;
  };

  return (
    <div className={styles.container} style={{ "--chart-color": teamColor } as React.CSSProperties}>
      <div className={styles.header}>
        <h3 className={styles.title}>SEASON OVR TREND</h3>
        <p className={styles.subtitle}>
          역대 시즌 오버롤(OVR) 변화 추이 · 배지 색=시즌 등급
          {hasTeamChange ? " · 선 색=소속팀" : ""}
          {anyProjected ? " · 점선=예상(다음 시즌 또는 공백 시즌 보간)" : ""}
        </p>
      </div>

      <div className={styles.chartWrapper}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className={styles.svgChart}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-color)" stopOpacity="0.8" />
              <stop offset="100%" stopColor="var(--chart-color)" stopOpacity="0.05" />
            </linearGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>

          {/* 배경 눈금선 (Grid) */}
          {gridVals.map((val) => (
            <g key={val}>
              <line
                x1={PADDING_X - 10}
                y1={getY(val)}
                x2={WIDTH - PADDING_X + 10}
                y2={getY(val)}
                className={styles.gridLine}
              />
              <text x={PADDING_X - 16} y={getY(val) + 8} className={styles.yAxisLabel}>
                {val}
              </text>
            </g>
          ))}

          {/* 영역형 차트 채우기 - 선수의 현재 팀 색 하나로(세그먼트별로 나누면 전환이 너무
              시끄러워 보여서, 팀 구분은 선/배지/칩에 맡기고 배경 워시는 통일감을 준다) */}
          <path d={areaPath} fill="url(#areaGradient)" className={styles.areaPath} />

          {/* 꺾은선: 구간마다 실선/점선 + 팀 색 */}
          {lineSegments.map((seg, i) => (
            <path
              key={i}
              d={seg.path}
              className={seg.dashed ? styles.linePathProjected : styles.linePath}
              style={{ stroke: seg.color }}
              filter={seg.dashed ? undefined : "url(#glow)"}
            />
          ))}

          {/* 데이터 포인트 + 항상 보이는 오버롤 숫자 배지 */}
          {history.map((record, i) => {
            const cx = getX(i);
            const cy = getY(record.OVR);
            const isHovered = hoverIdx === i;
            const isProjected = !!record.projected;
            const stagger = dense && i % 2 === 1 ? staggerGap : 0;
            const badgeCy = Math.max(cy - badgeR - 14 - stagger, badgeR + 4);
            const pointColor = hasTeamChange ? colorForTeam(record.team) : teamColor;
            const tColor = tierColor(record.OVR);
            const isTransition = hasTeamChange && (i === 0 || record.team !== history[i - 1].team);
            const abbr = isTransition ? abbrForTeam(record.team) : null;

            return (
              <g key={i} onMouseEnter={() => setHoverIdx(i)}>
                {/* 툴팁을 띄우기 위한 넓은 감지 영역 */}
                <rect
                  x={cx - spacing / 2}
                  y={0}
                  width={spacing}
                  height={HEIGHT}
                  fill="transparent"
                  style={{ cursor: "crosshair" }}
                />

                {/* X축 시즌 라벨 - 호버 시 확대 배율은 inline style로(CSS 클래스의 고정
                    font-size는 presentation attribute보다 우선순위가 높아, 시즌이 많아
                    글자를 줄인 차트에서도 호버한 라벨만 30px로 튀어 화면을 가렸다). */}
                <text
                  x={cx}
                  y={HEIGHT - 32}
                  style={{ fontSize: isHovered ? xLabelFont * 1.15 : xLabelFont }}
                  className={`${styles.xAxisLabel} ${isHovered ? styles.xAxisLabelActive : ""}`}
                >
                  {formatSeason(record.season)}{isProjected ? "*" : ""}
                </text>

                {/* 이적 전환 칩 - 이 시즌부터 바뀐 팀의 약어(요청: "팀 구분을 색상 또는
                    로고로" - 실제 로고 이미지를 SVG 안에 심는 대신, 이 사이트가 이미 쓰는
                    TeamBadge의 폴백 스타일(팀 컬러 원 + 약어)을 그대로 재사용한다 - 로고가
                    없는 팀도 있고, 매 시즌 로고를 다 박으면 오히려 더 시끄러워진다). */}
                {abbr && (
                  <g>
                    <circle cx={cx} cy={HEIGHT - 12} r={13} fill={pointColor} stroke="#0d0d0d" strokeWidth={1.5} />
                    <text x={cx} y={HEIGHT - 12} className={styles.teamChipText}>
                      {abbr}
                    </text>
                  </g>
                )}

                {/* 활성화된 세로 가이드라인 */}
                {isHovered && (
                  <line
                    x1={cx}
                    y1={PADDING_TOP}
                    x2={cx}
                    y2={HEIGHT - PADDING_BOTTOM}
                    className={styles.guideLine}
                  />
                )}

                {/* 점 (Dot) - 팀 색 */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={isHovered ? 6 : 4}
                  className={`${styles.dataPoint} ${isHovered ? styles.dataPointActive : ""} ${isProjected ? styles.dataPointProjected : ""}`}
                  style={{ stroke: isHovered ? undefined : pointColor }}
                />

                {/* 오버롤 숫자 배지 - 채움은 등급 색(위압감), 예상/보간 배지는 속을 비우고
                    등급 색 테두리만. */}
                <line
                  x1={cx} y1={cy} x2={cx} y2={badgeCy + badgeR}
                  className={styles.badgeStem}
                />
                <circle
                  cx={cx}
                  cy={badgeCy}
                  r={badgeR}
                  className={`${styles.ovrBadge} ${isProjected ? styles.ovrBadgeProjected : ""} ${isHovered ? styles.ovrBadgeActive : ""}`}
                  style={isProjected ? { stroke: tColor } : { fill: tColor }}
                />
                <text
                  x={cx}
                  y={badgeCy}
                  fontSize={badgeFont}
                  className={styles.ovrBadgeText}
                >
                  {record.OVR}
                </text>

                {/* 툴팁 SVG 구현 (Hover) */}
                {isHovered && (
                  <g className={styles.tooltipGroup}>
                    {/* 툴팁 위치 조정 (오른쪽 가장자리 짤림 방지) */}
                    <g transform={`translate(${cx > WIDTH - 220 ? cx - 200 : cx + 20}, ${Math.max(cy - 60, PADDING_TOP)})`}>
                      <rect width="190" height="120" rx="6" className={styles.tooltipBg} style={{ stroke: pointColor }} />
                      <text x="16" y="34" className={styles.tooltipTitle}>
                        {record.season}{isProjected ? " (예상)" : ""}
                      </text>
                      <text x="16" y="70" className={styles.tooltipValue}>
                        OVR <tspan className={styles.tooltipHighlight} style={{ fill: tColor }}>{record.OVR}</tspan>
                      </text>
                      <text x="16" y="100" className={styles.tooltipSub}>
                        OFF {record.OFF} / DEF {record.DEF}{record.team ? ` · ${record.team}` : ""}
                      </text>
                    </g>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {anyProjected && (
        <p className={styles.projectedNote}>
          * 다음 시즌(경기 기록 없음, 작년 기록 기반 예상) 또는 군 복무·부상 등 공백 시즌(앞뒤 실측값 보간)
        </p>
      )}
    </div>
  );
}
