"""
경기 전 승률 모델 자동 재학습 파이프라인 (도전자 vs 현행 비교 후 조건부 승격).

흐름
  1. (선택 --rebuild-table) export_training_table.py의 피처 빌더로 학습 테이블 재생성 - 새로 끝난 경기 반영
  2. 새 경기 캐시(winprob_features.load_games, 증분) -> Elo/결장 피처 결합
  3. 학습 자격: 정규/플레이오프/챔프전은 포함, OPEN MATCH DAY(gmkey의 G14)는 기본 제외
     (--include-open-match 로 켜면 --open-match-weight 가중치로만 포함).
     최신 시즌은 자격 경기가 --min-current-games(기본 40) 미만이면 통째로 제외(새 규정 전환기 소표본 방지).
  4. 홀드아웃(시간순, 누수 없음): (A) 완결 시즌(자격 경기>=200) 마지막 2개를 walk-forward + (B) 가장 최근 N경기
     (그 이전 자격 행으로만 학습). 도전자 설정과 현행(incumbent) 설정을 동일 조건으로 재학습해 비교.
  5. 승격 규칙: 도전자 로그손실 <= 현행 + tol(기본 0.002) 일 때만 joblib+meta 저장, 아니면 현행 유지.
  6. 멱등: 학습 데이터 해시+설정이 지난 실행과 같으면 아무것도 안 함(--force로 무시).

쓰기 위치는 --out-dir 아래뿐(기본 raw/analysis). --dry-run 이면 아무것도 안 씀.

사용
  python -X utf8 tools/retrain_pregame_model.py --dry-run
  python -X utf8 tools/retrain_pregame_model.py --out-dir raw/challenger --incumbent raw/analysis/pregame_model.joblib
  python -X utf8 tools/retrain_pregame_model.py --self-test
"""
import argparse
import datetime
import hashlib
import json
import os
import shutil
import sys

import joblib
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

import winprob_benchmark as wb  # noqa: E402
import winprob_features as wf   # noqa: E402
from pregame_ensemble import PregameEnsemble  # noqa: E402

ANALYSIS = os.path.join(BASE, "..", "raw", "analysis")
OPEN_MATCH_CODES = {"G14"}  # meta.gameCode 14 = OPEN MATCH DAY (프리시즌 오픈매치)

CONFIG_V2 = {"name": "avg(RF, LR-diff) +elo +avail", "groups": ["base", "elo", "avail"], "components": ["rf", "lr"],
             "rf": wb.INCUMBENT_RF, "lr_C": 0.01, "elo": {"K": 10, "hfa": 40, "carry": 0.4}}
CONFIG_LEGACY = {"name": "RF base (legacy incumbent)", "groups": ["base"], "components": ["rf"],
                 "rf": wb.INCUMBENT_RF, "lr_C": 0.01, "elo": {"K": 10, "hfa": 40, "carry": 0.4}}
BUNDLE_FORMAT = 2


# ---------------------------------------------------------------- 승격 규칙 (순수 함수)
def promote_decision(inc_ll, chal_ll, n_holdout, tol=0.002, min_n=200):
    """(promote: bool, reason: str). 도전자가 현행보다 tol 넘게 나쁘거나, 홀드아웃이 너무 작으면 승격 안 함."""
    if n_holdout < min_n:
        return False, f"holdout too small ({n_holdout} < {min_n})"
    if chal_ll <= inc_ll + tol:
        return True, f"challenger {chal_ll:.4f} <= incumbent {inc_ll:.4f} + tol {tol}"
    return False, f"challenger {chal_ll:.4f} worse than incumbent {inc_ll:.4f} by more than tol {tol}"


def self_test():
    assert promote_decision(0.650, 0.648, 500)[0]
    assert promote_decision(0.650, 0.652, 500)[0]           # 정확히 tol 이내
    assert not promote_decision(0.650, 0.6521, 500)[0]      # tol 초과
    assert not promote_decision(0.650, 0.640, 50)[0]        # 홀드아웃 부족
    assert promote_decision(0.650, 0.6521, 500, tol=0.005)[0]
    print("promote_decision self-test ok")


# ---------------------------------------------------------------- 모델/행렬
def extras_of(cfg):
    pairs, game = [], []
    for g in cfg["groups"]:
        if g == "base":
            continue
        p, gk = wb.GROUPS[g]
        pairs += p
        game += gk
    return pairs, game


def make_ensemble(cfg):
    ep, eg = extras_of(cfg)
    return PregameEnsemble(wb.BASE_PAIR_KEYS, wb.BASE_GAME_KEYS, ep, eg, components=cfg["components"],
                           rf_params=cfg["rf"], lr_C=cfg["lr_C"])


def full_matrix(cols, cfg):
    """[h 기본][a 기본][기본 경기키][h 추가][a 추가][추가 경기키] - PregameEnsemble 레이아웃."""
    ep, eg = extras_of(cfg)
    parts = [cols[f"h_{k}"] for k in wb.BASE_PAIR_KEYS] + [cols[f"a_{k}"] for k in wb.BASE_PAIR_KEYS] \
        + [cols[k] for k in wb.BASE_GAME_KEYS] + [cols[f"h_{k}"] for k in ep] + [cols[f"a_{k}"] for k in ep] \
        + [cols[k] for k in eg]
    return np.column_stack(parts)


def fit_predict(cfg, X, y, w, tr, te):
    m = make_ensemble(cfg)
    m.fit(X[tr], y[tr], sample_weight=w[tr] if w is not None else None)
    return m.predict_proba(X[te])[:, 1]


# ---------------------------------------------------------------- 데이터 자격
def eligibility(meta, include_open, open_weight, min_current_games):
    codes = np.array([g[3:6] for g in meta["gmkey"]])
    is_open = np.isin(codes, list(OPEN_MATCH_CODES))
    w = np.where(is_open, open_weight if include_open else 0.0, 1.0)
    season = meta["season"]
    latest = season.max()
    cur = (season == latest) & (w > 0) & ~is_open
    if 0 < cur.sum() < min_current_games:  # 최신 시즌이 아직 소표본 -> 학습에서 제외 (테스트 전용)
        w = np.where(season == latest, 0.0, w)
    return w, is_open


def data_hash(meta, w, cfg):
    h = hashlib.sha1(json.dumps(cfg, sort_keys=True).encode())
    for gk, wi in zip(meta["gmkey"], w):
        if wi > 0:
            h.update(f"{gk}:{wi:.3f};".encode())
    return h.hexdigest()[:12]


# ---------------------------------------------------------------- 홀드아웃 평가
def holdout_eval(cols, meta, w, is_open, cfg_c, cfg_i, incumbent_bundle, newest_n, include_open):
    y, season = meta["y"], meta["season"]
    n = len(y)
    order = np.arange(n)  # load_dataset이 날짜순 정렬
    train_ok = w > 0
    Xc, Xi = full_matrix(cols, cfg_c), full_matrix(cols, cfg_i)
    # (A) 완결 시즌 walk-forward
    elig_per_season = {s: int(((season == s) & train_ok).sum()) for s in np.unique(season)}
    complete = [s for s in sorted(elig_per_season) if elig_per_season[s] >= 200]
    test_seasons = complete[-2:]
    pc, pi, in_h, where = np.full(n, np.nan), np.full(n, np.nan), np.zeros(n, bool), np.array([""] * n, dtype=object)
    for s in test_seasons:
        te = season == s
        tr = train_ok & (season < s)
        if tr.sum() < 500:
            continue
        pc[te] = fit_predict(cfg_c, Xc, y, w, tr, te)
        pi[te] = fit_predict(cfg_i, Xi, y, w, tr, te)
        in_h |= te
        where[te] = "A"
    # (B) 가장 최근 N경기 (오픈매치는 옵션 켰을 때만 테스트 대상)
    cand = order[~is_open | include_open]
    newest = cand[-newest_n:] if newest_n > 0 else np.array([], int)
    newest = newest[~in_h[newest]]
    used_deployed = False
    if len(newest):
        start = newest[0]
        te = np.zeros(n, bool); te[newest] = True
        tr = train_ok & (order < start)
        pc[te] = fit_predict(cfg_c, Xc, y, w, tr, te)
        # 현행 모델을 그대로 쓸 수 있으면(학습 종료일이 B 시작 이전) 실제 배포 모델로, 아니면 동일조건 재학습
        thr = (incumbent_bundle or {}).get("trainedThroughDate")
        if incumbent_bundle is not None and thr and thr < meta["date"][start]:
            im = incumbent_bundle["model"]
            Xd = Xi[te] if isinstance(im, PregameEnsemble) else _legacy_X(cols, incumbent_bundle)[te]
            pi[te] = im.predict_proba(Xd)[:, 1]
            used_deployed = True
        else:
            pi[te] = fit_predict(cfg_i, Xi, y, w, tr, te)
        in_h |= te
        where[te] = "B"
    m = in_h & ~np.isnan(pc) & ~np.isnan(pi)
    out = {"testSeasons": [int(s) for s in test_seasons], "nA": int((where == "A").sum()), "nB": int((where == "B").sum()),
           "incumbentDeployedUsedOnB": used_deployed, "n": int(m.sum())}
    if m.sum():
        out["challenger"] = wb.metrics(y[m], pc[m])
        out["incumbent"] = wb.metrics(y[m], pi[m])
        d, lo, hi = wb.paired_bootstrap(wb.per_game_loss(y[m], pi[m]), wb.per_game_loss(y[m], pc[m]))
        out["dLogloss"], out["ci95"] = d, [lo, hi]
        for tag in ("A", "B"):
            mm = m & (where == tag)
            if mm.sum() > 1 and len(set(y[mm])) > 1:
                out[f"challenger{tag}"], out[f"incumbent{tag}"] = wb.metrics(y[mm], pc[mm]), wb.metrics(y[mm], pi[mm])
    return out


def _legacy_X(cols, bundle):
    ks, gk = bundle["featureKeys"], bundle["gameLevelKeys"]
    return np.column_stack([cols[f"h_{k}"] for k in ks] + [cols[f"a_{k}"] for k in ks] + [cols[k] for k in gk])


# ---------------------------------------------------------------- 메인
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--analysis-dir", default=ANALYSIS, help="입력 테이블 위치(읽기)")
    ap.add_argument("--out-dir", default=None, help="결과 쓰기 위치 (기본: analysis-dir)")
    ap.add_argument("--incumbent", default=None, help="현행 모델 joblib (기본: <out-dir>/pregame_model.joblib)")
    ap.add_argument("--rebuild-table", action="store_true")
    ap.add_argument("--include-open-match", action="store_true")
    ap.add_argument("--open-match-weight", type=float, default=0.3)
    ap.add_argument("--min-current-games", type=int, default=40)
    ap.add_argument("--newest-n", type=int, default=60)
    ap.add_argument("--tol", type=float, default=0.002)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        self_test()
        return
    analysis = os.path.abspath(a.analysis_dir)
    out_dir = os.path.abspath(a.out_dir or analysis)
    model_path = os.path.join(out_dir, "pregame_model.joblib")
    meta_path = os.path.join(out_dir, "pregame_model_meta.json")
    state_path = os.path.join(out_dir, "retrain_last_run.json")
    inc_path = os.path.abspath(a.incumbent) if a.incumbent else model_path
    table_path = os.path.join(analysis, "pregame_training_table.json")

    if a.rebuild_table:
        import export_training_table as ett
        table_path = os.path.join(out_dir, "pregame_training_table.json") if not a.dry_run else table_path
        if a.dry_run:
            print("[retrain] --dry-run: 테이블 재생성 생략(기존 테이블 사용)")
        else:
            os.makedirs(out_dir, exist_ok=True)
            ett.OUT_PATH = table_path
            ett.main()
    elif os.path.exists(os.path.join(out_dir, "pregame_training_table.json")):
        table_path = os.path.join(out_dir, "pregame_training_table.json")

    cfg_c = CONFIG_V2
    games = wf.load_games()
    rows, cols, meta = wb.load_dataset(table_path, elo_kw=cfg_c["elo"], games=games)
    w, is_open = eligibility(meta, a.include_open_match, a.open_match_weight, a.min_current_games)
    dh = data_hash(meta, w, cfg_c)
    print(f"[retrain] 테이블 {len(rows)}행, 학습 자격 {int((w > 0).sum())}행 (오픈매치 {int(is_open.sum())}행, "
          f"제외/가중 처리), 데이터해시 {dh}")

    inc_bundle = joblib.load(inc_path) if os.path.exists(inc_path) else None
    cfg_i = (inc_bundle or {}).get("config") or CONFIG_LEGACY
    if os.path.exists(state_path) and not a.force:
        last = json.load(open(state_path, encoding="utf-8"))
        if last.get("dataHash") == dh and last.get("incumbentVersion") == (inc_bundle or {}).get("version"):
            print(f"[retrain] 지난 실행({last['ranAt']})과 학습 데이터/설정/현행 동일 - 할 일 없음 ({last['decision']}). --force로 재실행.")
            return

    if inc_bundle is None:
        print("[retrain] 현행 모델 없음 - 도전자를 그대로 승격")
        ho, promote, reason = {}, True, "no incumbent"
    else:
        ho = holdout_eval(cols, meta, w, is_open, cfg_c, cfg_i, inc_bundle, a.newest_n, a.include_open_match)
        if not ho.get("n"):
            promote, reason = False, "no holdout rows"
        else:
            promote, reason = promote_decision(ho["incumbent"]["logloss"], ho["challenger"]["logloss"], ho["n"], a.tol)
        print("[retrain] 홀드아웃: 시즌 %s (A %d경기) + 최근 B %d경기 = %d경기" % (ho["testSeasons"], ho["nA"], ho["nB"], ho["n"]))
        for k in ("incumbent", "challenger"):
            if k in ho:
                m = ho[k]
                print(f"    {k:<11} acc {m['acc']:.3f} logloss {m['logloss']:.4f} brier {m['brier']:.4f} auc {m['auc']:.3f} ece {m['ece']:.3f}")
        if "dLogloss" in ho:
            print(f"    dLogloss(chal-inc) {ho['dLogloss']:+.4f} CI95 [{ho['ci95'][0]:+.4f}, {ho['ci95'][1]:+.4f}]")
    print(f"[retrain] 결정: {'PROMOTE' if promote else 'KEEP INCUMBENT'} - {reason}")

    train_ok = w > 0
    trained_through = max(d for d, t in zip(meta["date"], train_ok) if t)
    version = f"v{datetime.date.today():%Y.%m.%d}-{dh}"
    run = {"ranAt": datetime.datetime.now().isoformat(timespec="seconds"), "dataHash": dh, "decision": "promote" if promote else "keep",
           "reason": reason, "holdout": ho, "candidateVersion": version, "incumbentVersion": (inc_bundle or {}).get("version"),
           "incumbentConfig": cfg_i["name"], "challengerConfig": cfg_c["name"]}
    if a.dry_run:
        print("[retrain] --dry-run: 파일 안 씀.")
        return
    os.makedirs(out_dir, exist_ok=True)
    if promote:
        X = full_matrix(cols, cfg_c)
        model = make_ensemble(cfg_c).fit(X[train_ok], meta["y"][train_ok], sample_weight=w[train_ok])
        ep, eg = extras_of(cfg_c)
        bundle = {"model": model, "featureKeys": wb.BASE_PAIR_KEYS, "gameLevelKeys": wb.BASE_GAME_KEYS,
                  "extraPairKeys": ep, "extraGameKeys": eg, "config": cfg_c, "version": version,
                  "bundleFormat": BUNDLE_FORMAT, "trainedThroughDate": trained_through}
        if os.path.exists(model_path):
            shutil.copy2(model_path, os.path.join(out_dir, "pregame_model.prev.joblib"))
        joblib.dump(bundle, model_path)
        # 로드 + 예측 sanity
        chk = joblib.load(model_path)
        p = chk["model"].predict_proba(X[train_ok][:5])[:, 1]
        assert np.all((p > 0) & (p < 1))
        meta_out = {"version": version, "trainedAt": run["ranAt"], "trainedThroughDate": trained_through,
                    "trainRows": int(train_ok.sum()), "openMatchIncluded": bool(a.include_open_match),
                    "seasons": sorted(int(s) for s in set(meta["season"][train_ok])), "config": cfg_c,
                    "holdout": ho, "reason": reason, "bundleFormat": BUNDLE_FORMAT}
        json.dump(meta_out, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"[retrain] 저장: {model_path} ({version}, {int(train_ok.sum())}행), {meta_path}")
    json.dump(run, open(state_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
