# -*- coding: utf-8 -*-
"""라인업 반영 승률 재계산의 회귀 검증.

두 가지를 고정한다:
  1. lineup을 안 주면 기존 동작과 **완전히 동일**해야 한다. 이 주입은 기존 예측 경로
     (predict_upcoming_games / sync_upcoming_games)를 그대로 쓰므로, 여기서 값이
     한 톨이라도 달라지면 이미 사이트에 나간 승률이 조용히 바뀐다.
  2. 결장자를 반영하면 실제로 값이 움직여야 한다 - 안 움직이면 기능이 죽은 것이다.

실행: python tools/check_lineup_recalc.py   (모델/DB 로드는 하지만 쓰기는 안 함)
"""
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

import export_training_table as ett  # noqa: E402


def check_helper():
    roster = {"A": 30.0, "B": 20.0, "C": 10.0, "D": 5.0}

    # 라인업이 없으면 그대로 - 객체까지 동일해야 기존 경로에 영향이 없다.
    assert ett.apply_lineup_to_roster(roster, None, None) is roster
    assert ett.apply_lineup_to_roster(roster, [], []) is roster

    # 결장자(C, D)는 빠진다.
    out = ett.apply_lineup_to_roster(roster, ["A", "B"], [])
    assert set(out) == {"A", "B"}, out
    assert out["A"] == 30.0 and out["B"] == 20.0, out

    # 엔트리에 있는데 출전 기록이 없는 선수는 최소 가중치를 받는다(0이 아니다).
    out = ett.apply_lineup_to_roster(roster, ["A", "NEW"], [])
    assert out["NEW"] == ett.LINEUP_MIN_WEIGHT, out

    # 선발은 가산된다.
    out = ett.apply_lineup_to_roster(roster, ["A", "B"], ["A"])
    assert out["A"] == 30.0 * ett.LINEUP_STARTER_BOOST, out
    assert out["B"] == 20.0, out

    # 원본은 변형되지 않는다(호출부가 같은 dict를 재사용해도 안전).
    assert roster == {"A": 30.0, "B": 20.0, "C": 10.0, "D": 5.0}
    print("  [ok] apply_lineup_to_roster: 결장자 제외 / 신규 최소가중치 / 선발 가산 / 원본 불변")


def check_no_op_identity():
    """lineup 인자를 안 주면 team_features_now 결과가 완전히 같아야 한다."""
    import predict_upcoming_games as pug

    ctx = pug.build_context()
    # 표본이 있는 팀 하나를 고른다.
    tcode = None
    for t, hist in ctx["timelines"].items():
        if len(hist) >= ett.ROLL_WINDOW:
            tcode = t
            break
    assert tcode, "표본 있는 팀을 못 찾음"
    today = "20260924"

    base = pug.team_features_now(tcode, "home", ctx, today)
    same = pug.team_features_now(tcode, "home", ctx, today, lineup=None)
    empty = pug.team_features_now(tcode, "home", ctx, today, lineup={})
    assert base == same, "lineup=None이 기존과 다름"
    assert base == empty, "lineup={}가 기존과 다름"
    print("  [ok] lineup 미지정 시 피처가 기존과 완전 동일 (팀 %s, %d개 피처)" % (tcode, len(base)))
    return pug, ctx, tcode, today, base


def check_absence_moves_features(pug, ctx, tcode, today, base):
    """결장자를 반영하면 로스터 의존 피처가 실제로 움직여야 한다."""
    window = ctx["timelines"][tcode][-ett.ROLL_WINDOW:]
    roster = ett.roster_window_minutes(window, ctx["player_stats_by_game"], tcode)
    assert roster, "로스터가 비었음"
    ordered = sorted(roster, key=roster.get, reverse=True)
    # 최다 출전 선수를 뺀 12인 엔트리를 만든다(= 주축 결장 시뮬레이션).
    dressed = ordered[1:13]
    starters = dressed[:5]
    out = pug.team_features_now(tcode, "home", ctx, today,
                                lineup={"dressed": dressed, "starters": starters})
    moved = [k for k in base
             if base[k] != out[k] and isinstance(base[k], float) and isinstance(out[k], float)]
    assert moved, "주축을 빼도 움직이는 피처가 없음 - 주입이 실제로 안 먹고 있다"
    print("  [ok] 최다출전 선수 결장 시 %d개 피처가 이동. 예: " % len(moved)
          + ", ".join("%s %.3f->%.3f" % (k.replace("home_", ""), base[k], out[k])
                      for k in moved[:4]))


if __name__ == "__main__":
    check_helper()
    pug, ctx, tcode, today, base = check_no_op_identity()
    check_absence_moves_features(pug, ctx, tcode, today, base)
    print("전부 통과.")
