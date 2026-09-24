"""
경기 전 예측 모델 저장 (2026-08-24) - tune_hyperparams.py로 찾은 최적 RandomForest 설정을
**전체 15시즌 데이터로** 재학습해서 joblib으로 저장. save_live_model.py와 다른 점: 그건
"홀드아웃 평가와 조건을 맞추려고" 마지막 시즌을 일부러 뺐지만, 여긴 실제 미래 경기(2026-27
시즌)를 예측하는 용도라 뺄 이유가 없음 - 지금 시점에서 15번째 시즌(2025-26)은 더 이상 "미래"가
아니라 그냥 과거 데이터라, 전부 넣는 게 맞다.

64.3%라는 성능 수치 자체는 tuned_model_results.json의 홀드아웃 평가에서 이미 나온 것 - 이 파일은
그 수치를 재현하는 게 목적이 아니라 실전 배포용 최종 모델을 만드는 것.

**2026-27 시즌(seasonCode 49) 제외 (2026-09-24, 사용자 요청)** - 2쿼터/3쿼터 용병+아시아쿼터
3인 동시출전이 이 시즌부터 처음 허용된 완전히 새로운 규정이라, 지금 이 시즌 표본은 몇 경기뿐이고
그마저 규정 자체가 낯선 전환기 데이터라 모델에 섞으면 소수 표본에 과적합될 위험이 큼. "지금까지
쌓인(=이전 규정) 데이터로 모델을 만들고, 새 규정 표본이 쌓이면 그때 다시 포함해서 재학습"하는
전략 - 데이터가 쌓이면 아래 CURRENT_SEASON_EXCLUDE를 지우거나 다음 시즌 코드로 옮기고 재실행할 것.
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
CURRENT_SEASON_EXCLUDE = 49  # 2026-2027 - 새 Q2/Q3 규정 첫 시즌, 표본 축적 전까지 재학습에서 제외


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
        all_rows = json.load(f)
    excluded = [r for r in all_rows if r["seasonCode"] == CURRENT_SEASON_EXCLUDE]
    rows = [r for r in all_rows if r["seasonCode"] != CURRENT_SEASON_EXCLUDE]
    if excluded:
        print(f"시즌 {CURRENT_SEASON_EXCLUDE}(2026-27, 새 규정) {len(excluded)}행 재학습에서 제외", flush=True)
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
