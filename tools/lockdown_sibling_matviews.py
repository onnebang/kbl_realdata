# -*- coding: utf-8 -*-
"""who-are-ya 머티리얼라이즈드 뷰의 **사용자 식별자 컬럼만** anon·authenticated에서 닫는다 (①안).

    python tools/lockdown_sibling_matviews.py            # 상태
    python tools/lockdown_sibling_matviews.py --apply    # 적용 (한 트랜잭션)
    python tools/lockdown_sibling_matviews.py --rollback # 테이블 단위 SELECT 복원

왜 테이블 단위가 아니라 컬럼 단위인가 (2026-09-05 감사): 19개 뷰 전부를 who-are-ya가 **브라우저에서
직접** 읽는다(저장소 7묶음 31곳, 24시간 로그 전부 runtime=web, service_role 읽기 0건, RPC 경로 0개).
테이블 단위로 닫으면 랭킹·대결 화면이 깨진다. 보호할 가치가 있는 건 id / user_id / result_id 뿐이다.

왜 이 6개 뷰만인가: 코드 감사로 앱이 이 뷰들에서 식별자 컬럼을 **한 번도 요청하지 않음**이 확정됐다.
  battle_cache 4개 -> 앱은 nickname, favorite_team, favorite_player, lifetime_rounds_cleared, saved_game 만
  kbo144_lb_cache / kovo36_lb_cache -> 앱이 아예 읽지 않음 (hallOfFame.js는 *_season_results 테이블을 읽는다)
나머지 5개(프로필 lb 4개의 id, kleague38_lb_cache의 user_id)는 앱이 비로그인에서도 select 하므로
who-are-ya 코드를 고친 뒤에만 닫을 수 있다(②안, leaderboardEngine.js / kleague/leaderboard.js).

Postgres 함정: 테이블 단위 SELECT가 있으면 컬럼 단위 REVOKE는 무효다. 그래서
  revoke select on 뷰 from anon, authenticated;  ->  grant select (허용 컬럼들) on 뷰 to anon, authenticated;
순서로 간다. service_role은 건드리지 않는다(테이블 단위 SELECT 유지, bypassrls).
결과적으로 select=* 도 거부된다(스크래퍼가 쓰던 패턴) - 앱은 * 를 쓰지 않는다(감사 확인).
"""
import sys
sys.path.insert(0, r"D:\영상작업\축구\개발\kbl_realdata\tools")
import psycopg2
from import_roster import load_database_url

# 뷰 -> 닫을 컬럼
HIDE = {
    "profiles_battle_cache": ["id"],
    "kbo_profiles_battle_cache": ["id"],
    "kleague_profiles_battle_cache": ["id"],
    "kovo_profiles_battle_cache": ["id"],
    "kbo144_lb_cache": ["user_id", "result_id"],
    "kovo36_lb_cache": ["user_id", "result_id"],
}
ROLES = "anon, authenticated"

mode = sys.argv[1] if len(sys.argv) > 1 else "--status"
c = psycopg2.connect(load_database_url())
c.autocommit = False
cur = c.cursor()


def columns(view):
    cur.execute("""select a.attname from pg_attribute a where a.attrelid = ('public.' || %s)::regclass
                    and a.attnum > 0 and not a.attisdropped order by a.attnum""", (view,))
    return [r[0] for r in cur.fetchall()]


if mode == "--apply":
    for view, hide in HIDE.items():
        cols = columns(view)
        missing = [h for h in hide if h not in cols]
        assert not missing, "%s 에 없는 컬럼: %s" % (view, missing)
        allowed = [col for col in cols if col not in hide]
        cur.execute("revoke select on public.%s from %s" % (view, ROLES))
        cur.execute("grant select (%s) on public.%s to %s" % (", ".join(allowed), view, ROLES))
    c.commit()
    print("적용 완료: %d개 뷰, 테이블 SELECT 회수 후 허용 컬럼만 grant (커밋)" % len(HIDE))
elif mode == "--rollback":
    for view in HIDE:
        cur.execute("grant select on public.%s to %s" % (view, ROLES))
    c.commit()
    print("복구 완료: %d개 뷰 테이블 단위 SELECT 복원 (커밋)" % len(HIDE))

print("\n%-30s %-10s %-22s %-22s %-8s" % ("뷰", "컬럼", "anon", "authenticated", "service"))
bad = 0
for view, hide in HIDE.items():
    for col in columns(view):
        cur.execute("""select has_column_privilege('anon', %s, %s, 'SELECT'),
                              has_column_privilege('authenticated', %s, %s, 'SELECT'),
                              has_column_privilege('service_role', %s, %s, 'SELECT')""",
                    ("public." + view, col, "public." + view, col, "public." + view, col))
        a, au, s = cur.fetchone()
        want_hidden = col in hide
        ok = (not a and not au) if want_hidden else (a and au)
        if not s or (mode != "--rollback" and not ok and mode == "--apply"):
            bad += 1
        mark = "닫힘" if want_hidden else "허용"
        print("%-30s %-10s %-22s %-22s %-8s %s" % (view, col, a, au, s, mark if mode == "--apply" else ""))
if mode == "--apply":
    print("\n기대와 다른 항목: %d (0이어야 함)" % bad)
c.close()
