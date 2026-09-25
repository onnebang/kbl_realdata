"""build_ovr_rounds.py 순수 로직 자체 점검(DB/엔진 없이). python test_build_ovr_rounds.py

증명하는 것: 단계 이동폭(0.2~1.0), 데드존, 시즌 누적 캡, 멱등, 무데이터 1회 재보정, 미출전 단계 값 유지, 단계 마감 판정.
"""
import pandas as pd

import build_ovr_rounds as o

EPS = 1e-9


def steps(minutes, e, played=None):
    st = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'PO', 'F'][:len(minutes)]
    return [{'stage': s, 'minutes': m, 'played': True if played is None else played[i], 'e': e[i] if isinstance(e, list) else e}
            for i, (s, m) in enumerate(zip(st, minutes))]


def moves(traj):
    return [r['delta'] for r in traj[1:] if r['delta'] != 0]


def test_step_magnitude_and_cap():
    m = [300, 600, 900, 1200, 1500, 1800, 2000, 2100]
    up = o.trajectory(75, steps(m, 99.0))                      # 계속 크게 위로
    assert all(o.STEP_MIN - EPS <= abs(d) <= o.STEP_MAX + EPS for d in moves(up)), moves(up)
    assert max(r['ovr'] for r in up) <= 75 + o.SEASON_CAP + EPS, up          # 시즌 누적 캡
    assert abs(up[-1]['ovr'] - (75 + o.SEASON_CAP)) < EPS                    # 캡에 도달해서 멈춤
    down = o.trajectory(75, steps(m, 40.0))
    assert min(r['ovr'] for r in down) >= 75 - o.SEASON_CAP - EPS, down
    assert all(o.STEP_MIN - EPS <= abs(d) <= o.STEP_MAX + EPS for d in moves(down))
    # 첫 단계는 크게 벌어져도 STEP_MAX로만 움직인다
    assert abs(up[1]['ovr'] - 76.0) < EPS and up[1]['delta'] == 1.0


def test_dead_zone():
    # w = 300/900 = 1/3, A = 75 + 0.5/3 = 75.17 -> |d| < 0.2 -> 제자리
    t = o.trajectory(75, steps([300], [75.5]))
    assert t[1]['ovr'] == 75.0 and t[1]['delta'] == 0.0
    # w = 1200/1800 = 2/3, A = 75 + 0.6 = 75.6 -> 이동(0.6)
    t = o.trajectory(75, steps([1200], [75.9]))
    assert abs(t[1]['delta'] - 0.6) < EPS


def test_idempotent_and_stateless():
    s = steps([300, 700, 1100, 1500, 1900, 2300], [80, 78, 82, 70, 75, 90])
    assert o.trajectory(76, s) == o.trajectory(76, s)
    assert o.trajectory(76, s, nodata=True) == o.trajectory(76, s, nodata=True)


def test_no_games_stage_holds_value():
    e = [80, None, 80]
    played = [True, False, False]
    t = o.trajectory(70, steps([900, 900, 900], e, played))
    assert t[2]['ovr'] == t[1]['ovr'] and t[2]['delta'] == 0.0 and t[3]['delta'] == 0.0
    assert t[2]['minutes'] == 900.0        # 누적 출전분은 그대로 보고한다


def test_nodata_recalibration_once():
    # R1 100분(<240) -> 재보정 안 함, 일반 규칙. R2 300분 -> 재보정(큰 점프 허용, launch+-6 이내)
    t = o.trajectory(56, steps([100, 300, 600, 900], [75, 75, 75, 75]), nodata=True)
    assert not t[1]['recalibrated'] and abs(t[1]['delta']) <= o.STEP_MAX + EPS
    assert t[2]['recalibrated']
    assert abs(t[2]['ovr'] - 56) <= o.RECAL_CAP + EPS
    assert sum(r['recalibrated'] for r in t) == 1                      # 딱 한 번
    base = t[2]['ovr']
    for r in t[3:]:
        assert abs(r['delta']) <= o.STEP_MAX + EPS and abs(r['ovr'] - base) <= o.SEASON_CAP + EPS
    # 극단: 재보정 점프는 RECAL_CAP에서 잘리고, 40..99를 벗어나지 않는다
    t = o.trajectory(56, steps([2000], [99.0]), nodata=True)
    assert t[1]['recalibrated'] and abs(t[1]['ovr'] - (56 + o.RECAL_CAP)) < EPS
    t = o.trajectory(41, steps([2000], [40.0]), nodata=True)
    assert t[1]['ovr'] >= o.OVR_MIN
    # 유데이터 선수는 재보정 없음(같은 입력에서 점프 대신 STEP_MAX로만)
    t = o.trajectory(56, steps([2000], [99.0]), nodata=False)
    assert not t[1]['recalibrated'] and abs(t[1]['delta']) <= o.STEP_MAX + EPS


def _games(**counts):
    rows = []
    for st, n in counts.items():
        for i in range(n):
            rows.append({'gmkey': f'{st}_{i}', 'stage': st, 'finished': True, 'home_tcode': 'A', 'away_tcode': 'B',
                         'home_score': 80, 'away_score': 70})
    return pd.DataFrame(rows)


def test_closed_stages():
    g = _games(R1=45, R2=44)
    assert o.closed_stages(g, complete=False) == ['R1']                # 진행 중 라운드는 발행 안 함
    g = _games(R1=45, R2=45, R3=45, R4=45, R5=45, R6=45)
    assert o.closed_stages(g, complete=False) == ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']
    g = _games(R1=45, R2=45, R3=45, R4=45, R5=45, R6=45, PO=10)
    assert 'PO' not in o.closed_stages(g, complete=False)              # F 시작 전 PO는 진행 중
    assert 'PO' in o.closed_stages(g, complete=True)                   # 끝난 시즌에 F 데이터가 없으면 PO가 마지막 단계
    g = _games(R1=45, PO=10, F=3)
    c = o.closed_stages(g, complete=False)
    assert 'PO' in c and 'F' not in c                                  # F 3경기(홈팀 3승) - 4승 전
    g = _games(R1=45, PO=10, F=4)                                      # 홈팀 A가 4연승
    assert o.closed_stages(g, complete=False)[-1] == 'F'


def test_stage_gmkeys_and_scale():
    g = _games(R1=45, R2=45, R3=45, PO=5, F=2)
    assert len(o.stage_gmkeys(g, 'R2')) == 90 and len(o.stage_gmkeys(g, 'PO')) == 140 and len(o.stage_gmkeys(g, 'F')) == 142
    assert o.stage_volume_scale('R1') == 6.0 and o.stage_volume_scale('R6') == 1.0 and o.stage_volume_scale('PO') == 1.0


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('ok', name)
    print('all passed')
