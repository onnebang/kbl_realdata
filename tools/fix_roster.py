import sys
import sync_upcoming_games as sug
sug.load_env_supabase()
conn = sug.get_conn()
cur = conn.cursor()

to_remove = [
    ('워싱턴', '70'),
    ('김영현', '70'),
    ('데릭 윌리엄스', '06'),
    ('송교창', '60'),
    ('최준용', '60'),
    ('드완 에르난데스', '60')
]

for name, tcode in to_remove:
    cur.execute("SELECT pcode FROM season_roster WHERE season_name='2026-2027' AND player_name LIKE %s AND tcode=%s", ('%' + name + '%', tcode))
    rows = cur.fetchall()
    print(f"Found {name} in {tcode}: {rows}")
    if rows:
        for r in rows:
            cur.execute("DELETE FROM season_roster WHERE season_name='2026-2027' AND pcode=%s AND tcode=%s", (r[0], tcode))
            print(f"Deleted {r[0]}")

conn.commit()
conn.close()
