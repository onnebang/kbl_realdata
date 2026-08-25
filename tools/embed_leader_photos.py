"""
문자중계 피드 + Game Leaders 카드용 선수 실사진 임베딩.

2026-08-25 확장: 처음엔 팀별 득점/리바운드/어시스트 1위(약 40명)만 다운받았는데, 사용자가
"중계에서 관련된 선수 이름과 얼굴이 같이 나오게" 요청 - 피드에 뜨는 대부분의 선수가 리더가
아니라서 40명으로는 커버가 안 됨. 10경기 전체 로스터(185명, 사용자 확인 후 진행 - 장당
압축후 약 6KB로 총 ~1.2MB)로 범위를 넓힘. kbl.or.kr의 공개 선수 사진을 내려받아 base64
data URI로 변환, GAME.players[pcode].photo에 주입한다. 그래도 로스터에 없는 극단적 케이스
(예: 코칭스태프 관련 이벤트)는 프론트에서 등번호 원형 아이콘으로 자연스럽게 폴백.
"""
import base64
import hashlib
import io
import json
import os
import urllib.request

from PIL import Image

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")

# kbl.or.kr는 실사진이 없는 선수도 항상 200을 내려주는데, 그 경우 전부 이 정확히 같은
# 실루엣 플레이스홀더 이미지(4536e79b...)를 서빙함 - 처음엔 "실제 사진 다운로드 성공"으로
# 오판해서 서로 다른 선수 여러 명에게 똑같은 아이콘이 붙는 버그가 났음(예: 배병준/캐디 라렌/
# 코피 코번이 전부 동일 이미지). 해시로 걸러서 이 경우엔 프론트의 등번호 원형 폴백을 쓰게 함.
PLACEHOLDER_SHA256 = "4536e79b12c31da221be51fbf0d52958f0e92a1dc34e360a29768f3cf71157ff"
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
DEMO_PATH = os.path.join(ANALYSIS_DIR, "live_replay_demo.json")


def find_roster_pcodes(gmkeys):
    roster = set()
    img_url = {}
    for gmkey in gmkeys:
        path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
        with open(path, encoding="utf-8") as f:
            rows = json.load(f)
        for row in rows:
            pcode = row["player"]["pcode"]
            roster.add(pcode)
            if row["player"].get("img"):
                img_url[pcode] = row["player"]["img"]
    return roster, img_url


def sniff_mime(raw):
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return None


THUMB_WIDTH = 120  # 카드에 쓰는 원형 썸네일용 - 원본은 470x609라 그대로 넣기엔 너무 큼


def download_as_data_uri(url, timeout=10):
    # kbl.or.kr는 실제 PNG인데도 Content-Type을 application/binary로 잘못 내려주는 경우가
    # 있어서(관측: player-stat.json img URL 전수 중 다수), 헤더 대신 매직바이트로 판별.
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    if hashlib.sha256(raw).hexdigest() == PLACEHOLDER_SHA256:
        return None
    mime = sniff_mime(raw)
    if not mime:
        return None
    # 원본이 470x609처럼 커서(선수마다 다름) 카드용 120px 썸네일로 축소 후 JPEG 재인코딩
    # (사진은 투명배경이 필요없고 JPEG가 PNG보다 훨씬 작아 40명 합쳐도 용량 여유 있음)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    ratio = THUMB_WIDTH / img.width
    img = img.resize((THUMB_WIDTH, round(img.height * ratio)), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=82)
    b64 = base64.b64encode(out.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def main():
    with open(DEMO_PATH, encoding="utf-8") as f:
        data = json.load(f)
    gmkeys = list(data["games"].keys())

    print("로스터 전체 파악 중...", flush=True)
    roster, img_url = find_roster_pcodes(gmkeys)
    print(f"  대상 {len(roster)}명 (사진 URL 확보 {len(img_url)}명)", flush=True)

    photos = {}
    fail = []
    for i, pcode in enumerate(sorted(roster), 1):
        url = img_url.get(pcode)
        if not url:
            fail.append(pcode)
            continue
        try:
            data_uri = download_as_data_uri(url)
            if data_uri:
                photos[pcode] = data_uri
            else:
                fail.append(pcode)
        except Exception as e:
            fail.append(pcode)
        if i % 20 == 0:
            print(f"  {i}/{len(roster)}...", flush=True)

    print(f"성공 {len(photos)}명, 실패 {len(fail)}명 {fail}", flush=True)
    total_bytes = sum(len(v) for v in photos.values())
    print(f"총 base64 용량: {total_bytes/1024:.0f}KB", flush=True)

    injected = 0
    for gmkey, g in data["games"].items():
        for pcode, pinfo in g.get("players", {}).items():
            if pcode in photos:
                pinfo["photo"] = photos[pcode]
                injected += 1

    with open(DEMO_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"완료 - {injected}건 주입, {DEMO_PATH} 갱신", flush=True)


if __name__ == "__main__":
    main()
