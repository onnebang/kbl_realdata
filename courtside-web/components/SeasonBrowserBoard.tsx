"use client";

import { useMemo, useState } from "react";
import { TeamBadge } from "./TeamBadge";
import SeasonBrowserModal from "./SeasonBrowserModal";
import type { SeasonGameRow } from "@/lib/seasonBrowser";
import styles from "@/app/season-browser/season-browser.module.css";

// web/season_browser_template.html의 renderGameList()/openBoxScore() 포팅 - 검색어
// 실시간 필터링과 박스스코어 모달 열기/닫기는 진짜 상호작용이 필요해서 이 프로젝트
// 컨벤션대로 client component(courtside-web CLAUDE.md: "실시간 상호작용이 필요한 경우만
// use client"). 경기 목록 자체는 app/season-browser/page.tsx가 서버에서 미리 불러와
// props로 넘겨준 걸 그대로 받아 필터링만 함 - 여기서 추가로 Supabase를 부르지 않음.

function fmtDate(d: string) {
  return d.replaceAll("-", ".");
}

export default function SeasonBrowserBoard({ games }: { games: SeasonGameRow[] }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"ALL" | "정규시즌" | "플레이오프" | "챔피언결정전">("ALL");
  const [selected, setSelected] = useState<SeasonGameRow | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return games.filter((g) => {
      if (category !== "ALL" && g.season_category !== category) return false;
      if (!q) return true;
      const hay = [g.home_team?.name, g.home_team?.abbr, g.away_team?.name, g.away_team?.abbr]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [games, search, category]);

  return (
    <div>
      <div className={styles.filters}>
        <input
          type="text"
          placeholder="팀 이름으로 검색 (예: KT, 서울SK)"
          aria-label="팀 이름 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label="경기 구분" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
          <option value="ALL">전체</option>
          <option value="정규시즌">정규시즌</option>
          <option value="플레이오프">플레이오프</option>
          <option value="챔피언결정전">챔피언결정전</option>
        </select>
      </div>

      <div className={styles.countLine}>{rows.length}경기</div>
      <div className={styles.panel}>
        {rows.length === 0 ? (
          <div className={styles.grEmpty}>해당하는 경기가 없습니다.</div>
        ) : (
          rows.map((g) => {
            const hWin = (g.home_score ?? 0) > (g.away_score ?? 0);
            return (
              <button key={g.gmkey} type="button" className={styles.gameRow} onClick={() => setSelected(g)}>
                <div>
                  <div className={styles.grDate}>{fmtDate(g.game_date)}</div>
                  {g.season_category === "플레이오프" && <span className={styles.grCat}>PO</span>}
                  {g.season_category === "챔피언결정전" && <span className={styles.grCat}>CP</span>}
                </div>
                <div className={styles.grMatchup}>
                  <span className={styles.grTeam}>
                    <TeamBadge team={g.home_team ? { ...g.home_team, logoUrl: g.home_team.logo_url } : null} size={20} />
                    {g.home_team?.name ?? "?"}
                  </span>
                  <span className={styles.grVs}>vs</span>
                  <span className={styles.grTeam}>
                    <TeamBadge team={g.away_team ? { ...g.away_team, logoUrl: g.away_team.logo_url } : null} size={20} />
                    {g.away_team?.name ?? "?"}
                  </span>
                </div>
                <div className={styles.grScore}>
                  <span className={hWin ? styles.win : undefined}>{g.home_score}</span> - <span className={!hWin ? styles.win : undefined}>{g.away_score}</span>
                </div>
              </button>
            );
          })
        )}
      </div>

      {selected && <SeasonBrowserModal game={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
