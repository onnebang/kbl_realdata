"""
폼 지수 리더보드 정적 페이지 생성 - build_form_index.py 산출물을 템플릿에 주입.
팀 로고/컬러는 live_replay_demo.json의 teamMeta 재사용(재다운로드 안 함).
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
FORM_PATH = os.path.join(ANALYSIS_DIR, "form_index_2025-2026.json")
DEMO_PATH = os.path.join(ANALYSIS_DIR, "live_replay_demo.json")

SCRATCHPAD = r"C:\Users\mwon0\AppData\Local\Temp\claude\C--Users-mwon0-Downloads-files\2f574caf-9d2a-4b1f-846d-80d187e30234\scratchpad"
TEMPLATE_PATH = os.path.join(SCRATCHPAD, "form_index_template.html")
FONT_PATH = os.path.join(SCRATCHPAD, "pretendard_fontface.txt")
OUT_PATH = os.path.join(SCRATCHPAD, "form_index.html")


def main():
    with open(FORM_PATH, encoding="utf-8") as f:
        form_data = json.load(f)
    with open(DEMO_PATH, encoding="utf-8") as f:
        demo_data = json.load(f)
    team_meta = demo_data["teamMeta"]

    with open(TEMPLATE_PATH, encoding="utf-8") as f:
        tpl = f.read()
    with open(FONT_PATH, encoding="utf-8") as f:
        font_block = f.read()

    out = tpl.replace("__FONT_BLOCK__", font_block)
    out = out.replace("__FORM_JSON__", json.dumps(form_data, ensure_ascii=False))
    out = out.replace("__TEAM_META_JSON__", json.dumps(team_meta, ensure_ascii=False))

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"완료 - {OUT_PATH} ({len(out)/1024:.0f}KB)")


if __name__ == "__main__":
    main()
