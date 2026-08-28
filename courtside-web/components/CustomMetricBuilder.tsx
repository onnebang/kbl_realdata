"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { TeamBadge } from "./TeamBadge";
import { METRIC_COMPONENTS, type ComponentKey, type MetricPlayerRow } from "@/lib/customMetric";

const DEFAULT_WEIGHTS: Record<ComponentKey, number> = Object.fromEntries(
  METRIC_COMPONENTS.map((c) => [c.key, 1])
) as Record<ComponentKey, number>;

function fmt(v: number) {
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

export default function CustomMetricBuilder({ players }: { players: MetricPlayerRow[] }) {
  const [weights, setWeights] = useState<Record<ComponentKey, number>>(DEFAULT_WEIGHTS);

  const ranked = useMemo(() => {
    return players
      .map((p) => {
        const customIndex = METRIC_COMPONENTS.reduce((s, c) => s + weights[c.key] * p.z[c.key], 0);
        return { ...p, customIndex };
      })
      .sort((a, b) => b.customIndex - a.customIndex);
  }, [players, weights]);

  const maxAbs = Math.max(1, ...ranked.slice(0, 10).map((r) => Math.abs(r.customIndex)));

  return (
    <div>
      <div className="panel">
        <div className="panel-title-row">
          <div className="panel-title" style={{ marginBottom: 0 }}>
            가중치 조절 (슬라이더를 움직이면 아래 순위가 즉시 바뀝니다)
          </div>
          <button type="button" className="window-btn" onClick={() => setWeights(DEFAULT_WEIGHTS)}>
            초기화
          </button>
        </div>
        <div className="metric-slider-grid">
          {METRIC_COMPONENTS.map((c) => (
            <div className="metric-slider-row" key={c.key}>
              <div className="metric-slider-label">
                <span>{c.label}</span>
                <span className="metric-slider-val">{weights[c.key].toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={-2}
                max={2}
                step={0.1}
                value={weights[c.key]}
                onChange={(e) => setWeights((w) => ({ ...w, [c.key]: Number(e.target.value) }))}
                className="metric-slider"
              />
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">CUSTOM 지표 TOP 10</div>
        {ranked.slice(0, 10).map((r) => (
          <div className="wpa-bar-row" key={r.pcode}>
            <TeamBadge team={{ name: r.teamName, abbr: r.teamAbbr, color: r.teamColor, logoUrl: r.teamLogoUrl }} size={20} />
            <Link href={`/players/${r.pcode}`} className="wpa-bar-name">
              {r.name}
            </Link>
            <div className="wpa-bar-track">
              <div
                className={`wpa-bar-fill ${r.customIndex >= 0 ? "pos" : "neg"}`}
                style={{ width: `${(Math.abs(r.customIndex) / maxAbs) * 100}%` }}
              />
            </div>
            <span className={`wpa-bar-val ${r.customIndex >= 0 ? "pos" : "neg"}`}>{fmt(r.customIndex)}</span>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-title">전체 순위 ({ranked.length}명, 시즌 10경기 이상)</div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>선수</th>
                <th>팀</th>
                <th>GP</th>
                <th>CUSTOM</th>
                {METRIC_COMPONENTS.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ranked.map((r, i) => (
                <tr key={r.pcode}>
                  <td>{i + 1}</td>
                  <td>
                    <Link href={`/players/${r.pcode}`}>{r.name}</Link>
                  </td>
                  <td style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <TeamBadge team={{ name: r.teamName, abbr: r.teamAbbr, color: r.teamColor, logoUrl: r.teamLogoUrl }} size={16} />
                    {r.teamAbbr}
                  </td>
                  <td>{r.gp}</td>
                  <td className={r.customIndex >= 0 ? "wpa-pos" : "wpa-neg"}>{fmt(r.customIndex)}</td>
                  {METRIC_COMPONENTS.map((c) => (
                    <td key={c.key}>{c.key === "fgPct" || c.key === "tpPct" || c.key === "ftPct" ? `${r.raw[c.key].toFixed(1)}%` : r.raw[c.key].toFixed(1)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
