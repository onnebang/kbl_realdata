"use client";

import { useState, useRef } from "react";
import styles from "./ScoringInfographicStudio.module.css";

type TabKey = "season" | "location" | "opponent" | "team";

interface ScoringStudioProps {
  playerName: string;
  careerPts: number;
  seasonBarSvg: string;
  zoneSvg: string;
  detailed5ZoneSvg: string;
  koreaMapSvg: string;
  teamPieSvg: string;
  hasTeamBreakdown: boolean;
}

export default function ScoringInfographicStudio({
  playerName,
  careerPts,
  seasonBarSvg,
  zoneSvg,
  detailed5ZoneSvg,
  koreaMapSvg,
  teamPieSvg,
  hasTeamBreakdown,
}: ScoringStudioProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("season");
  const [zoneMode, setZoneMode] = useState<"classic" | "detailed">("classic");
  const [isExporting, setIsExporting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 현재 활성 탭에 대응하는 SVG 추출
  let activeSvg = seasonBarSvg;
  let tabNameEn = "BY_SEASON";
  let tabNameKo = "시즌별";

  if (activeTab === "location") {
    activeSvg = zoneMode === "classic" ? zoneSvg : detailed5ZoneSvg;
    tabNameEn = zoneMode === "classic" ? "BY_SHOT_LOCATION" : "5_ZONE_EFFICIENCY";
    tabNameKo = zoneMode === "classic" ? "슛 위치별" : "5구역 정밀분석";
  } else if (activeTab === "opponent") {
    activeSvg = koreaMapSvg;
    tabNameEn = "BY_OPPONENT";
    tabNameKo = "상대 연고지별";
  } else if (activeTab === "team") {
    activeSvg = teamPieSvg;
    tabNameEn = "BY_TEAM";
    tabNameKo = "소속팀별";
  }

  // 1920x1080 초고화질 방송용 PNG 내보내기 함수
  const handleExportPng = async () => {
    if (!activeSvg) return;
    setIsExporting(true);

    try {
      // 1. 1920x1080 캔버스 생성
      const canvas = document.createElement("canvas");
      canvas.width = 1920;
      canvas.height = 1080;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // 2. ESPN 스타일 스튜디오 캔버스 배경 칠하기
      const bgGrad = ctx.createRadialGradient(960, 540, 100, 960, 540, 1100);
      bgGrad.addColorStop(0, "#f8f6f0");
      bgGrad.addColorStop(1, "#ece6dc");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, 1920, 1080);

      // 미세한 페이퍼 노이즈 질감 시뮬레이션
      ctx.fillStyle = "rgba(0, 0, 0, 0.015)";
      for (let i = 0; i < 4000; i++) {
        const rx = Math.random() * 1920;
        const ry = Math.random() * 1080;
        ctx.fillRect(rx, ry, 2, 2);
      }

      // 3. SVG를 Blob 및 Image로 변환하여 캔버스에 렌더링
      const svgBlob = new Blob([activeSvg], { type: "image/svg+xml;charset=utf-8" });
      const URL = window.URL || window.webkitURL || window;
      const blobURL = URL.createObjectURL(svgBlob);

      const img = new Image();
      img.onload = () => {
        // 상하좌우 여백을 두고 시네마틱하게 그리기
        const marginX = 80;
        const marginY = 60;
        const drawW = 1920 - marginX * 2;
        const drawH = 1080 - marginY * 2;

        ctx.drawImage(img, marginX, marginY, drawW, drawH);

        // 하단 브랜딩 워터마크
        ctx.font = "bold 16px 'IBM Plex Mono', sans-serif";
        ctx.fillStyle = "#888888";
        ctx.textAlign = "right";
        ctx.fillText(`COURTSIDE · ${playerName} 통산 ${careerPts.toLocaleString()}점`, 1920 - marginX, 1080 - 24);

        URL.revokeObjectURL(blobURL);

        // 4. 다운로드 링크 트리거
        const pngUrl = canvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.download = `${playerName}_득점분석_${tabNameKo}_${tabNameEn}.png`;
        a.href = pngUrl;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setIsExporting(false);
      };

      img.onerror = () => {
        URL.revokeObjectURL(blobURL);
        setIsExporting(false);
      };

      img.src = blobURL;
    } catch (e) {
      console.error("PNG export error:", e);
      setIsExporting(false);
    }
  };

  return (
    <div className={styles.studioContainer} ref={containerRef}>
      {/* 1. 상단 제어 바 (탭 전환 + 정밀분석 토글 + 다운로드 버튼) */}
      <div className={styles.studioToolbar}>
        <div className={styles.tabGroup}>
          <button
            type="button"
            className={`${styles.tabBtn} ${activeTab === "season" ? styles.tabActive : ""}`}
            onClick={() => setActiveTab("season")}
          >
            시즌별 // BY SEASON
          </button>
          <button
            type="button"
            className={`${styles.tabBtn} ${activeTab === "location" ? styles.tabActive : ""}`}
            onClick={() => setActiveTab("location")}
          >
            슛 위치별 // BY SHOT LOCATION
          </button>
          <button
            type="button"
            className={`${styles.tabBtn} ${activeTab === "opponent" ? styles.tabActive : ""}`}
            onClick={() => setActiveTab("opponent")}
          >
            상대 연고지별 // BY OPPONENT
          </button>
          {hasTeamBreakdown && (
            <button
              type="button"
              className={`${styles.tabBtn} ${activeTab === "team" ? styles.tabActive : ""}`}
              onClick={() => setActiveTab("team")}
            >
              소속팀별 // BY TEAM
            </button>
          )}
        </div>

        <div className={styles.actionGroup}>
          {activeTab === "location" && (
            <div className={styles.subToggleGroup}>
              <button
                type="button"
                className={`${styles.toggleBtn} ${zoneMode === "classic" ? styles.toggleActive : ""}`}
                onClick={() => setZoneMode("classic")}
              >
                기본 3구역 (사진 5)
              </button>
              <button
                type="button"
                className={`${styles.toggleBtn} ${zoneMode === "detailed" ? styles.toggleActive : ""}`}
                onClick={() => setZoneMode("detailed")}
              >
                정밀 5구역 분석
              </button>
            </div>
          )}

          <button
            type="button"
            className={styles.downloadBtn}
            onClick={handleExportPng}
            disabled={isExporting}
            title="1920x1080 방송 그래픽 해상도로 PNG 다운로드"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            {isExporting ? "저장 중..." : "인포그래픽 이미지 저장 (PNG)"}
          </button>
        </div>
      </div>

      {/* 2. 16:9 와이드 시네마틱 캔버스 */}
      <div className={styles.canvasFrame}>
        <div
          className={styles.svgViewer}
          dangerouslySetInnerHTML={{ __html: activeSvg }}
        />
      </div>

      {/* 3. 하단 컨텍스트 가이드 */}
      <div className={styles.footnoteRow}>
        {activeTab === "season" && (
          <span>
            와인색 막대는 <strong>커리어 최다 득점 시즌(Career-High)</strong>을 나타냅니다. 막대 상단에서 경기당 평균 득점(PPG)을 확인할 수 있습니다.
          </span>
        )}
        {activeTab === "location" && zoneMode === "classic" && (
          <span>
            FIBA 공식 규격 반코트(3점선 6.75m) 기준입니다. 녹색 실선은 자유투 라인, 테라코타 영역은 3점 구역, 슬레이트 블루 영역은 2점 구역입니다.
          </span>
        )}
        {activeTab === "location" && zoneMode === "detailed" && (
          <span>
            실제 경기별 슛 좌표(x, y) 데이터를 기반으로 림 어택, 페인트존, 미드레인지, 3점 슛의 성공률(FG%)과 득점 비중을 정밀 산출했습니다.
          </span>
        )}
        {activeTab === "opponent" && (
          <span>
            대한민국 10개 구단 연고 도시 기준 정밀 실루엣 지도입니다. 수도권 등 밀집 지역은 지시선으로 구분되어 있으며, 좌측에서 최다 득점 상대 TOP 3를 제공합니다.
          </span>
        )}
        {activeTab === "team" && (
          <span>
            선수가 통산 활약한 각 프랜차이즈별 누적 득점 및 경기당 평균 득점(PPG) 비교 도넛 차트입니다.
          </span>
        )}
      </div>
    </div>
  );
}
