"""
KBL 라이브 수집기 (Phase 1, 2026-09-02) - 경기가 열리는 날 켜두면 KBL API의 문자중계를
주기적으로 폴링해서 game_events를 증분 적재하고, games 행의 스코어/종료여부를 갱신한다.
이게 코트사이드 사이트를 예정 -> 진행중 -> 종료로 넘기는 유일한 주체다
(courtside-web/lib/gameStatus.ts의 3상태 정의와 1:1).

  예정   = games.home_score IS NULL      (sync_upcoming_games.py가 넣어둔 상태)
  진행중 = 스코어 있음 + is_ended=false  (이 스크립트가 매 폴링마다 갱신)
  종료   = is_ended=true                 (이 스크립트가 종료를 감지하고 세운 뒤 배치가 정산)

--- 왜 파이썬인가 ---
backend/src/index.ts(Cloudflare Worker, 미배포)에도 폴링/이벤트 감지 로직이 있지만, 승률
모델(joblib)·피처 정의·DB 자격증명·마이그레이션 스크립트가 전부 파이썬 쪽에 이미 있다.
Worker는 푸시 알림 전용으로 두고, 적재는 여기서 한다(로드맵 합의). 이 스크립트는 Worker를
읽기만 했고 건드리지 않는다 - 다만 remainingSec 추정 규칙(regulationTotal)은 Worker와
같은 정의를 쓴다.

--- !!! 미검증 API 리스크 (TODO-LIVE) !!! ---
tools/fetch_kbl_data.py는 지금까지 isEnded==1(끝난 경기)만 받아봤다. "진행 중"인 경기에서
api.kbl.or.kr이 정확히 뭘 주는지는 비시즌이라 아무도 관측하지 못했다. 그래서 이 스크립트는
전부 방어적으로 짰다:
  - 필드 누락/빈 응답/타입 이상(isEnded가 0/1이 아니라 "1"/true로 오는 경우 등) 전부 허용.
  - 이벤트가 한 번에 뭉텅이로 들어와도 그냥 전체 스냅샷을 다시 계산해서 UPSERT(멱등).
  - player-stat이 경기 중엔 없을 수도 있다고 보고 DB 로스터 폴백을 둠.
  - 어떤 폴링 하나가 터져도 루프는 절대 죽지 않음(로그 남기고 다음 주기로).
  - 종료 판정(detect_ended)은 명시 신호(스케줄/meta의 isEnded)를 먼저 보되, **부정 증거가
    긍정 신호를 거부할 수 있다** - playingQuarter가 진짜 쿼터 코드거나, 직전 폴링보다
    문자중계 이벤트가 늘었거나, 문자중계상 Q1~Q3를 진행 중이면 그 주기엔 종료로 넘기지
    않는다. 종료 표시는 되돌릴 수 없는 결정(is_ended 단조 + 수집 중단)이라 단일 플래그에
    베팅하지 않는다. 명시 신호가 아예 없을 때만 001/009 휴리스틱으로 내려간다.
    거부 증거가 하나도 없는 깨끗한 판정이어도 **연속 2주기(END_CONFIRM_MIN_POLLS)** 같은
    신호가 유지돼야 실제로 is_ended를 세운다(end_gate) - 카운터는 raw/live_state/에 남겨서
    --once(매 실행이 새 프로세스)에서도 이어진다. 그래도 오판이 나면 되돌리는 절차는
    README '종료 오판 복구'에 적어뒀다(games.is_ended=false로 되돌리고 재수집).
    **009는 '경기 종료'가 아니라 '피리어드 종료'다** - 시드 라벨을 그대로 믿었다가 드라이런
    1회차에서 Q2에 경기가 끝나버렸다(detect_ended docstring 참고).
  - **모든 원본 응답을 raw/live_logs/<gmkey>/<타임스탬프>.json에 그대로 남김** - 10월에
    무슨 일이 벌어지든 나중에 오프라인으로 재현/디버깅할 수 있게. 이게 미검증 리스크에
    대한 가장 실질적인 보험이다. (경기 하나당 폴링 150회 x ~60KB ≈ 10MB 수준)
  - 무인 실행이 영원히 돌지 않음: 연기/취소 경기는 --stall-timeout(기본 2시간) 동안 새
    이벤트가 없으면 폴링 대상에서 내리고, 전체 수명은 --max-runtime(기본 12시간)으로
    묶이며, KST 날짜가 바뀌면 다음 날 경기로 자동 전환한다.

--- 라이브 값은 '잠정치'다 ---
경기 중에는 최종 경기 길이(연장 여부)를 알 수 없어서 remainingSec을 규정시간 기준으로
추정하고, 라인업/pcode도 확정 박스스코어가 아니라 문자중계에서 복원한 값이다. 그래서
경기가 끝나면 reconcile_finished_game()이 기존 배치 경로(fetch_kbl_data 재수집 +
migrate_to_supabase.py --gmkeys + migrate_game_events_to_supabase.py --gmkeys --replace)를
그대로 호출해서 공식 박스스코어/슛좌표/재계산 WPA로 덮어쓴다. 배치가 정본, 라이브는 잠정.

그 '잠정 -> 정본' 인계가 Phase 1에서 제일 깨지기 쉬운 지점이라, 세 겹으로 막았다:
  1. 정산은 공식 박스스코어가 실제로 도착했을 때만 이관을 돌린다(official_box_ready).
     안 왔으면 ok=False로 돌려주고 다음 주기에 재시도한다 - 예전엔 isEnded가 뜬 즉시
     이관을 돌려서, team-record.json이 아직 없으면 migrate_to_supabase가 games.home_score를
     **NULL로 덮어썼다**(= 다 끝난 경기가 사이트에서 '예정'으로 되돌아감. 실제 재현됨).
  2. migrate_to_supabase.load_games의 UPSERT를 비파괴(coalesce/monotonic)로 고쳤다 -
     1번을 뚫고 들어와도 스코어가 NULL로 지워지지 않는다.
  3. 정산 서브프로세스의 **종료코드를 확인**하고, 실패하면 경기를 pending에 남겨
     재시도한다(poll_cycle). 그래도 안 되면 크게 로그를 남기고, 다음날 daily_batch.py가
     --replace + force 재수집으로 정정한다(그쪽도 이번에 고침).

--- 경기 당일 운용법 ---
  # 오늘(KST) 열리는 경기를 전부 60초 간격으로 따라감. 켜두면 끝. 경기가 끝나면
  # 자동으로 정산 배치까지 돌리고, 오늘 경기가 다 끝나면 스스로 종료한다.
  set PATH=...  &&  python live_collector.py

  python live_collector.py --interval 30          # 폴링 간격(초)
  python live_collector.py --gmkey S49G01N1       # 특정 경기만 강제
  python live_collector.py --once                 # 1회만 돌고 종료(작업 스케줄러용)
  python live_collector.py --dry-run-source S47G03N16 --speed 60
                                                  # API 대신 끝난 경기를 재생(오프라인 검증)

무인 실행은 작업 스케줄러 KBL_LiveCollector(2026-09-14)가 매일 13:00부터 10분마다 이
스크립트를 띄운다(떠 있으면 무시). 조건과 한계는 README의 운용 섹션 참고.
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import time
import traceback

BASE = os.path.dirname(os.path.abspath(__file__))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import fetch_kbl_data as fkd                      # noqa: E402  HTTP 계층 재사용(복제 금지)
import migrate_game_events_to_supabase as mge      # noqa: E402  이벤트 매핑/모델 규약 재사용
from python_runtime import resolve_python          # noqa: E402  정산 서브프로세스 인터프리터
from sync_upcoming_games import get_conn, load_env_supabase  # noqa: E402  DB 접속 규약 재사용

RAW_DIR = os.path.join(BASE, "..", "raw")
LIVE_LOG_DIR = os.path.join(RAW_DIR, "live_logs")
# 종료 신호 확정 카운터(end_gate)를 프로세스 밖에 남겨두는 곳. --once는 매 실행이 새
# 프로세스라 메모리 카운터가 매번 0으로 리셋되고, 그러면 "연속 2주기 확인" 규칙이 영원히
# 충족되지 않아 경기가 절대 종료되지 않는다(= 새 실패 모드를 만드는 셈). gmkey당 JSON 한 개.
LIVE_STATE_DIR = os.path.join(RAW_DIR, "live_state")

KST = datetime.timezone(datetime.timedelta(hours=9))

# backend/src/index.ts의 regulationTotal과 같은 정의 - 정규 4쿼터 2400초, 진행 중인 연장은
# 쿼터당 300초씩 얹음. 경기 중엔 최종 길이를 모르니 "지금 보이는 마지막 쿼터가 끝나면
# 경기가 끝난다"고 가정해 remainingSec을 추정한다.
REGULATION_SEC = 4 * 600

# 라이브 대상으로 볼 경기 분류 - daily_batch.py의 CATEGORIES와 같은 스코프.
CATEGORIES = {"R", "PO", "CU", "AS"}

# 피리어드 시작/종료 액션 코드. schema_supabase.sql의 action_codes 시드는 001='경기 시작',
# 009='경기 종료'로 라벨링해뒀지만 **실제 데이터는 쿼터마다 한 쌍씩** 나온다(저장된 200경기
# 표본: 009가 경기당 4개(정규) + 연장마다 1개, Q1/Q2/Q3/Q4 각 200개). 즉 라벨이 오해를
# 부르는 것이고 의미는 '피리어드 시작/종료'다. 이 사실을 드라이런 1회차에서 발견함
# (자세한 내용은 detect_ended docstring).
PERIOD_START_CODE = "001"
GAME_OVER_CODE = "009"

# 라이브 값이 절대 건드리면 안 되는 gmkey 패턴(드라이런 합성 경기) - 정산 배치는 진짜
# KBL gmkey에만 의미가 있고, 합성 gmkey를 넘기면 raw/games에 없어서 조용히 no-op이지만
# 명시적으로 막아두는 편이 사고를 줄인다.
SYNTHETIC_PREFIX = "DRYRUN-"

# 종료 신호에 '거부 증거'가 붙었을 때, 몇 주기 연속으로 같은 신호가 유지되면 결국 받아들일지
# (detect_ended docstring 참고). 몰수/중단처럼 문자중계가 Q4 전에 멈춘 채 진짜로 끝난
# 경우의 탈출구. 기본 폴링 간격 60초 x 3 = 3분.
END_CONFIRM_POLLS = 3

# 거부 증거가 하나도 없는 '깨끗한' 종료 판정이라도 **연속 N주기** 유지돼야 실제로 종료로
# 커밋한다(end_gate). 종료 커밋은 되돌릴 수 없는 결정(is_ended 단조 + pending 제거 +
# select_target_games 필터)이라, 단 한 번의 응답 이상(스케줄 캐시 오염, 순간적인 필드
# 누락, 문자중계 일시 소실)에 베팅하지 않는다. 대가는 폴링 간격 1회분(기본 60초) 지연뿐.
END_CONFIRM_MIN_POLLS = 2

# 종료 정산 재시도 상한. 공식 박스스코어 공개가 늦어지는 상황을 60초 간격으로 10번
# (=10분) 기다린다. 그래도 안 되면 크게 로그를 남기고 포기(무한 루프 방지) - 다음날
# daily_batch가 --replace로 정정한다.
RECONCILE_MAX_ATTEMPTS = 10

# 무인 운용 안전장치(2026-09-02).
#   MAX_RUNTIME_SEC  - 수집기 전체 수명 상한. 연기/취소된 경기는 문자중계가 영원히 비어
#                      있어서 절대 '종료'가 되지 않고, 예전 구현은 `while pending`에 시간
#                      제한이 없어 다음날까지 60초마다 KBL API를 두드리며 그날 경기는
#                      쳐다보지도 않았다.
#   STALL_TIMEOUT_SEC- 한 경기가 이 시간 동안 아무 진전(새 이벤트)이 없으면 포기하고
#                      pending에서 뺀다. 시작조차 못 한 경기(연기/취소)와 중계가 끊긴
#                      경기를 같은 규칙으로 정리한다. 경기 사이 최장 공백(하프타임 +
#                      작전타임 연쇄)보다 넉넉하게 잡음.
MAX_RUNTIME_SEC = 12 * 3600
STALL_TIMEOUT_SEC = 2 * 3600

# 무인 실행(작업 스케줄러 KBL_LiveCollector, 2026-09-14). 수집기는 경기 시작 전에 미리 떠 있고,
# 각 경기는 예정 시각 이 시간 전부터만 폴링한다. 예전엔 뜨자마자 오늘 경기 전부를 60초마다
# 두드렸고, 아직 시작 전인 경기도 스톨 시계가 그 순간부터 돌아서 - 14:00·16:30 두 경기가 있는
# 날 13:30에 켜면 16:30 경기가 15:30에 "2시간 동안 새 이벤트 없음"으로 시작도 전에 떨어졌다
# (개막일 10/3이 정확히 이 편성). 이제 스톨 시계는 예정 시각부터 돈다(drop_stalled).
PREGAME_LEAD_SEC = 30 * 60


def log(msg):
    print(f"[live {datetime.datetime.now(KST).strftime('%H:%M:%S')}] {msg}", flush=True)


def kst_today():
    return datetime.datetime.now(KST).strftime("%Y-%m-%d")


def tipoff_epoch(game_date, game_start):
    """games.game_date(date) + game_start(time, KST) -> epoch 초. 시각을 모르면 0(= 바로 폴링)."""
    if not game_date or not game_start:
        return 0.0
    return datetime.datetime.combine(game_date, game_start, tzinfo=KST).timestamp()


def due_games(pending, tipoffs, now, lead=PREGAME_LEAD_SEC):
    """지금 폴링할 경기 = 예정 시각 lead초 전을 지난 경기. 그 전엔 KBL API를 두드리지 않는다."""
    return {gk for gk in pending if tipoffs.get(gk, 0.0) - lead <= now}


def drop_stalled(pending, progress, summaries, now, stall_timeout):
    """이번 주기 요약으로 진전(이벤트 수 증가) 시각을 갱신하고, stall_timeout 넘게 진전이 없는
    경기를 돌려준다. progress는 gmkey -> (시계 시작/마지막 진전 시각, 본 이벤트 수).
    시작 전 경기는 run()이 시계를 예정 시각에 맞춰 넣으므로 경기 전 대기 시간은 세지 않는다."""
    for s in summaries:
        seen = s.get("events") or 0
        if seen > progress.get(s["gmkey"], (now, 0))[1]:
            progress[s["gmkey"]] = (now, seen)
    return {gk for gk in pending if now - progress.get(gk, (now, 0))[0] >= stall_timeout}


def keep_awake():
    """수집기가 떠 있는 동안 노트북이 유휴 절전에 들어가지 않게(Windows 전용). 프로세스가 끝나면
    Windows가 알아서 푼다. 덮개를 닫아서 들어가는 절전은 막지 못한다."""
    if os.name == "nt":
        import ctypes
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)  # CONTINUOUS|SYSTEM_REQUIRED


# ---------------------------------------------------------------------------
# 스냅샷 수집 (API / 리플레이)
# ---------------------------------------------------------------------------

def _ended_flag(value):
    """isEnded 정규화 - 라이브에서 정수 1/0이 아니라 "1"/true로 올 가능성이 미검증이라
    문자열/불린도 전부 받아들인다. 판단 불가면 None(=모름)."""
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int):
        return 1 if value == 1 else (0 if value == 0 else None)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("1", "true", "y", "yes"):
            return 1
        if v in ("0", "false", "n", "no", ""):
            return 0
    return None


def write_raw_log(gmkey, payload):
    """원본 응답 전체를 그대로 저장 - 미검증 API 리스크에 대한 보험(모듈 docstring 참고)."""
    try:
        d = os.path.join(LIVE_LOG_DIR, gmkey)
        os.makedirs(d, exist_ok=True)
        ts = datetime.datetime.now(KST).strftime("%Y%m%dT%H%M%S_%f")
        with open(os.path.join(d, f"{ts}.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception as e:  # noqa: BLE001  로깅 실패가 수집을 막으면 안 됨
        log(f"  (경고) 원본 로그 저장 실패: {e}")


def state_path(gmkey):
    return os.path.join(LIVE_STATE_DIR, f"{gmkey}.json")


def load_end_state(gmkey):
    """종료 신호 확정 카운터를 읽어온다. 파일이 없거나 깨졌으면 0에서 시작 - 실패 방향이
    '종료를 한 주기 더 미룬다'라서 안전하다(반대로 굳는 쪽이 위험)."""
    try:
        with open(state_path(gmkey), encoding="utf-8") as f:
            s = json.load(f)
        return {"clean": int(s.get("clean", 0)), "veto": int(s.get("veto", 0))}
    except Exception:  # noqa: BLE001  없음/깨짐/권한 - 전부 '기록 없음'으로 취급
        return {"clean": 0, "veto": 0}


def save_end_state(gmkey, state):
    try:
        os.makedirs(LIVE_STATE_DIR, exist_ok=True)
        tmp = state_path(gmkey) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"clean": state.get("clean", 0), "veto": state.get("veto", 0),
                       "updated": datetime.datetime.now(KST).isoformat()}, f)
        os.replace(tmp, state_path(gmkey))
    except Exception as e:  # noqa: BLE001  상태 저장 실패가 수집을 막으면 안 됨
        log(f"  (경고) 종료 신호 상태 저장 실패({gmkey}): {e} - 메모리 카운터로만 진행")


def clear_end_state(gmkey):
    try:
        os.remove(state_path(gmkey))
    except Exception:  # noqa: BLE001
        pass


def end_gate(state, ended, held, grew):
    """detect_ended의 '이번 주기 판정'을 **여러 주기에 걸친 결정**으로 바꾸는 게이트.
    순수 함수(state를 제자리에서 갱신하고 결정을 반환) - 회귀 테스트가 DB 없이 이 규칙만
    따로 검증할 수 있게 일부러 분리했다(replay_dry_run.verify_end_detection).

    반환 (commit: bool, why: str|None)

    규칙:
      - held(긍정 신호가 거부됨): clean 리셋. 이벤트가 늘고 있으면 veto도 리셋(경기가 진짜
        진행 중), 늘지 않는데 신호만 계속이면 veto를 올려 END_CONFIRM_POLLS회째에 수용
        (몰수/중단 탈출구).
      - 종료 아님: 둘 다 리셋.
      - 깨끗한 종료 판정: clean을 올리고 END_CONFIRM_MIN_POLLS회 연속일 때만 커밋.
        **첫 주기에는 절대 커밋하지 않는다** - 종료는 되돌릴 수 없는 결정이라 단발성
        응답 이상에 베팅하지 않는다.
    """
    clean, veto = int(state.get("clean", 0)), int(state.get("veto", 0))
    if held:
        clean = 0
        veto = 0 if grew else veto + 1
        state.update(clean=clean, veto=veto)
        if veto >= END_CONFIRM_POLLS:
            return True, (f"거부 증거가 있었지만 {veto}주기 연속 종료 신호 + 이벤트 증가 없음 "
                          f"-> 수용 ({held})")
        return False, None
    if not ended:
        state.update(clean=0, veto=0)
        return False, None
    clean, veto = clean + 1, 0
    state.update(clean=clean, veto=veto)
    if clean >= END_CONFIRM_MIN_POLLS:
        return True, f"종료 신호 {clean}주기 연속 확인"
    return False, (f"종료 신호 1회차({clean}/{END_CONFIRM_MIN_POLLS}) - "
                   f"한 주기 더 같은 신호가 유지되어야 확정")


def fetch_snapshot(gmkey, raw_log=True):
    """한 경기의 라이브 스냅샷. text-cast만 필수, 나머지는 없으면 없는 대로 진행.

    fetch_one_game()이 아니라 fetch_endpoint()를 쓰는 이유는 fetch_kbl_data.fetch_endpoint의
    docstring 참고 - 라이브 폴링이 raw/games/ 캐시를 만들면 종료 후 배치가 반쪽짜리
    문자중계를 공식 데이터로 착각한다."""
    snap = {"gmkey": gmkey, "fetched_at": datetime.datetime.now(KST).isoformat(),
            "events": None, "meta": None, "player_stat": None, "errors": {}}
    try:
        snap["events"] = fkd.fetch_endpoint(gmkey, "text-cast")
    except Exception as e:  # noqa: BLE001
        snap["errors"]["text-cast"] = repr(e)
    for name in ("meta", "player-stat"):
        try:
            snap["meta" if name == "meta" else "player_stat"] = fkd.fetch_endpoint(gmkey, name)
        except Exception as e:  # noqa: BLE001
            snap["errors"][name] = repr(e)
    if raw_log:
        write_raw_log(gmkey, snap)
    if snap["events"] is None:
        raise RuntimeError(f"text-cast 조회 실패: {snap['errors'].get('text-cast')}")
    return snap


class ReplaySource:
    """끝난 경기의 저장된 문자중계를 '지금 벌어지는 경기'처럼 조금씩 흘려보내는 소스.

    live_collector --dry-run-source와 replay_dry_run.py가 공유한다(같은 코드 경로를 타야
    드라이런이 실제 라이브 경로를 증명한다는 의미가 있음).

    시간 모델: 벽시계 경과 x speed 만큼 '경기 시계'가 흘렀다고 보고 그때까지의 이벤트만
    노출한다. 실제 경기는 작전타임/자유투로 벽시계가 훨씬 길지만, 리플레이 목적(이벤트가
    시간 순으로 조금씩 늘어나는 상황 재현)에는 경기 시계 기준이 단순하고 충분하다.
    speed=60이면 40분 경기가 약 40초, speed=1이면 실제 경기 길이 그대로."""

    def __init__(self, source_gmkey, speed=60.0, raw_log_gmkey=None, raw_log=False,
                 start_elapsed=0.0, meta_isended=True):
        path = os.path.join(RAW_DIR, "games", source_gmkey, "text-cast.json")
        with open(path, encoding="utf-8") as f:
            self.events = normalise_events(json.load(f))
        if not self.events:
            raise RuntimeError(f"{source_gmkey}: 문자중계가 비어있음")
        pstat_path = os.path.join(RAW_DIR, "games", source_gmkey, "player-stat.json")
        self.player_stat = None
        if os.path.exists(pstat_path):
            with open(pstat_path, encoding="utf-8") as f:
                self.player_stat = json.load(f)
        self.source_gmkey = source_gmkey
        self.speed = float(speed)
        self.raw_log_gmkey = raw_log_gmkey
        self.raw_log = raw_log
        # meta_isended=False - "API가 isEnded를 아예 안 준다"는 최악의 경우를 재현한다.
        # 그러면 종료 판정이 휴리스틱(마지막 이벤트가 Q4+ 009, 동점 아님)에만 의존하게 되고,
        # 미검증 API 리스크 중 제일 아픈 시나리오를 실제로 돌려볼 수 있다.
        self.meta_isended = meta_isended
        # start_elapsed - 이미 어느 지점까지 재생해둔 상태에서 이어붙일 때(예: --speed 1로
        # 앞 몇 분을 실시간으로 돌린 뒤 나머지를 빨리 감기). 시계를 과거로 되돌려 시작하면
        # 이미 DB에 들어간 뒷부분 이벤트와 스코어가 어긋나 보이므로 반드시 이어서 시작한다.
        self.started_at = time.time() - (float(start_elapsed) / max(self.speed, 1e-9))
        self.total_elapsed = mge.cumulative_elapsed(
            self.events[-1]["q"], self.events[-1]["m"], self.events[-1]["s"])
        self.forced_finish = False

    def sim_elapsed(self):
        return (time.time() - self.started_at) * self.speed

    def finished(self):
        return self.forced_finish or self.sim_elapsed() >= self.total_elapsed

    def finish_now(self):
        """--speed 1 구간 검증처럼 '앞부분만 실시간으로 돌리고 나머지는 빨리 감기'가
        필요할 때 남은 이벤트를 한 번에 흘려보내게 만든다(이벤트가 뭉텅이로 도착하는
        상황 자체도 미검증 API 리스크 항목이라 일부러 재현해볼 가치가 있음)."""
        self.forced_finish = True

    def __call__(self, gmkey):
        if self.forced_finish:
            visible = list(self.events)
        else:
            # 반드시 '앞에서부터 연속된 구간'이어야 한다 - 라이브에서 이벤트는 앞부분부터
            # 쌓이지 중간이 비지 않는다. (조건 필터가 아니라 첫 위반에서 끊는 이유)
            cutoff = self.sim_elapsed()
            n = 0
            for e in self.events:
                if mge.cumulative_elapsed(e["q"], e["m"], e["s"]) > cutoff:
                    break
                n += 1
            visible = self.events[:n]
        ended = self.finished()
        snap = {
            "gmkey": gmkey, "fetched_at": datetime.datetime.now(KST).isoformat(),
            "events": visible,
            # meta는 진짜 API 응답과 같은 모양으로 최소한만 흉내(isEnded 신호 경로 검증용).
            "meta": ({"game": {"isEnded": 1 if ended else 0}} if self.meta_isended else None),
            "player_stat": self.player_stat,
            "errors": {},
            "replay": {"source_gmkey": self.source_gmkey, "speed": self.speed,
                       "sim_elapsed": round(self.sim_elapsed(), 1),
                       "total_elapsed": self.total_elapsed},
        }
        if self.raw_log:
            write_raw_log(self.raw_log_gmkey or gmkey, snap)
        return snap


def normalise_events(raw):
    """API 응답을 이벤트 리스트로 정규화. 미검증 리스크 대응:
      - 리스트가 아니면(에러 객체 등) 빈 리스트.
      - dict가 아니거나 q/m/s가 없는/숫자가 아닌 행은 버림.
      - **순서는 API가 준 그대로 유지한다.** 처음엔 n(경기 내 순번)으로 정렬해서 순서 꼬임에
        대비하려 했는데, 저장된 경기 400개를 표본으로 확인해보니 S29G01N39에서 n이 쿼터
        경계에서 두 번 역행한다(Q1 마지막 n=163 다음 Q2 첫 n=158). 즉 n은 전역 단조가
        아니고, 진짜 시간순은 API가 돌려주는 순서다. 여기서 정렬해버리면 event_order가
        migrate_game_events_to_supabase.py(파일 순서 그대로 사용)와 어긋나서, 같은 경기가
        라이브일 때와 정산 후에 서로 다른 이벤트 번호를 갖게 된다 - 절대 안 됨."""
    if not isinstance(raw, list):
        return []
    out = []
    for e in raw:
        if not isinstance(e, dict):
            continue
        q = e.get("q")
        m, s = e.get("m"), e.get("s")
        if not isinstance(q, str) or not q:
            continue
        try:
            m = int(m)
            s = int(s)
        except (TypeError, ValueError):
            continue
        e = dict(e)
        e["m"], e["s"] = m, s
        out.append(e)
    return out


def tally_score(events, home_tcode, away_tcode):
    """득점 코드만으로 현재 스코어를 계산 - build_event_rows의 누적 규칙과 동일.
    종료 판정 휴리스틱이 '동점이면 연장'을 알아야 해서 행 생성보다 먼저 필요하다."""
    home = away = 0
    for e in events:
        pts = mge.SCORE_CODES.get(e.get("a"))
        if not pts:
            continue
        if e.get("t") == home_tcode:
            home += pts
        elif e.get("t") == away_tcode:
            away += pts
    return home, away


def cast_state(events):
    """문자중계 자체가 말해주는 진행 상태 - detect_ended의 '반대 증거'를 만드는 곳.

    001(피리어드 시작)과 009(피리어드 종료)는 쿼터마다 짝으로 나온다(저장된 경기에서 확인:
    001은 Q1~Q4 시작 지점, 009는 각 쿼터 0:00). 마지막 009가 마지막 001보다 뒤면 "지금
    피리어드가 끝난 상태". 009가 문자중계의 마지막 이벤트라는 보장은 없다 - 실제로
    S47G03N16은 Q4 009(인덱스 616) 뒤에 교체 OUT 이벤트가 11개 더 붙어 있다.

    반환 dict:
      in_progress   지금 어떤 피리어드를 뛰는 중(마지막 001이 마지막 009보다 뒤)
      period_idx    마지막으로 종료된(또는 진행 중인) 피리어드의 QUARTER_ORDER 인덱스, 모르면 -1
      ended_idx     마지막 009가 속한 피리어드 인덱스, 009가 없으면 -1
    """
    last_start = last_end = None
    for i, e in enumerate(events):
        a = e.get("a")
        if a == PERIOD_START_CODE:
            last_start = i
        elif a == GAME_OVER_CODE:
            last_end = i

    def qidx(i):
        if i is None:
            return -1
        q = events[i].get("q")
        return mge.QUARTER_ORDER.index(q) if q in mge.QUARTER_ORDER else -1

    in_progress = last_start is not None and (last_end is None or last_start > last_end)
    period_idx = qidx(last_start) if in_progress else qidx(last_end)
    return {"in_progress": in_progress, "period_idx": period_idx, "ended_idx": qidx(last_end)}


def detect_ended(snapshot, events, schedule_entry=None, home_score=None, away_score=None,
                 prev_event_count=None):
    """종료 판정. 반환 (ended: bool, 근거: str|None, 보류사유: str|None)

    !!! 드라이런에서 실제로 잡은 버그 !!! - 처음엔 "문자중계에 009(schema_supabase.sql의
    action_codes 시드 라벨: '경기 종료')가 보이면 끝"으로 짰는데, 저장된 200경기를 세어보니
    009는 **쿼터마다 하나씩** 나온다(정규경기 4개 + 연장 있으면 더). 즉 009는 '경기 종료'가
    아니라 '해당 피리어드 종료'다.

    !!! 2026-09-02 재설계 - 부정 증거가 긍정 신호를 거부할 수 있어야 한다 !!!
    예전 구현은 signals 리스트를 만들어놓고 **1이 하나라도 있으면 즉시 True**를 돌려줬다.
    그래서 애써 모아둔 부정 증거(playingQuarter가 진짜 쿼터 코드 = "그 쿼터를 지금 뛰는 중")가
    stale/premature한 schedule.isEnded=1을 절대 거부하지 못했다 - docstring이 설명하는
    우선순위와 코드가 달랐다. 그리고 그 오판은 **되돌릴 수 없다**: update_game_row가
    is_ended를 단조로 세우고(true->false 불가), poll_cycle이 그 경기를 pending에서 빼고,
    select_target_games는 is_ended=true를 제외하므로 남은 경기가 영영 수집되지 않는다
    (사이트는 경기 중간에 '종료'로 굳는다). 라이브 API 거동이 한 번도 관측된 적 없다는
    전제에서, 단일 긍정 플래그에 이렇게 크게 베팅하는 건 방향이 반대다.

    그래서 지금 판정 순서:
      1. 긍정 신호 수집: schedule.isEnded==1 / meta.game.isEnded==1.
      2. **거부(veto) 증거 수집** - 하나라도 있으면 이번 주기엔 종료로 넘기지 않는다:
         a. meta.game.playingQuarter가 진짜 쿼터 코드   -> 그 쿼터를 지금 뛰는 중
         b. 직전 폴링보다 문자중계 이벤트 수가 늘어남   -> 경기가 아직 이벤트를 뿜는 중
            (= "두 주기 연속으로 같은 신호가 유지되어야 확정"을 자연스럽게 구현. 폴링
            간격만큼만 늦어지고, 그 대가로 단발성 오신호가 전부 걸러진다.)
         c. 문자중계상 Q1~Q3를 진행 중                  -> 정상 경기는 그 시점에 끝나지 않음
      3. 거부 증거 없이 긍정 신호가 있으면 종료.
      4. 명시 신호가 아예 없을 때만 휴리스틱: 마지막 009가 마지막 001보다 뒤이고(= 지금
         피리어드가 끝난 상태), 그 피리어드가 Q4 이후이고, 동점이 아니면 종료
         (동점이면 연장이 붙는다). 시계가 0:00에 닿았다는 것만으로는 절대 끝으로 보지 않는다.

    2b/2c가 계속 유지되는 비정상 상황(예: 몰수패로 Q2에 진짜 종료)에서 영원히 안 끝나면
    곤란하므로, 호출자(GameIngestor -> end_gate)가 "이벤트가 더는 늘지 않는데 긍정 신호만
    계속 뜨는" 주기를 세어 END_CONFIRM_POLLS회 뒤에는 API 말을 받아들인다.

    !!! 이 함수는 '이번 주기의 판정'만 한다 !!! 실제 종료 커밋은 end_gate()가 결정한다 -
    거부 증거가 하나도 없는 깨끗한 판정이라도 END_CONFIRM_MIN_POLLS주기 연속 유지돼야
    is_ended가 세워진다. 그래서 이 함수의 반환값 True는 "끝났다"가 아니라 "이번 응답만
    보면 끝난 것으로 보인다"는 뜻이다(회귀 테스트도 그 의미로 고정돼 있다)."""
    positives, explicit = [], False
    if isinstance(schedule_entry, dict):
        f = _ended_flag(schedule_entry.get("isEnded"))
        if f is not None:
            explicit = True
            if f == 1:
                positives.append("schedule.isEnded=1")
    meta = snapshot.get("meta") if isinstance(snapshot, dict) else None
    playing_quarter = None
    if isinstance(meta, dict):
        game = meta.get("game") if isinstance(meta.get("game"), dict) else meta
        if isinstance(game, dict):
            f = _ended_flag(game.get("isEnded"))
            if f is not None:
                explicit = True
                if f == 1:
                    positives.append("meta.game.isEnded=1")
            # playingQuarter - 2026-09-02에 실제 KBL API를 찔러보고 발견한 필드(그전까지
            # 이 코드베이스 어디서도 안 썼음). 실측 두 상태:
            #   미래 경기(S49G01N1): isEnded=0, isStarted=0, playingQuarter='X'
            #   종료 경기(S47G03N16): isEnded=1, isStarted=1, playingQuarter='X'
            # 즉 'X'는 "지금 진행 중인 쿼터 없음"이고 경기 전/후 양쪽에서 나오므로 종료
            # 신호로 쓸 수 없다. 반대로 값이 진짜 쿼터 코드(Q1~X4)면 "그 쿼터를 지금 뛰는
            # 중"이라는 뜻일 수밖에 없으므로 **'아직 안 끝남'의 강한 근거**로 쓴다.
            # (진행 중 실제 값은 여전히 미관측 - 그래서 긍정 신호로는 절대 쓰지 않음.)
            pq = game.get("playingQuarter")
            if isinstance(pq, str) and pq in mge.QUARTER_ORDER:
                playing_quarter = pq
                explicit = True

    st = cast_state(events) if events else {"in_progress": False, "period_idx": -1, "ended_idx": -1}
    grew = prev_event_count is not None and len(events) > prev_event_count

    vetoes = []
    if playing_quarter:
        vetoes.append(f"meta.game.playingQuarter={playing_quarter}(그 쿼터 진행 중)")
    if grew:
        vetoes.append(f"문자중계 이벤트 증가({prev_event_count}->{len(events)}건)")
    if st["in_progress"] and 0 <= st["period_idx"] < 3:
        vetoes.append(f"문자중계상 {mge.QUARTER_ORDER[st['period_idx']]} 진행 중")

    if positives:
        if vetoes:
            return False, None, f"{positives[0]} 이지만 보류 - " + " / ".join(vetoes)
        return True, positives[0], None
    if explicit:
        return False, None, None  # 명시 신호가 있고 전부 '안 끝남' - 휴리스틱으로 뒤집지 않는다

    if not events or st["ended_idx"] < 0 or st["in_progress"]:
        return False, None, None
    if st["ended_idx"] < 3:  # Q1~Q3의 009는 그냥 쿼터 종료
        return False, None, None
    if grew:
        return False, None, (f"휴리스틱 종료 조건은 충족했지만 보류 - "
                             f"문자중계 이벤트 증가({prev_event_count}->{len(events)}건)")
    if home_score is not None and away_score is not None and home_score == away_score:
        return False, None, None  # 동점으로 피리어드 종료 -> 연장이 붙는다
    q = mge.QUARTER_ORDER[st["ended_idx"]]
    return True, (f"휴리스틱: {q} 종료({GAME_OVER_CODE}) 이후 새 피리어드 없음 + 동점 아님"
                  f"(isEnded 신호가 응답에 아예 없음)"), None


# ---------------------------------------------------------------------------
# 경기 전 컨텍스트 / 로스터
# ---------------------------------------------------------------------------

def load_pregame_context(cur, gmkeys):
    """pregame_features에서 라이브 승률모델의 컨텍스트 2개(netrtgDiff/synergyDiff)를 읽음.

    시즌 극초반 폴백: 그 경기의 pregame_features 행이 없거나(표본 부족으로
    sync_upcoming_games.py가 예측을 보류한 경우 - predict_upcoming_games의 MIN_HISTORY
    미만) netrtg/synergy 중 한쪽이라도 NULL이면 그 항목을 중립(0.0)으로 둔다.
    migrate_game_events_to_supabase.build_game_rows가 None을 0.0으로 처리하는 기존 규칙과
    같다. 이때 home_win_prob은 objective_prob과 정확히 같은 값이 되고, 사이트의
    "왜 이 승률인가" 패널(components/GameReplay.tsx)이 두 막대를 같은 길이로 보여준다 -
    격차가 0이라 설명 문장도 안 붙는다. 즉 별도 컬럼 없이도 "아직 팀 전력 정보가 없어서
    점수·시간만 본 확률"이라는 사실이 화면에 정직하게 드러난다."""
    ctx = {}
    if not gmkeys:
        return ctx
    cur.execute("""
        select gmkey, home_netrtg, away_netrtg,
               home_synergy_onoff_rating, away_synergy_onoff_rating
        from pregame_features where gmkey = any(%s)
    """, (list(gmkeys),))
    found = {r[0]: r[1:] for r in cur.fetchall()}
    for gk in gmkeys:
        row = found.get(gk)
        if row is None:
            ctx[gk] = {"netrtgDiff": 0.0, "synergyDiff": 0.0, "neutral": True,
                       "reason": "pregame_features 행 없음(시즌 극초반 표본 부족)"}
            continue
        h_net, a_net, h_syn, a_syn = row
        net = (h_net - a_net) if (h_net is not None and a_net is not None) else None
        syn = (h_syn - a_syn) if (h_syn is not None and a_syn is not None) else None
        neutral = net is None and syn is None
        reason = None
        if net is None or syn is None:
            reason = f"netrtg={'있음' if net is not None else '없음'}, synergy={'있음' if syn is not None else '없음'}"
        ctx[gk] = {"netrtgDiff": net if net is not None else 0.0,
                   "synergyDiff": syn if syn is not None else 0.0,
                   "neutral": neutral, "reason": reason}
    return ctx


def load_valid_pcodes(cur):
    """game_events.pcode는 players(pcode) FK - 아직 players에 없는 신인이 문자중계에
    등장하면 INSERT 자체가 터진다. 라이브가 FK 때문에 죽는 것보다 그 이벤트의 pcode만
    NULL로 두는 편이 낫다(경기 종료 후 배치가 정식 pcode로 정정한다)."""
    cur.execute("select pcode from players")
    return {r[0] for r in cur.fetchall()}


def roster_from_player_stat(player_stat, home_tcode, away_tcode):
    """migrate_game_events_to_supabase.build_roster_lookup과 정확히 같은 매핑."""
    name_to_pcode = {}
    starters = {home_tcode: [], away_tcode: []}
    for row in player_stat or []:
        if not isinstance(row, dict):
            continue
        p = row.get("player")
        if not isinstance(p, dict) or not p.get("pcode"):
            continue
        name_to_pcode[(p.get("tcode"), p.get("pname"))] = p["pcode"]
        if row.get("startFlag") == 1 and p.get("tcode") in starters:
            starters[p["tcode"]].append(p["pcode"])
    return name_to_pcode, starters


def roster_from_db(cur, home_tcode, away_tcode, since_date):
    """player-stat이 경기 중엔 안 나올 수도 있다는 가정(미검증)에 대한 폴백 - 최근 경기
    박스스코어에서 (팀, 선수이름) -> pcode 맵만 복원한다. 선발 5인은 알 수 없으므로 빈
    리스트로 두고, 문자중계 맨 앞의 101(교체 IN) 이벤트들로 라인업이 자연히 채워진다
    (실제 저장된 경기들을 보면 경기 시작 시 선발 10명이 전부 101 이벤트로 찍힌다)."""
    cur.execute("""
        select distinct on (gps.tcode, p.name) gps.tcode, p.name, gps.pcode
        from game_player_stats gps
        join players p on p.pcode = gps.pcode
        join games g on g.gmkey = gps.gmkey
        where gps.tcode = any(%s) and g.game_date >= %s
        order by gps.tcode, p.name, g.game_date desc
    """, ([home_tcode, away_tcode], since_date))
    name_to_pcode = {(r[0], r[1]): r[2] for r in cur.fetchall()}
    return name_to_pcode, {home_tcode: [], away_tcode: []}


# ---------------------------------------------------------------------------
# 이벤트 -> 행 (migrate_game_events_to_supabase와 동일 매핑)
# ---------------------------------------------------------------------------

def total_elapsed_for(events, ended):
    """모델 피처 remainingSec의 기준이 되는 '경기 전체 길이'.

    종료: migrate_game_events_to_supabase.build_game_rows와 완전히 동일하게 마지막
          이벤트의 누적 경과시간. 그래야 라이브 최종값과 배치 재계산값이 일치한다.
    진행중: 최종 길이를 알 수 없으니 backend/src/index.ts의 regulationTotal과 같은 규칙 -
          규정시간(2400초), 연장 이벤트가 보이면 쿼터당 300초씩 추가. 즉 '지금 보이는
          마지막 쿼터가 끝나면 경기가 끝난다'고 추정. 연장에 들어가는 순간 추정이
          갱신되면서 이전 이벤트들의 승률도 같이 재계산된다(그래서 매 폴링마다 전체
          스냅샷을 다시 계산하고 UPSERT한다)."""
    last = events[-1]
    if ended:
        return mge.cumulative_elapsed(last["q"], last["m"], last["s"])
    q = last["q"]
    if q not in mge.QUARTER_ORDER:
        return REGULATION_SEC  # 모르는 쿼터 표기 - 규정시간으로 보수적 추정
    # cumulative_elapsed(q, 0, 0) = "그 쿼터가 끝나는 시점의 누적 경과". Q1~Q3면 규정시간이
    # 더 크므로 max로 걸러진다(= 아직 연장 없음). X1이면 2700, X2면 3000...으로 자동 확장.
    return max(REGULATION_SEC, mge.cumulative_elapsed(q, 0, 0))


def build_event_rows(gmkey, home_tcode, away_tcode, events, name_to_pcode, starters,
                     ctx, ended, model, valid_pcodes=None):
    """migrate_game_events_to_supabase.build_game_rows의 이벤트 루프를 그대로 따르되
    (라인업 복원 / 득점 누적 / PRE 행 / 피처 구성 / event_order 부여 전부 동일),
    라이브에 필요한 두 가지만 다르다:
      1. total_elapsed 추정(위 total_elapsed_for) - 진행 중엔 최종 길이를 모름.
      2. players에 아직 없는 pcode는 NULL 처리(FK 방어).
    반환값은 migrate와 완전히 같은 15컬럼 튜플 리스트."""
    lineup = {home_tcode: list(starters.get(home_tcode, [])),
              away_tcode: list(starters.get(away_tcode, []))}
    total_elapsed = total_elapsed_for(events, ended)
    if total_elapsed <= 0:
        return []

    net = ctx["netrtgDiff"]
    syn = ctx["synergyDiff"]

    def feat_row(score_diff, remaining_sec):
        return [score_diff, remaining_sec, mge.scaled_score_diff(score_diff, remaining_sec), net, syn]

    rows = [feat_row(0, total_elapsed)]
    neutral_rows = [[0, total_elapsed, mge.scaled_score_diff(0, total_elapsed), 0.0, 0.0]]
    meta_rows = [{
        "q": "PRE", "m": None, "s": None, "action": None, "pcode": None, "team": None,
        "homeScore": 0, "awayScore": 0,
        "homeLineup": list(lineup[home_tcode]), "awayLineup": list(lineup[away_tcode]),
    }]

    def resolve_pcode(team, player):
        if not player or not team:
            return None
        pc = name_to_pcode.get((team, player))
        if pc is not None and valid_pcodes is not None and pc not in valid_pcodes:
            return None  # players 테이블에 아직 없는 선수 - FK 위반 대신 NULL
        return pc

    home_score, away_score = 0, 0
    for evt in events:
        code = evt.get("a")
        team = evt.get("t")
        player = evt.get("p")

        if code == "101" and team in lineup and player:
            pcode = resolve_pcode(team, player)
            if pcode and pcode not in lineup[team]:
                lineup[team].append(pcode)
        elif code == "102" and team in lineup and player:
            pcode = resolve_pcode(team, player)
            if pcode and pcode in lineup[team]:
                lineup[team].remove(pcode)

        if code in mge.SCORE_CODES and team in (home_tcode, away_tcode):
            pts = mge.SCORE_CODES[code]
            if team == home_tcode:
                home_score += pts
            else:
                away_score += pts

        elapsed = mge.cumulative_elapsed(evt["q"], evt["m"], evt["s"])
        remaining = total_elapsed - elapsed
        score_diff = home_score - away_score
        rows.append(feat_row(score_diff, remaining))
        neutral_rows.append([score_diff, remaining, mge.scaled_score_diff(score_diff, remaining), 0.0, 0.0])
        meta_rows.append({
            "q": evt["q"], "m": evt["m"], "s": evt["s"], "action": code or None,
            "pcode": resolve_pcode(team, player),
            "team": team or None,
            "homeScore": home_score, "awayScore": away_score,
            "homeLineup": list(lineup[home_tcode]), "awayLineup": list(lineup[away_tcode]),
        })

    import numpy as np
    probs = model.predict_proba(np.array(rows, dtype=float))[:, 1]
    probs_neutral = model.predict_proba(np.array(neutral_rows, dtype=float))[:, 1]
    return mge.assemble_events(gmkey, meta_rows, probs, probs_neutral)


# ---------------------------------------------------------------------------
# DB 쓰기
# ---------------------------------------------------------------------------

UPSERT_EVENTS_SQL = """
    insert into game_events (gmkey, event_order, quarter, clock_min, clock_sec,
        action_code, pcode, tcode, home_score, away_score, home_lineup, away_lineup,
        home_win_prob, wpa_home, objective_prob) values %s
    on conflict (gmkey, event_order) do update set
""" + ", ".join(f"{c}=excluded.{c}" for c in mge.EVENT_COLS)


def upsert_events(cur, rows):
    """DO UPDATE인 이유: (a) 같은 이벤트를 다시 폴링해도 멱등, (b) 진행 중 경기의 승률은
    total_elapsed 추정이 갱신되면(연장 진입 등) 과거 이벤트까지 바뀌므로 정정이 필요,
    (c) KBL이 이벤트를 수정(오심 정정 등)해도 깨끗하게 덮어써야 함."""
    from psycopg2.extras import execute_values
    if not rows:
        return 0
    execute_values(cur, UPSERT_EVENTS_SQL, rows, page_size=1000)
    return len(rows)


def update_game_row(cur, gmkey, home_score, away_score, ended):
    """예정 -> 진행중 -> 종료를 실제로 넘기는 한 줄. is_ended는 절대 true->false로
    되돌리지 않는다(정산이 끝난 경기를 라이브가 다시 진행중으로 만드는 사고 방지)."""
    cur.execute("""
        update games set home_score=%s, away_score=%s, is_ended=(games.is_ended or %s)
        where gmkey=%s
    """, (home_score, away_score, bool(ended), gmkey))
    return cur.rowcount


class GameIngestor:
    """경기 하나의 라이브 적재 상태. 폴링마다 '지금까지의 전체 스냅샷'을 다시 계산하고
    직전에 쓴 값과 다른 행만 UPSERT한다(뭉텅이 도착/정정/연장 진입 전부 같은 경로로 처리).

    memo(직전에 쓴 행)를 비워둔 새 인스턴스로 같은 스냅샷을 다시 넣으면 전 행이 다시
    UPSERT되므로 멱등성 검증에 그대로 쓸 수 있다(replay_dry_run.py의 3번 검증)."""

    def __init__(self, gmkey, home_tcode, away_tcode, ctx, model, valid_pcodes=None):
        self.gmkey = gmkey
        self.home_tcode = home_tcode
        self.away_tcode = away_tcode
        self.ctx = ctx
        self.model = model
        self.valid_pcodes = valid_pcodes
        self.name_to_pcode = {}
        self.starters = {home_tcode: [], away_tcode: []}
        self.roster_source = None
        self._written = {}
        self.reconciled = False
        # 정산 재시도 상태(2026-09-02) - reconcile_finished_game()이 실패하면 여기 기록만
        # 남기고 pending에 그대로 둬서 다음 주기에 다시 시도한다. 예전엔 호출 '전에'
        # reconciled=True를 세우고 종료코드를 안 봐서, 실패한 정산이 성공으로 둔갑했다.
        self.reconcile_attempts = 0
        self.reconcile_error = None
        # detect_ended의 '이벤트 증가' 거부 증거용. 첫 ingest 때 DB의 기존 이벤트 수로
        # 시드한다 - 그래야 --once(매 실행이 새 프로세스)에서도 주기 간 비교가 성립한다.
        self._last_event_count = None
        # 종료 신호 확정 카운터(end_gate). {"clean": 깨끗한 종료 판정 연속 주기,
        # "veto": 거부됐는데도 신호가 유지된 연속 주기}. 첫 ingest 때 raw/live_state에서
        # 읽어와 프로세스 경계를 넘긴다(--once는 매 실행이 새 프로세스).
        self.end_state = None

    def set_roster(self, name_to_pcode, starters, source):
        self.name_to_pcode = name_to_pcode
        self.starters = starters
        self.roster_source = source
        self._written = {}  # 로스터가 바뀌면 라인업/pcode가 바뀌므로 전 행 재작성

    def ensure_roster(self, cur, snapshot):
        """가능하면 공식 player-stat, 없으면 DB 폴백. 경기 중간에 player-stat이 뒤늦게
        나타나면 그때 승격한다(선발 정보가 들어오면 라인업 복원이 정확해짐)."""
        pstat = snapshot.get("player_stat")
        if isinstance(pstat, list) and pstat:
            n2p, starters = roster_from_player_stat(pstat, self.home_tcode, self.away_tcode)
            if n2p and self.roster_source != "player-stat":
                self.set_roster(n2p, starters, "player-stat")
                log(f"  {self.gmkey}: 로스터 = 공식 player-stat "
                    f"({len(n2p)}명, 선발 {sum(len(v) for v in starters.values())}명)")
                return
            if self.roster_source == "player-stat":
                return
        if self.roster_source is None:
            since = (datetime.datetime.now(KST) - datetime.timedelta(days=400)).strftime("%Y-%m-%d")
            n2p, starters = roster_from_db(cur, self.home_tcode, self.away_tcode, since)
            self.set_roster(n2p, starters, "db-fallback")
            log(f"  {self.gmkey}: player-stat 없음 - DB 로스터 폴백({len(n2p)}명, "
                f"선발은 문자중계 101 이벤트로 복원)")

    def seed_event_count(self, cur):
        """DB에 이미 들어있는 이 경기의 이벤트 수 - detect_ended의 '이벤트 증가' 비교 기준.
        프로세스 안에서는 직전 폴링 값이 이어지지만, --once는 매 실행이 새 프로세스라
        DB가 유일한 '직전 상태'다."""
        if self._last_event_count is None:
            cur.execute("select count(*) from game_events where gmkey=%s", (self.gmkey,))
            # PRE 행(event_order=0)은 문자중계 이벤트가 아니라 우리가 얹은 행이라 뺀다.
            self._last_event_count = max(0, cur.fetchone()[0] - 1)

    def ingest(self, cur, snapshot, schedule_entry=None):
        """스냅샷 하나를 DB에 반영. 반환 요약 dict."""
        if not isinstance(snapshot, dict):
            raise TypeError(f"스냅샷이 dict가 아님({type(snapshot).__name__}) - "
                            f"API가 예상 밖 응답을 준 것으로 보고 이번 주기는 버림")
        self.seed_event_count(cur)
        if self.end_state is None:
            self.end_state = load_end_state(self.gmkey)
        events = normalise_events(snapshot.get("events"))
        pre_home, pre_away = tally_score(events, self.home_tcode, self.away_tcode)
        raw_ended, ended_why, held = detect_ended(snapshot, events, schedule_entry,
                                                  pre_home, pre_away, self._last_event_count)
        grew = len(events) > (self._last_event_count or 0)

        # 이번 주기의 판정을 '여러 주기에 걸친 결정'으로 바꾼다(end_gate). 깨끗한 종료
        # 판정도 첫 주기에는 커밋하지 않는다 - 종료는 되돌릴 수 없기 때문.
        before = dict(self.end_state)
        ended, gate_why = end_gate(self.end_state, raw_ended, held, grew)
        if self.end_state != before:
            save_end_state(self.gmkey, self.end_state)
        if held:
            log(f"  {self.gmkey}: 종료 신호 보류({self.end_state['veto']}/{END_CONFIRM_POLLS}) - {held}")
            if ended:
                ended_why = gate_why
                log(f"  {self.gmkey}: (주의) {ended_why}")
        elif raw_ended and not ended:
            log(f"  {self.gmkey}: 종료 신호 확인 중 - {gate_why} ({ended_why})")
        elif ended:
            ended_why = f"{ended_why} [{gate_why}]"

        if not events:
            # 경기 시작 전(문자중계 비어있음) - games 행을 건드리면 스코어가 0으로 찍혀
            # 사이트가 '예정'을 '진행중'으로 잘못 표시한다. 아무것도 하지 않는다.
            return {"gmkey": self.gmkey, "events": 0, "written": 0, "started": False,
                    "ended": False, "home_score": None, "away_score": None,
                    "ended_why": None, "held": held, "neutral_ctx": self.ctx["neutral"]}
        if ended:
            q = events[-1].get("q")
            idx = mge.QUARTER_ORDER.index(q) if q in mge.QUARTER_ORDER else -1
            if idx < 3:
                # 정상적인 경기는 Q4 전에 끝나지 않는다. 몰수/중단이면 진짜일 수 있지만
                # 그보다는 응답이 이상한 쪽이 훨씬 그럴듯하므로 로그로 크게 남긴다
                # (종료 표시 자체는 API 신호를 존중 - 어차피 정산 배치가 정본을 덮어씀).
                log(f"  {self.gmkey}: (주의) {q} 시점에 종료 신호({ended_why}) - "
                    f"몰수/중단이 아니라면 응답 이상 가능성. raw/live_logs 확인 요망")

        self.ensure_roster(cur, snapshot)
        rows = build_event_rows(self.gmkey, self.home_tcode, self.away_tcode, events,
                                self.name_to_pcode, self.starters, self.ctx, ended,
                                self.model, self.valid_pcodes)
        if not rows:
            return {"gmkey": self.gmkey, "events": len(events), "written": 0, "started": False,
                    "ended": False, "home_score": None, "away_score": None,
                    "ended_why": None, "held": held, "neutral_ctx": self.ctx["neutral"]}

        changed = [r for r in rows if self._written.get(r[1]) != r]
        new_count = sum(1 for r in changed if r[1] not in self._written)
        upsert_events(cur, changed)
        for r in changed:
            self._written[r[1]] = r
        # _last_event_count(다음 주기의 '이벤트 증가' 비교 기준)는 여기서 올리지 않는다 -
        # 커밋이 실패하면 DB엔 안 들어갔는데 기준만 앞서가서, 다음 주기에 증가가 없는 것처럼
        # 보이고 종료 거부 증거가 사라진다. poll_cycle이 commit 성공 후에 올린다.

        last = rows[-1]
        home_score, away_score = last[8], last[9]
        update_game_row(cur, self.gmkey, home_score, away_score, ended)
        return {"gmkey": self.gmkey, "events": len(events), "written": len(changed),
                "new": new_count, "updated": len(changed) - new_count, "started": True,
                "ended": ended, "ended_why": ended_why, "held": held,
                "home_score": home_score, "away_score": away_score,
                "win_prob": last[12], "objective_prob": last[14],
                "neutral_ctx": self.ctx["neutral"]}


# ---------------------------------------------------------------------------
# 종료 정산 (기존 배치 경로 재사용 - 라이브 잠정치를 공식 데이터로 덮어씀)
# ---------------------------------------------------------------------------

def official_box_ready(gmkey):
    """raw/games/<gmkey>/의 공식 박스스코어가 '스코어를 담고 있는 상태'인지 확인.

    !!! 이 검사가 왜 필요한가 !!!
    migrate_to_supabase.scan_all()은 team-record.json이 없거나 records.score가 비어 있으면
    home_score/away_score를 None으로 만든다. 종료 정산은 "KBL이 isEnded를 막 세운 순간"에
    호출되는데, 그 시점에 공식 박스스코어가 아직 안 올라와 있을 수 있다. 그 반쪽짜리
    입력으로 games를 UPSERT하면 라이브가 방금 채운 스코어가 지워진다.
    migrate_to_supabase.load_games를 비파괴(coalesce)로 고쳐서 DB 쪽은 이미 막았지만,
    애초에 의미 없는 이관을 돌리지 않는 게 맞고 '아직 준비 안 됨 -> 다음 주기 재시도'
    라는 판단을 여기서 내려야 재시도 로직이 성립한다(2중 방어)."""
    d = os.path.join(RAW_DIR, "games", gmkey)
    meta_path, tr_path = os.path.join(d, "meta.json"), os.path.join(d, "team-record.json")
    if not os.path.exists(meta_path):
        return False, "meta.json 없음"
    if not os.path.exists(tr_path):
        return False, "team-record.json 없음(공식 박스스코어 미공개)"
    try:
        with open(meta_path, encoding="utf-8") as f:
            g = json.load(f)["game"]
        with open(tr_path, encoding="utf-8") as f:
            tr = json.load(f)
    except Exception as e:  # noqa: BLE001
        return False, f"공식 파일 파싱 실패: {e}"
    scores = {}
    for row in tr if isinstance(tr, list) else []:
        if isinstance(row, dict) and row.get("tcode"):
            scores[row["tcode"]] = (row.get("records") or {}).get("score")
    h, a = scores.get(g.get("tcodeH")), scores.get(g.get("tcodeA"))
    if h is None or a is None:
        return False, f"team-record에 최종 스코어 없음(home={h}, away={a})"
    return True, f"{h}-{a}"


def reconcile_finished_game(gmkey, python_exe=None, timeout=1800):
    """경기가 끝나면 기존 배치 경로를 그대로 호출한다(새로 짜지 않음):
      1) fetch_kbl_data.fetch_one_game(force=True) - 공식 5개 엔드포인트 재수집.
         force=True가 핵심 - 캐시가 남아 있으면 반쪽짜리 데이터가 그대로 굳는다.
      2) 공식 박스스코어가 실제로 도착했는지 확인(official_box_ready). 아직이면
         **이관을 아예 돌리지 않고 ok=False로 반환** - 호출자가 다음 주기에 재시도한다.
      3) migrate_to_supabase.py --gmkeys   - 박스스코어/팀스탯/슛좌표/스코어/is_ended.
      4) migrate_game_events_to_supabase.py --gmkeys --replace - 이벤트/WPA 재계산 후
         라이브 잠정 행을 덮어씀(--replace가 없으면 DO NOTHING이라 잠정치가 남는다).
    전 단계가 UPSERT/force 재수집이라 두 번 돌려도 안전(멱등).

    반환 dict의 **"ok"가 이 함수의 계약**이다(2026-09-02 추가). 예전엔 서브프로세스
    종료코드를 로그로만 찍고 무시했는데, 그러면 exit 1로 실패한 --replace 이관이 조용히
    성공 취급되고 -> 호출자가 경기를 pending에서 빼버리고 -> select_target_games는
    is_ended=true를 제외하므로 다시 볼 기회가 영영 없어져 -> 라이브 잠정치(규정시간 추정
    remainingSec, 문자중계로 복원한 라인업)가 '공식 데이터'로 굳는다. ok=False면 호출자가
    반드시 재시도해야 한다."""
    if gmkey.startswith(SYNTHETIC_PREFIX):
        log(f"  {gmkey}: 합성 gmkey - 정산 배치 생략(진짜 KBL 경기가 아님)")
        return {"skipped": "synthetic", "ok": True}

    log(f"  {gmkey}: 종료 정산 시작(공식 데이터 재수집 -> 배치 이관)")
    result = {"fetch": None, "migrate": None, "events": None, "ok": False, "why": None}
    try:
        result["fetch"] = fkd.fetch_one_game(gmkey, force=True)
        log(f"    재수집: {result['fetch']}")
    except Exception as e:  # noqa: BLE001
        result["fetch"] = f"error: {e}"
        log(f"    재수집 실패: {e}")

    ready, detail = official_box_ready(gmkey)
    if not ready:
        result["why"] = f"공식 박스스코어 미도착({detail})"
        log(f"    정산 보류 - {result['why']}. 이관을 돌리지 않고 다음 주기에 재시도한다"
            f"(반쪽 데이터로 이관하면 스코어가 NULL로 덮일 수 있음).")
        return result
    log(f"    공식 박스스코어 확인: {detail}")

    load_env_supabase()
    env = dict(os.environ)
    exe = python_exe or resolve_python()
    failures = []
    for key, argv in (("migrate", [exe, "migrate_to_supabase.py", "--gmkeys", gmkey]),
                      ("events", [exe, "migrate_game_events_to_supabase.py",
                                  "--gmkeys", gmkey, "--replace"])):
        try:
            p = subprocess.run(argv, cwd=BASE, env=env, timeout=timeout)
            result[key] = p.returncode
            log(f"    {argv[1]} -> exit {p.returncode}")
            if p.returncode != 0:
                failures.append(f"{argv[1]} exit {p.returncode}")
        except Exception as e:  # noqa: BLE001
            result[key] = f"error: {e}"
            failures.append(f"{argv[1]} {type(e).__name__}: {e}")
            log(f"    {argv[1]} 실패: {e}")
    result["ok"] = not failures
    if failures:
        result["why"] = "; ".join(failures)
        log(f"    정산 실패 - {result['why']}")
    return result


# ---------------------------------------------------------------------------
# 대상 선정 / 루프
# ---------------------------------------------------------------------------

def select_target_games(cur, date_str, gmkey=None):
    """오늘(KST) 열리는 경기 중 아직 안 끝난 것 = 예정(스코어 NULL) + 진행중(스코어 있음).
    is_ended=true인 경기는 이미 정산됐으므로 폴링 대상이 아니다."""
    if gmkey:
        cur.execute("""select gmkey, home_tcode, away_tcode, home_score, away_score,
                              is_ended, game_date, game_start from games where gmkey=%s""", (gmkey,))
    else:
        cur.execute("""select gmkey, home_tcode, away_tcode, home_score, away_score,
                              is_ended, game_date, game_start
                       from games where game_date=%s and is_ended=false
                       order by game_start nulls last, gmkey""", (date_str,))
    return [{"gmkey": r[0], "home_tcode": r[1], "away_tcode": r[2], "home_score": r[3],
             "away_score": r[4], "is_ended": r[5], "game_date": r[6], "game_start": r[7]}
            for r in cur.fetchall()]


def fetch_schedule_entries(date_str):
    """KBL 스케줄에서 오늘 경기의 isEnded를 같이 봄(종료 신호 이중화). 실패해도 무시 -
    문자중계/meta 쪽 신호로도 종료를 판정할 수 있다.
    date_str은 문자열("YYYY-MM-DD")이든 datetime.date든 받는다(DB에서 온 값은 date 타입)."""
    try:
        ymd = (date_str.strftime("%Y%m%d") if hasattr(date_str, "strftime")
               else str(date_str).replace("-", ""))
        games = fkd.load_target_games(seasons=None, categories=CATEGORIES,
                                      from_date=ymd, to_date=ymd,
                                      use_cache=False, is_ended=None)
        return {g["gmkey"]: g for g in games}
    except Exception as e:  # noqa: BLE001
        log(f"  (경고) 스케줄 조회 실패({e}) - 종료 판정은 문자중계/meta 신호만 사용")
        return {}


def write_status(conn, gmkey, events=None, error=None):
    """감시용 심박(live_collector_status) - Supabase pg_cron이 이걸 보고 멈춤을 Discord로 알린다
    (tools/live_collector_watch.sql). 적재와 별도 트랜잭션이고 실패해도 삼킨다 - 감시 때문에
    수집이 깨지면 안 된다. 이벤트 수가 늘었을 때만 last_event_at을 올린다."""
    try:
        with conn.cursor() as cur:
            if error is None:
                cur.execute("""
                    insert into live_collector_status as s (gmkey, last_ok_at, events, last_event_at)
                    values (%s, now(), %s, case when %s > 0 then now() end)
                    on conflict (gmkey) do update set
                      last_ok_at = now(),
                      last_event_at = case when excluded.events > s.events then now()
                                           else s.last_event_at end,
                      events = greatest(excluded.events, s.events),
                      last_error = null""", (gmkey, events, events))
            else:
                cur.execute("""
                    insert into live_collector_status as s (gmkey, last_error, last_error_at)
                    values (%s, %s, now())
                    on conflict (gmkey) do update set last_error = excluded.last_error,
                                                     last_error_at = now()""", (gmkey, error[:300]))
        conn.commit()
    except Exception as e:  # noqa: BLE001
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        log(f"  (경고) 감시 심박 기록 실패({gmkey}): {type(e).__name__}: {e}")


def poll_cycle(conn, ingestors, pending, snapshot_fn, schedule=None, reconcile=True):
    """폴링 1주기 - pending에 남은 경기마다 (스냅샷 -> ingest -> 종료면 정산).
    **정산이 성공한 경기만** pending에서 빠진다.

    **이 함수는 절대 예외를 밖으로 던지지 않는다.** 무인 운용에서 폴링 하나가 터졌다고
    수집기가 죽으면(그날 남은 경기를 통째로 놓치면) 그게 제일 큰 사고다. 실패한 경기는
    트랜잭션을 롤백하고 스택트레이스를 남긴 뒤 다음 주기에 다시 시도한다 - 매 주기가
    '지금까지의 전체 스냅샷'을 다시 계산하므로 놓친 주기는 자동으로 따라잡힌다.

    !!! 2026-09-02 수정 - 정산 실패를 감지하고 재시도한다 !!!
    예전에는 reconcile_finished_game()을 부르기 **전에** reconciled=True를 세우고, 종료코드도
    보지 않고, 곧바로 pending.discard(gk)를 했다. 그래서 정산이 한 번 실패하면:
      - 이 프로세스는 다시 시도하지 않고(reconciled=True),
      - 경기는 pending에서 빠져 run()의 while 루프가 끝나 프로세스가 종료되고,
      - 다음 --once 실행은 select_target_games가 is_ended=true를 제외하므로 이 경기를 못 보고,
      - daily_batch도 --replace 없이 이관해서 잠정 행을 못 덮어썼다(지금은 고침).
    결과적으로 **단 한 번의 일시적 실패로 라이브 잠정치가 영구 '공식' 데이터가 됐다.**
    지금은 ok=True일 때만 완료 처리하고, 실패하면 pending에 남겨 다음 주기에 재시도한다
    (RECONCILE_MAX_ATTEMPTS회까지 - 그 뒤엔 크게 로그를 남기고 포기해서 루프가 영원히
    돌지 않게 한다).

    replay_dry_run.py도 이 함수를 그대로 쓴다 - 드라이런이 실제 라이브 코드 경로(에러
    처리 포함)를 증명해야 의미가 있기 때문."""
    summaries = []
    for gk in sorted(pending):
        try:
            snap = snapshot_fn(gk)
            with conn.cursor() as cur:
                summary = ingestors[gk].ingest(cur, snap, (schedule or {}).get(gk))
            conn.commit()
            # 커밋이 확정된 뒤에야 '직전 주기 이벤트 수'를 올린다(ingest 주석 참고).
            if summary.get("events"):
                ingestors[gk]._last_event_count = summary["events"]
            write_status(conn, gk, events=summary.get("events") or 0)
        except Exception as e:  # noqa: BLE001
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            write_status(conn, gk, error=f"{type(e).__name__}: {e}")
            log(f"  {gk}: 폴링 실패({type(e).__name__}: {e}) - 이번 주기는 건너뛰고 계속")
            log("    " + traceback.format_exc().strip().replace("\n", "\n    "))
            summaries.append({"gmkey": gk, "error": f"{type(e).__name__}: {e}",
                              "started": False, "ended": False})
            continue

        summaries.append(summary)
        if not summary["started"]:
            log(f"  {gk}: 아직 시작 전(문자중계 이벤트 0건)")
            continue
        log(f"  {gk}: {summary['home_score']}-{summary['away_score']} "
            f"(이벤트 {summary['events']}건, 신규 {summary.get('new', 0)}/"
            f"수정 {summary.get('updated', 0)}, 홈승률 {summary['win_prob']})"
            + (f" [종료 감지: {summary['ended_why']}]" if summary["ended"] else ""))

        if not summary["ended"]:
            continue

        ing = ingestors[gk]
        if not reconcile:
            pending.discard(gk)
            continue
        if ing.reconciled:
            pending.discard(gk)
            continue
        if ing.reconcile_attempts >= RECONCILE_MAX_ATTEMPTS:
            log(f"  {gk}: !!! 정산 {ing.reconcile_attempts}회 연속 실패 - 재시도를 포기한다.\n"
                f"      마지막 오류: {ing.reconcile_error}\n"
                f"      DB의 이 경기 game_events는 아직 라이브 '잠정치'다(규정시간 기준 "
                f"remainingSec 추정 / 문자중계 복원 라인업). 반드시 수동 복구할 것:\n"
                f"      python daily_batch.py --only-supabase-sync --gmkeys {gk}  (권장 - "
                f"인터프리터 고정 + 종료코드 확인)\n"
                f"      python daily_batch.py --date <YYYYMMDD>   (그날 경기 전체 재처리)\n"
                f"      (원본 재수집이 필요하면) python -c \"import fetch_kbl_data as f; "
                f"f.fetch_one_game('{gk}', force=True)\" 를 먼저")
            summary["reconcile"] = {"ok": False, "gave_up": True, "why": ing.reconcile_error}
            pending.discard(gk)
            continue

        ing.reconcile_attempts += 1
        res = reconcile_finished_game(gk)
        summary["reconcile"] = res
        if res.get("ok"):
            ing.reconciled = True
            ing.reconcile_error = None
            clear_end_state(gk)   # 정산까지 끝난 경기의 확정 카운터는 남겨둘 이유가 없다
            pending.discard(gk)
        else:
            ing.reconcile_error = res.get("why") or "원인 미상"
            log(f"  {gk}: 정산 실패({ing.reconcile_attempts}/{RECONCILE_MAX_ATTEMPTS}) - "
                f"{ing.reconcile_error}. 다음 주기에 재시도한다(pending 유지).")
    return summaries


def run(args):
    load_env_supabase()
    # 모델은 폴링할 경기가 생겼을 때 읽는다 - 작업 스케줄러가 10분마다 띄우는데, 경기 없는
    # 날까지 매번 sklearn을 올리면 한 번에 20초 넘게 걸린다.
    model = None

    replay = None
    if args.dry_run_source:
        replay = ReplaySource(args.dry_run_source, speed=args.speed,
                              raw_log=not args.no_raw_log,
                              start_elapsed=args.start_elapsed,
                              meta_isended=not args.no_meta_isended)
        log(f"드라이런 소스: {args.dry_run_source} (speed x{args.speed}) - API 호출 안 함")

    conn = get_conn()
    conn.autocommit = False
    ingestors, pending = {}, set()
    progress = {}   # gmkey -> (마지막으로 진전이 있었던 시각, 그때의 이벤트 수)
    tipoffs = {}    # gmkey -> 예정 시각(epoch). 0이면 바로 폴링
    pinned = bool(args.gmkey or args.date or replay)

    def add_targets(cur, date_str):
        """대상 경기를 조회해서 아직 안 보던 경기를 ingestors/pending에 추가. 매 주기마다
        불려서 (a) 날짜가 넘어가면 새 날짜 경기를, (b) 당일 뒤늦게 편성/재개된 경기를 줍는다."""
        nonlocal model
        games = select_target_games(cur, date_str, args.gmkey)
        fresh = [g for g in games if g["gmkey"] not in ingestors]
        if not fresh:
            return games, []
        if model is None:
            log("승률 모델 로딩...")
            import joblib
            model = joblib.load(mge.MODEL_PATH)
        pregame = load_pregame_context(cur, [g["gmkey"] for g in fresh])
        valid_pcodes = load_valid_pcodes(cur)
        now = time.time()
        for g in fresh:
            gk = g["gmkey"]
            c = pregame[gk]
            if c["neutral"]:
                log(f"  {gk}: 경기 전 컨텍스트 없음 -> 중립(0/0)으로 추론. "
                    f"home_win_prob == objective_prob이 됨({c['reason']})")
            elif c["reason"]:
                log(f"  {gk}: 경기 전 컨텍스트 일부 결측 -> 그 항목만 0 ({c['reason']})")
            ingestors[gk] = GameIngestor(gk, g["home_tcode"], g["away_tcode"], c,
                                         model, valid_pcodes)
            pending.add(gk)
            # --gmkey/드라이런은 운용자가 '지금' 보겠다는 뜻이라 예정 시각을 보지 않는다.
            tipoffs[gk] = 0.0 if (args.gmkey or replay) else tipoff_epoch(g["game_date"],
                                                                          g["game_start"])
            # 스톨 시계 시작점: 시작 전 경기는 예정 시각부터(경기 전 대기를 세지 않음), 이미
            # 스코어가 있는 경기(수집기 재시작으로 다시 잡은 진행중 경기)는 지금부터.
            started = g["home_score"] is not None
            progress[gk] = (now if started or not tipoffs[gk] else tipoffs[gk], 0)
        return games, fresh

    try:
        with conn.cursor() as cur:
            date_str = args.date or kst_today()
            games, fresh = add_targets(cur, date_str)
            if not games:
                if args.gmkey:
                    log(f"--gmkey {args.gmkey}: games 테이블에 그런 경기가 없음 - 종료.")
                else:
                    log(f"{date_str}(KST)에 폴링할 경기 없음(예정/진행중 경기 0건) - 종료.")
                return 0
            if args.gmkey:
                # --gmkey는 날짜 조건을 무시하므로 스케줄 조회도 그 경기의 실제 날짜로.
                date_str = games[0]["game_date"]
                if games[0]["is_ended"] and not args.force_ended:
                    # 2026-09-02 - 예전엔 경고만 찍고 그대로 진행했다. 이미 정산이 끝난 경기를
                    # 다시 라이브로 적재하면 공식 game_events(확정 라인업/pcode/WPA)를 라이브
                    # 잠정치로 덮어쓴다. 운용자용 강제 플래그일수록 사고 시 되돌릴 수 없는
                    # 쪽으로 기울면 안 되므로, 명시적 --force-ended 없이는 거부한다.
                    log(f"거부: {args.gmkey}는 이미 종료(is_ended=true)로 정산이 끝난 경기다.\n"
                        f"  라이브로 다시 적재하면 공식 game_events를 잠정치로 덮어쓴다.\n"
                        f"  정말 필요하면 --force-ended를 함께 지정할 것"
                        f"(정산 배치가 뒤이어 다시 공식 데이터로 되돌린다).")
                    return 2
                if games[0]["is_ended"]:
                    log(f"  (주의) {args.gmkey}는 이미 종료된 경기인데 --force-ended로 강제 진행 - "
                        f"공식 game_events가 일시적으로 라이브 잠정치로 덮인다.")
        conn.commit()

        log(f"대상 {len(games)}경기: {', '.join(sorted(pending))}")
        snapshot_fn = replay if replay else (
            lambda gk: fetch_snapshot(gk, raw_log=not args.no_raw_log))
        keep_awake()
        # 수명 상한은 첫 경기를 폴링하기 시작한 때부터 잰다 - 13시에 떠서 22시 경기(12/31
        # 농구영신)를 기다리면 뜬 시각 기준 12시간은 경기 도중 자정에 끝나버린다.
        began = None
        waiting_for = None
        while pending:
            now = time.time()
            due = due_games(pending, tipoffs, now)
            summaries = []
            if due:
                began = began or now
                schedule = {} if replay else fetch_schedule_entries(date_str)
                polled = set(due)
                summaries = poll_cycle(conn, ingestors, polled, snapshot_fn, schedule)
                pending -= due - polled   # poll_cycle은 넘겨받은 집합에서만 뺀다
            elif waiting_for != min(tipoffs[gk] for gk in pending):
                waiting_for = min(tipoffs[gk] for gk in pending)
                log(f"다음 경기 {datetime.datetime.fromtimestamp(waiting_for, KST):%H:%M} - "
                    f"{PREGAME_LEAD_SEC // 60}분 전부터 폴링(그때까지 대기)")
            if args.once:
                log(f"--once - 1주기만 실행하고 종료(남은 경기 {len(pending)}건)")
                return 0
            if not pending:
                break

            # --- 무인 운용 안전장치(2026-09-02) --------------------------------
            # (1) 진전 없는 경기 정리. 연기/취소된 경기는 문자중계가 영원히 비어 있어서
            #     detect_ended가 절대 True가 되지 않는다. 예전 구현은 그런 경기 하나 때문에
            #     `while pending`이 무한히 돌면서 다음 날 경기는 쳐다보지도 않았다.
            for gk in sorted(drop_stalled(pending, progress, summaries, now, args.stall_timeout)):
                log(f"  {gk}: {args.stall_timeout / 60:.0f}분 동안 새 이벤트 없음"
                    f"(이벤트 {progress[gk][1]}건) - 연기/취소/중계중단으로 보고 폴링 중단."
                    f" is_ended는 건드리지 않는다(다음날 daily_batch가 정본을 넣는다).")
                pending.discard(gk)
            if not pending:
                break

            # (2) 날짜 롤오버. --date/--gmkey/드라이런으로 고정된 실행은 그대로 두고,
            #     기본 실행만 KST 날짜를 매 주기 다시 본다. 이미 시작한 경기는 자정을 넘겨도
            #     끝까지 따라간다(12/31 22:00 농구영신) - 내리는 건 시작도 안 한 경기뿐.
            if not pinned:
                today = kst_today()
                if today != date_str:
                    unstarted = {gk for gk in pending if progress[gk][1] == 0}
                    log(f"KST 날짜가 {date_str} -> {today}로 바뀜. 시작 안 한 이전 날짜 경기"
                        f"{sorted(unstarted)}는 내리고, 진행 중인 경기"
                        f"{sorted(pending - unstarted)}는 끝까지 따라간다.")
                    pending -= unstarted
                    date_str = today
                # 조회 실패(네트워크·풀러 끊김)로 프로세스가 죽으면 그날 남은 경기를 통째로
                # 놓친다 - 이번 주기만 건너뛰고 아래에서 재접속한다.
                try:
                    with conn.cursor() as cur:
                        _, fresh = add_targets(cur, date_str)
                    conn.commit()
                except Exception as e:  # noqa: BLE001
                    log(f"  대상 경기 재조회 실패({type(e).__name__}: {e}) - 다음 주기에 다시")
                    fresh = []
                if fresh:
                    log(f"신규 대상 {len(fresh)}경기 추가: "
                        f"{', '.join(g['gmkey'] for g in fresh)}")

            # (3) 수명 상한.
            if began and now - began >= args.max_runtime:
                log(f"최대 실행시간 {args.max_runtime / 3600:.1f}시간 초과 - 수집기를 종료한다"
                    f"(남은 경기 {sorted(pending)}). 필요하면 다시 실행할 것.")
                return 0
            if not pending:
                break
            time.sleep(args.interval)

            # (4) DB 재접속. 정산 서브프로세스가 길게 돌거나(최대 30분) 와이파이가 끊기면 Supabase
            #     풀러가 연결을 닫는다. 예전엔 그 뒤 모든 주기가 실패하다 add_targets에서 죽었다.
            if conn.closed:
                log("DB 연결이 닫혀 있음 - 다시 연결")
                try:
                    conn = get_conn()
                    conn.autocommit = False
                except Exception as e:  # noqa: BLE001
                    log(f"  재연결 실패({type(e).__name__}: {e}) - 다음 주기에 다시")

        log("오늘 대상 경기 전부 종료 - 수집기 종료.")
        return 0
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser(description="KBL 라이브 수집기(문자중계 -> game_events + games 갱신)")
    ap.add_argument("--gmkey", help="특정 경기만 강제로 폴링(날짜 조건 무시)")
    ap.add_argument("--date", help="YYYY-MM-DD - 대상 날짜(기본: 오늘 KST)")
    ap.add_argument("--once", action="store_true",
                    help="1주기만 돌고 종료 - 작업 스케줄러의 '1분마다 실행' 트리거용")
    ap.add_argument("--interval", type=int, default=60, help="폴링 간격(초, 기본 60)")
    ap.add_argument("--force-ended", action="store_true",
                    help="--gmkey로 지정한 경기가 이미 is_ended=true여도 강제로 라이브 적재 "
                         "(기본은 거부 - 공식 game_events를 잠정치로 덮어쓰기 때문)")
    ap.add_argument("--max-runtime", type=float, default=MAX_RUNTIME_SEC,
                    help=f"수집기 전체 수명 상한(초, 기본 {MAX_RUNTIME_SEC} = "
                         f"{MAX_RUNTIME_SEC // 3600}시간). 무인 실행이 영원히 도는 것 방지")
    ap.add_argument("--stall-timeout", type=float, default=STALL_TIMEOUT_SEC,
                    help=f"한 경기가 이 시간(초, 기본 {STALL_TIMEOUT_SEC} = "
                         f"{STALL_TIMEOUT_SEC // 3600}시간) 동안 새 이벤트를 안 내면 "
                         f"연기/취소로 보고 폴링 중단")
    ap.add_argument("--dry-run-source", help="API 대신 끝난 경기(gmkey)의 저장된 문자중계를 재생")
    ap.add_argument("--speed", type=float, default=60.0, help="--dry-run-source 재생 배속(기본 60)")
    ap.add_argument("--start-elapsed", type=float, default=0.0,
                    help="--dry-run-source 재생을 경기 시계 N초 지점부터 이어서 시작")
    ap.add_argument("--no-meta-isended", action="store_true",
                    help="--dry-run-source에서 meta.isEnded를 아예 주지 않음 - 종료 판정이 "
                         "휴리스틱만으로 되는지 확인하는 최악 시나리오 재현")
    ap.add_argument("--no-raw-log", action="store_true",
                    help="raw/live_logs 원본 응답 저장 끄기(기본은 켬 - 미검증 API 대비 보험)")
    args = ap.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
