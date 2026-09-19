import sqlite3
import pandas as pd
conn = sqlite3.connect('raw/kbl_realdata.db')
print(pd.read_sql_query("SELECT pcode, pname, SUM(score) FROM player_game_stats WHERE pname LIKE '%헤인즈%' GROUP BY pcode", conn))
