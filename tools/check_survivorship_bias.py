"""
생존 편향 직접 점검 (2026-08-20, 사용자 지적 - "10~20년 프로 생활을 이어가는 선수는 잘하는
선수만 남는다"). build_age_curves.py의 delta 방법은 "같은 선수 내 변화"만 봐서 단순 횡단비교
(21세 평균 vs 30세 평균)의 생존편향은 피하지만, **그 자체로 생존편향을 완전히 없애진 못한다** -
33->34세 전환을 관측하려면 그 선수가 33세까지 살아남고 34세에도 충분한 출전시간을 받아야 하는데,
그 조건 자체가 이미 "잘 버틴 선수"로 걸러진 표본임. 하락이 심해서 로테이션에서 밀린 선수는
애초에 델타 관측치를 남기지 못하고 표본에서 사라짐.

이걸 "고치는" 건 아니고(고치려면 mixed-effects 모델 등 훨씬 큰 작업), **얼마나 심한지 직접
재는** 게 이 스크립트의 목적:
1. 나이별 생존율(다음 시즌까지 충분한 출전시간으로 남아있는 비율) - 선택압이 실제로 얼마나
   강한지 정량화
2. "장기 생존자"(경력 8시즌 이상)가 데뷔 시즌부터 이미 더 잘했는지 - "잘하는 선수만 남는다"는
   가설을 직접 검증
3. 장기 생존자 코호트만으로 나이곡선을 다시 그려서, 전체 표본 곡선과 모양이 다른지 비교 -
   다르면 원래 곡선의 "말년 반등"이 생존편향 때문일 가능성이 큼
"""
import json
import os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")

import build_age_curves as bac  # 기존 선수-시즌 집계/델타 로직 재사용

LONG_CAREER_SEASONS = 8  # 이 이상 시즌을 뛰면 "장기 생존자"로 분류


def survival_rates(by_player):
    """나이 N에 충분한 출전시간으로 뛴 선수 중, N+1에도 그런 선수가 몇 %인지."""
    active_at = defaultdict(set)  # age -> {pcode}
    with open(os.path.join(ANALYSIS_DIR, "player_bio.json"), encoding="utf-8") as f:
        bio = json.load(f)
    for pcode, seasons in by_player.items():
        b = bio.get(pcode)
        if not b or not b.get("birthDate"):
            continue
        for s in seasons:
            age = bac.age_at_season(b["birthDate"], s["seasonYear"])
            if age is not None:
                active_at[age].add(pcode)

    rates = {}
    for age in sorted(active_at):
        cur = active_at[age]
        nxt = active_at.get(age + 1, set())
        # "연속 시즌으로 살아남음" 근사: 다음 나이에도 활동중인 선수 비율 (군복무 등 공백 포함 -
        # 공백까지 포함한 "그 나이 이후 커리어가 끊기지 않았는지"를 보는 관대한 지표)
        survived = len(cur & nxt)
        rates[age] = {"activeCount": len(cur), "survivedNextAge": survived,
                      "survivalRate": round(survived / len(cur), 3) if cur else None}
    return rates


def classify_career_length(by_player):
    """pcode -> 그 선수가 뛴 총 시즌 수(충분한 출전시간 기준)."""
    return {pcode: len(seasons) for pcode, seasons in by_player.items()}


def compare_debut_performance(by_player, career_length, bio):
    """장기생존자(8시즌+) vs 단기생존자의 '데뷔 시즌(첫 유효시즌)' 성적 비교."""
    long_debuts, short_debuts = [], []
    for pcode, seasons in by_player.items():
        if not seasons:
            continue
        debut = seasons[0]
        per = debut["stats"].get("per")
        if per is None:
            continue
        if career_length[pcode] >= LONG_CAREER_SEASONS:
            long_debuts.append(per)
        else:
            short_debuts.append(per)
    return {
        "longCareer": {"n": len(long_debuts), "avgDebutPER": round(sum(long_debuts) / len(long_debuts), 2) if long_debuts else None},
        "shortCareer": {"n": len(short_debuts), "avgDebutPER": round(sum(short_debuts) / len(short_debuts), 2) if short_debuts else None},
    }


def build_cohort_curve(by_player, bio, career_length, min_seasons):
    """career_length >= min_seasons인 선수만으로 아까와 같은 delta 곡선 재구성."""
    filtered = {pcode: seasons for pcode, seasons in by_player.items() if career_length.get(pcode, 0) >= min_seasons}
    deltas = bac.build_deltas(filtered, bio)
    curves, sample_counts = bac.build_curves(deltas)
    peaks = bac.find_peak_ages(curves)
    return curves, sample_counts, peaks


def main():
    print("선수-시즌 집계 중...", flush=True)
    by_player, bio = bac.load_player_season_stats()

    print("\n=== 1) 나이별 생존율 (다음 나이까지 충분출전 유지) ===", flush=True)
    rates = survival_rates(by_player)
    for age in sorted(rates):
        r = rates[age]
        if r["activeCount"] >= 5:
            print(f"  {age}세: 활동 {r['activeCount']}명 -> 다음나이 생존 {r['survivedNextAge']}명 ({r['survivalRate']*100:.0f}%)", flush=True)

    career_length = classify_career_length(by_player)
    long_career_n = sum(1 for v in career_length.values() if v >= LONG_CAREER_SEASONS)
    print(f"\n=== 2) 장기생존자(≥{LONG_CAREER_SEASONS}시즌) 데뷔시즌 성적 비교 ===", flush=True)
    print(f"  장기생존자: {long_career_n}명 / 전체 {len(career_length)}명", flush=True)
    debut_cmp = compare_debut_performance(by_player, career_length, bio)
    print(f"  장기생존자 데뷔시즌 평균 PER: {debut_cmp['longCareer']['avgDebutPER']} (n={debut_cmp['longCareer']['n']})", flush=True)
    print(f"  단기생존자 데뷔시즌 평균 PER: {debut_cmp['shortCareer']['avgDebutPER']} (n={debut_cmp['shortCareer']['n']})", flush=True)

    print(f"\n=== 3) 장기생존자만으로 나이곡선 재구성 (전체 곡선과 비교) ===", flush=True)
    cohort_curves, cohort_counts, cohort_peaks = build_cohort_curve(by_player, bio, career_length, LONG_CAREER_SEASONS)

    with open(os.path.join(ANALYSIS_DIR, "age_curves.json"), encoding="utf-8") as f:
        full = json.load(f)

    print(f"  {'스탯':<10}{'전체표본 전성기':<16}{'장기생존자만 전성기':<18}", flush=True)
    for pos in ("GD", "FD"):  # 센터는 장기생존자 표본이 너무 적을 수 있어 GD/FD만
        print(f"  [{pos}]", flush=True)
        for stat in bac.COUNTING_STATS + bac.RATE_STATS:
            key = f"{pos}|{stat}"
            full_peak = full["peakAges"].get(key, "-")
            cohort_peak = cohort_peaks.get(key, "-")
            cohort_n = sum(cohort_counts.get(key, {}).values())
            print(f"    {stat:<10}{str(full_peak):<16}{str(cohort_peak)+f' (표본{cohort_n})':<18}", flush=True)

    out = {
        "survivalRates": rates,
        "careerLengthDistribution": {str(k): v for k, v in
                                      __import__("collections").Counter(career_length.values()).items()},
        "debutPerformanceComparison": debut_cmp,
        "longCareerCohortCurves": cohort_curves,
        "longCareerCohortSampleCounts": cohort_counts,
        "longCareerCohortPeaks": cohort_peaks,
    }
    out_path = os.path.join(ANALYSIS_DIR, "survivorship_check.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\n-> {out_path}", flush=True)


if __name__ == "__main__":
    main()
