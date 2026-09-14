"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchEntitySeasonGridsAction } from "@/lib/scoringExplorerActions";
// lib/scoringExplorer.ts가 아니라 여기서 가져온다 - 그쪽은 Supabase를 import해서 브라우저
// 번들에 공개 키까지 끌고 들어온다(이 화면의 조회는 Server Action이 한다).
import { GRID, buildHeatmapSvg, type Dimension, type EntityOption, type EntitySeasonGrids, type GridResult } from "@/lib/scoringExplorerShape";
import styles from "@/app/leaderboards/scoring-explorer/scoring-explorer.module.css";

// web/scoring_distribution_template.html의 <script> 전체(el.* 이벤트 리스너들, pickEntity,
// render, play/pause)를 React 상태로 포팅. 원본과 동일하게 "엔티티를 고르면 그 엔티티의 전체
// 시즌 격자를 한 번에 들고 있다가, 재생/이전/다음/슬라이더는 서버 왕복 없이 클라이언트
// 메모리에서만" 동작 - 엔티티 자체를 바꾸는 순간만 fetchEntitySeasonGridsAction(Server Action)
// 호출.
// team/player는 뺐다 - 팀·선수 페이지의 히어로 밀도 지도가 같은 데이터를 더 잘 그린다.
// 여기 남은 둘은 그 페이지들에 없는 것: 리그 전체의 시대 변화와, 감독별 성향.
const DIM_LABELS: { value: Dimension; label: string }[] = [
  { value: "league", label: "리그 전체" },
  { value: "coach", label: "감독별" },
];

const VIEW_BOX = `${GRID.xMin} ${GRID.yMin} ${GRID.xMax - GRID.xMin} ${GRID.yMax - GRID.yMin}`;

function CourtPanel({ label, grid, loading }: { label: string; grid: GridResult | null | undefined; loading?: boolean }) {
  const svg = grid && grid.totalAtt > 0 ? buildHeatmapSvg(grid) : null;
  const pct = grid && grid.totalAtt ? Math.round((grid.totalMade / grid.totalAtt) * 100) : 0;
  return (
    <div className={styles.courtBlock}>
      <div className={styles.courtLabel}>{label}</div>
      <div className={styles.courtTilt}>
        <svg
          className={styles.courtSvg}
          viewBox={VIEW_BOX}
          dangerouslySetInnerHTML={{ __html: svg ?? "" }}
        />
      </div>
      {loading ? (
        <div className={styles.emptyNote}>불러오는 중…</div>
      ) : svg ? (
        <div className={styles.statLine}>
          {grid!.totalAtt.toLocaleString()}회 시도 · {grid!.totalMade.toLocaleString()}회 성공 ({pct}%)
        </div>
      ) : (
        <div className={styles.emptyNote}>이 시즌 표본 부족(30회 미만) 또는 데이터 없음</div>
      )}
    </div>
  );
}

export default function ScoringExplorerClient({
  entityOptionsByDim,
  initialDim,
  initialEntity,
}: {
  entityOptionsByDim: Record<Dimension, EntityOption[]>;
  initialDim: Dimension;
  initialEntity: EntityOption | null;
}) {
  const [dim, setDim] = useState<Dimension>(initialDim);
  const [entity, setEntity] = useState<EntityOption | null>(initialEntity);
  const [seasons, setSeasons] = useState<string[]>([]);
  const [grids, setGrids] = useState<Record<string, GridResult>>({});
  const [seasonIdx, setSeasonIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  // 기본 엔티티의 전체 이력도 마운트 직후 Server Action으로 불러오므로(위 page.tsx 주석)
  // 처음부터 로딩 상태로 시작(기본 엔티티가 없으면 불러올 것도 없다).
  const [loading, setLoading] = useState(Boolean(initialEntity));

  const [query, setQuery] = useState(initialEntity?.label ?? "");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const [compareLeague, setCompareLeague] = useState(false);
  const [leagueData, setLeagueData] = useState<EntitySeasonGrids | null>(null);
  const [leagueLoading, setLeagueLoading] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);

  // 검색 드롭다운 바깥 클릭 시 닫기(template의 document.addEventListener('click', ...)).
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setDropdownOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // 시즌 재생 - 1.1초 간격으로 다음 시즌, 끝에 도달하면 처음으로(template의 setInterval 루프
  // 그대로).
  useEffect(() => {
    if (!playing || seasons.length === 0) return;
    const t = setInterval(() => {
      setSeasonIdx((i) => (i + 1 >= seasons.length ? 0 : i + 1));
    }, 1100);
    return () => clearInterval(t);
  }, [playing, seasons.length]);

  // "리그 평균과 비교" 체크 시 리그 데이터를 딱 한 번만 지연 로드(끄고 다시 켜도 재사용).
  // 예전엔 compareLeague를 보는 effect가 로딩 상태를 켰다 - 체크하는 그 이벤트에서 바로 부른다.
  function toggleCompareLeague(on: boolean) {
    setCompareLeague(on);
    if (!on || leagueData || leagueLoading) return;
    setLeagueLoading(true);
    fetchEntitySeasonGridsAction("league", "league")
      .then(setLeagueData)
      .finally(() => setLeagueLoading(false));
  }

  function applyGrids(result: EntitySeasonGrids) {
    setSeasons(result.seasons);
    setGrids(result.grids);
    setSeasonIdx(Math.max(0, result.seasons.length - 1));
  }

  async function pickEntity(nextDim: Dimension, id: string) {
    const opt = (entityOptionsByDim[nextDim] ?? []).find((e) => e.id === id);
    if (!opt) return;
    setDim(nextDim);
    setEntity(opt);
    setQuery(opt.label);
    setDropdownOpen(false);
    setPlaying(false);
    setLoading(true);
    try {
      applyGrids(await fetchEntitySeasonGridsAction(nextDim, id));
    } finally {
      setLoading(false);
    }
  }

  // 마운트 직후 기본 엔티티(팀 이름순 첫 팀)의 전체 이력을 Server Action으로 불러옴 - SSR에서
  // 미리 굽지 않는 이유는 app/leaderboards/scoring-explorer/page.tsx 상단 주석 참고.
  // dim·entity·query·loading의 초기값이 이미 기본 엔티티라 여기서는 결과만 받아 넣는다.
  const initialId = initialEntity?.id;
  useEffect(() => {
    if (!initialId) return;
    let cancelled = false;
    fetchEntitySeasonGridsAction(initialDim, initialId)
      .then((result) => !cancelled && applyGrids(result))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [initialDim, initialId]);

  function handleDimChange(nextDim: Dimension) {
    setQuery("");
    const list = entityOptionsByDim[nextDim] ?? [];
    if (list.length) pickEntity(nextDim, list[0].id);
  }

  const filteredOptions = useMemo(() => {
    const list = entityOptionsByDim[dim] ?? [];
    const q = query.trim();
    return (q ? list.filter((e) => e.label.includes(q)) : list).slice(0, 60);
  }, [dim, query, entityOptionsByDim]);

  function pause() {
    setPlaying(false);
  }
  function goPrev() {
    pause();
    setSeasonIdx((i) => Math.max(0, i - 1));
  }
  function goNext() {
    pause();
    setSeasonIdx((i) => Math.min(seasons.length - 1, i + 1));
  }

  const season = seasons[seasonIdx];
  const mainGrid = season ? grids[season] : null;
  const compareGrid = compareLeague && season ? leagueData?.grids[season] : null;

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.controlsRow}>
          <select
            className={styles.control}
            value={dim}
            onChange={(e) => handleDimChange(e.target.value as Dimension)}
          >
            {DIM_LABELS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>

          <div className={styles.entitySearchWrap} ref={wrapRef}>
            <input
              type="text"
              className={`${styles.control} ${styles.entitySearchInput}`}
              placeholder="검색..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setDropdownOpen(true);
              }}
              onFocus={() => setDropdownOpen(true)}
            />
            <div className={`${styles.entityDropdown} ${dropdownOpen ? styles.entityDropdownShow : ""}`}>
              {filteredOptions.length ? (
                filteredOptions.map((opt) => (
                  <div
                    key={opt.id}
                    className={`${styles.entityOpt} ${opt.id === entity?.id ? styles.entityOptActive : ""}`}
                    onClick={() => pickEntity(dim, opt.id)}
                  >
                    <span>{opt.label}</span>
                  </div>
                ))
              ) : (
                <div className={styles.entityOptEmpty}>검색 결과 없음</div>
              )}
            </div>
          </div>

          <label className={styles.compareLabel}>
            <input type="checkbox" checked={compareLeague} onChange={(e) => toggleCompareLeague(e.target.checked)} />
            리그 평균과 비교 (최근 3시즌)
          </label>
        </div>

        <div className={styles.seasonControls}>
          <button type="button" className={styles.sctl} onClick={goPrev} disabled={seasonIdx <= 0}>
            ◀
          </button>
          <button
            type="button"
            className={`${styles.sctl} ${playing ? styles.sctlActive : ""}`}
            onClick={() => setPlaying((p) => !p)}
            disabled={seasons.length < 2}
          >
            {playing ? "⏸ 정지" : "▶ 재생"}
          </button>
          <button type="button" className={styles.sctl} onClick={goNext} disabled={seasonIdx >= seasons.length - 1}>
            ▶
          </button>
          <input
            type="range"
            className={styles.seasonSlider}
            min={0}
            max={Math.max(0, seasons.length - 1)}
            value={seasonIdx}
            onChange={(e) => {
              pause();
              setSeasonIdx(Number(e.target.value));
            }}
          />
          <span className={styles.seasonLabel}>{season ?? "-"}</span>
        </div>

        <div className={styles.courtsWrap}>
          {loading ? (
            <div className={styles.courtBlock}>
              <div className={styles.emptyNote}>불러오는 중…</div>
            </div>
          ) : (
            <CourtPanel label={entity?.label ?? "-"} grid={mainGrid} />
          )}
          {compareLeague && (
            <CourtPanel label="리그 평균" grid={compareGrid} loading={leagueLoading && !leagueData} />
          )}
        </div>

        <div className={styles.legendRow}>
          <span>적음</span>
          <span className={styles.legendBar} />
          <span>시도 많음</span>
        </div>
      </div>

      <footer className={styles.foot}>
        15시즌(2011-12~2025-26) 전체 슛차트 기반(shot_log에서 실시간 조회) · (엔티티,시즌) 조합 중
        시도 30회 미만은 표본 부족으로 제외 · 반코트 기준(원정 슛도 미러링해서 한 골대로 정규화) ·
        리그 전체(단독 선택/평균 비교 모두)는 데이터량이 많아 최근 3시즌만 지원.
      </footer>
    </>
  );
}
