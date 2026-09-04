import { supabase } from "./supabase";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { getTeams, shortSeason } from "./preseason";
import { ONOFF_MIN } from "./seasonFocus";
import { GMKEY_CHUNK, chunk, getSeasonGames, normalizePos, num, posLabel } from "./teamSeasonStats";
import { aggregateSeasonPlayers, fetchSeasonPlayerGameRows } from "./seasonLeaders";

// 선수별 조합(WOWY) - 요청: "선수별 조합", 참고는 databallr.com의 WOWY Lineups 뷰
// (라인업 행마다 MIN / OFF / DEF / NET, 선수마다 ON-OFF 토글).
//
// ── 정의(이 파일의 유일한 진실. 캡션으로도 그대로 내보낸다) ────────────────────────
// 표본은 "주인공이 코트에 있는 스틴트"뿐이다(lineup_stints에서 home_lineup 또는 away_lineup이
// 그 pcode를 포함하는 행). 그 스틴트들을 동료가 같은 라인업 배열에 있느냐로만 두 덩이로 가른다.
//   함께 = 주인공 ON + 동료 ON
//   따로 = 주인공 ON + 동료 OFF      ← "선수가 벤치일 때"가 절대 아니다. 주인공은 계속 코트에 있다.
// 마진은 항상 주인공이 속한 쪽(홈이면 home_pts - away_pts, 원정이면 그 반대)에서 본다.
// net/40 = 마진 합 ÷ 분 × 40.
//
// 검증(2026-09-04, SQL로 직접 대조): 자밀 워니(291248) 2025-2026 - 온코트 1,790.4분 / +2.37 per40.
//   최원혁     함께 431.6분 +6.02   따로 1,358.8분 +1.21
//   안영준     함께 1,113.9분 +4.20 따로 676.5분 -0.65
//   알빈 톨렌티노 함께 824.7분 +3.98 따로 965.7분 +0.99
//   오세근     함께 456.8분 -0.18   따로 1,333.6분 +3.24
// 이 값들은 시즌 카테고리를 가리지 않은 값이다(정규시즌 1,684.9분 + 플레이오프 105.5분).
// 그래서 이 파일의 시즌 범위는 정규시즌+플레이오프 전체다 - 라인업 표본은 원래 귀해서
// 플레이오프를 버릴 이유가 없고, 캡션에 그 사실을 적는다.
// (주의: lib/seasonLeaders.ts / lib/teamSeasonStats.ts는 정규시즌만 쓴다. 표본이 다르다.)

/** 동료 한 명이 표에 오르려면 "함께"와 "따로" 양쪽 모두 이 분 이상이어야 한다. */
export const WOWY_MIN_MINUTES = 100;

/** 주인공이 될 수 있는 최소 출전 시간(분). 저장소 선례 재사용 - lib/seasonFocus.ts ONOFF_MIN.on. */
export const WOWY_SUBJECT_MIN_MINUTES = ONOFF_MIN.on;

export const WOWY_DEFINITION =
  "표본은 주인공이 코트에 있는 스틴트뿐이다. '함께'는 주인공과 동료가 같이 뛴 시간, " +
  "'따로'는 주인공은 뛰고 동료만 벤치인 시간이다(주인공이 쉬는 시간은 어느 쪽에도 들어가지 않는다). " +
  "마진은 주인공 팀 기준이고 net/40 = 마진 합 ÷ 분 × 40.";

export type WowyScope = string; // 시즌명("2025-2026") 또는 "career"
export const WOWY_CAREER = "career";

export type WowySplit = {
  minutes: number;
  stints: number;
  margin: number;
  netPer40: number;
  /** "1,114분 · 331스틴트" */
  sample: string;
};

export type WowyMate = {
  pcode: string;
  name: string;
  href: string;
  with: WowySplit;
  without: WowySplit;
  /** 함께 net/40 - 따로 net/40. 양수면 "이 동료와 있을 때 더 좋다". */
  diff: number;
  /** 양쪽 다 WOWY_MIN_MINUTES를 넘었는가. */
  qualified: boolean;
};

export type WowySubject = {
  pcode: string;
  name: string;
  tcode: string | null;
  teamName: string | null;
  teamAbbr: string | null;
  teamColor: string | null;
  logoUrl: string | null;
  /** 시즌 범위면 시즌명, 커리어면 null. */
  seasonName: string | null;
  /** "25-26" 또는 "커리어". */
  scopeLabel: string;
  gamesN: number;
  onCourt: WowySplit;
  href: string;
};

export type Wowy = {
  scope: WowyScope;
  subject: WowySubject;
  /** 자격을 통과한 동료. diff 내림차순(같이 뛸 때 좋은 동료가 위). */
  mates: WowyMate[];
  /** 표본 미달 동료(참고용, 같은 필드. UI는 접어두거나 생략해도 된다). */
  belowThreshold: WowyMate[];
  minMinutes: number;
  definition: string;
  caption: string;
};

type StintRow = {
  gmkey: string;
  home_lineup: string[] | null;
  away_lineup: string[] | null;
  duration_sec: number | null;
  home_pts: number | null;
  away_pts: number | null;
};

const STINT_SELECT = "gmkey, home_lineup, away_lineup, duration_sec, home_pts, away_pts";

/**
 * 주인공이 코트에 있는 스틴트 전부.
 * home/away를 따로 두 번 조회한다 - `.contains()`(PostgREST cs 연산자)가 lineup_stints의
 * 두 GIN 인덱스를 각각 그대로 타기 때문. or(...)로 한 번에 묶으면 인덱스 선택이 불안정해진다.
 * 시즌 범위면 gmkey를 GMKEY_CHUNK개씩 끊어서 좁힌다(게임 테이블에만 season_name이 있다).
 */
async function fetchSubjectStints(pcode: string, gmkeys: string[] | null): Promise<StintRow[]> {
  const parts = gmkeys ? chunk(gmkeys, GMKEY_CHUNK) : [null];
  const out: StintRow[] = [];
  for (const part of parts) {
    for (const col of ["home_lineup", "away_lineup"] as const) {
      const rows = await fetchAllPagesBounded<StintRow>((from, to) => {
        let q = supabase.from("lineup_stints").select(STINT_SELECT, { count: "exact" }).contains(col, [pcode]);
        if (part) q = q.in("gmkey", part);
        return q.range(from, to);
      });
      out.push(...rows);
    }
  }
  return out;
}

function per40(margin: number, minutes: number): number {
  return minutes > 0 ? (margin / minutes) * 40 : 0;
}

function makeSplit(minutes: number, stints: number, margin: number): WowySplit {
  return {
    minutes,
    stints,
    margin,
    netPer40: per40(margin, minutes),
    sample: `${minutes.toLocaleString(undefined, { maximumFractionDigits: 0 })}분 · ${stints.toLocaleString()}스틴트`,
  };
}

/**
 * 선수 한 명의 WOWY 표.
 * @param scope 시즌명("2025-2026") 또는 WOWY_CAREER("career")
 * 스틴트가 하나도 없으면 null(라인업 로그가 없는 옛 경기·미출전 선수).
 */
export async function getWowy(pcode: string, scope: WowyScope = WOWY_CAREER): Promise<Wowy | null> {
  const isCareer = scope === WOWY_CAREER;

  // 시즌 범위 - 정규시즌+플레이오프 모두(category: null). 라인업 표본을 버리지 않는다.
  const games = isCareer ? [] : await getSeasonGames(scope, { category: null });
  if (!isCareer && !games.length) return null;

  const stints = await fetchSubjectStints(pcode, isCareer ? null : games.map((g) => g.gmkey));
  if (!stints.length) return null;

  type Mine = { lineup: string[]; margin: number; sec: number };
  const mine: Mine[] = [];
  const gameSet = new Set<string>();
  for (const s of stints) {
    const home = s.home_lineup ?? [];
    const away = s.away_lineup ?? [];
    const onHome = home.includes(pcode);
    const lineup = onHome ? home : away;
    if (!lineup.includes(pcode)) continue; // 방어(조회 조건상 도달하지 않음)
    const hp = num(s.home_pts);
    const ap = num(s.away_pts);
    mine.push({ lineup, margin: onHome ? hp - ap : ap - hp, sec: num(s.duration_sec) });
    gameSet.add(s.gmkey);
  }
  if (!mine.length) return null;

  const totalSec = mine.reduce((t, m) => t + m.sec, 0);
  const totalMargin = mine.reduce((t, m) => t + m.margin, 0);

  // 동료별 함께/따로 누적. 주인공 온코트 총합에서 "함께"를 빼면 "따로"가 되므로 한 번만 순회한다.
  type MateAcc = { sec: number; margin: number; stints: number };
  const withAcc = new Map<string, MateAcc>();
  for (const m of mine) {
    for (const p of m.lineup) {
      if (p === pcode) continue;
      const a = withAcc.get(p) ?? { sec: 0, margin: 0, stints: 0 };
      a.sec += m.sec;
      a.margin += m.margin;
      a.stints += 1;
      withAcc.set(p, a);
    }
  }

  const codes = [pcode, ...withAcc.keys()];
  const names = new Map<string, string>();
  for (const part of chunk(codes, 200)) {
    const { data } = await supabase.from("players").select("pcode, name").in("pcode", part);
    for (const p of data ?? []) names.set(p.pcode as string, p.name as string);
  }

  const all: WowyMate[] = [...withAcc.entries()].map(([mate, a]) => {
    const wMin = a.sec / 60;
    const oMin = (totalSec - a.sec) / 60;
    const oMargin = totalMargin - a.margin;
    const oStints = mine.length - a.stints;
    const w = makeSplit(wMin, a.stints, a.margin);
    const o = makeSplit(oMin, oStints, oMargin);
    return {
      pcode: mate,
      name: names.get(mate) ?? mate,
      href: `/players/${mate}`,
      with: w,
      without: o,
      diff: w.netPer40 - o.netPer40,
      qualified: wMin >= WOWY_MIN_MINUTES && oMin >= WOWY_MIN_MINUTES,
    };
  });
  all.sort((x, y) => y.diff - x.diff);

  // 주인공의 시즌 소속 팀 - 시즌 범위일 때만. game_player_stats를 같은 gmkey 청크로 좁혀 읽는다.
  let tcode: string | null = null;
  if (!isCareer) {
    const minByTeam = new Map<string, number>();
    for (const part of chunk(games.map((g) => g.gmkey), GMKEY_CHUNK)) {
      const { data } = await supabase
        .from("game_player_stats")
        .select("tcode, min_played")
        .eq("pcode", pcode)
        .in("gmkey", part);
      for (const r of data ?? []) {
        const tc = r.tcode as string;
        minByTeam.set(tc, (minByTeam.get(tc) ?? 0) + num(r.min_played) + 0.001);
      }
    }
    let best = -1;
    for (const [tc, m] of minByTeam) if (m > best) { tcode = tc; best = m; }
  }
  const teams = isCareer ? null : await getTeams(scope);
  const team = tcode && teams ? teams.get(tcode) : undefined;

  const onCourt = makeSplit(totalSec / 60, mine.length, totalMargin);
  const scopeLabel = isCareer ? "커리어" : shortSeason(scope);
  const rangeText = isCareer ? "커리어 전체(15시즌 라인업 로그)" : `${shortSeason(scope)} 정규시즌+플레이오프`;

  return {
    scope,
    subject: {
      pcode,
      name: names.get(pcode) ?? pcode,
      tcode,
      teamName: team?.name ?? null,
      teamAbbr: team?.abbr ?? null,
      teamColor: team?.color ?? null,
      logoUrl: team?.logoUrl ?? null,
      seasonName: isCareer ? null : scope,
      scopeLabel,
      gamesN: gameSet.size,
      onCourt,
      href: `/players/${pcode}`,
    },
    mates: all.filter((m) => m.qualified),
    belowThreshold: all.filter((m) => !m.qualified),
    minMinutes: WOWY_MIN_MINUTES,
    definition: WOWY_DEFINITION,
    caption:
      `${rangeText} · ${gameSet.size}경기 · 온코트 ${Math.round(onCourt.minutes).toLocaleString()}분 ` +
      `(${onCourt.netPer40 >= 0 ? "+" : ""}${onCourt.netPer40.toFixed(2)}/40) · ` +
      `함께·따로 양쪽 ${WOWY_MIN_MINUTES}분 이상인 동료만 표에 올린다`,
  };
}

// ---------------------------------------------------------------------------
// 주인공 선택기
// ---------------------------------------------------------------------------

export type WowyPickPlayer = {
  pcode: string;
  name: string;
  backNum: string | null;
  pos: "G" | "F" | "C" | null;
  posLabel: string;
  gp: number;
  minutes: number;
  href: string;
};

export type WowyTeamGroup = {
  tcode: string;
  name: string;
  abbr: string;
  color: string;
  logoUrl: string | null;
  players: WowyPickPlayer[];
};

export type WowyPicker = {
  seasonName: string;
  minMinutes: number;
  playersN: number;
  groups: WowyTeamGroup[];
  caption: string;
};

/**
 * 그 시즌에 주인공이 될 수 있는 선수 목록(팀별 묶음).
 * 자격 = 출전 시간 WOWY_SUBJECT_MIN_MINUTES(300분) 이상. 표본 범위는 getWowy와 같은
 * 정규시즌+플레이오프. 실측: 2025-2026 → 111명.
 * 팀은 그 시즌 가장 오래 뛴 팀(시즌 중 이적 선수는 한 번만 나온다).
 */
export async function getWowyPlayers(seasonName: string): Promise<WowyPicker | null> {
  const [{ rows }, teams] = await Promise.all([
    fetchSeasonPlayerGameRows(seasonName, { category: null }),
    getTeams(seasonName),
  ]);
  if (!rows.length) return null;

  const aggs = aggregateSeasonPlayers(rows).filter((a) => a.minutes >= WOWY_SUBJECT_MIN_MINUTES);
  if (!aggs.length) return null;

  const backNum = new Map<string, string>();
  for (const r of rows) if (r.back_num) backNum.set(r.pcode, r.back_num);

  const names = new Map<string, string>();
  for (const part of chunk(aggs.map((a) => a.pcode), 200)) {
    const { data } = await supabase.from("players").select("pcode, name").in("pcode", part);
    for (const p of data ?? []) names.set(p.pcode as string, p.name as string);
  }

  const byTeam = new Map<string, WowyPickPlayer[]>();
  for (const a of aggs) {
    const pos = normalizePos(a.pos);
    const list = byTeam.get(a.tcode) ?? [];
    list.push({
      pcode: a.pcode,
      name: names.get(a.pcode) ?? a.pcode,
      backNum: backNum.get(a.pcode) ?? null,
      pos,
      posLabel: posLabel(pos),
      gp: a.gp,
      minutes: a.minutes,
      href: `/players/${a.pcode}`,
    });
    byTeam.set(a.tcode, list);
  }

  const groups: WowyTeamGroup[] = [...byTeam.entries()]
    .map(([tcode, players]) => {
      const info = teams.get(tcode);
      players.sort((x, y) => y.minutes - x.minutes);
      return {
        tcode,
        name: info?.name ?? tcode,
        abbr: info?.abbr ?? tcode,
        color: info?.color ?? "#888888",
        logoUrl: info?.logoUrl ?? null,
        players,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name, "ko"));

  return {
    seasonName,
    minMinutes: WOWY_SUBJECT_MIN_MINUTES,
    playersN: aggs.length,
    groups,
    caption: `${shortSeason(seasonName)} 정규시즌+플레이오프 ${WOWY_SUBJECT_MIN_MINUTES}분 이상 출전한 ${aggs.length}명`,
  };
}
