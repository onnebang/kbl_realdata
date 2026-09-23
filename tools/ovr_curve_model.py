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

    # 1-b) 출전 경기 수 신뢰도 - 부상/결장으로 반 시즌도 못 뛴 해가 풀타임 시즌과 똑같이
    # 50% 가중치를 그대로 받아가는 문제(유저 제보: 최준용 18경기, 송교창 9경기, 하윤기
    # 28경기 시즌 이후 다음 해까지 급락). full_season_games 경기를 채우면 신뢰도 1.0,
    # 그 밑으로는 games/full_season_games만큼 깎이되 min_reliability 밑으로는 안 깎는다
    # (몇 경기 안 뛰었어도 그 안에서 보여준 기록 자체를 0 취급하진 않음). 이 값으로
    # weights를 재조정해서, 반 시즌짜리 해가 직전 풀타임 시즌들을 덜 밀어내게 한다.
    full_season_games: int = 45
    min_reliability: float = 0.5

    # 2) 나이 구간
    growth_lo: int = 18
    growth_hi: int = 23   # 이 나이까지는 성장기, 24세부터 전성기 시작
    peak_hi: int = 29     # 24~29세 전성기, 30세부터 하락기
    growth_max_bonus: float = 0.10   # growth_lo세일 때 최대 +10% 보너스(잠재력 1.0 기준)
    # 시도했다가 되돌림: 0.18로 올리고 potential>1.0을 얹으면, 나이 보너스가 "어릴수록
    # 크다"는 구조 때문에 더 어린(=증명 안 된) 시즌이 최근 시즌보다 더 크게 부스트되면서
    # 오히려 데뷔 시즌 > 2년차로 역전되는 부작용이 생겼다(실측: 김보배 21세 82 > 22세 81).
    # 이 파라미터는 "아직 증명 안 된 유망주에 대한 낙관"용이라 시즌 간 상승분을 키우는 데는
    # 구조적으로 안 맞는다 - 성장기 시즌 간 변동폭을 키우려면 이 값이 아니라 스무딩
    # 가중치(weights) 자체를 손봐야 하는데, 이건 전체 선수에 영향을 주는 더 큰 변경이라
    # 별도로 검토가 필요하다.
    decline_rate: float = 0.025      # 하락기 매년 복리로 -2.5%(등급별 저항력 적용 전 기준값)

    # 3) 등급별 하락 저항력 - (이 peak 이상이면, 하락률 저항 비율, 부진시 peak쪽 견인 비율,
    #    peak 대비 최소 유지 비율(하한선)). peak 기준 내림차순으로 처음 맞는 구간을 쓴다.
    #    맨 아래 (0, 0,0,0)은 등급표 밖 - 저항력·하한선 전부 0, 순수 에이징+실측 그대로.
    #
    # KBL은 NBA보다 리그 규모가 작아 전체 백분위 앵커 자체가 91~99=상위 1% 수준으로 압축돼
    # 있다(build_courtside_ovr.py의 anchors 참고) - "90 이상"을 최상위 등급 기준으로 쓰면
    # 국내 레전드급 선수(예: 이정현 - 커리어 피크가 86~87)가 전부 중위 등급으로 밀려나
    # 부진 시즌 하나에 벤치 선수보다 낮은 값까지 떨어지는 문제가 생겼다(유저 제보). 기준을
    # 85로 낮추고, 블렌드만으로는 부족해 "peak의 X% 밑으로는 절대 못 감"이라는 하한선을
    # 추가한다 - 실제로 리그를 아는 사람이 봤을 때 "이 선수가 벤치보다 못하다"는 결과가
    # 나오지 않게 하는 최종 안전장치.
    tiers: tuple = (
        (85.0, 0.70, 0.55, 0.80),   # 레전드/MVP급 - 르브론, 커리급의 극한의 명성 방어
        (78.0, 0.35, 0.25, 0.60),   # 준수한 주전급 - 중간 정도 보호
        (70.0, 0.15, 0.10, 0.45),   # 로테이션급 - 약한 보호
        (0.0, 0.0, 0.0, 0.0),       # 그 외 - 보호 없음, 실측 그대로
    )

    ovr_floor: float = 40.0
    ovr_ceiling: float = 99.0

    # 3-b) 명성 보호막의 나이 감쇠.
    # 위 TIERS는 커리어 피크 한 번으로 정해지고 **나이를 전혀 안 봤다** - _tier_for()의
    # 입력이 raw_peak뿐이라, 29세에 89를 찍은 선수는 38세가 되어도 같은 보호(저항 0.70,
    # 부진방어 0.55, 하한 peak*0.80)를 그대로 받았다. 실측:
    #   실측 raw 89->60(-29점)인 노장의 모델 출력은 89->74.6(-14.4점, 실측의 50%만 반영)
    #   38세에 실측 60 vs 모델 74.6 -> 14.6점 괴리. 하한선 71.2 밑으로는 영영 못 내려감.
    # 이게 "지는 별" 수동 하향(김선형·김종규 등)이 계속 필요했던 구조적 이유다.
    # 보호막의 원래 목적은 **전성기 한 시즌 부진**을 막는 것이지(이정현이 피크 87인데
    # 한 해 부진으로 58까지 떨어졌던 제보가 출발점) 은퇴 직전까지 실측을 부정하는 게
    # 아니므로, 하락기 진입 후 fade_years에 걸쳐 residual까지 걷는다.
    protection_fade_years: int = 10
    protection_residual: float = 0.25

    def _tier_for(self, career_peak: float) -> tuple[float, float, float]:
        """career_peak(지금까지의 최고 calculated_ovr)에 맞는
        (하락 저항력, 부진 방어력, peak 대비 최소 유지 비율) 반환."""
        for min_peak, aging_resistance, perf_buffer, min_retention in self.tiers:
            if career_peak >= min_peak:
                return aging_resistance, perf_buffer, min_retention
        return 0.0, 0.0, 0.0

    def _protection_scale(self, age: int) -> float:
        """나이에 따른 보호막 배율(1.0 = 전성기까진 그대로, 이후 residual까지 선형 감쇠)."""
        if age <= self.peak_hi:
            return 1.0
        frac = min(1.0, (age - self.peak_hi) / max(1, self.protection_fade_years))
        return 1.0 - (1.0 - self.protection_residual) * frac

    def _reliability(self, games: float | None) -> float:
        """경기수 -> 이 시즌 스무딩 가중치에 곱할 신뢰도(0.5~1.0). games 정보가 없으면
        기존 동작 그대로(=1.0, 항상 풀타임 취급)."""
        if games is None:
            return 1.0
        return max(self.min_reliability, min(1.0, games / self.full_season_games))

    def _weighted_recent(self, raws: list[float], games: list[float | None] | None = None) -> float:
        """raws[-1]이 당해 시즌. 최근 self.weights 길이만큼(기본 3시즌) 가중평균.
        games가 주어지면 경기수 신뢰도로 각 시즌 가중치를 눌러서, 반 시즌짜리 해가
        직전 풀타임 시즌과 똑같은 발언권을 갖지 않게 한다."""
        window = raws[-len(self.weights):][::-1]  # [당해, 전년, 2년전, ...]
        base_weights = self.weights[: len(window)]
        if games is not None:
            games_window = games[-len(self.weights):][::-1]
            rel = [self._reliability(g) for g in games_window]
            used_weights = [w * r for w, r in zip(base_weights, rel)]
            if sum(used_weights) <= 0:
                used_weights = base_weights
        else:
            used_weights = base_weights
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
        games_history: list[float | None] = []
        career_peak = 0.0   # 하한선 기준값(스무딩까지 거친 calculated_ovr의 역대 최고치)
        raw_peak = 0.0      # 등급 판정 기준값(그 시즌 raw_performance 자체의 역대 최고치)

        for row in seasons:
            age = row["age"]
            raw = row["raw_performance"]
            potential = row.get("potential", 1.0)
            raw_history.append(raw)
            games_history.append(row.get("games"))

            # 등급은 "실제로 증명한 한 시즌 최고 활약(raw_peak)"으로 정한다 - calculated_ovr
            # 기준으로 등급을 매기면, 3시즌 가중평균이 그 시즌 raw 정점 자체를 이미 깎아놔서
            # (예: 87점 시즌 직전 두 시즌이 78·84였다면 스무딩 값은 84.3까지만 올라감) 정작
            # 커리어 하이를 찍은 선수가 등급표 문턱을 못 넘는 모순이 생긴다(유저 제보 사례
            # 재현 중 발견) - 등급 "자격"은 raw 성적으로, 등급이 정해진 뒤의 방어 "기준값"은
            # 그래도 스무딩된 career_peak을 쓴다(한 시즌 반짝만으로 방어선 자체가 부풀지 않게).
            raw_peak = max(raw_peak, raw)
            aging_resistance, perf_buffer, min_retention = self._tier_for(raw_peak)
            # 등급이 준 보호를 나이로 한 번 깎는다 - 전성기까진 배율 1.0이라 영향 없음.
            prot = self._protection_scale(age)
            aging_resistance *= prot
            perf_buffer *= prot
            min_retention *= prot

            smoothed = self._weighted_recent(raw_history, games_history)

            if age <= self.peak_hi:
                mult = self._age_multiplier(age, potential)
                value = smoothed * mult
            else:
                # 하락기: 플레이 스타일(슈터/피지컬)에 따라 하락 가속도를 다르게 설정
                base_decline = self.decline_rate
                play_style = row.get("play_style", "balanced")
                if play_style == "shooter":
                    base_decline *= 0.6  # 40% 완만한 하락 (커리/레지 밀러형)
                elif play_style == "athletic":
                    base_decline *= 1.4  # 40% 가파른 하락 (웨스트브룩/아이제아형)

                # 등급이 높을수록 base_decline 자체를 깎아서 적용, 매년 복리
                rate = base_decline * (1 - aging_resistance)
                years_past_peak = age - self.peak_hi
                value = smoothed * ((1 - rate) ** years_past_peak)

            # 부진 방어: 이번 시즌 값이 커리어 최고치보다 낮으면, 그 격차의 일부(등급별
            # perf_buffer)를 "명성"으로 메운다. 등급표 밖(perf_buffer=0)이면 이 줄은
            # 아무 효과가 없어 실측 그대로 반영된다 - 하나의 식으로 등급 차이를 통일했다.
            if value < career_peak:
                value = value * (1 - perf_buffer) + career_peak * perf_buffer

            # 하한선: 블렌드까지 거치고도 등급에 맞는 최소 유지선(peak * min_retention) 밑이면
            # 거기서 끊는다 - "이 정도 레전드가 벤치 선수보다 못하다"는 결과를 최종적으로 막는
            # 안전장치(유저 제보: 이정현 커리어 피크 87인데 부진 시즌 하나로 58까지 떨어짐).
            value = max(value, career_peak * min_retention)

            value = max(self.ovr_floor, min(self.ovr_ceiling, value))

            out.append({**row, "calculated_ovr": round(value, 1)})

            career_peak = max(career_peak, value)

        return out

    def project_forward(self, seasons: list[dict], extra_years: int = 1) -> float:
        """seasons: 실제 시즌 이력(오래된 순, process_player와 같은 형식). 다음 시즌 경기
        기록이 아직 없을 때(개막 전) 쓰는 예상치. NBA 2K처럼 비시즌 동안의 자연 성장, 
        과거 추세(Trend), 그리고 약간의 랜덤성(오프시즌 캠프 성과)을 반영한다.
        """
        processed = self.process_player(seasons)
        last_row = seasons[-1]
        last_value = processed[-1]["calculated_ovr"]
        next_age = last_row["age"] + extra_years

        # 과거 추세(Trend) 계산: 직전 2~3시즌 간의 상승/하락세
        trend = 0.0
        if len(processed) >= 2:
            trend = processed[-1]["calculated_ovr"] - processed[-2]["calculated_ovr"]
            if len(processed) >= 3:
                trend_prev = processed[-2]["calculated_ovr"] - processed[-3]["calculated_ovr"]
                trend = (trend * 0.7) + (trend_prev * 0.3)

        # 난수(Pseudo-random) 보정: 매번 돌릴 때마다 결과가 달라지지 않도록 결정론적 난수(Hash) 사용
        # 오프시즌 트레이닝 캠프의 성과를 흉내 냄 (-1.0 ~ +1.0)
        import hashlib
        hash_input = f"{last_row.get('name', 'player')}_{next_age}_{last_value}"
        hash_val = int(hashlib.md5(hash_input.encode()).hexdigest(), 16)
        pseudo_rand = (hash_val % 21 - 10) / 10.0  # -1.0 to +1.0

        if next_age <= self.growth_hi:
            # 1. 성장기 (Growth Phase: ~23세)
            potential = last_row.get("potential", 1.0)
            base_growth = 1.5 * potential
            trend_effect = max(-1.0, min(3.0, trend * 0.5))  # 부진해도 유망주는 크게 꺾이지 않음
            
            value = last_value + base_growth + trend_effect + pseudo_rand
            # 유망주는 비시즌에 최소 0(동결) ~ 최대 +4 정도의 성장을 보임
            value = max(last_value, min(last_value + 4.0, value))
            value = max(self.ovr_floor, min(self.ovr_ceiling, value))
            return round(value, 1)

        elif next_age <= self.peak_hi:
            # 2. 전성기 (Peak Phase: 24~29세)
            trend_effect = max(-2.0, min(2.0, trend * 0.5))
            
            value = last_value + trend_effect + pseudo_rand
            # 전성기 선수는 비시즌에 -2 ~ +2 정도의 등락을 보임
            value = max(last_value - 2.0, min(last_value + 2.0, value))
            value = max(self.ovr_floor, min(self.ovr_ceiling, value))
            return round(value, 1)

        # 3. 하락기 (Decline Phase: 30세~)
        career_peak = max(r["calculated_ovr"] for r in processed)
        raw_peak = max(r["raw_performance"] for r in seasons)
        aging_resistance, perf_buffer, min_retention = self._tier_for(raw_peak)

        base_decline = self.decline_rate
        play_style = last_row.get("play_style", "balanced")
        if play_style == "shooter":
            base_decline *= 0.6
        elif play_style == "athletic":
            base_decline *= 1.4
        rate = base_decline * (1 - aging_resistance)

        value = last_value * ((1 - rate) ** extra_years)
        
        # 하락기에도 미세한 추세 반등(회춘)이 있을 수 있음
        trend_effect = max(-1.0, min(1.0, trend * 0.3))
        value += trend_effect + (pseudo_rand * 0.5)

        value = max(value, career_peak * min_retention)
        value = max(self.ovr_floor, min(self.ovr_ceiling, value))
        return round(value, 1)


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
       부진(부상 등) -> 85 돌파(최상위 등급 확정) -> 30대 하락기에서도 완만하게만
       떨어지는지 검증.
    2) 아이제아 토마스풍(flash_then_crash): 짧게 반짝했지만 70을 못 넘겨 등급표 맨
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
        {"season": "10/11", "age": 18, "raw_performance": 45},
        {"season": "11/12", "age": 19, "raw_performance": 52},
        {"season": "12/13", "age": 20, "raw_performance": 58},
        {"season": "13/14", "age": 21, "raw_performance": 62},
        {"season": "14/15", "age": 22, "raw_performance": 65},
        {"season": "15/16", "age": 23, "raw_performance": 67},
        {"season": "16/17", "age": 24, "raw_performance": 68},
        {"season": "17/18", "age": 25, "raw_performance": 69},   # 커리어 하이(69) - 70 미만이라 등급표 최하단 유지
        {"season": "18/19", "age": 26, "raw_performance": 67},
        {"season": "19/20", "age": 27, "raw_performance": 63},
        {"season": "20/21", "age": 28, "raw_performance": 58},
        {"season": "21/22", "age": 29, "raw_performance": 53},
        {"season": "22/23", "age": 30, "raw_performance": 48},
        {"season": "23/24", "age": 31, "raw_performance": 42},
        {"season": "24/25", "age": 32, "raw_performance": 36},
    ]

    model = OvrCurveModel()
    legend_result = model.process_player(legend_data)
    crash_result = model.process_player(crash_data)

    _print_table("Legend tier (peak >= 85)", legend_result)
    _print_table("No-buffer tier (peak < 70)", crash_result)

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

    # 검증 4: 경기수 신뢰도 - 똑같이 raw_performance가 떨어진 시즌이라도, 부상으로 9경기만
    # 뛴 시즌은 풀타임(45경기+) 시즌보다 스무딩 값을 덜 끌어내려야 한다(유저 제보: 9경기
    # 부진 시즌 하나가 정상 시즌만큼 다음 시즌 OVR까지 끌어내림).
    reliability_base = [
        {"season": "s1", "age": 26, "raw_performance": 83, "games": 54},
        {"season": "s2", "age": 27, "raw_performance": 83, "games": 54},
        {"season": "s3", "age": 28, "raw_performance": 70, "games": 54},
    ]
    reliability_injured = [
        {**reliability_base[0]},
        {**reliability_base[1]},
        {**reliability_base[2], "games": 9},
    ]
    full_result = model.process_player(reliability_base)[-1]["calculated_ovr"]
    injured_result = model.process_player(reliability_injured)[-1]["calculated_ovr"]
    assert injured_result > full_result, (
        f"경기수 신뢰도가 적용되지 않음: 9경기 부진 시즌({injured_result})이 "
        f"풀타임 부진 시즌({full_result})만큼 떨어짐"
    )

    print(f"\n검증 통과: 최상위 등급 방어(피크 대비 -{legend_drop_pct:.1%}) vs "
          f"방어 없는 등급(피크 대비 -{crash_drop_pct:.1%}) 차이 확인됨")

    # 검증 4: 실사례 재현(유저 제보) - 커리어 피크 87인 베테랑이 거의 못 뛴 마지막 시즌
    # (raw 40 근처, 실제 이정현의 2025-26 시즌처럼 경기수는 있어도 득점이 거의 없는 경우)을
    # 하나 겪어도, 하한선 덕에 로테이션급(70) 밑으로는 안 떨어져야 한다.
    veteran_data = [
        {"season": "y1", "age": 20, "raw_performance": 65},
        {"season": "y2", "age": 22, "raw_performance": 78},
        {"season": "y3", "age": 24, "raw_performance": 84},
        {"season": "y4", "age": 26, "raw_performance": 87},   # 커리어 하이
        {"season": "y5", "age": 28, "raw_performance": 82},
        {"season": "y6", "age": 30, "raw_performance": 79},
        {"season": "y7", "age": 32, "raw_performance": 74},
        {"season": "y8", "age": 34, "raw_performance": 70},
        {"season": "y9", "age": 36, "raw_performance": 40},   # 거의 못 뛴 마지막 시즌
    ]
    veteran_result = model.process_player(veteran_data)
    _print_table("Veteran floor test (peak 87 -> near-invisible final season)", veteran_result)
    last_veteran = veteran_result[-1]["calculated_ovr"]
    assert last_veteran >= 70 * 0.9, (
        f"베테랑 하한선이 로테이션급보다도 낮게 나옴(제보 재현 실패): {last_veteran}"
    )
    print(f"검증 통과: 피크 87 베테랑이 최악의 시즌에도 {last_veteran}까지만 하락(하한선 동작)")

    fig = plot_tier_comparison({
        "Legend tier (peak >= 85)": legend_result,
        "No-buffer tier (peak < 70)": crash_result,
        "Veteran floor (peak 87)": veteran_result,
    })
    fig.savefig("ovr_curve_demo.png", dpi=120)
    print("차트 저장: ovr_curve_demo.png")

    # 검증 5: 예상치(project_forward) - 성장기 선수는 새 정보 없이 떨어지면 안 된다
    # (유저 제보 재현: 22세, 데뷔 시즌 raw가 약해서 3시즌 평균에 재투입되면 79->78로 착시
    # 하락하던 문제).
    growing_player = [
        {"season": "y1", "age": 21, "raw_performance": 75, "play_style": "balanced"},
        {"season": "y2", "age": 22, "raw_performance": 78, "play_style": "balanced"},
    ]
    projected_growth = model.project_forward(growing_player, extra_years=1)
    last_real_growth = model.process_player(growing_player)[-1]["calculated_ovr"]
    assert projected_growth >= last_real_growth, (
        f"성장기 선수 예상치가 마지막 확정값보다 낮음(착시 하락 재발): "
        f"{projected_growth} < {last_real_growth}"
    )
    print(f"검증 통과: 성장기 선수(22->23세) 예상치 {projected_growth} >= 마지막 확정값 {last_real_growth}")

    # 검증 6: 하락기 선수는 한 시즌 더 늙으면 실제로 더 낮아져야 한다(부진 방어를 예상치에
    # 다시 적용해 오히려 오르던 역전 버그 재발 방지 - 실측: 라건아 93->95로 역전됐던 사례).
    declining_player = legend_data + [
        {"season": "y_late", "age": 36, "raw_performance": 70, "play_style": "athletic"},
    ]
    projected_decline = model.project_forward(declining_player, extra_years=1)
    last_real_decline = model.process_player(declining_player)[-1]["calculated_ovr"]
    assert projected_decline <= last_real_decline, (
        f"하락기 선수 예상치가 마지막 확정값보다 높음(부진 방어 이중 적용 재발): "
        f"{projected_decline} > {last_real_decline}"
    )
    print(f"검증 통과: 하락기 선수(36->37세) 예상치 {projected_decline} <= 마지막 확정값 {last_real_decline}")


if __name__ == "__main__":
    demo()
