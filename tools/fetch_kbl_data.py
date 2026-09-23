"""
KBL 공식 사이트(kbl.or.kr) 비공식 API에서 실제 경기 데이터를 긁어온다.
- 문자중계(이벤트 로그) / 선수별 박스스코어(1,2차 스탯) / 팀 기록 / 슛차트 / 경기 메타
- 인증 불필요, 정적 헤더 3개(Channel/TeamCode/lang)만 있으면 됨.
- 목적: 라인업 시너지·매치업 분석을 위한 AI 학습용 원본 데이터 축적 (실시간 승률 예측 시스템의 기초 자료).

사용법:
  python fetch_kbl_data.py --seasons 43,45,47 --categories R,PO --limit 10   # 테스트: 10경기만
  python fetch_kbl_data.py --seasons 39,41,43,45,47 --categories R,PO       # 최근 5시즌 정식 수집
"""
import argparse
import json
import os
import time
import urllib.request
import urllib.error

API_BASE = "https://api.kbl.or.kr"
RAW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "raw")
GAMES_DIR = os.path.join(RAW_DIR, "games")
SCHEDULE_DIR = os.path.join(RAW_DIR, "schedule")

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Channel": "WEB",
    "TeamCode": "XX",
    "lang": "ko",
    "Referer": "https://www.kbl.or.kr/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

ENDPOINTS = {
    "meta": "/match/{gmkey}",
    "player-stat": "/match/{gmkey}/player-stat",
    "team-record": "/match/{gmkey}/team-record",
    "match-chart": "/match/{gmkey}/match-chart",
    # quarterList 없이 부르면 서버가 마지막 쿼터만 돌려줌(문자중계 탭의 기본 동작) - 이거
    # 놓치면 경기 앞부분 이벤트가 통째로 빠져서 스틴트 복원이 불가능해짐. 프론트 JS 번들에서
    # 확인한 실제 파라미터로 4쿼터+연장 4개를 한 번에 명시 요청 (연장 없는 경기는 무시됨, 안전).
    "text-cast": "/match/{gmkey}/text-cast?quarterList=Q1,Q2,Q3,Q4,X1,X2,X3,X4",
}

# 추적 대상 경기 분류. 예전엔 이 목록이 daily_batch/live_collector/sync_upcoming_games/
# predict_upcoming_games/generate_daily_report 5곳에 따로 박혀 있어서, 카테고리가 하나
# 늘 때마다 일부만 갱신되는 사고가 반복됐다 - CP(챔피언결정전)는 3곳에서, OM(오픈매치=
# 프리시즌)은 2곳에서 빠져 있었다(2026-09-24 발견). 여기 한 곳만 고치면 되도록 모은다.
#   TRACKED    : 수집/폴링 대상 전부
#   PREDICTABLE: 승률 예측 대상 - 올스타(AS)는 팀이 섞여 예측이 무의미해서 뺀다
# D리그는 seasonName 자체가 달라 별도 취급이라 여기 없다.
TRACKED_CATEGORIES = {"R", "PO", "CP", "CU", "AS", "OM"}
PREDICTABLE_CATEGORIES = TRACKED_CATEGORIES - {"AS"}

DELAY_SEC = 0.35
# 절전/최대절전에서 깨어난 직후엔 네트워크 스택이 올라오는 데 30~60초가 걸린다 - 예전
# 백오프(1.5/3/4.5초 = 총 9초)로는 4번을 다 태우고도 DNS가 아직 안 붙어 getaddrinfo로
# 죽었고, daily_batch가 06:00에 통째로 날아간 적이 3번 있다(2026-08-31, 09-02, 09-05).
# 총 대기를 60초로 늘려 기상 직후 1회 실행도 살아남게 한다. API가 진짜 죽어 있으면
# 그만큼 늦게 실패할 뿐이라 손해가 없다.
MAX_RETRIES = 6


def api_get(path):
    # 첫 5시즌 수집 중 원인불명 exit code 4로 한 번 죽은 적 있음(트레이스백도 안 남아서
    # 외부에서 강제종료됐을 가능성이 높음) - 순단성 네트워크 문제에도 버티도록 재시도 추가.
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(API_BASE + path, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(min(30, 2 * 2 ** attempt))   # 2,4,8,16,30 = 총 60초
    raise last_err


def fetch_game_list(from_date, to_date):
    return api_get(f"/match/list?fromDate={from_date}&toDate={to_date}&tcodeList=all")


def load_target_games(seasons, categories, from_date, to_date, use_cache=True, is_ended=1):
    os.makedirs(SCHEDULE_DIR, exist_ok=True)
    cache_path = os.path.join(SCHEDULE_DIR, f"list_{from_date}_{to_date}.json")
    # 매일 돌리는 배치(daily_batch.py)는 "오늘" 범위를 반복 조회하는데, 하루 안에서도
    # 경기가 끝나기 전/후로 isEnded 값이 바뀌므로 캐시를 쓰면 안 됨. 대량 백필(main())은
    # 과거 확정된 경기라 캐시가 안전하고 재실행 시 API 호출을 아낄 수 있어서 그대로 둠.
    if use_cache and os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            games = json.load(f)
    else:
        games = fetch_game_list(from_date, to_date)
        if use_cache:
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(games, f, ensure_ascii=False, indent=2)
        time.sleep(DELAY_SEC)

    # is_ended: 1(기본) = 지금까지의 동작 그대로 "끝난 경기만"(백필/daily_batch가 의존).
    #           None    = isEnded로 거르지 않음 - 라이브 수집기(live_collector.py)가 "오늘
    #                     열리는 경기"(아직 시작 전 0, 진행중 0, 방금 끝난 1)를 전부 봐야 해서
    #                     추가. 별도 HTTP 계층을 복제하는 대신 여기 파라미터 하나로.
    #           0       = 아직 안 끝난 경기만(sync_upcoming_games의 스코프와 같은 의미).
    # 실제 라이브 경기에서 isEnded가 정수 1/0이 아니라 "1"/true로 올 가능성이 비시즌이라
    # 검증이 안 됨 - 문자열/불린도 같이 받아들이도록 normalize.
    def ended_flag(g):
        v = g.get("isEnded")
        if isinstance(v, bool):
            return 1 if v else 0
        if isinstance(v, str):
            v = v.strip()
            return 1 if v in ("1", "true", "True", "Y") else (0 if v in ("0", "false", "False", "N", "") else None)
        return v

    target = [
        g for g in games
        if (not seasons or g.get("seasonCode") in seasons)
        and g.get("seasonCategory") in categories
        and (is_ended is None or ended_flag(g) == is_ended)
    ]
    return target


def fetch_endpoint(gmkey, name):
    """엔드포인트 하나만 받아서 파싱된 JSON을 반환(파일로 저장하지 않음).

    fetch_one_game()은 raw/games/<gmkey>/ 아래에 캐시 파일을 남기는데, 라이브 폴링이 그
    캐시를 만들어버리면 경기 종료 후 배치(fetch_one_game은 force가 아니면 기존 파일을
    건너뜀)가 "경기 도중에 찍힌 반쪽짜리 문자중계"를 공식 데이터로 착각한다. 그래서
    라이브 경로는 이 함수로 메모리에서만 읽고, 원본 응답은 raw/live_logs/에 따로 남긴다
    (live_collector.py 참고). 종료 후 재수집은 fetch_one_game(gmkey, force=True)."""
    return api_get(ENDPOINTS[name].format(gmkey=gmkey))


def fetch_one_game(gmkey, force=False):
    game_dir = os.path.join(GAMES_DIR, gmkey)
    os.makedirs(game_dir, exist_ok=True)
    fetched = {}
    for name, path_tpl in ENDPOINTS.items():
        out_path = os.path.join(game_dir, f"{name}.json")
        if os.path.exists(out_path) and not force:
            fetched[name] = "cached"
            continue
        try:
            data = api_get(path_tpl.format(gmkey=gmkey))
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            fetched[name] = "ok"
        except urllib.error.HTTPError as e:
            fetched[name] = f"HTTPError {e.code}"
        except Exception as e:  # noqa: BLE001
            fetched[name] = f"error: {e}"
        time.sleep(DELAY_SEC)
    return fetched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default=None, help="쉼표구분 seasonCode 목록, 예: 43,45,47 (생략 시 날짜범위만으로 필터)")
    ap.add_argument("--categories", default="R,PO,CP", help="쉼표구분 seasonCategory 목록 (기본 R,PO,CP)")
    ap.add_argument("--from-date", default="20200901")
    ap.add_argument("--to-date", default=time.strftime("%Y%m%d"))
    ap.add_argument("--limit", type=int, default=None, help="테스트용: 앞에서 N경기만 처리")
    ap.add_argument("--force", action="store_true", help="이미 받은 파일도 다시 받기")
    args = ap.parse_args()

    seasons = {int(s) for s in args.seasons.split(",")} if args.seasons else None
    categories = set(args.categories.split(","))

    games = load_target_games(seasons, categories, args.from_date, args.to_date)
    games.sort(key=lambda g: (g["gameDate"], g["gmkey"]))
    if args.limit:
        games = games[: args.limit]

    print(f"대상 경기 수: {len(games)} (seasons={sorted(seasons) if seasons else 'ALL'}, categories={sorted(categories)})", flush=True)

    os.makedirs(GAMES_DIR, exist_ok=True)
    fail_log = []
    for i, g in enumerate(games, 1):
        gmkey = g["gmkey"]
        try:
            result = fetch_one_game(gmkey, force=args.force)
        except Exception as e:  # noqa: BLE001
            # api_get이 재시도까지 다 소진해도 실패하면 여기로 옴 - 이 경기는 실패 로그에 남기고
            # 다음 경기로 계속 진행 (전체 수집이 경기 하나 때문에 죽지 않게).
            result = {"unexpected": f"error: {e}"}
        bad = {k: v for k, v in result.items() if v not in ("ok", "cached")}
        if bad:
            fail_log.append({"gmkey": gmkey, "issues": bad})
        if i % 25 == 0 or i == len(games):
            print(f"  [{i}/{len(games)}] {g['gameDate']} {g['tnameH']} vs {g['tnameA']} ({gmkey}) -> {result}", flush=True)

    if fail_log:
        fail_path = os.path.join(RAW_DIR, "fetch_failures.json")
        with open(fail_path, "w", encoding="utf-8") as f:
            json.dump(fail_log, f, ensure_ascii=False, indent=2)
        print(f"실패/문제 {len(fail_log)}건 -> {fail_path}")
    else:
        print("전부 정상 수집.")


if __name__ == "__main__":
    main()
