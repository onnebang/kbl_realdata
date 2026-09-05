# -*- coding: utf-8 -*-
"""최근 폼 피처가 경기 전 승률 모델에 실제로 얼마나 기여하는지 애블레이션으로 잰다.

## 왜

질문: "직전경기와, 최근 5경기, 75포제션 등등의 데이터를 넣었을때, 팀 승률 모델은 어느정도 될까"

먼저 확인할 사실: **이미 들어가 있다.** tune_hyperparams.py:39 FEATURE_KEYS에
last1/last3/last5/last10 의 netrtg·winPct 8종(팀별)이 이미 있고, 그 상태의 홀드아웃 정확도가
64.31%다. 그러니 진짜 질문은 "넣으면 얼마나 오르나"가 아니라 **"지금 그게 얼마나 일하고
있고, 더 넣으면 더 오르나"** 다.

## 방법

평가는 기존과 동일하게 맞춘다 - 그래야 64.3%와 같은 자로 비교된다.
  · 마지막 시즌(2025-26)을 통째로 홀드아웃, 나머지로 학습
  · 시즌 확장 CV(season_expanding_cv)로 하이퍼파라미터 탐색
  · 지표는 홀드아웃 정확도 + 로그손실
하이퍼파라미터 탐색을 피처셋마다 새로 돌린다 - 고정 파라미터로 비교하면 "피처가 나쁜 것"과
"그 피처셋에 안 맞는 파라미터"를 구분할 수 없다.

**주의(이 저장소가 이미 겪은 함정)**: tune_hyperparams.py:30-38 주석에 나이곡선·로스터연속성이
RandomForest feature_importance 순위는 높았는데 홀드아웃 정확도는 오히려 떨어졌다는 기록이
있다. importance는 예측력의 지표가 아니다. 여기서도 **홀드아웃 숫자만** 본다.

## 피처셋

  base        지금 배포된 29종(팀별) + 경기 3종
  no_form     base에서 last* 8종을 뺀 것 -> 폼이 지금 얼마나 일하는지
  form_only   last* 8종 + 경기 3종만 -> 폼만으로 어디까지 가는지
  plus_rtg    base + last{1,3,5,10}_offrtg/defrtg 8종(테이블에 있는데 안 쓰던 것)
  plus_p75    base + 75포제션 환산 파생(아래 참고)
  plus_delta  base + "최근 폼 - 시즌 평균" 차이(모멘텀) 파생
  all         위 파생 전부

75포제션 환산: 이 테이블의 offrtg/defrtg/netrtg는 이미 100포제션당 값이라 75포제션으로
바꿔도 상수배(0.75)일 뿐 트리모델에는 정보가 0이다. 대신 의미 있는 건 **템포를 곱해 경기당
실점/득점 규모로 되돌린 값**이라(pace가 다른 두 팀의 같은 netrtg는 경기당 득실차가 다르다),
그걸 파생으로 만든다: expPtsPerGame = offrtg * pace / 100.
"""
import json
import os
import sys

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss
from sklearn.model_selection import RandomizedSearchCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

BASE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.path.join(BASE, "..", "raw", "analysis", "pregame_training_table.json")

# 지금 배포된 피처셋 (tune_hyperparams.py:39와 글자 그대로 같아야 한다)
BASE_KEYS = [
    "offrtg", "defrtg", "netrtg", "pace", "efgRt", "tsRt", "rebRt", "astRt", "tovRt",
    "winPctRecent", "synergyOnOffRating", "avgAge", "avgHeightCm", "avgWeightKg",
    "avgVerticalJumpCm", "avgWingspanCm",
    "restDays", "venueNetRtg", "coachWinPct", "foreignConcentration", "foreignPlayerCount",
    "last1_netrtg", "last1_winPct", "last3_netrtg", "last3_winPct",
    "last5_netrtg", "last5_winPct", "last10_netrtg", "last10_winPct",
]
FORM_KEYS = ["last1_netrtg", "last1_winPct", "last3_netrtg", "last3_winPct",
             "last5_netrtg", "last5_winPct", "last10_netrtg", "last10_winPct"]
NON_FORM = [k for k in BASE_KEYS if k not in FORM_KEYS]
EXTRA_RTG = ["last1_offrtg", "last1_defrtg", "last3_offrtg", "last3_defrtg",
             "last5_offrtg", "last5_defrtg", "last10_offrtg", "last10_defrtg"]
GAME_KEYS = ["dayOfWeek", "month", "refHomeWinRate"]


def derived(side, w):
    """파생 피처. side는 'home'/'away', w는 그 팀의 피처 dict."""
    g = lambda k: w.get(f"{side}_{k}")

    def num(*ks):
        vs = [g(k) for k in ks]
        return None if any(v is None for v in vs) else vs

    out = {}
    # 페이스를 곱해 "경기당 득/실점 규모"로 되돌린 값. 100포제션당 값만으로는 템포 차이가
    # 만드는 실제 점수 규모 차이가 안 보인다.
    v = num("offrtg", "pace")
    out["expPtsPerGame"] = v[0] * v[1] / 100 if v else None
    v = num("defrtg", "pace")
    out["expOppPtsPerGame"] = v[0] * v[1] / 100 if v else None
    # 모멘텀: 최근 폼 - 시즌 평균. "잘하는 팀"과 "지금 올라오는 팀"을 가른다.
    for n in (1, 3, 5, 10):
        v = num(f"last{n}_netrtg", "netrtg")
        out[f"mom{n}"] = v[0] - v[1] if v else None
    # 폼의 안정성: 최근 3경기와 10경기의 차이가 크면 변동이 심한 팀
    v = num("last3_netrtg", "last10_netrtg")
    out["formSpread"] = v[0] - v[1] if v else None
    return out


DERIVED_P75 = ["expPtsPerGame", "expOppPtsPerGame"]
DERIVED_MOM = ["mom1", "mom3", "mom5", "mom10", "formSpread"]

SETS = {
    "base (지금 배포)": (BASE_KEYS, [], GAME_KEYS),
    "no_form (폼 제거)": (NON_FORM, [], GAME_KEYS),
    "form_only (폼만)": (FORM_KEYS, [], GAME_KEYS),
    "plus_rtg (+최근 off/def)": (BASE_KEYS + EXTRA_RTG, [], GAME_KEYS),
    "plus_p75 (+페이스 환산)": (BASE_KEYS, DERIVED_P75, GAME_KEYS),
    "plus_mom (+모멘텀)": (BASE_KEYS, DERIVED_MOM, GAME_KEYS),
    "all (전부)": (BASE_KEYS + EXTRA_RTG, DERIVED_P75 + DERIVED_MOM, GAME_KEYS),
}


def build_xy(rows, team_keys, derived_keys, game_keys):
    X, y = [], []
    for r in rows:
        dh = derived("home", r["home"]) if derived_keys else {}
        da = derived("away", r["away"]) if derived_keys else {}
        feats = [r["home"].get(f"home_{k}") for k in team_keys]
        feats += [r["away"].get(f"away_{k}") for k in team_keys]
        feats += [dh.get(k) for k in derived_keys] + [da.get(k) for k in derived_keys]
        feats += [r.get(k) for k in game_keys]
        X.append([np.nan if v is None else v for v in feats])
        y.append(r["homeWon"])
    return np.array(X, dtype=float), np.array(y, dtype=int)


def season_expanding_cv(seasons_sorted, rows_by_season_idx, min_train_seasons=2):
    splits = []
    for i in range(min_train_seasons, len(seasons_sorted)):
        tr = [idx for s in seasons_sorted[:i] for idx in rows_by_season_idx[s]]
        va = rows_by_season_idx[seasons_sorted[i]]
        if tr and va:
            splits.append((tr, va))
    return splits


def main():
    with open(TABLE_PATH, encoding="utf-8") as f:
        rows = json.load(f)
    seasons = sorted({r["seasonCode"] for r in rows})
    holdout_season = seasons[-1]
    tune_rows = [r for r in rows if r["seasonCode"] != holdout_season]
    hold_rows = [r for r in rows if r["seasonCode"] == holdout_season]
    tune_seasons = sorted({r["seasonCode"] for r in tune_rows})
    by_season = {}
    for i, r in enumerate(tune_rows):
        by_season.setdefault(r["seasonCode"], []).append(i)
    cv = season_expanding_cv(tune_seasons, by_season)
    print("학습 %d경기 / 홀드아웃 %d경기(시즌 %s) / CV 분할 %d개\n"
          % (len(tune_rows), len(hold_rows), holdout_season, len(cv)), flush=True)

    space = {
        "RandomForest": (
            RandomForestClassifier(random_state=0),
            {"n_estimators": [200, 300, 500], "max_depth": [3, 4, 5, 6, None],
             "min_samples_leaf": [5, 10, 20, 30], "max_features": ["sqrt", 0.5, 0.8]},
        ),
        "HistGB": (
            HistGradientBoostingClassifier(random_state=0),
            {"max_depth": [2, 3, 4, None], "max_iter": [50, 100, 150, 300],
             "learning_rate": [0.01, 0.03, 0.05, 0.1], "l2_regularization": [0.0, 0.5, 1.0, 3.0],
             "min_samples_leaf": [10, 20, 30]},
        ),
        "LogReg": (
            make_pipeline(SimpleImputer(strategy="mean"), StandardScaler(), LogisticRegression(max_iter=2000)),
            {"logisticregression__C": [0.01, 0.03, 0.1, 0.3, 1.0, 3.0]},
        ),
    }

    results = []
    for label, (tk, dk, gk) in SETS.items():
        Xt, yt = build_xy(tune_rows, tk, dk, gk)
        Xh, yh = build_xy(hold_rows, tk, dk, gk)
        best_row = None
        for mname, (est, params) in space.items():
            search = RandomizedSearchCV(est, params, n_iter=25, cv=cv, scoring="neg_log_loss",
                                        random_state=0, n_jobs=-1)
            search.fit(Xt, yt)
            probs = search.best_estimator_.predict_proba(Xh)[:, 1]
            acc = accuracy_score(yh, probs >= 0.5)
            ll = log_loss(yh, probs)
            if best_row is None or acc > best_row["acc"]:
                best_row = {"model": mname, "acc": acc, "ll": ll}
        results.append({"set": label, "nFeat": Xt.shape[1], **best_row})
        print("  %-24s 피처 %3d  최고 %-13s 정확도 %5.2f%%  로그손실 %.4f"
              % (label, Xt.shape[1], best_row["model"], best_row["acc"] * 100, best_row["ll"]), flush=True)

    print("\n=== 홀드아웃 정확도 순 ===", flush=True)
    for r in sorted(results, key=lambda r: -r["acc"]):
        print("  %-24s %5.2f%%  (로그손실 %.4f, %s, 피처 %d)"
              % (r["set"], r["acc"] * 100, r["ll"], r["model"], r["nFeat"]), flush=True)
    out = os.path.join(BASE, "..", "raw", "analysis", "form_ablation_results.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    print("\n저장: %s" % out)


if __name__ == "__main__":
    main()
