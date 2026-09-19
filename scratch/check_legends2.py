import sqlite3
import json
import codecs

conn = sqlite3.connect('raw/kbl_realdata.db')
c = conn.cursor()

output = {}

# Check Ra Gun-ah / Ratliffe
ra_rows = c.execute("SELECT DISTINCT pcode, pname FROM player_game_stats WHERE pname LIKE '%라들리프%' OR pname LIKE '%라건아%'").fetchall()
output['ra_gun_ah_names'] = ra_rows

# Check Ra Gun-ah total rebounds
ra_rebs = c.execute("SELECT SUM(rb) FROM player_game_stats WHERE pcode='290524'").fetchone()
output['ra_total_rebs'] = ra_rebs[0] if ra_rebs else 0
ra_rebs_po = c.execute("SELECT SUM(rb) FROM player_game_stats p JOIN games g ON p.gmkey=g.gmkey WHERE pcode='290524' AND g.season_category='PO'").fetchone()
output['ra_po_rebs'] = ra_rebs_po[0] if ra_rebs_po else 0
ra_rebs_r = c.execute("SELECT SUM(rb) FROM player_game_stats p JOIN games g ON p.gmkey=g.gmkey WHERE pcode='290524' AND g.season_category='R'").fetchone()
output['ra_r_rebs'] = ra_rebs_r[0] if ra_rebs_r else 0


# Check Kim Joo-sung
kim_rows = c.execute("SELECT DISTINCT pcode, pname FROM player_game_stats WHERE pname LIKE '%김주성%'").fetchall()
output['kim_joo_sung_names'] = kim_rows

kim_pcodes = [r[0] for r in kim_rows]
if kim_pcodes:
    kim_pcode = kim_pcodes[0] # assuming the first one is the legend
    kim_rebs = c.execute(f"SELECT SUM(rb) FROM player_game_stats WHERE pcode='{kim_pcode}'").fetchone()
    output['kim_total_rebs'] = kim_rebs[0] if kim_rebs else 0

# Check Ham Ji-hoon
ham_rows = c.execute("SELECT DISTINCT pcode, pname FROM player_game_stats WHERE pname LIKE '%함지훈%'").fetchall()
output['ham_ji_hoon_names'] = ham_rows

with codecs.open('scratch/diagnostics.json', 'w', 'utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)
