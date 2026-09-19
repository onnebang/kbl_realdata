import sqlite3
import pandas as pd

conn = sqlite3.connect('raw/kbl_realdata.db')
query = """
SELECT pcode, pname, SUM(score) as pts, SUM(ast) as ast, SUM(rb) as reb, SUM(threep) as threep
FROM player_game_stats
WHERE pname IN ('서장훈', '라건아', '애런 헤인즈', '김주성', '추승균', '주희정', '이상민', '양동근', '신기성', '김승현', '문경은', '우지원')
GROUP BY pcode, pname
"""
df = pd.read_sql_query(query, conn)
print(df)
