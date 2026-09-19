import sqlite3
import pandas as pd
conn = sqlite3.connect('raw/kbl_realdata.db')
print("Haynes:", pd.read_sql_query("SELECT SUM(score) FROM player_game_stats WHERE pcode='290675'", conn).iloc[0,0])
print("Seo:", pd.read_sql_query("SELECT SUM(score) FROM player_game_stats WHERE pcode='290261'", conn).iloc[0,0])
