"""
경기 중(라이브) 승률 예측 - 훈련 데이터 구축 (로드맵 05 본작업, 2026-08-24).

지금까지 만든 건 전부 "경기 전(pre-game)" 예측이었음 - 한 경기 = 한 행. 이번엔 사용자가
원래 원했던 "시간 흐름별" 모델: **한 경기를 수십~수백 개의 시점 스냅샷으로 펼쳐서** 각 시점의
(득점차, 남은시간, 경기전 팀전력)으로 그 시점 이후 최종 결과(홈팀 승/패)를 맞추는 문제로 바꾼다.

업계 표준 방식(NBA 라이브 승률 그래프 등이 쓰는 방식과 동일한 뼈대): **득점차 + 남은시간이
거의 모든 걸 지배**한다 - 농구는 시계가 있는 스포츠라 후반부로 갈수록 이 두 변수가 압도적으로
중요해짐. 여기에 경기 전 팀전력(우리가 이미 검증한 netrtg차/시너지차)을 얹어서, 게임 초반
(득점차가 아직 무의미할 때)엔 경기 전 예측에 가깝고, 후반으로 갈수록 실제 스코어가 지배하도록
만든다.

**스냅샷 단위**: 스틴트 경계(교체 시점)가 아니라 **문자중계 이벤트 하나하나**를 씀 - 스틴트는
평균 92초에 한 번이라 너무 성겨서 "방금 3점슛 넣은 순간의 승률" 같은 걸 못 잡음. 이벤트 단위로
하면 4,207경기 * 경기당 ~500이벤트 ≈ 200만 개 스냅샷 확보.

**"남은시간"의 정의**: 고정값(2400초)이 아니라 **그 경기의 실제 마지막 이벤트 시각**을 총
경기시간으로 삼음 - 연장전이 있는 경기도 자동으로 처리됨(연장 있으면 그만큼 총시간이 늘어날
뿐, 정규시간 고정값을 쓰면 연장전 계산이 꼬임).

**경기 전 팀전력**: pregame_training_table.json에 이미 있는 netrtg차/시너지차를 그대로 붙임 -
새 모델을 또 학습시키는 게 아니라 이미 검증된 피처를 재사용. pregame 테이블에 없는 경기(직전
경기 3경기 미만 워밍업 구간)는 라이브 데이터에서도 제외.
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
OUT_PATH = os.path.join(ANALYSIS_DIR, "live_winprob_snapshots.json")

QUARTER_ORDER = ["Q1", "Q2", "Q3", "Q4", "X1", "X2", "X3", "X4", "EQ1", "EQ2", "EQ3", "EQ4"]
QUARTER_LEN_SEC = {"Q1": 600, "Q2": 600, "Q3": 600, "Q4": 600}  # 그 외(연장)는 기본 300
SCORE_CODES = {"201": 2, "205": 3, "203": 1, "207": 2}  # 2점/3점/자유투/덩크


def quarter_len(q):
    return QUARTER_LEN_SEC.get(q, 300)


def cumulative_elapsed(q, m, s):
    idx = QUARTER_ORDER.index(q) if q in QUARTER_ORDER else len(QUARTER_ORDER)
    prior = sum(quarter_len(qq) for qq in QUARTER_ORDER[:idx])
    remaining = m * 60 + s
    return prior + (quarter_len(q) - remaining)


def load_pregame_context():
    """gmkey -> {netrtgDiff, synergyDiff, homeWon} - 이미 검증된 경기전 피처 재사용."""
    with open(os.path.join(ANALYSIS_DIR, "pregame_training_table.json"), encoding="utf-8") as f:
        rows = json.load(f)
    out = {}
    for r in rows:
        h_net, a_net = r["home"].get("home_netrtg"), r["away"].get("away_netrtg")
        h_syn, a_syn = r["home"].get("home_synergyOnOffRating"), r["away"].get("away_synergyOnOffRating")
        out[r["gmkey"]] = {
            "netrtgDiff": (h_net - a_net) if h_net is not None and a_net is not None else None,
            "synergyDiff": (h_syn - a_syn) if h_syn is not None and a_syn is not None else None,
            "homeWon": r["homeWon"],
            "seasonCode": r["seasonCode"],
        }
    return out


def build_game_snapshots(gmkey, ctx, home_tcode):
    path = os.path.join(GAMES_DIR, gmkey, "text-cast.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        events = json.load(f)
    if not events:
        return []

    total_elapsed = cumulative_elapsed(events[-1]["q"], events[-1]["m"], events[-1]["s"])
    if total_elapsed <= 0:
        return []

    snapshots = []
    home_score, away_score = 0, 0
    for evt in events:
        code = evt.get("a")
        if code in SCORE_CODES and evt.get("t") == home_tcode:
            home_score += SCORE_CODES[code]
        elif code in SCORE_CODES:
            away_score += SCORE_CODES[code]

        elapsed = cumulative_elapsed(evt["q"], evt["m"], evt["s"])
        remaining = total_elapsed - elapsed
        snapshots.append({
            "elapsedSec": elapsed,
            "remainingSec": remaining,
            "quarter": evt["q"],
            "scoreDiff": home_score - away_score,
            "netrtgDiff": ctx["netrtgDiff"],
            "synergyDiff": ctx["synergyDiff"],
            "homeWon": ctx["homeWon"],
        })
    return snapshots


def main():
    pregame_ctx = load_pregame_context()
    print(f"경기전 컨텍스트 있는 경기: {len(pregame_ctx)}개", flush=True)

    all_snapshots = []
    skipped_no_ctx = 0
    for gmkey in sorted(os.listdir(GAMES_DIR)):
        ctx = pregame_ctx.get(gmkey)
        if ctx is None:
            skipped_no_ctx += 1
            continue
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        home_tcode = meta["game"].get("tcodeH")
        snaps = build_game_snapshots(gmkey, ctx, home_tcode)
        for s in snaps:
            s["gmkey"] = gmkey
            s["seasonCode"] = ctx["seasonCode"]
        all_snapshots.extend(snaps)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(all_snapshots, f, ensure_ascii=False)
    print(f"경기전 컨텍스트 없어서 제외: {skipped_no_ctx}개", flush=True)
    print(f"총 스냅샷 {len(all_snapshots)}개 -> {OUT_PATH}", flush=True)


if __name__ == "__main__":
    main()
