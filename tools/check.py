import sys
import sync_upcoming_games as sug
sug.load_env_supabase()
conn = sug.get_conn()
cur = conn.cursor()
cur.execute("SELECT tcode, name FROM teams")
for r in cur.fetchall(): print(r)
