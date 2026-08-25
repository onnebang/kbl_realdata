"""
경기 전 승률 예측 - 여러 모델 x 여러 피처셋 비교 (2026-08-19, 사용자 요청).

train_baseline_model.py(순수 파이썬 로지스틱 회귀, 결측값 0-대입)에 이어서, sklearn/xgboost로
그래디언트부스팅 등 비선형 모델까지 비교한다. **결측값을 0으로 채우지 않고 NaN 그대로 둔다** -
트리 계열 모델(HistGradientBoosting/XGBoost)은 결측을 "이 피처가 없다는 것 자체가 신호"로
학습할 수 있어서, 로지스틱 회귀에서 신체정보/컴바인 피처가 오히려 해가 됐던 게 0-대입이라는
거친 결측 처리 때문이었는지 여기서 갈린다.

평가는 이전과 동일하게 **가장 최근 시즌(2025-26)을 통째로 떼어놓는 시간순 홀드아웃** - 시즌을
섞으면 같은 시즌 팀 전력이 새서 착시가 생김.
"""
import json
import math
import os

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier, GradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

BASE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.path.join(BASE, "..", "raw", "analysis", "pregame_training_table.json")

FEATURE_SETS = {
    "team-stats": ["offrtg", "defrtg", "netrtg", "pace", "efgRt", "tsRt", "rebRt", "astRt", "tovRt", "winPctRecent"],
    "team-stats+synergy": ["offrtg", "defrtg", "netrtg", "pace", "efgRt", "tsRt", "rebRt", "astRt", "tovRt",
                            "winPctRecent", "synergyOnOffRating"],
    "team-stats+bio": ["offrtg", "defrtg", "netrtg", "pace", "efgRt", "tsRt", "rebRt", "astRt", "tovRt",
                        "winPctRecent", "avgAge", "avgHeightCm", "avgWeightKg", "avgVerticalJumpCm", "avgWingspanCm"],
    "everything": ["offrtg", "defrtg", "netrtg", "pace", "efgRt", "tsRt", "rebRt", "astRt", "tovRt",
                   "winPctRecent", "synergyOnOffRating", "avgAge", "avgHeightCm", "avgWeightKg",
                   "avgVerticalJumpCm", "avgWingspanCm"],
}


def build_xy(rows, feature_keys):
    X, y = [], []
    for r in rows:
        feats = []
        for k in feature_keys:
            feats.append(r["home"].get(f"home_{k}"))
        for k in feature_keys:
            feats.append(r["away"].get(f"away_{k}"))
        X.append([np.nan if v is None else v for v in feats])
        y.append(r["homeWon"])
    return np.array(X, dtype=float), np.array(y, dtype=int)


def make_models():
    # 로지스틱 회귀는 NaN을 못 받아서 imputer(평균대입)+표준화를 파이프라인으로 붙임.
    # 트리 계열은 NaN을 그대로 받아서 결측 자체를 분기 조건으로 쓸 수 있음.
    return {
        "LogisticRegression": make_pipeline(
            SimpleImputer(strategy="mean"), StandardScaler(), LogisticRegression(max_iter=2000, C=1.0)),
        "RandomForest": RandomForestClassifier(
            n_estimators=300, max_depth=4, min_samples_leaf=10, random_state=0),
        "GradientBoosting(sklearn)": make_pipeline(
            SimpleImputer(strategy="mean"),
            GradientBoostingClassifier(n_estimators=150, max_depth=2, learning_rate=0.05, random_state=0)),
        "HistGradientBoosting(NaN-native)": HistGradientBoostingClassifier(
            max_depth=3, max_iter=150, learning_rate=0.05, l2_regularization=1.0, random_state=0),
        "XGBoost": XGBClassifier(
            n_estimators=150, max_depth=3, learning_rate=0.05, reg_lambda=1.0,
            eval_metric="logloss", random_state=0),
    }


def main():
    with open(TABLE_PATH, encoding="utf-8") as f:
        rows = json.load(f)
    seasons = sorted({r["seasonCode"] for r in rows})
    test_season = seasons[-1]
    train_rows = [r for r in rows if r["seasonCode"] != test_season]
    test_rows = [r for r in rows if r["seasonCode"] == test_season]
    print(f"train {len(train_rows)}행(시즌 {seasons[:-1]}) / test {len(test_rows)}행(시즌 {test_season})", flush=True)
    base_rate = sum(r["homeWon"] for r in test_rows) / len(test_rows)
    print(f"test 홈승 베이스레이트: {base_rate:.3f}\n", flush=True)

    results = []
    for fs_name, keys in FEATURE_SETS.items():
        X_train, y_train = build_xy(train_rows, keys)
        X_test, y_test = build_xy(test_rows, keys)
        for model_name, model in make_models().items():
            model.fit(X_train, y_train)
            probs = model.predict_proba(X_test)[:, 1]
            acc = accuracy_score(y_test, probs >= 0.5)
            ll = log_loss(y_test, probs)
            auc = roc_auc_score(y_test, probs)
            results.append({"featureSet": fs_name, "model": model_name, "acc": acc, "logloss": ll, "auc": auc})

    results.sort(key=lambda r: -r["acc"])
    print(f"{'피처셋':<22}{'모델':<34}{'정확도':>8}{'로그손실':>10}{'AUC':>8}", flush=True)
    print("-" * 82, flush=True)
    for r in results:
        print(f"{r['featureSet']:<22}{r['model']:<34}{r['acc']*100:>7.1f}%{r['logloss']:>10.3f}{r['auc']:>8.3f}", flush=True)

    out_path = os.path.join(BASE, "..", "raw", "analysis", "model_comparison.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    print(f"\n-> {out_path}", flush=True)


if __name__ == "__main__":
    main()
