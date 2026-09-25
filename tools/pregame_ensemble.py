"""
경기 전 승률 모델 래퍼 (RF + 표준화 로지스틱 평균 앙상블). joblib으로 pickle되므로 이 모듈은 가볍게 유지
(numpy/sklearn만) - 추론 쪽에서 `import pregame_ensemble`만 되면 로드된다.

입력 열 레이아웃(기존 predict_upcoming_games.py와 접두 호환):
    [home 기본쌍키][away 기본쌍키][기본 경기키]  +  [home 추가쌍키][away 추가쌍키][추가 경기키]
기존 추론 코드(기본 65열만 만듦)가 이 모델을 부르면 추가 열은 NaN으로 채워 예측한다(성능은 기본 피처 수준으로
떨어지지만 죽지는 않음) - 추가 피처까지 제대로 넣으려면 predict_upcoming_v2.py를 쓸 것.
"""
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


class PregameEnsemble:
    def __init__(self, base_pairs, base_game, extra_pairs, extra_game, components=("rf", "lr"),
                 rf_params=None, lr_C=0.01):
        self.base_pairs, self.base_game = list(base_pairs), list(base_game)
        self.extra_pairs, self.extra_game = list(extra_pairs), list(extra_game)
        self.components = tuple(components)
        self.rf_params = dict(rf_params or {})
        self.lr_C = lr_C
        self.models = {}

    # -- 레이아웃
    @property
    def n_base(self):
        return 2 * len(self.base_pairs) + len(self.base_game)

    @property
    def n_full(self):
        return self.n_base + 2 * len(self.extra_pairs) + len(self.extra_game)

    def _pad(self, X):
        X = np.asarray(X, dtype=float)
        if X.shape[1] == self.n_full:
            return X
        if X.shape[1] == self.n_base:  # 기존 추론 경로: 추가 피처 없음
            return np.hstack([X, np.full((len(X), self.n_full - self.n_base), np.nan)])
        raise ValueError(f"expected {self.n_full} (or legacy {self.n_base}) columns, got {X.shape[1]}")

    def _diff(self, X):
        p0, g0, p1 = len(self.base_pairs), len(self.base_game), len(self.extra_pairs)
        b = self.n_base
        parts = [X[:, :p0] - X[:, p0:2 * p0], X[:, 2 * p0:2 * p0 + g0],
                 X[:, b:b + p1] - X[:, b + p1:b + 2 * p1], X[:, b + 2 * p1:]]
        return np.hstack(parts)

    def _matrix(self, comp, X):
        return X if comp == "rf" else self._diff(X)

    # -- sklearn 인터페이스
    def fit(self, X, y, sample_weight=None):
        X = self._pad(X)
        for c in self.components:
            if c == "rf":
                m = RandomForestClassifier(random_state=0, n_jobs=-1, **self.rf_params)
                m.fit(X, y, sample_weight=sample_weight)
            else:
                m = make_pipeline(SimpleImputer(strategy="mean"), StandardScaler(),
                                  LogisticRegression(C=self.lr_C, max_iter=3000))
                kw = {} if sample_weight is None else {"logisticregression__sample_weight": sample_weight}
                m.fit(self._matrix(c, X), y, **kw)
            self.models[c] = m
        return self

    def predict_proba(self, X):
        X = self._pad(X)
        p = np.mean([self.models[c].predict_proba(self._matrix(c, X))[:, 1] for c in self.components], axis=0)
        return np.column_stack([1 - p, p])


def _selftest():
    rng = np.random.default_rng(0)
    m = PregameEnsemble(["a", "b"], ["g"], ["e"], ["eg"], rf_params=dict(n_estimators=20, min_samples_leaf=5))
    assert m.n_base == 5 and m.n_full == 8
    X = rng.normal(size=(300, 8)); y = (X[:, 0] - X[:, 2] + rng.normal(size=300) > 0).astype(int)
    m.fit(X, y)
    assert m.predict_proba(X).shape == (300, 2)
    assert m.predict_proba(X[:, :5]).shape == (300, 2)  # 기존 추론 경로(65열 등가)
    print("pregame_ensemble selftest ok")


if __name__ == "__main__":
    _selftest()
