"""
1회성 분석 - build_live_winprob_data.py의 AVG_COMBINED_POSSESSION_SEC 상수를 실제 데이터로
재보기 위한 스크립트. NBA 샷클락(24초)을 그대로 가정하는 대신, team-record.json에 이미
계산돼 있는 `poss`(팀별 포제션 수)와 그 경기의 실제 총 경과시간을 대조해서 "평균 포제션
(양팀 합산) 길이"를 직접 잰다. 결과: 800경기 표본 기준 평균/중앙값 모두 17.0초,
p10~p90이 15.6~18.4초로 편차가 작아 안정적인 상수로 취급 가능.
"""
import json
import os
import random

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")

QUARTER_ORDER = ["Q1", "Q2", "Q3", "Q4", "X1", "X2", "X3", "X4", "EQ1", "EQ2", "EQ3", "EQ4"]
QUARTER_LEN_SEC = {"Q1": 600, "Q2": 600, "Q3": 600, "Q4": 600}


def quarter_len(q):
    return QUARTER_LEN_SEC.get(q, 300)


def cumulative_elapsed(q, m, s):
    idx = QUARTER_ORDER.index(q) if q in QUARTER_ORDER else len(QUARTER_ORDER)
    prior = sum(quarter_len(qq) for qq in QUARTER_ORDER[:idx])
    return prior + (quarter_len(q) - (m * 60 + s))


def main(sample_size=800, seed=0):
    gmkeys = sorted(os.listdir(GAMES_DIR))
    random.seed(seed)
    sample = random.sample(gmkeys, min(sample_size, len(gmkeys)))

    ratios = []
    for gk in sample:
        tr_path = os.path.join(GAMES_DIR, gk, "team-record.json")
        tc_path = os.path.join(GAMES_DIR, gk, "text-cast.json")
        if not (os.path.exists(tr_path) and os.path.exists(tc_path)):
            continue
        with open(tr_path, encoding="utf-8") as f:
            tr = json.load(f)
        with open(tc_path, encoding="utf-8") as f:
            events = json.load(f)
        if not events or len(tr) != 2:
            continue
        total_elapsed = cumulative_elapsed(events[-1]["q"], events[-1]["m"], events[-1]["s"])
        if total_elapsed <= 0:
            continue
        poss_sum = tr[0]["records"]["poss"] + tr[1]["records"]["poss"]
        if poss_sum <= 0:
            continue
        ratios.append(total_elapsed / poss_sum)

    ratios.sort()
    n = len(ratios)
    print(f"games analyzed: {n}")
    print(f"mean avg-combined-possession-sec: {sum(ratios) / n:.3f}")
    print(f"median: {ratios[n // 2]:.3f}")
    print(f"p10/p90: {ratios[int(n * 0.1)]:.3f} / {ratios[int(n * 0.9)]:.3f}")


if __name__ == "__main__":
    main()
