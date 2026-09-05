# -*- coding: utf-8 -*-
"""tools/lockdown_anon.sql의 **실행 가능한 역연산**(읽기 쪽만).

    PYTHONIOENCODING=utf-8 python tools/rollback_lockdown.py

lockdown_anon.sql 하단의 롤백 블록은 주석이라 손으로 옮겨 적어야 한다 - 장애 중에는 그럴 시간이
없다. 2026-09-05에 프로덕션이 두 번 깨졌을 때(1차: 키가 다른 Vercel 프로젝트에, 2차: 키 값이
이 Supabase 프로젝트에 무효) 이 스크립트로 각각 수 초 만에 복구했다.

되살리는 것: SELECT 정책 25개(락다운 로그의 원래 이름 그대로) · 뷰 2개 SELECT · RPC 7개 EXECUTE.
쓰기 grant 회수(5절)는 되돌리지 않는다 - RLS가 어차피 막고, 서버 코드에 쓰기가 없어 무해하다.
정책이 이미 있으면 건너뛰므로 여러 번 실행해도 안전하다.
"""
import sys
sys.path.insert(0, r"D:\영상작업\축구\개발\kbl_realdata\tools")
import psycopg2
from import_roster import load_database_url

POLICIES = [
    ("teams", "public read teams"), ("coaches", "public read coaches"), ("seasons", "public read seasons"),
    ("action_codes", "public read action_codes"), ("game_team_stats", "public read game_team_stats"),
    ("game_player_stats", "public read game_player_stats"), ("shot_log", "public read shot_log"),
    ("lineup_stints", "public read lineup_stints"), ("pregame_features", "public read pregame_features"),
    ("lineup_combo", "public read"), ("player_onoff", "public read"),
    ("player_season_wpa", "public read player_season_wpa"), ("game_summary_tags", "public read"),
    ("xpts_zone_table", "public read"), ("player_win_impact", "player_win_impact_public_read"),
    ("season_roster", "public read"), ("roster_changes", "public read"),
    ("roster_departure", "roster_departure_public_read"),
    ("import_slot_season", "public read import_slot_season"), ("import_rule_season", "public read import_rule_season"),
    ("departure_impact_team", "public read departure_impact_team"),
    ("departure_impact_player", "public read departure_impact_player"),
    ("strength_adjustment_team", "public read strength_adjustment_team"),
    ("strength_adjustment_player", "public read strength_adjustment_player"),
    ("player_nationality", "public read player_nationality"),
]
VIEWS = ["seasons_with_regular_games", "team_season_running_avg"]
RPCS = ["player_clutch_profile", "player_season_percentile_pool", "season_zone_mix", "team_best_units",
        "team_season_four_factors", "team_season_roster", "form_index_season(text)"]

c = psycopg2.connect(load_database_url())
c.autocommit = False
cur = c.cursor()
created = 0
for t, pol in POLICIES:
    cur.execute("select 1 from pg_policies where schemaname='public' and tablename=%s and policyname=%s", (t, pol))
    if cur.fetchone():
        continue
    cur.execute('create policy "%s" on public.%s for select using (true)' % (pol.replace('"', '""'), t))
    created += 1
for v in VIEWS:
    cur.execute("grant select on public.%s to anon, authenticated" % v)
for fn in RPCS:
    cur.execute("grant execute on function public.%s to anon, authenticated, public" % fn)
c.commit()
print("복구: 정책 %d개 생성, 뷰 %d개 grant, RPC %d개 grant - 커밋 완료" % (created, len(VIEWS), len(RPCS)))

cur.execute("select count(*) from pg_policies where schemaname='public' and cmd='SELECT'")
print("public SELECT 정책 수:", cur.fetchone()[0], "(락다운 전 51)")
cur.execute("select has_function_privilege('anon','public.form_index_season(text)','EXECUTE'), has_table_privilege('anon','public.seasons_with_regular_games','SELECT')")
print("anon form_index_season EXECUTE / 뷰 SELECT:", cur.fetchone())
c.close()
