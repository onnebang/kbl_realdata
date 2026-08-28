import {
  getSeasonsWithShots,
  getEntityOptions,
  getShotGrid,
  buildHeatmapSvg,
  type Dimension,
} from "@/lib/scoringExplorer";

const DIM_LABELS: { value: Dimension; label: string }[] = [
  { value: "league", label: "리그 전체" },
  { value: "team", label: "팀" },
  { value: "player", label: "선수" },
  { value: "coach", label: "코치" },
];

export default async function ScoringExplorerPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; dim?: string; entity?: string }>;
}) {
  const { season, dim, entity } = await searchParams;
  const seasons = await getSeasonsWithShots();
  const activeSeason = season ?? seasons[0];
  const activeDim = (DIM_LABELS.find((d) => d.value === dim)?.value ?? "league") as Dimension;
  const entities = await getEntityOptions(activeDim, activeSeason);
  const activeEntity = entity && entities.some((e) => e.id === entity) ? entity : entities[0]?.id;
  const grid = activeEntity ? await getShotGrid(activeDim, activeEntity, activeSeason) : null;
  const svg = grid ? buildHeatmapSvg(grid) : null;
  const pct = grid && grid.totalAtt ? Math.round((grid.totalMade / grid.totalAtt) * 100) : 0;

  return (
    <div className="wrap">
      <div className="title">득점 분포 탐색기</div>
      <div className="subtitle">
        팀·선수·코치·리그 단위로 한 시즌의 슛 시도를 반코트 히트맵으로. 상대 쪽 슛은 한쪽 골대 기준으로 미러링해서
        정규화했습니다.
      </div>

      <form style={{ marginTop: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select name="dim" defaultValue={activeDim}>
          {DIM_LABELS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
        <select name="entity" defaultValue={activeEntity}>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
        <select name="season" defaultValue={activeSeason}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s} 시즌
            </option>
          ))}
        </select>
        <button type="submit" className="back-link" style={{ cursor: "pointer" }}>
          조회
        </button>
      </form>

      <div className="panel">
        <div className="panel-title">
          {entities.find((e) => e.id === activeEntity)?.label ?? "-"} · {activeSeason}
        </div>
        {grid && grid.totalAtt > 0 ? (
          <>
            <div className="explorer-stat-line">
              {grid.totalAtt.toLocaleString()}회 시도 · {grid.totalMade.toLocaleString()}회 성공 ({pct}%)
            </div>
            <div className="zc-court-tilt">
              <svg className="zc-court" viewBox="345 27 375 357" dangerouslySetInnerHTML={{ __html: svg ?? "" }} />
            </div>
            <div className="explorer-legend">
              <span>적음</span>
              <div className="explorer-legend-gradient" />
              <span>시도 많음</span>
            </div>
          </>
        ) : (
          <div className="empty-note">이 조건에 해당하는 슛 기록이 없음</div>
        )}
      </div>

      <footer className="foot">
        {activeSeason} 시즌 · shot_log에서 실시간 조회 · 반코트 미러링(원본 골대 위치 기준)
      </footer>
    </div>
  );
}
