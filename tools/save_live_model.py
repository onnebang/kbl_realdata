"""
튜닝에서 찾은 최고 모델(HistGradientBoosting)을 실제로 저장 (2026-08-24, WPA 계산용).

tune_live_winprob_model.py는 탐색+평가만 하고 모델 객체를 디스크에 남기지 않았음 - WPA
계산 스크립트가 매번 다시 학습시키는 건 낭비라, tuned_live_winprob_results.json에 이미
저장된 최적 하이퍼파라미터로 딱 한 번 재학습해서 joblib으로 저장해둔다.

**어떤 데이터로 학습하는가**: 튜닝 때와 동일하게 홀드아웃 시즌(47) 제외한 14개 시즌(220만행)
- WPA는 "이미 검증된 그 모델"을 그대로 재사용해서 과거 경기를 서술하는 용도라, 우리가 실제로
평가해서 74.7%를 확인한 바로 그 모델과 동일한 것을 써야 일관성이 있음(전체 15시즌으로 다시
학습하면 미세하게 다른 모델이 되어 방금 보고한 성능 수치와 안 맞게 됨).
"""
import json
import os

import joblib
from sklearn.ensemble import HistGradientBoostingClassifier

import tune_live_winprob_model as tlw

BASE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(BASE, "..", "raw", "analysis", "tuned_live_winprob_results.json")
MODEL_PATH = os.path.join(BASE, "..", "raw", "analysis", "live_winprob_model.joblib")


def main():
    with open(RESULTS_PATH, encoding="utf-8") as f:
        results = json.load(f)
    best = max(results, key=lambda r: r["holdoutAcc"])
    print(f"최고 모델: {best['model']} (홀드아웃 정확도 {best['holdoutAcc']*100:.1f}%)", flush=True)

    with open(tlw.DATA_PATH, encoding="utf-8") as f:
        rows = json.load(f)
    seasons_sorted = sorted({r["seasonCode"] for r in rows})
    tune_rows = [r for r in rows if r["seasonCode"] != seasons_sorted[-1]]
    X, y = tlw.build_xy(tune_rows)

    params = {k: v for k, v in best["bestParams"].items()}
    # HistGradientBoosting의 max_depth가 None으로 탐색됐을 수도 있어 그대로 전달
    model = HistGradientBoostingClassifier(random_state=0, **params)
    model.fit(X, y)

    joblib.dump(model, MODEL_PATH)
    print(f"저장 완료 -> {MODEL_PATH}", flush=True)


if __name__ == "__main__":
    main()
