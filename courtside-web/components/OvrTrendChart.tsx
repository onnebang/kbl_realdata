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
  // 원래 260(가로세로 비 3.85:1)은 svgChart가 width:100%/height:auto로 뷰박스 비율을 그대로
  // 유지하는 구조라, 모바일처럼 폭이 좁아지면 높이도 같이 줄어들어(예: 340px 폭이면 높이
  // 88px) 등락 자체가 눌려서 거의 안 보였다(감사 피드백: "아직도 너무 작아서 안 보임").
  // 380으로 늘려 비율을 2.6:1로 낮추면 같은 폭에서도 세로 진폭이 훨씬 커진다.
  const HEIGHT = 380;
  // 축 라벨이 회전 없이 가로로 짧게만 찍혀서(formatSeason) 60px짜리 하단 여백은 과했다 -
  // 줄여서 꺾은선 자체가 상자를 더 채우게(감사 피드백: "추이가 잘 안 보임"의 절반은 라벨/점
  // 대비 문제였지만 나머지 절반은 그래프가 상자 안에서 너무 작게 그려지던 것).
  // 축 글자 크기를 11px->26px로 키운 만큼(제보: "인간의 눈으로 볼 수가 없어") 라벨이
  // 잘리지 않도록 여백도 같이 키운다.
  const PADDING_TOP = 34;
  const PADDING_BOTTOM = 60;
  const PADDING_X = 90;

  // 고정 40-99 범위(리그 전체 스케일)는 한 선수의 실제 등락(보통 한 자리~10대 초반)을
  // 59점짜리 축에 욱여넣어 선이 거의 평평해 보였다(제보: "모바일에서 차이가 거의 안 보임" -
  // 실은 모바일만의 문제가 아니라 축 자체가 이 선수의 변동폭보다 훨씬 넓었던 것). 그 선수의
  // 실제 최저~최고를 기준으로 축을 맞춰서(+여유), 변동이 작을수록 더 확대해서 보여준다.
  const values = history.map((r) => r.OVR);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max(4, (rawMax - rawMin) * 0.25);
  let MIN_OVR = Math.max(30, Math.floor((rawMin - pad) / 5) * 5);
  let MAX_OVR = Math.min(99, Math.ceil((rawMax + pad) / 5) * 5);
  // 변동이 거의 없는 선수(예: 커리어 내내 OVR 70 고정)까지 확대하면 축이 5점짜리가 되어
  // 오히려 사소한 잡음을 큰 등락처럼 과장한다 - 최소 폭 15점은 유지.
  if (MAX_OVR - MIN_OVR < 15) {
    const mid = (MAX_OVR + MIN_OVR) / 2;
    MIN_OVR = Math.max(30, Math.round(mid - 7.5));
    MAX_OVR = Math.min(99, MIN_OVR + 15);
  }

  const yRange = MAX_OVR - MIN_OVR;
  // 눈금 4개 - 축 범위가 선수마다 달라지므로(위 동적 계산) 예전처럼 40/60/80/99를 박아둘 수 없다.
  const gridVals = Array.from(new Set([MIN_OVR, Math.round(MIN_OVR + yRange / 3), Math.round(MIN_OVR + (yRange * 2) / 3), MAX_OVR]));
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
                  y={HEIGHT - 32}
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
                    <g transform={`translate(${cx > WIDTH - 220 ? cx - 200 : cx + 20}, ${Math.max(cy - 100, PADDING_TOP)})`}>
                      <rect width="190" height="120" rx="6" className={styles.tooltipBg} />
                      <text x="16" y="34" className={styles.tooltipTitle}>
                        {record.season}{record.projected ? " (예상)" : ""}
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
    </div>
  );
}
