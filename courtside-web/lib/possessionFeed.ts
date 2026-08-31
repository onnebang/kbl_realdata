import type { GameEvent } from "./postgameReport";
import { COURT_X, COURT_Y, HOOP_LEFT, HOOP_RIGHT, drawCourtMarkings, drawHoop, type ShotRow } from "./zoneCompare";

// courtside_template.html(레퍼런스 아티팩트)의 segmentPossessions/renderGroup/
// buildShotReliability/findShotForScoreRow/drawMiniShotSpot 포팅 - "한 공격(포제션)"
// 단위로 이벤트를 묶어 보여주는 플레이 피드. 순수 로직만 여기 두고(이 파일은 JSX 없음),
// 렌더링은 components/GameReplay.tsx가 담당(이 프로젝트의 lib/zoneCompare.ts +
// GameReplay.tsx 관계와 같은 패턴).

export const MAKE_CODES = new Set(["201", "205", "207"]);
export const MISS_CODES = new Set(["202", "206", "208"]);
export const SCORING_CODES = new Set(["201", "203", "205", "207"]);
export const KEY_FLOW_CODES = new Set(["212", "213", "209"]); // 스틸/블록/공격리바운드
export const KEY_FLOW_TAGS: Record<string, string> = { "212": "STL", "213": "BLK", "209": "OREB" };
const FT_CODES = new Set(["203", "204"]);
const NONPOSSESSION_CODES = new Set(["001", "002", "003", "009", "101", "102"]);
// 블록(213)과 팀 단위 안내성 이벤트(팀속공/팀리바운드/팀파울 등, player 없이 team만 있는
// 기록)는 공수전환을 나타내지 않는 정보성 이벤트라 그룹 소속 team 판정에서 제외.
const TEAM_INFO_CODES = new Set(["213", "217", "218", "221", "223", "225", "226", "227", "228", "229"]);
// 슈팅파울(215)은 파울 이벤트 바로 다음이 아니라 "215 파울자유투 -> 225 팀파울 -> 203/204
// 자유투" 순서로 팀 단위 안내 이벤트가 하나 끼는 게 실제 데이터 패턴이라, 바로 다음줄이
// 아니라 "다음 실질 이벤트"까지 건너뛰어서 확인해야 함(216/224도 보너스 상황이면
// 자유투로 이어질 수 있어 같이 포함).
const SHOOTING_FOUL_CODES = new Set(["215", "216", "224"]);

export type PossessionGroup = { type: "group"; team: string; rows: GameEvent[] };
export type PossessionDivider = { type: "divider"; rows: GameEvent[]; subBurst: boolean };
export type PossessionItem = PossessionGroup | PossessionDivider;

function nextRealEvent(rows: GameEvent[], i: number): GameEvent | null {
  for (let j = i + 1; j < rows.length; j++) {
    if (!TEAM_INFO_CODES.has(rows[j].action_code ?? "")) return rows[j];
  }
  return null;
}

// "두경민의 3점 실패 - 공격 리바운드 - 김주성의 어시 - 유기상의 3점슛"을 한 섹션으로. 팀이
// 바뀌거나(수비리바운드/턴오버 등으로 공수 전환) 직전 그룹이 득점/턴오버로 "닫혔으면" 새
// 섹션을 시작한다. 득점 직후 어시스트가 바로 오면 같은 섹션에 묶임(MAKE에서 바로 안 닫고
// 다음 이벤트가 같은 팀 어시스트인지 먼저 확인한 뒤에 닫음).
export function segmentPossessions(rows: GameEvent[]): PossessionItem[] {
  const groups: PossessionItem[] = [];
  let cur: PossessionGroup | null = null;
  let pendingClose = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.quarter === "PRE") continue;
    const code = row.action_code ?? "";

    if (NONPOSSESSION_CODES.has(code)) {
      // 교체는 한꺼번에 몰려서 나오는 경우가 많아(5명씩 통째로 교체) 개별 줄 대신 하나의
      // "교체 N명" 구분선으로 묶음 - 안 그러면 진짜 플레이 사이에 교체 알림만 잔뜩 낌.
      const isSub = code === "101" || code === "102";
      const lastGroup = groups[groups.length - 1];
      if (isSub && lastGroup && lastGroup.type === "divider" && lastGroup.subBurst) {
        lastGroup.rows.push(row);
      } else {
        groups.push({ type: "divider", rows: [row], subBurst: isSub });
      }
      continue;
    }

    let owner = row.tcode ?? "";
    if (TEAM_INFO_CODES.has(code)) {
      owner = cur ? cur.team : owner; // 정보성 이벤트는 그룹 경계에 영향 안 줌
    } else if (SHOOTING_FOUL_CODES.has(code)) {
      const next = nextRealEvent(rows, i);
      if (next && next.tcode && FT_CODES.has(next.action_code ?? "") && next.tcode !== row.tcode) owner = next.tcode;
    }

    const startNew = !cur || cur.team !== owner || pendingClose;
    if (startNew) {
      cur = { type: "group", team: owner, rows: [] };
      groups.push(cur);
      pendingClose = false;
    }
    cur!.rows.push(row);

    if (MAKE_CODES.has(code) || code === "203") {
      const next = rows[i + 1];
      const assistFollows = !!next && next.action_code === "211" && next.tcode === owner;
      pendingClose = !assistFollows;
    } else if (code === "211" || code === "214") {
      pendingClose = true;
    }
  }
  return groups;
}

// 최근 이 개수만큼의 원본 이벤트를 대상으로 포제션을 나누고, 그중 최근 이 개수의 "실제
// 포제션"만 화면에 보여줌(레퍼런스 아티팩트의 FEED_WINDOW/FEED_MAX_GROUPS 그대로 재사용).
export const FEED_WINDOW = 90;
export const FEED_MAX_GROUPS = 9;

// idx 시점까지의 최근 포제션 목록을 최신순(내림차순)으로 반환.
export function buildRecentFeed(events: GameEvent[], idx: number): PossessionItem[] {
  if (idx <= 0) return [];
  const startIdx = Math.max(0, idx - FEED_WINDOW);
  const windowRows = events.slice(startIdx, idx + 1);
  const segmented = segmentPossessions(windowRows);
  // 마지막 FEED_MAX_GROUPS개의 "실제 포제션"이 반드시 포함되도록 - 교체가 몰리는 구간처럼
  // 구분선(divider)이 연달아 나오면 개수 제한에서 밀려 진짜 플레이가 안 보이는 문제 방지.
  let groupsSeen = 0,
    sliceFrom = 0;
  for (let i = segmented.length - 1; i >= 0; i--) {
    sliceFrom = i;
    if (segmented[i].type === "group") {
      groupsSeen++;
      if (groupsSeen >= FEED_MAX_GROUPS) break;
    }
  }
  return segmented.slice(sliceFrom).reverse();
}

export type ShotWithMeta = ShotRow & { quarter: string; pcode: string | null };

// (선수, 쿼터) 조합별로 문자중계 타임라인의 성공/실패 "개수"와 shot_log의 "개수"를 비교 -
// 정확히 일치할 때만(그리고 0보다 클 때만) 그 조합을 신뢰. 두 로그는 서로 다른 소스라 조인
// 키가 없어서(같은 순서라는 가정이 최선), 카운트가 안 맞는 조합은 순서 매칭 자체가 애초에
// 틀렸다는 뜻 - 확신 있게 틀린 위치를 보여주는 것보다, 못 믿을 조합은 조용히 생략하는 게 낫다.
export function buildShotReliability(events: GameEvent[], shots: ShotWithMeta[]): Map<string, boolean> {
  const tlCounts = new Map<string, number>();
  for (const r of events) {
    if (r.quarter === "PRE" || !r.pcode || !r.action_code) continue;
    if (MAKE_CODES.has(r.action_code) || MISS_CODES.has(r.action_code)) {
      const key = `${r.pcode}|${r.quarter}`;
      tlCounts.set(key, (tlCounts.get(key) ?? 0) + 1);
    }
  }
  const scCounts = new Map<string, number>();
  for (const s of shots) {
    if (!s.pcode) continue;
    const key = `${s.pcode}|${s.quarter}`;
    scCounts.set(key, (scCounts.get(key) ?? 0) + 1);
  }
  const reliable = new Map<string, boolean>();
  const allKeys = new Set<string>([...tlCounts.keys(), ...scCounts.keys()]);
  for (const k of allKeys) {
    const tl = tlCounts.get(k) ?? 0;
    const sc = scCounts.get(k) ?? 0;
    reliable.set(k, tl === sc && tl > 0);
  }
  return reliable;
}

// 신뢰 가능한 (선수,쿼터) 조합에서만, 득점 이벤트가 "이 선수가 이 쿼터에서 몇 번째로
// 시도한 슛인가"(성공+실패 통틀어 ordinal, 1-indexed)를 타임라인 순서로 세서 shot_log의
// 같은 순번 행을 찾음. 자유투(203)는 shot_log에 위치 데이터가 없어 대상에서 제외(호출 전
// endedInScore만 확인하고 넘어오므로 여기서 MAKE_CODES로 다시 걸러냄).
export function findShotForScoreRow(
  events: GameEvent[],
  shots: ShotWithMeta[],
  reliability: Map<string, boolean>,
  scoreRow: GameEvent
): ShotWithMeta | null {
  if (!scoreRow.pcode || !scoreRow.action_code || !MAKE_CODES.has(scoreRow.action_code)) return null;
  const key = `${scoreRow.pcode}|${scoreRow.quarter}`;
  if (!reliability.get(key)) return null;
  const idx = events.indexOf(scoreRow);
  if (idx < 0) return null;
  const shotsInQ = shots.filter((s) => s.pcode === scoreRow.pcode && s.quarter === scoreRow.quarter);
  if (!shotsInQ.length) return null;
  let count = 0;
  for (let i = 0; i <= idx; i++) {
    const r = events[i];
    if (r.pcode === scoreRow.pcode && r.quarter === scoreRow.quarter && r.action_code && (MAKE_CODES.has(r.action_code) || MISS_CODES.has(r.action_code))) {
      count++;
    }
  }
  return shotsInQ[count - 1] ?? null;
}

// shot_log의 d 필드("어느 쪽 골대에 가까운 슛인지")를 이 카드가 보여줄 타겟 골대
// (targetRight)에 맞춰 뒤집음 - zoneCompare.ts의 mirrorShotX(항상 오른쪽 골대 기준으로만
// 미러링)와 달리 여기는 풀코트라 어느 쪽으로도 뒤집을 수 있어야 함.
function normalizeShotX(shot: ShotRow, targetRight: boolean): number {
  const nearRight = shot.d === "1";
  if (targetRight) return nearRight ? shot.x : 750 - shot.x;
  return nearRight ? 750 - shot.x : shot.x;
}

function drawBasketball(x: number, y: number): string {
  let svg = `<circle cx="${x}" cy="${y}" r="18" fill="#e8590c" stroke="#3a2418" stroke-width="1.4"/>`;
  svg += `<path d="M ${x - 18} ${y} H ${x + 18} M ${x} ${y - 18} V ${y + 18}" stroke="#3a2418" stroke-width="1.3"/>`;
  svg += `<path d="M ${x - 13} ${y - 13} Q ${x} ${y} ${x - 13} ${y + 13}" fill="none" stroke="#3a2418" stroke-width="1.1"/>`;
  svg += `<path d="M ${x + 13} ${y - 13} Q ${x} ${y} ${x + 13} ${y + 13}" fill="none" stroke="#3a2418" stroke-width="1.1"/>`;
  return svg;
}

// 득점 포제션 카드 위에 얹는 미니 풀코트 슛맵(양쪽 골대 다 보이는 NBA 중계 그래픽 스타일) -
// GameReplay.tsx가 <svg viewBox="COURT_X[0] COURT_Y[0] ..." dangerouslySetInnerHTML>로
// 감싸는 내부 마크업만 반환(이 파일의 buildCourtDotsSvg류와 같은 컨벤션, 바깥 <svg> 태그는
// 호출부 책임). 성공=농구공 아이콘+휘어 들어가는 궤적, 실패=X 마크. colorHex는 실제 팀
// 컬러(홈/원정 hex) - 이 프로젝트 다른 코트 다이어그램들도 CSS 변수가 아니라 실제 팀 컬러를
// 직접 받는 컨벤션(zoneCompare.ts의 buildCourtDotsSvg 참고).
export function drawMiniShotSpot(shot: ShotWithMeta, targetRight: boolean, colorHex: string, homeLogoUrl: string | null): string {
  const x = normalizeShotX(shot, targetRight);
  const y = shot.y;
  const midX = (COURT_X[0] + COURT_X[1]) / 2,
    midY = (COURT_Y[0] + COURT_Y[1]) / 2;

  let svg = `<rect x="${COURT_X[0]}" y="${COURT_Y[0]}" width="${COURT_X[1] - COURT_X[0]}" height="${COURT_Y[1] - COURT_Y[0]}" fill="#d9b98a" stroke="var(--ink-faint)" stroke-width="2"/>`;
  svg += drawCourtMarkings(HOOP_LEFT[0], COURT_X[0], 1, "#fff", 1.5);
  svg += drawCourtMarkings(HOOP_RIGHT[0], COURT_X[1], -1, "#fff", 1.5);
  svg += `<line x1="${midX}" y1="${COURT_Y[0]}" x2="${midX}" y2="${COURT_Y[1]}" stroke="#fff" stroke-width="1.5" opacity="0.7"/>`;
  svg += `<circle cx="${midX}" cy="${midY}" r="48" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.7"/>`;
  if (homeLogoUrl) {
    svg += `<image href="${homeLogoUrl}" x="${midX - 50}" y="${midY - 50}" width="100" height="100" opacity="0.92"/>`;
  }
  svg += drawHoop(HOOP_LEFT[0], HOOP_LEFT[1], true);
  svg += drawHoop(HOOP_RIGHT[0], HOOP_RIGHT[1], false);

  if (shot.made) {
    const hoop = targetRight ? HOOP_RIGHT : HOOP_LEFT;
    // 골밑슛처럼 거리가 짧아도 궤적이 보이도록 최소 높이를 보장하고, 거리가 늘어날수록
    // 완만하게 커지도록(상한도 둬서 너무 과장 안 함).
    const shotDist = Math.hypot(x - hoop[0], y - hoop[1]);
    const arcHeight = Math.max(40, Math.min(75, shotDist * 0.55 + 30));
    const controlY = Math.min(y, hoop[1]) - arcHeight;
    const controlX = (x + hoop[0]) / 2;
    svg += `<path d="M ${x} ${y} Q ${controlX} ${controlY} ${hoop[0]} ${hoop[1]}" fill="none" stroke="${colorHex}" stroke-width="3" stroke-dasharray="5,3.5" opacity="0.9" stroke-linecap="round"/>`;
    svg += drawBasketball(x, y);
  } else {
    svg += `<line x1="${x - 12}" y1="${y - 12}" x2="${x + 12}" y2="${y + 12}" stroke="${colorHex}" stroke-width="3.5"/>`;
    svg += `<line x1="${x - 12}" y1="${y + 12}" x2="${x + 12}" y2="${y - 12}" stroke="${colorHex}" stroke-width="3.5"/>`;
  }
  return svg;
}
