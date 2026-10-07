"""
경기 전 예측 모델 저장 (2026-08-24) - tune_hyperparams.py로 찾은 최적 RandomForest 설정을
**전체 15시즌 데이터로** 재학습해서 joblib으로 저장. save_live_model.py와 다른 점: 그건
"홀드아웃 평가와 조건을 맞추려고" 마지막 시즌을 일부러 뺐지만, 여긴 실제 미래 경기(2026-27
시즌)를 예측하는 용도라 뺄 이유가 없음 - 지금 시점에서 15번째 시즌(2025-26)은 더 이상 "미래"가
아니라 그냥 과거 데이터라, 전부 넣는 게 맞다.

64.3%라는 성능 수치 자체는 tuned_model_results.json의 홀드아웃 평가에서 이미 나온 것 - 이 파일은
그 수치를 재현하는 게 목적이 아니라 실전 배포용 최종 모델을 만드는 것.

**2026-27 시즌(seasonCode 49) 조건부 제외 (2026-09-24 도입, 2026-10-06 자동화 - 사용자 요청)** -
2쿼터/3쿼터 용병+아시아쿼터 3인 동시출전이 이 시즌부터 처음 허용된 완전히 새로운 규정이라,
표본이 적을 때 모델에 섞으면 소수 표본에 과적합될 위험이 크다. "표본이 SAMPLE_THRESHOLD(행)
미만이면 빼고, 그 이상이면 포함해서 재학습" - 매주 KBL_WeeklyTrain(weekly_retrain.py)이 이
스크립트를 다시 돌리므로 기준을 넘는 주부터 자동으로 포함된다(사람이 플래그를 직접 지울 필요 없음).
"""
import json
import os
import sys

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier

from tune_hyperparams import FEATURE_KEYS, GAME_LEVEL_KEYS, TABLE_PATH

BASE = os.path.dirname(os.path.abspath(__file__))
MODEL_OUT = os.path.join(BASE, "..", "raw", "analysis", "pregame_model.joblib")
BEST_PARAMS_PATH = os.path.join(BASE, "..", "raw", "analysis", "tuned_model_results.json")
CURRENT_SEASON_CODE = 49  # 2026-2027 - 새 Q2/Q3 용병 2인 규정 첫 시즌
SAMPLE_THRESHOLD = 150  # 사용자 지정(2026-10-06) - 이 시즌 학습테이블 표본이 이 행 수를 넘으면 포함

# 승격 게이트(2026-10-07): 새 모델이 현재 배포 모델과 최근 경기 예측이 이만큼 이상 달라지면 덮어쓰지 않는다. 매주 데이터가
# 몇 행~몇십 행 늘 뿐이라 정상 재학습은 거의 안 달라진다 - 실측(drop 10~80행): 평균 |Δp| 0.009~0.022, 상위 5% 0.024~0.067.
# 학습 테이블이 깨지면(라벨 섞임 재현) 평균 0.110, 상위 5% 0.239. 임계는 정상 최대의 2배 남짓, 깨진 값 아래로 잡았다.
# 의도적으로 피처/하이퍼파라미터를 바꾼 재학습은 --force로 건너뛴다.
DRIFT_MEAN_MAX = 0.05
DRIFT_P95_MAX = 0.15
DRIFT_REF_ROWS = 400


def build_xy(rows):
    X, y = [], []
    for r in rows:
        feats = [r["home"].get(f"home_{k}") for k in FEATURE_KEYS] + [r["away"].get(f"away_{k}") for k in FEATURE_KEYS]
        feats += [r.get(k) for k in GAME_LEVEL_KEYS]
        X.append([np.nan if v is None else v for v in feats])
        y.append(r["homeWon"])
    return np.array(X, dtype=float), np.array(y, dtype=int)


def drift_vs_deployed(new_model, rows):
    """현재 배포 모델과 새 모델의 최근 경기 예측 확률 차이(평균, 상위 5%). 배포 모델이 없거나 피처 구성이 다르면 None."""
    if not os.path.exists(MODEL_OUT):
        return None
    deployed = joblib.load(MODEL_OUT)
    if deployed.get("featureKeys") != FEATURE_KEYS or deployed.get("gameLevelKeys") != GAME_LEVEL_KEYS:
        return None
    X, _ = build_xy(rows[-DRIFT_REF_ROWS:])
    d = np.abs(new_model.predict_proba(X)[:, 1] - deployed["model"].predict_proba(X)[:, 1])
    return float(d.mean()), float(np.percentile(d, 95))


def main():
    with open(TABLE_PATH, encoding="utf-8") as f:
        all_rows = json.load(f)
    current = [r for r in all_rows if r["seasonCode"] == CURRENT_SEASON_CODE]
    if len(current) >= SAMPLE_THRESHOLD:
        rows = all_rows
        print(f"시즌 {CURRENT_SEASON_CODE}(2026-27, 새 규정) {len(current)}행 - 기준치({SAMPLE_THRESHOLD}) 달성, 재학습에 포함", flush=True)
    else:
        rows = [r for r in all_rows if r["seasonCode"] != CURRENT_SEASON_CODE]
        print(f"시즌 {CURRENT_SEASON_CODE}(2026-27, 새 규정) {len(current)}행 - 기준치({SAMPLE_THRESHOLD}) 미달, 재학습에서 제외", flush=True)
    with open(BEST_PARAMS_PATH, encoding="utf-8") as f:
        results = json.load(f)
    rf_result = next(r for r in results if r["model"] == "RandomForest")
    params = rf_result["bestParams"]
    print(f"RandomForest 파라미터(튜닝 결과 재사용): {params}", flush=True)

    X, y = build_xy(rows)
    print(f"전체 {len(rows)}행({rows[0]['seasonCode']}~{rows[-1]['seasonCode']}시즌)으로 재학습...", flush=True)

    model = RandomForestClassifier(random_state=0, **params)
    model.fit(X, y)

    drift = drift_vs_deployed(model, rows)
    if drift is None:
        print("승격 게이트: 비교할 배포 모델이 없거나 피처 구성이 달라 건너뜀", flush=True)
    else:
        print(f"승격 게이트: 배포 모델 대비 최근 {DRIFT_REF_ROWS}경기 예측 차이 평균 {drift[0]:.4f} / 상위5% {drift[1]:.4f} "
              f"(기준 {DRIFT_MEAN_MAX} / {DRIFT_P95_MAX})", flush=True)
        if (drift[0] > DRIFT_MEAN_MAX or drift[1] > DRIFT_P95_MAX) and "--force" not in sys.argv:
            print("[GATE] 새 모델이 배포 모델과 너무 다름 - 학습 테이블/피처 이상 의심, 덮어쓰지 않고 중단 "
                  "(의도한 변경이면 --force)", flush=True)
            sys.exit(1)

    os.makedirs(os.path.dirname(MODEL_OUT), exist_ok=True)
    joblib.dump({"model": model, "featureKeys": FEATURE_KEYS, "gameLevelKeys": GAME_LEVEL_KEYS}, MODEL_OUT)
    print(f"저장 완료 -> {MODEL_OUT}", flush=True)
    print("(참고: 이 모델의 정직한 성능 추정치는 tuned_model_results.json의 홀드아웃 결과인 "
          f"{rf_result['holdoutAcc']*100:.1f}% - 여긴 그 시즌까지 포함해서 재학습한 배포용 모델)", flush=True)


if __name__ == "__main__":
    main()
