import { supabase } from "./supabase";
import { classifyShot } from "./formIndex";
import { isCornerThree } from "./zoneCompare";
import { computeFinalPlusMinus, type PlayerStartInfo } from "./gameLineups";
import { teamTopPerformer, type GameEvent, type PlayerBox } from "./postgameReport";
import type { ScheduleGame, SeasonStats } from "./matchups";

// 요청 항목 1~7("직전 경기 활약 선수 주의/직전 경기 수비 약점/조합 시너지/최근 추세/오펜스
// 리바운드·블록/코트사이드 최종 승률/경기 후 예측 정확도 채점") - 이 파일이 "구조화된 데이터로
// 만들라"(page.tsx가 그대로 문자열로 렌더하는 대신, 경기 후 같은 값을 다시 참조해 채점할 수
// 있게)는 요구를 만족시키는 핵심. app/games/[gmkey]/page.tsx가 이미 갖고 있는 데이터(최근
// 일정·시즌 스탯)는 그대로 넘겨받고, 이 파일에서만 필요한 것(직전 경기 슛 존 성향, 리그
// 오펜스리바운드 평균, 팀 블록 리더)만 새로 조회.
//
// 데이터 정직성 원칙(이 세션 전체에서 이미 확립 - lib/shotImpactChart.ts의 FTr 프록시,
// lib/possessionFeed.ts의 reliability-gated 상관관계와 동일한 태도): 이 데이터셋엔 실제
// 온볼 수비 매치업/슛클락/포제션 타입 구분이 없음. weak_defender는 "수비가 나빴다"를 직접
// 증명하는 게 아니라 +/-(그 선수 출전 중 팀 득실차)라는 프록시일 뿐이고, reason 문구에서
// 항상 그렇게 캡션함. 표본이 얇거나(예: 직전 경기가 없는 시즌 첫 경기) 특정 팀이 그 지표에서
// 딱히 두드러지지 않으면, 그 인사이트는 자리만 비워두지 않고 아예 생성하지 않음(스킵).

export type PreviewInsight =
  | {
      kind: "watch_player";
      team: "home" | "away"; // 이 선수가 소속된 팀(= 상대팀이 주의해야 할 대상)
      pcode: string;
      name: string;
      reason: string;
      statLine: string;
      isCornerThreeTendency: boolean;
    }
  | {
      kind: "weak_defender";
      theirTeam: "home" | "away"; // 수비 약점이 발견된(+/- 최저) 선수의 팀
      theirPcode: string;
      theirName: string;
      theirPlusMinus: number;
      theirMinutesPlayed: number;
      ourTargetPcode: string; // 상대팀(theirTeam의 반대편)에서 이 약점을 노릴 만한 선수
      ourTargetName: string;
      ourTargetUsage: number;
      reason: string;
    }
  | {
      kind: "combo_synergy";
      team: "home" | "away";
      pcodes: string[];
      names: string[];
      pts: number;
      ast: number;
      reb: number;
      sharedSeconds: number;
      gameDate: string;
      priorLabel?: string; // "직전 경기(날짜)" 또는 개막 전 "지난 시즌(25-26) 마지막 경기(날짜)" - 카드 문구용
    }
  | { kind: "trend"; team: "home" | "away"; text: string; wins: number; losses: number; avgMargin: number }
  | { kind: "oreb_watch"; team: "home" | "away"; orebPct: number; leagueAvgOrebPct: number; reason: string }
  | { kind: "block_watch"; team: "home" | "away"; pcode: string; name: string; blkPg: number; reason: string }
  | { kind: "win_prob"; homeProb: number; awayProb: number };

// 직전 경기 한 판 전체(양 팀) - app/games/[gmkey]/page.tsx가 "이 경기" 자체를 위해 이미 쓰는
// getPlayerStats(gmkey)/getEvents(gmkey) 결과를 그대로 재사용해(같은 매핑 규칙으로) 만들어
// 넘겨줌. 이 파일에서 새로 쿼리하지 않음(스펙 요구 - "이미 있는 쿼리 함수 재사용").
export type PriorGameData = {
  gmkey: string;
  gameDate: string;
  seasonName?: string; // 이 직전 경기가 열린 시즌 - 지금 보는 경기와 다르면(개막 전) 문구에 명시
  homeTcode: string; // 이 직전 경기 자체의 홈팀(지금 보고 있는 이 경기의 홈/원정과는 다른 개념)
  awayTcode: string;
  box: PlayerBox[];
  events: GameEvent[]; // attachDerivedFields 적용된 상태
  players: PlayerStartInfo[];
  minutesByPcode: Map<string, number>;
  usageByPcode: Map<string, number>;
};

// ---------------------------------------------------------------------------
// 임계값(전부 문서화 - 검증 리포트에 그대로 인용) - "your call, document it" 요구 반영.
// ---------------------------------------------------------------------------
const MIN_SHOTS_FOR_ZONE_SAMPLE = 5; // 이보다 적으면 존 성향 자체를 언급하지 않음
const CORNER_THREE_MIN_ATTEMPTS = 2;
const CORNER_THREE_MIN_SHARE_OF_THREES = 0.4; // 3점 시도의 40%+ 가 코너면 "코너 3점 조심"으로 특정
const MIN_MINUTES_FOR_WEAK_DEFENDER = 15; // 이보다 적게 뛴 선수의 +/-는 가비지타임 노이즈로 취급해 제외
const MIN_COMBO_SECONDS_TOGETHER = 120; // 2분 미만 동반 출전은 표본 부족으로 제외
const MIN_COMBO_TOTAL_STAT = 15; // 합산 PTS+AST+REB가 이보다 낮으면 "주목할 만한 조합"이 아님
const OREB_WATCH_MARGIN_PP = 4; // 리그 평균보다 +4%p 이상일 때만 "오펜스 리바운드 조심"
const OREB_WATCH_MIN_GP = 5;
const BLOCK_WATCH_MIN_BPG = 1.0; // 팀 내 1위라도 경기당 1개 미만이면 "조심할 만큼"은 아니라고 봄
const BLOCK_WATCH_MIN_GP = 5;

const ZONE_LABEL_KO: Record<string, string> = {
  rim: "골밑",
  close: "근거리",
  midShort: "짧은 미드레인지",
  midLong: "롱2(미드~3점 사이)",
  three: "3점",
};

// "직전 경기(날짜)" 라벨 - 개막 전엔 같은 시즌 경기가 아직 없어서 그 직전 경기가 지난 시즌 경기다.
// 그 사실을 문구에 그대로 드러낸다(시즌 중엔 기존 문구 그대로). 게이트 자체(이미 팀을 떠난 선수
// 제외)는 각 빌더가 departed(roster_changes 'out' pcode)로 처리.
function shortSeasonLabel(season: string): string {
  const [a, b] = season.split("-");
  return `${a.slice(2)}-${b.slice(2)}`;
}
function priorGameLabel(priorGame: PriorGameData, seasonName: string): string {
  if (priorGame.seasonName && priorGame.seasonName !== seasonName) {
    return `지난 시즌(${shortSeasonLabel(priorGame.seasonName)}) 마지막 경기(${priorGame.gameDate})`;
  }
  return `직전 경기(${priorGame.gameDate})`;
}

// ---------------------------------------------------------------------------
// Insight 1: watch_player - 직전 경기 스포트라이트(gameScore 기준, postgameReport.ts의
// teamTopPerformer 재사용 - "highest PTS보다 완전한 활약도 지표 있으면 그걸 우선"이라는
// 스펙 요구 반영) + 슛 존 성향(코너 3 우선, 아니면 실제 최다 구역을 정직하게).
// ---------------------------------------------------------------------------
async function getPlayerShotsForGame(gmkey: string, pcode: string) {
  const { data } = await supabase.from("shot_log").select("x, y, d, made").eq("gmkey", gmkey).eq("pcode", pcode);
  return (data ?? []) as { x: number; y: number; d: string; made: boolean }[];
}

// 한 경기 표본이 너무 얇을 때(스펙: "or fall back to season shot_log if the one game's sample
// is too thin") - 이 경기 시점 이전 이 시즌 전체 슛으로 대체. shot_log엔 season_name이 없어서
// games!inner로 조인(lib/formIndex.ts의 getFormIndexLeaderboard가 이미 쓰는 것과 같은 패턴).
async function getPlayerSeasonShots(pcode: string, seasonName: string, beforeDate: string) {
  const { data } = await supabase
    .from("shot_log")
    .select("x, y, d, made, games!inner(season_name, game_date)")
    .eq("pcode", pcode)
    .eq("games.season_name", seasonName)
    .lte("games.game_date", beforeDate);
  return ((data ?? []) as unknown as { x: number; y: number; d: string; made: boolean }[]) ?? [];
}

function buildShotTendencyNote(
  shots: { x: number; y: number; d: string; made: boolean }[]
): { text: string; isCorner: boolean } | null {
  if (shots.length < MIN_SHOTS_FOR_ZONE_SAMPLE) return null;

  const threeAtt = shots.filter((s) => classifyShot(s.x, s.y, s.d).zone === "three");
  const cornerAtt = shots.filter((s) => isCornerThree(s.x, s.y, s.d));
  if (
    threeAtt.length > 0 &&
    cornerAtt.length >= CORNER_THREE_MIN_ATTEMPTS &&
    cornerAtt.length / threeAtt.length >= CORNER_THREE_MIN_SHARE_OF_THREES
  ) {
    const made = cornerAtt.filter((s) => s.made).length;
    return {
      text: `코너 3점 비중이 높음(3점 시도 ${threeAtt.length}개 중 ${cornerAtt.length}개가 코너, ${made}/${cornerAtt.length} 성공) - 코너 3점을 특히 조심.`,
      isCorner: true,
    };
  }

  const zoneCounts = new Map<string, number>();
  for (const s of shots) {
    const { zone } = classifyShot(s.x, s.y, s.d);
    zoneCounts.set(zone, (zoneCounts.get(zone) ?? 0) + 1);
  }
  let bestZone = "",
    bestCount = -1;
  for (const [z, c] of zoneCounts) {
    if (c > bestCount) {
      bestZone = z;
      bestCount = c;
    }
  }
  if (!bestZone || bestCount <= 0) return null;
  const pct = Math.round((bestCount / shots.length) * 100);
  return { text: `${ZONE_LABEL_KO[bestZone] ?? bestZone} 슛 비중이 높음(전체 ${shots.length}개 중 ${bestCount}개, ${pct}%).`, isCorner: false };
}

async function buildWatchPlayerInsight(
  team: "home" | "away",
  theirTcode: string,
  priorGame: PriorGameData | null,
  seasonName: string,
  gameDate: string,
  departed?: Set<string>
): Promise<PreviewInsight | null> {
  if (!priorGame) return null;
  // 개막 전: 직전 경기가 지난 시즌 경기라 이미 팀을 떠난 선수가 "막아야 할 선수"로 뽑힌다(실측 -
  // 26-27 예정 경기 프리뷰가 25-26 소속 기준). 떠난 선수는 후보에서 빼고 남은 선수 중 최고 활약.
  const box = departed?.size ? priorGame.box.filter((b) => !departed.has(b.pcode)) : priorGame.box;
  const standout = teamTopPerformer(box, theirTcode);
  if (!standout) return null;

  const statLine = `${standout.pts}점 (FG ${standout.fgm}/${standout.fga}) ${standout.reb}REB ${standout.ast}AST ${standout.stl}STL ${standout.blk}BLK`;

  let shots = await getPlayerShotsForGame(priorGame.gmkey, standout.pcode);
  let usedSeasonFallback = false;
  if (shots.length < MIN_SHOTS_FOR_ZONE_SAMPLE) {
    shots = await getPlayerSeasonShots(standout.pcode, seasonName, gameDate);
    usedSeasonFallback = true;
  }
  const tendency = buildShotTendencyNote(shots);

  const reason =
    `${priorGameLabel(priorGame, seasonName)} 게임스코어 기준 팀 내 최고 활약` +
    (tendency ? ` - ${tendency.text}${usedSeasonFallback ? "(표본은 시즌 누적 슛 기준)" : ""}` : "");

  return {
    kind: "watch_player",
    team,
    pcode: standout.pcode,
    name: standout.name,
    reason,
    statLine,
    isCornerThreeTendency: tendency?.isCorner ?? false,
  };
}

// ---------------------------------------------------------------------------
// Insight 2: weak_defender - 직전 경기 +/- 최저(실측 minutes 필터 적용) 프록시 + 우리 팀
// 직전 경기 usage_rtg 최고 선수를 대응 타깃으로.
// ---------------------------------------------------------------------------
function buildWeakDefenderInsight(
  theirTeam: "home" | "away",
  theirTcode: string,
  theirPriorGame: PriorGameData | null,
  ourPriorGame: PriorGameData | null,
  ourTcode: string,
  seasonName: string,
  theirDeparted?: Set<string>,
  ourDeparted?: Set<string>
): PreviewInsight | null {
  if (!theirPriorGame) return null;

  const pm = computeFinalPlusMinus(theirPriorGame.events, theirPriorGame.players, theirPriorGame.homeTcode, theirPriorGame.awayTcode);
  let worst: { pcode: string; value: number } | null = null;
  for (const p of theirPriorGame.players) {
    if (p.tcode !== theirTcode || theirDeparted?.has(p.pcode)) continue;
    const minutes = theirPriorGame.minutesByPcode.get(p.pcode) ?? 0;
    if (minutes < MIN_MINUTES_FOR_WEAK_DEFENDER) continue;
    const value = pm.get(p.pcode) ?? 0;
    if (!worst || value < worst.value) worst = { pcode: p.pcode, value };
  }
  // 실측이 양수/0이면 "수비가 약했다"고 부를 근거가 없음 - 스킵.
  if (!worst || worst.value >= 0) return null;

  const theirName = theirPriorGame.box.find((b) => b.pcode === worst!.pcode)?.name ?? worst.pcode;
  const theirMinutes = theirPriorGame.minutesByPcode.get(worst.pcode) ?? 0;

  if (!ourPriorGame) return null;
  let ourTarget: { pcode: string; name: string; usage: number } | null = null;
  for (const p of ourPriorGame.players) {
    if (p.tcode !== ourTcode || ourDeparted?.has(p.pcode)) continue;
    // usage_rtg는 출전시간이 짧을수록 폭주한다(실측: 12초 뛴 가비지타임 선수가 264.1로 1위).
    // "이 약점을 노릴 우리 선수"로 그런 선수를 지목하면 인사이트가 통째로 무의미해지므로,
    // 상대 쪽 약점 판정과 같은 출전시간 하한(MIN_MINUTES_FOR_WEAK_DEFENDER)을 여기도 적용.
    if ((ourPriorGame.minutesByPcode.get(p.pcode) ?? 0) < MIN_MINUTES_FOR_WEAK_DEFENDER) continue;
    const usage = ourPriorGame.usageByPcode.get(p.pcode) ?? 0;
    if (!ourTarget || usage > ourTarget.usage) {
      ourTarget = { pcode: p.pcode, name: ourPriorGame.box.find((b) => b.pcode === p.pcode)?.name ?? p.pcode, usage };
    }
  }
  if (!ourTarget) return null;

  const reason =
    `${theirName} ${priorGameLabel(theirPriorGame, seasonName)} +/- ${worst.value > 0 ? "+" : ""}${worst.value} ` +
    `(${theirMinutes.toFixed(0)}분 출전) - 팀이 이 선수 출전 중 열세였음(직접적인 수비 기록이 아니라 온코트 득실차 프록시).`;

  return {
    kind: "weak_defender",
    theirTeam,
    theirPcode: worst.pcode,
    theirName,
    theirPlusMinus: worst.value,
    theirMinutesPlayed: theirMinutes,
    ourTargetPcode: ourTarget.pcode,
    ourTargetName: ourTarget.name,
    ourTargetUsage: ourTarget.usage,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Insight 3: combo_synergy - 이 경기(하나) 전용 라인업 스틴트 추적 + 부분조합(2~4인) 집계.
// lib/lineupNetRating.ts의 lineup_combo(커리어 전체 사전 집계)와는 목적이 다름 - 이 함수는
// "이 한 경기"에서 실제로 함께 뛴 시간 동안 그 조합원들이 직접 만든 PTS/AST/REB만 합산.
// ---------------------------------------------------------------------------
type Stint = { onCourt: string[]; startIdx: number; endIdx: number };

function buildLineupStints(events: GameEvent[], players: PlayerStartInfo[], tcode: string): Stint[] {
  const onCourt = new Set(players.filter((p) => p.tcode === tcode && p.isStarter).map((p) => p.pcode));
  const stints: Stint[] = [];
  let stintStart = 0;
  for (let i = 0; i < events.length; i++) {
    const row = events[i];
    if (row.tcode !== tcode || !row.pcode) continue;
    if (row.action_code !== "101" && row.action_code !== "102") continue;
    if (i - 1 >= stintStart) stints.push({ onCourt: Array.from(onCourt), startIdx: stintStart, endIdx: i - 1 });
    if (row.action_code === "101") onCourt.add(row.pcode);
    else onCourt.delete(row.pcode);
    stintStart = i;
  }
  if (stintStart <= events.length - 1) stints.push({ onCourt: Array.from(onCourt), startIdx: stintStart, endIdx: events.length - 1 });
  return stints.filter((s) => s.onCourt.length >= 2);
}

const POINT_VALUE_BY_ACTION: Record<string, number> = { "201": 2, "203": 1, "205": 3, "207": 2 };

function personalStatsInRange(events: GameEvent[], startIdx: number, endIdx: number, tcode: string) {
  const m = new Map<string, { pts: number; ast: number; reb: number }>();
  for (let i = startIdx; i <= endIdx; i++) {
    const row = events[i];
    if (row.tcode !== tcode || !row.pcode || !row.action_code) continue;
    const cur = m.get(row.pcode) ?? { pts: 0, ast: 0, reb: 0 };
    if (POINT_VALUE_BY_ACTION[row.action_code] != null) cur.pts += POINT_VALUE_BY_ACTION[row.action_code];
    else if (row.action_code === "211") cur.ast += 1;
    else if (row.action_code === "209" || row.action_code === "210") cur.reb += 1;
    m.set(row.pcode, cur);
  }
  return m;
}

function combinationsN<T>(arr: T[], n: number): T[][] {
  if (n === 0) return [[]];
  if (arr.length < n) return [];
  const [first, ...rest] = arr;
  const withFirst = combinationsN(rest, n - 1).map((c) => [first, ...c]);
  return [...withFirst, ...combinationsN(rest, n)];
}

export type ComboTotal = { pcodes: string[]; pts: number; ast: number; reb: number; seconds: number };

// export - 경기 후 채점(gradeMatchupInsights)이 "이 경기 실제로는 이 조합이 몇 점을 합작했는지"를
// 같은 방식으로 재계산해 비교하는 데도 재사용(프리뷰 때와 채점 때 서로 다른 로직을 쓰면 그 자체로
// 부정직한 비교가 되므로 반드시 하나의 함수만).
export function computeComboTotals(events: GameEvent[], players: PlayerStartInfo[], tcode: string): Map<string, ComboTotal> {
  const stints = buildLineupStints(events, players, tcode);
  const totals = new Map<string, ComboTotal>();
  for (const stint of stints) {
    const personal = personalStatsInRange(events, stint.startIdx, stint.endIdx, tcode);
    const duration = Math.max(0, events[stint.endIdx].elapsed - events[stint.startIdx].elapsed);
    const sorted = [...stint.onCourt].sort();
    for (let n = 2; n <= Math.min(4, sorted.length); n++) {
      for (const combo of combinationsN(sorted, n)) {
        const key = combo.join(",");
        const agg = totals.get(key) ?? { pcodes: combo, pts: 0, ast: 0, reb: 0, seconds: 0 };
        for (const pcode of combo) {
          const s = personal.get(pcode);
          if (s) {
            agg.pts += s.pts;
            agg.ast += s.ast;
            agg.reb += s.reb;
          }
        }
        agg.seconds += duration;
        totals.set(key, agg);
      }
    }
  }
  return totals;
}

function buildComboSynergyInsight(
  team: "home" | "away",
  tcode: string,
  priorGame: PriorGameData | null,
  seasonName: string,
  departed?: Set<string>
): PreviewInsight | null {
  if (!priorGame) return null;
  const totals = computeComboTotals(priorGame.events, priorGame.players, tcode);

  // 사이즈(2/3/4인)별 최고 조합 중, "인당 생산성"(합산 PTS+AST+REB ÷ 인원수)이 가장 높은
  // 규모를 채택 - 단순히 인원이 많아서 총합이 큰 조합이 자동으로 뽑히지 않도록.
  let best: { agg: ComboTotal } | null = null;
  let bestPerPlayer = -1;
  for (const agg of totals.values()) {
    if (departed?.size && agg.pcodes.some((p) => departed.has(p))) continue; // 떠난 선수가 낀 조합은 이번 시즌엔 재현 불가
    if (agg.seconds < MIN_COMBO_SECONDS_TOGETHER) continue;
    const total = agg.pts + agg.ast + agg.reb;
    if (total < MIN_COMBO_TOTAL_STAT) continue;
    const perPlayer = total / agg.pcodes.length;
    if (perPlayer > bestPerPlayer) {
      bestPerPlayer = perPlayer;
      best = { agg };
    }
  }
  if (!best) return null;

  const nameByPcode = new Map(priorGame.box.map((b) => [b.pcode, b.name]));
  const names = best.agg.pcodes.map((p) => nameByPcode.get(p) ?? p);
  return {
    kind: "combo_synergy",
    team,
    pcodes: best.agg.pcodes,
    names,
    pts: best.agg.pts,
    ast: best.agg.ast,
    reb: best.agg.reb,
    sharedSeconds: best.agg.seconds,
    gameDate: priorGame.gameDate,
    priorLabel: priorGameLabel(priorGame, seasonName),
  };
}

// ---------------------------------------------------------------------------
// Insight 4: trend - getRecentSchedule(이미 fetch된 것) 기반 단순 W-L/평균 마진.
// ---------------------------------------------------------------------------
function buildTrendInsight(team: "home" | "away", schedule: ScheduleGame[], seasonName?: string): PreviewInsight | null {
  if (!schedule.length) return null;
  // 개막 전엔 "최근 N경기"가 전부 지난 시즌 경기 - 이번 시즌 성적처럼 읽히지 않도록 문구에 명시.
  // schedule[0](가장 최근 경기) 하나만 보면 안 된다: 개막 직후엔 이번 시즌 1~2경기 + 지난 시즌
  // 3~4경기가 섞인 창이 되는데, 그때 schedule[0]은 이번 시즌이라 라벨이 "최근"으로 돌아가면서
  // 지난 시즌 경기까지 이번 시즌 성적인 것처럼 읽힌다(실측 지적).
  const priorSeasons = seasonName == null ? [] : [...new Set(schedule.map((g) => g.seasonName).filter((s): s is string => s != null && s !== seasonName))];
  const allPrior = priorSeasons.length > 0 && schedule.every((g) => g.seasonName != null && g.seasonName !== seasonName);
  const scope = allPrior
    ? `지난 시즌(${shortSeasonLabel(priorSeasons[0])}) 마지막`
    : priorSeasons.length > 0
      ? `지난 시즌(${shortSeasonLabel(priorSeasons[0])}) 경기를 포함한 최근`
      : "최근";
  const wins = schedule.filter((g) => g.teamScore > g.oppScore).length;
  const losses = schedule.length - wins;
  const avgMargin = schedule.reduce((s, g) => s + (g.teamScore - g.oppScore), 0) / schedule.length;
  const rounded = Math.round(avgMargin * 10) / 10;
  const text = `${scope} ${schedule.length}경기 ${wins}승 ${losses}패, 평균 마진 ${rounded >= 0 ? "+" : ""}${rounded.toFixed(1)}점.`;
  return { kind: "trend", team, text, wins, losses, avgMargin: rounded };
}

// ---------------------------------------------------------------------------
// Insight 5a: oreb_watch - 시즌 평균 oreb_pct가 리그 평균보다 뚜렷이(OREB_WATCH_MARGIN_PP
// 이상) 높을 때만.
// ---------------------------------------------------------------------------
function buildOrebWatchInsight(team: "home" | "away", seasonStats: SeasonStats | null, leagueAvgOrebPct: number | null): PreviewInsight | null {
  if (!seasonStats || leagueAvgOrebPct == null) return null;
  if (seasonStats.gp < OREB_WATCH_MIN_GP) return null;
  const diff = seasonStats.orebPct - leagueAvgOrebPct;
  if (diff < OREB_WATCH_MARGIN_PP) return null;
  const reason =
    `시즌 평균 공격리바운드율 ${seasonStats.orebPct.toFixed(1)}%(리그 평균 ${leagueAvgOrebPct.toFixed(1)}%보다 ${diff.toFixed(1)}%p 높음, ` +
    `${seasonStats.gp}경기 기준) - 오펜스 리바운드로 인한 세컨찬스 득점을 조심.`;
  return { kind: "oreb_watch", team, orebPct: seasonStats.orebPct, leagueAvgOrebPct, reason };
}

// ---------------------------------------------------------------------------
// Insight 5b: block_watch - 팀 season 블록 리더(최소 경기수/블록 기준 충족 시만).
// ---------------------------------------------------------------------------
async function getSeasonBlockLeader(
  tcode: string,
  seasonName: string,
  beforeDate: string,
  departed?: Set<string>
): Promise<{ pcode: string; name: string; blkPg: number; gp: number } | null> {
  const { data: games } = await supabase
    .from("games")
    .select("gmkey")
    .eq("season_name", seasonName)
    .eq("season_category", "정규시즌")
    .lt("game_date", beforeDate)
    .or(`home_tcode.eq.${tcode},away_tcode.eq.${tcode}`)
    .not("home_score", "is", null);
  if (!games || !games.length) return null;
  const gmkeys = games.map((g) => g.gmkey);

  const { data: stats } = await supabase
    .from("game_player_stats")
    .select("pcode, blk, player:players(name)")
    .eq("tcode", tcode)
    .in("gmkey", gmkeys);
  if (!stats || !stats.length) return null;

  const agg = new Map<string, { blkSum: number; gp: number; name: string }>();
  for (const r of stats as unknown as { pcode: string; blk: number | null; player: { name: string } | null }[]) {
    const cur = agg.get(r.pcode) ?? { blkSum: 0, gp: 0, name: r.player?.name ?? r.pcode };
    cur.blkSum += r.blk ?? 0;
    cur.gp += 1;
    agg.set(r.pcode, cur);
  }
  let best: { pcode: string; name: string; blkPg: number; gp: number } | null = null;
  for (const [pcode, a] of agg) {
    if (departed?.has(pcode)) continue;
    const blkPg = a.blkSum / a.gp;
    if (!best || blkPg > best.blkPg) best = { pcode, name: a.name, blkPg, gp: a.gp };
  }
  return best;
}

async function buildBlockWatchInsight(
  team: "home" | "away",
  tcode: string,
  seasonName: string,
  beforeDate: string,
  departed?: Set<string>
): Promise<PreviewInsight | null> {
  const leader = await getSeasonBlockLeader(tcode, seasonName, beforeDate, departed);
  if (!leader || leader.gp < BLOCK_WATCH_MIN_GP || leader.blkPg < BLOCK_WATCH_MIN_BPG) return null;
  const reason = `시즌 평균 ${leader.blkPg.toFixed(1)}블록/경기로 팀 내 1위(${leader.gp}경기 기준) - 골밑 시도 때 이 선수의 블록을 조심.`;
  return { kind: "block_watch", team, pcode: leader.pcode, name: leader.name, blkPg: leader.blkPg, reason };
}

// ---------------------------------------------------------------------------
// Insight 6: win_prob - 이 페이지가 이미 쓰는 승률(derivedEvents[0].home_win_prob, GameReplay의
// 스코어보드/postgameReport의 preActPct와 동일한 값)을 그대로 재사용 - 별도로 재계산하지 않음.
// ---------------------------------------------------------------------------
function buildWinProbInsight(homeWinProb: number | null): PreviewInsight | null {
  if (homeWinProb == null) return null;
  return { kind: "win_prob", homeProb: homeWinProb, awayProb: 1 - homeWinProb };
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------
export type BuildInsightsInput = {
  homeTcode: string;
  awayTcode: string;
  seasonName: string;
  gameDate: string; // 지금 보고 있는 이 경기의 날짜(시즌 폴백 슛 조회의 "이 시점까지" 컷오프)
  homeSchedule: ScheduleGame[];
  awaySchedule: ScheduleGame[];
  homeSeasonStats: SeasonStats | null;
  awaySeasonStats: SeasonStats | null;
  leagueAvgOrebPct: number | null;
  homeWinProb: number | null;
  homePriorGame: PriorGameData | null;
  awayPriorGame: PriorGameData | null;
  // 개막 전 게이트 - roster_changes 'out'(이미 팀을 떠난 선수) pcode. 없으면 게이트 없음(시즌 중 기존 동작).
  homeDeparted?: Set<string>;
  awayDeparted?: Set<string>;
};

export async function buildMatchupInsights(input: BuildInsightsInput): Promise<PreviewInsight[]> {
  const insights: PreviewInsight[] = [];

  const [homeWatch, awayWatch, homeBlock, awayBlock] = await Promise.all([
    buildWatchPlayerInsight("home", input.homeTcode, input.homePriorGame, input.seasonName, input.gameDate, input.homeDeparted),
    buildWatchPlayerInsight("away", input.awayTcode, input.awayPriorGame, input.seasonName, input.gameDate, input.awayDeparted),
    buildBlockWatchInsight("home", input.homeTcode, input.seasonName, input.gameDate, input.homeDeparted),
    buildBlockWatchInsight("away", input.awayTcode, input.seasonName, input.gameDate, input.awayDeparted),
  ]);
  if (homeWatch) insights.push(homeWatch);
  if (awayWatch) insights.push(awayWatch);

  const homeWeak = buildWeakDefenderInsight("home", input.homeTcode, input.homePriorGame, input.awayPriorGame, input.awayTcode, input.seasonName, input.homeDeparted, input.awayDeparted);
  const awayWeak = buildWeakDefenderInsight("away", input.awayTcode, input.awayPriorGame, input.homePriorGame, input.homeTcode, input.seasonName, input.awayDeparted, input.homeDeparted);
  if (homeWeak) insights.push(homeWeak);
  if (awayWeak) insights.push(awayWeak);

  const homeCombo = buildComboSynergyInsight("home", input.homeTcode, input.homePriorGame, input.seasonName, input.homeDeparted);
  const awayCombo = buildComboSynergyInsight("away", input.awayTcode, input.awayPriorGame, input.seasonName, input.awayDeparted);
  if (homeCombo) insights.push(homeCombo);
  if (awayCombo) insights.push(awayCombo);

  const homeTrend = buildTrendInsight("home", input.homeSchedule, input.seasonName);
  const awayTrend = buildTrendInsight("away", input.awaySchedule, input.seasonName);
  if (homeTrend) insights.push(homeTrend);
  if (awayTrend) insights.push(awayTrend);

  const homeOreb = buildOrebWatchInsight("home", input.homeSeasonStats, input.leagueAvgOrebPct);
  const awayOreb = buildOrebWatchInsight("away", input.awaySeasonStats, input.leagueAvgOrebPct);
  if (homeOreb) insights.push(homeOreb);
  if (awayOreb) insights.push(awayOreb);
  if (homeBlock) insights.push(homeBlock);
  if (awayBlock) insights.push(awayBlock);

  const winProb = buildWinProbInsight(input.homeWinProb);
  if (winProb) insights.push(winProb);

  return insights;
}

// ---------------------------------------------------------------------------
// 경기 후 채점(요청 항목 7) - 프리뷰 때 만든 것과 정확히 같은 선수/팀/조합을 이번 경기의
// 실제 값과 나란히 보여줌("예측이 맞았다/틀렸다"를 억지로 자동 판정하지 않고, win_prob만
// 명확한 적중/빗나감이 있고 나머지는 predicted-vs-actual을 그대로 노출해 독자가 판단하게 -
// 스펙이 명시한 이 프로젝트의 정직성 원칙과 동일).
// ---------------------------------------------------------------------------
export type GradingContext = {
  box: PlayerBox[]; // 이 경기(지금 보고 있는 경기) 최종 박스스코어, 양 팀
  events: GameEvent[]; // 이 경기 attachDerivedFields 적용된 이벤트, 양 팀
  players: PlayerStartInfo[]; // 이 경기 로스터(pcode/tcode/isStarter), 양 팀
  homeTcode: string;
  awayTcode: string;
  homeScore: number;
  awayScore: number;
  homeTname: string;
  awayTname: string;
};

export function gradeMatchupInsights(insights: PreviewInsight[], ctx: GradingContext): (string | null)[] {
  const pm = computeFinalPlusMinus(ctx.events, ctx.players, ctx.homeTcode, ctx.awayTcode);
  const homeComboTotals = computeComboTotals(ctx.events, ctx.players, ctx.homeTcode);
  const awayComboTotals = computeComboTotals(ctx.events, ctx.players, ctx.awayTcode);
  let homeOrebActual = 0,
    awayOrebActual = 0;
  for (const e of ctx.events) {
    if (e.action_code !== "209" || !e.tcode) continue;
    if (e.tcode === ctx.homeTcode) homeOrebActual++;
    else if (e.tcode === ctx.awayTcode) awayOrebActual++;
  }
  const boxByPcode = new Map(ctx.box.map((b) => [b.pcode, b]));

  return insights.map((insight): string | null => {
    switch (insight.kind) {
      case "win_prob": {
        const predictedHome = insight.homeProb >= 0.5;
        const actualHomeWon = ctx.homeScore > ctx.awayScore;
        const hit = predictedHome === actualHomeWon;
        const winnerName = actualHomeWon ? ctx.homeTname : ctx.awayTname;
        return `실제 결과 ${winnerName} 승(${ctx.homeScore}-${ctx.awayScore}) - 예측 ${hit ? "적중" : "빗나감"}.`;
      }
      case "watch_player": {
        const p = boxByPcode.get(insight.pcode);
        if (!p) return "이번 경기 미출전(또는 기록 없음).";
        return `이번 경기 실제 ${p.pts}점 (FG ${p.fgm}/${p.fga}) ${p.reb}REB ${p.ast}AST.`;
      }
      case "weak_defender": {
        const theirVal = pm.get(insight.theirPcode);
        const theirP = boxByPcode.get(insight.theirPcode);
        const ourP = boxByPcode.get(insight.ourTargetPcode);
        const theirText = theirP
          ? `이번 경기 +/- ${theirVal != null ? (theirVal > 0 ? "+" : "") + theirVal : "0"}`
          : "이번 경기 미출전";
        const ourText = ourP ? `${insight.ourTargetName} ${ourP.pts}점` : `${insight.ourTargetName} 미출전`;
        return `${theirText} · ${ourText}.`;
      }
      case "combo_synergy": {
        const totals = insight.team === "home" ? homeComboTotals : awayComboTotals;
        const key = [...insight.pcodes].sort().join(",");
        const t = totals.get(key);
        if (!t || t.seconds === 0) return "이번 경기 이 조합은 함께 코트에 서지 않음.";
        return `이번 경기 함께 뛴 동안 ${t.pts}점 ${t.ast}어시 ${t.reb}리바.`;
      }
      case "oreb_watch": {
        const actual = insight.team === "home" ? homeOrebActual : awayOrebActual;
        return `이번 경기 실제 공격리바운드 ${actual}개.`;
      }
      case "block_watch": {
        const p = boxByPcode.get(insight.pcode);
        if (!p) return "이번 경기 미출전.";
        return `이번 경기 실제 블록 ${p.blk}개.`;
      }
      case "trend":
        return null; // 스펙: 추세는 강하게 채점할 대상이 아님 - 참고 정보로만 표시
      default:
        return null;
    }
  });
}
