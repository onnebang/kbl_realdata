import sync_upcoming_games as sug
sug.load_env_supabase()
conn = sug.get_conn()
cur = conn.cursor()

# Find military players
cur.execute("SELECT pcode, player_name, note, tcode FROM season_roster WHERE season_name='2026-2027' AND note LIKE '%군복무%'")
rows = cur.fetchall()
for r in rows:
    print(f"Deleting {r[1]} ({r[0]}) from tcode {r[3]} (note: {r[2]})")
    cur.execute("DELETE FROM season_roster WHERE season_name='2026-2027' AND pcode=%s AND tcode=%s", (r[0], r[3]))

conn.commit()
conn.close()
