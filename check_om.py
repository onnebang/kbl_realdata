import sqlite3
import pandas as pd

db_path = r'd:\영상작업\축구\개발\kbl_realdata\raw\kbl_realdata.db'
conn = sqlite3.connect(db_path)

# 1. Get OM games
games = pd.read_sql("SELECT gmkey, game_date, home_tcode, away_tcode, home_name, away_name FROM games WHERE season_category = 'OM' AND game_date >= '20260920' AND game_date <= '20260929'", conn)

if len(games) == 0:
    print("No OM games found in the given date range.")
else:
    print(f"Found {len(games)} OM games.")

    # 2. Get player stats for these games
    query = """
    SELECT s.gmkey, s.pcode, s.pname, s.tcode, s.play_min, s.play_sec, s.score, s.rb, s.ast, s.stl, s.bs, s.to_, s.fg, s.fg_a, s.threep, s.threep_a, s.ft, s.ft_a, s.offrtg, s.defrtg, s.netrtg
    FROM player_game_stats s
    JOIN games g ON s.gmkey = g.gmkey
    WHERE g.season_category = 'OM' AND g.game_date >= '20260920' AND g.game_date <= '20260929'
    """
    stats = pd.read_sql(query, conn)
    
    # Calculate minutes
    stats['minutes'] = stats['play_min'] + stats['play_sec'] / 60.0
    
    # Aggregate by player
    agg = stats.groupby(['tcode', 'pcode', 'pname']).agg(
        games=('gmkey', 'count'),
        mins=('minutes', 'mean'),
        pts=('score', 'mean'),
        reb=('rb', 'mean'),
        ast=('ast', 'mean'),
        stl=('stl', 'mean'),
        blk=('bs', 'mean'),
        tov=('to_', 'mean'),
        fg=('fg', 'sum'),
        fga=('fg_a', 'sum'),
        fg3=('threep', 'sum'),
        fg3a=('threep_a', 'sum'),
        netrtg=('netrtg', 'mean')
    ).reset_index()
    
    agg['fg_pct'] = (agg['fg'] / agg['fga'] * 100).fillna(0)
    agg['fg3_pct'] = (agg['fg3'] / agg['fg3a'] * 100).fillna(0)
    
    # Sort by team and points
    agg = agg.sort_values(['tcode', 'pts'], ascending=[True, False])
    
    pd.set_option('display.max_rows', None)
    print(agg)
