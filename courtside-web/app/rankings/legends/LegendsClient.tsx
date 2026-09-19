"use client";

import { useState } from "react";
import Link from "next/link";
import styles from "../rankings.module.css";
import Image from "next/image";

interface LegendData {
  rank: number;
  pcode: string;
  pname: string;
  value: number;
  is_active: boolean;
}

interface CategoryData {
  name: string;
  data: LegendData[];
}

interface Props {
  leaders: Record<string, CategoryData>;
}

export default function LegendsClient({ leaders }: Props) {
  const categories = Object.keys(leaders);
  const [activeTab, setActiveTab] = useState(categories[0] || "");

  if (categories.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.title}>LIVING LEGENDS</div>
        <p>No data available. Database backfill may be in progress...</p>
      </div>
    );
  }

  const currentCategory = leaders[activeTab];

  return (
    <div className={styles.container}>
      <div className={styles.title}>LIVING LEGENDS</div>
      <div className={styles.subtitle}>KBL 역대 통산 기록 (정규시즌+PO 통합)</div>

      <div className={styles.tabs}>
        {categories.map((key) => (
          <button
            key={key}
            className={`${styles.tab} ${activeTab === key ? styles.tabActive : ""}`}
            onClick={() => setActiveTab(key)}
          >
            {leaders[key].name}
          </button>
        ))}
      </div>

      <div className={styles.list}>
        {currentCategory.data.map((player) => (
          <Link
            key={`${activeTab}-${player.pcode}`}
            href={`/players/${player.pcode}`}
            style={{ textDecoration: "none", color: "inherit" }}
          >
            <div className={styles.card}>
              <div className={styles.rank}>{player.rank}</div>
              
              <div style={{ position: "relative", width: 60, height: 60, borderRadius: "50%", overflow: "hidden", marginRight: 16, backgroundColor: "#30363d" }}>
                <Image
                  src={`https://kbl.or.kr/files/kbl/players-photo/${player.pcode}.png`}
                  alt={player.pname}
                  fill
                  style={{ objectFit: "cover" }}
                  unoptimized
                />
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
                  {player.pname}
                  {!player.is_active && (
                    <span style={{ marginLeft: 8, fontSize: "0.8rem", backgroundColor: "#30363d", padding: "2px 6px", borderRadius: 4, color: "#8b949e" }}>
                      은퇴
                    </span>
                  )}
                  {player.is_active && (
                    <span style={{ marginLeft: 8, fontSize: "0.8rem", backgroundColor: "rgba(46, 160, 67, 0.2)", padding: "2px 6px", borderRadius: 4, color: "#3fb950", border: "1px solid rgba(46, 160, 67, 0.4)" }}>
                      현역
                    </span>
                  )}
                </div>
              </div>

              <div style={{ fontSize: "1.5rem", fontWeight: 800, color: "#f0f6fc", textAlign: "right" }}>
                {player.value.toLocaleString()}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
