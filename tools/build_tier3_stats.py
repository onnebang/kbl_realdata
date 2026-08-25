"""
Tier 03 라이브 스탯 - 포제션/정밀 시간창 추적 (2026-08-24, kbl_stats_roadmap.html 03단계).

로드맵 자체가 "01·02 끝나고 안정화 확인 후 진행 권장"이라고 경고한 단계 - 포제션 경계를
이벤트만으로 판정해야 해서(문자중계엔 명시적 포제션 ID가 없음) 정의를 신중하게 잡음. 아래
가정들은 이 파일에서만 유효한 근사치이지 KBL 공식 스탯 정의가 아님.

## 포제션 경계 판정 규칙 (Points Off Turnover / Second Chance 공용)
팀별로 두 플래그를 독립적으로 추적한다:
- `off_turnover_active[T]`: 상대 턴오버(214) 직후 True. T가 득점(성공)하면 그 득점을 POT로
  집계하고 두 플래그 모두 클리어. T가 자기도 턴오버하면 집계 없이 클리어하고 상대팀 플래그를
  True로 넘김(체인 턴오버). 상대가 수비리바운드(210)를 잡으면(T가 슛을 놓쳤다는 뜻) 클리어.
  T의 공격리바운드(209)는 이 플래그를 안 건드림 - 턴오버로 얻은 포제션이 오펜스리바운드로
  연장돼도 여전히 "그 턴오버발 포제션"이라 계속 살아있어야 함.
- `second_chance_active[T]`: T의 공격리바운드(209) 직후 True. T가 득점하면 세컨찬스로 집계 후
  클리어. 상대 수비리바운드로 클리어. T의 턴오버로도 집계 없이 클리어.
쿼터가 바뀌면 두 플래그 전부 강제 리셋(쿼터 경계 넘어서 잘못 귀속되는 것 방지).

**검증 방법**: 이 정의로 계산한 "팀당 경기평균 POT/세컨찬스"가 상식적 범위(NBA 팀 평균은 보통
POT 15~17점/경기, 세컨찬스 12~14점/경기)와 비슷한 자릿수인지로 1차 검증함 - 실행 후 출력 로그
참고.

## Transition/Fast Break
"수비리바운드/스틸 시점~다음 슛시도 시점 game clock차 8초 이내"를 그대로 구현. 트리거 후 그
팀의 첫 슛시도(성공/실패 불문)까지만 보고, 그 전에 턴오버가 나면 트리거 소멸.

## Foul Trouble / Bonus Pressure
- 개인 파울트러블: 파울코드(216 파울, 224 기타파울) 누적이 쿼터별 관행적 임계값(1쿼터 2개,
  전반 3개, 3쿼터까지 4개)을 처음 넘는 순간을 "폼파울트러블 진입"으로 1경기 1선수당 1회만 기록.
- 팀 보너스: 팀파울(225) 누적이 쿼터당 5개(FIBA/KBL 보너스 규정) 도달 시점부터 그 쿼터가 끝날
  때까지 상대가 얻은 자유투(203/204) 시도 수를 "보너스 자유투"로 집계.

## Clutch Time Performance
로드맵 조건 그대로: Q4 & 잔여시간 5분 이내 & 점수차 5점 이내. 추가로 연장(X1~X4)은 전체가
초박빙 상황(동점에서 시작)이라 조건 없이 통째로 클러치로 포함(로드맵 원문엔 없지만 상식적 확장 -
주석으로 명시).

## 타임아웃 효과성
작전시간(003) 이벤트 전후 120초씩 상대 득점을 비교. 개별 타임아웃 하나로는 노이즈가 커서
리그 전체 평균으로만 집계(리더보드 아님 - check_survivorship_bias.py와 같은 접근).
"""
import json
import os
from collections import defaultdict

from build_synergy_matchup import cumulative_elapsed
from build_live_winprob_data import SCORE_CODES

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")

POT_SCP_OUT = os.path.join(ANALYSIS_DIR, "points_off_to_second_chance.json")
TRANSITION_OUT = os.path.join(ANALYSIS_DIR, "transition_index.json")
FOULTROUBLE_OUT = os.path.join(ANALYSIS_DIR, "foul_trouble.json")
BONUS_OUT = os.path.join(ANALYSIS_DIR, "bonus_pressure.json")
CLUTCH_OUT = os.path.join(ANALYSIS_DIR, "clutch_performance.json")
TIMEOUT_OUT = os.path.join(ANALYSIS_DIR, "timeout_effectiveness.json")

MAKE_CODES = {"201", "205", "207"}
SHOT_ATTEMPT_CODES = {"201", "202", "205", "206", "207", "208"}
TURNOVER_CODE = "214"
OREB_CODE, DREB_CODE = "209", "210"
STEAL_CODE = "212"
PERSONAL_FOUL_CODES = {"216", "224"}
TEAM_FOUL_CODE = "225"
FT_MAKE_CODE, FT_MISS_CODE = "203", "204"
TIMEOUT_CODE = "003"
TRANSITION_MAX_GAP_SEC = 8
FOUL_TROUBLE_THRESHOLDS = {"Q1": 2, "Q2": 3, "Q3": 4}
BONUS_TEAM_FOULS = 5
TIMEOUT_WINDOW_SEC = 120


def process_game(gmkey, home_tcode, away_tcode, meta):
    path = os.path.join(GAMES_DIR, gmkey, "text-cast.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        events = json.load(f)
    if not events:
        return None

    game_date = meta["game"].get("gameDate")
    teams = (home_tcode, away_tcode)
    total_elapsed = cumulative_elapsed(events[-1]["q"], events[-1]["m"], events[-1]["s"])

    # --- Points Off TO / Second Chance ---
    off_to_active = {home_tcode: False, away_tcode: False}
    sc_active = {home_tcode: False, away_tcode: False}
    pot_pts = {home_tcode: 0, away_tcode: 0}
    scp_pts = {home_tcode: 0, away_tcode: 0}

    # --- Transition ---
    trans_trigger = {home_tcode: None, away_tcode: None}  # elapsed sec of last reb/steal
    trans_attempts = {home_tcode: [], away_tcode: []}  # list of bool(made)

    # --- Foul trouble ---
    personal_fouls = defaultdict(int)  # (player,team) -> count
    foul_trouble_events = []

    # --- Bonus ---
    team_fouls_this_q = defaultdict(int)  # team -> count, reset per quarter
    in_bonus = {home_tcode: False, away_tcode: False}
    bonus_ft_count = {home_tcode: 0, away_tcode: 0}
    cur_q = None

    # --- Clutch ---
    clutch_stat = defaultdict(lambda: {"pts": 0, "reb": 0, "ast": 0, "stl": 0, "blk": 0, "to": 0, "fgm": 0, "fga": 0})

    # --- Timeout ---
    timeout_events_local = []
    score_events_local = []  # (elapsed, team, pts) for windowed lookup

    for evt in events:
        code = evt.get("a")
        team = evt.get("t")
        player = evt.get("p")
        q = evt["q"]
        elapsed = cumulative_elapsed(q, evt["m"], evt["s"])
        remaining = total_elapsed - elapsed

        if q != cur_q:
            cur_q = q
            off_to_active = {home_tcode: False, away_tcode: False}
            sc_active = {home_tcode: False, away_tcode: False}
            team_fouls_this_q = defaultdict(int)
            in_bonus = {home_tcode: False, away_tcode: False}

        if team not in teams:
            if code in SCORE_CODES:
                score_events_local.append((elapsed, team, SCORE_CODES[code]))
            continue

        other = away_tcode if team == home_tcode else home_tcode

        if code in SCORE_CODES:
            pts = SCORE_CODES[code]
            score_events_local.append((elapsed, team, pts))
            if off_to_active[team]:
                pot_pts[team] += pts
            if sc_active[team]:
                scp_pts[team] += pts
            off_to_active[team] = False
            sc_active[team] = False

        elif code == TURNOVER_CODE:
            off_to_active[team] = False
            sc_active[team] = False
            off_to_active[other] = True

        elif code == DREB_CODE:
            off_to_active[other] = False
            sc_active[other] = False

        elif code == OREB_CODE:
            sc_active[team] = True

        if code in (DREB_CODE, STEAL_CODE):
            trans_trigger[team] = elapsed
        elif code in SHOT_ATTEMPT_CODES:
            trig = trans_trigger.get(team)
            if trig is not None and (elapsed - trig) <= TRANSITION_MAX_GAP_SEC:
                trans_attempts[team].append(code in MAKE_CODES)
            trans_trigger[team] = None
        elif code == TURNOVER_CODE:
            trans_trigger[team] = None

        if code in PERSONAL_FOUL_CODES and player:
            key = (player, team)
            personal_fouls[key] += 1
            threshold = FOUL_TROUBLE_THRESHOLDS.get(q)
            if threshold is not None and personal_fouls[key] == threshold:
                foul_trouble_events.append({
                    "gmkey": gmkey, "gameDate": game_date, "player": player, "tcode": team,
                    "quarter": q, "foulCount": personal_fouls[key], "at": {"q": q, "m": evt["m"], "s": evt["s"]},
                })

        if code == TEAM_FOUL_CODE:
            team_fouls_this_q[team] += 1
            if team_fouls_this_q[team] >= BONUS_TEAM_FOULS:
                in_bonus[team] = True
        if code in (FT_MAKE_CODE, FT_MISS_CODE) and in_bonus.get(other):
            bonus_ft_count[team] += 1

        is_clutch = (q == "Q4" and remaining <= 300) or q.startswith("X")
        if is_clutch and player:
            key = (player, team)
            cs = clutch_stat[key]
            if code in SCORE_CODES:
                cs["pts"] += SCORE_CODES[code]
            if code in (OREB_CODE, DREB_CODE):
                cs["reb"] += 1
            elif code == "211":
                cs["ast"] += 1
            elif code == STEAL_CODE:
                cs["stl"] += 1
            elif code == "213":
                cs["blk"] += 1
            elif code == TURNOVER_CODE:
                cs["to"] += 1
            if code in {"201", "202", "205", "206", "207", "208"}:
                cs["fga"] += 1
                if code in MAKE_CODES:
                    cs["fgm"] += 1

        if code == TIMEOUT_CODE:
            timeout_events_local.append((elapsed, team))

    timeout_deltas = []
    for t_elapsed, t_team in timeout_events_local:
        opp = away_tcode if t_team == home_tcode else home_tcode
        before = sum(p for e, tm, p in score_events_local if tm == opp and t_elapsed - TIMEOUT_WINDOW_SEC <= e < t_elapsed)
        after = sum(p for e, tm, p in score_events_local if tm == opp and t_elapsed < e <= t_elapsed + TIMEOUT_WINDOW_SEC)
        timeout_deltas.append((before, after))

    return {
        "pot_pts": pot_pts, "scp_pts": scp_pts,
        "trans_attempts": trans_attempts,
        "foul_trouble_events": foul_trouble_events,
        "bonus_ft_count": bonus_ft_count,
        "clutch_stat": clutch_stat,
        "timeout_deltas": timeout_deltas,
        "home_tcode": home_tcode, "away_tcode": away_tcode, "gmkey": gmkey, "gameDate": game_date,
    }


def main():
    team_game_totals = []  # per game: {gmkey, tcode, pot, scp}
    trans_agg = defaultdict(lambda: {"attempts": 0, "makes": 0})  # tcode -> totals
    foul_trouble_all = []
    bonus_agg = defaultdict(lambda: {"games": 0, "ftDrawn": 0})
    clutch_agg = defaultdict(lambda: {"pts": 0, "reb": 0, "ast": 0, "stl": 0, "blk": 0, "to": 0, "fgm": 0, "fga": 0, "games": set()})
    all_timeout_deltas = []

    n = 0
    for gmkey in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        home_tcode, away_tcode = meta["game"].get("tcodeH"), meta["game"].get("tcodeA")
        if not home_tcode or not away_tcode:
            continue

        r = process_game(gmkey, home_tcode, away_tcode, meta)
        if r is None:
            continue
        n += 1

        for team in (home_tcode, away_tcode):
            team_game_totals.append({
                "gmkey": gmkey, "gameDate": r["gameDate"], "tcode": team,
                "pointsOffTurnover": r["pot_pts"][team], "secondChancePoints": r["scp_pts"][team],
            })
            attempts = r["trans_attempts"][team]
            trans_agg[team]["attempts"] += len(attempts)
            trans_agg[team]["makes"] += sum(attempts)
            bonus_agg[team]["games"] += 1
            bonus_agg[team]["ftDrawn"] += r["bonus_ft_count"][team]

        foul_trouble_all.extend(r["foul_trouble_events"])

        for (player, team), cs in r["clutch_stat"].items():
            a = clutch_agg[(player, team)]
            for k in ("pts", "reb", "ast", "stl", "blk", "to", "fgm", "fga"):
                a[k] += cs[k]
            a["games"].add(gmkey)

        all_timeout_deltas.extend(r["timeout_deltas"])

        if n % 500 == 0:
            print(f"  {n}경기 처리...", flush=True)

    print(f"\n총 {n}경기 처리 완료", flush=True)

    os.makedirs(ANALYSIS_DIR, exist_ok=True)

    # Points off TO / Second chance - 팀-시즌 평균으로 요약(경기별 원자료는 용량 커서 상위만)
    team_game_totals.sort(key=lambda x: -(x["pointsOffTurnover"] + x["secondChancePoints"]))
    avg_pot = sum(x["pointsOffTurnover"] for x in team_game_totals) / len(team_game_totals)
    avg_scp = sum(x["secondChancePoints"] for x in team_game_totals) / len(team_game_totals)
    with open(POT_SCP_OUT, "w", encoding="utf-8") as f:
        json.dump({"leagueAvgPointsOffTurnoverPerGame": round(avg_pot, 2),
                   "leagueAvgSecondChancePointsPerGame": round(avg_scp, 2),
                   "topGames": team_game_totals[:300]}, f, ensure_ascii=False, indent=1)
    print(f"Points-off-TO/Second-Chance -> {POT_SCP_OUT}", flush=True)
    print(f"  리그 평균: POT {avg_pot:.1f}점/경기, 세컨찬스 {avg_scp:.1f}점/경기", flush=True)

    trans_list = [
        {"tcode": t, "attempts": v["attempts"], "makes": v["makes"],
         "fgPct": round(v["makes"] / v["attempts"], 3) if v["attempts"] else None}
        for t, v in trans_agg.items()
    ]
    trans_list.sort(key=lambda x: -x["attempts"])
    with open(TRANSITION_OUT, "w", encoding="utf-8") as f:
        json.dump(trans_list, f, ensure_ascii=False, indent=1)
    print(f"Transition Index (팀별) -> {TRANSITION_OUT}", flush=True)
    for r in trans_list[:5]:
        print(f"  tcode{r['tcode']} 속공시도 {r['attempts']}회 성공률 {r['fgPct']}", flush=True)

    with open(FOULTROUBLE_OUT, "w", encoding="utf-8") as f:
        json.dump(foul_trouble_all[:1000], f, ensure_ascii=False, indent=1)
    print(f"Foul Trouble 이벤트 {len(foul_trouble_all)}건 -> {FOULTROUBLE_OUT}", flush=True)

    bonus_list = [
        {"tcode": t, "games": v["games"], "bonusFtDrawnPerGame": round(v["ftDrawn"] / v["games"], 2)}
        for t, v in bonus_agg.items() if v["games"] >= 10
    ]
    bonus_list.sort(key=lambda x: -x["bonusFtDrawnPerGame"])
    with open(BONUS_OUT, "w", encoding="utf-8") as f:
        json.dump(bonus_list, f, ensure_ascii=False, indent=1)
    print(f"Bonus Pressure (팀별 보너스 자유투/경기) -> {BONUS_OUT}", flush=True)

    clutch_list = []
    for (player, team), a in clutch_agg.items():
        if a["fga"] < 20:
            continue
        clutch_list.append({
            "player": player, "tcode": team, "games": len(a["games"]),
            "pts": a["pts"], "reb": a["reb"], "ast": a["ast"], "stl": a["stl"], "blk": a["blk"], "to": a["to"],
            "fgm": a["fgm"], "fga": a["fga"], "fgPct": round(a["fgm"] / a["fga"], 3),
            "ptsPerGame": round(a["pts"] / len(a["games"]), 2),
        })
    clutch_list.sort(key=lambda x: -x["ptsPerGame"])
    with open(CLUTCH_OUT, "w", encoding="utf-8") as f:
        json.dump(clutch_list[:300], f, ensure_ascii=False, indent=1)
    print(f"Clutch Time 리더보드(클러치FGA 20+) -> {CLUTCH_OUT}", flush=True)
    for r in clutch_list[:5]:
        print(f"  {r['player']} 클러치 경기당 {r['ptsPerGame']}점 (FG% {r['fgPct']}, {r['games']}경기)", flush=True)

    before_sum = sum(b for b, a in all_timeout_deltas)
    after_sum = sum(a for b, a in all_timeout_deltas)
    n_to = len(all_timeout_deltas)
    with open(TIMEOUT_OUT, "w", encoding="utf-8") as f:
        json.dump({
            "n_timeouts": n_to,
            "avgOpponentPtsBefore120s": round(before_sum / n_to, 3) if n_to else None,
            "avgOpponentPtsAfter120s": round(after_sum / n_to, 3) if n_to else None,
        }, f, ensure_ascii=False, indent=1)
    print(f"타임아웃 효과성 (n={n_to}) -> {TIMEOUT_OUT}", flush=True)
    if n_to:
        print(f"  작전타임 전 120초 상대 평균 {before_sum/n_to:.2f}점 vs 후 120초 {after_sum/n_to:.2f}점", flush=True)


if __name__ == "__main__":
    main()
