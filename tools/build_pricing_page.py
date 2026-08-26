"""
구독 요금제 페이지 정적 생성 - build_form_index_page.py와 동일한 "템플릿+폰트 주입"
패턴이지만, 이 페이지는 동적 데이터가 없어서(정적 마케팅 페이지) JSON 주입은 없음.
"""
import os

BASE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_PATH = os.path.join(BASE, "..", "web", "pricing_template.html")
FONT_PATH = os.path.join(BASE, "..", "web", "pretendard_fontface.txt")
SCRATCHPAD = r"C:\Users\mwon0\AppData\Local\Temp\claude\C--Users-mwon0-Downloads-files\2f574caf-9d2a-4b1f-846d-80d187e30234\scratchpad"
OUT_PATH = os.path.join(SCRATCHPAD, "pricing.html")


def main():
    with open(TEMPLATE_PATH, encoding="utf-8") as f:
        tpl = f.read()
    with open(FONT_PATH, encoding="utf-8") as f:
        font_block = f.read()

    out = tpl.replace("__FONT_BLOCK__", font_block)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"완료 - {OUT_PATH} ({len(out)/1024:.0f}KB)")


if __name__ == "__main__":
    main()
