"""
실제 KBL 팀 로고 임베딩 (2026-08-25, 사용자 재요청 - "nba스타일처럼 팀 로고도 있어야함").

이전엔 kbl.or.kr의 팀 로고 경로를 여러 패턴으로 시도했지만 전부 실패했었음(README 4차 확장
기록 참고) - 그때는 정적 파일 경로를 추측했는데, 실제로는 kbl.or.kr이 SPA라 어떤 경로로
요청해도 같은 앱 셸 HTML(5175바이트)만 돌아와서 전부 "가짜 200"이었음.

이번엔 실제 프론트엔드 번들(assets/index-*.js)을 받아서 로고가 `teamLogoClassInfo` 배열 +
`ic-emblem.{code}` CSS 클래스(assets/css/ico.css)로 구현돼있는 걸 발견 - 진짜 이미지 경로는
`/assets/img/ico/logo/ic-{code}.svg`. tcode -> 코드 매핑도 그 배열에서 직접 확인.

11개 팀은 SVG 로고가 있고, 2개(전자랜드=65, 캐롯=73 - 둘 다 없어진/개명된 팀)는 현재 CSS
번들에 아예 없어서(사이트에서 완전히 빠진 것으로 보임) 기존 컬러 배지로 계속 폴백.
"""
import base64
import json
import os
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
DEMO_PATH = os.path.join(ANALYSIS_DIR, "live_replay_demo.json")

# tcode -> (kbl.or.kr 로고 코드, 확장자) - teamLogoClassInfo에서 확인한 실제 매핑
LOGO_SOURCES = {
    "06": ("ic-kt", "svg"),
    "10": ("ic-hd", "svg"),
    "16": ("ic-db", "svg"),
    "30": ("old/or2022e", "png"),  # 오리온스 - 현재 CSS엔 연도별 버전만 남아있음, 최신(2022) 사용
    "35": ("ic-ss", "svg"),
    "50": ("ic-lg", "svg"),
    "55": ("ic-sk", "svg"),
    "60": ("ic-kcc", "svg"),
    "64": ("ic-pega", "svg"),
    "66": ("ic-sono", "svg"),
    "70": ("ic-kgc", "svg"),
    # 65(전자랜드), 73(캐롯)은 현재 kbl.or.kr CSS 번들에 로고가 없음 - 컬러 배지 폴백 유지
}

MIME = {"svg": "image/svg+xml", "png": "image/png"}


def download_logo(path, ext):
    url = f"https://kbl.or.kr/assets/img/ico/logo/{path}.svg" if ext == "svg" else f"https://kbl.or.kr/assets/img/ico/logo/{path}.png"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        raw = resp.read()
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:{MIME[ext]};base64,{b64}"


def main():
    with open(DEMO_PATH, encoding="utf-8") as f:
        data = json.load(f)

    print(f"팀 로고 {len(LOGO_SOURCES)}개 다운로드 중...", flush=True)
    logos = {}
    for tcode, (path, ext) in LOGO_SOURCES.items():
        try:
            logos[tcode] = download_logo(path, ext)
            print(f"  {tcode} ({path}) 성공, {len(logos[tcode])//1024}KB", flush=True)
        except Exception as e:
            print(f"  {tcode} ({path}) 실패: {e}", flush=True)

    total_kb = sum(len(v) for v in logos.values()) // 1024
    print(f"총 {len(logos)}개 성공, {total_kb}KB", flush=True)

    for gmkey, g in data["games"].items():
        g["homeLogo"] = logos.get(g["homeTcode"])
        g["awayLogo"] = logos.get(g["awayTcode"])

    # 리그 순위 테이블은 이 경기 두 팀 외의 팀도 보여줘야 해서 최상위 teamMeta에도 로고를 채움
    if "teamMeta" in data:
        for tcode, meta in data["teamMeta"].items():
            if tcode in logos:
                meta["logo"] = logos[tcode]

    with open(DEMO_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"완료 - {DEMO_PATH} 갱신", flush=True)


if __name__ == "__main__":
    main()
