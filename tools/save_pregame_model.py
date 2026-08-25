"""
경기 전 예측 모델 저장 (2026-08-24) - tune_hyperparams.py로 찾은 최적 RandomForest 설정을
**전체 15시즌 데이터로** 재학습해서 joblib으로 저장. save_live_model.py와 다른 점: 그건
"홀드아웃 평가와 조건을 맞추려고" 마지막 시즌을 일부러 뺐지만, 여긴 실제 미래 경기(2026-27
시즌)를 예측하는 용도라 뺄 이유가 없음 - 지금 시점에서 15번째 시즌(2025-26)은 더 이상 "미래"가
아니라 그냥 과거 데이터라, 전부 넣는 게 맞다.

64.3%라는 성능 수치 자체는 tuned_model_results.json의 홀드아웃 평가에서 이미 나온 것 - 이 파일은
그 수치를 재현하는 게 목적이 아니라 실전 배포용 최종 모델을 만드는 것.
"""
import json
import os

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier

from tune_hyperparams import FEATURE_KEYS, GAME_LEVEL_KEYS, TABLE_PATH

BASE = os.path.dirname(os.path.abspath(__file__))
MODEL_OUT = os.path.join(BASE, "..", "raw", "analysis", "pregame_model.joblib")
BEST_PARAMS_PATH = os.path.join(BASE, "..", "raw", "analysis", "tuned_model_results.json")


def build_xy(rows):
    X, y = [], []
    for r in rows:
        feats = [r["home"].get(f"home_{k}") for k in FEATURE_KEYS] + [r["away"].get(f"away_{k}") for k in FEATURE_KEYS]
        feats += [r.get(k) for k in GAME_LEVEL_KEYS]
        X.append([np.nan if v is None else v for v in feats])
        y.append(r["homeWon"])
    return np.array(X, dtype=float), np.array(y, dtype=int)


def main():
    with open(TABLE_PATH, encoding="utf-8") as f:
        rows = json.load(f)
    with open(BEST_PARAMS_PATH, encoding="utf-8") as f:
        results = json.load(f)
    rf_result = next(r for r in results if r["model"] == "RandomForest")
    params = rf_result["bestParams"]
    print(f"RandomForest 파라미터(튜닝 결과 재사용): {params}", flush=True)

    X, y = build_xy(rows)
    print(f"전체 {len(rows)}행({rows[0]['seasonCode']}~{rows[-1]['seasonCode']}시즌)으로 재학습...", flush=True)

    model = RandomForestClassifier(random_state=0, **params)
    model.fit(X, y)

    os.makedirs(os.path.dirname(MODEL_OUT), exist_ok=True)
    joblib.dump({"model": model, "featureKeys": FEATURE_KEYS, "gameLevelKeys": GAME_LEVEL_KEYS}, MODEL_OUT)
    print(f"저장 완료 -> {MODEL_OUT}", flush=True)
    print("(참고: 이 모델의 정직한 성능 추정치는 tuned_model_results.json의 홀드아웃 결과인 "
          f"{rf_result['holdoutAcc']*100:.1f}% - 여긴 그 시즌까지 포함해서 재학습한 배포용 모델)", flush=True)


if __name__ == "__main__":
    main()
