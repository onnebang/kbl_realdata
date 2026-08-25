"""
시즌 WPA 리더보드 정적 페이지 생성 - build_wpa.py가 만든 wpa_season_leaderboard.json을
템플릿(scratchpad/wpa_leaderboard_template.html)에 주입해서 완성된 HTML을 만든다.

팀컬러/약칭은 build_live_replay_demo.py의 TEAM_META와 동일(README 참고 - 공식 로고를 못 구해서
쓰는 근사값). 팀명이 시즌 중간에 바뀐 경우(예: 고양오리온스->고양소노)도 있지만, WPA 이벤트 로그엔
그 당시 팀명이 없고 tcode만 있어서 전체 시즌에 걸쳐 "현재 팀명"으로 통일 표시함 - 프랜차이즈
연속성만 정확하면(tcode는 안 바뀜) 큰 문제 없다고 판단.
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
SEASON_PATH = os.path.join(ANALYSIS_DIR, "wpa_season_leaderboard.json")

SCRATCHPAD = r"C:\Users\mwon0\AppData\Local\Temp\claude\C--Users-mwon0-Downloads-files\2f574caf-9d2a-4b1f-846d-80d187e30234\scratchpad"
TEMPLATE_PATH = os.path.join(SCRATCHPAD, "wpa_leaderboard_template.html")
FONT_PATH = os.path.join(SCRATCHPAD, "pretendard_fontface.txt")
OUT_PATH = os.path.join(SCRATCHPAD, "wpa_leaderboard.html")

TEAM_META = {
    "06": {"abbr": "KT", "color": "#D6001C", "name": "수원 KT"},
    "10": {"abbr": "MOB", "color": "#0077C8", "name": "울산 현대모비스"},
    "16": {"abbr": "DB", "color": "#0B3D91", "name": "원주 DB"},
    "30": {"abbr": "GOY", "color": "#1B1F3B", "name": "고양 오리온스"},
    "35": {"abbr": "SAM", "color": "#1428A0", "name": "서울 삼성"},
    "55": {"abbr": "SK", "color": "#EA0029", "name": "서울 SK"},
    "60": {"abbr": "KCC", "color": "#F58220", "name": "전주 KCC"},
    "64": {"abbr": "GAS", "color": "#009944", "name": "대구 한국가스공사"},
    "65": {"abbr": "EL", "color": "#0060AF", "name": "인천 전자랜드"},
    "66": {"abbr": "SONO", "color": "#C8102E", "name": "고양 소노"},
    "70": {"abbr": "KGC", "color": "#BE0000", "name": "안양 정관장"},
    "50": {"abbr": "LG", "color": "#A50034", "name": "창원 LG"},
    "73": {"abbr": "CRT", "color": "#FF6B00", "name": "고양 캐롯"},
}


def main():
    with open(SEASON_PATH, encoding="utf-8") as f:
        leaderboard = json.load(f)
    with open(TEMPLATE_PATH, encoding="utf-8") as f:
        tpl = f.read()
    with open(FONT_PATH, encoding="utf-8") as f:
        font_block = f.read()

    out = tpl.replace("__FONT_BLOCK__", font_block)
    out = out.replace("__LEADERBOARD_JSON__", json.dumps(leaderboard, ensure_ascii=False))
    out = out.replace("__TEAM_META_JSON__", json.dumps(TEAM_META, ensure_ascii=False))

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"완료 - {OUT_PATH} ({len(out)/1024:.0f}KB)")


if __name__ == "__main__":
    main()
