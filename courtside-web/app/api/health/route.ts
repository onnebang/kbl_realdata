import { NextResponse } from "next/server";
import { usingServerKey } from "@/lib/supabaseServer";

// 배포 점검용. "이 배포의 서버가 어느 키를 쓰는가"를 curl 한 번으로 안다.
//
// 왜 필요한가 (2026-09-05 실제 사고): 서비스 키를 Vercel에 넣은 뒤 로그의 긍정 문구를 보고
// DB 락다운 SQL을 실행했는데, 프로덕션 런타임은 여전히 공개 키였다(그 로그는 다른 배포/빌드의
// 것이었다). 사이트가 500/404/빈화면이 됐고 즉시 롤백했다. "로그를 올바로 읽었는가"에
// 기대지 않고, **지금 프로덕션 도메인이 답하는 값**을 보기 위한 엔드포인트다.
//
// 비밀은 하나도 내보내지 않는다 - 키 사용 여부(boolean), Vercel 환경 이름, 커밋 7자리뿐이다.
// force-dynamic: 빌드 때 값이 굳지 않고 매 요청 그 배포의 런타임 값을 답한다.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    usingServerKey,
    // production / preview / development - 프리뷰 배포의 답을 프로덕션으로 착각하지 않게.
    vercelEnv: process.env.VERCEL_ENV ?? null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    checkedAt: new Date().toISOString(),
  });
}
