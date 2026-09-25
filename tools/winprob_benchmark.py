"""
경기 전 승률 모델 벤치마크 하니스 (시간순 walk-forward, 누수 없음).

  * walk-forward: 시즌 s를 시즌 < s 데이터로만 학습한 모델로 예측 (최근 6개 완결 시즌을 테스트)
  * sequential : 최근 2시즌을 N경기 블록 단위로 "그 블록 이전 전부"로 재학습하며 예측
                 (시즌 중 매일/라운드별 재학습을 흉내)
  * 지표: 정확도/로그손실/Brier/AUC/ECE, 모델 간 로그손실 차이의 paired bootstrap 95% CI
  * 보정(calibration)은 "그 시즌 이전의 OOF 예측"으로만 학습 (walk-forward 예측 자체가 OOF)

사용:  python -X utf8 tools/winprob_benchmark.py [--out-dir tools/model_reports] [--quick]
입력:  raw/analysis/pregame_training_table.json (export_training_table.py 산출물, 읽기만 함)
       raw/analysis/winprob_games_cache.json  (winprob_features.py가 만드는 경기 캐시)
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

import winprob_features as wf

BASE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.path.join(BASE, "..", "raw", "analysis", "pregame_training_table.json")
CURRENT_SEASON_EXCLUDE = 49  # 새 규정 첫 시즌 - tune_hyperparams/save_pregame_model과 동일
MIN_TRAIN_SEASONS = 3
N_TEST_SEASONS = 6

# tune_hyperparams.py의 FEATURE_KEYS/GAME_LEVEL_KEYS와 동일(그 모듈은 xgboost를 import해서 복사)
BASE_PAIR_KEYS = [
    "offrtg", "defrtg", "netrtg", "pace", "efgRt", "tsRt", "rebRt", "astRt", "tovRt",
    "winPctRecent", "synergyOnOffRating", "avgAge", "avgHeightCm", "avgWeightKg",
    "avgVerticalJumpCm", "avgWingspanCm",
    "restDays", "venueNetRtg", "coachWinPct", "foreignConcentration", "foreignPlayerCount",
    "last1_netrtg", "last1_winPct", "last3_netrtg", "last3_winPct",
    "last5_netrtg", "last5_winPct", "last10_netrtg", "last10_winPct", "teamPWR",
]
BASE_GAME_KEYS = ["dayOfWeek", "month", "refHomeWinRate"]
GROUPS = {  # 그룹 -> (팀별 쌍 키, 경기 단위 키)
    "base": (BASE_PAIR_KEYS, BASE_GAME_KEYS),
    "elo": (["elo"], ["eloDiff", "eloProb"]),
    "sched": (["b2b", "gamesLast7", "gamesLast14", "sameVenueStreak"], []),
    "avail": (["missTop8Share", "missTop3Share", "missTop8Count"], []),
}

INCUMBENT_RF = dict(n_estimators=200, min_samples_leaf=30, max_features="sqrt", max_depth=None)  # tuned_model_results.json


# ---------------------------------------------------------------- 데이터
def load_dataset(table_path=TABLE_PATH, elo_kw=None, games=None):
    """테이블 행(시즌 49 제외 안 함) + 추가 피처 컬럼 -> (rows, cols dict of np arrays)."""
    with open(table_path, encoding="utf-8") as f:
        rows = json.load(f)
    rows.sort(key=lambda r: (r["gameDate"], r["gmkey"]))
    games = games if games is not None else wf.load_games()
    extras, _ = wf.build_extras(games, **(elo_kw or {}))
    cols = {}

    def put(name, vals):
        cols[name] = np.array([np.nan if v is None else v for v in vals], dtype=float)

    for k in BASE_PAIR_KEYS:
        put(f"h_{k}", [r["home"].get(f"home_{k}") for r in rows])
        put(f"a_{k}", [r["away"].get(f"away_{k}") for r in rows])
    for k in BASE_GAME_KEYS:
        put(k, [r.get(k) for r in rows])
    ex = [extras.get(r["gmkey"]) for r in rows]
    for g, (pairs, gks) in GROUPS.items():
        if g == "base":
            continue
        for k in pairs:
            put(f"h_{k}", [e["home"][k] if e else None for e in ex])
            put(f"a_{k}", [e["away"][k] if e else None for e in ex])
        for k in gks:
            put(k, [e["game"][k] if e else None for e in ex])
    meta = {"season": np.array([r["seasonCode"] for r in rows]), "y": np.array([r["homeWon"] for r in rows]),
            "gmkey": [r["gmkey"] for r in rows], "date": [r["gameDate"] for r in rows]}
    return rows, cols, meta


def design(cols, groups, diff=False):
    names = []
    for g in groups:
        pairs, gks = GROUPS[g]
        for k in pairs:
            names += [f"d_{k}"] if diff else [f"h_{k}", f"a_{k}"]
        names += gks
    parts = []
    for n in names:
        if n.startswith("d_"):
            parts.append(cols["h_" + n[2:]] - cols["a_" + n[2:]])
        else:
            parts.append(cols[n])
    return np.column_stack(parts), names


# ---------------------------------------------------------------- 모델
def make_model(kind, **kw):
    if kind == "rf":
        p = dict(INCUMBENT_RF); p.update(kw)
        return RandomForestClassifier(random_state=0, n_jobs=-1, **p)
    if kind == "lr":
        return make_pipeline(SimpleImputer(strategy="mean"), StandardScaler(),
                             LogisticRegression(C=kw.get("C", 0.01), max_iter=3000))
    if kind == "hgb":
        p = dict(max_depth=3, learning_rate=0.03, max_iter=150, l2_regularization=3.0, min_samples_leaf=30)
        p.update(kw)
        return HistGradientBoostingClassifier(random_state=0, **p)
    raise ValueError(kind)


def fit_predict(kind, X, y, Xte, w=None, **kw):
    m = make_model(kind, **kw)
    if w is None:
        m.fit(X, y)
    elif kind == "lr":
        m.fit(X, y, logisticregression__sample_weight=w)
    else:
        m.fit(X, y, sample_weight=w)
    return m.predict_proba(Xte)[:, 1]


# ---------------------------------------------------------------- 지표
def ece(y, p, bins=10):
    idx = np.minimum((p * bins).astype(int), bins - 1)
    tot = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            tot += m.mean() * abs(y[m].mean() - p[m].mean())
    return float(tot)


def metrics(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return {"n": int(len(y)), "acc": float(((p >= .5) == y).mean()), "logloss": float(log_loss(y, p, labels=[0, 1])),
            "brier": float(brier_score_loss(y, p)),
            "auc": float(roc_auc_score(y, p)) if len(set(y)) > 1 else None, "ece": ece(y, p)}


def per_game_loss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def paired_bootstrap(loss_a, loss_b, B=2000, seed=0):
    """mean(loss_b - loss_a) 와 95% CI (음수 = b가 더 좋음)."""
    d = loss_b - loss_a
    rng = np.random.default_rng(seed)
    means = d[rng.integers(0, len(d), (B, len(d)))].mean(1)
    return float(d.mean()), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


# ---------------------------------------------------------------- walk-forward
def seasons_of(meta):
    return sorted(s for s in set(meta["season"].tolist()) if s != CURRENT_SEASON_EXCLUDE)


def walk_forward(kind, X, meta, min_train=MIN_TRAIN_SEASONS, **kw):
    """모든 시즌(min_train번째부터) 예측 -> 전 행 길이 배열(예측 못 한 행은 NaN). 이게 곧 OOF."""
    ss = seasons_of(meta)
    y, season = meta["y"], meta["season"]
    pred = np.full(len(y), np.nan)
    for i in range(min_train, len(ss)):
        tr = np.isin(season, ss[:i])
        te = season == ss[i]
        try:
            pred[te] = fit_predict(kind, X[tr], y[tr], X[te], **kw)
        except Exception as e:  # noqa - 예: teamPWR window-shape/구간화 크래시 -> 그 모델은 건너뜀
            print(f"    [{kind}] season {ss[i]} 실패: {e}", flush=True)
            return None
    return pred


def calibrate_oof(pred, meta, method, min_prior=1):
    """시즌 s의 예측을, s 이전 시즌들의 OOF 예측(pred) 위에서 학습한 보정기로 변환. 누수 없음."""
    ss = seasons_of(meta)
    y, season = meta["y"], meta["season"]
    out = pred.copy()
    for i, s in enumerate(ss):
        te = season == s
        prior = np.isin(season, ss[:i]) & ~np.isnan(pred)
        if prior.sum() < 300 or np.isnan(pred[te]).any():
            continue
        if method == "isotonic":
            m = IsotonicRegression(out_of_bounds="clip", y_min=0.02, y_max=0.98).fit(pred[prior], y[prior])
            out[te] = m.predict(pred[te])
        else:  # platt
            z = lambda p: np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))[:, None]
            m = LogisticRegression(C=1e4).fit(z(pred[prior]), y[prior])
            out[te] = m.predict_proba(z(pred[te]))[:, 1]
    return out


def sequential(kind, X, meta, seasons, block=45, **kw):
    """seasons 안 경기들을 시간순 block경기 단위로: 그 블록 이전 전부(시즌 49 제외)로 재학습 -> 블록 예측."""
    y, season = meta["y"], meta["season"]
    valid = season != CURRENT_SEASON_EXCLUDE
    pred = np.full(len(y), np.nan)
    idx = np.where(np.isin(season, seasons))[0]  # 이미 날짜순 정렬된 행
    for st in range(0, len(idx), block):
        te = idx[st:st + block]
        tr = np.arange(len(y)) < te[0]
        tr &= valid
        pred[te] = fit_predict(kind, X[tr], y[tr], X[te], **kw)
    return pred


# ---------------------------------------------------------------- Elo 파라미터(테스트 시즌 이전 데이터로만 선택)
def tune_elo(games, table_rows, select_max_season=35):
    """Elo 예측확률 자체의 로그손실을 시즌 <= select_max_season 경기(테스트 시즌과 무관)에서 비교."""
    best = None
    ys = {r["gmkey"]: (r["homeWon"], r["seasonCode"]) for r in table_rows}
    for K in (5, 10, 20, 30):
        for carry in (0.4, 0.6, 0.75, 0.9):
            for hfa in (20, 40, 65, 90):
                ex, _ = wf.build_extras(games, K=K, hfa=hfa, carry=carry)
                p, y = [], []
                for gk, (won, s) in ys.items():
                    if s <= select_max_season and s >= 15:
                        p.append(ex[gk]["game"]["eloProb"]); y.append(won)
                ll = log_loss(y, np.clip(p, 1e-4, 1 - 1e-4))
                if best is None or ll < best[0]:
                    best = (ll, dict(K=K, hfa=hfa, carry=carry))
    return best


# ---------------------------------------------------------------- 리포트
def summarize(name, pred, meta, test_seasons):
    y, season = meta["y"], meta["season"]
    per = {int(s): metrics(y[season == s], pred[season == s]) for s in test_seasons}
    m = np.isin(season, test_seasons)
    return {"name": name, "perSeason": per, "pooled": metrics(y[m], pred[m])}


def compare(pred_a, pred_b, meta, test_seasons):
    y, season = meta["y"], meta["season"]
    m = np.isin(season, test_seasons)
    la, lb = per_game_loss(y, pred_a), per_game_loss(y, pred_b)
    d, lo, hi = paired_bootstrap(la[m], lb[m])
    per = {int(s): float((lb - la)[season == s].mean()) for s in test_seasons}
    return {"dLogloss": d, "ci95": [lo, hi], "perSeasonD": per, "seasonsImproved": int(sum(v < 0 for v in per.values()))}


def keep_rule(cmp):
    """채택 규칙: 풀링 로그손실 개선 + 테스트 시즌 중 3개 이상에서 개선."""
    return cmp["dLogloss"] < 0 and cmp["seasonsImproved"] >= 3


def md_table(results, cmps, inc):
    ls = ["| config | acc | logloss | brier | AUC | ECE | dLL vs incumbent [95% CI] | seasons better |", "|---|---|---|---|---|---|---|---|"]
    for r in results:
        p = r["pooled"]; c = cmps.get(r["name"])
        cs = "-" if not c else f"{c['dLogloss']:+.4f} [{c['ci95'][0]:+.4f}, {c['ci95'][1]:+.4f}]"
        sb = "-" if not c else f"{c['seasonsImproved']}/{len(c['perSeasonD'])}"
        ls.append(f"| {r['name']} | {p['acc']:.3f} | {p['logloss']:.4f} | {p['brier']:.4f} | {p['auc']:.3f} | {p['ece']:.3f} | {cs} | {sb} |")
    return "\n".join(ls)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=os.path.join(BASE, "model_reports"))
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--skip-elo-tune", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    games = wf.load_games()
    rows, cols0, meta = load_dataset(games=games)
    ss = seasons_of(meta)
    test_seasons = ss[-N_TEST_SEASONS:]
    print(f"rows={len(rows)} seasons={ss} test={test_seasons}", flush=True)

    elo_kw = dict(K=20, hfa=65, carry=0.75)
    if not a.skip_elo_tune:
        ll, elo_kw = tune_elo(games, rows)
        print(f"Elo 파라미터(시즌<=35 선택): {elo_kw} logloss={ll:.4f}", flush=True)
        rows, cols0, meta = load_dataset(games=games, elo_kw=elo_kw)
    cols = cols0

    specs = {  # name -> (kind, groups, diff, kwargs)
        "RF base (incumbent)": ("rf", ["base"], False, {}),
        "RF +elo": ("rf", ["base", "elo"], False, {}),
        "RF +sched": ("rf", ["base", "sched"], False, {}),
        "RF +avail": ("rf", ["base", "avail"], False, {}),
        "RF +elo+sched+avail": ("rf", ["base", "elo", "sched", "avail"], False, {}),
        "LR base": ("lr", ["base"], False, {}),
        "LR diff base": ("lr", ["base"], True, {}),
        "LR diff +elo": ("lr", ["base", "elo"], True, {}),
        "LR diff +elo+sched+avail": ("lr", ["base", "elo", "sched", "avail"], True, {}),
        "LR elo-only": ("lr", ["elo"], True, {"C": 1.0}),
        "LR diff +all C=0.003": ("lr", ["base", "elo", "sched", "avail"], True, {"C": 0.003}),
        "LR diff +all C=0.03": ("lr", ["base", "elo", "sched", "avail"], True, {"C": 0.03}),
        "RF leaf60 +all": ("rf", ["base", "elo", "sched", "avail"], False, {"min_samples_leaf": 60}),
        "RF +elo+avail": ("rf", ["base", "elo", "avail"], False, {}),
        "LR diff +elo+avail": ("lr", ["base", "elo", "avail"], True, {}),
        "HGB base": ("hgb", ["base"], False, {}),
        "HGB +elo+sched+avail": ("hgb", ["base", "elo", "sched", "avail"], False, {}),
    }
    if a.quick:
        specs = {k: v for k, v in specs.items() if k in ("RF base (incumbent)", "RF +elo", "LR diff +elo")}
    preds = {}
    for name, (kind, groups, diff, kw) in specs.items():
        X, _ = design(cols, groups, diff)
        p = walk_forward(kind, X, meta, **kw)
        print(f"{name}: {'FAILED' if p is None else 'ok'} ({time.time()-t0:.0f}s)", flush=True)
        if p is not None:
            preds[name] = p

    inc = "RF base (incumbent)"
    # 단순 평균 앙상블 (사후 결합)
    for a_, b_ in (("RF base (incumbent)", "LR diff base"), ("RF +elo+sched+avail", "LR diff +elo+sched+avail"),
                 ("RF +elo+avail", "LR diff +elo+avail")):
        if a_ in preds and b_ in preds:
            preds[f"AVG[{a_} | {b_}]"] = (preds[a_] + preds[b_]) / 2
    # 상수(베이스레이트) 기준선
    y, season = meta["y"], meta["season"]
    const = np.full(len(y), np.nan)
    for i in range(MIN_TRAIN_SEASONS, len(ss)):
        const[season == ss[i]] = y[np.isin(season, ss[:i])].mean()
    preds["const home-rate"] = const

    order = sorted((k for k in preds if k != inc), key=lambda k: metrics(y[np.isin(season, test_seasons)], preds[k][np.isin(season, test_seasons)])["logloss"])
    results = [summarize(inc, preds[inc], meta, test_seasons)] + [summarize(k, preds[k], meta, test_seasons) for k in order]
    cmps = {k: compare(preds[inc], preds[k], meta, test_seasons) for k in order}

    # 보정 (OOF 기반) - 상위 모델(개선 채택 후보 또는 인큐번트)에 적용
    cal = {}
    best_name = min((k for k in preds if k != "const home-rate"), key=lambda k: results_ll(results, k))
    for base_name in {inc, best_name}:
        for method in ("isotonic", "platt"):
            n = f"{base_name} +{method}"
            p = calibrate_oof(preds[base_name], meta, method)
            cal[n] = p
            results.append(summarize(n, p, meta, test_seasons))
            cmps[n] = compare(preds[inc], p, meta, test_seasons)
    # 시퀀스(시즌 내 재학습)
    seq = {}
    if not a.quick:
        seq_seasons = test_seasons[-2:]
        for name in {inc, best_name}:
            comps = [name] if name in specs else (name[4:-1].split(" | ") if name.startswith("AVG[") else [])
            if not comps or any(c not in specs for c in comps):
                continue
            ps = []
            for c in comps:
                kind, groups, diff, kw = specs[c]
                X, _ = design(cols, groups, diff)
                ps.append(sequential(kind, X, meta, seq_seasons, **kw))
            p = np.mean(ps, axis=0)
            m = np.isin(season, seq_seasons)
            static = preds[name]
            seq[name] = {"sequentialPooled": metrics(y[m], p[m]), "staticPooled": metrics(y[m], static[m]),
                         "cmp_seq_vs_static": compare(static, p, meta, seq_seasons)}
            print(f"sequential {name}: {seq[name]['sequentialPooled']['logloss']:.4f} vs static {seq[name]['staticPooled']['logloss']:.4f}", flush=True)

    all_cmp = dict(cmps)
    out = {"generated": time.strftime("%Y-%m-%d %H:%M"), "eloParams": elo_kw, "testSeasons": test_seasons,
           "incumbent": inc, "bestByLogloss": best_name, "results": results, "comparisons": all_cmp,
           "keepRule": {k: keep_rule(v) for k, v in all_cmp.items()}, "sequential": seq,
           "calibrationBaseModels": sorted({inc, best_name})}
    os.makedirs(a.out_dir, exist_ok=True)
    with open(os.path.join(a.out_dir, "benchmark_latest.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    md = ["# Pre-game win-prob benchmark (walk-forward)", f"generated {out['generated']}, test seasons {test_seasons}, Elo {elo_kw}", "",
          md_table(results, all_cmp, inc), "", "Per-season logloss:", ""]
    for r in results:
        md.append(f"- {r['name']}: " + ", ".join(f"{s}:{v['logloss']:.3f}" for s, v in r["perSeason"].items()))
    md.append("\nKeep rule (pooled logloss better AND >=3 seasons better): " + json.dumps(out["keepRule"], ensure_ascii=False))
    for k, v in seq.items():
        md.append(f"\nSequential (retrain every 45 games) {k}: seq {v['sequentialPooled']['logloss']:.4f} vs static {v['staticPooled']['logloss']:.4f}, "
                  f"dLL {v['cmp_seq_vs_static']['dLogloss']:+.4f} CI {v['cmp_seq_vs_static']['ci95']}")
    with open(os.path.join(a.out_dir, "benchmark_latest.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md))
    print("\n".join(md), flush=True)
    print(f"done {time.time()-t0:.0f}s")


def results_ll(results, name):
    return next(r["pooled"]["logloss"] for r in results if r["name"] == name)


if __name__ == "__main__":
    main()
