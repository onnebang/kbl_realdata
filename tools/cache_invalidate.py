# -*- coding: utf-8 -*-
"""courtside-web의 Next.js Data Cache 무효화 - Supabase에 쓰는 모든 스크립트가 커밋 직후 호출.

**왜 필요한가**: unstable_cache는 배포와도 무관하게 유지된다(courtside-web/lib/cachePolicy.ts
상단 주석) - Supabase에 새 데이터를 써도 그 데이터를 읽는 캐시된 페이지는 TTL(최대
24시간)이 지날 때까지 옛 값을 계속 보여준다. 2026-09-24~25에 이걸로 실제 버그 2건(경기
종료 직후 박스스코어 공백, 로스터 사진 미표시)이 사용자에게 노출됐다.

**best-effort다** - 이 호출이 실패해도 절대 예외를 던지지 않는다. DB 쓰기는 이미 끝난
뒤이므로, 실패하면 그냥 오늘까지의 동작(TTL 만료까지 대기)으로 돌아갈 뿐 - 새로운 실패
모드를 호출부(daily_batch.py 등)에 추가하지 않는다.

**토큰**: REVALIDATE_TOKEN 환경변수(GitHub Actions secret 또는 tools/.env.supabase) -
sync_upcoming_games.load_env_supabase()가 이미 .env.supabase를 로드해두면 그대로 쓰임.
없으면 조용히 건너뛴다(예전 동작 = TTL 만료 대기로 자연 후퇴).

사용법:
    from cache_invalidate import revalidate
    revalidate([f"game:{gmkey}", "batch:daily"])
"""
import json
import os
import urllib.error
import urllib.request

SITE_URL = os.environ.get("REVALIDATE_SITE_URL", "https://courtside-web-ten.vercel.app")
TIMEOUT_SEC = 5


def revalidate(tags):
    """tags: 문자열 리스트(예: ["game:S49G14N3", "batch:daily"]). 성공하면 True, 실패해도
    예외 없이 False만 돌려줌 - 호출부는 반환값을 무시해도 안전."""
    if not tags:
        return True
    token = os.environ.get("REVALIDATE_TOKEN")
    if not token:
        print("[revalidate] REVALIDATE_TOKEN 없음 - 건너뜀(.env.supabase 또는 GH Actions secret 확인)", flush=True)
        return False
    req = urllib.request.Request(
        f"{SITE_URL}/api/revalidate",
        data=json.dumps({"tags": tags}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            resp.read()
        print(f"[revalidate] {len(tags)}개 태그 무효화: {tags}", flush=True)
        return True
    except Exception as e:  # noqa: BLE001 - best-effort, 절대 호출부를 깨면 안 됨
        print(f"[revalidate] 실패(무시하고 계속): {e}", flush=True)
        return False
