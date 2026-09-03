"""KBL 공식 선수 명부(api.kbl.or.kr/players)에서 현역 국내 선수 로스터를 CSV로 뽑는다.

--- 이 엔드포인트가 실제로 무엇인가(2026-09-03 실측) ---
`GET https://api.kbl.or.kr/players` 는 1,458명짜리 전체 등록 명부다. 쿼리 파라미터는 전부
무시된다(seasonCode/tcode/playerFlag 어느 것을 붙여도 바이트 단위로 같은 응답). 행마다 그
선수의 "마지막 소속"(tname/tcode)과 두 개의 상태 필드가 있다:

  playerFlag          0 = 국내, 1 = 외국인, 2 = 아시아쿼터
                      (16명의 flag 2가 전원 아시아쿼터 선수, 공백 있는 이름 492명 중 473명이
                      flag 1 - 이름 공백 휴리스틱보다 이게 정답이다. 에디 다니엘/네이트 힉맨/
                      밥 쏜톤처럼 영문 이름의 국내 선수가 flag 0으로 정확히 잡힌다.)
  playerLastCareerIf  'A' = 현역(200명, 팀당 17~25명), 숫자 = 은퇴 시즌 코드,
                      'C'(10명)/'D'(7명) = 국내 선수 별도 등록 상태(군복무·육성 추정 - 확인 안 됨),
                      '' = 대학/기타.

국내 선수(flag 0)의 현역 판정은 신뢰할 수 있다 - 허훈→부산 KCC, 김선형→수원 KT, 이대성→
서울 삼성, 오세근→서울 SK, 김종규→안양 정관장 같은 최근 이적이 전부 새 팀 'A'로 나온다.
반면 외국인 행은 낡았다(원주 DB에 크리스 캐어드, 고양 소노에 타일러 가틀린이 'A'로 남아
있음 - 둘 다 2026-27 확정 명단에 없음). 그래서 이 스크립트는 **국내(flag 0)만** 뽑고,
외국인/아시아쿼터는 사용자가 확정해 준 tools/rosters/foreign_confirmed_*.csv를 그대로 쓴다.

출력 CSV 열: team(tcode), pcode, name, back_num, pos, note
  - pcode를 그대로 싣는다. import_roster.py가 pcode 열이 있으면 이름 매칭을 건너뛰므로
    동명이인(이정현 - 고양 소노 #6 / 원주 DB #3, 둘 다 현역)이 모호함 없이 연결된다.
  - 'C'/'D' 상태도 로스터에 포함하되 note에 남긴다. 빼면 build_roster_changes.py가 이들을
    "리그 이탈"로 잘못 발표한다(지난 시즌 출전 기록이 있으므로).

사용:
    python fetch_kbl_roster.py                      # tools/rosters/domestic_kbl_<오늘>.csv 생성
    python fetch_kbl_roster.py --out path.csv
    python fetch_kbl_roster.py --show-foreign       # 명부의 외국인 'A' 행을 확정 명단과 비교용으로 출력
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.kbl.or.kr/players"
HEADERS = {  # fetch_kbl_data.py와 동일 - 이 헤더가 없으면 500
    "Accept": "application/json, text/plain, */*",
    "Channel": "WEB",
    "TeamCode": "XX",
    "lang": "ko",
    "Referer": "https://www.kbl.or.kr/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

ACTIVE_STATUS = {"A": "KBL 등록 현역", "C": "KBL 등록상태 C(군복무·육성 추정, 미확인)", "D": "KBL 등록상태 D(군복무·육성 추정, 미확인)"}
# 선수 포지션 코드만 허용 - 'AA'/'AB'/'AC'/'AD'는 감독·코치·스태프 등록(예: 강동희 AA)이라 제외
PLAYER_POS = {"FD": "F", "GD": "G", "C": "C", "FC": "F/C", "GF": "G/F"}


def fetch_registry():
    req = urllib.request.Request(API, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser(description="KBL 명부에서 현역 국내 선수 로스터 CSV 생성")
    ap.add_argument("--out", help="출력 CSV 경로(기본: tools/rosters/domestic_kbl_<오늘>.csv)")
    ap.add_argument("--show-foreign", action="store_true", help="명부의 외국인/아시아쿼터 'A' 행을 출력하고 종료")
    ap.add_argument("--cache", help="이미 받아둔 /players JSON 파일(네트워크 대신)")
    args = ap.parse_args()

    if args.cache:
        rows = json.load(io.open(args.cache, encoding="utf-8"))
    else:
        rows = fetch_registry()
    print("명부 %d행 수신" % len(rows))

    status = lambda r: (r.get("playerLastCareerIf") or "").strip()  # noqa: E731

    if args.show_foreign:
        print("외국인/아시아쿼터 중 명부상 현역(A) - 확정 명단과 비교용:")
        for r in sorted(rows, key=lambda r: (r["tname"], r["pname"])):
            if r["playerFlag"] in ("1", "2") and status(r) == "A":
                print("  %-12s %-10s #%-3s flag=%s" % (r["tname"], r["pname"], r.get("backNum") or "", r["playerFlag"]))
        return

    picked, skipped_pos = [], []
    for r in rows:
        if r.get("playerFlag") != "0" or status(r) not in ACTIVE_STATUS:
            continue
        pos = (r.get("pos") or "").strip()
        if pos not in PLAYER_POS:
            skipped_pos.append((r["pname"], r["tname"], pos))
            continue
        picked.append({
            "team": r["tcode"],
            "pcode": r["pcode"],
            "name": (r["pname"] or "").strip(),
            "back_num": (r.get("backNum") or "").strip(),
            "pos": PLAYER_POS[pos],
            "note": "%s | KBL 명부 %s | flag0 국내 | 원문 pos %s" % (ACTIVE_STATUS[status(r)], dt.date.today().isoformat(), pos),
        })

    out = args.out or os.path.join(HERE, "rosters", "domestic_kbl_%s.csv" % dt.date.today().isoformat())
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with io.open(out, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["team", "pcode", "name", "back_num", "pos", "note"])
        w.writeheader()
        for p in sorted(picked, key=lambda p: (p["team"], p["name"])):
            w.writerow(p)

    by_team = {}
    for p in picked:
        by_team.setdefault(p["team"], []).append(p)
    print("현역 국내 선수 %d명 -> %s" % (len(picked), out))
    for tcode in sorted(by_team):
        cd = sum(1 for p in by_team[tcode] if "등록상태" in p["note"])
        print("  tcode %s: %2d명%s" % (tcode, len(by_team[tcode]), " (C/D 상태 %d명 포함)" % cd if cd else ""))
    if skipped_pos:
        print("포지션 코드가 선수가 아니라 제외: %d행" % len(skipped_pos))
        for n, t, p in skipped_pos[:10]:
            print("   - %s (%s) pos=%s" % (n, t, p))


if __name__ == "__main__":
    main()
