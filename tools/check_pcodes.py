# -*- coding: utf-8 -*-
import sys
import sync_upcoming_games as sug
sug.load_env_supabase()
conn = sug.get_conn()
cur = conn.cursor()

names = ['워싱턴', '김영현', '윌리엄스', '에르난데스']
for name in names:
    cur.execute("SELECT pcode, name FROM players WHERE name LIKE %s", ('%' + name + '%',))
    print(f"Found {name}:")
    for r in cur.fetchall(): print(r)

conn.close()
