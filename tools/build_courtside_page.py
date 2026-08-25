"""
코트사이드(courtside_template.html) 정적 페이지 생성 - live_replay_demo.json을
__GAME_JSON__ 자리에 주입. build_form_index_page.py/build_season_browser_page.py와
같은 패턴 - 그동안 이 단계를 즉석 스크립트로만 해왔는데, 템플릿을 자주 고치는 파일이라
재사용 가능한 스크립트로 남겨둠.

2026-08-25: 템플릿 원본을 세션별 임시 scratchpad 경로가 아니라 프로젝트 안(web/)으로
옮김 - scratchpad 경로엔 세션 ID가 박혀 있어서 다음 세션에선 그 경로가 아예 없어짐(git에도
안 잡힘). 앞으로 템플릿 수정은 web/courtside_template.html에 직접. 로컬 프리뷰용 산출물만
계속 scratchpad로 내보냄(용량 커서 git엔 안 올림).
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
DEMO_PATH = os.path.join(ANALYSIS_DIR, "live_replay_demo.json")

TEMPLATE_PATH = os.path.join(BASE, "..", "web", "courtside_template.html")
SCRATCHPAD = r"C:\Users\mwon0\AppData\Local\Temp\claude\C--Users-mwon0-Downloads-files\2f574caf-9d2a-4b1f-846d-80d187e30234\scratchpad"
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
