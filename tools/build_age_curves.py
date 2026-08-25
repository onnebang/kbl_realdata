"""
포지션별 나이-기량 곡선 (2026-08-20, 사용자 요청) - "가드는 나이 들수록 어시스트가 늘고 덩크는
주는지" 같은 걸 실제 KBL 데이터로 확인.

**왜 NBA/일본/중국 데이터를 안 빌려왔나**: 15시즌치 KBL 자체 데이터에 3시즌 이상 뛴 선수가
432명(전체 773명 중)이나 있어서, 굳이 다른 리그(신체조건·플레이스타일·경쟁강도가 다른) 데이터를
가져와 보정하는 것보다 KBL 데이터로 직접 계산하는 게 더 정확함. 표본이 부족한 스탯/포지션이
나오면 그때 외부 데이터를 참고하는 걸 재검토하면 됨.

**Delta 방법(세이버메트릭스 표준 기법)** - 그냥 "27세 선수들 평균 vs 28세 선수들 평균"을 비교하면
생존 편향(survivorship bias)에 걸림: 못하는 선수는 나이 들기 전에 리그를 떠나서, 나이 많은
그룹엔 애초에 잘하는 선수만 남아있어 "나이 들수록 좋아진다"는 착시가 생김. 대신 **같은 선수의
연속 두 시즌**(나이 N -> N+1) 사이의 변화량(delta)만 모아서, 그 나이 전환 구간에서 실제로 얼마나
좋아지거나 나빠졌는지를 재고, 그 델타들을 나이순으로 누적합해서 곡선을 그린다. 이러면 "이 나이
그룹에 누가 남아있는가"가 아니라 "실제로 그 나이를 지나며 얼마나 변했는가"만 반영됨.

델타는 두 시즌 중 적은 쪽 출전시간으로 가중평균(표본 적은 전환을 덜 믿음).
"""
import json
import os
from collections import defaultdict

import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
OUT_PATH = os.path.join(ANALYSIS_DIR, "age_curves.json")

# per36 = 36분 기준으로 환산(출전시간 차이 통제). rate류(per/usgRt 등)는 이미 비율이라 그대로.
# 2026-08-20 확장(사용자 요청) - 1차/2차 스탯 전부 비교. 공격효율=offrtg, 수비효율=defrtg,
# 수비력=drebRt(수비리바운드율)+bs+stl, 종합가치=per/pie 두 개(서로 다른 산출식이라 교차검증됨.
COUNTING_STATS = ["score", "rb", "ast", "stl", "bs", "dk", "threep", "ft", "fg", "to", "foul"]
RATE_STATS = ["per", "pie", "usgRt", "astRt", "tovRt", "rebRt", "efgRt", "tsRt",
              "offrtg", "defrtg", "netrtg", "orebRt", "drebRt", "astTo", "astRatio"]
MIN_SEASON_MINUTES = 200  # 이보다 적게 뛴 시즌은 표본 신뢰 안 함(가비지타임 위주 시즌 배제)
AGE_RANGE = range(19, 38)


def season_year(season_name):
    """'2021-2022' -> 2021 (연령 계산 기준 시즌 시작연도)."""
    try:
        return int(season_name[:4])
    except (ValueError, TypeError):
        return None


def load_player_season_stats():
    """pcode -> [{seasonCode, seasonYear, position, minutes, stats:{...per36/rate}}] (시즌순 정렬)."""
    with open(os.path.join(ANALYSIS_DIR, "player_bio.json"), encoding="utf-8") as f:
        bio = json.load(f)

    by_player_season = defaultdict(lambda: {"minutes": 0.0, "posCount": defaultdict(float),
                                             "sums": defaultdict(float), "seasonCode": None, "seasonYear": None})
    for gmkey in os.listdir(GAMES_DIR):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        pstat_path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
        if not (os.path.exists(meta_path) and os.path.exists(pstat_path)):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        season_code = meta["game"].get("seasonCode")
        season_year_v = season_year(meta["game"].get("seasonName"))
        with open(pstat_path, encoding="utf-8") as f:
            rows = json.load(f)
        for row in rows:
            p, r = row["player"], row["records"]
            minutes = (r.get("playMin") or 0) + (r.get("playSec") or 0) / 60
            if minutes <= 0:
                continue
            key = (p["pcode"], season_code)
            agg = by_player_season[key]
            agg["seasonCode"] = season_code
            agg["seasonYear"] = season_year_v
            agg["minutes"] += minutes
            agg["posCount"][p.get("pos")] += minutes
            for stat in COUNTING_STATS:
                agg["sums"][stat] += (r.get(stat) or 0)
            for stat in RATE_STATS:
                val = r.get(stat)
                if val is not None:
                    agg["sums"][stat] += val * minutes  # 분가중평균 위해 분 곱해서 누적
                    agg["sums"][f"{stat}_wsum"] += minutes

    by_player = defaultdict(list)
    for (pcode, season_code), agg in by_player_season.items():
        if agg["minutes"] < MIN_SEASON_MINUTES:
            continue
        pos = max(agg["posCount"], key=agg["posCount"].get) if agg["posCount"] else None
        stats = {}
        for stat in COUNTING_STATS:
            stats[stat] = agg["sums"][stat] * 36 / agg["minutes"]  # per-36
        for stat in RATE_STATS:
            wsum = agg["sums"].get(f"{stat}_wsum", 0)
            stats[stat] = agg["sums"][stat] / wsum if wsum > 0 else None
        by_player[pcode].append({
            "seasonCode": season_code, "seasonYear": agg["seasonYear"], "position": pos,
            "minutes": round(agg["minutes"], 1), "stats": stats,
        })

    for pcode in by_player:
        by_player[pcode].sort(key=lambda s: s["seasonCode"])

    return by_player, bio


def build_deltas(by_player, bio):
    """(position, age, stat) -> [(delta, weight)] - age는 '이전' 시즌 기준 나이(그 나이에서
    다음 나이로 넘어가며 얼마나 변했는지)."""
    deltas = defaultdict(list)
    for pcode, seasons in by_player.items():
        b = bio.get(pcode)
        if not b or not b.get("birthDate"):
            continue
        for i in range(len(seasons) - 1):
            s0, s1 = seasons[i], seasons[i + 1]
            if s1["seasonCode"] - s0["seasonCode"] != 2:  # 연속 시즌만(시즌코드 2씩 증가가 연속)
                continue
            age0 = age_at_season(b["birthDate"], s0["seasonYear"])
            if age0 is None or age0 not in AGE_RANGE:
                continue
            pos = s0["position"] or s1["position"]
            if pos not in ("GD", "FD", "C"):
                continue
            weight = min(s0["minutes"], s1["minutes"])
            for stat in COUNTING_STATS + RATE_STATS:
                v0, v1 = s0["stats"].get(stat), s1["stats"].get(stat)
                if v0 is None or v1 is None:
                    continue
                deltas[(pos, age0, stat)].append((v1 - v0, weight))
    return deltas


def age_at_season(birth_date_str, season_year_v):
    if not birth_date_str or season_year_v is None:
        return None
    import datetime
    bd = datetime.datetime.strptime(birth_date_str, "%Y-%m-%d")
    ref = datetime.datetime(season_year_v, 11, 1)  # 시즌 개막 시점(11월 초 근사) 기준 나이
    return ref.year - bd.year - ((ref.month, ref.day) < (bd.month, bd.day))


def build_curves(deltas):
    """포지션별/스탯별로 나이 전환 평균 델타 -> 누적합으로 곡선 재구성. 20세를 기준점(0)으로 잡음."""
    curves = {}
    sample_counts = {}
    for pos in ("GD", "FD", "C"):
        for stat in COUNTING_STATS + RATE_STATS:
            avg_delta_by_age = {}
            n_by_age = {}
            for age in AGE_RANGE:
                pairs = deltas.get((pos, age, stat), [])
                if len(pairs) < 5:  # 표본 5쌍 미만인 전환 구간은 건너뜀(곡선에서 그 구간만 결측)
                    continue
                total_w = sum(w for _, w in pairs)
                avg_delta_by_age[age] = sum(d * w for d, w in pairs) / total_w
                n_by_age[age] = len(pairs)

            # 20세부터 누적합 (20세 이전 데이터 없으면 그냥 관측된 첫 나이부터 0 시작)
            ages_sorted = sorted(avg_delta_by_age.keys())
            if not ages_sorted:
                continue
            curve = {}
            cum = 0.0
            curve[ages_sorted[0]] = 0.0
            for age in ages_sorted:
                cum += avg_delta_by_age[age]
                curve[age + 1] = round(cum, 3)
            curves[f"{pos}|{stat}"] = curve
            sample_counts[f"{pos}|{stat}"] = n_by_age
    return curves, sample_counts


# tovRt(턴오버율)는 낮을수록 좋은 스탯이라 "최고점"이 아니라 "최저점"이 진짜 전성기.
# 이걸 구분 안 하면 "턴오버율 전성기 21세"처럼 사실은 최악의 지점을 전성기라고 잘못 표시하게 됨.
LOWER_IS_BETTER = {"tovRt", "to", "foul", "defrtg"}  # defrtg는 낮을수록(실점 적을수록) 좋은 지표


def find_peak_ages(curves):
    peaks = {}
    for key, curve in curves.items():
        if not curve:
            continue
        stat = key.split("|")[1]
        peak_age = min(curve, key=curve.get) if stat in LOWER_IS_BETTER else max(curve, key=curve.get)
        peaks[key] = peak_age
    return peaks


def main():
    print("선수-시즌 집계 중...", flush=True)
    by_player, bio = load_player_season_stats()
    print(f"  {len(by_player)}명, 시즌평균 {sum(len(v) for v in by_player.values())}건 (최소 {MIN_SEASON_MINUTES}분 이상)", flush=True)

    print("나이 전환 델타 계산 중...", flush=True)
    deltas = build_deltas(by_player, bio)
    total_pairs = sum(len(v) for v in deltas.values())
    print(f"  나이전환 쌍 {total_pairs}건", flush=True)

    curves, sample_counts = build_curves(deltas)
    peaks = find_peak_ages(curves)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"curves": curves, "sampleCounts": sample_counts, "peakAges": peaks}, f, ensure_ascii=False, indent=1)

    print("\n=== 포지션별 스탯별 전성기 나이 (delta 누적곡선 최고점) ===", flush=True)
    pos_names = {"GD": "가드", "FD": "포워드", "C": "센터"}
    for pos in ("GD", "FD", "C"):
        print(f"\n[{pos_names[pos]}]", flush=True)
        for stat in COUNTING_STATS + RATE_STATS:
            key = f"{pos}|{stat}"
            if key in peaks:
                n_total = sum(sample_counts[key].values())
                print(f"  {stat:<10} 전성기 {peaks[key]}세  (표본 {n_total}쌍)", flush=True)

    print(f"\n-> {OUT_PATH}", flush=True)


if __name__ == "__main__":
    main()
