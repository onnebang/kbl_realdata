# -*- coding: utf-8 -*-
"""12인 엔트리 발표 후 경기 전 승률을 한 번 더 계산해 pregame_features에 반영한다.

**흐름**
KBL 규정상 12인(선발 5 + 벤치 7)을 경기 30분 전까지 제출한다. 그 명단은 player-stat의
startFlag로 드러난다(fetch_starting_lineups.py 참고). 명단이 나오면 그 경기의 로스터
가중치에서 결장자를 빼고 선발을 소폭 가산해(export_training_table.apply_lineup_to_roster)
같은 모델로 다시 예측하고, pregame_features.home_win_prob을 갱신한다.

**왜 결장자 중심인가**
이 모델(pregame_model.joblib)은 라인업으로 학습된 적이 없다. 팀 단위 롤링 스탯과 로스터
가중평균으로만 배웠기 때문에, "선발이 누구냐"로 승률을 크게 흔들 근거가 없다. 반면 "누가
오늘 아예 안 뛴다"는 로스터 가중평균에 직접 반영되는, 근거가 확실한 정보다. 그래서 선발
가산(LINEUP_STARTER_BOOST)은 일부러 약하게 두고 결장 반영을 주 효과로 삼는다.

**멱등성**
같은 경기를 여러 번 돌려도 결과는 같다(같은 엔트리 -> 같은 승률). live_collector가
10분마다 부르는 것을 전제로 한 설계다. 값이 안 바뀌면 UPDATE도 건너뛴다.

사용법:
  python recalc_lineup_winprob.py --today              # 오늘 경기 중 엔트리 나온 것만 갱신
  python recalc_lineup_winprob.py --gmkey S49G14N1
  python recalc_lineup_winprob.py --today --dry-run    # 계산만 하고 DB 안 씀
"""
import argparse
import datetime
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

import fetch_kbl_data as fkd            # noqa: E402
import fetch_starting_lineups as fsl    # noqa: E402
import sync_upcoming_games as sug       # noqa: E402

KST = datetime.timezone(datetime.timedelta(hours=9))


def collect_lineups(games):
    """{gmkey: {tcode: {"dressed":[...], "starters":[...]}}} - 엔트리 나온 경기만."""
    lineups, pending = {}, []
    for g in games:
        res = fsl.fetch_lineup(g["gmkey"])
        if not res["available"]:
            pending.append((g, res))
            continue
        lineups[g["gmkey"]] = {
            tcode: {"dressed": res["dressed"].get(tcode, []),
                    "starters": res["starters"].get(tcode, [])}
            for tcode in res["dressed"]
        }
    return lineups, pending


def stored_probs(cur, gmkeys):
    cur.execute("select gmkey, home_win_prob from pregame_features where gmkey = any(%s)",
                (list(gmkeys),))
    return {k: (float(v) if v is not None else None) for k, v in cur.fetchall()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gmkey", help="이 경기만")
    ap.add_argument("--today", action="store_true", help="오늘 예정 경기 전부")
    ap.add_argument("--dry-run", action="store_true", help="계산만 하고 DB에 안 씀")
    args = ap.parse_args()

    if args.gmkey:
        d = datetime.datetime.now(KST).strftime("%Y%m%d")
        games = [g for g in fkd.fetch_game_list(d, d) if g["gmkey"] == args.gmkey]
    elif args.today:
        games = fsl.today_games()
    else:
        ap.error("--gmkey 또는 --today 필요")

    if not games:
        print("[recalc] 대상 경기 없음.", flush=True)
        return

    lineups, pending = collect_lineups(games)
    for g, res in pending:
        tip = fsl.tipoff_dt(g)
        print("[recalc] %s %s vs %s: 엔트리 아직 없음(player-stat %d행)%s"
              % (g["gmkey"], g.get("tnameH"), g.get("tnameA"), res["n_rows"],
                 " tip=%s" % tip.strftime("%H:%M") if tip else ""), flush=True)
    if not lineups:
        print("[recalc] 갱신할 경기 없음 - 종료.", flush=True)
        return

    target = [g for g in games if g["gmkey"] in lineups]
    print("[recalc] 엔트리 확정 %d경기 - 피처 컨텍스트 구성 중..." % len(target), flush=True)

    import joblib
    import predict_upcoming_games as pug
    model_bundle = joblib.load(pug.MODEL_PATH)
    ctx = pug.build_context()

    # 같은 컨텍스트로 라인업 반영 전/후를 둘 다 계산해 변동폭을 보여준다.
    before_rows, _ = sug.compute_prediction_rows(ctx, model_bundle, target)
    after_rows, skipped = sug.compute_prediction_rows(ctx, model_bundle, target, lineups=lineups)
    before_by_gm = {r[0]: r[-1] for r in before_rows}
    if skipped:
        print("[recalc] 표본 부족으로 예측 보류 %d경기" % skipped, flush=True)
    if not after_rows:
        print("[recalc] 계산된 행 없음 - 종료.", flush=True)
        return

    name_by_gm = {g["gmkey"]: (g.get("tnameH"), g.get("tnameA")) for g in target}
    for r in after_rows:
        gm, new = r[0], r[-1]
        old_model = before_by_gm.get(gm)
        h, a = name_by_gm.get(gm, ("?", "?"))
        delta = ("%+.1f%%p" % ((new - old_model) * 100)) if old_model is not None else "?"
        print("  %s %s vs %s: %.1f%% -> %.1f%%  (%s)"
              % (gm, h, a, (old_model or 0) * 100, new * 100, delta), flush=True)

    if args.dry_run:
        print("[recalc] --dry-run - DB 안 씀.", flush=True)
        return

    sug.load_env_supabase()
    conn = sug.get_conn()
    try:
        cur = conn.cursor()
        old_stored = stored_probs(cur, [r[0] for r in after_rows])
        changed = [r for r in after_rows if old_stored.get(r[0]) != r[-1]]
        if not changed:
            print("[recalc] 저장값과 동일 - UPDATE 생략(멱등).", flush=True)
            return
        sug.upsert_predictions(cur, changed)
        conn.commit()
        for r in changed:
            print("  [DB] %s %s -> %s" % (r[0], old_stored.get(r[0]), r[-1]), flush=True)
        print("[recalc] %d경기 갱신 완료." % len(changed), flush=True)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
