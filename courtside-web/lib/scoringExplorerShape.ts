import { drawCourtMarkings } from "./zoneCompare";

// 득점 분포 탐색기의 "모양" - **Supabase를 import하지 않는다.**
//
// 이 파일이 따로 있는 이유: components/ScoringExplorerClient.tsx("use client")가 여기 좌표
// 상수와 순수 SVG 빌더를 가져다 쓴다. 예전에는 lib/scoringExplorer.ts에서 가져왔는데, 그 파일
// 1행이 import { supabase } 라 모듈 전체가 클라이언트 번들로 끌려갔다. 그 결과 브라우저에
// @supabase/supabase-js 63.2KB(br)와 **공개 키가 실려 나갔다** - 정작 이 화면의 데이터 조회는
// lib/scoringExplorerActions.ts의 "use server" Server Action이 한다.
//
// 규칙: 이 파일에는 데이터 조회를 넣지 마라. 조회는 lib/scoringExplorer.ts에.

export const GRID = { cols: 15, rows: 15, xMin: 345, xMax: 720, yMin: 27, yMax: 384, hoopX: 681, hoopY: 205 };

export type GridCell = { row: number; col: number; att: number; made: number };
export type GridResult = { cells: GridCell[]; totalAtt: number; totalMade: number };
export type Dimension = "player" | "team" | "coach" | "league";
export type EntityOption = { id: string; label: string };
export type EntitySeasonGrids = { seasons: string[]; grids: Record<string, GridResult> };

function drawHoop(hx: number, hy: number): string {
  let svg = `<line x1="${hx + 13}" y1="${hy - 19}" x2="${hx + 13}" y2="${hy + 19}" stroke="var(--ink-soft)" stroke-width="4.5" stroke-linecap="round"/>`;
  svg += `<circle cx="${hx}" cy="${hy}" r="9.5" fill="none" stroke="#e8590c" stroke-width="3.2"/>`;
  return svg;
}

export function buildHeatmapSvg(grid: GridResult): string {
  const maxAtt = Math.max(1, ...grid.cells.map((c) => c.att));
  const cellW = (GRID.xMax - GRID.xMin) / GRID.cols;
  const cellH = (GRID.yMax - GRID.yMin) / GRID.rows;

  let svg = `<rect x="${GRID.xMin}" y="${GRID.yMin}" width="${GRID.xMax - GRID.xMin}" height="${GRID.yMax - GRID.yMin}" fill="#d9b98a" stroke="var(--ink-faint)" stroke-width="2"/>`;
  for (const cell of grid.cells) {
    if (cell.att === 0) continue;
    const x = GRID.xMin + cell.col * cellW;
    const y = GRID.yMin + cell.row * cellH;
    const ratio = Math.pow(cell.att / maxAtt, 0.6);
    const pct = cell.att ? Math.round((cell.made / cell.att) * 100) : 0;
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${cellH.toFixed(1)}" fill="var(--hot)" opacity="${(ratio * 0.88).toFixed(2)}"><title>${cell.att}회 시도, ${cell.made}회 성공(${pct}%)</title></rect>`;
  }
  svg += drawCourtMarkings(GRID.hoopX, GRID.xMax, -1, "#fff", 1.4);
  svg += drawHoop(GRID.hoopX, GRID.hoopY);
  return svg;
}
