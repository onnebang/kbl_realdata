import sqlite3
import pandas as pd
conn = sqlite3.connect('../raw/kbl_realdata.db')
df = pd.read_sql_query("SELECT name FROM sqlite_master WHERE type='table'", conn)
print(df)
