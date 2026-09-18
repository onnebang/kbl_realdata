"use client";

import React, { useState } from "react";
import styles from "./OvrTrendChart.module.css";
import { OvrSeasonRecord } from "../lib/ovr";

interface OvrTrendChartProps {
  history: OvrSeasonRecord[];
  teamColor?: string;
}

export default function OvrTrendChart({ history, teamColor = "#542582" }: OvrTrendChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!history || history.length === 0) {
    return <div className={styles.empty}>OVR 트렌드 데이터가 없습니다.</div>;
  }

  // 차트 스케일링 설정
  const WIDTH = 1000;
  // 2kratings.com류 참고 이미지처럼 각 점 위에 오버롤 숫자를 항상 큼직하게 띄우려면 그
  // 배지가 들어갈 위쪽 여백이 예전(34)보다 훨씬 더 필요하다 - 높이/상단 패딩을 늘린다.
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
  // 간격에 맞춰 줄여서 겹치지 않게 한다(신인 2~3시즌은 참고 이미지처럼 크게, 15시즌
  // 롱런 선수는 촘촘하게).
  const spacing = history.length > 1 ? innerWidth / (history.length - 1) : innerWidth;
  const badgeR = Math.max(15, Math.min(30, spacing / 2 - 4));
  const badgeFont = Math.max(15, Math.round(badgeR * 0.8));
  const xLabelFont = Math.max(14, Math.min(26, spacing / 3.4));

  // 좌표 계산 함수
  const getX = (index: number) => {
    if (history.length === 1) return WIDTH / 2;
    return PADDING_X + (index / (history.length - 1)) * innerWidth;
  };

  const getY = (val: number) => {
    const clamped = Math.max(MIN_OVR, Math.min(MAX_OVR, val));
    return PADDING_TOP + innerHeight - ((clamped - MIN_OVR) / yRange) * innerHeight;
  };

  // 예상(다음 시즌, 아직 경기 기록 없음) 구간은 확정 구간과 선을 분리해 점선으로 그린다 -
  // 실측/추정이 시각적으로도 구분되게(요청: "예상 오버롤이 흐름이 제대로 이어지는지").
  const projectedStartIdx = history.findIndex((r) => r.projected);
  const confirmedHistory = projectedStartIdx === -1 ? history : history.slice(0, projectedStartIdx + 1);

  const pathFor = (rows: OvrSeasonRecord[], offset: number) => {
    if (rows.length === 0) return "";
    return `M ${getX(offset)},${getY(rows[0].OVR)} ${rows
      .slice(1)
      .map((r, i) => `L ${getX(offset + i + 1)},${getY(r.OVR)}`)
      .join(" ")}`;
  };

  // Area Path (Fill) - 전체 구간(예상 포함) 채우기
  const areaPath = `
    M ${getX(0)},${HEIGHT - PADDING_BOTTOM}
    ${history.map((r, i) => `L ${getX(i)},${getY(r.OVR)}`).join(" ")}
    L ${getX(history.length - 1)},${HEIGHT - PADDING_BOTTOM}
    Z
  `;

  // 확정 구간 선(실선) - 예상 구간이 있으면 그 시작점까지만
  const confirmedLinePath = pathFor(confirmedHistory, 0);
  // 예상 구간 선(점선) - 마지막 확정 점 -> 예상 점만 잇는다
  const projectedLinePath =
    projectedStartIdx > 0 ? pathFor(history.slice(projectedStartIdx - 1), projectedStartIdx - 1) : "";

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
        <p className={styles.subtitle}>역대 시즌 오버롤(OVR) 변화 추이{projectedStartIdx !== -1 ? " · 점선=다음 시즌 예상" : ""}</p>
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

          {/* 영역형 차트 채우기 */}
          <path d={areaPath} fill="url(#areaGradient)" className={styles.areaPath} />

          {/* 꺾은선: 확정 구간(실선) + 예상 구간(점선) */}
          <path d={confirmedLinePath} className={styles.linePath} filter="url(#glow)" />
          {projectedLinePath && (
            <path d={projectedLinePath} className={styles.linePathProjected} />
          )}

          {/* 데이터 포인트 + 항상 보이는 오버롤 숫자 배지 */}
          {history.map((record, i) => {
            const cx = getX(i);
            const cy = getY(record.OVR);
            const isHovered = hoverIdx === i;
            const isProjected = !!record.projected;
            const badgeCy = Math.max(cy - badgeR - 14, badgeR + 4);

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

                {/* X축 시즌 라벨 */}
                <text
                  x={cx}
                  y={HEIGHT - 32}
                  fontSize={xLabelFont}
                  className={`${styles.xAxisLabel} ${isHovered ? styles.xAxisLabelActive : ""}`}
                >
                  {formatSeason(record.season)}{isProjected ? "*" : ""}
                </text>

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

                {/* 점 (Dot) */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={isHovered ? 6 : 4}
                  className={`${styles.dataPoint} ${isHovered ? styles.dataPointActive : ""} ${isProjected ? styles.dataPointProjected : ""}`}
                />

                {/* 참고 이미지 스타일: 오버롤 숫자를 배지로 항상 표시(호버 없이도 읽힘) */}
                <line
                  x1={cx} y1={cy} x2={cx} y2={badgeCy + badgeR}
                  className={styles.badgeStem}
                />
                <circle
                  cx={cx}
                  cy={badgeCy}
                  r={badgeR}
                  className={`${styles.ovrBadge} ${isProjected ? styles.ovrBadgeProjected : ""} ${isHovered ? styles.ovrBadgeActive : ""}`}
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
                      <rect width="190" height="120" rx="6" className={styles.tooltipBg} />
                      <text x="16" y="34" className={styles.tooltipTitle}>
                        {record.season}{isProjected ? " (예상)" : ""}
                      </text>
                      <text x="16" y="70" className={styles.tooltipValue}>
                        OVR <tspan className={styles.tooltipHighlight}>{record.OVR}</tspan>
                      </text>
                      <text x="16" y="100" className={styles.tooltipSub}>
                        OFF {record.OFF} / DEF {record.DEF}
                      </text>
                    </g>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {projectedStartIdx !== -1 && (
        <p className={styles.projectedNote}>* 아직 경기 기록이 없는 다음 시즌 - 작년 기록 기반 예상치</p>
      )}
    </div>
  );
}
