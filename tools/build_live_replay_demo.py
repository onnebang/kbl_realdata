"""
라이브 화면 프로토타입용 리플레이 데이터 (2026-08-24 시작, 여러 차례 확장).

실제 라이브 경기가 없는 지금은, 이미 검증된 라이브 모델 + WPA 로직(build_wpa.py와 동일 방식)을
완결된 과거 경기에 그대로 돌려서 "이 경기가 실시간으로 중계됐다면 화면이 이렇게 움직였을 것"을
재현한다. 데이터 소스만 "문자중계 로그 재생"에서 "실시간 폴링"으로 바꾸면 그대로 진짜 라이브에
쓸 수 있는 구조.

**2026-08-24 최종 확장(사용자 요청 - "동부/모비스 경기만 있는데 샘플 10경기 정도 더")**: 1경기
전용 스크립트를 10경기 배치로 일반화. 4207경기를 매 게임마다 다시 스캔하면 느려서(historical_rarity의
마진 분포, wpa_biggest_plays 랭킹용 리스트) 딱 한 번만 계산해서 모든 게임이 재사용하도록 캐싱.

선정한 10경기 - wpa_biggest_plays.json 상위권(극적인 버저비터 위주) + 블로아웃 2개 + 여러 시즌
(2014~2026)에 걸쳐 다양성 확보:
"""
import json
import math
import os
from collections import defaultdict

import joblib
import numpy as np

from build_live_winprob_data import SCORE_CODES, cumulative_elapsed, load_pregame_context

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
MODEL_PATH = os.path.join(ANALYSIS_DIR, "live_winprob_model.joblib")
OUT_PATH = os.path.join(ANALYSIS_DIR, "live_replay_demo.json")

DEMO_GMKEYS = [
    "S23G01N209",  # 2014-02-06 원주동부 61:58 울산모비스 - 버저비터, 기존 플래그십 데모
    "S43G01N51",   # 2023-11-18 연장 버저비터
    "S47G01N97",   # 2025-12-11 Q4 버저비터 (최신 시즌)
    "S25G01N96",   # 2014-11-28 Q4 버저비터
    "S33G01N243",  # 2019-03-07 Q4 버저비터
    "S45G01N18",   # 2024-10-27 연장 버저비터
    "S37G01N177",  # 2021-02-02 Q4 버저비터
    "S47G01N174",  # 2026-01-27 블로아웃(45점차, 최신 시즌)
    "S43G01N16",   # 2023-10-29 Q4 버저비터
    "S45G01N42",   # 2024-11-09 블로아웃(43점차)
]

TEAM_META = {
    "06": {"abbr": "KT", "color": "#1A1A1A", "name": "수원 KT"},
    "10": {"abbr": "MOB", "color": "#A6192E", "name": "울산 현대모비스"},
    "16": {"abbr": "DB", "color": "#1C8A43", "name": "원주 DB"},
    "30": {"abbr": "GOY", "color": "#1E2749", "name": "고양 오리온스"},
    "35": {"abbr": "SAM", "color": "#1428A0", "name": "서울 삼성"},
    "55": {"abbr": "SK", "color": "#E4002B", "name": "서울 SK"},
    "60": {"abbr": "KCC", "color": "#0C2340", "name": "전주 KCC"},
    "64": {"abbr": "GAS", "color": "#0072CE", "name": "대구 한국가스공사"},
    "65": {"abbr": "EL", "color": "#0060AF", "name": "인천 전자랜드"},
    "66": {"abbr": "SONO", "color": "#3FA9F5", "name": "고양 소노"},
    "70": {"abbr": "KGC", "color": "#C8102E", "name": "안양 정관장"},
    "50": {"abbr": "LG", "color": "#8E1B3D", "name": "창원 LG"},
    "73": {"abbr": "CRT", "color": "#FF6B00", "name": "고양 캐롯"},
}
DEFAULT_TEAM_META = {"abbr": "?", "color": "#5b5f6e", "name": "?"}


def team_meta(tcode):
    # 2026-08-25 확장 때 사용자가 "모비스가 파란색으로 나온다"고 지적 - 확인해보니 원래
    # 값들이 실제 구단 컬러와 다른 "일반적으로 알려진 팀 이미지에 맞춘 근사값"이었음(아래
    # 팀컬러 검색으로 재확인: 검정 KT / 빨강 SK·정관장·모비스 / 파랑 삼성·가스공사 / 남색
    # KCC / 적갈색 LG / 하늘색 소노 / 초록 DB). SK·정관장·모비스처럼 같은 "빨강" 계열
    # 3팀이 실제로 존재하므로, 이 색상이 겹칠 때는 courtside_template.html의
    # color-clash 로직(해치 패턴)이 구분을 맡음 - 여기서 억지로 색상을 벌릴 필요는 없음.
    return TEAM_META.get(tcode, DEFAULT_TEAM_META)


ACTION_LABELS = {
    "001": "경기 시작", "002": "경기 중단", "003": "작전타임", "009": "경기 종료",
    "101": "교체 IN", "102": "교체 OUT",
    "201": "2점슛 성공", "202": "2점슛 실패", "203": "자유투 성공", "204": "자유투 실패",
    "205": "3점슛 성공", "206": "3점슛 실패", "207": "덩크슛 성공", "208": "덩크슛 실패",
    "209": "공격리바운드", "210": "수비리바운드", "211": "어시스트", "212": "스틸",
    "213": "블록", "214": "턴오버", "215": "파울자유투", "216": "파울",
    "217": "팀속공", "218": "팀리바운드", "221": "굿디펜스", "223": "팀턴오버",
    "224": "기타파울", "225": "팀파울", "226": "스크린 어시스트", "227": "디플렉션",
    "228": "비디오판독", "229": "코치 챌린지",
}


def scaled_score_diff(score_diff, remaining_sec):
    return score_diff / math.sqrt(remaining_sec + 30)


def build_roster_lookup(gmkey, home_tcode, away_tcode):
    """(팀,이름)->pcode 매핑 + 시작 라인업(pcode set) + pcode->{name,tcode}."""
    pstat_path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
    with open(pstat_path, encoding="utf-8") as f:
        rows = json.load(f)
    name_to_pcode = {}
    player_info = {}
    starters = {home_tcode: [], away_tcode: []}
    for row in rows:
        p = row["player"]
        name_to_pcode[(p["tcode"], p["pname"])] = p["pcode"]
        player_info[p["pcode"]] = {"name": p["pname"], "tcode": p["tcode"], "pos": p.get("pos"), "backNum": p.get("backNum"),
                                    "isStarter": row.get("startFlag") == 1}
        if row.get("startFlag") == 1:
            starters[p["tcode"]].append(p["pcode"])
    return name_to_pcode, player_info, starters


def load_combo_subset(all_pcodes, combo_cache):
    def key(pcodes):
        return "_".join(sorted(pcodes))

    result = {}
    for n in (2, 3, 4, 5):
        subset = {}
        for row in combo_cache[n]:
            if all(p in all_pcodes for p in row["pcodes"]):
                subset[key(row["pcodes"])] = {"netRatingPer40": row["netRatingPer40"], "minutes": row["minutes"], "stints": row["stints"]}
        result[n] = subset
    return result


def load_onoff_subset(all_pcodes, onoff_cache):
    return {pcode: v for pcode, v in onoff_cache.items() if pcode in all_pcodes}


def load_shot_chart(gmkey):
    """match-chart.json의 shootLog는 pcode를 이미 갖고 있어서(문자중계와 달리 이름 조인 불필요)
    그대로 pcode별로 묶기만 하면 됨."""
    path = os.path.join(GAMES_DIR, gmkey, "match-chart.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        chart = json.load(f)
    out = {}
    for player in chart.get("shootLog", []):
        out[player["pcode"]] = [
            {"x": log["x"], "y": log["y"], "o": log["o"], "d": log["d"], "q": log["q"]}
            for log in player["logs"]
        ]
    return out


def load_pregame_detail(gmkey, pregame_rows_by_gmkey, team_timelines, h2h, starters, combos5, standings, season_name):
    """이 경기의 pregame_training_table.json 행에서 "왜 이 팀이 약체/강체로 평가되는가"를
    설명하는 필드를 골라 임베드 + 직전 10경기 넷레이팅 개별값(트렌드 라인 차트용, 팀-시즌
    타임라인에서 이 경기 이전 최대 10개를 그대로 추출 - 새 계산 아니라 team_timelines 재사용).

    2026-08-25 확장(사용자 요청 - "여러가지를 조합했으면") 3가지 추가:
    - last5_winPct: last5_netrtg는 이미 있었는데 승률 쪽은 안 뽑고 있었음(모델 피처엔 이미 존재).
    - startingLineupNetrtg: combo_5man.json에서 "이 경기 실제 선발 5인" 조합과 정확히 일치하는
      행을 찾음(임의 5인 조합이 아니라 진짜 선발 라인업 궁합). 그 정확한 조합이 시즌 내내
      180초 미만만 같이 뛰었으면 데이터가 없을 수 있음(null로 정직하게 표시).
    - h2h: 두 팀의 과거 맞대결 전적 - 이 경기 이전 것만(leak-free), h2h는 이미 날짜순 정렬된
      리스트라 이 gmkey 위치 이전 것만 세면 됨."""
    row = pregame_rows_by_gmkey.get(gmkey)
    if row is None:
        return None
    keys = ["offrtg", "defrtg", "netrtg", "winPctRecent", "last10_winPct", "last5_netrtg", "last5_winPct",
            "synergyOnOffRating", "restDays", "coachWinPct"]
    home_tcode, away_tcode = row["homeTcode"], row["awayTcode"]

    def recent_trend(tcode):
        hist = team_timelines.get(tcode, [])
        idx = next((i for i, x in enumerate(hist) if x["gmkey"] == gmkey), None)
        if idx is None:
            return []
        window = hist[max(0, idx - 10):idx]
        return [x["netrtg"] for x in window if x["netrtg"] is not None]

    def starting_lineup_netrtg(tcode):
        five = sorted(starters.get(tcode, []))
        if len(five) != 5:
            return None
        combo = combos5.get("_".join(five))
        return combo["netRatingPer40"] if combo else None

    pair_games = h2h.get(frozenset((home_tcode, away_tcode)), [])
    idx = next((i for i, rec in enumerate(pair_games) if rec[0] == gmkey), len(pair_games))
    prior_meetings = pair_games[:idx]
    home_h2h_wins = sum(1 for rec in prior_meetings if rec[6] == home_tcode)
    # 최근 5경기만 - "맞대결 기록" 리스트용(ESPN Matchups 탭처럼 개별 경기 스코어 나열)
    recent_meetings = [
        {"gameDate": gd, "homeTcode": ht, "awayTcode": at, "homeScore": hs, "awayScore": as_}
        for (gk, gd, ht, at, hs, as_, w) in prior_meetings[-5:]
    ]
    h2h_info = {
        "meetings": len(prior_meetings),
        "homeWins": home_h2h_wins,
        "awayWins": len(prior_meetings) - home_h2h_wins,
        "recentMeetings": recent_meetings,
    }

    # 리그 테이블 - 이 경기 시점 기준 리크프리 스탠딩(정규시즌만). 이 경기에 직접 참여 안 하는
    # 다른 팀들은 "이 경기 날짜 이전"의 가장 최근 스냅샷을 찾아야 함(그냥 시즌 마지막 스냅샷을
    # 쓰면 미래 결과가 새는 리크가 됨) - 그래서 gameDate로 직접 필터링.
    this_game_date = row.get("gameDate", "")
    season_standings = standings.get(season_name, {})
    table = []
    for tcode, snapshots in season_standings.items():
        eligible = [s for s in snapshots if s["gameDate"] <= this_game_date]
        if not eligible:
            continue
        snap = eligible[-1]
        w, l = snap["wins"], snap["losses"]
        gp = w + l
        table.append({"tcode": tcode, "wins": w, "losses": l, "pct": round(w / gp, 3) if gp else 0.0})
    table.sort(key=lambda r: -r["pct"])

    return {
        "home": {**{k: row["home"].get(f"home_{k}") for k in keys}, "recentTrend": recent_trend(home_tcode),
                 "startingLineupNetrtg": starting_lineup_netrtg(home_tcode)},
        "away": {**{k: row["away"].get(f"away_{k}") for k in keys}, "recentTrend": recent_trend(away_tcode),
                 "startingLineupNetrtg": starting_lineup_netrtg(away_tcode)},
        "h2h": h2h_info,
        "standings": table,
        "standingsSeason": season_name,
    }


def build_team_timelines_for_trend():
    """team_timelines: tcode -> [{gmkey, netrtg}] 날짜순 - export_training_table.py와 같은 패턴을
    가볍게 재구현(여기선 폼 트렌드 라인차트용 netrtg 하나만 있으면 됨).

    2026-08-25 확장(사용자 요청 - "상대기준 승률" + "맞대결 기록 추가" + "리그 테이블 추가"):
    같은 단일 스캔에서 3가지를 더 뽑아냄(전체 디렉토리를 또 스캔하지 않고 이 함수가 이미
    열어보는 meta.json/team-record.json을 재사용):
    - h2h: frozenset({tcodeA,tcodeB}) -> [(gmkey, gameDate, homeTcode, awayTcode, homeScore,
      awayScore, winnerTcode), ...] 날짜순 - "맞대결 기록"의 개별 경기 리스트용.
    - standings: seasonName -> tcode -> [{gmkey, wins, losses}] 날짜순 - "리그 테이블"용,
      이 경기 시점 기준 리크프리 스탠딩(그 경기 포함 이전까지 누적)."""
    timelines = defaultdict(list)
    h2h = defaultdict(list)
    standings = defaultdict(lambda: defaultdict(list))
    season_wl = defaultdict(lambda: defaultdict(lambda: [0, 0]))  # seasonName -> tcode -> [wins, losses]
    games = []
    for gk in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gk, "meta.json")
        tr_path = os.path.join(GAMES_DIR, gk, "team-record.json")
        if not (os.path.exists(meta_path) and os.path.exists(tr_path)):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        with open(tr_path, encoding="utf-8") as f:
            tr = json.load(f)
        by_tcode = {r["tcode"]: r["records"] for r in tr}
        g = meta["game"]
        is_regular = g.get("seasonCategoryName") == "정규시즌"
        games.append((g.get("gameDate"), gk, g.get("tcodeH"), g.get("tcodeA"), by_tcode,
                      g.get("seasonName"), is_regular))
    games.sort(key=lambda x: (x[0], x[1]))
    for gameDate, gk, home_tcode, away_tcode, by_tcode, season_name, is_regular in games:
        for tcode in (home_tcode, away_tcode):
            rec = by_tcode.get(tcode, {})
            timelines[tcode].append({"gmkey": gk, "netrtg": rec.get("netrtg")})
        h_score = by_tcode.get(home_tcode, {}).get("score")
        a_score = by_tcode.get(away_tcode, {}).get("score")
        if home_tcode and away_tcode and h_score is not None and a_score is not None and h_score != a_score:
            winner = home_tcode if h_score > a_score else away_tcode
            h2h[frozenset((home_tcode, away_tcode))].append(
                (gk, gameDate, home_tcode, away_tcode, h_score, a_score, winner))

            if is_regular and season_name:
                for tcode in (home_tcode, away_tcode):
                    wl = season_wl[season_name][tcode]
                    standings[season_name][tcode].append({"gmkey": gk, "gameDate": gameDate, "wins": wl[0], "losses": wl[1]})
                    if tcode == winner:
                        wl[0] += 1
                    else:
                        wl[1] += 1
    return timelines, h2h, standings


def build_historical_reference():
    """전체 4207경기를 스캔해야 하는 것들(마진 분포)을 딱 한 번만 계산해서 캐싱 - 10경기가
    전부 재사용."""
    margins = []
    for gk in sorted(os.listdir(GAMES_DIR)):
        tr_path = os.path.join(GAMES_DIR, gk, "team-record.json")
        if not os.path.exists(tr_path):
            continue
        with open(tr_path, encoding="utf-8") as f:
            tr = json.load(f)
        scores = [row["records"].get("score") for row in tr if row["records"].get("score") is not None]
        if len(scores) == 2 and scores[0] != scores[1]:
            margins.append(abs(scores[0] - scores[1]))

    wpa_path = os.path.join(ANALYSIS_DIR, "wpa_biggest_plays.json")
    biggest_plays = []
    if os.path.exists(wpa_path):
        with open(wpa_path, encoding="utf-8") as f:
            biggest_plays = json.load(f)

    return {"margins": margins, "biggestPlays": biggest_plays}


def historical_rarity(final_home, final_away, biggest_wpa_abs, ref):
    margins = ref["margins"]
    this_margin = abs(final_home - final_away)
    n_total = len(margins)
    n_closer_or_equal = sum(1 for m in margins if m <= this_margin)
    margin_percentile = round(n_closer_or_equal / n_total, 4) if n_total else None

    biggest_plays = ref["biggestPlays"]
    wpa_total = len(biggest_plays)
    wpa_rank = None
    for i, p in enumerate(biggest_plays):
        if abs(p["teamWpa"]) <= biggest_wpa_abs:
            wpa_rank = i + 1
            break
    if wpa_rank is None and wpa_total:
        wpa_rank = wpa_total + 1

    return {
        "marginTotalGames": n_total,
        "marginPercentile": margin_percentile,
        "wpaSwingRank": wpa_rank,
        "wpaSwingSampleSize": wpa_total,
    }


def build_one_game(gmkey, model, pregame_ctx, pregame_rows_by_gmkey, team_timelines, combo_cache, onoff_cache, hist_ref, h2h, standings):
    ctx = pregame_ctx.get(gmkey)
    if ctx is None:
        print(f"  [건너뜀] {gmkey} - pregame_training_table.json에 없음(워밍업 구간 등)", flush=True)
        return None

    meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)
    g = meta["game"]
    home_tcode, away_tcode = g["tcodeH"], g["tcodeA"]
    home_tname, away_tname = g["tnameH"], g["tnameA"]

    text_path = os.path.join(GAMES_DIR, gmkey, "text-cast.json")
    with open(text_path, encoding="utf-8") as f:
        events = json.load(f)

    name_to_pcode, player_info, starters = build_roster_lookup(gmkey, home_tcode, away_tcode)
    lineup = {home_tcode: list(starters[home_tcode]), away_tcode: list(starters[away_tcode])}

    total_elapsed = cumulative_elapsed(events[-1]["q"], events[-1]["m"], events[-1]["s"])
    net = ctx["netrtgDiff"] if ctx["netrtgDiff"] is not None else 0.0
    syn = ctx["synergyDiff"] if ctx["synergyDiff"] is not None else 0.0

    def feat_row(score_diff, remaining_sec):
        return [score_diff, remaining_sec, scaled_score_diff(score_diff, remaining_sec), net, syn]

    pregame_row = feat_row(0, total_elapsed)
    neutral_rows = [[0, total_elapsed, scaled_score_diff(0, total_elapsed), 0.0, 0.0]]

    home_score, away_score = 0, 0
    run_pts = {home_tcode: 0, away_tcode: 0}
    last_score_elapsed = {home_tcode: 0, away_tcode: 0}

    rows = [pregame_row]
    meta_rows = [{
        "q": "PRE", "m": None, "s": None, "action": None, "actionLabel": "경기 시작 전 예측",
        "player": None, "team": None, "homeScore": 0, "awayScore": 0,
        "homeLineup": list(lineup[home_tcode]), "awayLineup": list(lineup[away_tcode]),
        "runHome": 0, "runAway": 0, "droughtHomeSec": 0, "droughtAwaySec": 0,
    }]

    for evt in events:
        code = evt.get("a")
        team = evt.get("t")
        player = evt.get("p")
        elapsed = cumulative_elapsed(evt["q"], evt["m"], evt["s"])

        if code == "101" and team in lineup and player:
            pcode = name_to_pcode.get((team, player))
            if pcode and pcode not in lineup[team]:
                lineup[team].append(pcode)
        elif code == "102" and team in lineup and player:
            pcode = name_to_pcode.get((team, player))
            if pcode and pcode in lineup[team]:
                lineup[team].remove(pcode)

        if code in SCORE_CODES and team in (home_tcode, away_tcode):
            pts = SCORE_CODES[code]
            other = away_tcode if team == home_tcode else home_tcode
            if team == home_tcode:
                home_score += pts
            else:
                away_score += pts
            run_pts[team] += pts
            run_pts[other] = 0
            last_score_elapsed[team] = elapsed

        remaining = total_elapsed - elapsed
        score_diff = home_score - away_score
        rows.append(feat_row(score_diff, remaining))
        neutral_rows.append([score_diff, remaining, scaled_score_diff(score_diff, remaining), 0.0, 0.0])
        meta_rows.append({
            "q": evt["q"], "m": evt["m"], "s": evt["s"], "action": code,
            "actionLabel": ACTION_LABELS.get(code, code), "player": player,
            "pcode": name_to_pcode.get((team, player)) if player and team else None, "team": team,
            "homeScore": home_score, "awayScore": away_score,
            "homeLineup": list(lineup[home_tcode]), "awayLineup": list(lineup[away_tcode]),
            "runHome": run_pts[home_tcode], "runAway": run_pts[away_tcode],
            "droughtHomeSec": elapsed - last_score_elapsed[home_tcode],
            "droughtAwaySec": elapsed - last_score_elapsed[away_tcode],
        })

    X = np.array(rows, dtype=float)
    X_neutral = np.array(neutral_rows, dtype=float)
    probs = model.predict_proba(X)[:, 1]
    probs_neutral = model.predict_proba(X_neutral)[:, 1]

    timeline = []
    for i, mr in enumerate(meta_rows):
        prob_home = float(probs[i])
        wpa_home = None if i == 0 else round(prob_home - float(probs[i - 1]), 4)
        timeline.append({
            **mr, "homeProb": round(prob_home, 4), "wpaHome": wpa_home,
            "objectiveProb": round(float(probs_neutral[i]), 4),
        })

    final_home, final_away = meta_rows[-1]["homeScore"], meta_rows[-1]["awayScore"]
    biggest = max(timeline[1:], key=lambda r: abs(r["wpaHome"]))

    all_pcodes = set(player_info.keys())
    combos_by_n = load_combo_subset(all_pcodes, combo_cache)
    onoff = load_onoff_subset(all_pcodes, onoff_cache)
    rarity = historical_rarity(final_home, final_away, abs(biggest["wpaHome"]), hist_ref)
    shot_chart = load_shot_chart(gmkey)
    pregame_detail = load_pregame_detail(gmkey, pregame_rows_by_gmkey, team_timelines, h2h, starters, combos_by_n[5],
                                          standings, g.get("seasonName"))

    print(f"  {gmkey}: {home_tname} {final_home}:{final_away} {away_tname} "
          f"(최대스윙 {biggest['wpaHome']:+.3f}, 통산 {rarity['wpaSwingRank']}위)", flush=True)

    return {
        "gmkey": gmkey, "gameDate": g.get("gameDate"),
        "homeTname": home_tname, "awayTname": away_tname,
        "homeTcode": home_tcode, "awayTcode": away_tcode,
        "homeAbbr": team_meta(home_tcode)["abbr"], "awayAbbr": team_meta(away_tcode)["abbr"],
        "homeColor": team_meta(home_tcode)["color"], "awayColor": team_meta(away_tcode)["color"],
        "finalHome": final_home, "finalAway": final_away,
        "homeWon": final_home > final_away,
        "players": player_info,
        "onoff": onoff,
        "combos2": combos_by_n[2], "combos3": combos_by_n[3],
        "combos4": combos_by_n[4], "combos5": combos_by_n[5],
        "rarity": rarity,
        "pregameNetrtgDiff": round(net, 2), "pregameSynergyDiff": round(syn, 2),
        "pregameDetail": pregame_detail,
        "shotChart": shot_chart,
        "timeline": timeline,
    }


def main():
    print("모델/캐시 로딩...", flush=True)
    model = joblib.load(MODEL_PATH)
    pregame_ctx = load_pregame_context()

    with open(os.path.join(ANALYSIS_DIR, "pregame_training_table.json"), encoding="utf-8") as f:
        pregame_rows_by_gmkey = {r["gmkey"]: r for r in json.load(f)}

    combo_cache = {}
    for n in (2, 3, 4, 5):
        with open(os.path.join(ANALYSIS_DIR, f"combo_{n}man.json"), encoding="utf-8") as f:
            combo_cache[n] = json.load(f)

    with open(os.path.join(ANALYSIS_DIR, "player_onoff.json"), encoding="utf-8") as f:
        onoff_cache = {row["pcode"]: {"netRatingPer40": row["netRatingPer40"], "minutes": row["minutes"]} for row in json.load(f)}

    print("팀 넷레이팅 타임라인(폼 트렌드용) + 팀간 맞대결 전적 + 시즌 스탠딩 구성 중...", flush=True)
    team_timelines, h2h, standings = build_team_timelines_for_trend()

    print("전체 4207경기 히스토리 참조 캐시(마진분포/WPA랭킹) 구성 중...", flush=True)
    hist_ref = build_historical_reference()

    print(f"\n{len(DEMO_GMKEYS)}경기 리플레이 데이터 생성...", flush=True)
    games = {}
    game_list = []
    for gmkey in DEMO_GMKEYS:
        result = build_one_game(gmkey, model, pregame_ctx, pregame_rows_by_gmkey, team_timelines, combo_cache, onoff_cache, hist_ref, h2h, standings)
        if result is None:
            continue
        games[gmkey] = result
        game_list.append({
            "gmkey": gmkey, "gameDate": result["gameDate"],
            "homeTname": result["homeTname"], "awayTname": result["awayTname"],
            "finalHome": result["finalHome"], "finalAway": result["finalAway"],
            "wpaSwingRank": result["rarity"]["wpaSwingRank"],
        })

    # 리그 순위 테이블용 - 이 경기 두 팀만이 아니라 리그 전체 팀 이름/컬러/약칭이 필요해서
    # 게임별이 아니라 최상위에 한 번만 넣음(로고는 embed_team_logos.py가 나중에 채워줌).
    team_meta_out = {tcode: {**meta, "logo": None} for tcode, meta in TEAM_META.items()}

    # "구역 지배력"용 리그 평균 - xpts_zone_table.json(build_xpts_shot_quality.py 산출물,
    # 15시즌 전체 fgPct)을 게임별 중복 없이 최상위에 한 번만.
    with open(os.path.join(ANALYSIS_DIR, "xpts_zone_table.json"), encoding="utf-8") as f:
        zone_table = json.load(f)
    league_zone_fg_pct = {z: round(v["fgPct"], 4) for z, v in zone_table.items()}

    out = {"gameList": game_list, "games": games, "teamMeta": team_meta_out, "leagueZoneFgPct": league_zone_fg_pct}
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    size_mb = os.path.getsize(OUT_PATH) / (1024 * 1024)
    print(f"\n총 {len(games)}경기 -> {OUT_PATH} ({size_mb:.1f}MB)", flush=True)


if __name__ == "__main__":
    main()
