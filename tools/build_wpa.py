"""
Win Probability Added (WPA) - 2026-08-24, 사용자 요청.

MLB의 WPA, NFL의 EPA와 같은 개념: 매 이벤트마다 "그 플레이 직전 승률 -> 직후 승률"의 변화폭을
그 플레이/선수에 귀속시킨다. 방금 튜닝·저장한 라이브 모델(HistGradientBoosting, 홀드아웃
정확도 74.7%)을 그대로 재사용 - 새 모델을 또 학습시키는 게 아니라 이미 검증된 걸 descriptive
분석에 쓰는 것.

**부호 규약**: 모델은 P(홈팀 승)을 예측함. 원정팀의 좋은 플레이는 P(홈팀 승)을 "낮춰야" 정상이라,
원정팀 이벤트는 부호를 뒤집어서 "그 팀 입장에서 얼마나 도움이 됐나"로 통일(teamWPA). 이래야
홈/원정 안 가리고 "누가 승리기여 플레이를 많이 만들었는가" 리더보드를 바로 만들 수 있음.

**"직전" 승률의 정의**: 스냅샷이 이벤트 순서대로 나열돼있으니, i번째 이벤트의 WPA = P(i) - P(i-1).
경기 첫 이벤트는 비교할 "직전"이 없어서, "득점차 0·잔여시간 풀타임·경기전 팀전력만 반영"한
모델 예측값을 가상의 "0번째" 상태로 삼는다 - 사실상 "이 두 팀이 지금 경기를 시작한다면"에
대한 모델의 답.

**선수 귀속**: 문자중계 이벤트에 선수명(p)이 있는 것만 개인에게 귀속(팀 전체 이벤트 - 작전타임/
팀턴오버/팀파울 등 - 는 개인 귀속 없이 팀 WPA 로그에만 남김).
"""
import json
import math
import os

import joblib
import numpy as np

from build_live_winprob_data import (
    QUARTER_ORDER, QUARTER_LEN_SEC, SCORE_CODES,
    cumulative_elapsed, load_pregame_context,
)

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
MODEL_PATH = os.path.join(ANALYSIS_DIR, "live_winprob_model.joblib")
EVENTS_OUT_PATH = os.path.join(ANALYSIS_DIR, "wpa_events.json")
PLAYER_OUT_PATH = os.path.join(ANALYSIS_DIR, "wpa_player_leaderboard.json")
BIGPLAYS_OUT_PATH = os.path.join(ANALYSIS_DIR, "wpa_biggest_plays.json")
SEASON_OUT_PATH = os.path.join(ANALYSIS_DIR, "wpa_season_leaderboard.json")

NO_PLAYER_CODES = {"001", "002", "003", "009", "010", "217", "218", "219", "223", "225", "228", "229"}


def scaled_score_diff(score_diff, remaining_sec):
    return score_diff / math.sqrt(remaining_sec + 30)


def build_feature_rows(score_diffs, remaining_secs, net, syn):
    return np.array([
        [sd, rem, scaled_score_diff(sd, rem), net, syn]
        for sd, rem in zip(score_diffs, remaining_secs)
    ], dtype=float)


def process_game(gmkey, ctx, home_tcode, model):
    path = os.path.join(GAMES_DIR, gmkey, "text-cast.json")
    if not os.path.exists(path):
        return [], []
    with open(path, encoding="utf-8") as f:
        events = json.load(f)
    if not events:
        return [], []

    total_elapsed = cumulative_elapsed(events[-1]["q"], events[-1]["m"], events[-1]["s"])
    if total_elapsed <= 0:
        return [], []

    net = ctx["netrtgDiff"] if ctx["netrtgDiff"] is not None else 0.0
    syn = ctx["synergyDiff"] if ctx["synergyDiff"] is not None else 0.0

    # 가상의 "0번째" 상태(경기 시작 전) - 득점차 0, 잔여시간 = 전체 경기시간
    pregame_row = build_feature_rows([0], [total_elapsed], net, syn)

    home_score, away_score = 0, 0
    score_diffs, remaining_secs = [], []
    for evt in events:
        code = evt.get("a")
        if code in SCORE_CODES and evt.get("t") == home_tcode:
            home_score += SCORE_CODES[code]
        elif code in SCORE_CODES:
            away_score += SCORE_CODES[code]
        elapsed = cumulative_elapsed(evt["q"], evt["m"], evt["s"])
        score_diffs.append(home_score - away_score)
        remaining_secs.append(total_elapsed - elapsed)

    X = build_feature_rows(score_diffs, remaining_secs, net, syn)
    all_X = np.vstack([pregame_row, X])
    probs = model.predict_proba(all_X)[:, 1]  # P(홈팀 승), 인덱스 0=경기전, 1..n=이벤트 i

    event_log = []
    player_deltas = []  # (pcode 대신 이름 - text-cast엔 pcode 없음, gmkey+이름으로 나중에 집계)
    for i, evt in enumerate(events):
        prob_before, prob_after = probs[i], probs[i + 1]
        raw_delta = prob_after - prob_before
        team = evt.get("t")
        team_wpa = raw_delta if team == home_tcode else -raw_delta
        row = {
            "gmkey": gmkey, "n": evt.get("n"), "q": evt["q"], "m": evt["m"], "s": evt["s"],
            "action": evt.get("a"), "team": team, "player": evt.get("p"),
            "probBefore": round(float(prob_before), 4), "probAfter": round(float(prob_after), 4),
            "teamWpa": round(float(team_wpa), 4),
        }
        event_log.append(row)
        if evt.get("a") not in NO_PLAYER_CODES and evt.get("p"):
            player_deltas.append((evt.get("p"), team, team_wpa))

    return event_log, player_deltas


def main():
    print("모델 로딩...", flush=True)
    model = joblib.load(MODEL_PATH)

    pregame_ctx = load_pregame_context()
    print(f"경기전 컨텍스트 있는 경기: {len(pregame_ctx)}개", flush=True)

    player_agg = {}  # (name, team) -> {"totalWpa":..,"plays":..,"posWpa":..,"negWpa":..}
    # 시즌별 리더보드용 - (seasonName, name, team) 키. 정규시즌만(플레이오프는 경기수가 팀마다
    # 크게 달라서 같은 잣대로 순위 매기면 왜곡됨 - 플레이오프는 나중에 별도로 다룰 후보)
    season_player_agg = {}
    biggest_plays = []
    all_events_sample = []  # 전체 이벤트 로그는 너무 커서(240만행) 대표 샘플만 남김(막판/클러치 위주)

    n_games = 0
    for gmkey in sorted(os.listdir(GAMES_DIR)):
        ctx = pregame_ctx.get(gmkey)
        if ctx is None:
            continue
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        home_tcode = meta["game"].get("tcodeH")
        season_name = meta["game"].get("seasonName")
        is_regular = meta["game"].get("seasonCategoryName") == "정규시즌"

        event_log, player_deltas = process_game(gmkey, ctx, home_tcode, model)
        if not event_log:
            continue
        n_games += 1

        for name, team, wpa in player_deltas:
            key = (name, team)
            a = player_agg.setdefault(key, {"totalWpa": 0.0, "plays": 0, "posWpa": 0.0, "negWpa": 0.0, "games": set()})
            a["totalWpa"] += wpa
            a["plays"] += 1
            a["games"].add(gmkey)
            if wpa > 0:
                a["posWpa"] += wpa
            else:
                a["negWpa"] += wpa

            if is_regular and season_name:
                skey = (season_name, name, team)
                sa = season_player_agg.setdefault(skey, {"totalWpa": 0.0, "plays": 0, "posWpa": 0.0, "negWpa": 0.0, "games": set()})
                sa["totalWpa"] += wpa
                sa["plays"] += 1
                sa["games"].add(gmkey)
                if wpa > 0:
                    sa["posWpa"] += wpa
                else:
                    sa["negWpa"] += wpa

        # 경기당 가장 큰 플레이(팀WPA 절댓값 최대) 하나씩 기록 - 하이라이트용
        biggest = max(event_log, key=lambda r: abs(r["teamWpa"]))
        biggest_plays.append(biggest)

        # 막판(잔여 5분 이내) 이벤트만 대표 샘플로 남김 - 클러치 플레이 열람용, 전체는 너무 큼
        for r in event_log:
            elapsed_left = cumulative_elapsed(r["q"], r["m"], r["s"])
            # 남은시간 재계산 대신 이미 있는 정보로 대략 필터: q가 Q4/연장이면 클러치 후보
            if r["q"] in ("Q4", "X1", "X2", "X3", "X4"):
                all_events_sample.append(r)

        if n_games % 500 == 0:
            print(f"  {n_games}경기 처리...", flush=True)

    print(f"\n총 {n_games}경기 처리 완료", flush=True)

    leaderboard = []
    for (name, team), a in player_agg.items():
        if a["plays"] < 20:
            continue
        leaderboard.append({
            "player": name, "team": team, "games": len(a["games"]), "plays": a["plays"],
            "totalWpa": round(a["totalWpa"], 3), "posWpa": round(a["posWpa"], 3), "negWpa": round(a["negWpa"], 3),
            "wpaPerGame": round(a["totalWpa"] / len(a["games"]), 4),
        })
    leaderboard.sort(key=lambda r: -r["totalWpa"])

    biggest_plays.sort(key=lambda r: -abs(r["teamWpa"]))

    # 시즌별 리더보드 - 정규시즌 내 표본 20경기 미만인 통산 기준(plays>=20)보다 낮춰서
    # plays>=15로(한 시즌 82경기 안에서의 순위라 통산 기준을 그대로 쓰면 너무 많이 걸러짐)
    by_season = {}
    for (season_name, name, team), a in season_player_agg.items():
        if a["plays"] < 15:
            continue
        row = {
            "player": name, "team": team, "games": len(a["games"]), "plays": a["plays"],
            "totalWpa": round(a["totalWpa"], 3), "posWpa": round(a["posWpa"], 3), "negWpa": round(a["negWpa"], 3),
            "wpaPerGame": round(a["totalWpa"] / len(a["games"]), 4),
        }
        by_season.setdefault(season_name, []).append(row)
    for rows in by_season.values():
        rows.sort(key=lambda r: -r["totalWpa"])
    seasons_sorted = sorted(by_season.keys(), reverse=True)  # "2025-2026" 형식이라 문자열 내림차순 = 최신순
    season_leaderboard = {"seasons": seasons_sorted, "bySeason": by_season}

    os.makedirs(ANALYSIS_DIR, exist_ok=True)
    with open(PLAYER_OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(leaderboard, f, ensure_ascii=False, indent=1)
    with open(BIGPLAYS_OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(biggest_plays[:500], f, ensure_ascii=False, indent=1)
    with open(EVENTS_OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(all_events_sample, f, ensure_ascii=False)
    with open(SEASON_OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(season_leaderboard, f, ensure_ascii=False, indent=1)

    print(f"선수 리더보드 {len(leaderboard)}명 -> {PLAYER_OUT_PATH}", flush=True)
    print(f"경기별 최대 임팩트 플레이 {len(biggest_plays)}건 -> {BIGPLAYS_OUT_PATH}", flush=True)
    print(f"시즌별 리더보드 {len(seasons_sorted)}개 시즌 -> {SEASON_OUT_PATH}", flush=True)
    print(f"4쿼터+연장 이벤트 샘플 {len(all_events_sample)}건 -> {EVENTS_OUT_PATH}", flush=True)

    print("\n=== 통산 총 WPA 상위 10명 ===", flush=True)
    for r in leaderboard[:10]:
        print(f"  {r['player']:<10} {r['totalWpa']:+.2f}  ({r['games']}경기, 경기당 {r['wpaPerGame']:+.3f})", flush=True)


if __name__ == "__main__":
    main()
