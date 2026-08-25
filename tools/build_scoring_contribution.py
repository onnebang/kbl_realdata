"""
Scoring Contribution Rate (로드맵 03단계 #8, 2026-08-24) - 스틴트(누구 코트 위) + 이벤트(누가
득점) 조인.

"이 선수가 코트에 있는 동안, 팀 득점 중 본인이 득점하거나 어시스트한 비중"을 시즌 단위로 집계.
스틴트 파일(`raw/stints/{gmkey}.json`)이 이미 각 스틴트의 시작/끝 시각과 그 구간 팀 득점
(homePts/awayPts)을 득점검증까지 마친 상태로 갖고 있어서, 이벤트를 한 번만 훑으면서 "지금
몇 번째 스틴트 구간인지" 포인터만 전진시키면 됨(스틴트가 시간순으로 이미 정렬돼있어서 O(이벤트
수+스틴트 수), 스틴트마다 전체 이벤트 재스캔할 필요 없음).

**어시스트 귀속 규칙**: 득점 이벤트 바로 다음 이벤트가 같은 팀·같은 시각(q,m,s)의 어시스트(211)면
그 득점의 점수를 어시스트한 선수의 기여로도 더한다(득점자 본인 기여와 별도로 카운트 - 한 바스켓이
두 선수의 기여로 동시에 잡히는 건 의도된 설계, "관여도"지 "배타적 분배"가 아님).

**분모(팀 득점)는 스틴트 파일의 homePts/awayPts를 그대로 씀** - 이미 build_lineup_stints.py에서
전체 경기 득점 검증(98.8% 일치)을 통과한 신뢰할 수 있는 숫자라, 여기서 또 계산할 필요 없음.
"""
import json
import os
from collections import defaultdict

from build_synergy_matchup import cumulative_elapsed
from build_live_winprob_data import SCORE_CODES

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
STINTS_DIR = os.path.join(BASE, "..", "raw", "stints")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
OUT_PATH = os.path.join(ANALYSIS_DIR, "scoring_contribution.json")

MIN_STINT_SEC_TOTAL = 3600  # 시즌 누적 최소 표본(코트 위 총 시간, 초) - 대략 시즌 10경기 이상 주전급


def clock_elapsed(clock):
    q, m, s = clock
    return cumulative_elapsed(q, m, s)


def process_game(gmkey, meta, pcode_name):
    stint_path = os.path.join(STINTS_DIR, f"{gmkey}.json")
    text_path = os.path.join(GAMES_DIR, gmkey, "text-cast.json")
    pstat_path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
    if not (os.path.exists(stint_path) and os.path.exists(text_path)):
        return None
    with open(stint_path, encoding="utf-8") as f:
        sdata = json.load(f)
    stints = sdata["stints"]
    if not stints:
        return None
    home_tcode, away_tcode = sdata["homeCode"], sdata["awayCode"]

    name_to_pcode = {}
    if os.path.exists(pstat_path):
        with open(pstat_path, encoding="utf-8") as f:
            for row in json.load(f):
                p = row["player"]
                pcode_name[p["pcode"]] = p["pname"]
                name_to_pcode[(p["tcode"], p["pname"])] = p["pcode"]

    with open(text_path, encoding="utf-8") as f:
        events = json.load(f)
    if not events:
        return None

    ranges = []
    for st in stints:
        start_e = clock_elapsed(st["startClock"])
        end_e = clock_elapsed(st["endClock"])
        ranges.append((start_e, end_e, st))

    contrib = defaultdict(float)  # pcode -> 기여 득점
    team_pts_while_on = defaultdict(float)  # pcode -> 그 선수가 코트에 있던 스틴트들의 팀 득점 합
    seconds_on_court = defaultdict(float)

    n_ranges = len(ranges)

    for start_e, end_e, st in ranges:
        dur = max(end_e - start_e, 0)
        for team, lineup, pts in ((home_tcode, st["homeLineup"], st["homePts"]), (away_tcode, st["awayLineup"], st["awayPts"])):
            for pcode in lineup:
                team_pts_while_on[pcode] += pts
                seconds_on_court[pcode] += dur

    idx = 0
    for i, evt in enumerate(events):
        code = evt.get("a")
        if code not in SCORE_CODES:
            continue
        team = evt.get("t")
        if team not in (home_tcode, away_tcode):
            continue
        elapsed = cumulative_elapsed(evt["q"], evt["m"], evt["s"])
        while idx < n_ranges - 1 and elapsed >= ranges[idx][1]:
            idx += 1
        start_e, end_e, st = ranges[idx]
        if not (start_e <= elapsed <= end_e):
            continue
        pts = SCORE_CODES[code]
        scorer_pcode = name_to_pcode.get((team, evt.get("p")))
        if scorer_pcode:
            contrib[scorer_pcode] += pts
        if i + 1 < len(events):
            nxt = events[i + 1]
            if nxt.get("a") == "211" and nxt.get("t") == team and nxt["q"] == evt["q"] and nxt["m"] == evt["m"] and nxt["s"] == evt["s"]:
                assister_pcode = name_to_pcode.get((team, nxt.get("p")))
                if assister_pcode:
                    contrib[assister_pcode] += pts

    return contrib, team_pts_while_on, seconds_on_court


def main():
    pcode_name = {}
    total_contrib = defaultdict(float)
    total_team_pts = defaultdict(float)
    total_seconds = defaultdict(float)
    tcode_of = {}

    n = 0
    for gmkey in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)

        result = process_game(gmkey, meta, pcode_name)
        if result is None:
            continue
        contrib, team_pts_while_on, seconds_on_court = result
        n += 1
        for pcode, v in contrib.items():
            total_contrib[pcode] += v
        for pcode, v in team_pts_while_on.items():
            total_team_pts[pcode] += v
        for pcode, v in seconds_on_court.items():
            total_seconds[pcode] += v

        if n % 500 == 0:
            print(f"  {n}경기 처리...", flush=True)

    print(f"\n총 {n}경기 처리 완료", flush=True)

    leaderboard = []
    for pcode, team_pts in total_team_pts.items():
        secs = total_seconds[pcode]
        if secs < MIN_STINT_SEC_TOTAL or team_pts <= 0:
            continue
        leaderboard.append({
            "pcode": pcode, "player": pcode_name.get(pcode, pcode),
            "minutesOnCourt": round(secs / 60, 1),
            "teamPtsWhileOnCourt": round(team_pts, 1),
            "contributionPts": round(total_contrib.get(pcode, 0.0), 1),
            "contributionRate": round(total_contrib.get(pcode, 0.0) / team_pts, 3),
        })
    leaderboard.sort(key=lambda x: -x["contributionRate"])

    os.makedirs(ANALYSIS_DIR, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(leaderboard[:500], f, ensure_ascii=False, indent=1)

    print(f"Scoring Contribution Rate (코트위 누적 60분+) {len(leaderboard)}명 -> {OUT_PATH}", flush=True)
    for r in leaderboard[:10]:
        print(f"  {r['player']} 관여율 {r['contributionRate']*100:.1f}% ({r['minutesOnCourt']}분 누적)", flush=True)


if __name__ == "__main__":
    main()
