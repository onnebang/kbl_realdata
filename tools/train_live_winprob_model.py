"""
경기 중(라이브) 승률 예측 모델 학습 + 평가 (2026-08-24).

핵심 검증 방법이 경기전 모델과 다름 - 정확도 하나로는 부족하고, **남은시간 구간별로 쪼개서
정확도/로그손실을 따로 봐야** 함. 잘 만든 라이브 모델이라면 경기 초반(남은시간 많음)엔
정확도가 낮고(득점차가 아직 안 쌓여서 거의 경기전 예측 수준) 막판으로 갈수록 정확도가
급격히 올라가야(득점차가 거의 결과를 결정) 정상 - 이 패턴이 안 나오면 모델이 뭔가 잘못됨.

경기전 모델과 동일하게 시즌 홀드아웃(2025-26) 사용 - 같은 경기의 여러 스냅샷이 train/test에
동시에 걸치면 안 되므로 시즌(=경기) 단위로 자름(스냅샷 단위 무작위 분할 절대 금지 - 그러면
같은 경기의 앞부분은 train, 뒷부분은 test에 들어가는 정보누수가 생김).
"""
import json
import math
import os

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE, "..", "raw", "analysis", "live_winprob_snapshots.json")

# 득점차를 남은시간으로 정규화 - "5점차인데 10초 남음" vs "5점차인데 20분 남음"의 결정력 차이를
# 선형모델이 스스로 못 배우니 직접 만들어 넣어줌(트리모델은 원본 두 변수만으로도 상호작용을
# 배울 수 있지만, 로지스틱회귀 등 선형모델엔 필수적인 피처).
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
        # 2026-08-25 확장(사용자 요청) - "남은 포제션 수"(24초 가정 대신 실측 17.0초/포제션)와
        # "최근 5분/15분 활약"(모멘텀). build_live_winprob_data.py 주석 참고.
        poss_est = r.get("remainingPossessionsEst", rem / 17.0)
        m5 = r.get("netMarginLast5Min", 0.0)
        m15 = r.get("netMarginLast15Min", 0.0)
        X.append([sd, rem, scaled_score_diff(sd, rem), net, syn, poss_est, m5, m15])
        y.append(r["homeWon"])
    return np.array(X, dtype=float), np.array(y, dtype=int)


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

    seasons = sorted({r["seasonCode"] for r in rows})
    test_season = seasons[-1]
    train_rows = [r for r in rows if r["seasonCode"] != test_season]
    test_rows = [r for r in rows if r["seasonCode"] == test_season]
    print(f"train {len(train_rows)}개 (시즌 {seasons[:-1]}) / test {len(test_rows)}개 (시즌 {test_season})", flush=True)

    X_train, y_train = build_xy(train_rows)
    X_test, y_test = build_xy(test_rows)
    base_rate = y_test.mean()
    print(f"test 홈승 베이스레이트(스냅샷 단위): {base_rate:.3f}\n", flush=True)

    models = {
        "LogisticRegression": make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
        "RandomForest": RandomForestClassifier(n_estimators=200, max_depth=8, min_samples_leaf=50,
                                                n_jobs=-1, random_state=0),
        "HistGradientBoosting": HistGradientBoostingClassifier(max_depth=6, max_iter=200,
                                                                 learning_rate=0.1, random_state=0),
    }

    for name, model in models.items():
        model.fit(X_train, y_train)
        probs = model.predict_proba(X_test)[:, 1]
        acc = accuracy_score(y_test, probs >= 0.5)
        ll = log_loss(y_test, probs)
        print(f"[{name}] 전체 test 정확도 {acc*100:.1f}%  로그손실 {ll:.3f}", flush=True)
        evaluate_by_time_bucket(model, test_rows)
        print(flush=True)


if __name__ == "__main__":
    main()
