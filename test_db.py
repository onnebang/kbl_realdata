import os
import psycopg2
from dotenv import load_dotenv
load_dotenv('.env.local')

conn = psycopg2.connect(
    host=os.environ.get('SUPABASE_DB_HOST'),
    database='postgres',
    user=os.environ.get('SUPABASE_DB_USER'),
    password=os.environ.get('SUPABASE_DB_PASSWORD'),
    port=6543
)
cur = conn.cursor()
cur.execute("SELECT name, team_code FROM players WHERE season_code='S49' AND name IN ('송교창', '최준용', '드완 에르난데스', '워싱턴', '김영현', '데릭 윌리엄스')")
for r in cur.fetchall(): print(r)
