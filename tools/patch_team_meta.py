"""
live_replay_demo.json에 팀컬러/약칭(게임별 homeColor/awayColor/homeAbbr/awayAbbr +
최상위 teamMeta[tcode].color/abbr)만 가볍게 주입.

원래는 build_live_replay_demo.py 재실행으로 처리하려 했으나, 이 환경의 anaconda Python이
3.8이라 저장된 승률 모델(joblib, numpy 2.x/sklearn 1.9 기준으로 저장됨)을 로드할 수 없는
상태(numpy._core ModuleNotFoundError)라 전체 파이프라인 재실행이 막힘 - ML 모델 없이도
계산 가능한 필드라 이 패치 스크립트로 우회. TEAM_META는 build_live_replay_demo.py와 동일하게
유지해서, 나중에 환경이 복구되면 전체 재생성해도 같은 값이 나오도록 함.

2026-08-25: 팀컬러가 실제 구단 컬러와 다르다는 지적(모비스가 파란색으로 나옴)을 받고 검색으로
재확인 후 TEAM_META 값 교체 - build_live_replay_demo.py의 주석 참고. 최상위 teamMeta는
"logo"(embed_team_logos.py가 채운 base64)와 "name"은 그대로 두고 color/abbr만 갱신.
"""
import json
import os

ANALYSIS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "raw", "analysis")
DEMO_PATH = os.path.join(ANALYSIS_DIR, "live_replay_demo.json")

TEAM_META = {
    "06": {"abbr": "KT", "color": "#1A1A1A"},
    "10": {"abbr": "MOB", "color": "#A6192E"},
    "16": {"abbr": "DB", "color": "#1C8A43"},
    "30": {"abbr": "GOY", "color": "#1E2749"},
    "35": {"abbr": "SAM", "color": "#1428A0"},
    "55": {"abbr": "SK", "color": "#E4002B"},
    "60": {"abbr": "KCC", "color": "#0C2340"},
    "64": {"abbr": "GAS", "color": "#0072CE"},
    "65": {"abbr": "EL", "color": "#0060AF"},
    "66": {"abbr": "SONO", "color": "#3FA9F5"},
    "70": {"abbr": "KGC", "color": "#C8102E"},
    "50": {"abbr": "LG", "color": "#8E1B3D"},
    "73": {"abbr": "CRT", "color": "#FF6B00"},
}
DEFAULT = {"abbr": "?", "color": "#5b5f6e"}


def main():
    with open(DEMO_PATH, encoding="utf-8") as f:
        data = json.load(f)
    for gmkey, g in data["games"].items():
        hm = TEAM_META.get(g["homeTcode"], DEFAULT)
        am = TEAM_META.get(g["awayTcode"], DEFAULT)
        g["homeAbbr"], g["homeColor"] = hm["abbr"], hm["color"]
        g["awayAbbr"], g["awayColor"] = am["abbr"], am["color"]
    for tcode, entry in data.get("teamMeta", {}).items():
        tm = TEAM_META.get(tcode, DEFAULT)
        entry["abbr"], entry["color"] = tm["abbr"], tm["color"]
    with open(DEMO_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"완료 - {len(data['games'])}경기 + 최상위 teamMeta {len(data.get('teamMeta', {}))}팀에 팀컬러/약칭 주입")


if __name__ == "__main__":
    main()
