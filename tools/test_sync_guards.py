# -*- coding: utf-8 -*-
"""sync_upcoming_games.py의 "끝난 경기는 다시 쓰지 않는다" 가드 회귀 테스트.

왜 이 테스트가 있나 (2026-09-30): 이 가드는 원래 games UPSERT에만 있었고
pregame_features UPSERT에는 빠져 있었다. 그래서 종료된 경기의 **경기 전 예측**이 나중에
스케줄 시점 값으로 덮여 쓰일 수 있었고, 이 컬럼이 종료 경기에서 null일 거라고 가정한 웹 폴백
때문에 같은 경기 페이지가 "예측 적중"과 "예측 빗나감"을 동시에 표시했다.

가드를 UPSERT마다 손으로 적으면 새 UPSERT를 추가할 때 또 빠지므로, 세 문장 전부에 들어 있는지
여기서 고정한다. DB 연결이 필요 없다 - SQL 문자열만 본다.

실행:  python test_sync_guards.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sync_upcoming_games as sug  # noqa: E402


def test_pregame_upsert_has_guard():
    sql = sug.predictions_upsert_sql(["gmkey", "home_netrtg", "home_win_prob"])
    assert "on conflict (gmkey) do update set" in sql, sql
    # 가드 없이 통과하면 종료 경기의 경기 전 기록이 덮인다.
    assert "not exists" in sql and "g.is_ended" in sql, sql
    assert "g.home_score is not null" in sql, sql
    # 대상 테이블을 제대로 참조하는지(엉뚱한 테이블을 보면 가드가 항상 참이 된다).
    assert "g.gmkey = pregame_features.gmkey" in sql, sql
    # 갱신 대상 컬럼이 실제로 들어가는지 - 가드만 있고 SET이 비면 아무것도 안 써진다.
    assert "home_netrtg=excluded.home_netrtg" in sql, sql
    assert "home_win_prob=excluded.home_win_prob" in sql, sql
    # gmkey는 갱신 대상이 아니다(충돌 키).
    assert "gmkey=excluded.gmkey" not in sql, sql


def test_lineup_upsert_has_guard():
    sql = sug.lineup_upsert_sql()
    assert "not exists" in sql and "g.is_ended" in sql, sql
    # 이 경로는 home_win_prob을 절대 건드리면 안 된다(recalc_lineup_winprob.py 머리주석 -
    # 예전에 덮어써서 "이전 값"이 영구히 사라진 사고가 있었다).
    assert "home_win_prob =" not in sql and "home_win_prob=" not in sql, sql
    assert "home_win_prob_lineup = excluded.home_win_prob_lineup" in sql, sql


def test_games_guard_constant_used():
    # games 쪽 가드는 자기 컬럼을 본다(pregame_features와 표현이 다르다).
    assert "games.is_ended = false" in sug.GAMES_NOT_ENDED
    assert "games.home_score is null" in sug.GAMES_NOT_ENDED


def test_prediction_columns_match_row_width():
    """컬럼 목록과 compute_prediction_rows()가 만드는 튜플 폭이 어긋나면 execute_values가
    런타임에야 터진다. FIELDS 한 줄 추가로 양쪽이 같이 늘어나는지 여기서 본다."""
    from migrate_pregame_features_to_supabase import FIELDS
    cols = sug.prediction_columns()
    assert cols[0] == "gmkey"
    assert cols[-1] == "home_win_prob"
    assert len(cols) == 1 + 2 * len(FIELDS) + 1, (len(cols), len(FIELDS))


def test_not_ended_guard_is_table_scoped():
    assert "g.gmkey = foo.gmkey" in sug.not_ended_guard("foo")


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  ok   {name}")
            except AssertionError as exc:
                failed += 1
                print(f"  FAIL {name}: {exc}")
    print("실패 없음." if not failed else f"{failed}건 실패.")
    sys.exit(1 if failed else 0)
