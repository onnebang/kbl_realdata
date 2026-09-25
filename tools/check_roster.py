# -*- coding: utf-8 -*-
import sys
import sync_upcoming_games as sug
sug.load_env_supabase()
conn = sug.get_conn()
cur = conn.cursor()
cur.execute("SELECT pcode, player_name FROM season_roster WHERE tcode='70' AND season_name='2026-2027'")
print("KGC (70):")
for r in cur.fetchall(): print(r)
cur.execute("SELECT pcode, player_name FROM season_roster WHERE tcode='06' AND season_name='2026-2027'")
print("KT (06):")
for r in cur.fetchall(): print(r)
cur.execute("SELECT pcode, player_name FROM season_roster WHERE tcode='60' AND season_name='2026-2027'")
print("KCC (60):")
for r in cur.fetchall(): print(r)
conn.close()
