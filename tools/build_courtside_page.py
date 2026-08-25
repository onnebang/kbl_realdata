"""
코트사이드(courtside_template.html) 정적 페이지 생성 - live_replay_demo.json을
__GAME_JSON__ 자리에 주입. build_form_index_page.py/build_season_browser_page.py와
같은 패턴 - 그동안 이 단계를 즉석 스크립트로만 해왔는데, 템플릿을 자주 고치는 파일이라
재사용 가능한 스크립트로 남겨둠.
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
DEMO_PATH = os.path.join(ANALYSIS_DIR, "live_replay_demo.json")

SCRATCHPAD = r"C:\Users\mwon0\AppData\Local\Temp\claude\C--Users-mwon0-Downloads-files\2f574caf-9d2a-4b1f-846d-80d187e30234\scratchpad"
TEMPLATE_PATH = os.path.join(SCRATCHPAD, "courtside_template.html")
OUT_PATH = os.path.join(SCRATCHPAD, "courtside.html")


def main():
    with open(DEMO_PATH, encoding="utf-8") as f:
        demo_data = json.load(f)
    with open(TEMPLATE_PATH, encoding="utf-8") as f:
        tpl = f.read()
    out = tpl.replace("__GAME_JSON__", json.dumps(demo_data, ensure_ascii=False))
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"완료 - {OUT_PATH} ({len(out)/1024:.0f}KB)")


if __name__ == "__main__":
    main()
