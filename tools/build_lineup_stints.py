"""
문자중계 이벤트 로그(text-cast) -> 라인업 스틴트(stint) 재구성.

"스틴트" = 코트 위 10인(홈5+원정5) 구성이 바뀌지 않고 유지된 구간. 교체(101=IN/102=OUT)
이벤트가 나올 때마다 새 스틴트로 끊고, 그 구간에 각 팀이 득점한 점수를 기록한다.
이 stint 단위 데이터가 온/오프코트 net rating, 2·3인 시너지, 매치업 계산의 원재료가 된다.

text-cast엔 pcode가 없고 선수 이름(p)+팀코드(t)만 있어서, player-stat.json에서
(팀코드,이름) -> pcode 매핑을 만들어 조인한다. 동시에 여러 명이 한 타이밍(같은 분:초)에
교체되는 경우(쿼터 시작/막판 대량 교체)는 한 번에 묶어서 처리 - 안 그러면 0점짜리
찰나의 스틴트가 우수수 생김.

검증: 스틴트별 득점 합계가 최종 스코어와 정확히 일치해야 함(자유투 포함, 필드골+자유투로
구성된 실제 득점 이벤트만 집계하므로). 이 스크립트가 그 검증을 자동으로 수행한다.
"""
import argparse
import json
import os

RAW_GAMES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "raw", "games")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "raw", "stints")

# KBL 정규쿼터 10분, 연장 5분 (표준 규정 기준 가정 - 실제 라벨은 EQ1~EQ4)
QUARTER_LEN_SEC = {"Q1": 600, "Q2": 600, "Q3": 600, "Q4": 600,
                   "EQ1": 300, "EQ2": 300, "EQ3": 300, "EQ4": 300}
SCORE_CODES = {"201": 2, "205": 3, "203": 1, "207": 2}  # 2점슛성공/3점슛성공/자유투성공/덩크슛성공
SUB_CODES = {"101", "102"}


def clock_key(evt):
    return (evt["q"], evt["m"], evt["s"])


def elapsed_in_quarter(evt):
    total = QUARTER_LEN_SEC.get(evt["q"], 600)
    remaining = evt["m"] * 60 + evt["s"]
    return total - remaining


def build_name_lookup(pstat):
    name_to_pcode = {}
    starters = {}
    for row in pstat:
        p = row["player"]
        t = p["tcode"]
        name_to_pcode[(t, p["pname"])] = p["pcode"]
        starters.setdefault(t, set())
        if row.get("startFlag") == 1:
            starters[t].add(p["pcode"])
    return name_to_pcode, starters


def build_game_stints(game_dir, gmkey):
    with open(os.path.join(game_dir, "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
    with open(os.path.join(game_dir, "player-stat.json"), encoding="utf-8") as f:
        pstat = json.load(f)
    with open(os.path.join(game_dir, "text-cast.json"), encoding="utf-8") as f:
        events = json.load(f)

    home_code = meta["game"]["tcodeH"]
    away_code = meta["game"]["tcodeA"]
    name_to_pcode, starters = build_name_lookup(pstat)

    on_court = {home_code: set(starters.get(home_code, set())),
                away_code: set(starters.get(away_code, set()))}

    stints = []
    issues = []
    cur_start_evt = events[0] if events else None
    cur_points = {home_code: 0, away_code: 0}
    cur_quarters = set()

    def flush(end_evt):
        if cur_start_evt is None:
            return
        # 쿼터 경계에서 "이전 쿼터 5인 전원 OUT" -> "다음 쿼터 5인 전원 IN"이 서로 다른
        # (쿼터,시각) 배치로 따로 찍혀서, 그 사이에 양팀 다 0명인 찰나의 빈 스틴트가 생김.
        # 실제 플레이 구간이 아니므로 건너뛴다.
        if not on_court[home_code] and not on_court[away_code]:
            return
        stints.append({
            "homeLineup": sorted(on_court[home_code]),
            "awayLineup": sorted(on_court[away_code]),
            "lineupValid": len(on_court[home_code]) == 5 and len(on_court[away_code]) == 5,
            "quarters": sorted(cur_quarters, key=lambda q: (len(q), q)),
            "startClock": clock_key(cur_start_evt),
            "endClock": clock_key(end_evt),
            "homePts": cur_points[home_code],
            "awayPts": cur_points[away_code],
        })

    i = 0
    n = len(events)
    while i < n:
        evt = events[i]
        if evt.get("a") in SUB_CODES:
            batch_key = clock_key(evt)
            batch = []
            while i < n and events[i].get("a") in SUB_CODES and clock_key(events[i]) == batch_key:
                batch.append(events[i])
                i += 1
            flush(evt)
            for e in batch:
                t = e.get("t")
                pcode = name_to_pcode.get((t, e.get("p")))
                if pcode is None:
                    issues.append({"gmkey": gmkey, "evt": e, "reason": "unknown player (name/team lookup miss)"})
                    continue
                if e["a"] == "101":
                    on_court[t].add(pcode)
                else:
                    on_court[t].discard(pcode)
            cur_start_evt = evt
            cur_points = {home_code: 0, away_code: 0}
            cur_quarters = {evt["q"]}
        else:
            if evt.get("a") in SCORE_CODES and evt.get("t") in cur_points:
                cur_points[evt["t"]] += SCORE_CODES[evt["a"]]
            cur_quarters.add(evt["q"])
            i += 1

    if events:
        flush(events[-1])

    return {
        "gmkey": gmkey,
        "homeCode": home_code,
        "awayCode": away_code,
        "finalHome": meta["game"].get("scoreH")
        if "scoreH" in meta["game"] else None,
        "stints": stints,
    }, issues


def validate(game_stints, meta):
    home_code = game_stints["homeCode"]
    away_code = game_stints["awayCode"]
    sum_home = sum(s["homePts"] for s in game_stints["stints"])
    sum_away = sum(s["awayPts"] for s in game_stints["stints"])
    tr = meta["teamrecords"]
    actual_home = sum(tr["home"].get(f"scoreq{i}", 0) for i in (1, 2, 3, 4)) + sum(tr["home"].get("scoreeq", []) or [])
    actual_away = sum(tr["away"].get(f"scoreq{i}", 0) for i in (1, 2, 3, 4)) + sum(tr["away"].get("scoreeq", []) or [])
    return {
        "sumHome": sum_home, "actualHome": actual_home, "homeMatch": sum_home == actual_home,
        "sumAway": sum_away, "actualAway": actual_away, "awayMatch": sum_away == actual_away,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gmkey", help="특정 경기 하나만 처리 (테스트용)")
    ap.add_argument("--limit", type=int, default=None, help="처리할 경기 수 제한")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    gmkeys = [args.gmkey] if args.gmkey else sorted(os.listdir(RAW_GAMES_DIR))
    if args.limit:
        gmkeys = gmkeys[: args.limit]

    all_issues = []
    mismatch_count = 0
    ok_count = 0
    for gmkey in gmkeys:
        game_dir = os.path.join(RAW_GAMES_DIR, gmkey)
        needed = ["meta.json", "player-stat.json", "text-cast.json"]
        if not all(os.path.exists(os.path.join(game_dir, f)) for f in needed):
            continue
        with open(os.path.join(game_dir, "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        result, issues = build_game_stints(game_dir, gmkey)
        all_issues.extend(issues)
        check = validate(result, meta)
        result["validation"] = check
        with open(os.path.join(OUT_DIR, f"{gmkey}.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
        if check["homeMatch"] and check["awayMatch"]:
            ok_count += 1
        else:
            mismatch_count += 1
            print(f"  [MISMATCH] {gmkey}: home {check['sumHome']}/{check['actualHome']}, "
                  f"away {check['sumAway']}/{check['actualAway']}")

    print(f"\n처리 완료: {ok_count + mismatch_count}경기 (점수 일치 {ok_count} / 불일치 {mismatch_count})")
    if all_issues:
        print(f"선수 조인 실패 이벤트: {len(all_issues)}건")
        with open(os.path.join(OUT_DIR, "_issues.json"), "w", encoding="utf-8") as f:
            json.dump(all_issues, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
