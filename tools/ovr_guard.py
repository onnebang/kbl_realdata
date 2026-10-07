"""OVR 산출물 검증 가드 - weekly_retrain.py가 OVR 재계산 직후(학습·커밋 전)에 돌린다.

2026-10-06 개막 직후 전원 OVR 폭락 사고는 파이프라인이 에러 없이(종료코드 0) 끝났고 과거 시즌 858행까지
오염시킨 채 기능 커밋에 섞여 나갔다. 무인 주간 잡이 같은 일을 겪지 않도록, 방금 만든 JSON을 마지막 커밋(HEAD)
JSON과 비교해 이상하면 푸시하지 않는다. 순수 함수라 replay/단위 점검에서도 그대로 쓴다.

검사(old = HEAD의 JSON, new = 방금 생성한 JSON; "올 시즌" = new의 가장 최신 시즌):
  1) 올 시즌 이전 행은 값이 그대로여야 한다(OVR/OFF/DEF/능력치) - 진행 중 시즌 데이터가 과거를 오염시키면 안 된다.
  2) (pcode, 시즌) 행이 사라지면 안 된다. 올 시즌 행이 소량(MAX_LIVE_LOSS_RATIO 이하) 빠지는 건 로스터 정리로 있을 수
     있어 경고만 하고, 그 이상이거나 과거 시즌 행이 빠지면 실패.
  3) 올 시즌 행은 한 번에 크게 움직이면 안 된다 - 선수별 최대 MAX_LIVE_STEP, 95% 선수 MAX_LIVE_P95 이내, 평균 이동
     (부호 포함)이 MAX_LIVE_MEAN_SHIFT 이내(전원이 한쪽으로 쏠리는 사고 탐지).
  4) 올 시즌 행이 예상치에서 실측으로 한꺼번에 바뀌는 시즌 확정 전환은 1년에 한 번 정상적으로 값이 크게 움직이고
     (백분위 풀에 새 시즌이 들어가 과거 행도 소폭 이동) 위 검사가 성립하지 않는다 - 이 경우는 사람이 확인하고
     OVR_GUARD_ALLOW_SETTLE=1로 다시 돌려야 통과한다(행 소실 검사는 그대로 적용).
"""
import json
import os
import subprocess
import sys

NUMERIC = ("OVR", "OFF", "DEF", "attributes")
MAX_LIVE_STEP = 8
MAX_LIVE_P95 = 3
MAX_LIVE_MEAN_SHIFT = 0.7
MAX_LIVE_LOSS_RATIO = 0.03
SETTLE_SHARE = 0.3  # 올 시즌 행 중 예상치(projected)에서 실측으로 바뀐 비율이 이 이상이면 시즌 확정 전환으로 본다


def _index(rows):
    return {(r["pcode"], r["season"]): r for r in rows}


def _p95(values):
    s = sorted(values)
    return s[min(len(s) - 1, int(0.95 * len(s)))] if s else 0


def check(old_rows, new_rows, allow_settle=False):
    """(problems, warnings) - problems가 비어 있으면 통과."""
    old, new = _index(old_rows), _index(new_rows)
    problems, warnings = [], []
    live = max((s for _, s in new), default=None)
    if live is None:
        return ["새 JSON이 비어 있다"], warnings

    settled = [k for k in old if k[1] < live]
    lost_settled = [k for k in settled if k not in new]
    if lost_settled:
        problems.append(f"과거 시즌 행 {len(lost_settled)}개 소실 (예: {old[lost_settled[0]]['name']} {lost_settled[0][1]})")

    live_old = [k for k in old if k[1] == live]
    lost_live = [k for k in live_old if k not in new]
    if lost_live:
        names = ", ".join(old[k]["name"] for k in lost_live[:5])
        msg = f"올 시즌({live}) 행 {len(lost_live)}/{len(live_old)}개 소실 ({names}{' ...' if len(lost_live) > 5 else ''})"
        (problems if len(lost_live) > MAX_LIVE_LOSS_RATIO * max(1, len(live_old)) else warnings).append(msg)

    newly_real = [k for k in live_old if k in new and old[k].get("projected") and not new[k].get("projected")]
    settle = bool(live_old) and len(newly_real) >= SETTLE_SHARE * len(live_old)
    if settle and not allow_settle:
        problems.append(f"시즌 확정 전환 감지({live}: 예상치 행 {len(newly_real)}/{len(live_old)}개가 실측으로 바뀜) - "
                        "값 변화를 직접 확인한 뒤 OVR_GUARD_ALLOW_SETTLE=1 로 다시 실행")
    if settle:
        return problems, warnings

    changed = [k for k in settled if k in new and any(old[k].get(f) != new[k].get(f) for f in NUMERIC)]
    if changed:
        problems.append(f"확정 시즌 행 {len(changed)}개의 값이 바뀜 (예: {old[changed[0]]['name']} {changed[0][1]})")

    deltas = [new[k]["OVR"] - old[k]["OVR"] for k in live_old if k in new]
    if deltas:
        mean_shift = sum(deltas) / len(deltas)
        if max(abs(d) for d in deltas) > MAX_LIVE_STEP:
            worst = max((k for k in live_old if k in new), key=lambda k: abs(new[k]["OVR"] - old[k]["OVR"]))
            problems.append(f"올 시즌 선수 하나가 한 번에 {MAX_LIVE_STEP}점 넘게 움직임 ({old[worst]['name']}: "
                            f"{old[worst]['OVR']} -> {new[worst]['OVR']})")
        if _p95([abs(d) for d in deltas]) > MAX_LIVE_P95:
            problems.append(f"올 시즌 선수 5% 이상이 {MAX_LIVE_P95}점 넘게 움직임 (상위 5% 변동폭 {_p95([abs(d) for d in deltas])})")
        if abs(mean_shift) > MAX_LIVE_MEAN_SHIFT:
            problems.append(f"올 시즌 평균 OVR이 한쪽으로 {mean_shift:+.2f} 쏠림 (전원 하락/상승 사고 패턴)")
    return problems, warnings


def head_rows(repo_root, rel_path):
    raw = subprocess.run(["git", "-C", repo_root, "show", f"HEAD:{rel_path}"], capture_output=True, check=True).stdout
    return json.loads(raw.decode("utf-8"))


def selftest():
    def row(p, season, ovr, projected=False):
        return {"pcode": p, "name": p, "season": season, "OVR": ovr, "OFF": ovr, "DEF": ovr, "attributes": {}, "projected": projected}

    base = [row(str(i), "2025-2026", 70 + i % 10) for i in range(50)] + [row(str(i), "2026-2027", 70 + i % 10, True) for i in range(50)]

    def moved(delta):
        return [r if r["season"] != "2026-2027" else {**r, "OVR": r["OVR"] + delta} for r in base]

    assert check(base, base) == ([], []), "동일 입력이 통과해야 함"
    alternating = [r if r["season"] != "2026-2027" else {**r, "OVR": r["OVR"] + (1 if int(r["pcode"]) % 2 else -1)} for r in base]
    assert check(base, alternating)[0] == [], "선수마다 +-1씩 갈리는 주간 변동은 정상 범위"
    assert check(base, moved(1))[0], "전원이 같은 방향으로 +1이면 쏠림으로 막아야 함"
    assert check(base, moved(-10))[0], "전원 -10(어제 사고 패턴)은 막아야 함"
    assert check(base, [r for r in base if r["pcode"] != "3" or r["season"] != "2025-2026"])[0], "과거 시즌 행 소실은 막아야 함"
    assert check(base, base[:-5])[0] and not check(base, base[:-1])[0], "올 시즌 행: 대량 소실은 실패, 1개는 경고만"
    assert check(base, [r if r["season"] != "2025-2026" or r["pcode"] != "7" else {**r, "OVR": 99} for r in base])[0], "확정 시즌 값 변경은 막아야 함"
    settled = [r if r["season"] != "2026-2027" else {**r, "projected": False, "OVR": r["OVR"] + 6} for r in base]
    assert check(base, settled)[0] and not check(base, settled, allow_settle=True)[0], "시즌 확정 전환은 수동 승인 시에만 통과"
    print("ovr_guard selftest 통과")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        repo = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
        rel = "courtside-web/lib/courtside_ovr_history.json"
        with open(os.path.join(repo, rel), encoding="utf-8") as f:
            probs, warns = check(head_rows(repo, rel), json.load(f), allow_settle=os.environ.get("OVR_GUARD_ALLOW_SETTLE") == "1")
        for w in warns:
            print("[경고]", w)
        for p in probs:
            print("[실패]", p)
        print("가드:", "통과" if not probs else "실패")
        sys.exit(1 if probs else 0)
