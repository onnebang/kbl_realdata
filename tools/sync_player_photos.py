"""players.photo_url 채우기 - KBL 공식 선수 사진(kbl.or.kr/files/kbl/players-photo/<pcode>.png).

배경(2026-09-03 실측): players 773명 전원 photo_url이 NULL이라 선수 디렉터리/프로필/포제션 피드가
전부 등번호 원형 폴백으로 나온다. 그런데 api.kbl.or.kr/players 명부의 img 필드가 선수마다
`https://kbl.or.kr/files/kbl/players-photo/{pcode}.png` 를 주고(현역 200명 전원, 고유 URL), 실제로
사진이 있는 선수는 진짜 PNG(자밀 워니 94KB)가 내려온다.

함정(embed_leader_photos.py에서 이미 겪음): 사진이 없는 선수도 200으로 "실루엣 플레이스홀더"가
내려온다 - 그것도 URL로 저장하면 서로 다른 선수 여러 명에게 같은 얼굴이 붙는다. 그래서 여기서는
바이트를 받아 sha256이 플레이스홀더와 같으면 NULL로 둔다(프론트가 등번호 폴백을 쓰게).

사용:
    python sync_player_photos.py --rostered-only        # 2026-2027 season_roster 선수만(213명, 빠름)
    python sync_player_photos.py                        # players 전원(773명, 수 분)
    python sync_player_photos.py --dry-run              # DB에 쓰지 않고 판별 결과만
    python sync_player_photos.py --force                # 이미 값이 있는 행도 다시 확인
"""
import argparse
import hashlib
import os
import sys
import time
import urllib.error
import urllib.request

import psycopg2
from psycopg2.extras import execute_values

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_roster import load_database_url  # noqa: E402
from cache_invalidate import revalidate  # noqa: E402

# embed_leader_photos.PLACEHOLDER_SHA256과 같은 값(그 모듈은 PIL을 최상단에서 import해서 여기서
# 가져오면 PIL 없는 인터프리터에서 죽는다 - 상수만 복제하고 출처를 적어둔다).
PLACEHOLDER_SHA256 = "4536e79b12c31da221be51fbf0d52958f0e92a1dc34e360a29768f3cf71157ff"

PHOTO_URL = "https://kbl.or.kr/files/kbl/players-photo/{pcode}.png"
DELAY_SEC = 0.25
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://www.kbl.or.kr/"}


def probe(pcode):
    """(status, url|None) - 'photo'면 실제 사진, 'placeholder'/'missing'/'error'면 None."""
    url = PHOTO_URL.format(pcode=pcode)
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        return ("missing" if e.code == 404 else "error"), None
    except Exception:  # noqa: BLE001
        return "error", None
    if not raw or not raw.startswith(b"\x89PNG") and not raw[:3] == b"\xff\xd8\xff":
        return "error", None
    if hashlib.sha256(raw).hexdigest() == PLACEHOLDER_SHA256:
        return "placeholder", None
    return "photo", url


def main():
    ap = argparse.ArgumentParser(description="players.photo_url 채우기(KBL 공식 사진, 플레이스홀더 제외)")
    ap.add_argument("--rostered-only", action="store_true", help="2026-2027 season_roster에 있는 선수만")
    ap.add_argument("--season", default="2026-2027")
    ap.add_argument("--force", action="store_true", help="이미 photo_url이 있는 행도 다시 확인")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = psycopg2.connect(load_database_url())
    cur = conn.cursor()
    if args.rostered_only:
        cur.execute("""
            select p.pcode, p.name, p.photo_url from players p
            join season_roster r on r.pcode = p.pcode and r.season_name = %s
            order by p.pcode
        """, (args.season,))
    else:
        cur.execute("select pcode, name, photo_url from players order by pcode")
    rows = cur.fetchall()
    # 아래 probe 루프가 수 분 걸리는 동안 놀던 연결은 서버가 끊는다(실측: 8분 뒤 UPDATE에서
    # "SSL connection has been closed unexpectedly"). 대상만 읽고 연결을 닫았다가 쓸 때 다시 연다.
    cur.close(); conn.close()
    targets = [r for r in rows if args.force or not r[2]]
    print("대상 %d명 (전체 %d, 이미 채워진 %d)" % (len(targets), len(rows), len(rows) - len(targets)))

    updates, counts = [], {"photo": 0, "placeholder": 0, "missing": 0, "error": 0}
    for i, (pcode, name, _) in enumerate(targets, 1):
        status, url = probe(pcode)
        counts[status] += 1
        if url:
            updates.append((pcode, url))
        if i % 25 == 0 or i == len(targets):
            print("  %d/%d  사진 %d · 플레이스홀더 %d · 없음 %d · 오류 %d" % (i, len(targets), counts["photo"], counts["placeholder"], counts["missing"], counts["error"]))
        time.sleep(DELAY_SEC)

    if args.dry_run:
        print("--dry-run: DB에 쓰지 않았다. 사진 확인된 %d명" % len(updates))
        return
    if updates:
        conn = psycopg2.connect(load_database_url())
        cur = conn.cursor()
        execute_values(cur, """
            update players as p set photo_url = v.url
            from (values %s) as v(pcode, url) where p.pcode = v.pcode
        """, updates)
        conn.commit()
        revalidate(["batch:daily"] + [f"player:{pcode}" for pcode, _ in updates])
    print("photo_url 갱신 %d명 (플레이스홀더 %d명은 NULL 유지)" % (len(updates), counts["placeholder"]))


if __name__ == "__main__":
    main()
