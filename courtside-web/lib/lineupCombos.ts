import { supabaseServer as supabase } from "./supabaseServer";
import { TAG, TTL, cachedFn } from "./cachePolicy";
import { fetchAllPagesBounded } from "./scoringExplorer";
import { getSeasonGames, num } from "./teamSeasonStats";
import {
  fetchSubjectStints,
  NET40_SE_CONST,
  net40Se,
  per40,
  WOWY_GROUP_MIN_MINUTES,
  WOWY_GROUP_SIZES,
} from "./wowy";

// 선수 프로필 "시너지 임팩트"를 2인에서 3·4·5인까지 넓힌 데이터 레이어(요청: "3인/4인/5인 조합도").
// 원본은 lib/playerDataScience.ts getTopPairCombos - n=2, 50분, net/40 내림차순 상위 3개다.
// 그 함수는 남겨 두고(다른 곳에서 쓸 수 있음) 여기서 크기별 조회·임계값·정렬을 새로 정의한다.
//
// ── 표본의 성격(이 파일의 모든 숫자에 붙는 단서) ──────────────────────────────────
// lineup_combo는 15시즌을 통째로 합친 커리어 통산이고 시즌 구분 컬럼이 없다. 그래서
//   · 이 패널의 범위는 언제나 "커리어"다(이번 시즌만 보는 방법이 없다).
//   · 조합원에 시즌 등번호를 붙일 수 없다(등번호는 시즌마다 바뀐다) - 원형 타일의 폴백 글자가
//     /lineups의 등번호가 아니라 이름 첫 글자인 이유.
//   · 상대 전력도, 코트 위 나머지가 누구였는지도 보정하지 않은 원시 온코트 마진이다(RAPM 아님).
// 행 수(2026-09-04 실측): n=2 12,993 / n=3 48,268 / n=4 60,171 / n=5 21,324.
// 분 중앙값: n=2 85.6 / n=3 22.1 / n=4 10.3 / n=5 7.0.

/** 표에 올리는 조합 크기(주인공 포함). 5인은 코트 위 라인업 그 자체다. */
export const COMBO_SIZES = [2, 3, 4, 5] as const;
export type ComboSize = (typeof COMBO_SIZES)[number];

/**
 * 크기별 최소 "함께 뛴 분".
 *
 * 왜 크기마다 다른가: 한 스틴트는 2인 조합 4개, 3인 6개, 4인 4개, 5인 1개를 동시에 만든다.
 * 같은 온코트 시간을 더 많은 조합이 나눠 갖는 셈이라 k가 커질수록 조합 하나에 쌓이는 시간이
 * 급격히 준다(분 중앙값 85.6 → 22.1 → 10.3 → 7.0). 하나의 하한을 네 크기에 그대로 쓰면
 * 5인 표가 통째로 비거나(100분) 2인 표가 노이즈로 덮인다(12분).
 *
 * 고른 방법(2026-09-04 실측): "n=2에서 50분 이상 조합을 하나라도 가진 선수" 613명을 모집단으로
 * 두고, 임계값별로 "그 크기에서 3개 이상 남는 선수 비율"을 셌다. 크기마다 그 비율이 86~89%로
 * 같아지는 지점을 골랐다 - 즉 네 표가 같은 인색함으로 걸러진다.
 *   n=2  90분 89% · 100분 87% · 120분 84% · 150분 79%
 *   n=3  55분 89% ·  60분 88% ·  70분 85% ·  80분 83%
 *   n=4  26분 92% ·  30분 89% ·  35분 85% ·  40분 82%
 *   n=5  10분 91% ·  12분 86% ·  14분 84% ·  15분 82%
 * 선수 네 명으로 통과 개수를 직접 확인한 값(이 임계값 기준):
 *   김선형(15시즌) 71 / 305 / 509 / 344개
 *   자밀 워니       28 / 142 / 260 / 194개
 *   조은후(3시즌)    7 /   7 /   4 /   4개   ← 얇은 선수도 네 크기 모두 3개 안팎은 남는다
 *   마커스 킨(단기)   6 /  14 /  19 /   9개
 * 신정섭처럼 통산 출전이 극히 적은 선수는 어느 크기에서도 0개가 되는데, 그건 채워야 할
 * 빈칸이 아니라 사실이므로 컴포넌트가 "표본을 넘긴 조합 없음"이라고 그대로 적는다.
 *
 * 대가는 오차 폭이다(아래 se). 이 임계값에서 ±는 각각 ±10 / ±13 / ±18 / ±29 - 5인은
 * 임계값을 아무리 올려도 ±가 두 자리 아래로 내려오지 않는다(20분으로 올려도 ±22인데 3개 이상
 * 남는 선수가 75%로 떨어진다). 그래서 5인은 "정밀하게" 대신 "정직하게" 보여주는 쪽을 택했다.
 *
 * (참고: lib/wowy.ts의 WOWY_GROUP_MIN_MINUTES는 100/100/40/20으로 여기와 다르다. 그쪽은
 *  한 시즌·주인공 온코트 스틴트에서 즉석 집계한 조합이고 이쪽은 15시즌 통산 테이블이라
 *  분포 자체가 다른 표본이다. 값을 억지로 맞추면 둘 중 하나가 근거를 잃는다.)
 */
export const COMBO_MIN_MINUTES_BY_SIZE: Record<ComboSize, number> = { 2: 100, 3: 60, 4: 30, 5: 12 };

/** 크기당 화면에 남기는 조합 수. 네 크기를 한 화면에 같이 놓으므로 12행이 상한이다. */
export const COMBO_TOP_N = 3;

/**
 * 축소(shrinkage) 상수 K. 순위용 값 = net/40 × 분/(분 + K).
 *
 * 왜 필요한가: 임계값을 넘긴 것 중 net/40 내림차순으로 그냥 뽑으면 상위권이 통째로 노이즈가
 * 된다. 자밀 워니 4인 조합 실측 - 원시 순위 1위는 33분짜리 +46.7(±17)이고, 아래 축소 순위
 * 1위는 635분짜리 +14.2(±4)다. 앞쪽은 "22스틴트 동안 그랬다"는 말이고 뒤쪽은 커리어 열 시즌에
 * 걸친 기록이다. 표에 인쇄되는 숫자는 어느 쪽이든 원시 net/40이지만, 줄 세우는 값은 표본
 * 두께로 눌러 준 값이어야 한다.
 *
 * K의 근거(2026-09-04, lineup_combo 전체에서 직접 추정): 조합 net/40의 관측 분산에서
 * 노이즈 분산(≈100²/분)을 빼면 남는 게 "진짜로 다른" 몫(τ²)이다. 분 160 이상만 모아 재면
 *   n=2 관측 37.31 − 노이즈 27.63 = τ² 9.68 (τ≈3.1) → K = 100²/τ² ≈ 1,030
 *   n=3 관측 43.98 − 노이즈 36.26 = τ² 7.72 (τ≈2.8) → K ≈ 1,295
 *   n=4 관측 45.34 − 노이즈 41.54 = τ² 3.80 (τ≈2.0) → K ≈ 2,630
 *   n=5 관측 37.49 − 노이즈 43.76 = τ² 음수          → 참분산이 검출되지 않는다(104개 표본)
 * 그래서 K = 1200으로 하나만 둔다. 5인에 K=∞(전부 0으로 축소)를 쓰면 순위가 사실상 누적
 * 마진순으로 무너지고, 크기마다 다른 K를 쓰면 크기 간 비교가 불가능해진다. 1200은 측정 가능한
 * 두 크기(1,030·1,295)의 사이 값이고, 4·5인에는 관대한 쪽(덜 누르는 쪽)이다.
 * 과제 브리핑에 적힌 다른 경로 - 한 시즌 split-half r=+0.044(2인 100분) - 에서 스피어만-브라운으로
 * 역산해도 K≈1,090이 나온다. 서로 다른 두 방법이 1,000~1,300에서 만난 셈이다.
 *
 * 주의: 여기서 말하는 "진짜로 다른 몫"은 궁합의 증거가 아니다. 강팀의 주전 둘은 궁합과 무관하게
 * 온코트 마진이 높다. τ²는 그 팀 전력 차이까지 전부 포함한 값이다.
 */
export const COMBO_SHRINK_K = 1200;

/** net/40의 표준오차. lib/wowy.ts에서 그대로 가져온다(사이트 전체가 한 정의를 쓴다). */
export { NET40_SE_CONST };

/**
 * lineup_combo에서 실측한 노이즈 상수. wowy.ts가 25-26 한 시즌으로 잡은 100이 15시즌 통산
 * 테이블에서도 맞는지 다시 확인한 값이다(2026-09-04). 크기별로 분 버킷을 나눠
 * 관측분산 = τ² + c²·평균(1/분) 을 최소제곱으로 적합했을 때 c = 98.9 / 96.5 / 95.4 / 95.6.
 * 100은 조금 넉넉한 쪽(오차를 살짝 크게 부르는 쪽)이라 그대로 쓴다.
 */
export const COMBO_SE_CHECK = "n=2 98.9 · n=3 96.5 · n=4 95.4 · n=5 95.6";

/** 조합원 한 명(주인공 제외). 사진은 773명 중 31명만 있어서(실측) 폴백이 기본값이다. */
export type ComboMember = {
  pcode: string;
  name: string;
  href: string;
  photoUrl: string | null;
  /** 사진이 없을 때 원형 타일에 넣을 글자. 커리어 테이블이라 등번호는 붙일 수 없다. */
  initial: string;
};

export type ComboRow = {
  /** 주인공을 뺀 조합원 pcode를 정렬해 이은 값. React key. */
  key: string;
  size: ComboSize;
  members: ComboMember[];
  minutes: number;
  stints: number;
  netPer40: number;
  /** ±. 분만으로 정해진다 - net40Se 참고. */
  se: number;
  /**
   * 순위·막대 길이에 쓰는 값(부호는 항상 netPer40과 같은 방향).
   * 커리어(rankKind "shrunk")는 netPer40 × 분/(분+K) - 표본 두께로 누른 net/40.
   * 시즌(rankKind "minutes")은 함께 뛴 분 그 자체 - 한 시즌 표본으로는 net/40의 우열이
   * 재현되지 않아(아래 getPlayerSeasonCombos 주석) net/40 대신 표본 크기로 줄을 세운다.
   */
  rankValue: number;
  rankKind: "shrunk" | "minutes";
  /** |net/40| < se - 부호조차 의미가 없는 행. 색을 빼는 근거. */
  noisy: boolean;
};

export type ComboSizeBlock = {
  size: ComboSize;
  minMinutes: number;
  /** 임계값을 넘긴 조합 수(상위 COMBO_TOP_N개만 rows에 담긴다). */
  passed: number;
  rows: ComboRow[];
};

export type PlayerCombos = {
  blocks: ComboSizeBlock[];
  /** 어느 크기든 한 행이라도 있는가. 패널을 통째로 접을지 판단용. */
  any: boolean;
  /**
   * 조회 실패. 빈 결과("조합 없음")와 절대 같은 화면이 되면 안 된다.
   *
   * 이 값은 **호출부**(app/players/[pcode]/page.tsx의 `.catch`)가 만든다. 이 파일의 compute
   * 함수는 실패를 삼키지 않고 던진다 - 예전엔 compute 안에서 `{failed: true}`를 돌려줬는데,
   * 그 반환값이 cachedFn(unstable_cache)을 그대로 통과해 일시 장애가 TTL(커리어 6시간 · 시즌
   * 1시간) 동안 "불러오지 못함"으로 굳어 버렸다(감사 지적). 던지면 캐시엔 아무것도 안 남고
   * 다음 요청이 다시 시도한다.
   */
  failed: boolean;
};

/** 호출부 `.catch`용 실패 센티널. 매번 새 객체를 돌려준다(공유 객체를 어디선가 변형하지 않도록). */
export function failedCombos(): PlayerCombos {
  return { blocks: [], any: false, failed: true };
}

type ComboDbRow = { pcodes: string[]; minutes: number; stints: number; net_rating_per40: number };

/** 한 크기의 통과 조합 전부. 김선형 4인이 509행(실측)이라 1,000행 페이지 경계에 가깝다 - 병렬 페이지네이터로 받는다. */
async function fetchSizeRows(pcode: string, size: ComboSize): Promise<ComboDbRow[]> {
  return fetchAllPagesBounded<ComboDbRow>(
    (from, to) =>
      supabase
        .from("lineup_combo")
        .select("pcodes, minutes, stints, net_rating_per40", { count: "exact" })
        .contains("pcodes", [pcode])
        .eq("n", size)
        .gte("minutes", COMBO_MIN_MINUTES_BY_SIZE[size])
        .order("combo_key", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: ComboDbRow[] | null; error: unknown; count: number | null }>
  );
}

/**
 * 선수 한 명의 크기별 상위 조합.
 *
 * 조회는 크기 4개를 병렬로 한 번씩(콜드 실측: 크기 하나가 서버 22ms, 왕복 포함 150~200ms).
 * 이름·사진은 실제로 화면에 오르는 최대 12행의 조합원만 모아 한 번 더 조회한다 - 김선형처럼
 * 1,200개가 통과하는 선수도 이름 조회는 30명 안팎이다.
 */
/** 커리어 조합 - lineup_combo(142,756행)에서 뽑는다. 수동 build 때만 바뀐다. */
export const getPlayerCombos = cachedFn(computePlayerCombos, {
  name: "playerCombos",
  ttl: TTL.manualBuild,
  tags: (pcode) => [TAG.build, `player:${pcode}`],
});

async function computePlayerCombos(pcode: string): Promise<PlayerCombos> {
  // fetchAllPagesBounded는 재시도 후에도 실패하면 던진다(조용히 잘린 숫자를 화면에 올리지
  // 않으려는 그 파일의 규칙). 여기서 받아 `{failed: true}`로 바꾸면 안 된다 - 이 함수는
  // cachedFn 안이라 그 센티널이 6시간 캐시된다(PlayerCombos.failed 주석). 그대로 던지고,
  // 프로필 페이지를 500으로 만들지 않는 일은 호출부의 `.catch(failedCombos)`가 맡는다.
  const bySize: ComboDbRow[][] = await Promise.all(COMBO_SIZES.map((size) => fetchSizeRows(pcode, size)));

  // 1차 정렬·컷을 먼저 끝내고 이름을 붙인다(조회량을 12행 분량으로 줄이기 위해).
  const picked = COMBO_SIZES.map((size, i) => {
    const rows = bySize[i].map((r) => {
      const minutes = Number(r.minutes);
      const netPer40 = Number(r.net_rating_per40);
      return {
        pcodes: (r.pcodes ?? []).filter((p) => p !== pcode),
        minutes,
        stints: Number(r.stints),
        netPer40,
        se: net40Se(minutes),
        shrunk: (netPer40 * minutes) / (minutes + COMBO_SHRINK_K),
      };
    });
    // 축소값 내림차순. 동률(얇은 표본끼리)이면 분이 두꺼운 쪽을 위로 - 같은 값이면 덜 흔들리는
    // 표본이 위에 오는 게 이 표의 일관된 방향이다.
    rows.sort((a, b) => b.shrunk - a.shrunk || b.minutes - a.minutes);
    return { size, passed: rows.length, top: rows.slice(0, COMBO_TOP_N) };
  });

  const memberPcodes = Array.from(new Set(picked.flatMap((p) => p.top.flatMap((r) => r.pcodes))));
  const nameByPcode = new Map<string, string>();
  const photoByPcode = new Map<string, string>();
  if (memberPcodes.length) {
    const { data } = await supabase.from("players").select("pcode, name, photo_url").in("pcode", memberPcodes);
    for (const r of data ?? []) {
      nameByPcode.set(r.pcode as string, r.name as string);
      const url = r.photo_url as string | null;
      if (url) photoByPcode.set(r.pcode as string, url);
    }
  }

  const blocks: ComboSizeBlock[] = picked.map((p) => ({
    size: p.size,
    minMinutes: COMBO_MIN_MINUTES_BY_SIZE[p.size],
    passed: p.passed,
    rows: p.top.map((r) => {
      const members: ComboMember[] = r.pcodes.map((mp) => {
        const name = nameByPcode.get(mp) ?? mp;
        return {
          pcode: mp,
          name,
          href: `/players/${mp}`,
          photoUrl: photoByPcode.get(mp) ?? null,
          initial: (name || "?").slice(0, 1),
        };
      });
      return {
        key: [...r.pcodes].sort().join(","),
        size: p.size,
        members,
        minutes: r.minutes,
        stints: r.stints,
        netPer40: r.netPer40,
        se: r.se,
        rankValue: r.shrunk,
        rankKind: "shrunk" as const,
        noisy: Math.abs(r.netPer40) < r.se,
      };
    }),
  }));

  return { blocks, any: blocks.some((b) => b.rows.length > 0), failed: false };
}

// ── 시즌 범위 ─────────────────────────────────────────────────────────────────

/**
 * 시즌 범위 "최고의 조합". 그 시즌에 라인업 로그가 아예 없으면(개막 전, 혹은 그 선수가
 * 그 시즌에 출전하지 않음) null - "표본 미달"과 구분해야 화면이 "0개"와 "애초에 없음"을
 * 다른 문장으로 말할 수 있다.
 *
 * 임계값은 lib/wowy.ts의 WOWY_GROUP_MIN_MINUTES(2:100·3:100·4:40·5:20)를 그대로 쓴다 - 같은
 * 표본(한 시즌 온코트 스틴트)에서 나온 값이라 새로 재는 것보다 재사용이 맞다. WOWY는 "함께"와
 * "따로" 양쪽이 이 문턱을 넘어야 하지만 여기는 "함께"만 있으면 되므로 실제 통과율은 WOWY보다
 * 오히려 넉넉하다.
 */
export const getPlayerSeasonCombos = cachedFn(computeGetPlayerSeasonCombos, {
  name: "playerSeasonCombos",
  ttl: TTL.batchDaily,
  tags: (pcode, season) => [TAG.batch, TAG.season(season), `player:${pcode}`],
});

async function computeGetPlayerSeasonCombos(pcode: string, season: string): Promise<PlayerCombos | null> {
  const games = await getSeasonGames(season, { category: null });
  if (!games.length) return null; // 개막 전 등 - 그 시즌에 끝난 경기가 없음

  // 실패는 던진다(위 computePlayerCombos와 같은 이유 - cachedFn 안에서 센티널을 돌려주면
  // 일시 장애가 TTL.batchDaily 1시간 동안 캐시된다). 호출부가 `.catch(failedCombos)`로 받는다.
  const stints = await fetchSubjectStints(
    pcode,
    games.map((g) => g.gmkey)
  );
  if (!stints.length) return null; // 그 시즌 라인업 로그에 이 선수가 없음(출전 없음 등)

  // 스틴트마다 동료(최대 4명)의 부분집합을 세어 "함께"만 쌓는다 - lib/wowy.ts getWowy의
  // groupAcc와 같은 방식이지만 "따로"는 계산하지 않는다(이 패널에 필요 없다).
  type Acc = { members: string[]; sec: number; margin: number; stints: number };
  const bySize = new Map<number, Map<string, Acc>>(WOWY_GROUP_SIZES.map((s) => [s, new Map<string, Acc>()]));
  const bump = (size: number, key: string, members: string[], sec: number, margin: number) => {
    const map = bySize.get(size)!;
    const a = map.get(key) ?? { members, sec: 0, margin: 0, stints: 0 };
    a.sec += sec;
    a.margin += margin;
    a.stints += 1;
    map.set(key, a);
  };

  for (const s of stints) {
    const home = s.home_lineup ?? [];
    const away = s.away_lineup ?? [];
    const onHome = home.includes(pcode);
    const lineup = onHome ? home : away;
    if (!lineup.includes(pcode)) continue; // 방어(조회 조건상 도달하지 않음)
    const others = lineup.filter((p) => p !== pcode).sort();
    const margin = onHome ? num(s.home_pts) - num(s.away_pts) : num(s.away_pts) - num(s.home_pts);
    const sec = num(s.duration_sec);
    const n = others.length;

    for (const p of others) bump(2, p, [p], sec, margin);
    for (let mask = 1; mask < 1 << n; mask++) {
      let bits = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) bits++;
      if (bits < 2 || bits > 4) continue;
      const members: string[] = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) members.push(others[i]);
      bump(members.length + 1, members.join(","), members, sec, margin);
    }
  }

  const picked = WOWY_GROUP_SIZES.map((size) => {
    const minMinutes = WOWY_GROUP_MIN_MINUTES[size];
    const all = [...bySize.get(size)!.values()]
      .map((a) => {
        const minutes = a.sec / 60;
        return {
          members: a.members,
          minutes,
          stints: a.stints,
          netPer40: per40(a.margin, minutes),
          se: net40Se(minutes),
        };
      })
      .filter((r) => r.minutes >= minMinutes);
    // 함께 뛴 시간 내림차순 - net/40이 아니다(파일 상단 주석 참고). 동률이면 스틴트 수가
    // 많은 쪽을 위로(더 잘게 쪼개져 관측된 표본이 우연 하나에 덜 좌우된다).
    all.sort((x, y) => y.minutes - x.minutes || y.stints - x.stints);
    return { size: size as ComboSize, minMinutes, passed: all.length, top: all.slice(0, COMBO_TOP_N) };
  });

  const memberPcodes = Array.from(new Set(picked.flatMap((p) => p.top.flatMap((r) => r.members))));
  const nameByPcode = new Map<string, string>();
  const photoByPcode = new Map<string, string>();
  if (memberPcodes.length) {
    const { data } = await supabase.from("players").select("pcode, name, photo_url").in("pcode", memberPcodes);
    for (const r of data ?? []) {
      nameByPcode.set(r.pcode as string, r.name as string);
      const url = r.photo_url as string | null;
      if (url) photoByPcode.set(r.pcode as string, url);
    }
  }

  const blocks: ComboSizeBlock[] = picked.map((p) => ({
    size: p.size,
    minMinutes: p.minMinutes,
    passed: p.passed,
    rows: p.top.map((r) => {
      const members: ComboMember[] = r.members.map((mp) => {
        const name = nameByPcode.get(mp) ?? mp;
        return {
          pcode: mp,
          name,
          href: `/players/${mp}`,
          photoUrl: photoByPcode.get(mp) ?? null,
          initial: (name || "?").slice(0, 1),
        };
      });
      return {
        key: [...r.members].sort().join(","),
        size: p.size,
        members,
        minutes: r.minutes,
        stints: r.stints,
        netPer40: r.netPer40,
        se: r.se,
        rankValue: r.minutes,
        rankKind: "minutes" as const,
        noisy: Math.abs(r.netPer40) < r.se,
      };
    }),
  }));

  return { blocks, any: blocks.some((b) => b.rows.length > 0), failed: false };
}

/** 시즌 범위 최소 표본 문장(캡션용) - WOWY_GROUP_MIN_MINUTES를 그대로 인용한다. */
export const SEASON_COMBO_MIN_MINUTES_SENTENCE = WOWY_GROUP_SIZES.map(
  (s) => `${s}인 ${WOWY_GROUP_MIN_MINUTES[s]}분`
).join(" · ");
export const SEASON_COMBO_SE_SENTENCE = WOWY_GROUP_SIZES.map(
  (s) => `±${Math.round(NET40_SE_CONST / Math.sqrt(WOWY_GROUP_MIN_MINUTES[s]))}`
).join(" · ");
