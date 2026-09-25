"""
예정된(아직 안 열린) 경기의 승률 예측 (2026-08-24) - 지금까지 파이프라인 전체가 "이미 끝난
경기"만 다뤘는데(학습/평가/모든 통계), 실제로 쓸모있으려면 "아직 안 열린 경기"에 대한 예측이
나와야 함. export_training_table.py의 leak-free 피처 빌더들을 그대로 재사용하되, 딱 하나
다른 점: 기존엔 "그 경기 gmkey 이전까지"를 잘랐다면, 여긴 애초에 그 경기가 timeline에 없으니
그냥 "지금까지 전체"를 그대로 쓰면 됨(어차피 오늘 이후로는 아무 데이터도 없어서 자동으로
leak-free).

- 감독: 예정 경기엔 meta.json이 없어서(아직 안 열림) 감독을 알 수 없음 - "감독 교체 없었다"고
  가정하고 각 팀의 가장 최근 경기 감독을 그대로 씀(latest_manager_per_team).
- 심판: 사전에 배정 안 나오는 정보라 그냥 None(모델이 결측치로 처리).
- 구장: match/list 스케줄 응답에 이미 stadiumname이 있어서 그대로 씀.
- 휴식일수: 그 팀의 가장 최근 경기 날짜와 이 경기 날짜의 차이로 직접 계산.
"""
import datetime
import json
import os

import joblib
import numpy as np

import export_training_table as ett
import fetch_kbl_data as fkd

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
MODEL_PATH = os.path.join(ANALYSIS_DIR, "pregame_model.joblib")
OUT_PATH = os.path.join(ANALYSIS_DIR, "upcoming_predictions.json")
LOOKAHEAD_DAYS = 3


def team_features_now(tcode, prefix, ctx, today_str, lineup=None):
    hist = ctx["timelines"].get(tcode, [])
    feats = ett.rolling_features(hist)
    if feats is None:
        return None  # 그 팀 경기 표본이 아직 MIN_HISTORY 미만(시즌 극초반) - 예측 보류

    window = hist[-ett.ROLL_WINDOW:]
    roster = ett.roster_window_minutes(window, ctx["player_stats_by_game"], tcode)
    # 현재 팀 로스터에 없는 선수 필터링
    if ctx.get("active_roster") and tcode in ctx.get("active_roster"):
        roster = {p: m for p, m in roster.items() if p in ctx["active_roster"][tcode]}
        
    # lineup이 주어지면(= 그 경기 12인 엔트리가 발표됨) 결장자를 빼고 선발을 소폭 가산한다.
    # None이면 아무 일도 안 일어나므로 기존 호출부 동작은 그대로다.
    if lineup:
        roster = ett.apply_lineup_to_roster(roster, lineup.get("dressed"), lineup.get("starters"))
    bs = ett.bio_synergy_features(roster, ctx["bio"], ctx["latest_onoff"], today_str, prefix)
    form = {f"{prefix}_{k}": v for k, v in ett.multi_window_form(hist).items()}
    age_curve = {f"{prefix}_{k}": v for k, v in ett.age_curve_team_feature(roster, ctx["bio"], ctx["age_curves"], today_str).items()}
    continuity = ett.roster_continuity(roster, ctx["season_roster_minutes"], tcode, ctx["current_season_code"])
    foreign_conc, foreign_n = ett.foreign_usage_concentration(roster, ctx["bio"])
    run_vuln = ett.run_vulnerability_features(window)
    pwr = ett.team_pwr_feature(roster, ctx["ovr_by_pcode_season"], ctx["prev_season_name"], prefix)

    last_game_date = hist[-1]["gameDate"]
    d0 = datetime.datetime.strptime(last_game_date, "%Y%m%d")
    d1 = datetime.datetime.strptime(today_str, "%Y%m%d")
    rest_days = (d1 - d0).days - 1

    mgr = ctx["latest_manager"].get(tcode)
    coach_win_pct = ett.cumulative_rate_before(ctx["coach_timelines"].get(mgr, []))

    return {
        **{f"{prefix}_{k}": v for k, v in feats.items()}, **bs, **form,
        **age_curve,
        f"{prefix}_restDays": rest_days,
        f"{prefix}_venueNetRtg": None,  # 아래서 경기장 정해지면 채움
        f"{prefix}_coachWinPct": coach_win_pct,
        f"{prefix}_foreignConcentration": foreign_conc,
        f"{prefix}_foreignPlayerCount": foreign_n,
        f"{prefix}_rosterContinuity": continuity,
        f"{prefix}_runVulnBigRuns": run_vuln["runVulnBigRuns"],
        f"{prefix}_runVulnWorstRun": run_vuln["runVulnWorstRun"],
        **pwr,
    }


def build_context(current_season_code=None):
    """current_season_code를 안 주면(과거엔 항상 이 경로) games[-1] 기준 +2로 추정 - 그 시즌이
    아직 raw/games에 한 경기도 안 쌓인 "완전히 새 시즌"일 때만 맞는 가정이다. 2026-09-24부터
    2026-27 시즌 경기(S49G14N1/2/3)가 실제로 raw/games에 들어오기 시작하면서 이 추정이 깨짐
    (latest_season_code 자체가 이미 49라 49+2=51이라는 존재하지 않는 시즌을 가리키게 됨 - 실전
    확인함). 그래서 호출부(main())는 이제 스케줄 API가 실제로 돌려주는 seasonCode를 여기로
    넘긴다 - 그게 있으면 그걸 그대로 쓰고, 없을 때만(check_lineup_recalc.py 같은 스케줄 없는
    호출) 기존 추정으로 폴백."""
    games = ett.load_all_games()
    if not games:
        raise SystemExit("과거 경기 데이터가 없음 - export_training_table.py가 쓰는 것과 동일한 raw/games가 필요")

    run_vuln_path = os.path.join(ANALYSIS_DIR, "run_vulnerability_per_game.json")
    run_vuln_per_game = {}
    if os.path.exists(run_vuln_path):
        with open(run_vuln_path, encoding="utf-8") as f:
            run_vuln_per_game = json.load(f)

    timelines = ett.build_team_timelines(games, run_vuln_per_game)
    coach_timelines = ett.build_coach_timelines(games)
    venue_timelines = ett.build_venue_timelines(games)
    referee_timeline = ett.build_cumulative_timeline(
        games, key_fn=lambda g: g.get("mainReferee"),
        outcome_fn=lambda g: 1 if g["homeRecord"]["score"] > g["awayRecord"]["score"] else 0)
    player_stats_by_game = ett.load_player_stats_by_game()
    season_roster_minutes = ett.build_season_roster_minutes(games, player_stats_by_game)
    latest_manager = ett.latest_manager_per_team(games)

    with open(os.path.join(ANALYSIS_DIR, "player_bio.json"), encoding="utf-8") as f:
        bio = json.load(f)
    with open(os.path.join(ANALYSIS_DIR, "player_onoff_timeline.json"), encoding="utf-8") as f:
        onoff_timeline = json.load(f)
    latest_onoff = ett.latest_player_onoff(games, onoff_timeline)
    age_curves = ett.load_age_curves()

    if current_season_code is None:
        latest_season_code = games[-1]["seasonCode"]
        current_season_code = latest_season_code + 2  # KBL 시즌코드는 시즌마다 +2 (build_age_curves.py에서 확인된 패턴)

    ovr_by_pcode_season = ett.load_courtside_ovr()
    season_names = ett.season_name_by_code(games)
    prev_season_name = season_names.get(current_season_code - 2)  # 팀 PWR 피처용 - 직전 완결 시즌만(누수 방지)

    active_roster = {}
    try:
        import sync_upcoming_games as sug
        sug.load_env_supabase()
        conn = sug.get_conn()
        cur = conn.cursor()
        cur.execute("SELECT season_name FROM seasons WHERE season_code = %s", (current_season_code,))
        row = cur.fetchone()
        if row:
            cur.execute("SELECT tcode, pcode FROM season_roster WHERE season_name = %s", (row[0],))
            for t, p in cur.fetchall():
                active_roster.setdefault(t, set()).add(p)
        conn.close()
    except Exception as e:
        print("[predict] active_roster 로드 실패:", e)

    return {
        "games": games, "timelines": timelines, "coach_timelines": coach_timelines,
        "venue_timelines": venue_timelines, "referee_timeline": referee_timeline,
        "player_stats_by_game": player_stats_by_game, "season_roster_minutes": season_roster_minutes,
        "latest_manager": latest_manager, "bio": bio, "latest_onoff": latest_onoff,
        "age_curves": age_curves, "current_season_code": current_season_code,
        "ovr_by_pcode_season": ovr_by_pcode_season, "prev_season_name": prev_season_name,
        "active_roster": active_roster,
    }


def fetch_upcoming_schedule(lookahead_days=LOOKAHEAD_DAYS):
    today = datetime.date.today()
    future = today + datetime.timedelta(days=lookahead_days)
    all_games = fkd.fetch_game_list(today.strftime("%Y%m%d"), future.strftime("%Y%m%d"))
    return [g for g in all_games if g.get("isEnded") == 0
            and g.get("seasonCategory") in fkd.PREDICTABLE_CATEGORIES]


def predict(ctx, model_bundle, schedule_games):
    model, feature_keys, game_level_keys = model_bundle["model"], model_bundle["featureKeys"], model_bundle["gameLevelKeys"]
    predictions = []

    for g in schedule_games:
        home_tcode, away_tcode = g["tcodeH"], g["tcodeA"]
        game_date = g["gameDate"]

        home_feats = team_features_now(home_tcode, "home", ctx, game_date)
        away_feats = team_features_now(away_tcode, "away", ctx, game_date)
        if home_feats is None or away_feats is None:
            predictions.append({
                "gmkey": g["gmkey"], "gameDate": game_date, "gameStart": g.get("gameStart"),
                "homeTname": g["tnameH"], "awayTname": g["tnameA"], "stadium": g.get("stadiumname"),
                "homeWinProb": None, "note": "직전 경기 표본 부족(시즌 극초반) - 예측 보류",
            })
            continue

        home_venue_key = (home_tcode, g.get("stadiumname"))
        home_feats[f"home_venueNetRtg"] = ett.venue_rating_before(ctx["venue_timelines"].get(home_venue_key, []))
        away_venue_key = (away_tcode, g.get("stadiumname"))
        away_feats[f"away_venueNetRtg"] = ett.venue_rating_before(ctx["venue_timelines"].get(away_venue_key, []))

        ref_home_win_rate = None  # 사전에 심판 배정 정보 없음

        feats = [home_feats.get(f"home_{k}") for k in feature_keys] + [away_feats.get(f"away_{k}") for k in feature_keys]
        ctx_vals = {"dayOfWeek": ett.date_context_features(game_date)["dayOfWeek"],
                    "month": ett.date_context_features(game_date)["month"],
                    "refHomeWinRate": ref_home_win_rate}
        feats += [ctx_vals.get(k) for k in game_level_keys]
        X = np.array([[np.nan if v is None else v for v in feats]], dtype=float)

        prob_home = float(model.predict_proba(X)[0, 1])
        predictions.append({
            "gmkey": g["gmkey"], "gameDate": game_date, "gameStart": g.get("gameStart"),
            "homeTname": g["tnameH"], "awayTname": g["tnameA"], "stadium": g.get("stadiumname"),
            "seasonCategory": g.get("seasonCategory"),
            "homeWinProb": round(prob_home, 4),
        })

    return predictions


def main():
    if not os.path.exists(MODEL_PATH):
        raise SystemExit(f"{MODEL_PATH} 없음 - 먼저 save_pregame_model.py 실행 필요")
    model_bundle = joblib.load(MODEL_PATH)

    print("예정 경기 조회 중...", flush=True)
    schedule_games = fetch_upcoming_schedule()
    cats = "/".join(sorted(fkd.PREDICTABLE_CATEGORIES))
    print(f"  {LOOKAHEAD_DAYS}일 내 예정 경기({cats}) {len(schedule_games)}건", flush=True)
    if not schedule_games:
        with open(OUT_PATH, "w", encoding="utf-8") as f:
            json.dump([], f, ensure_ascii=False, indent=1)
        print("예정된 경기 없음.", flush=True)
        return

    print("피처 컨텍스트(팀 타임라인/로스터/시너지 등) 구성 중...", flush=True)
    # 스케줄 API가 실제로 돌려준 seasonCode를 그대로 씀 - games[-1]+2 추정은 이 시즌 경기가
    # 이미 raw/games에 쌓이기 시작하면 깨진다(build_context 주석 참고).
    ctx = build_context(current_season_code=schedule_games[0].get("seasonCode"))

    print("예측 중...", flush=True)
    predictions = predict(ctx, model_bundle, schedule_games)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(predictions, f, ensure_ascii=False, indent=1)
    print(f"-> {OUT_PATH}", flush=True)
    for p in predictions:
        if p["homeWinProb"] is not None:
            print(f"  {p['gameDate']} {p['homeTname']} vs {p['awayTname']}: 홈 승률 {p['homeWinProb']*100:.1f}%", flush=True)
        else:
            print(f"  {p['gameDate']} {p['homeTname']} vs {p['awayTname']}: {p['note']}", flush=True)


if __name__ == "__main__":
    main()
