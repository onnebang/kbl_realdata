import { NextResponse } from "next/server";
import { supabaseServer, usingServerKey, serverKeyClaims, projectRef } from "@/lib/supabaseServer";

// 배포 점검용. "이 배포의 서버가 어느 키를 쓰고, 그 키가 **정말 이 프로젝트에서 동작하는가**"를
// curl 한 번으로 안다.
//
// 왜 이렇게까지 하는가 (2026-09-05, 같은 날 두 번의 사고):
//   1차: 서비스 키를 Vercel에 넣은 뒤 로그의 긍정 문구를 믿고 DB 락다운을 실행 -> 프로덕션
//        런타임은 공개 키였다(다른 프로젝트 kbl-realdata에 넣었었다). 500/404/빈화면, 즉시 롤백.
//   2차: 키 존재(usingServerKey=true)를 확인하고 락다운 실행 -> 이번엔 키 **값**이 이 프로젝트에
//        유효하지 않아 모든 쿼리가 401, 사이트 전체 500. 롤백해도 안 살아났다(락다운과 무관).
// 그래서 이 엔드포인트는 (a) 키의 JWT 클레임(role·ref)이 이 프로젝트와 맞는지, (b) 실제 쿼리
// 하나가 통과하는지까지 답한다. 비밀은 내보내지 않는다 - role 이름, ref, 에러 문구, 커밋 7자리뿐.
export const dynamic = "force-dynamic";

export async function GET() {
  const claims = serverKeyClaims();
  let probe: string;
  try {
    // 정책이 열려 있든 닫혀 있든 service_role이면 반드시 읽히는 테이블. 실패하면 에러 문구가
    // 곧 진단이다(예: "Invalid API key" = 다른 프로젝트 키 / 손상).
    const { data } = await supabaseServer.from("games").select("gmkey").limit(1);
    probe = data?.length ? "ok" : "ok(0행)";
  } catch (e) {
    probe = "error: " + (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  return NextResponse.json({
    keyPresent: usingServerKey,
    keyFormat: claims.format,
    keyRole: claims.role, // 기대값 "service_role"
    keyProjectRef: claims.ref,
    urlProjectRef: projectRef,
    keyMatchesProject: !!claims.ref && !!projectRef && claims.ref === projectRef,
    probe, // 기대값 "ok"
    // 이 셋이 전부 맞아야 락다운을 돌려도 된다.
    readyForLockdown: usingServerKey && claims.role === "service_role" && claims.ref === projectRef && probe.startsWith("ok"),
    vercelEnv: process.env.VERCEL_ENV ?? null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    checkedAt: new Date().toISOString(),
  });
}
