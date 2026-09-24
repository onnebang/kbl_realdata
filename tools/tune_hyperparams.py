"""
하이퍼파라미터 튜닝 (2026-08-19, 사용자 요청 - 데이터 확대 + 튜닝으로 성능 개선).

**시즌 경계 기준 확장윈도우 CV** - sklearn 기본 GridSearchCV는 무작위 K-fold라 같은 시즌 안의
팀 전력이 train/val에 새어나가 튜닝 자체가 과최적화(overfit-to-CV)될 위험이 있음. 대신
"과거 시즌들로 학습 -> 다음 시즌으로 검증"을 시즌을 하나씩 늘려가며 반복하는 수동 CV를 쓴다
(TimeSeriesSplit과 비슷하지만 인덱스가 아니라 실제 시즌 경계로 자름).

**최종 홀드아웃은 절대 튜닝에 안 씀** - 가장 최근 시즌은 튜닝용 CV 풀에서 완전히 제외하고,
튜닝이 다 끝난 뒤 딱 한 번만 평가한다. 안 그러면 "튜닝해서 좋아진 성능"이 사실은 홀드아웃에
대한 은근한 과최적화일 뿐일 수 있음.
"""
import json
import os

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss
from sklearn.model_selection import RandomizedSearchCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

BASE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.path.join(BASE, "..", "raw", "analysis", "pregame_training_table.json")

# 2026-08-20 확장 (사용자 요청): 휴식일수/구장/감독/심판/다중시간창 폼/용병출전집중도 추가.
#
# 나이곡선(ageCurveLevel_*)과 로스터연속성(rosterContinuity)도 시도해봤는데(export_training_table.py
# 상단 docstring 참고), 고정 하이퍼파라미터로 통제한 애블레이션에서 **오히려 정확도가 떨어짐**
# (64.3% 기존 최고 -> 로스터연속성만 62.2% / 나이곡선만 62.9% / 둘다 63.6%). RandomForest
# feature_importance 순위에선 away_rosterContinuity가 9/69위로 꽤 높게 나왔지만, 그건 트리가
# train셋 노이즈를 학습에 쓰고 있다는 신호일 뿐 실제 일반화 성능(held-out 정확도)은 오히려
# 나빴음 - RF importance(불순도 감소량)가 진짜 예측력의 좋은 지표가 아닐 수 있다는 걸 보여주는
# 사례. 그래서 기본 피처셋에서는 뺐음 - export_training_table.py는 계속 만들어두니(피처 자체는
# raw/analysis/pregame_training_table.json에 존재) 나중에 다른 모델/방식으로 재시도 가능.
FEATURE_KEYS = [
    "offrtg", "defrtg", "netrtg", "pace", "efgRt", "tsRt", "rebRt", "astRt", "tovRt",
    "winPctRecent", "synergyOnOffRating", "avgAge", "avgHeightCm", "avgWeightKg",
    "avgVerticalJumpCm", "avgWingspanCm",
    "restDays", "venueNetRtg", "coachWinPct", "foreignConcentration", "foreignPlayerCount",
    "last1_netrtg", "last1_winPct", "last3_netrtg", "last3_winPct",
    "last5_netrtg", "last5_winPct", "last10_netrtg", "last10_winPct",
    "teamPWR",  # 2026-09-24, 사용자 결정: 애블레이션상 RandomForest 홀드아웃이 60.8%->60.1%로
    # 소폭 하락하고 HistGradientBoosting과는 아예 안 맞지만(위 except ValueError 참고), 이번
    # 시즌 데이터가 쌓일수록 courtside OVR 정교화 + 재학습으로 나아질 거라는 전제로 그래도
    # 포함해서 배포하기로 함. export_training_table.py의 team_pwr_feature() 참고 - 직전
    # 완결 시즌 OVR만 씀(leak-free).
]
GAME_LEVEL_KEYS = ["dayOfWeek", "month", "refHomeWinRate"]  # 팀별이 아니라 그 경기 자체 컨텍스트

# 2026-09-24: 2026-27시즌(seasonCode 49)은 튜닝/홀드아웃에서 제외 - 아직 2경기뿐이라 그대로 두면
# seasons_sorted[-1]이 49가 되어 "최종 홀드아웃"이 표본 2개짜리가 되고, 그중 한 쪽 레이블만 있으면
# log_loss가 즉시 터진다(실제로 겪음). save_pregame_model.py의 CURRENT_SEASON_EXCLUDE와 동일한
# 이유(새 Q2/Q3 규정 전환기 표본 부족) - 데이터 쌓이면 같이 정리.
CURRENT_SEASON_EXCLUDE = 49


def build_xy(rows):
    X, y = [], []
    for r in rows:
        feats = [r["home"].get(f"home_{k}") for k in FEATURE_KEYS] + [r["away"].get(f"away_{k}") for k in FEATURE_KEYS]
        feats += [r.get(k) for k in GAME_LEVEL_KEYS]
        X.append([np.nan if v is None else v for v in feats])
        y.append(r["homeWon"])
    return np.array(X, dtype=float), np.array(y, dtype=int)


def season_expanding_cv(seasons_sorted, rows_by_season_idx, min_train_seasons=2):
    """[(train_idx, val_idx), ...] - 시즌을 하나씩 늘려가며 다음 시즌을 검증에 씀."""
    splits = []
    for i in range(min_train_seasons, len(seasons_sorted)):
        train_idx = [idx for s in seasons_sorted[:i] for idx in rows_by_season_idx[s]]
        val_idx = rows_by_season_idx[seasons_sorted[i]]
        if train_idx and val_idx:
            splits.append((train_idx, val_idx))
    return splits


def main():
    with open(TABLE_PATH, encoding="utf-8") as f:
        rows = json.load(f)
    excluded = [r for r in rows if r["seasonCode"] == CURRENT_SEASON_EXCLUDE]
    rows = [r for r in rows if r["seasonCode"] != CURRENT_SEASON_EXCLUDE]
    if excluded:
        print(f"시즌 {CURRENT_SEASON_EXCLUDE}(2026-27, 새 규정) {len(excluded)}행 튜닝에서 제외", flush=True)

    seasons_sorted = sorted({r["seasonCode"] for r in rows})
    final_holdout_season = seasons_sorted[-1]
    tune_pool_seasons = seasons_sorted[:-1]  # 최종 홀드아웃은 튜닝 CV에서 완전 제외
    print(f"전체 시즌: {seasons_sorted}", flush=True)
    print(f"튜닝용 CV 풀: {tune_pool_seasons} / 최종 홀드아웃(튜닝에 절대 안 씀): {final_holdout_season}\n", flush=True)

    tune_rows = [r for r in rows if r["seasonCode"] != final_holdout_season]
    holdout_rows = [r for r in rows if r["seasonCode"] == final_holdout_season]
    X_tune, y_tune = build_xy(tune_rows)
    X_holdout, y_holdout = build_xy(holdout_rows)

    rows_by_season_idx = {}
    for i, r in enumerate(tune_rows):
        rows_by_season_idx.setdefault(r["seasonCode"], []).append(i)
    # min_train_seasons=3(기본 2에서 상향, 2026-09-24) - teamPWR은 courtside OVR 히스토리가
    # 시작되는 시즌 자체(11=2006-07, 12=2007-08)엔 "그 전 시즌" 데이터가 아예 없어 커버리지
    # 0%(전부 NaN)다. min_train_seasons=2였을 때 첫 CV 폴드가 [11,12]만으로 학습해서 teamPWR
    # 열이 통째로 NaN이 되고, HistGradientBoosting의 구간화가 "distinct_values 2개 미만"으로
    # 즉시 터졌다(실제로 겪음). 시즌 13부터는 커버리지 44%로 정상 - 3으로 올리면 첫 폴드가
    # [11,12,13]을 다 포함해 해결됨.
    cv_splits = season_expanding_cv(tune_pool_seasons, rows_by_season_idx, min_train_seasons=3)
    print(f"CV 폴드 수: {len(cv_splits)} (시즌을 하나씩 늘려가며 다음 시즌 검증)", flush=True)
    if not cv_splits:
        print("튜닝 풀 시즌이 너무 적어 CV를 못 만듦 - 시즌이 더 모이면 재실행할 것.", flush=True)
        return

    search_space = {
        "RandomForest": (
            RandomForestClassifier(random_state=0),
            {"n_estimators": [200, 300, 500], "max_depth": [3, 4, 5, 6, None],
             "min_samples_leaf": [5, 10, 20, 30], "max_features": ["sqrt", 0.5, 0.8]},
        ),
        "HistGradientBoosting": (
            HistGradientBoostingClassifier(random_state=0),
            {"max_depth": [2, 3, 4, None], "max_iter": [50, 100, 150, 300],
             "learning_rate": [0.01, 0.03, 0.05, 0.1], "l2_regularization": [0.0, 0.5, 1.0, 3.0],
             "min_samples_leaf": [10, 20, 30]},
        ),
        "XGBoost": (
            XGBClassifier(eval_metric="logloss", random_state=0),
            {"n_estimators": [50, 100, 150, 300], "max_depth": [2, 3, 4], "learning_rate": [0.01, 0.03, 0.05, 0.1],
             "reg_lambda": [0.5, 1.0, 3.0, 5.0], "subsample": [0.7, 0.85, 1.0], "colsample_bytree": [0.6, 0.8, 1.0]},
        ),
        "LogisticRegression": (
            make_pipeline(SimpleImputer(strategy="mean"), StandardScaler(), LogisticRegression(max_iter=2000)),
            {"logisticregression__C": [0.01, 0.03, 0.1, 0.3, 1.0, 3.0]},
        ),
    }

    results = []
    for name, (estimator, params) in search_space.items():
        search = RandomizedSearchCV(
            estimator, params, n_iter=25, cv=cv_splits, scoring="neg_log_loss",
            random_state=0, n_jobs=-1)
        try:
            search.fit(X_tune, y_tune)
        except ValueError as e:
            # 2026-09-24 실제로 겪음 - teamPWR처럼 초기 시즌 커버리지가 0%인 피처가 있으면
            # HistGradientBoosting의 구간화가 "distinct_values 2개 미만"으로 터짐. 한 모델이
            # 새 피처와 안 맞는다고 나머지 모델(RandomForest 등) 튜닝까지 통째로 날릴 이유는
            # 없음 - 실패한 모델만 건너뛰고 계속 진행, 최종 목록엔 성공한 것만 남는다.
            print(f"[{name}] 학습 실패, 건너뜀: {e}", flush=True)
            continue
        best = search.best_estimator_
        probs = best.predict_proba(X_holdout)[:, 1]
        acc = accuracy_score(y_holdout, probs >= 0.5)
        ll = log_loss(y_holdout, probs)
        print(f"[{name}] CV 최적 파라미터: {search.best_params_}", flush=True)
        print(f"  튜닝 CV 로그손실: {-search.best_score_:.3f}  |  최종 홀드아웃: 정확도 {acc*100:.1f}% 로그손실 {ll:.3f}\n", flush=True)
        results.append({"model": name, "bestParams": search.best_params_,
                         "cvLogLoss": -search.best_score_, "holdoutAcc": acc, "holdoutLogLoss": ll})

    results.sort(key=lambda r: -r["holdoutAcc"])
    print("=== 최종 순위 (홀드아웃 정확도 기준) ===", flush=True)
    for r in results:
        print(f"  {r['model']:<22} 정확도 {r['holdoutAcc']*100:5.1f}%  로그손실 {r['holdoutLogLoss']:.3f}", flush=True)

    out_path = os.path.join(BASE, "..", "raw", "analysis", "tuned_model_results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    print(f"\n-> {out_path}", flush=True)


if __name__ == "__main__":
    main()
