import sqlite3
conn = sqlite3.connect('raw/kbl_realdata.db')
cur = conn.cursor()
cur.execute("SELECT MIN(g.game_date), COUNT(gps.gmkey) FROM games g LEFT JOIN player_game_stats gps ON g.gmkey = gps.gmkey WHERE g.season_name LIKE '%1998%'")
print("1998 games stats count:", cur.fetchone())
cur.execute("SELECT MIN(g.game_date) FROM games g JOIN player_game_stats gps ON g.gmkey = gps.gmkey")
print("Earliest game date with stats:", cur.fetchone()[0])
conn.close()
