"""이우석(291375, 현대모비스) 2026-27 시즌 로스터 복귀 - 일회성 수동 패치.

배경: 2025-2026 시즌 군 복무로 공백(courtside_ovr_history.json에 그 시즌 행 없음).
2026 아시안게임 금메달로 조기 전역, 개막부터 현대모비스 소속으로 뛸 수 있게 됨(2026-09-24
사용자 확인). season_roster(2026-2027)에 아직 없어서 build_courtside_ovr.py의 "완전
신인 예상치" 경로가 그를 못 찾음 - 과거 4시즌 기록이 있는데도 예상 OVR 자체가 안 생김.

import_roster.py는 --replace 시 season_name 전체를 지우고 CSV로 재적재하는 전량 갱신
스크립트라(현재 208행 로스터 중 이 한 명만 담은 CSV를 그걸로 돌리면 나머지 207명이
삭제된다), 여기선 그 한 행만 upsert한다. 나중에 정식 로스터 CSV를 다시 받아 rerun해도
on conflict(season_name, tcode, player_name)로 자연스럽게 같은 행에 합쳐진다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_roster import load_database_url
import psycopg2

PCODE = "291375"
NAME = "이우석"
TCODE = "10"  # 울산 현대모비스
SEASON = "2026-2027"


def patch():
    conn = psycopg2.connect(load_database_url())
    cur = conn.cursor()
    cur.execute("""
        insert into season_roster (season_name, tcode, pcode, player_name, source)
        values (%s, %s, %s, %s, %s)
        on conflict (season_name, tcode, player_name) do update set
            pcode = excluded.pcode, source = excluded.source, updated_at = now()
    """, (SEASON, TCODE, PCODE, NAME, "manual: 2026 AG 금메달 조기전역 복귀(2026-09-24)"))
    conn.commit()

    cur.execute("select season_name, tcode, pcode, player_name from season_roster where pcode=%s", (PCODE,))
    print(f"[SUCCESS] {NAME} season_roster 반영: {cur.fetchall()}")
    conn.close()


if __name__ == "__main__":
    patch()
