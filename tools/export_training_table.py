"""
경기 전(pre-game) 승률 예측 베이스라인용 피처 테이블 추출 (로드맵 05단계 준비 작업).

핵심 원칙: 데이터 누수(leakage) 방지 - 각 팀-경기 행의 피처는 반드시 "그 경기 이전 날짜"의
경기들만 사용한다. team-record.json의 offrtg/defrtg/netrtg/pace를 팀별로 날짜순 정렬해서
직전 최대 10경기 이동평균으로 계산 (그날 경기 자체의 스탯은 절대 포함 안 함 - 그건 결과를
아는 상태에서 결과를 예측하는 것과 같아서 의미없는 모델이 됨).

**시너지·신체정보 결합 (사용자 요청)**: build_player_onoff_timeline.py가 만든 "그 경기 이전까지"
누적된 선수별 온/오프코트 net rating 스냅샷과, build_player_bio_features.py가 만든 나이/키/몸무게/
드래프트 컴바인(버티컬 점프 등) 데이터를, 팀의 "최근 로스터 로테이션"(직전 ROLL_WINDOW경기에서
각 선수가 실제로 뛴 평균 출전시간)으로 가중평균해서 팀 단위 피처로 결합한다. 가중치를 "이번 경기
실제 출전시간"이 아니라 "직전 경기들의 평균 출전시간"으로 쓰는 이유: 이번 경기 로테이션은 아직
일어나지 않은 미래 정보라 실전 배포 시점엔 알 수 없음 - 오직 과거로만 만든 예측 피처여야 함.

컴바인 데이터는 2018년 이후 드래프트생만 있어서(121명 매칭) 팀 로스터 상당수가 결측 - 결측
선수는 평균 계산에서 빼고 커버리지 비율(`*_coverage`)도 같이 남겨서, 나중에 이 피처를 믿을지
말지 판단할 수 있게 한다.

아직 어떤 모델 아키텍처를 쓸지 정하지 않았음 - 이 스크립트는 아키텍처와 무관하게 필요한
"경기 전 시점 피처 테이블"만 만들어둔다. 실시간(경기 중) 승률 예측은 별도로 스틴트/이벤트
시퀀스 기반 모델이 필요 (여긴 사전 논의 필요 - 로드맵 05 본작업). 2·3인 조합 시너지/매치업은
"미래에 누가 함께 뛸지"를 미리 알아야 해서 사전 예측 피처로 못 씀 - 그건 라이브(경기 중)
모델의 영역.

표본 부족(직전 경기 3경기 미만 - 시즌 극초반)인 행은 제외.

**2026-08-20 확장 (사용자 요청)**: 휴식일수/요일/월(시즌진행도)/경기장/감독/심판/다중시간창
회복폼/용병출전집중도를 추가. 전부 같은 원칙(그 경기 이전 정보만) 적용:
- 휴식일수·요일·월: 그냥 날짜에서 계산되는 사실이라 누수 걱정 없음(경기 전에 이미 확정된 값)
- 경기장/감독/심판: "이 경기 이전까지" 누적 성적(팀-구장 승률, 감독 커리어 승률, 심판이
  담당했던 경기의 홈팀 승률)을 스냅샷으로 - player_onoff_timeline.py와 같은 패턴
- 다중 시간창 폼: 기존엔 직전 10경기 평균 하나뿐이었는데, 1/3/5/10경기 각각 따로 평균내서
  "최근 폼"을 여러 해상도로 포착 (사용자가 말한 "시계열 2~5배 증가")
- 용병 출전 집중도: 연봉 데이터는 kbl.or.kr에 없음(비공식 API 프론트 번들 뒤져봤는데 "연봉"/
  "샐러리" 관련 텍스트는 전부 이사회 의결 같은 역사 기록일 뿐 선수별/팀별 실제 데이터는 없음).
  대신 실제 출전시간/사용률로 "1옵-2옵 역할 분리 정도"를 직접 측정 - 어차피 연봉도 결국 역할
  분담을 반영하는 대리지표일 뿐이라 이게 더 직접적일 수 있음.
  **주의**: 2025-26 시즌까지 외국선수는 항상 1명만 동시 출전 가능했던 규정 기준 데이터임.
  다가오는 시즌(2쿼터·3쿼터에 외국선수 2명 동시 출전 허용)은 이 15시즌 데이터에 단 한 경기도
  선례가 없는 완전히 새로운 룰이라, 그 변화 자체를 학습할 표본이 아직 없음 - 새 시즌 데이터가
  쌓이기 전까진 이 부분 예측력은 제한적일 수 있다는 걸 감안해야 함.

**나이-기량 곡선 피처 (2026-08-20, 사용자 요청 - "조심스럽게 피처화") - 신중하게 다룬 이유들**:
1. build_age_curves.py/check_survivorship_bias.py로 이미 확인했듯, 이 곡선은 "평균 선수의
   성장 궤적"이 아니라 "리그에 남은 선수들의 궤적" - 생존편향이 완전히 안 빠짐. 그래서 "선수가
   나이 들면 이렇게 좋아질 것"이라고 예측에 쓰는 게 아니라, "이 나이대 선수는 그 포지션
   전형적으로 어느 수준을 보이는가"라는 **서술적 컨텍스트 피처**로만 씀.
2. 노이즈가 큰 스탯/구간(30대 후반, 센터 포지션, 표본 5쌍 미만 구간)이 섞여있어서 표본이
   가장 탄탄한 3개 스탯만 씀: 어시스트율(astRt, BQ 신호), 덩크(dk, 순수운동능력 신호),
   PER(종합가치). 곡선 자체도 3점 이동평균으로 스무딩해서 들쭉날쭉한 나이별 델타 노이즈를 줄임.
3. **잔여 데이터 누수 주의**: age_curves.json은 15시즌 전체를 한 번에 써서 만든 고정 곡선임 -
   즉 2012년 경기를 피처화할 때도 2026년 데이터가 섞여 만들어진 "전형적인 정점 나이"를 쓰게
   됨. 이건 팀 롤링스탯/시너지처럼 그 경기 이전 정보만 쓰는 다른 피처들과 다른, 약한 형태의
   미래정보 유입임. 노화 패턴이 15년 사이 리그 안에서 극적으로 바뀌었을 가능성은 낮다고 보고
   일단 진행하지만, 엄밀하게는 완전히 leak-free가 아니라는 걸 기록해둠.
4. 피처 자체는 "팀 로스터가 각 포지션 전형적 정점 대비 얼마나 아래/위에 있는가"(0=정점 수준,
   음수일수록 정점에서 먼 나이) - 팀 로테이션 출전시간 가중평균, leak-free(그 경기 이전
   윈도우의 로테이션만 사용, 다른 피처들과 동일 원칙).

**로스터 연속성 피처 (2026-08-20, 사용자 관찰 - 병역 공백)**: 국내선수 경력 데이터에서 "2시즌
코드 이상 건너뛰는 공백"을 세어보니 176건 중 62.5%(110건)가 23~26세에서 시작(24세가 최다,
42건), 공백 길이는 대부분 1시즌 분(111건) - 상무(연 10명 안팎)를 못 간 선수는 일반 입대로
1~2시즌을 통째로 비우고, 그중 상당수는 복귀해도 로테이션에 못 돌아온다는 얘기와 정확히
부합. 원인(병역/트레이드/부상 등)을 구분하긴 어렵지만, "작년 로테이션 핵심이었던 선수가
지금 로스터에 없다"는 사실 자체가 팀 전력 변화의 선행 신호라 팀 단위 연속성 지표로 씀:
직전 완결 시즌의 상위 로테이션(출전시간 기준) 중 이번 윈도우에도 남아있는 비율.

**런 취약성 피처 (2026-08-24, Tier04 로드맵 - "지금 비어있는 신호 종류")**: `build_run_vulnerability.py`가
경기별로 계산해둔 "이 팀이 그 경기에서 상대에게 내준 8+런 횟수/최대런 크기"를, 다른 롤링피처와
똑같이 직전 ROLL_WINDOW경기 평균으로 leak-free 결합. 나이곡선/로스터연속성 때와 같은 절차로
`tune_hyperparams.py`에서 애블레이션 후 채택 여부 결정 예정 - 아직 기본 FEATURE_KEYS엔 없음.
"""
import datetime
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
OUT_PATH = os.path.join(ANALYSIS_DIR, "pregame_training_table.json")

ROLL_WINDOW = 10
MIN_HISTORY = 3
FORM_WINDOWS = [1, 3, 5, 10]
FEATURE_KEYS = ["offrtg", "defrtg", "netrtg", "pace", "efgRt", "tsRt", "rebRt", "astRt", "tovRt"]
FOREIGN_NATIONALITIES = {"외국", "아시아쿼터"}


def load_player_stats_by_game():
    """gmkey -> [{pcode, tcode, playMin, playSec}] - 팀별 로테이션/출전시간 파악용."""
    out = {}
    for gmkey in os.listdir(GAMES_DIR):
        path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            rows = json.load(f)
        entries = []
        for row in rows:
            p, r = row["player"], row["records"]
            minutes = (r.get("playMin") or 0) + (r.get("playSec") or 0) / 60
            if minutes <= 0:
                continue
            entries.append({"pcode": p["pcode"], "tcode": p["tcode"], "minutes": minutes})
        out[gmkey] = entries
    return out


def age_on(birth_date_str, on_date_str):
    if not birth_date_str or not on_date_str:
        return None
    try:
        bd = datetime.datetime.strptime(birth_date_str, "%Y-%m-%d")
        od = datetime.datetime.strptime(on_date_str, "%Y%m%d")
    except ValueError:
        return None
    return od.year - bd.year - ((od.month, od.day) < (bd.month, bd.day))


def weighted_avg(pairs):
    """pairs: [(value, weight)], value가 None인 항목은 제외."""
    total_w = sum(w for v, w in pairs if v is not None)
    if total_w <= 0:
        return None, 0.0
    val = sum(v * w for v, w in pairs if v is not None) / total_w
    coverage = total_w / sum(w for _, w in pairs) if pairs else 0.0
    return round(val, 2), round(coverage, 2)


def load_all_games():
    games = []
    for gmkey in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        tr_path = os.path.join(GAMES_DIR, gmkey, "team-record.json")
        if not (os.path.exists(meta_path) and os.path.exists(tr_path)):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        with open(tr_path, encoding="utf-8") as f:
            tr = json.load(f)
        by_tcode = {row["tcode"]: row["records"] for row in tr}
        g = meta["game"]
        home_tcode, away_tcode = g.get("tcodeH"), g.get("tcodeA")
        if home_tcode not in by_tcode or away_tcode not in by_tcode:
            continue
        teams = meta.get("teams", {})
        judges = g.get("judges") or {}
        games.append({
            "gmkey": gmkey,
            "gameDate": g.get("gameDate"),
            "seasonCode": g.get("seasonCode"),
            "homeTcode": home_tcode,
            "awayTcode": away_tcode,
            "homeRecord": by_tcode[home_tcode],
            "awayRecord": by_tcode[away_tcode],
            "stadium": g.get("stadiumname"),
            "homeManager": ((teams.get("home") or {}).get("staffs") or {}).get("manager", {}).get("name"),
            "awayManager": ((teams.get("away") or {}).get("staffs") or {}).get("manager", {}).get("name"),
            "mainReferee": (judges.get("main") or {}).get("name"),
        })
    games.sort(key=lambda x: (x["gameDate"], x["gmkey"]))
    return games


def date_context_features(game_date):
    """휴식일수는 팀별로 따로 계산해야 해서 별도(build_team_timelines 이후) - 여긴 날짜 자체에서
    바로 나오는, 팀 무관 컨텍스트만."""
    d = datetime.datetime.strptime(game_date, "%Y%m%d")
    return {"dayOfWeek": d.weekday(), "month": d.month}


def build_cumulative_timeline(games, key_fn, outcome_fn):
    """key_fn(g) -> 그룹 키(감독명/심판명/등), outcome_fn(g) -> 0/1(그 그룹 기준 승패).
    그룹키 -> [(gameDate, gmkey, outcome)] 날짜순. 감독은 팀 안 가리고 커리어 전체로 묶임,
    심판도 마찬가지."""
    timelines = {}
    for g in games:
        key = key_fn(g)
        if key is None:
            continue
        timelines.setdefault(key, []).append({"gameDate": g["gameDate"], "gmkey": g["gmkey"], "outcome": outcome_fn(g)})
    for k in timelines:
        timelines[k].sort(key=lambda x: (x["gameDate"], x["gmkey"]))
    return timelines


def cumulative_rate_before(timeline_for_key, gmkey=None, min_games=5):
    """이 gmkey '이전'까지의 누적 승률(또는 outcome 평균). 표본 부족하면 None.
    gmkey=None이면 아직 안 열린 미래 경기용 - 지금까지의 전체 기록을 그대로 씀(predict_upcoming_games.py)."""
    if not timeline_for_key:
        return None
    if gmkey is None:
        idx = len(timeline_for_key)
    else:
        idx = next((i for i, x in enumerate(timeline_for_key) if x["gmkey"] == gmkey), None)
        if idx is None:
            return None
    if idx < min_games:
        return None
    before = timeline_for_key[:idx]
    return round(sum(x["outcome"] for x in before) / len(before), 3)


def build_venue_timelines(games):
    """(tcode, venue) -> [(gameDate, gmkey, netrtg)] - 그 팀이 그 구장에서 뛴 기록만."""
    timelines = {}
    for g in games:
        for side, opp in (("home", "away"), ("away", "home")):
            tcode = g["homeTcode"] if side == "home" else g["awayTcode"]
            record = g["homeRecord"] if side == "home" else g["awayRecord"]
            key = (tcode, g["stadium"])
            timelines.setdefault(key, []).append(
                {"gameDate": g["gameDate"], "gmkey": g["gmkey"], "netrtg": record.get("netrtg")})
    for k in timelines:
        timelines[k].sort(key=lambda x: (x["gameDate"], x["gmkey"]))
    return timelines


def venue_rating_before(venue_timeline, gmkey=None, min_games=2):
    """team-venue 조합은 표본이 원래 적어서(원정 구장은 어쩌다 한 번씩) 기준을 낮게 잡음(2경기).
    gmkey=None이면 미래 경기용 - 지금까지 전체 기록 사용."""
    if not venue_timeline:
        return None
    if gmkey is None:
        idx = len(venue_timeline)
    else:
        idx = next((i for i, x in enumerate(venue_timeline) if x["gmkey"] == gmkey), None)
        if idx is None:
            return None
    if idx < min_games:
        return None
    before = venue_timeline[:idx]
    vals = [x["netrtg"] for x in before if x["netrtg"] is not None]
    return round(sum(vals) / len(vals), 2) if vals else None


def multi_window_form(history_before, windows=FORM_WINDOWS):
    """직전 N경기 평균을 여러 N(1/3/5/10)에 대해 각각 계산 - '최근 폼'을 여러 해상도로."""
    feats = {}
    for n in windows:
        window = history_before[-n:]
        if not window:
            for k in ("netrtg", "offrtg", "defrtg", "winPct"):
                feats[f"last{n}_{k}"] = None
            continue
        vals_net = [g["record"].get("netrtg") for g in window if g["record"].get("netrtg") is not None]
        vals_off = [g["record"].get("offrtg") for g in window if g["record"].get("offrtg") is not None]
        vals_def = [g["record"].get("defrtg") for g in window if g["record"].get("defrtg") is not None]
        feats[f"last{n}_netrtg"] = round(sum(vals_net) / len(vals_net), 2) if vals_net else None
        feats[f"last{n}_offrtg"] = round(sum(vals_off) / len(vals_off), 2) if vals_off else None
        feats[f"last{n}_defrtg"] = round(sum(vals_def) / len(vals_def), 2) if vals_def else None
        feats[f"last{n}_winPct"] = round(sum(g["won"] for g in window) / len(window), 3)
    return feats


AGE_CURVE_STATS = ["astRt", "dk", "per"]  # 표본 가장 탄탄한 3개만 (위 docstring 참고)


def smooth_curve(curve, window=3):
    """단순 이동평균으로 나이별 델타 노이즈 완화. curve: {age(str/int): value}."""
    ages = sorted(int(a) for a in curve)
    vals = {a: curve[str(a)] if str(a) in curve else curve.get(a) for a in ages}
    smoothed = {}
    half = window // 2
    for i, age in enumerate(ages):
        lo, hi = max(0, i - half), min(len(ages), i + half + 1)
        window_vals = [vals[ages[j]] for j in range(lo, hi)]
        smoothed[age] = sum(window_vals) / len(window_vals)
    return smoothed


def load_age_curves():
    """position|stat -> {age: level_relative_to_peak} (0 = 정점 수준, 음수 = 정점에서 먼 정도)."""
    path = os.path.join(ANALYSIS_DIR, "age_curves.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    out = {}
    for pos in ("GD", "FD", "C"):
        for stat in AGE_CURVE_STATS:
            key = f"{pos}|{stat}"
            curve = raw["curves"].get(key)
            if not curve:
                continue
            smoothed = smooth_curve(curve)
            peak_level = max(smoothed.values())
            out[key] = {age: v - peak_level for age, v in smoothed.items()}  # 0 이하, 정점이 0
    return out


def age_curve_team_feature(roster_minutes, bio, age_curves, game_date):
    """팀 로스터(직전 윈도우 평균출전시간 가중)가 각 포지션 전형적 정점 대비 어디에 있는지.
    포지션 정보 없거나 곡선 범위 밖 나이면 그 선수는 제외(전체 팀 평균에서 빠짐 - coverage로 추적)."""
    result = {}
    for stat in AGE_CURVE_STATS:
        pairs = []
        for pcode, mins in roster_minutes.items():
            b = bio.get(pcode)
            if not b or not b.get("position") or not b.get("birthDate"):
                pairs.append((None, mins))
                continue
            age = age_on(b["birthDate"], game_date)
            curve = age_curves.get(f"{b['position']}|{stat}")
            level = curve.get(age) if curve else None
            pairs.append((level, mins))
        val, cov = weighted_avg(pairs)
        result[f"ageCurveLevel_{stat}"] = val
        result[f"ageCurveLevel_{stat}_coverage"] = cov
    return result


def build_season_roster_minutes(games, player_stats_by_game):
    """(tcode, seasonCode) -> {pcode: 그 시즌 총 출전분} - 로스터 연속성 계산용."""
    out = {}
    for g in games:
        for side in ("home", "away"):
            tcode = g["homeTcode"] if side == "home" else g["awayTcode"]
            key = (tcode, g["seasonCode"])
            bucket = out.setdefault(key, {})
            for ps in player_stats_by_game.get(g["gmkey"], []):
                if ps["tcode"] != tcode:
                    continue
                bucket[ps["pcode"]] = bucket.get(ps["pcode"], 0.0) + ps["minutes"]
    return out


def roster_continuity(roster_minutes, season_roster_minutes, tcode, season_code, top_n=8):
    """직전 완결 시즌(season_code-2) 상위 top_n 로테이션 중, 이번 윈도우에도 남아있는 선수의
    비중(직전 시즌 출전시간으로 가중) - 낮을수록 핵심 로스터가 많이 바뀐 것(병역/트레이드/부상 등
    원인은 구분 안 되지만 "전력 변화가 있었다"는 신호 자체는 유효)."""
    prev = season_roster_minutes.get((tcode, season_code - 2))
    if not prev:
        return None
    top = sorted(prev.items(), key=lambda x: -x[1])[:top_n]
    total_prev = sum(m for _, m in top)
    if total_prev <= 0:
        return None
    retained = sum(m for pcode, m in top if pcode in roster_minutes)
    return round(retained / total_prev, 3)


def foreign_usage_concentration(roster_minutes, bio):
    """이 팀 로테이션(직전 ROLL_WINDOW경기 평균 출전분) 중 외국선수/아시아쿼터 선수들 사이에서,
    가장 많이 뛴 한 명이 그 그룹 전체 출전시간에서 차지하는 비율. 연봉 데이터가 없어서 쓰는
    대리지표 - "확실한 1옵을 만드는 팀"(비율 높음) vs "용병 두 명을 고르게 쓰는 팀"(비율 0.5대)
    구분을 실제 출전시간으로 직접 잼. 외국선수가 로스터 윈도우에 아예 없으면(결측/이례적) None."""
    foreign_mins = []
    for pcode, mins in roster_minutes.items():
        b = bio.get(pcode)
        if b and b.get("nationality") in FOREIGN_NATIONALITIES:
            foreign_mins.append(mins)
    if not foreign_mins:
        return None, 0
    total = sum(foreign_mins)
    if total <= 0:
        return None, len(foreign_mins)
    return round(max(foreign_mins) / total, 3), len(foreign_mins)


def build_team_timelines(games, run_vuln_per_game=None):
    """팀코드 -> 그 팀이 뛴 경기를 날짜순으로, 그 경기에서의 자기 팀 records와 승패 포함.
    restDays도 여기서 같이 계산(직전 자기 팀 경기 날짜와의 차이 - 1일, 첫 경기는 None).
    run_vuln_per_game이 있으면(build_run_vulnerability.py 출력) 그 경기에서 이 팀이 "내준" 8+런
    횟수/최대런도 같이 붙임 - Tier04 로드맵의 '런 취약성' 애블레이션용, leak-free 롤링피처 재료."""
    run_vuln_per_game = run_vuln_per_game or {}
    timelines = {}
    for g in games:
        home_won = 1 if g["homeRecord"]["score"] > g["awayRecord"]["score"] else 0
        rv = run_vuln_per_game.get(g["gmkey"], {})
        home_rv = rv.get(g["homeTcode"], {})
        away_rv = rv.get(g["awayTcode"], {})
        timelines.setdefault(g["homeTcode"], []).append(
            {"gameDate": g["gameDate"], "gmkey": g["gmkey"], "record": g["homeRecord"], "won": home_won,
             "bigRunsAllowed": home_rv.get("bigRunsAllowed"), "worstRunAllowed": home_rv.get("worstRunAllowed")})
        timelines.setdefault(g["awayTcode"], []).append(
            {"gameDate": g["gameDate"], "gmkey": g["gmkey"], "record": g["awayRecord"], "won": 1 - home_won,
             "bigRunsAllowed": away_rv.get("bigRunsAllowed"), "worstRunAllowed": away_rv.get("worstRunAllowed")})
    for t in timelines:
        timelines[t].sort(key=lambda x: (x["gameDate"], x["gmkey"]))
        prev_date = None
        for entry in timelines[t]:
            if prev_date is None:
                entry["restDays"] = None
            else:
                d0 = datetime.datetime.strptime(prev_date, "%Y%m%d")
                d1 = datetime.datetime.strptime(entry["gameDate"], "%Y%m%d")
                entry["restDays"] = (d1 - d0).days - 1
            prev_date = entry["gameDate"]
    return timelines


def build_coach_timelines(games):
    """감독명 -> [(gameDate, gmkey, outcome)] - 소속팀 안 가리고 감독 커리어 전체로 묶음."""
    timelines = {}
    for g in games:
        home_won = 1 if g["homeRecord"]["score"] > g["awayRecord"]["score"] else 0
        for mgr, outcome in ((g.get("homeManager"), home_won), (g.get("awayManager"), 1 - home_won)):
            if not mgr:
                continue
            timelines.setdefault(mgr, []).append({"gameDate": g["gameDate"], "gmkey": g["gmkey"], "outcome": outcome})
    for k in timelines:
        timelines[k].sort(key=lambda x: (x["gameDate"], x["gmkey"]))
    return timelines


def latest_manager_per_team(games):
    """tcode -> 가장 최근 경기에서 확인된 감독명 - 아직 안 열린 미래 경기는 meta.json이 없어서
    감독을 알 수 없으니, "감독 교체 없었다"고 가정하고 최근 값을 그대로 씀(predict_upcoming_games.py)."""
    latest = {}
    for g in games:  # games는 이미 날짜순 정렬돼있음(load_all_games)
        if g.get("homeManager"):
            latest[g["homeTcode"]] = g["homeManager"]
        if g.get("awayManager"):
            latest[g["awayTcode"]] = g["awayManager"]
    return latest


def latest_player_onoff(games, onoff_timeline):
    """pcode -> 그 선수의 가장 최근 경기 기준 온/오프코트 스냅샷. player_onoff_timeline.json은
    leak-free 학습용으로 gmkey별 '그 경기 이전까지'만 담고 있어서, 그중 시간순으로 제일 마지막
    항목이 곧 "지금 시점"의 최신 상태가 된다."""
    latest = {}
    for g in games:
        snap = onoff_timeline.get(g["gmkey"])
        if not snap:
            continue
        for pcode, v in snap.items():
            if v is not None:
                latest[pcode] = v
    return latest


def rolling_features(history_before):
    """이 경기 '이전'의 최근 ROLL_WINDOW경기만 사용 (호출부에서 이미 slice해서 넘김)."""
    window = history_before[-ROLL_WINDOW:]
    if len(window) < MIN_HISTORY:
        return None
    feats = {}
    for k in FEATURE_KEYS:
        vals = [g["record"].get(k) for g in window if g["record"].get(k) is not None]
        feats[k] = round(sum(vals) / len(vals), 2) if vals else None
    feats["winPctRecent"] = round(sum(g["won"] for g in window) / len(window), 3)
    feats["gamesInWindow"] = len(window)
    return feats


def run_vulnerability_features(window_entries):
    """직전 ROLL_WINDOW경기(호출부에서 이미 slice)에서 이 팀이 내준 8+런 횟수/최대런 평균 -
    Tier04 로드맵 '런 취약성 팀 프로필' 애블레이션용(tune_hyperparams.py에서 on/off 비교)."""
    vals_big = [e["bigRunsAllowed"] for e in window_entries if e.get("bigRunsAllowed") is not None]
    vals_worst = [e["worstRunAllowed"] for e in window_entries if e.get("worstRunAllowed") is not None]
    return {
        "runVulnBigRuns": round(sum(vals_big) / len(vals_big), 3) if vals_big else None,
        "runVulnWorstRun": round(sum(vals_worst) / len(vals_worst), 2) if vals_worst else None,
    }


def roster_window_minutes(window_entries, player_stats_by_game, tcode):
    """window_entries: 팀 timeline에서 뽑은 직전 ROLL_WINDOW경기. 그 경기들에서 이 팀 소속으로
    뛴 선수별 '평균' 출전분(경기수로 나눔 - 결장 경기는 0으로 취급됨)."""
    totals = {}
    n_games = len(window_entries)
    if n_games == 0:
        return {}
    for entry in window_entries:
        for ps in player_stats_by_game.get(entry["gmkey"], []):
            if ps["tcode"] != tcode:
                continue
            totals[ps["pcode"]] = totals.get(ps["pcode"], 0.0) + ps["minutes"]
    return {pcode: total / n_games for pcode, total in totals.items()}


# 엔트리에 있는데 최근 ROLL_WINDOW 경기 출전 기록이 없는 선수(신인/복귀/장기결장 복귀)에게
# 줄 최소 가중치. 0으로 두면 "명단에 있는데 없는 사람"이 되어 체격/시너지 가중평균의 분모가
# 그 선수만큼 비고, 그러면 결장자를 뺀 효과와 구분이 안 된다.
LINEUP_MIN_WEIGHT = 5.0
# 선발 5인 가산. "결장자 반영 중심"이라 선발 보정은 일부러 약하게 둔다 - 선발이 누구냐보다
# 누가 빠졌냐가 근거가 훨씬 확실한 신호이고, 이 모델은 애초에 라인업으로 학습된 적이 없다.
LINEUP_STARTER_BOOST = 1.3


def apply_lineup_to_roster(roster_minutes, dressed, starters):
    """과거 출전분 기반 로스터 가중치를, 그 경기 실제 12인 엔트리로 보정한다.

    KBL 규정상 12인(선발 5 + 벤치 7)을 경기 30분 전까지 제출한다. 그 명단이 나오면
    (a) 엔트리에 없는 선수 = 그날 결장 -> 가중치에서 제외, (b) 선발 5인 -> 소폭 가산.
    (a)가 이 보정의 핵심이다 - 주축이 빠진 걸 반영하는 건 근거가 확실한 반면, 선발이
    누구냐로 승률을 크게 흔드는 건 이 모델이 뒷받침하지 못한다.

    dressed/starters가 비면 원본을 그대로 돌려준다(라인업 미발표 시 기존 동작 유지).
    """
    if not dressed:
        return roster_minutes
    dressed, starters = set(dressed), set(starters or ())
    out = {p: m for p, m in roster_minutes.items() if p in dressed}
    for p in dressed:
        out.setdefault(p, LINEUP_MIN_WEIGHT)
    for p in starters:
        out[p] = out.get(p, LINEUP_MIN_WEIGHT) * LINEUP_STARTER_BOOST
    return out


def bio_synergy_features(roster_minutes, bio, onoff_snapshot, game_date, prefix):
    pairs_age, pairs_ht, pairs_wt, pairs_vert, pairs_wing, pairs_synergy = [], [], [], [], [], []
    # coverage를 "팀 로테이션 전체 출전시간 대비 값이 있는 비율"로 일관되게 재려면, 값이
    # 없는 선수도 (None, 출전시간)으로 반드시 넣어야 분모(weighted_avg의 총 weight)가 팀
    # 로테이션 전체가 됨 - 안 그러면 애초에 리스트에서 빠져서 분모 자체가 줄어 커버리지가
    # 부풀려 보인다.
    for pcode, mins in roster_minutes.items():
        b = bio.get(pcode)
        combine = b.get("combine") if b else None
        pairs_age.append((age_on(b.get("birthDate"), game_date) if b else None, mins))
        pairs_ht.append((b.get("heightCm") if b else None, mins))
        pairs_wt.append((b.get("weightKg") if b else None, mins))
        pairs_vert.append((combine.get("verticalJumpCm") if combine else None, mins))
        pairs_wing.append((combine.get("wingspanCm") if combine else None, mins))
        snap = onoff_snapshot.get(pcode) if onoff_snapshot else None
        pairs_synergy.append((snap["netRatingPer40"] if snap else None, mins))

    age_v, _ = weighted_avg(pairs_age)
    ht_v, _ = weighted_avg(pairs_ht)
    wt_v, _ = weighted_avg(pairs_wt)
    vert_v, vert_cov = weighted_avg(pairs_vert)
    wing_v, wing_cov = weighted_avg(pairs_wing)
    syn_v, syn_cov = weighted_avg(pairs_synergy)

    return {
        f"{prefix}_avgAge": age_v,
        f"{prefix}_avgHeightCm": ht_v,
        f"{prefix}_avgWeightKg": wt_v,
        f"{prefix}_avgVerticalJumpCm": vert_v,
        f"{prefix}_verticalJumpCoverage": vert_cov,
        f"{prefix}_avgWingspanCm": wing_v,
        f"{prefix}_wingspanCoverage": wing_cov,
        f"{prefix}_synergyOnOffRating": syn_v,
        f"{prefix}_synergyCoverage": syn_cov,
    }


def main():
    games = load_all_games()
    run_vuln_path = os.path.join(ANALYSIS_DIR, "run_vulnerability_per_game.json")
    run_vuln_per_game = {}
    if os.path.exists(run_vuln_path):
        with open(run_vuln_path, encoding="utf-8") as f:
            run_vuln_per_game = json.load(f)
    timelines = build_team_timelines(games, run_vuln_per_game)
    coach_timelines = build_coach_timelines(games)
    venue_timelines = build_venue_timelines(games)
    referee_timeline = build_cumulative_timeline(
        games, key_fn=lambda g: g.get("mainReferee"),
        outcome_fn=lambda g: 1 if g["homeRecord"]["score"] > g["awayRecord"]["score"] else 0)
    player_stats_by_game = load_player_stats_by_game()
    season_roster_minutes = build_season_roster_minutes(games, player_stats_by_game)

    with open(os.path.join(ANALYSIS_DIR, "player_bio.json"), encoding="utf-8") as f:
        bio = json.load(f)
    with open(os.path.join(ANALYSIS_DIR, "player_onoff_timeline.json"), encoding="utf-8") as f:
        onoff_timeline = json.load(f)  # gmkey -> {pcode: {netRatingPer40, secondsSoFar} | null}
    age_curves = load_age_curves()

    rows = []
    for g in games:
        home_hist = timelines[g["homeTcode"]]
        away_hist = timelines[g["awayTcode"]]
        # 이 gmkey가 timeline에서 몇 번째인지 찾아서 그 이전까지만 사용
        home_idx = next(i for i, x in enumerate(home_hist) if x["gmkey"] == g["gmkey"])
        away_idx = next(i for i, x in enumerate(away_hist) if x["gmkey"] == g["gmkey"])
        home_window = home_hist[:home_idx][-ROLL_WINDOW:]
        away_window = away_hist[:away_idx][-ROLL_WINDOW:]
        home_feats = rolling_features(home_hist[:home_idx])
        away_feats = rolling_features(away_hist[:away_idx])
        if home_feats is None or away_feats is None:
            continue

        onoff_snapshot = onoff_timeline.get(g["gmkey"], {})
        home_roster = roster_window_minutes(home_window, player_stats_by_game, g["homeTcode"])
        away_roster = roster_window_minutes(away_window, player_stats_by_game, g["awayTcode"])
        home_bs = bio_synergy_features(home_roster, bio, onoff_snapshot, g["gameDate"], "home")
        away_bs = bio_synergy_features(away_roster, bio, onoff_snapshot, g["gameDate"], "away")

        home_form = {f"home_{k}": v for k, v in multi_window_form(home_hist[:home_idx]).items()}
        away_form = {f"away_{k}": v for k, v in multi_window_form(away_hist[:away_idx]).items()}

        home_venue_key = (g["homeTcode"], g["stadium"])
        away_venue_key = (g["awayTcode"], g["stadium"])
        home_venue_rating = venue_rating_before(venue_timelines.get(home_venue_key, []), g["gmkey"])
        away_venue_rating = venue_rating_before(venue_timelines.get(away_venue_key, []), g["gmkey"])

        home_coach_rate = cumulative_rate_before(coach_timelines.get(g.get("homeManager"), []), g["gmkey"])
        away_coach_rate = cumulative_rate_before(coach_timelines.get(g.get("awayManager"), []), g["gmkey"])
        ref_home_win_rate = cumulative_rate_before(referee_timeline.get(g.get("mainReferee"), []), g["gmkey"])

        home_foreign_conc, home_foreign_n = foreign_usage_concentration(home_roster, bio)
        away_foreign_conc, away_foreign_n = foreign_usage_concentration(away_roster, bio)

        home_age_curve = age_curve_team_feature(home_roster, bio, age_curves, g["gameDate"])
        away_age_curve = age_curve_team_feature(away_roster, bio, age_curves, g["gameDate"])

        home_continuity = roster_continuity(home_roster, season_roster_minutes, g["homeTcode"], g["seasonCode"])
        away_continuity = roster_continuity(away_roster, season_roster_minutes, g["awayTcode"], g["seasonCode"])

        home_run_vuln = run_vulnerability_features(home_window)
        away_run_vuln = run_vulnerability_features(away_window)

        ctx = date_context_features(g["gameDate"])

        home_won = 1 if g["homeRecord"]["score"] > g["awayRecord"]["score"] else 0
        rows.append({
            "gmkey": g["gmkey"],
            "gameDate": g["gameDate"],
            "seasonCode": g["seasonCode"],
            "homeTcode": g["homeTcode"],
            "awayTcode": g["awayTcode"],
            "dayOfWeek": ctx["dayOfWeek"],
            "month": ctx["month"],
            "refHomeWinRate": ref_home_win_rate,  # 특정 팀 아닌 그 경기 전체 컨텍스트
            "home": {
                **{f"home_{k}": v for k, v in home_feats.items()}, **home_bs, **home_form,
                **{f"home_{k}": v for k, v in home_age_curve.items()},
                "home_restDays": home_hist[home_idx]["restDays"],
                "home_venueNetRtg": home_venue_rating,
                "home_coachWinPct": home_coach_rate,
                "home_foreignConcentration": home_foreign_conc,
                "home_foreignPlayerCount": home_foreign_n,
                "home_rosterContinuity": home_continuity,
                "home_runVulnBigRuns": home_run_vuln["runVulnBigRuns"],
                "home_runVulnWorstRun": home_run_vuln["runVulnWorstRun"],
            },
            "away": {
                **{f"away_{k}": v for k, v in away_feats.items()}, **away_bs, **away_form,
                **{f"away_{k}": v for k, v in away_age_curve.items()},
                "away_restDays": away_hist[away_idx]["restDays"],
                "away_venueNetRtg": away_venue_rating,
                "away_coachWinPct": away_coach_rate,
                "away_foreignConcentration": away_foreign_conc,
                "away_foreignPlayerCount": away_foreign_n,
                "away_rosterContinuity": away_continuity,
                "away_runVulnBigRuns": away_run_vuln["runVulnBigRuns"],
                "away_runVulnWorstRun": away_run_vuln["runVulnWorstRun"],
            },
            "homeWon": home_won,
        })

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    print(f"학습 테이블 {len(rows)}행 (전체 {len(games)}경기 중 직전 {MIN_HISTORY}경기 미만 워밍업 구간 제외) -> {OUT_PATH}", flush=True)
    if rows:
        home_win_rate = sum(r["homeWon"] for r in rows) / len(rows)
        print(f"홈팀 승률(베이스레이트): {home_win_rate:.3f}  <- 이걸 못 이기면 모델 의미없음", flush=True)
        syn_cov = sum(r["home"]["home_synergyCoverage"] or 0 for r in rows) / len(rows)
        vert_cov = sum(r["home"]["home_verticalJumpCoverage"] or 0 for r in rows) / len(rows)
        print(f"평균 시너지 커버리지: {syn_cov:.2f}, 평균 버티컬점프 커버리지: {vert_cov:.2f} (팀 로테이션 출전시간 기준 가중)", flush=True)
        coach_cov = sum(1 for r in rows if r["home"]["home_coachWinPct"] is not None) / len(rows)
        venue_cov = sum(1 for r in rows if r["home"]["home_venueNetRtg"] is not None) / len(rows)
        ref_cov = sum(1 for r in rows if r["refHomeWinRate"] is not None) / len(rows)
        foreign_cov = sum(1 for r in rows if r["home"]["home_foreignConcentration"] is not None) / len(rows)
        print(f"커버리지 - 감독: {coach_cov:.2f}, 구장: {venue_cov:.2f}, 심판: {ref_cov:.2f}, "
              f"용병집중도: {foreign_cov:.2f}", flush=True)
        for stat in AGE_CURVE_STATS:
            cov = sum(r["home"].get(f"home_ageCurveLevel_{stat}_coverage") or 0 for r in rows) / len(rows)
            print(f"나이곡선({stat}) 커버리지: {cov:.2f}", flush=True)
        cont_cov = sum(1 for r in rows if r["home"]["home_rosterContinuity"] is not None) / len(rows)
        cont_avg = sum(r["home"]["home_rosterContinuity"] for r in rows if r["home"]["home_rosterContinuity"] is not None) / max(1, sum(1 for r in rows if r["home"]["home_rosterContinuity"] is not None))
        print(f"로스터 연속성 커버리지: {cont_cov:.2f}, 평균값: {cont_avg:.2f}", flush=True)
        rv_cov = sum(1 for r in rows if r["home"]["home_runVulnBigRuns"] is not None) / len(rows)
        print(f"런 취약성 커버리지: {rv_cov:.2f}", flush=True)


if __name__ == "__main__":
    main()
