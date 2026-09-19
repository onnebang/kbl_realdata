import React from "react";
import styles from "./OvrRadarChart.module.css";

interface OvrRadarChartProps {
  attributes: {
    outside: number;
    inside: number;
    playmaking: number;
    athletic: number;
    defense: number;
    rebounding: number;
  };
  ovr: number;
}

const LABELS = ["OUTSIDE", "INSIDE", "PLAYMAKING", "ATHLETIC", "DEFENSE", "REBOUNDING"];
const KEYS = ["outside", "inside", "playmaking", "athletic", "defense", "rebounding"] as const;

export default function OvrRadarChart({ attributes, ovr }: OvrRadarChartProps) {
  // 오버롤 등급별 색상 (92/89/85/75/기본)
  const color = ovr >= 92 ? "#f43f5e" : ovr >= 89 ? "#a855f7" : ovr >= 85 ? "#3b82f6" : ovr >= 75 ? "#10b981" : "#94a3b8";
  // SVG 크기
  const size = 200;
  const center = size / 2;
  const radius = size * 0.35; // 여백을 위해 35%로 설정

  // 6각형 꼭짓점 계산
  const getPoint = (val: number, index: number, total: number) => {
    const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
    // 40~99 스케일을 0~1로 매핑 (40 미만은 최하점)
    const scale = Math.max(0, Math.min(100, val) - 40) / 60;
    const r = radius * scale;
    return {
      x: center + Math.cos(angle) * r,
      y: center + Math.sin(angle) * r,
    };
  };

  const getLabelPoint = (index: number, total: number) => {
    const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
    const r = radius * 1.25; // 라벨은 조금 더 바깥쪽
    return {
      x: center + Math.cos(angle) * r,
      y: center + Math.sin(angle) * r,
      angle: angle,
    };
  };

  // 능력치 다각형 점선
  const points = KEYS.map((k, i) => getPoint(attributes[k], i, 6))
    .map(p => `${p.x},${p.y}`)
    .join(" ");

  // 배경 6각형 점선 가이드 3단계
  const guides = [0.33, 0.66, 1].map(scale => {
    return KEYS.map((_, i) => {
      const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
      const r = radius * scale;
      return `${center + Math.cos(angle) * r},${center + Math.sin(angle) * r}`;
    }).join(" ");
  });

  return (
    <div className={styles.wrapper}>
      <svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`}>
        {/* 가이드 라인 */}
        {guides.map((pts, i) => (
          <polygon key={i} points={pts} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
        ))}
        
        {/* 중앙에서 뻗어나가는 선 */}
        {KEYS.map((_, i) => {
          const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
          return (
            <line
              key={i}
              x1={center}
              y1={center}
              x2={center + Math.cos(angle) * radius}
              y2={center + Math.sin(angle) * radius}
              stroke="rgba(255,255,255,0.1)"
              strokeWidth="1"
            />
          );
        })}

        {/* 능력치 다각형 */}
        <polygon
          points={points}
          fill={color}
          fillOpacity="0.4"
          stroke={color}
          strokeWidth="2"
          style={{ filter: `drop-shadow(0 0 5px ${color}80)` }}
        />

        {/* 라벨 & 값 */}
        {KEYS.map((k, i) => {
          const lp = getLabelPoint(i, 6);
          const anchor = lp.x < center - 10 ? "end" : lp.x > center + 10 ? "start" : "middle";
          const val = attributes[k];
          return (
            <g key={i} transform={`translate(${lp.x}, ${lp.y})`}>
              <text
                x="0"
                y="-2"
                fill="rgba(255,255,255,0.6)"
                fontSize="8"
                fontWeight="700"
                textAnchor={anchor}
                letterSpacing="0.05em"
              >
                {LABELS[i]}
              </text>
              <text
                x="0"
                y="8"
                fill="#ffffff"
                fontSize="10"
                fontWeight="800"
                textAnchor={anchor}
              >
                {val}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
