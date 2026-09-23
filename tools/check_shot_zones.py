"""shot_log 기반 미드레인지 구역 보정값 회귀 검사(DB 필요). python check_shot_zones.py

build_courtside_ovr.py의 HOOP_L/HOOP_R/PAINT_RADIUS/THREE_RADIUS가 실측 데이터(pp_a,
threep_a)와 계속 잘 맞는지 확인한다 - DB가 갱신되거나(새 시즌 슛로그 추가) 누가 이 상수를
건드렸을 때 조용히 깨지는 걸 막는 용도. 2026-09-24, 미드레인지 신호 추가 때 했던 그리드서치
검증을 고정한 것.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_courtside_ovr import DB_PATH, HOOP_L, HOOP_R, PAINT_RADIUS, THREE_RADIUS

import sqlite3

conn = sqlite3.connect(DB_PATH)
shots = pd.read_sql_query("SELECT gmkey, pcode, x, y, made FROM shot_log", conn)
truth = pd.read_sql_query(
    "SELECT gmkey, pcode, fg_a, threep_a, pp_a FROM player_game_stats WHERE fg_a > 0", conn)
conn.close()

dist_l = np.hypot(shots['x'] - HOOP_L[0], shots['y'] - HOOP_L[1])
dist_r = np.hypot(shots['x'] - HOOP_R[0], shots['y'] - HOOP_R[1])
shots['dist'] = np.minimum(dist_l, dist_r)

# 1) 3점 반경이 여전히 threep_a를 잘 예측하는지 (선수-경기당 평균 오차)
pred_3pa = shots[shots['dist'] > THREE_RADIUS].groupby(['gmkey', 'pcode']).size().rename('pred_3pa').reset_index()
m3 = truth.merge(pred_3pa, on=['gmkey', 'pcode'], how='left').fillna({'pred_3pa': 0})
err_3pa = (m3['pred_3pa'] - m3['threep_a']).abs().mean()
assert err_3pa < 0.5, f"3점 반경({THREE_RADIUS}) 예측 오차가 커짐: {err_3pa:.3f}개/경기 (기준 <0.5)"

# 2) 페인트 반경이 여전히 pp_a를 잘 예측하는지
truth_p = truth[truth['pp_a'] > 0]
pred_paint = shots[shots['dist'] <= PAINT_RADIUS].groupby(['gmkey', 'pcode']).size().rename('pred_paint').reset_index()
mp = truth_p.merge(pred_paint, on=['gmkey', 'pcode'], how='left').fillna({'pred_paint': 0})
err_paint = (mp['pred_paint'] - mp['pp_a']).abs().mean()
assert err_paint < 0.5, f"페인트 반경({PAINT_RADIUS}) 예측 오차가 커짐: {err_paint:.3f}개/경기 (기준 <0.5)"

# 3) 슛 난이도 순서가 현실과 맞는지 - 골밑 > 미드레인지 > 3점 FG%
zone = np.where(shots['dist'] <= PAINT_RADIUS, 'rim',
                np.where(shots['dist'] <= THREE_RADIUS, 'mid', 'three'))
pct = pd.Series(shots['made'].values, index=zone).groupby(level=0).mean()
assert pct['rim'] > pct['mid'] > pct['three'], (
    f"구역별 FG%가 골밑>미드>3점 순서가 아님(좌표/반경이 깨졌을 가능성): {dict(pct)}"
)

print(
    f"통과: 3점 반경 오차 {err_3pa:.3f}개/경기, 페인트 반경 오차 {err_paint:.3f}개/경기, "
    f"FG% 골밑 {pct['rim']:.1%} > 미드 {pct['mid']:.1%} > 3점 {pct['three']:.1%}"
)
