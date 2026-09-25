# -*- coding: utf-8 -*-
"""12인 엔트리 발표 후 경기 전 승률을 한 번 더 계산해 pregame_features에 반영한다.

**흐름**
KBL 규정상 12인(선발 5 + 벤치 7)을 경기 30분 전까지 제출한다. 그 명단은 player-stat의
startFlag로 드러난다(fetch_starting_lineups.py 참고). 명단이 나오면 그 경기의 로스터
가중치에서 결장자를 빼고 선발을 소폭 가산해(export_training_table.apply_lineup_to_roster)
같은 모델로 다시 예측한다.

**왜 결장자 중심인가**
이 모델(pregame_model.joblib)은 라인업으로 학습된 적이 없다. 팀 단위 롤링 스탯과 로스터
가중평균으로만 배웠기 때문에, "선발이 누구냐"로 승률을 크게 흔들 근거가 없다. 반면 "누가
오늘 아예 안 뛴다"는 로스터 가중평균에 직접 반영되는, 근거가 확실한 정보다. 그래서 선발
가산(LINEUP_STARTER_BOOST)은 일부러 약하게 두고 결장 반영을 주 효과로 삼는다.

**두 값을 같이 남긴다(2026-09-25, 사용자 요청)**
예전엔 이 스크립트가 pregame_features.home_win_prob을 라인업 반영값으로 덮어써서, "시즌
전체 기준 AI 예상 승률"이 12인 엔트리가 나오는 순간 영영 사라졌다(제보: "이정현이 빠지니까
소노 패배가 예상될 정도로 승률이 내려왔었는데, 그 변동을 보여줘야 할 것 같다" - 그런데
변동폭을 보여줄 "이전" 값 자체가 이미 지워진 상태였음). 이제 home_win_prob은
sync_upcoming_games.py(엔트리 없이 계산하는 일반 경로)만 건드리고, 이 스크립트는 별도
컬럼(home_win_prob_lineup, lineup_absences)에만 쓴다 - 두 값이 항상 공존.

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
import json
import os
import sys

from cache_invalidate import revalidate

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

import export_training_table as ett     # noqa: E402
import fetch_kbl_data as fkd            # noqa: E402
import fetch_starting_lineups as fsl    # noqa: E402
import sync_upcoming_games as sug       # noqa: E402

KST = datetime.timezone(datetime.timedelta(hours=9))
# 결장 표기 기준 - 최근 ROLL_WINDOW경기 평균 출전시간 상위 몇 명을 "핵심 로테이션"으로 볼지.
# roster_continuity()가 이미 같은 목적(top_n=8)으로 쓰는 값과 맞춤 - 벤치 끝자리 결장까지
# 전부 나열하면 신호보다 잡음이 커진다.
CORE_ROTATION_SIZE = 8


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


def stored_lineup_probs(cur, gmkeys):
    cur.execute("select gmkey, home_win_prob_lineup from pregame_features where gmkey = any(%s)",
                (list(gmkeys),))
    return {k: (float(v) if v is not None else None) for k, v in cur.fetchall()}


def core_rotation_pcodes(tcode, ctx, active_roster=None):
    """최근 ROLL_WINDOW경기 평균 출전시간 상위 CORE_ROTATION_SIZE명 - "빠지면 눈에 띄는" 선수."""
    hist = ctx["timelines"].get(tcode, [])
    window = hist[-ett.ROLL_WINDOW:]
    roster = ett.roster_window_minutes(window, ctx["player_stats_by_game"], tcode)
    top = sorted(roster.items(), key=lambda x: -x[1])
    
    pcodes = []
    for pcode, _ in top:
        if active_roster is not None and pcode not in active_roster.get(tcode, set()):
            continue  # 현재 팀 로스터에 없는 선수(이적/은퇴 등)는 핵심 로테이션에서 제외
        pcodes.append(pcode)
        if len(pcodes) >= CORE_ROTATION_SIZE:
            break
            
    return pcodes


def compute_absences(g, lineup, ctx, active_roster=None):
    """{"home": [pcode, ...], "away": [pcode, ...]} - 핵심 로테이션인데 이번 엔트리(dressed)에
    없는 선수만. 이름은 여기서 안 붙인다 - 프론트가 어차피 players 테이블을 조인해서 표시하니
    pcode만 남겨 중복 소스를 안 만든다."""
    out = {}
    for side, tcode in (("home", g["tcodeH"]), ("away", g["tcodeA"])):
        dressed = set((lineup.get(tcode) or {}).get("dressed") or [])
        if not dressed:
            continue
        out[side] = [p for p in core_rotation_pcodes(tcode, ctx, active_roster) if p not in dressed]
    return out


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
    # 스케줄 API의 실제 seasonCode를 넘긴다(2026-09-25) - 안 넘기면 build_context가 games[-1]+2로
    # 추정하는데, 2026-27 경기가 raw/games에 쌓이기 시작한 뒤론 그게 존재하지 않는 시즌(51)이 돼서
    # teamPWR(직전 시즌 OVR)/rosterContinuity가 sync_upcoming_games(정상 코드 사용)와 다른 정의로
    # 계산된다 -> "시즌 기준 vs 엔트리 반영" 승률 차이에 결장 효과 말고 피처 정의 차이가 섞임.
    ctx = pug.build_context(current_season_code=target[0].get("seasonCode"))

    # 같은 컨텍스트로 라인업 반영 전/후를 둘 다 계산해 변동폭을 보여준다.
    before_rows, _ = sug.compute_prediction_rows(ctx, model_bundle, target)
    after_rows, skipped = sug.compute_prediction_rows(ctx, model_bundle, target, lineups=lineups)
    before_by_gm = {r[0]: r[-1] for r in before_rows}
    if skipped:
        print("[recalc] 표본 부족으로 예측 보류 %d경기" % skipped, flush=True)
    if not after_rows:
        print("[recalc] 계산된 행 없음 - 종료.", flush=True)
        return

    # 현재 시즌 로스터 조회를 위해 미리 DB 연결
    sug.load_env_supabase()
    conn = sug.get_conn()
    active_roster = {}
    try:
        cur = conn.cursor()
        cur.execute("SELECT team_code, pcode FROM players WHERE season_code = %s", (ctx["current_season_code"],))
        for t, p in cur.fetchall():
            active_roster.setdefault(t, set()).add(p)
    except Exception as e:
        print("[recalc] active_roster 조회 실패 (진행은 계속함):", e, flush=True)
    finally:
        conn.close()

    target_by_gm = {g["gmkey"]: g for g in target}
    absences_by_gm = {gm: compute_absences(g, lineups[gm], ctx, active_roster) for gm, g in target_by_gm.items()}

    name_by_gm = {g["gmkey"]: (g.get("tnameH"), g.get("tnameA")) for g in target}
    lineup_rows = []
    for r in after_rows:
        gm, new = r[0], r[-1]
        old_model = before_by_gm.get(gm)
        h, a = name_by_gm.get(gm, ("?", "?"))
        delta = ("%+.1f%%p" % ((new - old_model) * 100)) if old_model is not None else "?"
        abs_gm = absences_by_gm.get(gm) or {}
        abs_note = ", ".join(f"{side}:{len(v)}명" for side, v in abs_gm.items() if v) or "없음"
        print("  %s %s vs %s: %.1f%% -> %.1f%%  (%s)  핵심로테 결장(%s)"
              % (gm, h, a, (old_model or 0) * 100, new * 100, delta, abs_note), flush=True)
        lineup_rows.append((gm, new, json.dumps(abs_gm, ensure_ascii=False)))

    if args.dry_run:
        print("[recalc] --dry-run - DB 안 씀.", flush=True)
        return

    sug.load_env_supabase()
    conn = sug.get_conn()
    try:
        cur = conn.cursor()
        old_stored = stored_lineup_probs(cur, [r[0] for r in lineup_rows])
        changed = [r for r in lineup_rows if old_stored.get(r[0]) != r[1]]
        if not changed:
            print("[recalc] 저장값과 동일 - UPDATE 생략(멱등).", flush=True)
            return
        sug.upsert_lineup_predictions(cur, changed)
        conn.commit()
        for gm, new, _ in changed:
            print("  [DB] %s %s -> %s" % (gm, old_stored.get(gm), new), flush=True)
        print("[recalc] %d경기 갱신 완료." % len(changed), flush=True)
        # 2026-09-25(revalidateTag 연동) - 보통 소수 경기(오늘 엔트리 나온 것만)라 개별 gmkey로.
        revalidate(["batch:daily"] + [f"game:{gm}" for gm, _, _ in changed])
    finally:
        conn.close()


if __name__ == "__main__":
    main()
