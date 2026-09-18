import React from "react";
import styles from "./ShootingDashboard.module.css";
import { classifyShot } from "../lib/formIndex";

// Re-use CareerShot type shape here (duck typing)
interface Shot {
  x: number;
  y: number;
  d: string;
  made: boolean;
  quarter: string;
}

interface Props {
  shots: Shot[];
}

interface StatRow {
  label: string;
  fgm: number;
  fga: number;
}

function calcRowStats(shots: Shot[], label: string): StatRow {
  const fgm = shots.filter((s) => s.made).length;
  return {
    label,
    fgm,
    fga: shots.length,
  };
}

const ZONE_LABELS: Record<string, string> = {
  rim: "Restricted Area (0-1.2m)",
  close: "In The Paint (Non-RA) (1.2-3.0m)",
  midShort: "Mid-Range Short (3.0-5.0m)",
  midLong: "Mid-Range Long (5.0-6.75m)",
  three: "3-Point (6.75m+)",
};

const QUARTER_ORDER: Record<string, number> = {
  "1Q": 1,
  "2Q": 2,
  "3Q": 3,
  "4Q": 4,
  "1OT": 5,
  "2OT": 6,
  "3OT": 7,
};

export default function ShootingDashboard({ shots }: Props) {
  if (!shots || shots.length === 0) {
    return null;
  }

  // 1. By Distance (Zone)
  const byZone: Record<string, Shot[]> = {
    rim: [],
    close: [],
    midShort: [],
    midLong: [],
    three: [],
  };

  shots.forEach((s) => {
    const { zone } = classifyShot(s.x, s.y, s.d);
    if (byZone[zone]) {
      byZone[zone].push(s);
    } else {
      byZone.three.push(s); // Fallback
    }
  });

  const distanceRows = ["rim", "close", "midShort", "midLong", "three"].map((z) => calcRowStats(byZone[z], ZONE_LABELS[z]));

  // 2. By Quarter
  const byQuarter: Record<string, Shot[]> = {};
  shots.forEach((s) => {
    if (!byQuarter[s.quarter]) byQuarter[s.quarter] = [];
    byQuarter[s.quarter].push(s);
  });
  const quarterRows = Object.keys(byQuarter)
    .sort((a, b) => (QUARTER_ORDER[a] ?? 99) - (QUARTER_ORDER[b] ?? 99))
    .map((q) => calcRowStats(byQuarter[q], q));

  // Render a table
  const renderTable = (rows: StatRow[]) => (
    <table className={styles.dashTable}>
      <thead>
        <tr>
          <th>Split</th>
          <th>FGM</th>
          <th>FGA</th>
          <th>FG%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const pct = r.fga > 0 ? ((r.fgm / r.fga) * 100).toFixed(1) : "-";
          return (
            <tr key={r.label}>
              <td className={styles.labelCol}>{r.label}</td>
              <td>{r.fgm}</td>
              <td>{r.fga}</td>
              <td>{pct}%</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>SHOOTING DASHBOARD</h3>
      
      <div className={styles.tableSection}>
        <div className={styles.sectionTitle}>Shooting By Distance</div>
        {renderTable(distanceRows)}
      </div>

      <div className={styles.tableSection}>
        <div className={styles.sectionTitle}>Shooting By Quarter</div>
        {renderTable(quarterRows)}
      </div>
    </div>
  );
}
