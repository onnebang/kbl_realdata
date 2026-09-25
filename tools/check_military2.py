# -*- coding: utf-8 -*-
import json
import sync_upcoming_games as sug
sug.load_env_supabase()
conn = sug.get_conn()
cur = conn.cursor()
cur.execute("SELECT pcode, player_name, note, tcode FROM season_roster WHERE season_name='2026-2027' AND player_name IN ('신승민', '박인웅')")
rows = cur.fetchall()
with open('military_out.json', 'w', encoding='utf-8') as f:
    json.dump(rows, f, ensure_ascii=False, indent=2)
conn.close()
