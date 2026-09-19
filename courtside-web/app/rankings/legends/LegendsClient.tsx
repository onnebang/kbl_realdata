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
  leaders: Record<string, Record<string, CategoryData>>;
}

export default function LegendsClient({ leaders }: Props) {
  const [splitType, setSplitType] = useState<"total" | "regular" | "playoffs">("regular");
  
  // Guard against missing data
  const currentSplitData = leaders[splitType] || {};
  const categories = Object.keys(currentSplitData);
  const [activeTab, setActiveTab] = useState(categories[0] || "");

  // If activeTab is no longer valid in the new splitType, switch it
  if (categories.length > 0 && !categories.includes(activeTab)) {
    setActiveTab(categories[0]);
  }

  if (!leaders || Object.keys(leaders).length === 0 || categories.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.title}>LIVING LEGENDS</div>
        <p>No data available. Database backfill may be in progress...</p>
      </div>
    );
  }

  const currentCategory = currentSplitData[activeTab];

  return (
    <div className={styles.container}>
      <div className={styles.title}>LIVING LEGENDS</div>
      
      {/* Split Type Selector */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
        <button
          className={`${styles.tab} ${splitType === "total" ? styles.tabActive : ""}`}
          onClick={() => setSplitType("total")}
        >
          전체 기록
        </button>
        <button
          className={`${styles.tab} ${splitType === "regular" ? styles.tabActive : ""}`}
          onClick={() => setSplitType("regular")}
        >
          정규 리그
        </button>
        <button
          className={`${styles.tab} ${splitType === "playoffs" ? styles.tabActive : ""}`}
          onClick={() => setSplitType("playoffs")}
        >
          플레이오프
        </button>
      </div>

      <div className={styles.tabs}>
        {categories.map((key) => (
          <button
            key={key}
            className={`${styles.tab} ${activeTab === key ? styles.tabActive : ""}`}
            onClick={() => setActiveTab(key)}
          >
            {currentSplitData[key].name}
          </button>
        ))}
      </div>

      <div className={styles.list}>
        {currentCategory && currentCategory.data.map((player) => (
          <Link
            key={`${splitType}-${activeTab}-${player.pcode}`}
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
