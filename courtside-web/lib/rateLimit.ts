// IP당 고정 창(fixed window) 레이트리밋. 비싼 공개 API와 Server Action이 실행 지점에서 쓴다.
//
// ── 이게 무엇이 아닌지부터 (정직하게) ────────────────────────────────────────────────
// 카운터가 **인스턴스 메모리**에 있다. Vercel에서는 요청이 어느 함수 인스턴스로 갈지 알 수 없고,
// 인스턴스는 유휴가 되면 통째로 사라진다. 그래서:
//   · 실효 한도 = limit x 그 순간 살아 있는 인스턴스 수. 정확한 상한이 아니다.
//   · 인스턴스가 죽으면 카운터도 0으로 돌아간다.
//   · 분산 IP·봇넷·의도적 동시성은 전혀 못 막는다.
// 막을 수 있는 것은 딱 이 둘이고, 이번 작업의 목표도 여기까지다:
//   (1) 실수로 루프를 도는 클라이언트(useEffect 의존성 사고, 재시도 폭주),
//   (2) 단일 커넥션으로 도는 단순 스크립트/크롤러.
// 진짜 상한(전역 카운터·엣지 차단)은 Vercel WAF의 일이다 - 코드로 만들 수 없어서 통합자에게
// 규칙을 넘긴다(verifyHints 참고). 이 파일은 그 앞에 세우는 1차 방어일 뿐이다.
//
// 고정 창을 쓴 이유: 토큰 버킷보다 상태가 작고(정수 2개), 창 경계에서 최대 2배까지 통과하는
// 단점이 있지만 위 (1)(2)를 막는 데는 충분하다. 어차피 인스턴스 분산 때문에 정밀도 자체가
// 의미 없는 상황에서 더 정교한 알고리즘을 넣는 건 비용만 늘린다.

/** 창 길이. 모든 한도가 "분당"으로 표현되므로 60초 고정. */
export const WINDOW_MS = 60_000;

/**
 * 맵이 무한히 자라지 않게 하는 상한. 초과하면 만료 항목부터 쓸고, 그래도 넘치면 통째로 비운다
 * (= 그 순간 모두에게 창이 리셋된다). **의도적으로 fail-open이다** - 메모리를 지키려고 정상
 * 사용자를 막는 것보다, 한 번 새는 편이 낫다. 조용히 삼키지 않도록 여기 적어 둔다.
 */
const MAX_KEYS = 10_000;

type Entry = { count: number; resetAt: number };

const buckets = new Map<string, Entry>();

export type RateLimitResult = {
  allowed: boolean;
  /** 429일 때 Retry-After에 넣을 초. 허용된 요청에서는 0. */
  retryAfterSec: number;
};

/**
 * key(보통 `${버킷}:${IP}`)에 대해 창당 limit회까지 허용한다.
 *
 * key에 버킷 이름을 반드시 넣을 것 - 페이지 요청과 POST가 같은 카운터를 공유하면 한도가
 * 뒤섞여 둘 다 틀린 값이 된다.
 */
export function rateLimit(key: string, limit: number, now: number = Date.now()): RateLimitResult {
  const hit = buckets.get(key);

  if (!hit || hit.resetAt <= now) {
    if (buckets.size >= MAX_KEYS) sweep(now);
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }

  hit.count += 1;
  if (hit.count <= limit) return { allowed: true, retryAfterSec: 0 };

  // 남은 창 길이를 올림해서 최소 1초. 0을 주면 클라이언트가 즉시 재시도해 폭주가 안 잡힌다.
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((hit.resetAt - now) / 1000)) };
}

/** 만료된 항목 정리. 그래도 상한을 못 맞추면 전부 버린다(위 MAX_KEYS 주석의 fail-open). */
function sweep(now: number): void {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
  if (buckets.size >= MAX_KEYS) buckets.clear();
}
