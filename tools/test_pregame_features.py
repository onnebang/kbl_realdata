"""경기 전 승률 모델 피처 회귀 검사(모델·DB 없이). python test_pregame_features.py

두 가지를 지킨다:
 1. 외국선수 판정 - 예전엔 국적을 player_bio.json(kbl540 카드게임 프로젝트 스냅샷)에서 읽어서,
    그 스냅샷이 모르는 신규 영입 용병이 조용히 '국내'로 세어졌다. foreignPlayerCount/
    foreignConcentration이 틀린 값으로 배포 모델에 들어갔다(2026-09-29 발견).
 2. EWMA 동적 윈도우 폼 - "최근 경기에 더 큰 무게"와 "표본 적을 때 더 민감"이 실제로 성립하는지.
"""
import json
import os

import export_training_table as ett

# ══ 1. 외국선수 판정 (playerFlag 0=국내 / 1=외국 / 2=아시아쿼터) ══
stats = {
    "G1": [
        {"pcode": "dom", "tcode": "10", "minutes": 30.0, "flag": "0"},
        {"pcode": "imp", "tcode": "10", "minutes": 32.0, "flag": "1"},
        {"pcode": "asia", "tcode": "10", "minutes": 20.0, "flag": "2"},
        {"pcode": "unknown", "tcode": "10", "minutes": 5.0, "flag": None},
    ],
}
assert ett.foreign_pcodes_from_stats(stats) == {"imp", "asia"}

# 집중도 = 최다출전 외국선수 / 외국선수 전체
conc, n = ett.foreign_usage_concentration({"dom": 30.0, "imp": 30.0, "asia": 10.0}, {"imp", "asia"})
assert (conc, n) == (0.75, 2), (conc, n)

# 외국선수가 로테이션에 없으면 None - 0으로 뭉개면 "용병 없는 팀"과 "1옵 독점 팀"이 섞인다
assert ett.foreign_usage_concentration({"dom": 30.0}, {"imp"}) == (None, 0)

# ══ 2. EWMA 동적 윈도우 ══
def hist(results, netrtg=None):
    """results: [1, 0, ...] 승패. netrtg 생략 시 승패와 같은 부호의 임의값."""
    out = []
    for i, w in enumerate(results):
        nr = netrtg[i] if netrtg else (10.0 if w else -10.0)
        out.append({"won": w, "record": {"netrtg": nr, "offrtg": None, "defrtg": None}})
    return out


# 표본이 없으면 값은 None, alpha는 최소 span 기준
empty = ett.ewma_form([])
assert empty["ewma_netrtg"] is None and empty["ewma_winPct"] is None
assert empty["ewma_alpha"] == round(2 / (ett.EWMA_MIN_SPAN + 1), 3)

# 표본이 쌓이면 alpha가 작아지고(둔감해짐) max_span에서 멈춘다
a3 = ett.ewma_form(hist([1] * 3))["ewma_alpha"]
a10 = ett.ewma_form(hist([1] * 10))["ewma_alpha"]
a30 = ett.ewma_form(hist([1] * 30))["ewma_alpha"]
assert a3 > a10, (a3, a10)
assert a10 == a30 == round(2 / (ett.EWMA_MAX_SPAN + 1), 3), (a10, a30)

# 최근 경기에 더 큰 무게: 9패 뒤 1승은 단순 10경기 승률(0.1)보다 높게 평가된다
late_win = ett.ewma_form(hist([0] * 9 + [1]))["ewma_winPct"]
assert late_win > 0.1, late_win
# 반대로 9승 뒤 1패는 0.9보다 낮게
late_loss = ett.ewma_form(hist([1] * 9 + [0]))["ewma_winPct"]
assert late_loss < 0.9, late_loss
# 같은 성적이면 순서만 바뀌어도 값이 달라야 한다(순서를 안 보면 SMA와 다를 게 없다).
# 2경기로 재면 span 하한 때문에 alpha가 정확히 0.5라 양쪽이 우연히 같아진다 - 3경기로 잰다.
assert ett.ewma_form(hist([1, 1, 0]))["ewma_winPct"] != ett.ewma_form(hist([0, 1, 1]))["ewma_winPct"]

# netrtg 결측 경기는 건너뛴다(그 경기 때문에 폼이 사라지면 안 됨)
with_gap = hist([1, 1, 1])
with_gap[1]["record"]["netrtg"] = None
assert ett.ewma_form(with_gap)["ewma_netrtg"] is not None

# multi_window_form이 EWMA를 같이 내보낸다(두 호출부가 같은 폼 집합을 갖게 하는 계약)
mw = ett.multi_window_form(hist([1, 0, 1, 1]))
for k in ("ewma_netrtg", "ewma_winPct", "ewma_alpha", "last1_netrtg", "last10_winPct"):
    assert k in mw, k

# ══ 3. 실데이터 회귀: 2026-27 신규 용병/아쿼가 외국으로 잡히는가 ══
# 2026-09-24~27 오픈매치 10경기(S49G14N*)에 이 7명이 전원 출전했다. bio 기반 판정에서는
# 7명 모두 누락됐다 - 하나라도 빠지면 그 버그가 돌아온 것이다.
NEW_IMPORTS_2026_27 = {
    "291881": "스코티 제임스", "291882": "아치 굿윈", "291883": "존 무니",
    "291884": "루이스 킹", "291885": "트레이 포터", "291886": "다리우스 베즐리",
    "291887": "제리 아바디아노",
}
if os.path.isdir(ett.GAMES_DIR):
    om = {}
    for gmkey in os.listdir(ett.GAMES_DIR):
        if not gmkey.startswith("S49G14N"):
            continue
        path = os.path.join(ett.GAMES_DIR, gmkey, "player-stat.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                om[gmkey] = [{"pcode": r["player"]["pcode"], "tcode": r["player"]["tcode"],
                              "minutes": 1.0, "flag": r["player"].get("playerFlag")}
                             for r in json.load(f)]
    if om:
        found = ett.foreign_pcodes_from_stats(om)
        missing = {p: n for p, n in NEW_IMPORTS_2026_27.items() if p not in found}
        assert not missing, f"신규 용병이 외국선수로 안 잡힌다: {missing}"
        print(f"오픈매치 {len(om)}경기에서 신규 용병/아쿼 {len(NEW_IMPORTS_2026_27)}명 전원 외국선수로 판정")
    else:
        print("건너뜀: raw/games에 오픈매치(S49G14N*) 경기가 없음")
else:
    print(f"건너뜀: {ett.GAMES_DIR} 없음(클라우드 러너엔 경기 아카이브가 없다)")

print("test_pregame_features: 통과")
