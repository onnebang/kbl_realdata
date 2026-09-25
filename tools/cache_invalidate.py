# -*- coding: utf-8 -*-
"""courtside-web의 Next.js Data Cache 무효화 - Supabase에 쓰는 모든 스크립트가 커밋 직후 호출.

**왜 필요한가**: unstable_cache는 배포와도 무관하게 유지된다(courtside-web/lib/cachePolicy.ts
상단 주석) - Supabase에 새 데이터를 써도 그 데이터를 읽는 캐시된 페이지는 TTL(최대
24시간)이 지날 때까지 옛 값을 계속 보여준다. 2026-09-24~25에 이걸로 실제 버그 2건(경기
종료 직후 박스스코어 공백, 로스터 사진 미표시)이 사용자에게 노출됐다.

**best-effort다** - 이 호출이 실패해도 절대 예외를 던지지 않는다. DB 쓰기는 이미 끝난
뒤이므로, 실패하면 그냥 오늘까지의 동작(TTL 만료까지 대기)으로 돌아갈 뿐 - 새로운 실패
모드를 호출부(daily_batch.py 등)에 추가하지 않는다.

**토큰**: REVALIDATE_TOKEN 환경변수(GitHub Actions secret) 또는 tools/.env.supabase 파일.
**os.environ에 이미 있을 거라고 가정하지 않는다** - 이 모듈을 쓰는 19개 스크립트 중 15개는
sync_upcoming_games.load_env_supabase()가 아니라 import_roster.load_database_url()로 DB
자격증명을 읽는데, 그 함수는 DATABASE_URL 값만 돌려주고 os.environ은 전혀 안 건드린다(실제로
겪음 - build_roster_changes.py 재실행 시 REVALIDATE_TOKEN이 안 보임). 그래서 이 모듈이
직접, 독립적으로 .env.supabase를 읽는다 - 누가 먼저 뭘 로드했는지에 의존하지 않음.
없으면 조용히 건너뛴다(예전 동작 = TTL 만료 대기로 자연 후퇴).

사용법:
    from cache_invalidate import revalidate
    revalidate([f"game:{gmkey}", "batch:daily"])
"""
import io
import json
import os
import urllib.error
import urllib.request

SITE_URL = os.environ.get("REVALIDATE_SITE_URL", "https://courtside-web-ten.vercel.app")
TIMEOUT_SEC = 5
_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.supabase")


def _find_token():
    token = os.environ.get("REVALIDATE_TOKEN")
    if token:
        return token
    if not os.path.exists(_ENV_PATH):
        return None
    for line in io.open(_ENV_PATH, encoding="utf-8"):
        line = line.strip()
        if line.startswith("REVALIDATE_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def revalidate(tags):
    """tags: 문자열 리스트(예: ["game:S49G14N3", "batch:daily"]). 성공하면 True, 실패해도
    예외 없이 False만 돌려줌 - 호출부는 반환값을 무시해도 안전."""
    if not tags:
        return True
    token = _find_token()
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
