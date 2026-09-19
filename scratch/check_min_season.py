import sqlite3

conn = sqlite3.connect('raw/kbl_realdata.db')
cur = conn.cursor()
cur.execute("SELECT MIN(game_date) FROM games")
print("Earliest game date:", cur.fetchone()[0])
conn.close()
