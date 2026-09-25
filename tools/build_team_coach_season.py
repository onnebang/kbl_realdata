# -*- coding: utf-8 -*-
"""team_coach_season(시즌·팀·감독 매핑)을 games.home/away_coach_id에 다시 적용한다.

    python tools/build_team_coach_season.py            # 2026-2027
    python tools/build_team_coach_season.py 2027-2028

왜 필요한가 (2026-09-06): 예정 경기(26-27, 270경기)에는 감독 id가 없었다(25-26은 100% 채워짐).
sync_upcoming_games.py가 경기를 다시 적재하면 감독 id가 또 비므로, 매핑은 team_coach_season
테이블에 두고 이 스크립트로 언제든 재적용한다. games를 소스로 삼지 않는다.

감독 출처(team_coach_season.source): KBL 등록 API(api.kbl.or.kr/players)에서 pos='AA'(감독)이면서
playerLastCareerIf='A'(현역)인 행은 26-27 기준 5팀뿐이었다(KT 문경은·삼성 김상식·LG 조상현·KCC 이상민·
정관장 유도훈. 삼성은 25-26 김효범에서 교체). 나머지는 사용자 제공 기사(현대모비스 양동근·가스공사 강혁·
SK 전희철)와 사용자 확인(2026-09, 소노 손창환 유임 / DB는 김주성→이규섭 교체). 등록 API의 AA 행 29명은
"감독으로 등록된 적 있는 사람 전체"라 그대로 쓰면 팀당 여러 명이 나온다.
테이블은 RLS on + 정책 0 = 서버 전용.
"""
import sys
sys.path.insert(0, r"D:\영상작업\축구\개발\kbl_realdata\tools")
import psycopg2
from import_roster import load_database_url
from cache_invalidate import revalidate

season = sys.argv[1] if len(sys.argv) > 1 else "2026-2027"
c = psycopg2.connect(load_database_url()); c.autocommit = False; cur = c.cursor()
cur.execute("update games g set home_coach_id=t.coach_id from team_coach_season t where g.season_name=%s and t.season_name=%s and t.tcode=g.home_tcode", (season, season)); h = cur.rowcount
cur.execute("update games g set away_coach_id=t.coach_id from team_coach_season t where g.season_name=%s and t.season_name=%s and t.tcode=g.away_tcode", (season, season)); a = cur.rowcount
c.commit()
revalidate(["manual:build", f"season:{season}"])
cur.execute("select count(*), count(home_coach_id), count(away_coach_id) from games where season_name=%s", (season,))
print("%s: home %d / away %d 갱신 → games 채움 %s" % (season, h, a, cur.fetchone()))
cur.execute("select tm.name, co.name, t.confirmed from team_coach_season t join teams tm on tm.tcode=t.tcode join coaches co on co.coach_id=t.coach_id where t.season_name=%s order by tm.name", (season,))
for n, co, ok in cur.fetchall(): print("  %-12s %-6s %s" % (n, co, "" if ok else "(확인 필요)"))
c.close()
