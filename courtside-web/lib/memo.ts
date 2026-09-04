// 프로세스 안 짧은 수명 메모 - 요청마다 다시 계산할 이유가 없는 값을 위해.
//
// ── 왜 필요한가 ────────────────────────────────────────────────────────────────
// 이 사이트의 라우트는 대부분 force-dynamic이다(CLAUDE.md: "반드시 라이브 Supabase 쿼리").
// 그건 "매 요청 DB를 본다"는 뜻이지 "매 요청 같은 계산을 다시 한다"는 뜻이 아니다.
// 실측(2026-09-05): 개막 리포트의 54경기 시뮬레이션은 10만 회 × 2 시나리오라 dev 서버에서
// 요청당 30초 넘게 CPU를 먹었다(SIMS를 2,000으로 낮추면 8초 = DB 왕복만 남는다).
// 그 값은 같은 시즌·같은 배치 결과에서 항상 같으므로, 짧게 메모해 두면 첫 요청만 비용을 낸다.
//
// ── 설계 규약 ─────────────────────────────────────────────────────────────────
// · **프로세스 로컬이다.** 서버리스 인스턴스마다 따로 데워진다. 그래서 TTL이 짧아도 되고,
//   반대로 "전 유저에게 같은 값을 보장"하는 용도로는 쓸 수 없다.
// · **동시 요청을 합친다.** 10명이 동시에 들어와도 계산은 한 번만 돈다(in-flight 공유).
//   오픈 직후 트래픽이 몰릴 때 이게 TTL보다 더 크게 작동한다.
// · **실패는 캐시하지 않는다.** DB가 잠깐 죽었을 때 그 실패를 TTL 동안 물고 있으면 안 된다.
// · **개인화된 값에 쓰지 마라.** 로그인·구독 상태처럼 사용자마다 다른 값을 이 메모에 넣으면
//   다른 사람의 값이 새어 나간다. 키에 사용자 식별자가 들어가야 하는 값이면 쓰지 마라.
// · 키 수에 상한을 둔다 - 시즌·팀·선수처럼 값이 무한히 늘어날 수 있는 키에서 메모리가 새지 않게.

type Entry<R> = { value: R; expires: number };

const MAX_KEYS = 64;

export type MemoOptions<A extends unknown[]> = {
  /** 이 이름으로 캐시 공간이 갈린다. 함수마다 유일해야 한다. */
  name: string;
  /** 살아 있는 시간(ms). */
  ttlMs: number;
  /** 인자를 캐시 키로. 기본은 JSON. 개인화된 값이 들어가면 안 된다. */
  key?: (...args: A) => string;
};

/**
 * 같은 인자로 부르면 ttlMs 동안 같은 결과를 돌려주고, 동시에 들어온 호출은 하나로 합친다.
 * 반환 값은 **공유되는 참조**다 - 호출한 쪽에서 변형하면 다음 사람에게도 보인다. 읽기만 할 것.
 */
export function memoAsync<A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts: MemoOptions<A>) {
  const done = new Map<string, Entry<R>>();
  const inflight = new Map<string, Promise<R>>();

  return async (...args: A): Promise<R> => {
    const key = opts.key ? opts.key(...args) : JSON.stringify(args);
    const now = Date.now();

    const hit = done.get(key);
    if (hit && hit.expires > now) return hit.value;

    const running = inflight.get(key);
    if (running) return running; // 동시 요청은 계산을 나눠 갖는다

    const p = fn(...args)
      .then((value) => {
        // 오래된 키부터 버린다(삽입 순서 = Map의 순회 순서).
        if (done.size >= MAX_KEYS) {
          const oldest = done.keys().next();
          if (!oldest.done) done.delete(oldest.value);
        }
        done.set(key, { value, expires: Date.now() + opts.ttlMs });
        return value;
      })
      .finally(() => {
        inflight.delete(key); // 실패는 캐시하지 않는다 - 다음 요청이 다시 시도한다
      });

    inflight.set(key, p);
    return p;
  };
}
