import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

// Python 쓰기 스크립트(tools/cache_invalidate.py)가 Supabase 커밋 직후 호출하는 엔드포인트.
// unstable_cache는 배포와 무관하게 유지되므로(lib/cachePolicy.ts 상단 주석) 데이터가 바뀌어도
// 아무도 revalidateTag를 안 부르면 TTL(최대 24시간)이 지나야 반영됐다 - 2026-09-24~25에 이걸로
// 실제 버그 2건(경기 종료 직후 박스스코어 공백, 로스터 사진 미표시)이 사용자에게 노출됨.
//
// 태그 형식은 검증하지 않는다 - lib/cachePolicy.ts의 TAG 객체(game/season/batch/build)뿐
// 아니라 여러 파일이 이미 개별적으로 쓰는 `player:${pcode}`/`team:${tcode}` 같은 인라인
// 문자열 태그도 그대로 통과시켜야 하므로, 정해진 스킴 없이 문자열 배열을 그대로 revalidateTag에
// 넘긴다.
export const dynamic = "force-dynamic";
const MAX_TAGS = 100;

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token !== process.env.REVALIDATE_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const tags = (body as { tags?: unknown } | null)?.tags;
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > MAX_TAGS || !tags.every((t) => typeof t === "string")) {
    return NextResponse.json({ error: `tags must be an array of 1-${MAX_TAGS} strings` }, { status: 400 });
  }

  // Next 16의 revalidateTag는 2번째 인자(cacheLife 프로필/{expire})가 필수가 됨 - "use cache"
  // 계열 캐시를 위한 인자지만, 이 앱은 unstable_cache(태그 기반)만 쓰므로(cachePolicy.ts 상단
  // 주석) { expire: 0 }으로 "지금 즉시"를 명시해 넘긴다. 아래 검증 단계(라우트 curl 테스트)에서
  // 실제로 unstable_cache 태그가 풀리는지 확인할 것 - 타입만으로는 이 인자가 unstable_cache
  // 항목에도 적용되는지 보장이 안 됨.
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  return NextResponse.json({ revalidated: tags });
}
