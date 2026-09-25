# -*- coding: utf-8 -*-
import sys
import json
import sync_upcoming_games as sug
sug.load_env_supabase()
conn = sug.get_conn()
cur = conn.cursor()

names = ['워싱턴', '김영현', '윌리엄스', '에르난데스']
res = {}
for name in names:
    cur.execute("SELECT pcode, name FROM players WHERE name LIKE %s", ('%' + name + '%',))
    res[name] = cur.fetchall()

with open('pcodes_out.json', 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False, indent=2)

conn.close()
