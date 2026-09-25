# -*- coding: utf-8 -*-
import sync_upcoming_games as sug
sug.load_env_supabase()
conn = sug.get_conn()
cur = conn.cursor()
to_remove = [
    ('워싱턴', '70'),
    ('김영현', '70'),
    ('윌리엄스', '06'),
    ('에르난데스', '60')
]
for name, tcode in to_remove:
    cur.execute("SELECT pcode, player_name FROM season_roster WHERE season_name='2026-2027' AND player_name LIKE %s AND tcode=%s", ('%' + name + '%', tcode))
    for r in cur.fetchall():
        print('Deleting', r[1], r[0], 'from', tcode)
        cur.execute("DELETE FROM season_roster WHERE season_name='2026-2027' AND pcode=%s AND tcode=%s", (r[0], tcode))
conn.commit()
conn.close()
