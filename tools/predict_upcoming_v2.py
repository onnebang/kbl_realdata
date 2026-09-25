"""
새 경기 전 모델(bundleFormat 2: RF+LR 앙상블 + Elo/결장 피처)용 추론 헬퍼. 기존 predict_upcoming_games.py /
sync_upcoming_games.py / recalc_lineup_winprob.py는 수정하지 않는다 - 그쪽에 붙일 때 필요한 것만 여기 있다:

  state = build_extra_state(bundle)                       # 프로세스당 1번 (raw/games 캐시 -> Elo/일정 상태)
  X = build_X(bundle, state, g, home_feats, away_feats, lineup)   # 기존 X 조립 블록(feats 리스트 만드는 곳) 대체

기존 코드는 `home_feats`/`away_feats`(team_features_now 결과)로 X 한 행을 조립한다. v2는 같은 dict에 없는
extra 키(elo/missTop8Share/...)를 ExtraState.features_for()로 채워 넣어 확장 레이아웃으로 만든다.
lineup(=recalc_lineup_winprob의 {tcode: {"dressed": [...], "starters": [...]}})을 주면 결장 피처가 채워지고,
None이면 결장 피처는 NaN(모델이 평균으로 대체) - 엔트리 발표 전/후 두 값을 따로 계산하는 기존 흐름과 그대로 맞는다.

CLI (dry-run 전용, DB/파일 쓰기 없음):
  python -X utf8 tools/predict_upcoming_v2.py --model raw/challenger/pregame_model.joblib [--lookahead 3]
"""
import argparse
import os
import sys

import joblib
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

import winprob_features as wf  # noqa: E402


def build_extra_state(bundle):
    """끝난 경기 전부를 시간순으로 소비한 ExtraState (추론용). bundle의 Elo 설정과 학습 때 설정이 같아야 한다."""
    games = wf.load_games()
    _, state = wf.build_extras(games, **bundle["config"]["elo"])
    return state


def build_X(bundle, state, g, home_feats, away_feats, lineup=None, ref_home_win_rate=None):
    """확장 레이아웃 한 행 (1, n_full). g는 스케줄 API 경기 dict(tcodeH/tcodeA/gameDate/seasonCode)."""
    import export_training_table as ett
    lineup = lineup or {}
    hf, af, gf = state.features_for(
        g["tcodeH"], g["tcodeA"], g["gameDate"], g.get("seasonCode"),
        (lineup.get(g["tcodeH"]) or {}).get("dressed") or None,
        (lineup.get(g["tcodeA"]) or {}).get("dressed") or None)
    keys, gkeys = bundle["featureKeys"], bundle["gameLevelKeys"]
    dctx = ett.date_context_features(g["gameDate"])
    gctx = {"dayOfWeek": dctx["dayOfWeek"], "month": dctx["month"], "refHomeWinRate": ref_home_win_rate}
    ep, eg = bundle["extraPairKeys"], bundle["extraGameKeys"]
    vals = [home_feats.get(f"home_{k}") for k in keys] + [away_feats.get(f"away_{k}") for k in keys] \
        + [gctx.get(k) for k in gkeys] + [hf.get(k) for k in ep] + [af.get(k) for k in ep] + [gf.get(k) for k in eg]
    return np.array([[np.nan if v is None else v for v in vals]], dtype=float)


def predict_v2(ctx, bundle, state, schedule_games, lineups=None):
    """predict_upcoming_games.predict()의 v2 버전 (순수 계산, 쓰기 없음)."""
    import export_training_table as ett
    import predict_upcoming_games as pug
    out = []
    for g in schedule_games:
        lu = (lineups or {}).get(g["gmkey"]) or {}
        hf = pug.team_features_now(g["tcodeH"], "home", ctx, g["gameDate"], lineup=lu.get(g["tcodeH"]))
        af = pug.team_features_now(g["tcodeA"], "away", ctx, g["gameDate"], lineup=lu.get(g["tcodeA"]))
        if hf is None or af is None:
            out.append((g, None))
            continue
        hf["home_venueNetRtg"] = ett.venue_rating_before(ctx["venue_timelines"].get((g["tcodeH"], g.get("stadiumname")), []))
        af["away_venueNetRtg"] = ett.venue_rating_before(ctx["venue_timelines"].get((g["tcodeA"], g.get("stadiumname")), []))
        X = build_X(bundle, state, g, hf, af, lu)
        out.append((g, float(bundle["model"].predict_proba(X)[0, 1])))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--lookahead", type=int, default=3)
    ap.add_argument("--compare-incumbent", default=None, help="현행 joblib - 같은 경기 예측을 옆에 출력")
    a = ap.parse_args()
    import predict_upcoming_games as pug
    bundle = joblib.load(a.model)
    assert bundle.get("bundleFormat") == 2, "bundleFormat 2 모델이 아님"
    sched = pug.fetch_upcoming_schedule(a.lookahead)
    print(f"예정 경기 {len(sched)}건 (dry-run: DB/파일 쓰기 없음)")
    if not sched:
        return
    ctx = pug.build_context(current_season_code=sched[0].get("seasonCode"))
    state = build_extra_state(bundle)
    res = predict_v2(ctx, bundle, state, sched)
    inc = None
    if a.compare_incumbent:
        inc_bundle = joblib.load(a.compare_incumbent)
        inc = {p["gmkey"]: p["homeWinProb"] for p in pug.predict(ctx, inc_bundle, sched)}
    for g, p in res:
        base = f"  {g['gameDate']} {g['gmkey']} {g['tnameH']} vs {g['tnameA']}: "
        if p is None:
            print(base + "표본 부족 - 보류")
        else:
            extra = f"  (현행 {inc[g['gmkey']]*100:.1f}%)" if inc and inc.get(g["gmkey"]) is not None else ""
            print(base + f"홈 승률 {p*100:.1f}%{extra}")


if __name__ == "__main__":
    main()
