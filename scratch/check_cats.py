import sqlite3
import json
import codecs

conn = sqlite3.connect('raw/kbl_realdata.db')
c = conn.cursor()

cats = c.execute("SELECT DISTINCT season_category FROM games").fetchall()
categories = [x[0] for x in cats]

# Let's get rebounds for Ra Gun-ah by category
ra_rebs_by_cat = {}
for cat in categories:
    rebs = c.execute("SELECT SUM(rb) FROM player_game_stats p JOIN games g ON p.gmkey=g.gmkey WHERE pcode='290524' AND g.season_category=?", (cat,)).fetchone()[0]
    ra_rebs_by_cat[cat] = rebs

with codecs.open('scratch/diagnostics2.json', 'w', 'utf-8') as f:
    json.dump({"categories": categories, "ra_rebs": ra_rebs_by_cat}, f, ensure_ascii=False, indent=2)
