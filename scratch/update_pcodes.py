import psycopg2
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath('tools/import_roster.py')))
from import_roster import load_database_url

try:
    conn = psycopg2.connect(load_database_url())
    cur = conn.cursor()
    # Insert Archie Goodwin
    cur.execute("INSERT INTO players (pcode, name) VALUES ('291882', '아치 굿윈') ON CONFLICT (pcode) DO NOTHING;")
    cur.execute("UPDATE season_roster SET pcode='291882' WHERE player_name='아치 굿윈' AND pcode IS NULL")
    
    # Insert Louis King
    cur.execute("INSERT INTO players (pcode, name) VALUES ('291884', '루이스 킹') ON CONFLICT (pcode) DO NOTHING;")
    cur.execute("UPDATE season_roster SET pcode='291884' WHERE player_name='루이스 킹' AND pcode IS NULL")
    
    conn.commit()
    print('Successfully updated pcodes in Supabase!')
except Exception as e:
    print(e)
finally:
    if 'conn' in locals() and conn:
        conn.close()
