"""플레이 스타일(아키타입) 분류 - 선수-시즌마다 메인 1개 + 서브 1개(없으면 None).

build_courtside_ovr.py가 시즌·선수당 1행짜리 global_df를 넘기면 (메인 key, 서브 key)를 돌려준다.
OVR/OFF/DEF/세부 능력치 계산엔 관여하지 않는다 - 엔진의 `role`(11개)은 그대로 OFF/DEF 분할과 롤 플레이어
캡에 쓰이고, 여기서 정하는 건 화면에 보여줄 스타일뿐이다.

원리
  1. 스타일마다 "적합도"(0~1)를 정의한다 - 그 시즌 리그에서 해당 신호가 몇 % 위에 있는지(백분위). 시대마다
     3점 비중·페이스가 달라도 같은 잣대라서 절대 기준 대신 시즌 내 백분위를 쓴다. 비교 풀은 그 시즌 출전
     MIN_MINUTES 이상인 선수(진행 중 시즌은 경기 수에 비례해 하한을 낮춤). 빅맨/비빅맨 전용 스타일은 같은
     그룹끼리, 나머지는 리그 전체와 비교한다. 지표 둘 이상을 합친 스타일은 합성값을 다시 백분위로 매겨서
     "리그 상위 X%"의 의미가 스타일마다 같게 만든다.
  2. 메인 = 엔진이 정한 기존 롤. 다른 스타일 적합도가 기준선(MAIN_MIN)을 넘고 기존 롤보다 MARGIN 이상 뚜렷하게
     높으면 그 스타일로 교체("확실히 더 맞을 때만"). 공격 점유율 상위(에이스)에겐 수비·궂은일 계열을 메인으로
     붙이지 않는다(서브로만).
  3. 서브 = 메인이 아닌 스타일 중 적합도 최고이면서 SUB_MIN 이상일 때만(아니면 None). 사실상 같은 말인 조합
     (예: 리바운드 + 공격 리바운드)은 REDUNDANT로 걸러낸다.
  출전 MIN_MINUTES 미만(표본 부족)은 기존 롤 그대로, 서브 없음.
"""
import numpy as np
import pandas as pd

# (key, 한글 라벨, 툴팁 설명). 앞 11개는 기존 키(이름 변경 금지), 뒤는 신규. 순서는 문서용일 뿐 판정과 무관.
PLAY_STYLES = [
    ('Point Center', '포인트 센터', '골밑에서 동료의 득점 기회까지 만들어주는 패싱 빅맨.'),
    ('Stretch Big', '스트레치 빅', '3점 라인 밖에서도 위협적인 슈팅 빅맨.'),
    ('Paint Beast', '페인트존 장인', '골밑 득점과 리바운드를 함께 책임지는 페인트존의 지배자.'),
    ('Glass Cleaner', '글래스 클리너', '공수 리바운드를 걷어내는 리바운드 전문 빅맨.'),
    ('Playmaker', '플레이메이커', '경기를 조율하며 동료의 득점을 만들어주는 볼 핸들러.'),
    ('Sharpshooter', '샤프슈터', '3점과 외곽 슈팅으로 점수를 만드는 슈터.'),
    ('Slasher', '슬래셔', '돌파와 림 어택으로 페인트존을 파고들고 파울까지 얻어내는 공격수.'),
    ('3&D Wing', '3&D 윙', '3점 슈팅과 끈질긴 수비를 겸비한 윙.'),
    ('Lockdown Defender', '락다운 디펜더', '맡은 상대를 꽁꽁 묶는 수비 스페셜리스트.'),
    ('Scoring Threat', '스코어링 스렛', '언제든 득점을 터뜨릴 수 있는 득점원.'),
    ('All-Around', '올어라운드', '뚜렷한 약점 없이 고르게 해내는 만능 자원.'),
    ('Rim Protector', '림 프로텍터', '블락과 골밑 수비로 림을 지키는 수호신.'),
    ('Ball Hawk', '스틸러', '패스 길을 읽고 공을 가로채는 수비수.'),
    ('Midrange Master', '미드레인지 마스터', '공격의 상당 부분을 중거리 점퍼로 풀어가며 리그 평균 이상으로 넣는 선수.'),
    ('Foul Magnet', '파울 유도형', '림 어택과 접촉으로 자유투를 꾸준히 얻어내는 선수.'),
    ('Combo Guard', '콤보 가드', '득점과 볼 배급을 둘 다 해내는 가드.'),
    ('Bench Scorer', '벤치 스코어러', '벤치에서 나와 득점을 책임지는 식스맨.'),
    ('Corner Specialist', '코너 스페셜리스트', '코너 3점을 주무기로 삼아 정확하게 꽂는 슈터.'),
    ('Double-Double Machine', '더블더블 머신', '득점과 리바운드 더블더블을 밥 먹듯 기록하는 빅맨.'),
    ('Clutch Closer', '클러치 해결사', '접전의 4쿼터·연장에서 가장 믿을 만한 득점원.'),
    ('Screen Setter', '스크린 세터', '단단한 스크린으로 동료의 슈팅과 돌파 기회를 열어주는 선수.'),
    ('Hustle Big', '허슬 빅', '공격 리바운드와 풋백으로 세컨드 찬스를 만드는 에너지형 빅맨.'),
    ('Role Player', '롤 플레이어', '아직 KBL 기록이 없어 역할을 가늠하기 어려운 선수.'),
]
STYLE_LABEL = {k: label for k, label, _ in PLAY_STYLES}


def styles_json():
    """courtside-web/lib/play_styles.json(화면과 공유하는 단일 출처)용 리스트."""
    return [{'key': k, 'label': label, 'description': desc} for k, label, desc in PLAY_STYLES]


MIN_MINUTES = 300        # 시즌 총 출전 분 하한(완주 시즌 기준) - 이 미만은 표본이 작아 세분화하지 않는다
FULL_SEASON_GAMES = 54   # 정규시즌 경기 수 - 진행 중 시즌은 (최다 출전 경기 수/54)만큼 하한을 낮춘다
MIN_POOL = 8             # 비교 풀이 이보다 작으면 백분위를 못 낸다(시즌 극초반)

MAIN_MIN = 0.88          # 메인을 가져가려면 필요한 적합도(리그 상위 12%)
MARGIN = 0.05            # 기존 롤보다 이만큼 이상 높아야 교체(기존 롤 우대)
WEAK = 0.70              # 기존 롤 적합도가 이보다 낮으면 "안 맞는 라벨" - 교체 문턱을 낮추고 기술 특화도 메인 후보로
WEAK_MAIN_MIN = 0.80
SKILL_MAIN_MIN = 0.90    # 기술 특화 스타일(SKILL)은 기존 롤이 안 맞을 때만 메인, 그때도 더 높은 문턱
SUB_MIN = 0.80           # 서브가 되려면 필요한 적합도(리그 상위 20%)
SKILL_SUB_MIN = 0.85
STAR_USAGE = 0.80        # 공격 점유율 백분위가 이 이상이면 "에이스"

# 수비·궂은일 계열 - 에이스의 메인 라벨로는 부적절(서브로만). 벤치 스코어러도 에이스와 모순이라 포함.
NO_STAR_MAIN = {'Lockdown Defender', '3&D Wing', 'Rim Protector', 'Ball Hawk', 'Screen Setter', 'Hustle Big', 'Bench Scorer'}
# 기술 특화(지표 하나 안팎으로 정의) - 메인은 기존 롤보다 훨씬 뚜렷하게 높을 때만
SKILL = {'Ball Hawk', 'Midrange Master', 'Corner Specialist', 'Foul Magnet', 'Clutch Closer', 'Bench Scorer'}
# 뭉뚱그린 스타일은 구체적인 스타일에 살짝 밀리고, 두 능력을 합친 콤보 가드는 살짝 앞선다
PRIOR = {'Scoring Threat': -0.05, 'Lockdown Defender': -0.03, 'Combo Guard': 0.05}
REDUNDANT = {frozenset(p) for p in [
    ('Glass Cleaner', 'Hustle Big'), ('Paint Beast', 'Glass Cleaner'), ('Paint Beast', 'Hustle Big'),
    ('Playmaker', 'Combo Guard'), ('Point Center', 'Screen Setter'), ('Hustle Big', 'Screen Setter'),
    ('Lockdown Defender', 'Ball Hawk'), ('Rim Protector', 'Lockdown Defender'), ('Sharpshooter', 'Stretch Big'),
]}

# 판정 대상 키(엔진 롤 10개 + 신규 11개). All-Around(엔진 fallback)와 Role Player(기록 없는 신인)는 판정 없음.
KEYS = [k for k, _, _ in PLAY_STYLES if k not in ('All-Around', 'Role Player')]


def _rank(values, pool):
    """values 각 원소가 pool 안에서 차지하는 중간순위 백분위(0~1). 풀이 너무 작으면 NaN."""
    pv = np.sort(pool.dropna().to_numpy(float))
    v = values.to_numpy(float)
    if len(pv) < MIN_POOL:
        return np.full(len(v), np.nan)
    r = (np.searchsorted(pv, v, 'left') + np.searchsorted(pv, v, 'right')) / (2.0 * len(pv))
    r[np.isnan(v)] = np.nan
    return r


def _strengths(df):
    """(적합도 DataFrame[KEYS], 풀 자격 Series, 점유율 백분위 Series). 적용 불가 스타일은 NaN."""
    pos = df['position'].astype(str).str.upper()
    big = pos.str.contains('C') | (pos.str.contains('F') & (df['reb'] >= 6.0))  # 엔진 is_big과 같은 정의
    tall = pos.str.contains('C') | pos.str.contains('F')
    guard = pos.str.contains('G')
    g = df['g'].clip(lower=1)
    d = df.assign(
        fta_per75=df['fta'] / df['total_possessions'] * 75,
        start_pct=df['starts'] / g,
        dd_rate=df['dd_games'] / g,
        mid_share=df['mid_fga'] / df['fga'].replace(0, np.nan),
        clutch_ppg=df['clutch_pts'] / df['close_g'].replace(0, np.nan),
        clutch_pps=df['clutch_pts'] / df['clutch_fga'].replace(0, np.nan),
        corner_share=df['corner_a'] / df['tpa_shot'].replace(0, np.nan),
        corner_pct=df['corner_m'] / df['corner_a'].replace(0, np.nan),
        oreb_share=df['total_offr'] / (df['total_offr'] + df['total_defr']).replace(0, np.nan),
    )

    parts, quals, usage_p = [], [], []
    for _, sdf in d.groupby('season_name'):
        idx = sdf.index
        scale = float(np.clip(sdf['g'].max() / FULL_SEASON_GAMES, 0, 1))
        qual = sdf['total_min'] >= MIN_MINUTES * scale
        b = big.loc[idx]
        t = tall.loc[idx]
        every = pd.Series(True, index=idx)

        def P(col, group='own', cond=None):
            """col(이름 또는 Series)의 백분위. group 'own'=빅/비빅 각자 비교, 'all'=리그 전체. cond=풀 제한."""
            s = sdf[col] if isinstance(col, str) else col
            pool = qual if cond is None else (qual & cond)
            if group == 'all':
                return pd.Series(_rank(s, s[pool]), index=idx)
            o = pd.Series(np.nan, index=idx)
            for flag in (True, False):
                m = b == flag
                o[m] = _rank(s[m], s[m & pool])
            return o

        S = pd.DataFrame(index=idx)

        def add(key, comp, elig=None, group='own'):
            cond = every if elig is None else elig
            S[key] = P(comp, group, cond).where(cond)

        # 엔진 롤 - 엔진 내부 합성 능력치(inside 등)는 자유투 %의 세제곱 페널티 같은 인공물이 커서 화면용 판정은
        # 더 직접적인 지표(득점/어시스트/페인트 득점/자유투 시도)로 다시 정의했다.
        add('Playmaker', 'ast_per75', ~b)
        add('Point Center', 'ast_per75', b)
        add('Sharpshooter', 'attr_outside', ~b)
        add('Stretch Big', np.minimum(P('attr_outside'), P('tpm_per75', 'all')), b)
        add('Slasher', (P('paint_pts_per75') + P('fta_per75')) / 2)
        add('Lockdown Defender', 'attr_defense')
        add('3&D Wing', np.minimum(P('attr_outside'), P('attr_defense')))
        add('Scoring Threat', 'pts')
        add('Glass Cleaner', 'attr_rebounding', b)
        add('Paint Beast', np.minimum(P('paint_pts_per75'), P('attr_rebounding')), b)
        # 신규 - 지표 하나(또는 둘)로 정의. 표본 하한(floor)은 소표본 우연을 걸러낸다.
        add('Rim Protector', 'blk_per75', t, 'all')
        add('Ball Hawk', 'stl_per75', None, 'all')
        me = (sdf['mid_fga'] >= 50) & (sdf['midrange_pct'] >= 0.373)  # 0.373 = 리그 평균 미드레인지 성공률
        add('Midrange Master', 'mid_share', me, 'all')
        add('Foul Magnet', np.minimum(P('fta_per75', 'all'), P('ft_rate', 'all')), sdf['fta'] >= 60, 'all')
        add('Combo Guard', np.minimum(P('pts_per75'), P('ast_per75')), ~b & guard.loc[idx])
        add('Bench Scorer', 'pts', sdf['start_pct'] <= 0.34, 'all')
        ca = sdf['corner_a'] >= 35
        add('Corner Specialist', np.minimum(P('corner_share', 'all', ca), P('corner_pct', 'all', ca)), ca, 'all')
        S['Double-Double Machine'] = P('dd_rate', 'all').where(sdf['dd_rate'] >= 0.25)
        cl = sdf['clutch_fga'] >= 40
        add('Clutch Closer', np.minimum(P('clutch_ppg', 'all', cl), P('clutch_pps', 'all', cl)), cl, 'all')
        # 스크린 어시스트(sast)는 KBL이 2025-26부터 기록 - 그 전 시즌엔 신호가 없어 판정 불가
        if sdf.loc[qual, 'sast_per75'].max() > 0:
            add('Screen Setter', 'sast_per75', None, 'all')
        else:
            S['Screen Setter'] = np.nan
        add('Hustle Big', np.minimum(P('offr_per75', 'all'), P('oreb_share', 'all')), t, 'all')
        parts.append(S[KEYS])
        quals.append(qual)
        usage_p.append(P('usage', 'all'))
    return pd.concat(parts).loc[df.index], pd.concat(quals).loc[df.index], pd.concat(usage_p).loc[df.index]


def assign_play_styles(df):
    """df(global_df) -> (메인 key Series, 서브 key Series). 서브가 없으면 None."""
    S, qual, usage_p = _strengths(df)
    Sv = S.to_numpy(float)
    star = (usage_p >= STAR_USAGE).to_numpy()
    engine = df['role'].fillna('All-Around').to_numpy(object)
    main = engine.copy()
    sub = np.full(len(df), None, dtype=object)
    for n in np.flatnonzero(qual.to_numpy()):
        s = dict(zip(KEYS, Sv[n]))
        eng = engine[n]
        banned = NO_STAR_MAIN if star[n] else ()
        eng_ok = eng not in banned
        # 엔진 롤의 현재 적합도 - All-Around(엔진 fallback)이거나 못 잰 경우엔 중립 0.5
        e = s.get(eng, np.nan)
        e = 0.5 if e != e else e
        weak = (not eng_ok) or e < WEAK
        base = e + PRIOR.get(eng, 0.0) if eng_ok else -1.0
        pick, pick_score = None, -1.0
        for k in KEYS:
            v = s[k]
            if v != v or k == eng or k in banned:
                continue
            skill = k in SKILL
            score = v + PRIOR.get(k, 0.0)
            if skill and not weak:
                continue
            # 낮은 문턱은 "쓸 수는 있지만 안 맞는" 기존 롤일 때만(에이스라 기존 롤이 막힌 경우엔 그대로 MAIN_MIN)
            need = SKILL_MAIN_MIN if skill else (WEAK_MAIN_MIN if eng_ok and weak else MAIN_MIN)
            if v >= need and score >= base + MARGIN and score > pick_score:
                pick, pick_score = k, score
        m = pick or (eng if eng_ok else 'All-Around')
        main[n] = m
        # 서브
        best, best_score = None, -1.0
        for k in KEYS:
            v = s[k]
            if v != v or k == m or frozenset((m, k)) in REDUNDANT:
                continue
            if v >= (SKILL_SUB_MIN if k in SKILL else SUB_MIN) and v + PRIOR.get(k, 0.0) > best_score:
                best, best_score = k, v + PRIOR.get(k, 0.0)
        sub[n] = best
    return pd.Series(main, index=df.index), pd.Series(sub, index=df.index)
