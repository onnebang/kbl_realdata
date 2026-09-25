import sync_upcoming_games as sug
sug.load_env_supabase()
conn = sug.get_conn()
cur = conn.cursor()
to_delete = [
    ('291793', '70'),
    ('291346', '70'),
    ('290741', '70'),
    ('291791', '06'),
    ('291580', '60')
]
for p, t in to_delete:
    cur.execute("DELETE FROM season_roster WHERE season_name='2026-2027' AND pcode=%s AND tcode=%s", (p, t))
conn.commit()
conn.close()
