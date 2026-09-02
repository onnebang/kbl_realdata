"""Supabase 동기화 서브프로세스를 '실제로 돌아가는' 파이썬으로 띄우기 위한 인터프리터 해석기
(2026-09-02, Phase 1 검증 지적사항 반영).

--- 왜 이 파일이 필요한가 ---
이 저장소에는 서로 호환되지 않는 파이썬이 최소 두 개 있다.

  C:\\Users\\mwon0\\anaconda3\\python.exe                3.8.8  / sklearn 1.3.2 / numpy 1.24
  D:\\영상작업\\축구\\개발\\.venv\\Scripts\\python.exe    3.11.1 / sklearn 1.9.0 / numpy 2.4

raw/analysis/live_winprob_model.joblib은 sklearn 1.9/numpy 2.x에서 피클된 모델이라
**Anaconda 쪽에서는 joblib.load 자체가 죽는다** (`ModuleNotFoundError: No module named
'numpy._core'`). 즉 migrate_game_events_to_supabase.py는 Anaconda로 띄우면 무조건 exit 1이다.

daily_batch.py와 live_collector.py는 이 스크립트들을 subprocess로 띄우는데, 예전에는
`sys.executable`(= 나를 띄운 인터프리터)을 그대로 물려주고 `check=False`로 종료코드도
무시했다. 그래서 사람이 실수로 Anaconda 쉘에서 `python daily_batch.py`를 돌리면
이벤트 이관 단계가 통째로 죽으면서도 로그 한 줄 없이 "완료"로 끝난다. 그리고 그 배치는
라이브 수집기가 실패했을 때의 **유일한 복구 경로**라서, 조용한 실패가 곧 영구적인
잠정 데이터 고착으로 이어진다.

--- 해석 순서 ---
  1. 환경변수 KBL_PYTHON (운용자가 명시 지정 - 최우선)
  2. sys.executable (정상 케이스: 작업 스케줄러가 .venv로 띄우면 여기서 끝)
  3. <repo>/../.venv/Scripts/python.exe  (작업 스케줄러 KBL_DailyBatch가 쓰는 그 venv)
  4. %LOCALAPPDATA%/Programs/Python/Python311/python.exe
  5. PATH의 python / python3
후보마다 "psycopg2 임포트 + 실제 모델 joblib.load"까지 시켜보고 통과한 첫 번째를 쓴다
(임포트만 봐서는 안 된다 - 위 실패는 임포트가 아니라 언피클 시점에 터진다).
"""
import os
import shutil
import subprocess
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(BASE)
MODEL_PATH = os.path.join(REPO, "raw", "analysis", "live_winprob_model.joblib")

# 후보를 실제로 검증하는 프로브. 모델을 진짜로 언피클해봐야 numpy/sklearn 버전 불일치가
# 드러난다(임포트는 Anaconda에서도 멀쩡히 통과함).
_PROBE = (
    "import sys, joblib, psycopg2; "
    "joblib.load(sys.argv[1]); "
    "print('OK')"
)

_cache = {}


def _probe(exe, timeout=180):
    if not exe or not os.path.exists(exe):
        return False
    try:
        p = subprocess.run([exe, "-c", _PROBE, MODEL_PATH],
                           cwd=BASE, timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception:  # noqa: BLE001  실행 자체가 안 되는 후보
        return False
    return p.returncode == 0 and b"OK" in p.stdout


def candidates():
    # .venv는 저장소 안(kbl_realdata/.venv)일 수도, 한 단계 위(개발/.venv - 작업 스케줄러
    # KBL_DailyBatch가 실제로 쓰는 위치)일 수도 있어서 둘 다 본다.
    venvs = []
    for root in (REPO, os.path.dirname(REPO)):
        venvs += [os.path.join(root, ".venv", "Scripts", "python.exe"),
                  os.path.join(root, ".venv", "bin", "python")]
    out = ([os.environ.get("KBL_PYTHON"), sys.executable] + venvs +
           [os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Python",
                         "Python311", "python.exe"),
            shutil.which("python"), shutil.which("python3")])
    seen, uniq = set(), []
    for c in out:
        if c and c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def resolve_python(verbose=True):
    """모델을 실제로 로드할 수 있는 인터프리터 경로. 하나도 없으면 sys.executable을
    돌려주되 크게 경고한다(그 경우 서브프로세스가 exit 1로 죽고, 호출자는 이제 종료코드를
    검사하므로 최소한 조용히 넘어가지는 않는다)."""
    if "exe" in _cache:
        return _cache["exe"]
    tried = []
    for exe in candidates():
        if _probe(exe):
            _cache["exe"] = exe
            if verbose and exe != sys.executable:
                print(f"[python_runtime] 서브프로세스 인터프리터: {exe} "
                      f"(현재 인터프리터 {sys.executable}로는 승률 모델을 로드할 수 없음)",
                      flush=True)
            return exe
        tried.append(exe)
    _cache["exe"] = sys.executable
    print("[python_runtime] !!! 경고 !!! 승률 모델(live_winprob_model.joblib)을 로드할 수 있는 "
          "파이썬을 찾지 못했습니다. 이벤트 이관이 실패합니다.\n"
          f"    시도한 후보: {tried}\n"
          "    해결: 환경변수 KBL_PYTHON에 sklearn 1.9 / numpy 2.x가 설치된 파이썬 경로를 "
          "지정하세요(예: D:\\영상작업\\축구\\개발\\.venv\\Scripts\\python.exe).", flush=True)
    return sys.executable


if __name__ == "__main__":
    print(resolve_python())
