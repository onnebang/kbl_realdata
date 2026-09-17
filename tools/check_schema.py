import sqlite3
import pandas as pd
conn = sqlite3.connect('../raw/kbl_realdata.db')
df = pd.read_sql_query("SELECT * FROM games LIMIT 1", conn)
print(df.columns.tolist())
