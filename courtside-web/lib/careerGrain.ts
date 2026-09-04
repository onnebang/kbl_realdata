import { supabase } from "./supabase";
import { getPlayerCareerGames, type CareerGameRow } from "./playerProfile";
import { buildSeasonAxis, seasonStartYear, PLAYOFF_CATEGORY } from "./playerPageData";

// 커리어 결 띠(career grain strip) 데이터 레이어 - 히어로 발치에 커리어 전체를 가로 띠 하나로
// 그리기 위한 "밤(night)의 시간순 목록". 칸 하나 = 하루 한 경기.
//
// 왜 슛이 아니라 경기인가(실측, 2026-09-04): 26-27 확정 명단 198명 중 커리어 기록이 있는 선수는
// 198/198이지만, 히어로의 슛 밀도장이 요구하는 60슛을 넘는 선수는 151명뿐이다(1,500슛 이상은 54명,
// 중앙값 396슛). 즉 슛 기반 그림은 명단의 1/4에서 깨진다. 경기 기록은 전원에게 있으므로 이 띠는
// 누구의 페이지에서도 그려진다. 성공 기준은 워니(373경기)가 아니라 중앙값 119경기 선수다.
//
// ── 결장(absent)의 정의 - 이 기능의 핵심 ────────────────────────────────────────────────
// 빈 칸은 반드시 "그의 팀이 뛴 날 그가 뛰지 않았다"만 뜻해야 한다. "아직 그 팀 소속이 아니었다"나
// "이미 떠났다"를 결장으로 그리면 그림 전체가 거짓이 된다. 그래서 (pcode, tcode, season)마다
// 등록 창(registration window) = [그 팀에서의 첫 출전일 .. 마지막 출전일]을 잡고, 그 창 안에 있는
// 그 팀의 경기만 결장 후보로 센다. 창 밖 경기는 칸 자체를 만들지 않는다.
//
// 실측(2025-2026 시즌, 2026-09-04):
//   선수-팀 행 204개. 창을 안 자르면 행당 평균 결장 23.29칸, 자르면 7.28칸 - 자르지 않은 "결장"의
//   약 2/3가 가짜다. 204행 중 120행이 부분 창(자르면 값이 달라지는 행)이고, 자른 뒤에도 결장이
//   10칸 이상인 행이 55개, 한 행의 최대 결장은 44칸.
// 이건 캡션으로 덮을 문제가 아니라 정의의 문제라, 정의를 자른 쪽으로 구현하고 캡션이 그걸 설명한다.
//
// 결장의 원인은 이 DB에 없다(부상 데이터 없음). 화면 문구는 '결장'까지만 - '부상'은 쓰지 않는다.
//
// ── 주의: 0분 출전(DNP) 행 ──────────────────────────────────────────────────────────────
// game_player_stats에는 명단에는 들었지만 0분인 행이 있다(playerProfile.ts 주석, 25-26 6,792행 중
// 654행). 위 실측 수치는 전부 "행이 있으면 played"로 잰 값이라 여기서도 같은 기준을 쓴다 - 0분 밤은
// kind:'played' + pts 0 + min 0이고, 구분이 필요한 화면은 night.min === 0으로 직접 거른다
// (grain.dnpCount로도 준다).

export type CareerNightKind = "played" | "absent";

type NightBase = {
  /** YYYY-MM-DD (KST 날짜 문자열 그대로 - 시간대 변환 없음). */
  date: string;
  seasonName: string;
  /** 그날 그가 등록돼 있던 팀. 이적하면 띠 중간에서 색이 바뀐다. */
  tcode: string;
  /** played/absent 모두 채워진다(absent도 "그 팀이 치른 그 경기"가 특정되므로). */
  gmkey: string;
  isPlayoff: boolean;
  oppTcode: string;
  /** 종료 경기만 담으므로 실제로는 항상 숫자(검증: is_ended 경기 중 점수 null 0건). */
  teamScore: number | null;
  oppScore: number | null;
  /** 무승부 없음(검증 0건). */
  won: boolean | null;
  isHome: boolean;
};

/**
 * 커리어의 하루. kind로 좁히면 played 쪽에서만 pts/min/reb/ast가 number다.
 * (브리프의 `pts?` 등은 유니온 전체에서 `number | undefined`로 그대로 성립한다.)
 */
export type CareerNight =
  | (NightBase & {
      kind: "played";
      pts: number;
      min: number;
      reb: number;
      ast: number;
      isStarter: boolean | null;
    })
  | (NightBase & {
      kind: "absent";
      pts?: undefined;
      min?: undefined;
      reb?: undefined;
      ast?: undefined;
      isStarter?: undefined;
    });

/** 띠 위의 시즌 구간(경계 헤어라인과 연도 라벨의 위치). start/end 모두 nights의 포함 인덱스. */
export type CareerGrainSeason = {
  seasonName: string;
  startIndex: number;
  endIndex: number;
  /** 그 시즌 소속 팀(그 시즌 첫 밤 순서). 2개면 시즌 중 이적. */
  tcodes: string[];
  played: number;
  absent: number;
};

/** (pcode, tcode, season)의 등록 창 - 결장을 자른 근거를 그대로 노출(캡션·검산용). */
export type RegistrationWindow = {
  seasonName: string;
  tcode: string;
  /** 그 팀에서의 첫 출전일 / 마지막 출전일. */
  firstDate: string;
  lastDate: string;
  played: number;
  /** 창 안에서의 결장(= 실제로 띠에 그려지는 빈 칸 수). */
  absent: number;
  /**
   * 이 창을 자르지 않았다면 나왔을 결장 수(창 단위 근거). 창이 겹치는 시즌에서 두 창의 맞대결은
   * 양쪽에 한 번씩 들어가므로, 이 값들의 단순 합은 칸 수가 아니다 - 칸 수는
   * CareerGrain.absenceUnclippedCount(gmkey 중복 제거)를 쓴다.
   */
  absentUnclipped: number;
  /** 그 팀이 그 시즌 치른 종료 경기 수. */
  teamGames: number;
};

export type CareerGrain = {
  pcode: string;
  /** 날짜(같으면 gmkey) 오름차순 - 띠의 왼쪽부터 오른쪽 순서 그대로. */
  nights: CareerNight[];
  seasons: CareerGrainSeason[];
  firstDate: string | null;
  lastDate: string | null;
  playedCount: number;
  absenceCount: number;
  /**
   * 커리어 첫 시즌과 마지막으로 알려진 시즌 사이에서 출전이 0인 시즌.
   * 칸으로 그리지 않는다 - 띠는 여기서 라벨 붙은 끊김을 그린다.
   * 리그가 한 경기도 치르지 않은 시즌(26-27)은 공백으로 세지 않는다.
   */
  gapSeasons: string[];
  /** 칸 높이 정규화의 분모. 출전이 없으면 0. */
  maxPts: number;
  /** 커리어에 등장한 팀(첫 등장 순). 색 팔레트를 미리 만들 때 쓴다. */
  teams: string[];
  /** 총 칸 수 = playedCount + absenceCount(SVG 폭 계산). */
  cellCount: number;
  /** played 중 0분(DNP) 밤 수 - "출전"만 세고 싶은 캡션용. */
  dnpCount: number;
  /** 연속된 결장 칸의 최대 길이. */
  maxAbsenceRun: number;
  /** 결장을 자른 근거(창) 목록 - 시즌·팀 순. */
  windows: RegistrationWindow[];
  /**
   * 창을 자르지 않았을 때의 총 결장 '칸' 수(캡션 "가짜 결장 N칸을 뺐다"의 근거).
   * absenceCount와 같은 규칙(gmkey 1개 = 칸 1개)으로 세므로 두 수의 차가 곧 칸 수다.
   */
  absenceUnclippedCount: number;
};

/** 이동평균 창(경기 수) - 띠 위에 타는 선. */
export const MOVING_AVERAGE_WINDOW = 15;

const PAGE = 1000;

function emptyGrain(pcode: string): CareerGrain {
  return {
    pcode,
    nights: [],
    seasons: [],
    firstDate: null,
    lastDate: null,
    playedCount: 0,
    absenceCount: 0,
    gapSeasons: [],
    maxPts: 0,
    teams: [],
    cellCount: 0,
    dnpCount: 0,
    maxAbsenceRun: 0,
    windows: [],
    absenceUnclippedCount: 0,
  };
}

type TeamGameRow = {
  gmkey: string;
  game_date: string;
  season_name: string;
  season_category: string;
  home_tcode: string;
  away_tcode: string;
  home_score: number | null;
  away_score: number | null;
};

/**
 * 그가 뛴 시즌 × 그가 속했던 팀의 종료 경기를 한 번에(창 전체를 덮는 날짜 범위로 좁혀서).
 * 실측 최악(김선형 15시즌 2팀): 1,587행 - 1000행 기본 cap을 넘으므로 .range 페이지네이션 필수.
 * (같은 조건에서 시즌 전체 경기를 다 받으면 4,207행이라 팀·날짜로 좁히는 게 3배 싸다.)
 */
async function fetchTeamGames(seasons: string[], tcodes: string[], minDate: string, maxDate: string): Promise<TeamGameRow[]> {
  if (!seasons.length || !tcodes.length) return [];
  const list = tcodes.join(",");
  const rows: TeamGameRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("games")
      .select("gmkey, game_date, season_name, season_category, home_tcode, away_tcode, home_score, away_score")
      .eq("is_ended", true)
      .in("season_name", seasons)
      .gte("game_date", minDate)
      .lte("game_date", maxDate)
      .or(`home_tcode.in.(${list}),away_tcode.in.(${list})`)
      .order("game_date", { ascending: true })
      .order("gmkey", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    rows.push(...(data as unknown as TeamGameRow[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

/**
 * 커리어 마지막 이후의 등록 시즌(공백 시즌을 정직하게 세기 위해).
 * 예: 패리스 배스는 23-24만 뛰고 26-27 수원 KT 명단에 있다 - 명단을 보지 않으면 24-25·25-26이
 * "공백"이 아니라 "커리어 끝"으로 읽힌다.
 */
async function fetchLatestRosterSeason(pcode: string): Promise<string | null> {
  const { data } = await supabase
    .from("season_roster")
    .select("season_name")
    .eq("pcode", pcode)
    .order("season_name", { ascending: false })
    .limit(1);
  return (data ?? [])[0]?.season_name ?? null;
}

/** 후보 시즌 중 리그가 실제로 경기를 치른(종료 경기가 있는) 시즌만. 26-27은 개막 전이라 여기서 빠진다. */
async function seasonsWithPlay(candidates: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!candidates.length) return out;
  const res = await Promise.all(
    candidates.map((s) => supabase.from("games").select("season_name").eq("season_name", s).eq("is_ended", true).limit(1))
  );
  res.forEach((r, i) => {
    if ((r.data ?? []).length) out.add(candidates[i]);
  });
  return out;
}

/**
 * 커리어 결 띠 데이터.
 *
 * @param pcode 선수 코드
 * @param careerRows 페이지가 이미 받아 둔 getPlayerCareerGames(pcode) 결과. 주면 출전 절반은
 *   이 배열에서 만들고 재조회하지 않는다(선수 페이지는 이미 careerRows를 갖고 있다).
 *   생략하면 내부에서 getPlayerCareerGames를 호출한다.
 */
export async function getCareerGrain(pcode: string, careerRows?: CareerGameRow[]): Promise<CareerGrain> {
  const all = careerRows ?? (await getPlayerCareerGames(pcode));
  // 종료 경기만(예정·진행 중 경기는 아직 사실이 아니다). 실측상 미종료 경기의 기록 행은 0건이지만
  // 방어적으로 거른다.
  const played = all.filter((r) => r.isEnded).slice().sort((a, b) => (a.gameDate !== b.gameDate ? (a.gameDate < b.gameDate ? -1 : 1) : a.gmkey < b.gmkey ? -1 : 1));
  if (!played.length) return emptyGrain(pcode);

  const playedGmkeys = new Set(played.map((r) => r.gmkey));

  // ── 1. (season, tcode)별 등록 창 ──────────────────────────────────────────────────────
  type Win = { seasonName: string; tcode: string; d0: string; d1: string; played: number };
  const winMap = new Map<string, Win>();
  for (const r of played) {
    const key = `${r.seasonName}__${r.tcode}`;
    const w = winMap.get(key);
    if (!w) winMap.set(key, { seasonName: r.seasonName, tcode: r.tcode, d0: r.gameDate, d1: r.gameDate, played: 1 });
    else {
      if (r.gameDate < w.d0) w.d0 = r.gameDate;
      if (r.gameDate > w.d1) w.d1 = r.gameDate;
      w.played += 1;
    }
  }
  const wins = [...winMap.values()];

  const seasons = [...new Set(wins.map((w) => w.seasonName))];
  const tcodes = [...new Set(wins.map((w) => w.tcode))];
  const minDate = wins.reduce((m, w) => (w.d0 < m ? w.d0 : m), wins[0].d0);
  const maxDate = wins.reduce((m, w) => (w.d1 > m ? w.d1 : m), wins[0].d1);

  const teamGames = await fetchTeamGames(seasons, tcodes, minDate, maxDate);

  // ── 2. 창 안의 결장 ───────────────────────────────────────────────────────────────────
  // 결장 후보를 gmkey로 중복 제거한다: 창이 겹치는 희귀 케이스(실측 전체 15시즌에 1건 -
  // 마리오 리틀 16-17, 창원 LG 창과 서울 SK 창이 겹친다)에서 같은 경기가 두 칸이 되면 안 된다.
  // 그가 실제로 뛴 경기는 어느 팀 창에서도 결장이 될 수 없다(playedGmkeys로 먼저 걸러진다).
  const absentByGmkey = new Map<string, { g: TeamGameRow; tcode: string }>();
  // 자르지 않았을 때의 결장도 같은 규칙(gmkey 1개 = 칸 1개)으로 센다. 창이 겹치는 시즌에는
  // 두 창의 맞대결 경기가 양쪽에서 한 번씩 잡혀서, 창별 카운터를 그냥 더하면 칸 수가 부풀려진다
  // (실측: 조은후 291499의 23-24 정관장/소노 맞대결 결장 1경기 - 합산은 101, 실제 칸은 98).
  // 캡션은 이 값과 absenceCount의 차를 "N칸"이라고 적으므로 두 수가 같은 규칙으로 세져야 한다.
  const unclippedGmkeys = new Set<string>();
  const unclippedByWindow = new Map<string, number>();
  const teamGamesByWindow = new Map<string, number>();

  for (const w of wins) {
    const key = `${w.seasonName}__${w.tcode}`;
    let unclipped = 0;
    let total = 0;
    for (const g of teamGames) {
      if (g.season_name !== w.seasonName) continue;
      if (g.home_tcode !== w.tcode && g.away_tcode !== w.tcode) continue;
      total += 1;
      const missing = !playedGmkeys.has(g.gmkey);
      if (missing) {
        unclipped += 1; // 창별 근거(RegistrationWindow.absentUnclipped)는 창 단위로 그대로 센다
        unclippedGmkeys.add(g.gmkey);
      }
      if (!missing) continue;
      if (g.game_date < w.d0 || g.game_date > w.d1) continue; // 창 밖 - 칸을 만들지 않는다
      if (!absentByGmkey.has(g.gmkey)) absentByGmkey.set(g.gmkey, { g, tcode: w.tcode });
    }
    unclippedByWindow.set(key, unclipped);
    teamGamesByWindow.set(key, total);
  }
  // 주의: teamGames는 [minDate, maxDate]로 이미 좁혀 받았으므로 unclipped/teamGames는 그 범위 안의
  // 값이다. 커리어 첫 출전 이전·마지막 출전 이후의 팀 경기는 애초에 결장 후보가 아니므로(다른 팀
  // 소속이거나 리그에 없던 기간) 캡션이 쓰는 "잘라낸 가짜 결장"의 분모로도 이 범위가 옳다.

  // ── 3. 밤 목록 ────────────────────────────────────────────────────────────────────────
  const nights: CareerNight[] = [];
  for (const r of played) {
    nights.push({
      kind: "played",
      date: r.gameDate,
      seasonName: r.seasonName,
      tcode: r.tcode,
      gmkey: r.gmkey,
      isPlayoff: r.seasonCategory === PLAYOFF_CATEGORY,
      oppTcode: r.oppTcode,
      teamScore: r.teamScore,
      oppScore: r.oppScore,
      won: r.teamScore == null || r.oppScore == null ? null : r.teamScore > r.oppScore,
      isHome: r.isHome,
      pts: r.pts,
      min: r.min,
      reb: r.reb,
      ast: r.ast,
      isStarter: r.isStarter,
    });
  }
  for (const { g, tcode } of absentByGmkey.values()) {
    const isHome = g.home_tcode === tcode;
    const teamScore = isHome ? g.home_score : g.away_score;
    const oppScore = isHome ? g.away_score : g.home_score;
    nights.push({
      kind: "absent",
      date: g.game_date,
      seasonName: g.season_name,
      tcode,
      gmkey: g.gmkey,
      isPlayoff: g.season_category === PLAYOFF_CATEGORY,
      oppTcode: isHome ? g.away_tcode : g.home_tcode,
      teamScore,
      oppScore,
      won: teamScore == null || oppScore == null ? null : teamScore > oppScore,
      isHome,
    });
  }
  nights.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.gmkey < b.gmkey ? -1 : 1));

  // ── 4. 시즌 구간 ──────────────────────────────────────────────────────────────────────
  const seasonBlocks: CareerGrainSeason[] = [];
  for (let i = 0; i < nights.length; i++) {
    const n = nights[i];
    const last = seasonBlocks[seasonBlocks.length - 1];
    if (!last || last.seasonName !== n.seasonName) {
      seasonBlocks.push({ seasonName: n.seasonName, startIndex: i, endIndex: i, tcodes: [n.tcode], played: 0, absent: 0 });
    } else {
      last.endIndex = i;
      if (!last.tcodes.includes(n.tcode)) last.tcodes.push(n.tcode);
    }
    const cur = seasonBlocks[seasonBlocks.length - 1];
    if (n.kind === "played") cur.played += 1;
    else cur.absent += 1;
  }

  // ── 5. 공백 시즌 ──────────────────────────────────────────────────────────────────────
  // 축은 첫 출전 시즌 ~ "마지막으로 알려진 시즌"(마지막 출전 시즌과 최신 등록 시즌 중 뒤엣것).
  // 그중 밤이 0개이고 리그가 실제로 경기를 치른 시즌만 공백으로 센다.
  const playedSeasons = new Set(seasonBlocks.map((s) => s.seasonName));
  const firstSeason = seasonBlocks[0].seasonName;
  const lastPlayedSeason = seasonBlocks[seasonBlocks.length - 1].seasonName;
  const rosterSeason = await fetchLatestRosterSeason(pcode);
  const lastSeason = rosterSeason && seasonStartYear(rosterSeason) > seasonStartYear(lastPlayedSeason) ? rosterSeason : lastPlayedSeason;
  const candidates = buildSeasonAxis(firstSeason, lastSeason).filter((s) => !playedSeasons.has(s));
  const realSeasons = await seasonsWithPlay(candidates);
  const gapSeasons = candidates.filter((s) => realSeasons.has(s));

  // ── 6. 집계 ───────────────────────────────────────────────────────────────────────────
  let maxRun = 0;
  let run = 0;
  for (const n of nights) {
    if (n.kind === "absent") {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else run = 0;
  }

  const windows: RegistrationWindow[] = wins
    .map((w) => {
      const key = `${w.seasonName}__${w.tcode}`;
      return {
        seasonName: w.seasonName,
        tcode: w.tcode,
        firstDate: w.d0,
        lastDate: w.d1,
        played: w.played,
        absent: nights.filter((n) => n.kind === "absent" && n.seasonName === w.seasonName && n.tcode === w.tcode).length,
        absentUnclipped: unclippedByWindow.get(key) ?? 0,
        teamGames: teamGamesByWindow.get(key) ?? 0,
      };
    })
    .sort((a, b) => (a.seasonName !== b.seasonName ? (a.seasonName < b.seasonName ? -1 : 1) : a.firstDate < b.firstDate ? -1 : 1));

  const teamOrder: string[] = [];
  for (const n of nights) if (!teamOrder.includes(n.tcode)) teamOrder.push(n.tcode);

  const playedCount = played.length;
  const absenceCount = nights.length - playedCount;

  return {
    pcode,
    nights,
    seasons: seasonBlocks,
    firstDate: nights[0].date,
    lastDate: nights[nights.length - 1].date,
    playedCount,
    absenceCount,
    gapSeasons,
    maxPts: played.reduce((m, r) => (r.pts > m ? r.pts : m), 0),
    teams: teamOrder,
    cellCount: nights.length,
    dnpCount: played.filter((r) => r.min === 0).length,
    maxAbsenceRun: maxRun,
    windows,
    absenceUnclippedCount: unclippedGmkeys.size,
  };
}

/**
 * 띠 위에 타는 이동평균선. nights와 같은 길이의 배열을 돌려주고, 값이 아직 없으면 null.
 *
 * 정의: "최근 window경기 출전의 평균 득점". 결장 칸은 0점으로 세지 않는다 - 뛰지 않은 밤을 0점으로
 * 평균에 넣으면 결장이 곧 부진으로 보이는데, 그건 이 DB가 말할 수 없는 주장이다. 결장 칸에서는
 * 직전 출전까지의 값을 그대로 이어 그린다(선이 끊기지 않게).
 * 출전 수가 window에 못 미치는 구간은 null - 표본이 찰 때까지 선을 그리지 않는다.
 */
export function careerMovingAverage(nights: CareerNight[], window = MOVING_AVERAGE_WINDOW): (number | null)[] {
  const out: (number | null)[] = [];
  const buf: number[] = [];
  let sum = 0;
  let cur: number | null = null;
  for (const n of nights) {
    if (n.kind === "played") {
      buf.push(n.pts);
      sum += n.pts;
      if (buf.length > window) sum -= buf.shift()!;
      cur = buf.length >= window ? sum / window : null;
    }
    out.push(cur);
  }
  return out;
}
