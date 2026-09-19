import sqlite3
import json

conn = sqlite3.connect('raw/kbl_realdata.db')
cur = conn.cursor()
cur.execute("SELECT pcode, pname FROM (SELECT DISTINCT pcode, pname FROM player_game_stats)")
rows = cur.fetchall()
res = [r for r in rows if '라건아' in r[1] or '라틀리프' in r[1]]
with open('scratch/ra.json', 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False)
conn.close()
