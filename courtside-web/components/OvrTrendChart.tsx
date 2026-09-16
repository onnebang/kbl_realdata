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
  const HEIGHT = 260;
  // 축 라벨이 회전 없이 가로로 짧게만 찍혀서(formatSeason) 60px짜리 하단 여백은 과했다 -
  // 줄여서 꺾은선 자체가 상자를 더 채우게(감사 피드백: "추이가 잘 안 보임"의 절반은 라벨/점
  // 대비 문제였지만 나머지 절반은 그래프가 상자 안에서 너무 작게 그려지던 것).
  const PADDING_TOP = 28;
  const PADDING_BOTTOM = 42;
  const PADDING_X = 50;

  const MIN_OVR = 40;
  const MAX_OVR = 99;

  const yRange = MAX_OVR - MIN_OVR;
  const innerHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const innerWidth = WIDTH - PADDING_X * 2;

  // 좌표 계산 함수
  const getX = (index: number) => {
    if (history.length === 1) return WIDTH / 2;
    return PADDING_X + (index / (history.length - 1)) * innerWidth;
  };

  const getY = (val: number) => {
    const clamped = Math.max(MIN_OVR, Math.min(MAX_OVR, val));
    return PADDING_TOP + innerHeight - ((clamped - MIN_OVR) / yRange) * innerHeight;
  };

  // Area Path (Fill)
  const areaPath = `
    M ${getX(0)},${HEIGHT - PADDING_BOTTOM}
    ${history.map((r, i) => `L ${getX(i)},${getY(r.OVR)}`).join(" ")}
    L ${getX(history.length - 1)},${HEIGHT - PADDING_BOTTOM}
    Z
  `;

  // Line Path (Stroke)
  const linePath = `
    M ${getX(0)},${getY(history[0].OVR)}
    ${history.slice(1).map((r, i) => `L ${getX(i + 1)},${getY(r.OVR)}`).join(" ")}
  `;

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
        <p className={styles.subtitle}>역대 시즌 오버롤(OVR) 변화 추이</p>
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
          {[40, 60, 80, 99].map((val) => (
            <g key={val}>
              <line
                x1={PADDING_X - 10}
                y1={getY(val)}
                x2={WIDTH - PADDING_X + 10}
                y2={getY(val)}
                className={styles.gridLine}
              />
              <text x={PADDING_X - 20} y={getY(val) + 4} className={styles.yAxisLabel}>
                {val}
              </text>
            </g>
          ))}

          {/* 영역형 차트 채우기 */}
          <path d={areaPath} fill="url(#areaGradient)" className={styles.areaPath} />

          {/* 꺾은선 */}
          <path d={linePath} className={styles.linePath} filter="url(#glow)" />

          {/* 데이터 포인트 (Dots) 및 호버 인터랙션 영역 */}
          {history.map((record, i) => {
            const cx = getX(i);
            const cy = getY(record.OVR);
            const isHovered = hoverIdx === i;

            return (
              <g key={i} onMouseEnter={() => setHoverIdx(i)}>
                {/* 툴팁을 띄우기 위한 넓은 감지 영역 */}
                <rect
                  x={cx - (innerWidth / history.length) / 2}
                  y={0}
                  width={innerWidth / history.length}
                  height={HEIGHT}
                  fill="transparent"
                  style={{ cursor: "crosshair" }}
                />

                {/* X축 시즌 라벨 */}
                <text
                  x={cx}
                  y={HEIGHT - 25}
                  className={`${styles.xAxisLabel} ${isHovered ? styles.xAxisLabelActive : ""}`}
                >
                  {formatSeason(record.season)}
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
                  className={`${styles.dataPoint} ${isHovered ? styles.dataPointActive : ""}`}
                />

                {/* 툴팁 SVG 구현 (Hover) */}
                {isHovered && (
                  <g className={styles.tooltipGroup}>
                    {/* 툴팁 위치 조정 (오른쪽 가장자리 짤림 방지) */}
                    <g transform={`translate(${cx > WIDTH - 150 ? cx - 130 : cx + 15}, ${Math.max(cy - 60, PADDING_TOP)})`}>
                      <rect width="110" height="70" rx="4" className={styles.tooltipBg} />
                      <text x="10" y="24" className={styles.tooltipTitle}>{record.season}</text>
                      <text x="10" y="44" className={styles.tooltipValue}>
                        OVR <tspan className={styles.tooltipHighlight}>{record.OVR}</tspan>
                      </text>
                      <text x="10" y="60" className={styles.tooltipSub}>
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
    </div>
  );
}
