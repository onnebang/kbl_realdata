import { unstable_cache } from "next/cache";
import type { GameStatus } from "./gameStatus";

// 서버 렌더 캐시 정책 한 곳 - 요청: "요청마다 10만회 시뮬을 돌리지 말고 / 경기목록부터,
// 개막리포트, 팀 자세히보기, 선수 자세히보기, 들은 내용이 정해져 있으니 한번에 로드하고 /
// 선수별 조합/실시간 중계 인터렉티브 정도만 실시간 계산이 필요할것 같은데".
//
// ── 왜 라우트 config가 아니라 함수 단위인가 (실측 2026-09-05) ────────────────────────
// `export const revalidate = 600` 을 라우트에 적어도 이 프로젝트에서는 아무 일도 일어나지
// 않는다. supabase-js가 내부에서 부르는 fetch(node_modules/@supabase/postgrest-js)가 cache
// 옵션 없이 호출되고, Next 15+에서 옵션 없는 fetch의 기본은 no-store다. 그 fetch 하나가
// 라우트를 통째로 동적으로 만든다. 그래서 /games/[gmkey]는 searchParams도 force-dynamic도
// 없는데 동적으로 렌더된다.
// 또 Next 16.3.3에서 `use cache`/cacheLife/cacheTag는 next.config의 cacheComponents를 켜야
// 쓸 수 있는데, 그걸 켜면 지금 코드베이스가 쓰는 dynamic/revalidate가 통째로 제거된다.
// => 지금 쓸 수 있는 건 unstable_cache 하나다. 문서가 "use cache로 대체됨"이라 적지만,
//    같은 문서가 "배포를 넘어 유지돼야 하는 데이터는 unstable_cache나 fetch 캐시를 쓰라"고
//    되돌려 보낸다(use cache의 키에는 빌드 ID가 들어가 배포마다 날아간다).
//
// ── 캐시하면 안 되는 것 ────────────────────────────────────────────────────────────
// 1. **라이브 경기.** 문자중계는 클라이언트가 마지막 event_order부터 이어 받는데(useLiveGame),
//    서버가 준 시드가 캐시돼 뒤처지면 그 사이 이벤트가 영구히 비는 구멍이 된다. TTL로는 못
//    고친다 - 라이브 경기 데이터는 아예 통과시킨다(gameTtl이 0을 돌려준다).
// 2. **개인화된 값.** 로그인·구독 상태(courtside_profiles / courtside_subscriptions)는 키에
//    사용자가 들어가야 하므로 이 헬퍼로 감싸지 마라. 남의 값이 새어 나간다.
// 3. **D-day 카운터** 같은 "지금 몇 시인가"에 의존하는 값.
//
// ── 반환값은 직렬화된다 ───────────────────────────────────────────────────────────
// unstable_cache는 결과를 Data Cache에 직렬화해 넣는다. **Map/Set/Date는 살아남지 못한다.**
// 감싸는 함수의 반환 타입에 Map이 있으면 캐시 히트 때 빈 객체가 되어 조용히 망가진다.
// (그래서 lib/strengthAdjustment.ts와 lib/seasonProjection.ts의 반환 타입에서 Map을 걷어냈다.)

/**
 * TTL(초). 숫자를 고치기 전에 "그 테이블이 언제 바뀌는가"를 먼저 확인할 것 -
 * 근거는 tools/daily_batch.py(매일 06:00 KST)와 각 build_*.py(수동 실행)다.
 */
export const TTL = {
  /** 라이브 경기 - 캐시 금지. */
  live: 0,
  /** 예정 경기: pregame_features는 daily_batch에서만 바뀐다. */
  scheduled: 600,
  /** 종료 경기: 정산이 끝나면 불변. */
  final: 86_400,
  /** daily_batch 산출물(박스스코어·슛로그·스틴트·로스터). */
  batchDaily: 3_600,
  /** build_*.py 산출물(lineup_combo, player_win_impact, strength_adjustment, import_slot...). 수동 실행. */
  manualBuild: 21_600,
  /** 준-상수(action_codes, teams, xpts_zone_table). */
  reference: 86_400,
} as const;

/** 경기 상태별 TTL. 라이브는 0 = 캐시하지 않는다. */
export function gameTtl(status: GameStatus): number {
  return status === "live" ? TTL.live : status === "final" ? TTL.final : TTL.scheduled;
}

/**
 * ttl <= 0 이면 캐시를 아예 통과시킨다. unstable_cache로 감싸고 revalidate:0을 주는 것과
 * 다르다 - 감싸는 순간 Data Cache 왕복과 실패 모드가 생긴다.
 *
 * keyParts는 이 값이 무엇에 따라 달라지는지 전부 담아야 한다. 빠뜨리면 다른 시즌·다른 팀의
 * 값이 섞여 나간다.
 */
export function cached<R>(fn: () => Promise<R>, keyParts: string[], ttl: number, tags: string[] = []): Promise<R> {
  if (ttl <= 0) return fn();
  return unstable_cache(guardSerializable(fn, keyParts), keyParts, { revalidate: ttl, tags })();
}

/**
 * Map/Set/Date가 섞인 값을 캐시에 넣으면 **미스일 땐 맞고 히트일 땐 틀리는** 버그가 된다.
 * 조용히 틀리느니 개발 중에 크게 터지는 게 낫다. 프로덕션에서는 검사하지 않는다(비용 0).
 */
function guardSerializable<R>(fn: () => Promise<R>, keyParts: string[]): () => Promise<R> {
  if (process.env.NODE_ENV === "production") return fn;
  return async () => {
    const value = await fn();
    const bad = findUnserializable(value, "", 0);
    if (bad) {
      throw new Error(
        `cached(${keyParts.join("/")})가 직렬화 불가능한 값을 돌려줬다: ${bad}. ` +
          `unstable_cache는 결과를 JSON으로 저장하므로 Map/Set/Date는 캐시 히트에서 사라진다. ` +
          `배열/객체로 바꾸거나 cachedMap()을 써라.`
      );
    }
    return value;
  };
}

function findUnserializable(v: unknown, path: string, depth: number): string | null {
  if (depth > 6 || v == null) return null; // 깊이 제한 - 순환 참조와 과한 비용을 피한다
  if (v instanceof Map) return `${path || "<root>"}: Map`;
  if (v instanceof Set) return `${path || "<root>"}: Set`;
  if (v instanceof Date) return `${path || "<root>"}: Date`;
  if (Array.isArray(v)) {
    // 배열은 앞 몇 개만 본다 - 같은 모양이 반복되므로 전수 검사는 낭비다.
    for (let i = 0; i < Math.min(v.length, 3); i++) {
      const hit = findUnserializable(v[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const hit = findUnserializable(val, path ? `${path}.${k}` : k, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Map을 돌려주는 함수를 캐시한다 - 엔트리 배열로 저장했다가 Map으로 되살린다.
 * 값(V) 안에 또 Map이 있으면 그건 여전히 안 된다(위 가드가 잡는다).
 */
export async function cachedMap<K extends string, V>(
  fn: () => Promise<Map<K, V>>,
  keyParts: string[],
  ttl: number,
  tags: string[] = []
): Promise<Map<K, V>> {
  if (ttl <= 0) return fn();
  const entries = await cached(async () => [...(await fn()).entries()], keyParts, ttl, tags);
  return new Map(entries);
}

/**
 * 인자를 받는 함수를 캐시 버전으로 감싼다. 인자가 곧 캐시 키가 되므로 **직렬화 가능한 인자만**
 * 받아야 하고, 반환값도 직렬화 가능해야 한다(위 주석 참고).
 */
export function cachedFn<A extends (string | number | boolean | null | undefined)[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { name: string; ttl: number; tags?: (...args: A) => string[] }
): (...args: A) => Promise<R> {
  return (...args: A) => {
    if (opts.ttl <= 0) return fn(...args);
    // cached()를 거쳐야 직렬화 가드가 같이 걸린다.
    return cached(
      () => fn(...args),
      [opts.name, ...args.map((a) => String(a ?? ""))],
      opts.ttl,
      opts.tags ? opts.tags(...args) : []
    );
  };
}

/** 태그 규약 - revalidateTag로 즉시 무효화할 때 쓴다. */
export const TAG = {
  game: (gmkey: string) => `game:${gmkey}`,
  season: (season: string) => `season:${season}`,
  /** daily_batch가 돌면 무효화할 것들. */
  batch: "batch:daily",
  /** build_*.py 산출물. */
  build: "manual:build",
  /** 역대 기록(record_entries) - tools/record_book.py가 경기 종료 정산 직후 무효화한다. */
  records: "records",
} as const;
