import { NextRequest, NextResponse } from "next/server";
import { getHeroPayload } from "@/lib/fansiteHero";
import { parseTeamParam } from "@/lib/fansiteHeroPayload";
import { rateLimit } from "@/lib/rateLimit";

// 팬사이트(Green Light)의 메인 히어로가 서버에서 부르는 읽기 전용 JSON. 쓰기 경로 없음, 값은 전부 공개 화면에 있는 것.
// CORS 헤더를 붙이지 않는다 - 브라우저가 아니라 팬사이트 서버가 읽는다.
// 진행 중 경기가 있으면 점수가 움직이므로 CDN 수명을 짧게(10초), 없으면 30초.
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  // 캐시를 비켜 가는 쿼리스트링으로 DB를 두드리는 단순 반복을 막는다(box-score 라우트와 같은 방식). 정상 호출은 분당 2회 안팎.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) {
    const { allowed, retryAfterSec } = rateLimit(`fansite-hero:${ip}`, 60);
    if (!allowed) {
      return NextResponse.json(
        { error: `Too Many Requests - ${retryAfterSec}초 뒤에 다시 시도해 주세요.` },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(retryAfterSec) } }
      );
    }
  }

  const tcode = parseTeamParam(req.nextUrl.searchParams.get("team"));
  if (!tcode) return NextResponse.json({ error: "bad request" }, { status: 400, headers: NO_STORE });

  let payload;
  try {
    payload = await getHeroPayload(tcode);
  } catch (e) {
    // 스택과 DB 문구는 서버 로그에만 남기고 응답에는 싣지 않는다.
    console.error("[fansite/hero]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "upstream error" }, { status: 502, headers: NO_STORE });
  }
  if (!payload) return NextResponse.json({ error: "not found" }, { status: 404, headers: NO_STORE });

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": payload.live
        ? "public, s-maxage=10, stale-while-revalidate=30"
        : "public, s-maxage=30, stale-while-revalidate=120",
      "X-Robots-Tag": "noindex",
    },
  });
}
