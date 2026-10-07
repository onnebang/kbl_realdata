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
  const [activeOnly, setActiveOnly] = useState(false);

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
        <div className={styles.title}>올타임 리더스</div>
        <p>No data available. Database backfill may be in progress...</p>
      </div>
    );
  }

  const currentCategory = currentSplitData[activeTab];
  const allData = currentCategory?.data ?? [];
  // 요청(2026-10-07) - 현역만 볼 때는 1위부터 새로 매긴다.
  const shownData = activeOnly ? allData.filter((p) => p.is_active) : allData;
  // "얼마나 차이가 나는지"(사용자 요청) - 역대 1위(allData[0], 필터와 무관하게 전체 1위) 대비
  // 지금 가장 앞서 있는 현역 선수의 격차. 카테고리가 전부 누적 합계(득점/리바운드 등)라 단순
  // 차로 계산해도 된다(비율 지표 없음 - tools/build_alltime_leaders.py 참고).
  const allTimeLeader = allData[0];
  const activeLeader = allData.find((p) => p.is_active);

  return (
    <div className={styles.container}>
      <div className={styles.title}>올타임 리더스</div>

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

      <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, fontSize: "0.9rem", color: "#8b949e", cursor: "pointer" }}>
        <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
        현역만 보기
      </label>

      {allTimeLeader && activeLeader && activeLeader.pcode !== allTimeLeader.pcode && (
        <p style={{ fontSize: "0.9rem", color: "#8b949e", marginBottom: 16 }}>
          현역 선두는 <strong style={{ color: "#f0f6fc" }}>{activeLeader.pname}</strong>({activeLeader.value.toLocaleString()},
          역대 {activeLeader.rank}위) - 역대 1위 {allTimeLeader.pname}({allTimeLeader.value.toLocaleString()})와 격차{" "}
          <strong style={{ color: "#f0f6fc" }}>{(allTimeLeader.value - activeLeader.value).toLocaleString()}</strong>
        </p>
      )}
      {allTimeLeader && activeLeader && activeLeader.pcode === allTimeLeader.pcode && (
        <p style={{ fontSize: "0.9rem", color: "#3fb950", marginBottom: 16 }}>
          현역 선수가 역대 1위를 지키고 있습니다 - {activeLeader.pname}({activeLeader.value.toLocaleString()})
        </p>
      )}

      <div className={styles.list}>
        {shownData.length === 0 ? (
          <p style={{ color: "#8b949e" }}>현역 선수 중 이 부문에 기록이 있는 선수가 없습니다.</p>
        ) : (
        ) : (
          shownData.map((player, index) => (
          <Link
            key={`${splitType}-${activeTab}-${player.pcode}`}
            href={`/players/${player.pcode}`}
            style={{ textDecoration: "none", color: "inherit" }}
          >
            <div className={styles.card}>
              <div className={styles.rank}>{activeOnly ? index + 1 : player.rank}</div>

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
          ))
        )}
      </div>
    </div>
  );
}
