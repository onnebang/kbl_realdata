import type { Metadata } from "next";
import { getSeasonsWithMetricData, getSeasonPlayerMetrics } from "@/lib/customMetric";
import CustomMetricBuilder from "@/components/CustomMetricBuilder";
import { WidgetBoundary } from "@/components/WidgetBoundary";

export default async function CustomMetricPage({ searchParams }: { searchParams: Promise<{ season?: string }> }) {
  const { season } = await searchParams;
  const seasons = await getSeasonsWithMetricData();
  const activeSeason = season ?? seasons[0];
  const players = activeSeason ? await getSeasonPlayerMetrics(activeSeason) : [];

  return (
    <div className="wrap">
      <div className="title">커스텀 지표</div>
      <div className="subtitle">
        PPG/RPG/APG 같은 개별 스탯에 직접 가중치를 매겨 나만의 순위를 만들어보세요. 원값이 아니라 이 시즌
        리그 평균 대비 몇 표준편차 위인지(z-score)를 쓰기 때문에, 서로 단위가 다른 스탯(득점 vs 스틸)도
        공정하게 합산됩니다. 턴오버는 낮을수록 좋은 스탯이라 부호를 반전해서 더했습니다.
      </div>

      <form style={{ marginTop: 18, display: "flex", gap: 8 }}>
        <select name="season" defaultValue={activeSeason}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s} 시즌
            </option>
          ))}
        </select>
        <button type="submit" className="btn-primary">
          시즌 보기
        </button>
      </form>

      {players.length > 0 ? (
        <WidgetBoundary name="커스텀 지표">
          <CustomMetricBuilder players={players} />
        </WidgetBoundary>
      ) : (
        <div className="panel">
          <div className="empty-note">이 시즌은 조건(10경기 이상)을 충족하는 선수가 없음</div>
        </div>
      )}

      <footer className="foot">
        {activeSeason} 시즌 · {players.length}명 · game_player_stats에서 실시간 계산 · 가중치는 브라우저에서만 반영(저장 안 됨)
      </footer>
    </div>
  );
}

export const metadata: Metadata = {
  title: "커스텀 지표",
  description: "가중치를 직접 정해 만드는 선수 지표",
};
