import { createClient } from "@supabase/supabase-js";

// 서버 전용 Supabase 클라이언트 - **브라우저로 절대 나가면 안 된다.**
//
// ── 왜 나눴는가 (실측 2026-09-05) ─────────────────────────────────────────────────
// lib/supabase.ts는 NEXT_PUBLIC_ 접두사가 붙은 공개 키를 쓴다. 그 접두사는 "브라우저 번들에
// 넣어도 된다"는 뜻이고, 실제로 프로덕션 청크에서 키를 꺼내 PostgREST와 Realtime 웹소켓에
// 직접 붙을 수 있음이 확인됐다. 그 키에 걸린 RLS 정책이 전 테이블 `using (true)`라
// 240만 행짜리 플레이바이플레이를 포함한 DB 전체가 그대로 읽힌다.
//
// 브라우저가 Supabase를 진짜로 필요로 하는 곳은 **진행 중인 경기의 문자중계 하나**뿐이다
// (lib/useLiveGame.ts, components/LiveGameTransport.tsx에서 지연 로딩). 나머지 36개 파일은
// 전부 서버에서만 돈다. 그래서 서버는 이 클라이언트를 쓰고, 브라우저 키가 볼 수 있는 범위는
// DB 정책에서 라이브 중계에 필요한 세 테이블(games / game_events / players)로 좁힌다.
//
// ── 키가 아직 없을 때 ─────────────────────────────────────────────────────────────
// SUPABASE_SERVICE_ROLE_KEY가 없으면 공개 키로 폴백한다. 지금까지와 똑같이 동작하므로
// 배포 순서를 지킬 수 있다: (1) 이 코드를 먼저 배포 -> (2) 서버 전용 키를 환경변수에 추가
// -> (3) 그다음에 DB 정책을 좁힌다. 순서를 바꾸면 (3)에서 사이트 전체가 죽는다.
// 폴백 중임을 서버 로그에 한 번만 남긴다 - 조용히 넘어가면 (3)을 언제 해도 되는지 알 수 없다.
//
// ── 이 키의 성격 ─────────────────────────────────────────────────────────────────
// service_role 키는 RLS를 **우회한다.** 그래서 이 클라이언트로는 사용자별 테이블
// (courtside_profiles / courtside_subscriptions)을 절대 조회하지 마라 - RLS가 막아주지
// 않으므로 코드가 직접 사용자를 걸러야 하고, 한 번 실수하면 남의 데이터가 나간다.
// 현재 서버 코드는 그 두 테이블을 전혀 읽지 않는다(전수 확인). 그 상태를 유지할 것.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serverKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const fallbackKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (process.env.NODE_ENV !== "test") {
  // 값은 절대 찍지 않는다 - 어느 키를 쓰는지만. 두 경우 모두 찍는 이유: "경고가 없다"는 부재
  // 신호는 다른 배포의 로그를 보고 있어도 성립해서 약하다. 실제로 2026-09-05 Vercel 로그에서
  // 폴백 경고를 발견해 락다운을 막았고, 그 다음 단계(키가 들어갔는지)는 긍정 신호로 확인해야 했다.
  if (serverKey) {
    console.log("[supabaseServer] 서버 전용 키(SUPABASE_SERVICE_ROLE_KEY) 사용 중 - DB 정책을 좁혀도 됩니다.");
  } else {
    console.warn(
      "[supabaseServer] SUPABASE_SERVICE_ROLE_KEY가 없어 공개 키로 폴백합니다. " +
        "이 상태에서는 DB 정책을 좁히면 안 됩니다(사이트 전체가 읽기 불가가 됩니다)."
    );
  }
}

// ── 일시적 실패는 던지기 전에 다시 해본다 ─────────────────────────────────────────
//
// 아래에서 쿼리 실패를 예외로 바꾼다. 그러면 패널 하나가 잠깐 삐끗해도 페이지 전체가 오류
// 화면이 되므로, 그 전에 "정말 안 되는 것"과 "한 번 삐끗한 것"을 갈라야 한다.
//
// 읽기(GET/HEAD)만 재시도한다 - 재실행해도 결과가 같기 때문이다. 쓰기는 절대 재시도하지
// 않는다(지금 서버 코드에 쓰기는 없지만, 나중에 생겨도 여기서 두 번 실행되면 안 된다).
// 4xx는 재시도해도 똑같으므로 그냥 통과시켜 위에서 던지게 둔다 - 그건 코드 버그다.
//
// 대기 시간은 짧게 잡았다(150ms, 400ms). 이건 서버 렌더 중에 실제로 사용자를 기다리게
// 하는 시간이라, 최악이어도 0.55초 안에 끝나야 한다.
const RETRY_DELAYS_MS = [150, 400];

const retryingFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  const fetchInit: RequestInit = { ...init, cache: "no-store" };
  let lastErr: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(input, fetchInit);
      if (!idempotent || res.status < 500 || attempt >= RETRY_DELAYS_MS.length) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      // 네트워크 자체가 끊긴 경우. 재시도 대상이 아니면 그대로 올린다.
      if (!idempotent || attempt >= RETRY_DELAYS_MS.length) throw e;
      lastErr = e;
    }
    console.warn(`[supabaseServer] 재시도 ${attempt + 1}/${RETRY_DELAYS_MS.length}: ${String(lastErr)}`);
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
};

const client = createClient(url, serverKey ?? fallbackKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: retryingFetch },
});

// ── 실패를 조용히 삼키지 않는다 ───────────────────────────────────────────────────
//
// 문제(실측): 서버 코드의 `await supabase.from(...)` 221곳 중 error를 받는 곳이 22곳,
// 그 error를 실제로 보는 곳은 8곳이고 그 8곳도 전부 `if (error || !data) return null`처럼
// 그냥 삼킨다. 즉 **DB가 죽어도 페이지는 HTTP 200에 "데이터가 아직 없습니다"를 그린다.**
// 사용자 입장에서 "일시적 장애"와 "원래 데이터가 없는 화면"이 구분되지 않는다 - 오픈
// 직후에 이게 나면 사용자는 사이트가 비어 있다고 결론 내리고 떠난다.
//
// 고치는 방법: 호출부 221곳을 손대는 대신 클라이언트 쪽에서 한 번에 막는다.
// postgrest-js의 throwOnError()는 **error가 실제로 있을 때만** 던진다(소스 확인:
// PostgrestBuilder.ts:569 `if (error && this.shouldThrowOnError)`). 특히
// maybeSingle()의 "0행"은 error 없이 data=null이라 그대로 통과한다 - 정상적인 빈 결과와
// 진짜 실패가 섞이지 않는다.
//
// 플래그는 체인 끝까지 산다: throwOnError()가 자기 자신을 돌려주고 이후 .eq()/.order()/
// .range()도 전부 this를 돌려주기 때문에, select() 직후 한 번만 켜면 된다.
//
// 타입은 그대로 둔다(as로 원래 타입 유지). throwOnError()의 진짜 반환 타입은 data가
// non-null이 되는 별도 타입인데, 그걸 노출하면 기존 `?? []` 221곳이 전부 "쓸모없는 병합"
// 경고가 된다. 던지는 동작만 켜고 타입은 건드리지 않는 게 이 단계에서 맞다.
type Thrower = { throwOnError: () => unknown };
const strict = <T,>(builder: T): T => {
  const b = builder as unknown as Partial<Thrower>;
  if (typeof b.throwOnError === "function") b.throwOnError();
  return builder;
};

/** from()이 돌려주는 쿼리 빌더 - select/insert/update/upsert/delete 결과에 strict를 건다. */
const QB_METHODS = ["select", "insert", "update", "upsert", "delete"] as const;

/** 서버 컴포넌트·Server Action·라우트 핸들러 전용. 클라이언트 컴포넌트에서 import 금지. */
export const supabaseServer = new Proxy(client, {
  get(target, prop, receiver) {
    if (prop === "from") {
      return (table: string) => {
        const qb = target.from(table);
        return new Proxy(qb, {
          get(qbTarget, qbProp, qbReceiver) {
            const v = Reflect.get(qbTarget, qbProp, qbReceiver);
            if (typeof v === "function" && (QB_METHODS as readonly string[]).includes(String(qbProp))) {
              return (...args: unknown[]) =>
                strict((v as (...a: unknown[]) => unknown).apply(qbTarget, args));
            }
            return typeof v === "function" ? v.bind(qbTarget) : v;
          },
        });
      };
    }
    if (prop === "rpc") {
      return (...args: unknown[]) =>
        strict((target.rpc as unknown as (...a: unknown[]) => unknown).apply(target, args));
    }
    const v = Reflect.get(target, prop, receiver);
    return typeof v === "function" ? v.bind(target) : v;
  },
}) as typeof client;

/** 지금 서버가 전용 키를 쓰고 있는가 - 배포 점검용. **존재**만 본다(아래 serverKeyClaims 참고). */
export const usingServerKey = !!serverKey;

/** NEXT_PUBLIC_SUPABASE_URL의 프로젝트 ref(호스트 첫 조각). 키의 ref 클레임과 맞는지 대조용. */
export const projectRef: string | null = (() => {
  try {
    return new URL(url).hostname.split(".")[0] ?? null;
  } catch {
    return null;
  }
})();

/**
 * 서버 키의 JWT 클레임(role / ref)만 읽는다 - **키 값은 이 모듈 밖으로 절대 내보내지 않는다.**
 *
 * 왜 필요한가(2026-09-05 사고 2차): usingServerKey가 true여도 값이 **다른 Supabase 프로젝트의 키**
 * 이거나 손상된 값이면 모든 쿼리가 401이 되어 사이트 전체가 500이 된다. 존재 여부만으로는 이걸
 * 못 잡았다. Supabase JWT 키는 payload에 role("anon"/"service_role")과 ref(프로젝트)를 담으므로
 * 서명 검증 없이 payload만 디코드해도 "어느 프로젝트의 어떤 역할 키인가"는 알 수 있다.
 * 새 형식(sb_secret_...)은 JWT가 아니라 format="other"로 답한다.
 */
export function serverKeyClaims(): { format: "missing" | "jwt" | "other"; role: string | null; ref: string | null } {
  if (!serverKey) return { format: "missing", role: null, ref: null };
  const parts = serverKey.split(".");
  if (parts.length !== 3) return { format: "other", role: null, ref: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: string; ref?: string };
    return { format: "jwt", role: payload.role ?? null, ref: payload.ref ?? null };
  } catch {
    return { format: "other", role: null, ref: null };
  }
}
