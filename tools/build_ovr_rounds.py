"""라운드별 OVR 궤적(launch -> R1..R6 -> PO -> F) - 실제 경기 데이터로 시즌 중 OVR을 "게임처럼 완만하게" 움직인다.

제품 요구: 한 단계(라운드)에 OVR이 0.2~1.0 이내로만 움직이고, 시즌 전체 이동폭은 launch 대비 3~4점을 넘지 않는다.
시즌이 바뀌면 launch는 자유롭게 재설정(전 시즌 전체 기록으로 다시 계산 - 기존 build_courtside_ovr.py 그대로).

알고리즘(닫힌 단계 t마다, 선수별, 매번 처음부터 다시 계산 = 숨은 상태 없음/멱등):
  L   = launch OVR(개막 전 예상치. 과거 시즌 백테스트는 그 시즌 이전 기록만으로 프로젝션 블록을 재현)
  E_t = 그 시즌 t단계 종료까지의 경기만으로 엔진(build_courtside_ovr.compute_ovr)을 다시 돌린 OVR(소수 1자리)
  w_t = m_t / (m_t + K_MINUTES)     (m_t = 시즌 누적 출전분, 표본 신뢰도)
  A_t = L + w_t * (E_t - L)
  d = A_t - V_{t-1};  |d| < STEP_MIN 이면 제자리, 아니면 V_t = V_{t-1} + clip(d, +-STEP_MAX)
  이어서 |V_t - base| <= SEASON_CAP 하드 클램프(base = L, 무데이터 선수는 재보정 뒤 재보정값), 소수 1자리 반올림.
  그 단계에 안 뛴 선수는 V_{t-1} 유지. PO/F도 같은 규칙(누적에 포함, 그 단계에 뛴 선수만 갱신).
  무데이터 선수(KBL 이전 시즌 기록 없음 = launch가 스카우팅/바닥치 추정): 시즌 누적 출전이 처음
  RECAL_MIN_MINUTES 이상이 되는 단계에서 한 번만 RECAL_CAP까지 허용하는 재보정(recalibrated=True).

사용:
  python build_ovr_rounds.py --backtest 2025-2026 [--backtest 2024-2025]   # 읽기 전용, tools/backtest_reports/에 리포트
  python build_ovr_rounds.py --season 2026-2027 [--dry-run] [--out rows.json]   # 기본 dry-run
  python build_ovr_rounds.py --season 2026-2027 --write-db                 # public.ovr_round upsert(tools/sql/ovr_round.sql 선행)

파이썬은 반드시 D:\\영상작업\\축구\\개발\\.venv\\Scripts\\python.exe(3.11). git worktree에서 돌릴 땐
KBL540_PLAYERS_PATH(절대경로)와 raw/kbl_realdata.db가 필요하다(build_courtside_ovr.py 참고).
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from statistics import mean, median

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_courtside_ovr as eng  # noqa: E402

# ── 튜닝 상수(전부 여기서만 바꾼다) ─────────────────────────────────────────────
K_MINUTES = 600.0          # 신뢰도 w = m/(m+K). 클수록 launch에 오래 머문다
K_MINUTES_NODATA = 600.0   # 무데이터 선수 전용 K(launch가 추정치라 덜 믿어야 하면 작게)
STEP_MIN = 0.2             # 데드존: |A - V| 가 이보다 작으면 제자리
STEP_MAX = 1.0             # 한 단계 최대 이동
SEASON_CAP = 3.5           # 시즌 누적 이동 한도(|V - base|)
RECAL_MIN_MINUTES = 240.0  # 무데이터 선수 재보정 가능 시즌 누적 출전분
RECAL_CAP = 6.0            # 재보정 1회 한도(|V - L|)
OVR_MIN, OVR_MAX = 40.0, 99.0
ROUND_GAMES = 45           # 정규시즌 1라운드 = 45경기(10팀 라운드로빈), gmkey S{시즌코드}G01N{n} 의 n으로 라운드를 정한다
REG_ROUNDS = 6
FINALS_WINS = 4            # 챔피언결정전 7전 4선승제 - 한 팀이 4승하면 F 마감
PRORATE_VOLUME = True      # 부분 시즌 E_t의 볼륨 항(가비지/신인바닥/캡 보너스/경기수 신뢰도)을 시즌 환산할지(False면 실측 그대로)
EXCLUDE_OWN_SEASON_AWARDS = True  # 마지막(시즌 종료) 단계 전에는 그 시즌 수상을 평판 가산에서 뺀다(사후정보 차단)
REG_CAT, PO_CAT, FINALS_CAT = '정규시즌', '플레이오프', '챔피언결정전'
STAGES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'PO', 'F']
NO_DATA_FLOOR_FALLBACK = 53  # 명단엔 있는데 launch 행이 없는 선수(시즌 중 합류)의 바닥치(드래프트 정보가 없을 때)

REPORT_DIR = os.path.join(HERE, 'backtest_reports')
CACHE_DIR = os.path.join(REPORT_DIR, '_cache')
HISTORY_PATH = os.path.join(HERE, '..', 'courtside-web', 'lib', 'courtside_ovr_history.json')


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


# ── 1. 궤적 알고리즘(순수 함수, DB 없음) ─────────────────────────────────────────
def trajectory(launch, steps, nodata=False, k=None):
    """launch: launch OVR. steps: 단계 순서대로 [{'stage','minutes','played','e'}] (minutes=시즌 누적 출전분,
    played=이 단계에 뛰었는지, e=E_t 또는 None). 반환: launch 행을 포함한 단계별 dict 리스트
    {'stage','ovr','delta','minutes','recalibrated'}."""
    if k is None:
        k = K_MINUTES_NODATA if nodata else K_MINUTES
    launch = float(launch)
    v, base, recal_done = launch, launch, False
    out = [{'stage': 'launch', 'ovr': round(launch, 1), 'delta': 0.0, 'minutes': 0.0, 'recalibrated': False}]
    for s in steps:
        m, new, recal = float(s['minutes']), v, False
        if s['played'] and s['e'] is not None and m > 0:
            w = m / (m + k)
            a = launch + w * (float(s['e']) - launch)
            if nodata and not recal_done and m >= RECAL_MIN_MINUTES:
                new = _clamp(_clamp(a, launch - RECAL_CAP, launch + RECAL_CAP), OVR_MIN, OVR_MAX)
                new = round(new, 1)
                base, recal_done, recal = new, True, True
            else:
                d = a - v
                if abs(d) >= STEP_MIN:
                    cand = v + _clamp(d, -STEP_MAX, STEP_MAX)
                    cand = round(_clamp(_clamp(cand, base - SEASON_CAP, base + SEASON_CAP), OVR_MIN, OVR_MAX), 1)
                    if abs(cand - v) >= STEP_MIN - 1e-9:   # 캡에 깎여 0.2 미만이 되는 잔걸음은 안 한다
                        new = cand
        new = round(new, 1)
        out.append({'stage': s['stage'], 'ovr': new, 'delta': round(new - v, 1), 'minutes': round(m, 1),
                    'recalibrated': recal})
        v = new
    return out


# ── 2. 단계(라운드) 경계 ─────────────────────────────────────────────────────────
def load_season_games(conn, season):
    """시즌의 경기 목록 + 단계(R1..R6/PO/F) + 종료 여부(선수 기록이 있는 경기). 단계 정의는 gmkey의 N 기준."""
    df = pd.read_sql_query(
        "SELECT g.gmkey, g.season_category AS cat, g.home_tcode, g.away_tcode, g.home_score, g.away_score,"
        " EXISTS(SELECT 1 FROM player_game_stats p WHERE p.gmkey = g.gmkey) AS finished"
        " FROM games g WHERE g.season_name = ?", conn, params=[season])
    df['n'] = df['gmkey'].str.extract(r'N(\d+)$')[0].astype(float)

    def stage_of(r):
        if r['cat'] == REG_CAT and 1 <= r['n'] <= ROUND_GAMES * REG_ROUNDS:
            return 'R%d' % (int((r['n'] - 1) // ROUND_GAMES) + 1)
        return {PO_CAT: 'PO', FINALS_CAT: 'F'}.get(r['cat'])   # OPEN MATCH DAY 등은 None(무시)
    df['stage'] = df.apply(stage_of, axis=1)
    df['finished'] = df['finished'].astype(bool)
    return df[df['stage'].notna()].reset_index(drop=True)


def closed_stages(games, complete):
    """마감된 단계 목록(STAGES 순서). R: 그 라운드 45경기 전부 종료. PO: F가 시작됐거나(complete면 PO 경기가 있고
    F가 없을 때 마지막 단계로) 마감. F: 한 팀이 FINALS_WINS승."""
    fin = games[games['finished']]
    cnt = fin['stage'].value_counts().to_dict()
    closed = [f'R{r}' for r in range(1, REG_ROUNDS + 1) if cnt.get(f'R{r}', 0) >= ROUND_GAMES]
    if cnt.get('F', 0) > 0 or (complete and cnt.get('PO', 0) > 0):
        closed.append('PO')
    f = fin[fin['stage'] == 'F']
    if len(f):
        wins = {}
        for r in f.itertuples():
            if pd.isna(r.home_score) or pd.isna(r.away_score):
                continue
            w = r.home_tcode if r.home_score > r.away_score else r.away_tcode
            wins[w] = wins.get(w, 0) + 1
        if wins and max(wins.values()) >= FINALS_WINS:
            closed.append('F')
    return closed


def stage_gmkeys(games, stage):
    """stage 종료 시점까지의 시즌 누적 경기(종료된 경기만). R_r = 정규시즌 N<=45r, PO = 정규시즌 전체 + 플레이오프, F = 전부."""
    fin = games[games['finished']]
    if stage.startswith('R'):
        r = int(stage[1:])
        sel = fin[fin['stage'].isin([f'R{i}' for i in range(1, r + 1)])]
    elif stage == 'PO':
        sel = fin[fin['stage'].str.startswith('R') | (fin['stage'] == 'PO')]
    else:
        sel = fin
    return set(sel['gmkey'])


def stage_volume_scale(stage):
    """부분 시즌 -> 시즌 환산 배율(정규시즌 270경기 기준). PO/F는 정규시즌이 끝난 뒤라 1.0."""
    if not PRORATE_VOLUME or not stage.startswith('R'):
        return 1.0
    return (ROUND_GAMES * REG_ROUNDS) / (ROUND_GAMES * int(stage[1:]))


# ── 3. 엔진 호출(+디스크 캐시: 튜닝 때 엔진을 다시 안 돌리려고) ─────────────────────────
def _engine_fingerprint():
    h = hashlib.sha1()
    for p in (eng.__file__, os.path.join(HERE, 'ovr_curve_model.py'), eng.DB_PATH,
              os.path.join(HERE, '..', 'courtside-web', 'lib', 'courtside_awards.json'),
              os.path.join(HERE, '..', 'raw', 'analysis', 'wpa_season_leaderboard.json')):
        if p.endswith('.db') and os.path.exists(p):
            st = os.stat(p)
            h.update(f'{st.st_size}'.encode())   # 88MB 통째 해시 대신 크기(같은 스냅샷이면 같음)
        elif os.path.exists(p):
            with open(p, 'rb') as f:
                h.update(f.read())
    return h.hexdigest()[:12]


def _cached(name, fn, use_cache=True):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f'{name}.json')
    if use_cache and os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    val = fn()
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(val, f, ensure_ascii=False)
    return val


def engine_stage(season, stage, gmkeys, final, use_cache=True):
    """stage 종료 시점 엔진 결과 {pcode: {'ovr','off','def'}}(소수 1자리). final=True(시즌 종료 후 마지막 단계)면
    사후정보 차단(수상 제외·WPA 대체)을 풀어 전 시즌 엔진 결과와 같은 입력이 된다."""
    fp = _engine_fingerprint()
    key = hashlib.sha1((','.join(sorted(gmkeys)) + f'|{stage_volume_scale(stage)}|{final}|{EXCLUDE_OWN_SEASON_AWARDS}').encode()).hexdigest()[:10]

    def run():
        df = eng.compute_ovr(stage_spec={
            'season': season, 'gmkeys': gmkeys, 'volume_scale': stage_volume_scale(stage),
            'exclude_season_awards': EXCLUDE_OWN_SEASON_AWARDS and not final, 'keep_wpa': final})
        t = df[df['season_name'] == season]
        return {r.pcode: {'ovr': round(float(r.OVR_F), 3), 'off': round(float(r.OFF_F), 3), 'def': round(float(r.DEF_F), 3)}
                for r in t.itertuples()}
    return _cached(f'E_{season}_{stage}_{fp}_{key}', run, use_cache)


def engine_launch(season, roster, use_cache=True):
    """개막 전 예상 launch 행(과거 시즌 백테스트용) {pcode: row} - 그 시즌 이전 기록만으로 프로젝션 블록 재현."""
    fp = _engine_fingerprint()
    key = hashlib.sha1(','.join(sorted(roster)).encode()).hexdigest()[:10]

    def run():
        rows = eng.compute_ovr(launch_spec={'season': season, 'roster': roster})
        return {r['pcode']: {k: r[k] for k in ('OVR', 'OFF', 'DEF', 'name', 'team')} for r in rows if r['season'] == season}
    return _cached(f'L_{season}_{fp}_{key}', run, use_cache)


# ── 4. 선수 데이터 ────────────────────────────────────────────────────────────────
def load_player_game_minutes(conn, season):
    """(pcode, gmkey, minutes, pname) - 이 시즌 정규/플옵/챔프전."""
    return pd.read_sql_query(
        "SELECT p.pcode, p.gmkey, p.pname, p.tcode, p.play_min + p.play_sec / 60.0 AS minutes"
        " FROM player_game_stats p JOIN games g ON g.gmkey = p.gmkey"
        " WHERE g.season_name = ? AND g.season_category IN (?, ?, ?)",
        conn, params=[season, REG_CAT, PO_CAT, FINALS_CAT])


def load_prior_pcodes(conn, season):
    """이 시즌 이전에 KBL 확정 시즌 기록이 있는 pcode(= 무데이터가 아닌 선수). 빌더의 시즌 필터와 같은 기준."""
    df = pd.read_sql_query(
        "SELECT DISTINCT p.pcode FROM player_game_stats p JOIN games g ON g.gmkey = p.gmkey"
        " WHERE g.season_category IN (?, ?, ?) AND g.season_name NOT LIKE '%D리그%' AND g.season_name < ?"
        f" AND {eng.FULL_SEASON_SQL}", conn, params=[REG_CAT, PO_CAT, FINALS_CAT, season])
    return set(df['pcode'])


def load_history():
    with open(HISTORY_PATH, encoding='utf-8') as f:
        return json.load(f)


def player_launch(season, pmin, mode, conn, use_cache):
    """{pcode: {'OVR','OFF','DEF','name'}} launch 값. mode='history'면 JSON의 projected 행(현재 시즌),
    'backtest'면 그 시즌 이전 기록만으로 재현한 개막 전 예상치. auto = JSON에 그 시즌 projected 행이 있으면 history."""
    hist = [r for r in load_history() if r['season'] == season]
    if mode == 'auto':
        mode = 'history' if any(r.get('projected') for r in hist) else 'backtest'
    if mode == 'history':
        return {r['pcode']: {k: r[k] for k in ('OVR', 'OFF', 'DEF', 'name')} for r in hist if r.get('projected')}, mode
    names = pmin.sort_values('gmkey').groupby('pcode')['pname'].last().to_dict()
    teams = pmin.groupby('pcode')['tcode'].agg(lambda s: s.value_counts().index[0]).to_dict()
    roster = {p: {'team': str(teams.get(p, 'Unknown')), 'name': names.get(p, 'Unknown')} for p in names}
    return engine_launch(season, roster, use_cache), mode


# ── 5. 시즌 궤적 조립 ──────────────────────────────────────────────────────────────
def build_season_rows(season, launch_mode='auto', complete=None, use_cache=True, log=print):
    """--dry-run/--write-db/--backtest 공통: 선수별 궤적 행(dict) 리스트 + 진단 정보."""
    conn = sqlite3.connect(eng.DB_PATH)
    try:
        if complete is None:
            complete = season < eng.PROJECTION_SEASON
        games = load_season_games(conn, season)
        pmin = load_player_game_minutes(conn, season)
        prior = load_prior_pcodes(conn, season)
        launch, used_mode = player_launch(season, pmin, launch_mode, conn, use_cache)
    finally:
        conn.close()
    closed = closed_stages(games, complete)
    log(f'[{season}] launch={used_mode} closed={closed} complete={complete} players(launch)={len(launch)}')

    stage_of_game = dict(zip(games['gmkey'], games['stage']))
    pmin = pmin[pmin['minutes'] > 0].copy()
    pmin['stage'] = pmin['gmkey'].map(stage_of_game)
    engine_by_stage = {}
    for i, st in enumerate(closed):
        keys = stage_gmkeys(games, st)
        final = complete and i == len(closed) - 1
        t0 = time.time()
        engine_by_stage[st] = engine_stage(season, st, keys, final, use_cache)
        log(f'  E[{st}] games={len(keys)} players={len(engine_by_stage[st])} final={final} ({time.time() - t0:.1f}s)')

    # 시즌 누적 출전분(단계 종료 시점) / 그 단계에 뛰었는지
    stage_minutes = {st: pmin[pmin['gmkey'].isin(stage_gmkeys(games, st))].groupby('pcode')['minutes'].sum().to_dict() for st in closed}
    played_in = {st: set(pmin.loc[pmin['stage'] == st, 'pcode']) for st in closed}
    names = pmin.sort_values('gmkey').groupby('pcode')['pname'].last().to_dict()

    rows, meta = [], {}
    for pcode in sorted(set(launch) | set(pmin['pcode'])):
        lr = launch.get(pcode)
        nodata = pcode not in prior
        if lr is None:   # 명단에 없다가 시즌 중 합류 - 바닥치 launch
            fl = float(NO_DATA_FLOOR_FALLBACK)
            lr = {'OVR': fl, 'OFF': fl, 'DEF': fl, 'name': names.get(pcode, 'Unknown')}
            meta_late = True
        else:
            meta_late = False
        steps = [{'stage': st, 'minutes': stage_minutes[st].get(pcode, 0.0), 'played': pcode in played_in[st],
                  'e': (engine_by_stage[st].get(pcode) or {}).get('ovr')} for st in closed]
        traj = trajectory(lr['OVR'], steps, nodata)
        for r in traj:
            shift = r['ovr'] - float(lr['OVR'])
            rows.append({'pcode': pcode, 'season': season, 'stage': r['stage'], 'ovr': r['ovr'],
                         'off': round(_clamp(float(lr['OFF']) + shift, OVR_MIN, OVR_MAX), 1),
                         'def': round(_clamp(float(lr['DEF']) + shift, OVR_MIN, OVR_MAX), 1),
                         'delta': r['delta'], 'minutes': r['minutes'], 'recalibrated': r['recalibrated']})
        meta[pcode] = {'name': lr.get('name') or names.get(pcode), 'nodata': nodata, 'late': meta_late, 'launch': float(lr['OVR'])}
    return rows, {'closed': closed, 'meta': meta, 'engine': engine_by_stage, 'launch_mode': used_mode,
                  'minutes': stage_minutes}


# ── 6. 백테스트 리포트 ─────────────────────────────────────────────────────────────
FAMOUS = ['라건아', '허훈', '이정현', '유기상', '자밀 워니', '아셈 마레이', '하윤기', '송교창', '최준용', '문성곤']


def _corr(a, b):
    if len(a) < 3 or np.std(a) == 0 or np.std(b) == 0:
        return float('nan')
    return float(np.corrcoef(a, b)[0, 1])


def _direction_flips(traj):
    """움직인 단계들의 방향(+/-)이 바뀐 횟수(재보정 점프는 제외)."""
    sg = [np.sign(r['delta']) for r in traj[1:] if r['delta'] != 0 and not r['recalibrated']]
    return sum(1 for a, b in zip(sg, sg[1:]) if a != b)


def backtest_report(season, rows, info, min_minutes=300.0):
    hist = {r['pcode']: r for r in load_history() if r['season'] == season and not r.get('projected')}
    by_p = {}
    for r in rows:
        by_p.setdefault(r['pcode'], []).append(r)
    stats = {'season': season, 'closed': info['closed'], 'constants': {
        'K_MINUTES': K_MINUTES, 'K_MINUTES_NODATA': K_MINUTES_NODATA, 'STEP_MIN': STEP_MIN, 'STEP_MAX': STEP_MAX,
        'SEASON_CAP': SEASON_CAP, 'RECAL_MIN_MINUTES': RECAL_MIN_MINUTES, 'RECAL_CAP': RECAL_CAP,
        'PRORATE_VOLUME': PRORATE_VOLUME}}
    groups = {'data': [], 'nodata': []}
    for p, traj in by_p.items():
        m_last = traj[-1]['minutes']
        if m_last < min_minutes:
            continue
        info_p = info['meta'][p]
        groups['nodata' if info_p['nodata'] else 'data'].append((p, traj, info_p))

    def summarize(items):
        s = {'n': len(items)}
        if not items:
            return s
        steps = [abs(r['delta']) for _, t, _ in items for r in t[1:] if r['delta'] != 0 and not r['recalibrated']]
        recal = [r['delta'] for _, t, _ in items for r in t[1:] if r['recalibrated']]
        s['nonzero_steps'] = len(steps)
        s['share_in_0.2_1.0'] = (sum(1 for x in steps if STEP_MIN - 1e-9 <= x <= STEP_MAX + 1e-9) / len(steps)) if steps else None
        s['median_abs_step'] = float(median(steps)) if steps else None
        s['mean_moves_per_player'] = float(np.mean([sum(1 for r in t[1:] if r['delta'] != 0) for _, t, _ in items]))
        s['share_never_moved'] = float(np.mean([all(r['delta'] == 0 for r in t[1:]) for _, t, _ in items]))
        # 캡: 그 선수의 기준(launch, 재보정이면 재보정값)에서 SEASON_CAP 이상 떨어져 있는 단계
        cap_hit, cap_stage = 0, {}
        for _, t, _ in items:
            base = t[0]['ovr']
            for r in t[1:]:
                if r['recalibrated']:
                    base = r['ovr']
                if abs(r['ovr'] - base) >= SEASON_CAP - 1e-9:
                    cap_hit += 1
                    cap_stage[r['stage']] = cap_stage.get(r['stage'], 0) + 1
                    break
        s['hit_cap'] = cap_hit
        s['first_cap_stage'] = cap_stage
        drift = np.array([abs(t[-1]['ovr'] - t[0]['ovr']) for _, t, _ in items])
        s['final_drift'] = {'mean': float(drift.mean()), 'median': float(np.median(drift)), 'p90': float(np.percentile(drift, 90)),
                            'max': float(drift.max()), 'share_gt_3': float((drift > 3.0).mean())}
        flips = [_direction_flips(t) for _, t, _ in items]
        s['reversal_gt2_players'] = sum(1 for f in flips if f > 2)
        s['any_reversal_players'] = sum(1 for f in flips if f > 0)
        ef = [(p, t, hist[p]['OVR']) for p, t, _ in items if p in hist]
        if ef:
            L = np.array([t[0]['ovr'] for _, t, _ in ef]); V = np.array([t[-1]['ovr'] for _, t, _ in ef]); E = np.array([e for _, _, e in ef], float)
            s['n_with_truth'] = len(ef)
            s['mean_abs_L_minus_E'] = float(np.abs(L - E).mean())
            s['mean_abs_V_minus_E'] = float(np.abs(V - E).mean())
            s['corr_move_vs_gap'] = _corr(V - L, E - L)
            s['mean_L'], s['mean_V'], s['mean_E'] = float(L.mean()), float(V.mean()), float(E.mean())
            s['share_moved_toward_truth'] = float(np.mean([(v - l) * (e - l) > 0 for l, v, e in zip(L, V, E) if v != l]))
        s['recal'] = {'n': len(recal), 'mean_abs_jump': float(np.mean(np.abs(recal))) if recal else None,
                      'max_abs_jump': float(np.max(np.abs(recal))) if recal else None,
                      'stage': {}}
        for _, t, _ in items:
            for r in t[1:]:
                if r['recalibrated']:
                    s['recal']['stage'][r['stage']] = s['recal']['stage'].get(r['stage'], 0) + 1
        return s

    stats['data_players'] = summarize(groups['data'])
    stats['nodata_players'] = summarize(groups['nodata'])
    stats['all_ge_min'] = summarize(groups['data'] + groups['nodata'])
    return stats, groups


def famous_table(season, rows, info, extra_rookies=3):
    hist = [r for r in load_history() if r['season'] == season and not r.get('projected')]
    hist_by = {}
    for r in hist:
        hist_by.setdefault(r['name'], []).append(r)
    by_p = {}
    for r in rows:
        by_p.setdefault(r['pcode'], {})[r['stage']] = r
    picks = []
    for nm in FAMOUS:
        for h in hist_by.get(nm, []):
            if h['pcode'] in by_p:
                picks.append((h['pcode'], nm, h['OVR']))
    rookies = sorted(((p, m) for p, m in info['meta'].items() if m['nodata'] and p in by_p and by_p[p][info['closed'][-1]]['minutes'] > 600),
                     key=lambda x: -by_p[x[0]][info['closed'][-1]]['minutes'])[:extra_rookies]
    for p, m in rookies:
        h = next((r for r in hist if r['pcode'] == p), None)
        picks.append((p, (m['name'] or p) + ' (무데이터)', h['OVR'] if h else None))
    head = ['선수', 'pcode', 'launch'] + STAGES + ['E_full']
    lines = ['| ' + ' | '.join(head) + ' |', '|' + '---|' * len(head)]
    for p, nm, ef in picks:
        t = by_p[p]
        cells = [nm, p, f"{t['launch']['ovr']:.1f}"]
        for st in STAGES:
            r = t.get(st)
            cells.append('-' if r is None else (f"{r['ovr']:.1f}*" if r['recalibrated'] else f"{r['ovr']:.1f}"))
        cells.append('-' if ef is None else str(ef))
        lines.append('| ' + ' | '.join(cells) + ' |')
    return '\n'.join(lines)


def cmd_backtest(seasons, use_cache):
    os.makedirs(REPORT_DIR, exist_ok=True)
    for season in seasons:
        t0 = time.time()
        rows, info = build_season_rows(season, launch_mode='backtest', complete=True, use_cache=use_cache)
        elapsed = time.time() - t0
        stats, _ = backtest_report(season, rows, info)
        stats['elapsed_sec_incl_engine'] = round(elapsed, 1)
        table = famous_table(season, rows, info)
        with open(os.path.join(REPORT_DIR, f'backtest_{season}.json'), 'w', encoding='utf-8') as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
        with open(os.path.join(REPORT_DIR, f'backtest_{season}.md'), 'w', encoding='utf-8') as f:
            f.write(f'# ovr_round 백테스트 {season}\n\n```json\n{json.dumps(stats, ensure_ascii=False, indent=2)}\n```\n\n{table}\n')
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        print(table)


# ── 7. DB 쓰기(이 에이전트는 실행하지 않는다) ───────────────────────────────────────
def write_db(rows):
    import psycopg2
    from psycopg2.extras import execute_values
    from import_roster import load_database_url
    conn = psycopg2.connect(load_database_url())
    try:
        with conn, conn.cursor() as cur:
            execute_values(cur, """
                insert into public.ovr_round (pcode, season, stage, ovr, off, def, delta, minutes, recalibrated, computed_at)
                values %s
                on conflict (pcode, season, stage) do update set
                  ovr = excluded.ovr, off = excluded.off, def = excluded.def, delta = excluded.delta,
                  minutes = excluded.minutes, recalibrated = excluded.recalibrated, computed_at = now()
                """, [(r['pcode'], r['season'], r['stage'], r['ovr'], r['off'], r['def'], r['delta'], r['minutes'], r['recalibrated'])
                      for r in rows], template='(%s,%s,%s,%s,%s,%s,%s,%s,%s,now())', page_size=1000)
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--backtest', action='append', metavar='SEASON', help='읽기 전용 백테스트(여러 번 지정 가능)')
    ap.add_argument('--season', help='궤적을 계산할 시즌(예: 2026-2027)')
    ap.add_argument('--dry-run', action='store_true', help='기본 동작(DB에 안 씀)')
    ap.add_argument('--write-db', action='store_true', help='public.ovr_round에 upsert(tools/sql/ovr_round.sql 필요)')
    ap.add_argument('--out', help='--season 결과 행을 저장할 JSON 경로')
    ap.add_argument('--launch', default='auto', choices=['auto', 'history', 'backtest'])
    ap.add_argument('--complete', action='store_true', help='시즌 종료로 간주(마지막 단계에서 사후정보 차단 해제)')
    ap.add_argument('--no-cache', action='store_true')
    a = ap.parse_args()
    if a.backtest:
        cmd_backtest(a.backtest, not a.no_cache)
        return
    if not a.season:
        ap.error('--backtest 또는 --season 필요')
    rows, info = build_season_rows(a.season, a.launch, True if a.complete else None, not a.no_cache)
    print(f'{len(rows)} rows, closed={info["closed"]}')
    if a.out:
        with open(a.out, 'w', encoding='utf-8') as f:
            json.dump(rows, f, ensure_ascii=False)
        print('wrote', a.out)
    if a.write_db and not a.dry_run:
        write_db(rows)
        print('upserted', len(rows))
    else:
        print('dry-run: DB에 쓰지 않음')


if __name__ == '__main__':
    main()
