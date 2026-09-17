# -*- coding: utf-8 -*-
"""
2K/FC류 게임처럼 "완만하게" 움직이는 오버롤(OVR) 곡선 모델.

raw_performance(그 시즌 실제 활약도, 0~99 스케일 가정)를 그대로 쓰지 않고 세 단계를 거쳐
calculated_ovr을 만든다:

  1) 최근 3시즌 가중평균으로 급격한 등락을 1차로 완화(smoothing)
  2) 나이 곡선(성장기 보너스 / 전성기 유지 / 은퇴기 강제 하락)을 곱해서 반영
  3) 커리어 최고 기록(peak)이 높을수록 하락 저항력도 커지는 등급표(TIERS)를 적용
     (르브론 제임스급은 한 시즌 부진해도 명성 덕에 거의 안 떨어지고, 반대로 등급표
     맨 아래 칸에 걸리는 선수는 저항력 0 - 나이와 부진이 겹치면 그대로 폭락한다)

한 번이라도 90을 넘긴 선수만 특별 취급하는 이분법 대신, "역대 NBA 2K 사례를 보면 등급별로
방어력 자체가 다르게 설계돼 있다"는 요청에 맞춰 TIERS를 4단계 연속 구간표로 뒀다 - peak가
오를수록 자동으로 상위 구간으로 승급하고(반스처럼 계속 낮으면 승급 자체가 없음), 등급별
숫자는 요청에서 주신 실제 2K 사례(르브론/커리/듀란트=최상위, 하든/웨스트브룩/조지=상위이되
편차 큼, 반스/아담스=중위 방어력 0, 토마스/히버트=하위 급락)를 참고해 잡았다.

시즌 순서대로(오래된 시즌 -> 최신 시즌) 한 선수 안에서 순차 처리해야 하는 상태(최근 3시즌
이력, 누적 최고 기록)가 있어서 클래스로 감쌌다 - 함수 하나로도 되지만 이 상태를 매번
인자로 들고 다니는 것보다 낫다.
"""
from dataclasses import dataclass


@dataclass
class OvrCurveModel:
    # 1) 최근 3시즌 가중치 - 당해 50%, 전년 30%, 2년 전 20%. 이력이 3시즌 미만이면
    #    있는 만큼만 쓰고 그 가중치 합으로 나눠 재정규화한다.
    weights: tuple = (0.50, 0.30, 0.20)

    # 2) 나이 구간
    growth_lo: int = 18
    growth_hi: int = 23   # 이 나이까지는 성장기, 24세부터 전성기 시작
    peak_hi: int = 29     # 24~29세 전성기, 30세부터 하락기
    growth_max_bonus: float = 0.10   # growth_lo세일 때 최대 +10% 보너스(잠재력 1.0 기준)
    decline_rate: float = 0.025      # 하락기 매년 복리로 -2.5%(등급별 저항력 적용 전 기준값)

    # 3) 등급별 하락 저항력 - (이 peak 이상이면, 하락률 저항 비율, 부진시 peak쪽 견인 비율).
    #    peak 기준 내림차순으로 처음 맞는 구간을 쓴다. 맨 아래 (0, 0.0, 0.0)은 등급표 밖 -
    #    저항력 0(=순수 에이징+실측 그대로), 즉 명성 방어가 전혀 없다.
    tiers: tuple = (
        (90.0, 0.65, 0.50),   # MVP/레전드급 - 르브론·커리·듀란트: 부상/부진에도 거의 안 떨어짐
        (85.0, 0.35, 0.25),   # 올스타급 - 하든·웨스트브룩처럼 스탯이 진짜 무너지면 결국 뚫림
        (78.0, 0.10, 0.05),   # 준수한 주전급 - 반스·아담스: 방어력 거의 없이 스탯에 정직
        (0.0, 0.0, 0.0),      # 그 외 - 토마스·히버트: 나이+부진 겹치면 브레이크 없이 폭락
    )

    ovr_floor: float = 40.0
    ovr_ceiling: float = 99.0

    def _tier_for(self, career_peak: float) -> tuple[float, float]:
        """career_peak(지금까지의 최고 calculated_ovr)에 맞는 (하락 저항력, 부진 방어력) 반환."""
        for min_peak, aging_resistance, perf_buffer in self.tiers:
            if career_peak >= min_peak:
                return aging_resistance, perf_buffer
        return 0.0, 0.0

    def _weighted_recent(self, raws: list[float]) -> float:
        """raws[-1]이 당해 시즌. 최근 self.weights 길이만큼(기본 3시즌) 가중평균."""
        window = raws[-len(self.weights):][::-1]  # [당해, 전년, 2년전, ...]
        used_weights = self.weights[: len(window)]
        total_w = sum(used_weights)
        return sum(v * w for v, w in zip(window, used_weights)) / total_w

    def _age_multiplier(self, age: int, potential: float) -> float:
        if age <= self.growth_lo:
            return 1.0 + self.growth_max_bonus * potential
        if age < self.growth_hi + 1:  # 성장기: growth_lo~growth_hi, 선형으로 보너스 감소
            span = (self.growth_hi - self.growth_lo) or 1
            frac = (self.growth_hi - age) / span
            return 1.0 + self.growth_max_bonus * potential * frac
        if age <= self.peak_hi:  # 전성기: 보정 없음
            return 1.0
        return None  # 하락기는 슈퍼스타 여부에 따라 감쇠율이 달라져 호출부에서 따로 계산

    def process_player(self, seasons: list[dict]) -> list[dict]:
        """seasons: [{"season","age","raw_performance", ["potential"]}, ...] 오래된 시즌부터.
        각 항목에 calculated_ovr을 채운 새 리스트를 반환한다(원본은 건드리지 않음)."""
        out = []
        raw_history: list[float] = []
        career_peak = 0.0

        for row in seasons:
            age = row["age"]
            raw = row["raw_performance"]
            potential = row.get("potential", 1.0)
            raw_history.append(raw)

            # 등급은 "지금까지 증명한 최고치"로 매 시즌 다시 정한다 - 반스처럼 계속 낮으면
            # 영영 승급이 없고, 반대로 새 커리어 하이를 찍으면 다음 시즌부터 더 두꺼운
            # 방어력을 받는다(2K가 시즌 중 실시간으로 등급을 재산정하는 것과 같은 효과).
            aging_resistance, perf_buffer = self._tier_for(career_peak)

            smoothed = self._weighted_recent(raw_history)

            if age <= self.peak_hi:
                mult = self._age_multiplier(age, potential)
                value = smoothed * mult
            else:
                # 하락기: 등급이 높을수록 decline_rate 자체를 깎아서 적용, 매년 복리
                rate = self.decline_rate * (1 - aging_resistance)
                years_past_peak = age - self.peak_hi
                value = smoothed * ((1 - rate) ** years_past_peak)

            # 부진 방어: 이번 시즌 값이 커리어 최고치보다 낮으면, 그 격차의 일부(등급별
            # perf_buffer)를 "명성"으로 메운다. 등급표 밖(perf_buffer=0)이면 이 줄은
            # 아무 효과가 없어 실측 그대로 반영된다 - 하나의 식으로 등급 차이를 통일했다.
            if value < career_peak:
                value = value * (1 - perf_buffer) + career_peak * perf_buffer

            value = max(self.ovr_floor, min(self.ovr_ceiling, value))

            out.append({**row, "calculated_ovr": round(value, 1)})

            career_peak = max(career_peak, value)

        return out


def _plot_on_ax(ax, rows: list[dict], title: str):
    seasons = [r["season"] for r in rows]
    raw = [r["raw_performance"] for r in rows]
    ovr = [r["calculated_ovr"] for r in rows]
    # matplotlib 기본 폰트(DejaVu Sans)엔 한글 글리프가 없어 라벨은 영문으로 고정한다.
    ax.plot(seasons, raw, marker="o", linestyle="--", color="#999999", label="Raw Performance")
    ax.plot(seasons, ovr, marker="o", linewidth=2.5, color="#c0392b", label="Calculated OVR")
    ax.set_ylim(35, 100)
    ax.set_title(title)
    ax.grid(alpha=0.3)
    ax.tick_params(axis="x", rotation=30)


def plot_comparison(rows: list[dict], title: str = "Raw Performance vs Calculated OVR"):
    """raw_performance와 calculated_ovr 두 곡선을 겹쳐 그린다(선수 1명용)."""
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(10, 5))
    _plot_on_ax(ax, rows, title)
    ax.set_ylabel("OVR")
    ax.legend()
    fig.tight_layout()
    return fig


def plot_tier_comparison(named_rows: dict):
    """등급이 다른 선수 여러 명을 나란히 비교(등급표에 따라 저항력이 실제로 갈리는지 한눈에 확인)."""
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, len(named_rows), figsize=(6.5 * len(named_rows), 5), sharey=True)
    if len(named_rows) == 1:
        axes = [axes]
    for ax, (title, rows) in zip(axes, named_rows.items()):
        _plot_on_ax(ax, rows, title)
    axes[0].set_ylabel("OVR")
    axes[-1].legend()
    fig.tight_layout()
    return fig


def _print_table(name: str, result: list[dict]):
    print(f"\n== {name} ==")
    print(f"{'시즌':<6}{'나이':<5}{'raw':<6}{'calculated_ovr':<15}")
    for r in result:
        print(f"{r['season']:<6}{r['age']:<5}{r['raw_performance']:<6}{r['calculated_ovr']:<15}")


def demo():
    """등급표가 실제로 갈리는지 두 선수로 대조 확인한다.

    1) 르브론 제임스풍(legend): 18세 성장기 -> 20대 초중반 전성기 진입 -> 한 시즌
       부진(부상 등) -> 90 돌파(최상위 등급 확정) -> 30대 하락기에서도 완만하게만
       떨어지는지 검증.
    2) 아이제아 토마스풍(flash_then_crash): 짧게 반짝했지만 78을 못 넘겨 등급표 맨
       아래 칸(저항력 0)에 머무는 선수 - 나이+부진이 겹치면 브레이크 없이 그대로
       떨어져야 한다(=calculated_ovr이 raw를 거의 그대로 따라가야 함).
    """
    legend_data = [
        {"season": "05/06", "age": 18, "raw_performance": 68},
        {"season": "06/07", "age": 19, "raw_performance": 74},
        {"season": "07/08", "age": 20, "raw_performance": 80},
        {"season": "08/09", "age": 21, "raw_performance": 86},
        {"season": "09/10", "age": 22, "raw_performance": 88},
        {"season": "10/11", "age": 23, "raw_performance": 91},   # 여기서 90 돌파 -> 최상위 등급 확정
        {"season": "11/12", "age": 24, "raw_performance": 70},   # 갑작스런 부진 시즌
        {"season": "12/13", "age": 25, "raw_performance": 93},
        {"season": "13/14", "age": 26, "raw_performance": 95},
        {"season": "14/15", "age": 27, "raw_performance": 90},
        {"season": "15/16", "age": 28, "raw_performance": 93},
        {"season": "16/17", "age": 29, "raw_performance": 91},
        {"season": "17/18", "age": 30, "raw_performance": 89},
        {"season": "18/19", "age": 31, "raw_performance": 87},
        {"season": "19/20", "age": 32, "raw_performance": 86},
        {"season": "20/21", "age": 33, "raw_performance": 84},
        {"season": "21/22", "age": 34, "raw_performance": 80},
        {"season": "22/23", "age": 35, "raw_performance": 76},
        {"season": "23/24", "age": 36, "raw_performance": 70},
    ]

    crash_data = [
        {"season": "10/11", "age": 18, "raw_performance": 50},
        {"season": "11/12", "age": 19, "raw_performance": 58},
        {"season": "12/13", "age": 20, "raw_performance": 65},
        {"season": "13/14", "age": 21, "raw_performance": 70},
        {"season": "14/15", "age": 22, "raw_performance": 72},
        {"season": "15/16", "age": 23, "raw_performance": 74},
        {"season": "16/17", "age": 24, "raw_performance": 75},
        {"season": "17/18", "age": 25, "raw_performance": 76},   # 커리어 하이(76) - 78 미만이라 등급표 최하단 유지
        {"season": "18/19", "age": 26, "raw_performance": 74},
        {"season": "19/20", "age": 27, "raw_performance": 70},
        {"season": "20/21", "age": 28, "raw_performance": 65},
        {"season": "21/22", "age": 29, "raw_performance": 60},
        {"season": "22/23", "age": 30, "raw_performance": 55},
        {"season": "23/24", "age": 31, "raw_performance": 48},
        {"season": "24/25", "age": 32, "raw_performance": 42},
    ]

    model = OvrCurveModel()
    legend_result = model.process_player(legend_data)
    crash_result = model.process_player(crash_data)

    _print_table("Legend tier (peak >= 90)", legend_result)
    _print_table("No-buffer tier (peak < 78)", crash_result)

    # 검증 1: 최상위 등급 - 부진 시즌 방어 + 완만한 하락기
    idx_slump = next(i for i, r in enumerate(legend_result) if r["age"] == 24)
    assert legend_result[idx_slump]["calculated_ovr"] > legend_data[idx_slump]["raw_performance"], \
        "최상위 등급 부진 방어가 동작하지 않음(부진 시즌인데 raw보다도 낮으면 실패)"

    legend_late = [r for r in legend_result if r["age"] >= 30]
    drops = [legend_late[i]["calculated_ovr"] - legend_late[i + 1]["calculated_ovr"] for i in range(len(legend_late) - 1)]
    assert all(0 <= d <= 6 for d in drops), f"최상위 등급 하락기 낙폭이 완만하지 않음: {drops}"

    # 검증 2: 등급표 밖(저항력 0) - 방어 없이 raw를 거의 그대로 따라가야 함(3시즌 평균만 반영)
    last_crash = crash_result[-1]
    assert abs(last_crash["calculated_ovr"] - last_crash["raw_performance"]) <= 4, \
        f"방어력 0 등급인데도 raw와 너무 벌어짐(저항력이 잘못 걸림): {last_crash}"

    # 검증 3: 등급 차이가 실제로 체감될 만큼 커야 한다 - peak 대비 마지막 시즌 낙폭을 %로 비교
    legend_drop_pct = 1 - legend_result[-1]["calculated_ovr"] / max(r["calculated_ovr"] for r in legend_result)
    crash_drop_pct = 1 - crash_result[-1]["calculated_ovr"] / max(r["calculated_ovr"] for r in crash_result)
    assert crash_drop_pct > legend_drop_pct * 2, (
        f"등급별 낙폭 차이가 충분히 안 갈림: legend {legend_drop_pct:.1%} vs crash {crash_drop_pct:.1%}"
    )

    print(f"\n검증 통과: 최상위 등급 방어(피크 대비 -{legend_drop_pct:.1%}) vs "
          f"방어 없는 등급(피크 대비 -{crash_drop_pct:.1%}) 차이 확인됨")

    fig = plot_tier_comparison({
        "Legend tier (peak >= 90)": legend_result,
        "No-buffer tier (peak < 78)": crash_result,
    })
    fig.savefig("ovr_curve_demo.png", dpi=120)
    print("차트 저장: ovr_curve_demo.png")


if __name__ == "__main__":
    demo()
