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

/** 표에 올리는 조합 크기(주인공 포함). 2인은 기존 그대로, 3~5인이 추가된 것. */
export const WOWY_GROUP_SIZES = [2, 3, 4, 5] as const;
export type WowyGroupSize = (typeof WOWY_GROUP_SIZES)[number];

/**
 * net/40의 표준오차. 실측(2026-09-04, 25-26 리그 전체 조합)으로 "관측 SD × √분"이 조합 크기와
 * 무관하게 100 근처에서 거의 일정했다: 20분 99 / 32분 98 / 50분 104 / 80분 103 / 200분 106.
 * 그래서 분만 알면 그 행의 오차 폭을 바로 찍을 수 있다 - 25분 표본이면 ±20으로, 숫자가 스스로
 * 얼마나 못 미더운지 말하게 된다.
 */
export const NET40_SE_CONST = 100;
export function net40Se(minutes: number): number {
  return minutes > 0 ? NET40_SE_CONST / Math.sqrt(minutes) : Infinity;
}

/**
 * 조합 크기별로 표에 남기는 최대 행 수.
 * 임계값 몇 분 차이로 통과 개수가 두 배씩 바뀌는 구간이 있어(k=3의 중앙 통과 수가 100분 15개,
 * 60분 27개) 하한만으로는 화면 분량이 선수마다 널뛴다. 하한 + 상위 N 컷을 같이 쓴다.
 */
export const WOWY_GROUP_TOP_N: Record<WowyGroupSize, number> = { 2: 999, 3: 12, 4: 10, 5: 8 };

/**
 * 조합 크기별 최소 "함께" 분.
 *
 * 왜 크기마다 다른가: 한 스틴트는 2인 조합 4개, 3인 6개, 4인 4개, 5인 1개를 동시에 만든다.
 * 같은 온코트 시간을 조합 수로 나눠 갖는 셈이라 k가 커질수록 조합 하나에 쌓이는 시간이
 * 급격히 준다. 2인 기준선(100분)을 5인에 그대로 적용하면 표가 통째로 비고, 반대로 5인
 * 기준선을 2인에 적용하면 노이즈가 표를 덮는다.
 *
 * "따로"(조합원 전원 OFF) 쪽은 k가 커져도 안 무너진다 - 주인공의 시즌 동료가 15~19명이라
 * 그 넷이 전원 벤치인 시간이 흔하다(실측: 함께 25분 이상 조합의 따로 분 중앙값이 k=5에서도
 * 37분, 따로 0분인 조합은 k=2~5 통틀어 0개). 무너지는 쪽은 함께다(k=5 조합 분 중앙값 3.0분).
 * 하한은 양쪽에 같은 값으로 둔다 - 어느 한쪽만 두꺼운 비교는 비교가 아니다.
 *
 * 값의 근거(후보 111명 중 '5개 이상 남는' 비율, 함께&따로 양쪽 기준):
 *   k=3 100분 77% · k=4 40분 88% · k=5 20분 64%.
 */
export const WOWY_GROUP_MIN_MINUTES: Record<WowyGroupSize, number> = { 2: 100, 3: 100, 4: 40, 5: 20 };

/** 2단계 계산에서 "따로"까지 재 볼 후보를 크기별로 이만큼만 남긴다(함께 분 상위). */
const GROUP_CANDIDATE_CAP = 80;

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
  /** net/40의 표준오차(±). 분만으로 정해진다 - net40Se 주석 참고. */
  se: number;
  /** "1,114분 · 331스틴트" */
  sample: string;
};

/** 조합원 한 명(주인공 제외). 사진은 players.photo_url - 대부분 null이라 폴백이 기본값이다. */
export type WowyMember = {
  pcode: string;
  name: string;
  href: string;
  photoUrl: string | null;
  /** 그 시즌 등번호(경기 기록 최빈값). 커리어 범위에서는 null. */
  backNum: string | null;
  /** 등번호도 없을 때 원형 타일에 넣을 글자(한글 이름의 성 한 글자). */
  initial: string;
};

export type WowyMate = {
  /** 조합 키 - 주인공을 뺀 조합원 pcode를 정렬해 콤마로 이은 값. React key로 쓴다. */
  key: string;
  /** 주인공 포함 인원(2~5). */
  size: WowyGroupSize;
  /** 주인공을 뺀 조합원. 2인 조합이면 한 명. */
  members: WowyMember[];
  /** 2인 조합의 동료 pcode(하위 호환 - 3인 이상에서는 첫 조합원). */
  pcode: string;
  /** 2인이면 동료 이름, 3인 이상이면 "안영준 · 최원혁" 같은 나열. */
  name: string;
  href: string;
  with: WowySplit;
  without: WowySplit;
  /** 함께 net/40 - 따로 net/40. 양수면 "이 조합과 있을 때 더 좋다". */
  diff: number;
  /** 차이의 표준오차 = √(함께 SE² + 따로 SE²). |차이| < 이 값이면 부호조차 의미가 없다. */
  diffSe: number;
  /** 함께가 크기별 하한을, 따로가 WOWY_MIN_MINUTES를 넘었는가. */
  qualified: boolean;
};

export type WowySubject = {
  pcode: string;
  name: string;
  photoUrl: string | null;
  backNum: string | null;
  initial: string;
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
  /** 자격을 통과한 2인 조합. diff 내림차순(같이 뛸 때 좋은 동료가 위). */
  mates: WowyMate[];
  /** 표본 미달 2인 조합(참고용, 같은 필드. UI는 접어두거나 생략해도 된다). */
  belowThreshold: WowyMate[];
  /** 3·4·5인 조합. 크기를 키로, 각 배열은 diff 내림차순. 자격 통과분만. */
  groups: Record<number, WowyMate[]>;
  /** 크기별로 실제로 만들어진 조합 수(자격 통과 전) - 캡션이 "몇 개 중 몇 개"를 말할 수 있게. */
  groupCounts: Record<number, number>;
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
    se: net40Se(minutes),
    sample: `${minutes.toLocaleString(undefined, { maximumFractionDigits: 0 })}분 · ${stints.toLocaleString()}스틴트`,
  };
}

function diffSeOf(w: WowySplit, o: WowySplit): number {
  return Math.sqrt(w.se * w.se + o.se * o.se);
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

  // 시즌 범위에서만: (1) 주인공의 그 시즌 소속 팀, (2) 조합원의 등번호(원형 타일 폴백).
  //
  // 두 조회의 비용이 아주 다르다. 소속 팀은 주인공 한 명이라 전 청크를 훑어도 가볍고,
  // 시즌 중 이적 선수는 경기 수가 갈리는 지점이 뒤쪽 청크에 있을 수 있어 전부 봐야 한다.
  // 반대로 등번호는 조합원 15~20명 x 전 경기라 페이지네이션까지 걸려 /lineups가 4.0초에서
  // 5.4초로 늘었다(실측). 등번호는 시즌 내내 거의 안 바뀌므로 첫 청크만 봐도 로테이션
  // 선수는 전원 잡힌다 - 그래서 첫 청크 한 번만 읽는다.
  let tcode: string | null = null;
  const backNums = new Map<string, string>();
  if (!isCareer) {
    const gmkeys = games.map((g) => g.gmkey);
    const parts = chunk(gmkeys, GMKEY_CHUNK);
    const [teamRows, numRows] = await Promise.all([
      (async () => {
        const out: { tcode: string; min_played: number | null }[] = [];
        for (const part of parts) {
          const { data } = await supabase
            .from("game_player_stats")
            .select("tcode, min_played")
            .eq("pcode", pcode)
            .in("gmkey", part);
          out.push(...((data ?? []) as { tcode: string; min_played: number | null }[]));
        }
        return out;
      })(),
      parts.length
        ? fetchAllPagesBounded<{ pcode: string; back_num: string | null }>((from, to) =>
            supabase
              .from("game_player_stats")
              .select("pcode, back_num", { count: "exact" })
              .in("pcode", codes)
              .in("gmkey", parts[0])
              .range(from, to)
          )
        : Promise.resolve([]),
    ]);

    const minByTeam = new Map<string, number>();
    for (const r of teamRows) minByTeam.set(r.tcode, (minByTeam.get(r.tcode) ?? 0) + num(r.min_played) + 0.001);
    let best = -1;
    for (const [tc, m] of minByTeam)
      if (m > best) {
        tcode = tc;
        best = m;
      }

    const numSeen = new Map<string, Map<string, number>>();
    for (const r of numRows) {
      const bn = (r.back_num ?? "").trim();
      if (!bn) continue;
      const m = numSeen.get(r.pcode) ?? new Map<string, number>();
      m.set(bn, (m.get(bn) ?? 0) + 1);
      numSeen.set(r.pcode, m);
    }
    // 최빈 등번호. 동률이면 문자열 순으로 갈라 실행마다 값이 흔들리지 않게.
    for (const [pc, m] of numSeen) {
      const pick = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      if (pick) backNums.set(pc, pick[0]);
    }
  }

  const names = new Map<string, string>();
  const photos = new Map<string, string | null>();
  for (const part of chunk(codes, 200)) {
    const { data } = await supabase.from("players").select("pcode, name, photo_url").in("pcode", part);
    for (const p of data ?? []) {
      names.set(p.pcode as string, p.name as string);
      photos.set(p.pcode as string, (p.photo_url as string | null) ?? null);
    }
  }
  const memberOf = (mate: string): WowyMember => {
    const nm = names.get(mate) ?? mate;
    return {
      pcode: mate,
      name: nm,
      href: `/players/${mate}`,
      photoUrl: photos.get(mate) ?? null,
      backNum: backNums.get(mate) ?? null,
      // 사진도 등번호도 없을 때만 쓰는 2차 폴백. 성 한 글자는 김 13명·이 12명·최 10명으로
      // 충돌하므로(실측) 식별은 항상 옆의 이름 라벨이 맡는다.
      initial: (nm || "?").trim().slice(0, 1),
    };
  };

  const all: WowyMate[] = [...withAcc.entries()].map(([mate, a]) => {
    const wMin = a.sec / 60;
    const oMin = (totalSec - a.sec) / 60;
    const oMargin = totalMargin - a.margin;
    const oStints = mine.length - a.stints;
    const w = makeSplit(wMin, a.stints, a.margin);
    const o = makeSplit(oMin, oStints, oMargin);
    const member = memberOf(mate);
    return {
      key: mate,
      size: 2 as WowyGroupSize,
      members: [member],
      pcode: mate,
      name: member.name,
      href: member.href,
      with: w,
      without: o,
      diff: w.netPer40 - o.netPer40,
      diffSe: diffSeOf(w, o),
      qualified: wMin >= WOWY_MIN_MINUTES && oMin >= WOWY_MIN_MINUTES,
    };
  });
  all.sort((x, y) => y.diff - x.diff);

  // ── 3·4·5인 조합(요청: "3인 ,4인, 5인 조합도 보이면 좋을것 같아") ────────────────
  // 정의는 2인과 완전히 같다. "함께" = 주인공 + 조합원 전원이 동시에 코트 위. "따로" =
  // 주인공은 코트 위인데 조합원이 한 명도 없는 시간. 그래서 2인 표에서 배운 읽는 법이
  // 그대로 통하고, 같은 검산(함께 + 따로 ≤ 온코트)도 계속 성립한다.
  //   ! 2인과 달리 "함께 + 따로 = 온코트"가 아니다. 조합원이 일부만 있는 시간이 어느 쪽에도
  //     들어가지 않기 때문. 3인 이상 표의 캡션이 그 사실을 직접 말해야 한다.
  //
  // 1단계: 스틴트마다 동료 4명의 부분집합(크기 2~4)을 전부 세어 "함께"를 쌓는다.
  //        스틴트당 11개(4C2+4C3+4C4)라 2,000스틴트여도 22,000번이면 끝난다.
  type GroupAcc = { members: string[]; sec: number; margin: number; stints: number };
  const groupAcc = new Map<string, GroupAcc>();
  for (const m of mine) {
    const others = m.lineup.filter((p) => p !== pcode).sort();
    const n = others.length;
    if (n < 2) continue;
    for (let mask = 1; mask < 1 << n; mask++) {
      let bits = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) bits++;
      if (bits < 2 || bits > 4) continue;
      const members: string[] = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) members.push(others[i]);
      const key = members.join(",");
      const a = groupAcc.get(key) ?? { members, sec: 0, margin: 0, stints: 0 };
      a.sec += m.sec;
      a.margin += m.margin;
      a.stints += 1;
      groupAcc.set(key, a);
    }
  }

  // 2단계: 크기별로 "함께" 상위 후보만 남겨 "따로"를 실제로 훑어 센다. 후보를 자르는 이유는
  //        비용(후보 × 스틴트)뿐이고, 자른 건 전부 함께 분이 가장 짧은 것들이라 어차피
  //        하한에 걸린다.
  const groupCounts: Record<number, number> = {};
  const bySize = new Map<number, GroupAcc[]>();
  for (const a of groupAcc.values()) {
    const size = a.members.length + 1;
    groupCounts[size] = (groupCounts[size] ?? 0) + 1;
    const list = bySize.get(size) ?? [];
    list.push(a);
    bySize.set(size, list);
  }
  const groups: Record<number, WowyMate[]> = {};
  for (const [size, list] of bySize) {
    list.sort((x, y) => y.sec - x.sec);
    const minWith = WOWY_GROUP_MIN_MINUTES[size as WowyGroupSize] ?? WOWY_MIN_MINUTES;
    const rows: WowyMate[] = [];
    for (const a of list.slice(0, GROUP_CANDIDATE_CAP)) {
      const set = new Set(a.members);
      let oSec = 0;
      let oMargin = 0;
      let oStints = 0;
      for (const m of mine) {
        if (m.lineup.some((p) => set.has(p))) continue;
        oSec += m.sec;
        oMargin += m.margin;
        oStints += 1;
      }
      const w = makeSplit(a.sec / 60, a.stints, a.margin);
      const o = makeSplit(oSec / 60, oStints, oMargin);
      const members = a.members.map(memberOf);
      rows.push({
        key: a.members.join(","),
        size: size as WowyGroupSize,
        members,
        pcode: a.members[0],
        name: members.map((x) => x.name).join(" · "),
        href: members[0].href,
        with: w,
        without: o,
        diff: w.netPer40 - o.netPer40,
        diffSe: diffSeOf(w, o),
        qualified: w.minutes >= minWith && o.minutes >= minWith,
      });
    }
    // 3인 이상은 net/40 차이가 아니라 '함께 분'으로 줄 세운다. 실측된 split-half 상관이
    // k=3~5에서 0 근처라(순열 자료와 산포가 거의 같다) 차이로 정렬하면 노이즈를 순위로
    // 승격시키게 된다. 많이 뛴 조합이 위에 오는 건 표본이 지지하는 유일한 주장이다.
    rows.sort((x, y) => y.with.minutes - x.with.minutes);
    groups[size] = rows.filter((r) => r.qualified).slice(0, WOWY_GROUP_TOP_N[size as WowyGroupSize] ?? 12);
  }

  // (주인공 소속 팀 tcode는 위 등번호 조회에서 같이 구했다.)
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
      photoUrl: photos.get(pcode) ?? null,
      backNum: backNums.get(pcode) ?? null,
      initial: (names.get(pcode) ?? "?").trim().slice(0, 1),
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
    groups,
    groupCounts,
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
