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

if (!serverKey && process.env.NODE_ENV !== "test") {
  // 값은 절대 찍지 않는다 - 어느 키를 쓰는지만.
  console.warn(
    "[supabaseServer] SUPABASE_SERVICE_ROLE_KEY가 없어 공개 키로 폴백합니다. " +
      "이 상태에서는 DB 정책을 좁히면 안 됩니다(사이트 전체가 읽기 불가가 됩니다)."
  );
}

/** 서버 컴포넌트·Server Action·라우트 핸들러 전용. 클라이언트 컴포넌트에서 import 금지. */
export const supabaseServer = createClient(url, serverKey ?? fallbackKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** 지금 서버가 전용 키를 쓰고 있는가 - 배포 점검용. */
export const usingServerKey = !!serverKey;
