"""
실시간 알림 백엔드(backend/, Cloudflare Worker)용 승률 룩업테이블 export.

Worker는 Python/sklearn 없이 순수 JS만 돈다. build_live_replay_demo.py의 objectiveProb가
실제로는 (score_diff, remaining_sec) 2개 변수만의 함수라는 걸 이용해서 - 팀 전력 피처
(net/syn)는 0으로 고정, feat_row(score_diff, remaining_sec, scaled_score_diff, 0, 0) 그리드를
저장된 모델로 샘플링해서 작은 2D 테이블(JSON)로 뽑아둔다. Worker는 이 테이블만 갖고
가장 가까운 격자점을 찾아 승률을 근사(양쪽 다 촘촘해서 반올림 오차가 실사용에 문제 없음).

주의(remaining_sec 정의 불일치, 의도적으로 감수함): 원본 모델은 학습 시 "이 경기가 실제로
끝난 시각까지 남은 시간"(연장 포함, 사후적)으로 remaining_sec을 계산했음(build_live_replay_
demo.py의 total_elapsed = 마지막 이벤트 시각). 반면 실시간 폴링에서는 "그 경기가 연장에
갈지 미리 알 방법이 없어서" 표준적인 사전적 정의(정규 4쿼터=2400초, 진행 중인 연장은 300초씩
더함, courtside_template.html의 quarterLenSecJs/cumulativeElapsedJs와 동일한 정의)를 쓸 수밖에
없음. 두 정의는 연장이 없는 경기(대다수)에서는 사실상 동일하고, 연장 경기의 정규 4쿤터
막판에서만 약간 어긋남 - 알림 트리거(쿼터 종료/큰 스윙/역전) 용도로는 이 정도 근사 오차는
허용 가능하다고 판단.
"""
import json
import os

import joblib
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
MODEL_PATH = os.path.join(ANALYSIS_DIR, "live_winprob_model.joblib")
OUT_PATH = os.path.join(BASE, "..", "backend", "src", "lookup.json")

SCORE_DIFF_RANGE = range(-40, 41, 1)       # 81개 - 홈 기준 score_diff = home - away
REMAINING_SEC_RANGE = range(0, 2401, 20)   # 121개 - 정규 4쿼터 기준(연장은 Worker가 300초씩 더 얹어서 이 테이블을 그대로 재사용)


def scaled_score_diff(score_diff, remaining_sec):
    return score_diff / ((remaining_sec + 30) ** 0.5)


def main():
    model = joblib.load(MODEL_PATH)

    score_diffs = list(SCORE_DIFF_RANGE)
    remainings = list(REMAINING_SEC_RANGE)

    rows = []
    for remaining_sec in remainings:
        for score_diff in score_diffs:
            rows.append([score_diff, remaining_sec, scaled_score_diff(score_diff, remaining_sec), 0.0, 0.0])
    X = np.array(rows, dtype=float)
    probs = model.predict_proba(X)[:, 1]

    # probTable[remainingIdx][scoreDiffIdx] = 홈 승률(0~1) - Worker에서 가장 가까운
    # 격자점으로 바로 인덱싱하도록 2D 배열로 저장(키 없이 순수 숫자만 - 용량 절약).
    grid = probs.reshape(len(remainings), len(score_diffs)).round(4).tolist()

    out = {
        "scoreDiffMin": score_diffs[0], "scoreDiffMax": score_diffs[-1], "scoreDiffStep": 1,
        "remainingSecMax": remainings[-1], "remainingSecStep": 20,
        "probTable": grid,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f"완료 - {OUT_PATH} ({size_kb:.0f}KB, {len(remainings)}x{len(score_diffs)} 격자)")


if __name__ == "__main__":
    main()
