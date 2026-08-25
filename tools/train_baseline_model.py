"""
경기 전 승률 예측 - 실제 로지스틱 회귀 베이스라인 (로드맵 05단계, netrtg 단일피처 휴리스틱의
다음 단계). sklearn 등 외부 라이브러리 없이 순수 파이썬 경사하강법으로 학습 - .venv에 아무
ML 라이브러리도 없어서, 그리고 피처/샘플 규모(19개 피처 x 1,400행)가 작아 굳이 무거운
의존성을 새로 깔 필요가 없음.

**시즌 기준으로 train/test를 나눈다** - 무작위로 섞어서 나누면 같은 시즌 안의 팀 전력이
train/test에 누수되기 쉬움(팀 전력은 시즌 내내 비슷하게 유지되니까). 과거 시즌으로 학습해서
미래 시즌을 맞추는 게 실제 배포 상황(다음 경기를 예측)과 훨씬 비슷함.
"""
import json
import math
import os

BASE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.path.join(BASE, "..", "raw", "analysis", "pregame_training_table.json")

# 2026-08-19 애블레이션 결과(미래시즌 홀드아웃 기준, README 참고):
#   team-stats만            acc 58.3% logloss 0.690
#   team-stats + synergy    acc 59.7% logloss 0.674  <- 최고, 지금 기본값
#   team-stats + bio(나이/키/몸무게)  acc 55.1% logloss 0.696  <- 오히려 악화
#   synergy만(피처 1개)      acc 59.4% logloss 0.670
# 시너지(온/오프코트 net rating)는 확실히 도움됨. 나이/키/몸무게/버티컬점프/윙스팬은 이
# 단순 선형모델+팀레벨 가중평균 방식으로는 신호를 못 뽑아냄 - 커버리지가 낮은(버티컬점프
# 23%) 탓도 있고, 개인 신체스펙을 팀 단위로 뭉개버리면 정보가 많이 죽는 탓도 있을 것.
# 완전히 무의미하다고 결론내리긴 이름 - 더 정교한 방식(예: 선수 단위 피처를 팀 단위로
# 뭉개지 않고 그대로 쓰는 모델)에서는 다르게 나올 수 있음.
FEATURE_KEYS = [
    "offrtg", "defrtg", "netrtg", "pace", "efgRt", "tsRt", "rebRt", "astRt", "tovRt", "winPctRecent",
    "synergyOnOffRating",
]


def build_xy(rows):
    X, y = [], []
    for r in rows:
        feats = []
        for k in FEATURE_KEYS:
            feats.append(r["home"].get(f"home_{k}") or 0.0)
        for k in FEATURE_KEYS:
            feats.append(r["away"].get(f"away_{k}") or 0.0)
        X.append(feats)
        y.append(r["homeWon"])
    return X, y


def standardize(X, mean=None, std=None):
    n = len(X[0])
    if mean is None:
        mean = [sum(row[j] for row in X) / len(X) for j in range(n)]
        std = []
        for j in range(n):
            var = sum((row[j] - mean[j]) ** 2 for row in X) / len(X)
            std.append(math.sqrt(var) or 1.0)
    return [[(row[j] - mean[j]) / std[j] for j in range(n)] for row in X], mean, std


def sigmoid(z):
    if z < -60:
        return 0.0
    if z > 60:
        return 1.0
    return 1.0 / (1.0 + math.exp(-z))


def train_logreg(X, y, epochs=800, lr=0.1, l2=0.01):
    n, d = len(X), len(X[0])
    w = [0.0] * d
    b = 0.0
    for _ in range(epochs):
        grad_w = [0.0] * d
        grad_b = 0.0
        for xi, yi in zip(X, y):
            z = sum(w[j] * xi[j] for j in range(d)) + b
            pred = sigmoid(z)
            err = pred - yi
            for j in range(d):
                grad_w[j] += err * xi[j]
            grad_b += err
        for j in range(d):
            w[j] = w[j] - lr * (grad_w[j] / n + l2 * w[j])
        b = b - lr * (grad_b / n)
    return w, b


def predict(X, w, b):
    return [sigmoid(sum(w[j] * xi[j] for j in range(len(w))) + b) for xi in X]


def accuracy(probs, y):
    correct = sum(1 for p, yi in zip(probs, y) if (p >= 0.5) == bool(yi))
    return correct / len(y)


def main():
    with open(TABLE_PATH, encoding="utf-8") as f:
        rows = json.load(f)

    seasons = sorted({r["seasonCode"] for r in rows})
    # 마지막 시즌(가장 최근, 2025-26)을 테스트로 남기고 나머지로 학습 - 시간순 홀드아웃
    test_season = seasons[-1]
    train_rows = [r for r in rows if r["seasonCode"] != test_season]
    test_rows = [r for r in rows if r["seasonCode"] == test_season]
    print(f"train: {len(train_rows)}행 (시즌 {seasons[:-1]}), test: {len(test_rows)}행 (시즌 {test_season})", flush=True)

    X_train, y_train = build_xy(train_rows)
    X_test, y_test = build_xy(test_rows)
    X_train, mean, std = standardize(X_train)
    X_test, _, _ = standardize(X_test, mean, std)

    w, b = train_logreg(X_train, y_train)

    train_probs = predict(X_train, w, b)
    test_probs = predict(X_test, w, b)
    train_acc = accuracy(train_probs, y_train)
    test_acc = accuracy(test_probs, y_test)
    test_base_rate = sum(y_test) / len(y_test)

    print(f"train 정확도: {train_acc:.3f}", flush=True)
    print(f"test 정확도: {test_acc:.3f}  (test 구간 홈승 베이스레이트: {test_base_rate:.3f})", flush=True)

    # 로그손실도 같이 (정확도만으론 확률 보정 품질을 못 봄 - 승률 "예측"이 목적이라 중요)
    def logloss(probs, y):
        eps = 1e-9
        return -sum(yi * math.log(p + eps) + (1 - yi) * math.log(1 - p + eps) for p, yi in zip(probs, y)) / len(y)
    print(f"test 로그손실: {logloss(test_probs, y_test):.3f}  (참고: 베이스레이트로만 찍으면 {logloss([test_base_rate]*len(y_test), y_test):.3f})", flush=True)

    # 피처 중요도 참고용 (표준화된 좌표계에서의 계수 크기)
    names = [f"home_{k}" for k in FEATURE_KEYS] + [f"away_{k}" for k in FEATURE_KEYS]
    ranked = sorted(zip(names, w), key=lambda x: -abs(x[1]))
    print("영향력 큰 피처 top 5:", flush=True)
    for name, coef in ranked[:5]:
        print(f"  {name}: {coef:+.3f}", flush=True)


if __name__ == "__main__":
    main()
