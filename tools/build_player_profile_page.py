"""
선수 프로필 페이지 정적 생성 - build_scoring_distribution_page.py와 동일한
"템플릿+폰트+데이터 주입" 패턴. 슛 히트맵은 build_scoring_distribution.py 산출물의
"player" 섹션을 그대로 재사용(중복 집계 안 함) - player_profiles.json에 있는 선수로만
필터링해서 용량을 줄임. 팀 배지/로고는 live_replay_demo.json의 teamMeta(이미
embed_team_logos.py가 심어둔 실제 로고 포함) 재사용.
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
PROFILE_PATH = os.path.join(ANALYSIS_DIR, "player_profiles.json")
DIST_PATH = os.path.join(ANALYSIS_DIR, "scoring_distribution.json")
DEMO_PATH = os.path.join(ANALYSIS_DIR, "live_replay_demo.json")

TEMPLATE_PATH = os.path.join(BASE, "..", "web", "player_profile_template.html")
FONT_PATH = os.path.join(BASE, "..", "web", "pretendard_fontface.txt")
SCRATCHPAD = r"C:\Users\mwon0\AppData\Local\Temp\claude\C--Users-mwon0-Downloads-files\2f574caf-9d2a-4b1f-846d-80d187e30234\scratchpad"
OUT_PATH = os.path.join(SCRATCHPAD, "player_profile.html")


def main():
    with open(PROFILE_PATH, encoding="utf-8") as f:
        players = json.load(f)
    with open(DIST_PATH, encoding="utf-8") as f:
        dist = json.load(f)
    with open(DEMO_PATH, encoding="utf-8") as f:
        demo = json.load(f)

    # 슛 데이터는 player_profiles.json에 남은 선수(커리어 10경기 이상)로만 필터링해서
    # 용량을 줄임 - 컷 미달 선수의 슛 데이터는 애초에 프로필 페이지에서 보여줄 곳이 없음.
    shot_players = {pcode: v for pcode, v in dist["player"].items() if pcode in players}
    shot_data = {"grid": dist["grid"], "players": shot_players}

    with open(TEMPLATE_PATH, encoding="utf-8") as f:
        tpl = f.read()
    with open(FONT_PATH, encoding="utf-8") as f:
        font_block = f.read()

    out = tpl.replace("__FONT_BLOCK__", font_block)
    out = out.replace("__PLAYER_JSON__", json.dumps(players, ensure_ascii=False))
    out = out.replace("__SHOT_JSON__", json.dumps(shot_data, ensure_ascii=False))
    out = out.replace("__TEAM_META_JSON__", json.dumps(demo["teamMeta"], ensure_ascii=False))

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"완료 - 선수 {len(players)}명, 슛데이터 {len(shot_players)}명 -> {OUT_PATH} ({len(out)/1024:.0f}KB)")


if __name__ == "__main__":
    main()
