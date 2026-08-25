"""
선수 신체정보(생년월일/키/몸무게/포지션)와 신인 드래프트 컴바인 데이터(버티컬 점프/윙스팬/
레인 어질리티 등)를 pcode 기준으로 통합한다 (사용자 요청 - 승률 예측 피처로 활용).

- 신체정보: kbl540_players_final.json에 이미 pcode별로 들어있음(카드게임용으로 이미 수집됨) -
  같은 선수가 시즌마다 여러 행이라 pcode로 중복제거만 하면 됨.
- 컴바인: legacy-kbl/data/kbl_draft_combine_2018_2025.json - pcode가 없고 이름만 있어서
  이름으로 조인. 303명 중 121명이 실제 1군 로스터(kbl540_players_final.json)에 매칭됨 -
  나머지는 드래프트됐지만 실제 출전 기록이 없는 선수들로 추정, 정상적인 커버리지 갭.
  버티컬 점프(289/303), 윙스팬(302/303) 커버리지는 좋고 레인어질리티(247/303)는 약간 낮음.

**컴바인 데이터는 신인 드래프트 시점 값**(보통 대학 4학년 때 1회 측정) - 나이 들면서 실제
운동능력이 변해도 이 값은 고정임. "선수의 잠재적 운동능력 프로필" 정도로 해석해야지 "지금
시즌의 컨디션"으로 오독하면 안 됨. 커버리지도 2018년 이후 드래프트생 중 매칭된 선수뿐이라
베테랑/외국인 선수는 대부분 NULL - 팀 레벨로 집계할 때 결측 많다는 점 감안해야 함.
"""
import datetime
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
PLAYERS_PATH = os.path.join(BASE, "..", "..", "kbl540_players_final.json")
COMBINE_PATH = os.path.join(BASE, "..", "..", "legacy-kbl", "data", "kbl_draft_combine_2018_2025.json")
OUT_PATH = os.path.join(BASE, "..", "raw", "analysis", "player_bio.json")


def load_bio():
    with open(PLAYERS_PATH, encoding="utf-8") as f:
        rows = json.load(f)
    bio = {}
    for r in rows:
        pcode = r.get("pcode")
        if not pcode or pcode in bio:
            continue
        bio[pcode] = {
            "pcode": pcode,
            "name": r.get("name"),
            "birthDate": r.get("birth_date"),
            "heightCm": r.get("height_cm"),
            "weightKg": r.get("weight_kg"),
            "position": r.get("position"),
            "nationality": r.get("nationality"),
        }
    return bio


def load_combine():
    with open(COMBINE_PATH, encoding="utf-8") as f:
        return json.load(f)


def age_on(birth_date_str, on_date_str):
    """on_date_str: YYYYMMDD. birth_date_str: YYYY-MM-DD."""
    if not birth_date_str or not on_date_str:
        return None
    try:
        bd = datetime.datetime.strptime(birth_date_str, "%Y-%m-%d")
        od = datetime.datetime.strptime(on_date_str, "%Y%m%d")
    except ValueError:
        return None
    years = od.year - bd.year - ((od.month, od.day) < (bd.month, bd.day))
    return years


def main():
    bio = load_bio()
    combine = load_combine()

    name_to_pcodes = {}
    for pcode, b in bio.items():
        name_to_pcodes.setdefault(b["name"], []).append(pcode)

    matched, unmatched = 0, 0
    for c in combine:
        candidates = name_to_pcodes.get(c["name"])
        if not candidates:
            unmatched += 1
            continue
        matched += 1
        for pcode in candidates:  # 동명이인 있으면 둘 다에 붙임(드묾, 무시 가능한 리스크)
            bio[pcode]["combine"] = {
                "draftYear": c.get("draft_year"),
                "verticalJumpCm": c.get("vertical_jump_cm"),
                "wingspanCm": c.get("wingspan_cm"),
                "standingReachCm": c.get("standing_reach_cm"),
                "laneAgilitySec": c.get("lane_agility_sec"),
                "bodyFatPct": c.get("body_fat_pct"),
            }

    for pcode in bio:
        bio[pcode].setdefault("combine", None)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(bio, f, ensure_ascii=False, indent=1)

    with_combine = sum(1 for b in bio.values() if b["combine"])
    print(f"선수 {len(bio)}명 신체정보 로딩, 컴바인 매칭 {matched}/{len(combine)} "
          f"(로스터 커버 {with_combine}명, 미매칭 {unmatched}명은 실제 출전기록 없는 드래프트생으로 추정)", flush=True)
    print(f"-> {OUT_PATH}", flush=True)


if __name__ == "__main__":
    main()
