"""
경기 중(라이브) 승률 예측 - 하이퍼파라미터 튜닝 (2026-08-24).

tune_hyperparams.py(경기전 모델)와 같은 원칙(시즌경계 CV, 최종 홀드아웃은 튜닝에 안 씀)을
쓰되, 데이터 규모가 완전히 다름 - 경기전 모델은 4,182행이라 CV 폴드 12개(시즌 하나씩 확장)를
그대로 다 썼지만, 라이브 모델은 242만 행이라 그대로 하면 fit 1번에도 시간이 오래 걸려서
12폴드 x n_iter x 모델수를 다 돌리는 게 비현실적임. 그래서 두 가지로 스케일 조정:

1. **CV 폴드 수를 줄임**(12개 -> 4개, `min_train_seasons` 상향) - 폴드 하나당 표본이 이미
   수십만 행이라(전체 242만행/14시즌 ~ 17만행/시즌) 폴드를 더 쪼갠다고 안정성이 크게
   좋아지진 않음. 시즌경계 원칙(무작위 아님)은 그대로 유지.
2. **탐색 단계만 서브샘플**(경기 단위로 샘플링 - 행 단위로 무작위 추출하면 같은 경기의
   앞부분/뒷부분이 분리돼 통계적 왜곡이 생길 수 있어서, gmkey 기준으로 경기를 통째로
   골라냄). 최적 하이퍼파라미터를 찾은 뒤엔 **탐색에 쓰지 않은 전체 학습 데이터로 최종
   재학습**해서 홀드아웃 평가 - 탐색은 빠르게, 최종 모델은 전체 데이터로.
"""
import json
import math
import os
import random

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss
from sklearn.model_selection import RandomizedSearchCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE, "..", "raw", "analysis", "live_winprob_snapshots.json")
OUT_PATH = os.path.join(BASE, "..", "raw", "analysis", "tuned_live_winprob_results.json")

SEARCH_SAMPLE_GAMES_FRAC = 0.25  # 탐색 단계에서 쓸 경기 비율(경기 단위 샘플링, 행 단위 아님)
MIN_TRAIN_SEASONS = 10  # 이 값을 올릴수록 CV 폴드 수가 줄어듦(속도용 트레이드오프)


def scaled_score_diff(score_diff, remaining_sec):
    return score_diff / math.sqrt(remaining_sec + 30)


TIME_BUCKETS = [
    ("경기초반(30분+남음)", lambda r: r > 1800),
    ("전반(30~15분)", lambda r: 900 < r <= 1800),
    ("후반초반(15~5분)", lambda r: 300 < r <= 900),
    ("막판(5~1분)", lambda r: 60 < r <= 300),
    ("클러치(1분 이내)", lambda r: r <= 60),
]


def build_xy(rows):
    X, y = [], []
    for r in rows:
        sd, rem = r["scoreDiff"], r["remainingSec"]
        net = r["netrtgDiff"] if r["netrtgDiff"] is not None else 0.0
        syn = r["synergyDiff"] if r["synergyDiff"] is not None else 0.0
        X.append([sd, rem, scaled_score_diff(sd, rem), net, syn])
        y.append(r["homeWon"])
    return np.array(X, dtype=float), np.array(y, dtype=int)


def season_expanding_cv(seasons_sorted, rows_by_season_idx, min_train_seasons):
    splits = []
    for i in range(min_train_seasons, len(seasons_sorted)):
        train_idx = [idx for s in seasons_sorted[:i] for idx in rows_by_season_idx[s]]
        val_idx = rows_by_season_idx[seasons_sorted[i]]
        if train_idx and val_idx:
            splits.append((train_idx, val_idx))
    return splits


def sample_by_game(rows, frac, seed=0):
    """gmkey 단위로 경기를 골라서(행 단위 무작위 추출 금지 - 같은 경기가 쪼개지면 왜곡) 서브샘플."""
    gmkeys = sorted({r["gmkey"] for r in rows})
    rng = random.Random(seed)
    rng.shuffle(gmkeys)
    keep = set(gmkeys[: max(1, int(len(gmkeys) * frac))])
    return [r for r in rows if r["gmkey"] in keep]


def evaluate_by_time_bucket(model, rows):
    print("  남은시간 구간별 성능:", flush=True)
    for label, cond in TIME_BUCKETS:
        bucket_rows = [r for r in rows if cond(r["remainingSec"])]
        if len(bucket_rows) < 100:
            continue
        X, y = build_xy(bucket_rows)
        probs = model.predict_proba(X)[:, 1]
        acc = accuracy_score(y, probs >= 0.5)
        ll = log_loss(y, probs, labels=[0, 1])
        print(f"    {label:<18} n={len(bucket_rows):>8}  정확도 {acc*100:5.1f}%  로그손실 {ll:.3f}", flush=True)


def main():
    with open(DATA_PATH, encoding="utf-8") as f:
        rows = json.load(f)
    print(f"전체 스냅샷: {len(rows)}개", flush=True)

    seasons_sorted = sorted({r["seasonCode"] for r in rows})
    final_holdout_season = seasons_sorted[-1]
    tune_pool_seasons = seasons_sorted[:-1]
    tune_rows = [r for r in rows if r["seasonCode"] != final_holdout_season]
    holdout_rows = [r for r in rows if r["seasonCode"] == final_holdout_season]
    print(f"튜닝풀: {len(tune_rows)}개(시즌 {tune_pool_seasons}) / 최종 홀드아웃: {len(holdout_rows)}개(시즌 {final_holdout_season})", flush=True)

    search_rows = sample_by_game(tune_rows, SEARCH_SAMPLE_GAMES_FRAC)
    print(f"탐색용 서브샘플(경기 {SEARCH_SAMPLE_GAMES_FRAC*100:.0f}%): {len(search_rows)}개", flush=True)

    rows_by_season_idx = {}
    for i, r in enumerate(search_rows):
        rows_by_season_idx.setdefault(r["seasonCode"], []).append(i)
    search_seasons = sorted(rows_by_season_idx.keys())
    cv_splits = season_expanding_cv(search_seasons, rows_by_season_idx, MIN_TRAIN_SEASONS)
    print(f"CV 폴드 수: {len(cv_splits)}\n", flush=True)
    if not cv_splits:
        print("CV 폴드가 안 만들어짐 - MIN_TRAIN_SEASONS를 낮출 것.", flush=True)
        return

    X_search, y_search = build_xy(search_rows)
    X_holdout, y_holdout = build_xy(holdout_rows)

    search_space = {
        "RandomForest": (
            RandomForestClassifier(random_state=0, n_jobs=-1),
            {"n_estimators": [100, 200, 300], "max_depth": [5, 8, 10, 12, None],
             "min_samples_leaf": [20, 50, 100, 200], "max_features": ["sqrt", 0.6, 1.0]},
        ),
        "HistGradientBoosting": (
            HistGradientBoostingClassifier(random_state=0),
            {"max_depth": [3, 5, 6, 8, None], "max_iter": [100, 200, 300],
             "learning_rate": [0.03, 0.05, 0.1, 0.15], "l2_regularization": [0.0, 0.5, 1.0],
             "min_samples_leaf": [20, 50, 100]},
        ),
        "LogisticRegression": (
            make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
            {"logisticregression__C": [0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0]},
        ),
    }

    results = []
    for name, (estimator, params) in search_space.items():
        n_iter = min(15, np.prod([len(v) for v in params.values()]))
        search = RandomizedSearchCV(
            estimator, params, n_iter=n_iter, cv=cv_splits, scoring="neg_log_loss",
            random_state=0, n_jobs=-1)
        search.fit(X_search, y_search)
        print(f"[{name}] CV 최적 파라미터: {search.best_params_}  (탐색 CV 로그손실 {-search.best_score_:.3f})", flush=True)

        # 탐색에서 찾은 하이퍼파라미터로, 서브샘플이 아니라 전체 튜닝풀(242만행 중 홀드아웃 제외분)로 재학습
        best_estimator = search.best_estimator_
        X_full, y_full = build_xy(tune_rows)
        best_estimator.fit(X_full, y_full)

        probs = best_estimator.predict_proba(X_holdout)[:, 1]
        acc = accuracy_score(y_holdout, probs >= 0.5)
        ll = log_loss(y_holdout, probs)
        print(f"  전체데이터 재학습 후 최종 홀드아웃: 정확도 {acc*100:.1f}%  로그손실 {ll:.3f}", flush=True)
        evaluate_by_time_bucket(best_estimator, holdout_rows)
        print(flush=True)

        results.append({"model": name, "bestParams": {k: (v if not isinstance(v, (np.integer, np.floating)) else float(v))
                                                        for k, v in search.best_params_.items()},
                         "searchCvLogLoss": -search.best_score_, "holdoutAcc": acc, "holdoutLogLoss": ll})

    results.sort(key=lambda r: -r["holdoutAcc"])
    print("=== 최종 순위 (홀드아웃 정확도 기준) ===", flush=True)
    for r in results:
        print(f"  {r['model']:<22} 정확도 {r['holdoutAcc']*100:5.1f}%  로그손실 {r['holdoutLogLoss']:.3f}", flush=True)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    print(f"\n-> {OUT_PATH}", flush=True)


if __name__ == "__main__":
    main()
