# -*- coding: utf-8 -*-
import sync_upcoming_games as sug
sug.load_env_supabase()
conn = sug.get_conn()
cur = conn.cursor()
cur.execute("SELECT pcode, player_name, note, tcode FROM season_roster WHERE season_name='2026-2027' AND player_name IN ('신승민', '박인웅')")
for r in cur.fetchall(): print(r)
conn.close()
