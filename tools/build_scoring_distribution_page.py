"""
득점 분포 탐색기 정적 페이지 생성 - build_scoring_distribution.py 산출물을 템플릿에 주입.
build_form_index_page.py와 동일 패턴.
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
DIST_PATH = os.path.join(ANALYSIS_DIR, "scoring_distribution.json")

TEMPLATE_PATH = os.path.join(BASE, "..", "web", "scoring_distribution_template.html")
FONT_PATH = os.path.join(BASE, "..", "web", "pretendard_fontface.txt")
SCRATCHPAD = r"C:\Users\mwon0\AppData\Local\Temp\claude\C--Users-mwon0-Downloads-files\2f574caf-9d2a-4b1f-846d-80d187e30234\scratchpad"
OUT_PATH = os.path.join(SCRATCHPAD, "scoring_distribution.html")


def main():
    with open(DIST_PATH, encoding="utf-8") as f:
        dist_data = json.load(f)
    with open(TEMPLATE_PATH, encoding="utf-8") as f:
        tpl = f.read()
    with open(FONT_PATH, encoding="utf-8") as f:
        font_block = f.read()

    out = tpl.replace("__FONT_BLOCK__", font_block)
    out = out.replace("__DIST_JSON__", json.dumps(dist_data, ensure_ascii=False))

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"완료 - {OUT_PATH} ({len(out)/1024:.0f}KB)")


if __name__ == "__main__":
    main()
