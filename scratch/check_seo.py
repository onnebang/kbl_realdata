import sqlite3
import json

conn = sqlite3.connect('raw/kbl_realdata.db')
cur = conn.cursor()

# Query total score for Seo Jang-hoon (290261)
cur.execute("SELECT SUM(score) FROM player_game_stats WHERE pcode='290261'")
print("Raw score:", cur.fetchone()[0])

# Query total score joining with games to see if some are excluded
query = """
    SELECT SUM(gps.score)
    FROM player_game_stats gps
    JOIN games g ON gps.gmkey = g.gmkey
    WHERE gps.pcode = '290261' AND g.season_category = '정규시즌'
"""
cur.execute(query)
print("Regular season score:", cur.fetchone()[0])

conn.close()
