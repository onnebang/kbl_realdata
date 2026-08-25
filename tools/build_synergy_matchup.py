"""
라인업 스틴트(raw/stints/*.json) -> 선수 온코트 net rating / 2·3인 조합 시너지 / 매치업 효과.

로드맵 03단계 핵심 산출물. stint 하나 = "코트 위 10인 구성이 유지된 구간"이므로, 이 구간들을
선수(또는 선수 조합, 또는 상대 선수 조합) 기준으로 묶어 합산하면 아래를 직접 계산할 수 있다.

- 온코트 net rating: 그 선수가 코트에 있을 때 팀의 (득점-실점)을 40분 기준으로 환산
- N인 조합 시너지: 특정 N명이 "함께" 코트에 있었던 스틴트만 모아서 같은 방식으로 계산
  (2026-08-24 확장: 4·5인까지. `build_combos(n)`가 이미 완전히 일반화돼있어서 코드 변경 없이
  루프에 n만 추가하면 됨 - 5인은 사실상 "그 스틴트의 라인업 그 자체"라 조합 폭발 걱정 없음
  (한 스틴트당 5인 조합은 정확히 1개), 4인도 스틴트당 C(5,4)=5개뿐이라 계산량 문제 없음.
  다만 "정확히 이 N명"이 반복해서 함께 뛴 시간은 인원이 늘수록 자연히 줄어들어서 표본이
  희소해짐 - `--min-combo-sec`로 걸러지는 비율이 인원수 늘수록 커지는 게 정상)
- 매치업: 우리 팀 선수 A가 상대팀 선수 B와 "동시에" 코트에 있었던 스틴트를 모아서, 그 구간
  우리 팀의 net rating을 계산 (주의: 이건 실제 1대1 수비 매칭이 아니라 "동시 출전" 기준의
  co-occurrence 지표임 - 문자중계엔 개별 수비 배정 정보가 없어서 이게 낼 수 있는 최선의 근사치.
  README에도 이 한계를 명시해둘 것)

표본이 적은 조합(예: 단 한 스틴트, 30초)은 노이즈가 커서 min_seconds로 걸러낸다.
"""
import argparse
import itertools
import json
import os
from collections import defaultdict

STINTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "raw", "stints")
GAMES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "raw", "games")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "raw", "analysis")

QUARTER_ORDER = ["Q1", "Q2", "Q3", "Q4", "X1", "X2", "X3", "X4", "EQ1", "EQ2", "EQ3", "EQ4"]
QUARTER_LEN_SEC = {"Q1": 600, "Q2": 600, "Q3": 600, "Q4": 600}  # 그 외(연장)는 기본 300으로 처리


def quarter_len(q):
    return QUARTER_LEN_SEC.get(q, 300)


def cumulative_elapsed(q, m, s):
    idx = QUARTER_ORDER.index(q) if q in QUARTER_ORDER else len(QUARTER_ORDER)
    prior = sum(quarter_len(qq) for qq in QUARTER_ORDER[:idx])
    remaining = m * 60 + s
    return prior + (quarter_len(q) - remaining)


def stint_duration(stint):
    start = cumulative_elapsed(*stint["startClock"])
    end = cumulative_elapsed(*stint["endClock"])
    d = end - start
    return d if d > 0 else 0


def load_player_names():
    """pcode -> 한글 이름. 여러 경기에 걸쳐 있으니 raw/games를 훑으며 채운다(느리지만 1회성)."""
    names = {}
    for gmkey in os.listdir(GAMES_DIR):
        path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                rows = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        for row in rows:
            p = row.get("player", {})
            if p.get("pcode") and p.get("pname"):
                names[p["pcode"]] = p["pname"]
    return names


def iter_stints():
    for fn in os.listdir(STINTS_DIR):
        if not fn.endswith(".json") or fn.startswith("_"):
            continue
        with open(os.path.join(STINTS_DIR, fn), encoding="utf-8") as f:
            game = json.load(f)
        for s in game["stints"]:
            if not s.get("lineupValid"):
                continue
            dur = stint_duration(s)
            if dur <= 0:
                continue
            yield game["gmkey"], s, dur


def per40(pts_for, pts_against, seconds):
    if seconds <= 0:
        return None
    minutes = seconds / 60
    return (pts_for - pts_against) * 40 / minutes


def build_player_onoff(min_seconds=300):
    agg = defaultdict(lambda: {"for": 0, "against": 0, "sec": 0, "stints": 0})
    for gmkey, s, dur in iter_stints():
        for side, opp in (("home", "away"), ("away", "home")):
            pts_for = s[f"{side}Pts"]
            pts_against = s[f"{opp}Pts"]
            for pcode in s[f"{side}Lineup"]:
                a = agg[pcode]
                a["for"] += pts_for
                a["against"] += pts_against
                a["sec"] += dur
                a["stints"] += 1
    out = []
    for pcode, a in agg.items():
        if a["sec"] < min_seconds:
            continue
        out.append({
            "pcode": pcode,
            "seconds": a["sec"],
            "minutes": round(a["sec"] / 60, 1),
            "stints": a["stints"],
            "ptsFor": a["for"],
            "ptsAgainst": a["against"],
            "netRatingPer40": round(per40(a["for"], a["against"], a["sec"]), 2),
        })
    out.sort(key=lambda r: -r["seconds"])
    return out


def build_combos(n, min_seconds=180):
    agg = defaultdict(lambda: {"for": 0, "against": 0, "sec": 0, "stints": 0})
    for gmkey, s, dur in iter_stints():
        for side, opp in (("home", "away"), ("away", "home")):
            pts_for = s[f"{side}Pts"]
            pts_against = s[f"{opp}Pts"]
            lineup = s[f"{side}Lineup"]
            if len(lineup) < n:
                continue
            for combo in itertools.combinations(sorted(lineup), n):
                a = agg[combo]
                a["for"] += pts_for
                a["against"] += pts_against
                a["sec"] += dur
                a["stints"] += 1
    out = []
    for combo, a in agg.items():
        if a["sec"] < min_seconds:
            continue
        out.append({
            "pcodes": list(combo),
            "seconds": a["sec"],
            "minutes": round(a["sec"] / 60, 1),
            "stints": a["stints"],
            "netRatingPer40": round(per40(a["for"], a["against"], a["sec"]), 2),
        })
    out.sort(key=lambda r: -r["seconds"])
    return out


def build_matchups(min_seconds=180):
    """우리팀 선수 pcode -> 상대팀 선수 pcode 동시출전 net rating (co-occurrence, 실제 1대1 수비 아님)."""
    agg = defaultdict(lambda: {"for": 0, "against": 0, "sec": 0, "stints": 0})
    for gmkey, s, dur in iter_stints():
        for side, opp in (("home", "away"), ("away", "home")):
            pts_for = s[f"{side}Pts"]
            pts_against = s[f"{opp}Pts"]
            for me in s[f"{side}Lineup"]:
                for foe in s[f"{opp}Lineup"]:
                    a = agg[(me, foe)]
                    a["for"] += pts_for
                    a["against"] += pts_against
                    a["sec"] += dur
                    a["stints"] += 1
    out = []
    for (me, foe), a in agg.items():
        if a["sec"] < min_seconds:
            continue
        out.append({
            "pcode": me,
            "vsPcode": foe,
            "seconds": a["sec"],
            "minutes": round(a["sec"] / 60, 1),
            "netRatingPer40": round(per40(a["for"], a["against"], a["sec"]), 2),
        })
    out.sort(key=lambda r: -r["seconds"])
    return out


def attach_names(rows, names, key_fields):
    for r in rows:
        for kf in key_fields:
            code = r[kf]
            r[kf.replace("pcode", "name").replace("Pcode", "Name")] = names.get(code, code)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-onoff-sec", type=int, default=300)
    ap.add_argument("--min-combo-sec", type=int, default=180)
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    print("선수 이름 로딩...", flush=True)
    names = load_player_names()
    print(f"  {len(names)}명", flush=True)

    print("온/오프코트 net rating 계산...", flush=True)
    onoff = build_player_onoff(args.min_onoff_sec)
    attach_names(onoff, names, ["pcode"])
    with open(os.path.join(OUT_DIR, "player_onoff.json"), "w", encoding="utf-8") as f:
        json.dump(onoff, f, ensure_ascii=False, indent=1)
    print(f"  선수 {len(onoff)}명 (표본 {args.min_onoff_sec}초 이상)", flush=True)

    for n in (2, 3, 4, 5):
        print(f"{n}인 조합 시너지 계산...", flush=True)
        combos = build_combos(n, args.min_combo_sec)
        attach_names(combos, names, [])  # pcodes는 리스트라 아래서 별도 처리
        for r in combos:
            r["names"] = [names.get(p, p) for p in r["pcodes"]]
        with open(os.path.join(OUT_DIR, f"combo_{n}man.json"), "w", encoding="utf-8") as f:
            json.dump(combos, f, ensure_ascii=False, indent=1)
        print(f"  조합 {len(combos)}개 (표본 {args.min_combo_sec}초 이상)", flush=True)

    print("매치업(동시출전) net rating 계산...", flush=True)
    matchups = build_matchups(args.min_combo_sec)
    attach_names(matchups, names, ["pcode", "vsPcode"])
    with open(os.path.join(OUT_DIR, "matchups.json"), "w", encoding="utf-8") as f:
        json.dump(matchups, f, ensure_ascii=False, indent=1)
    print(f"  매치업 {len(matchups)}쌍 (표본 {args.min_combo_sec}초 이상)", flush=True)

    print("완료 ->", OUT_DIR, flush=True)


if __name__ == "__main__":
    main()
