import sqlite3
import pandas as pd
import json
import os
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "..", "raw", "kbl_realdata.db")
OUTPUT_PATH = os.path.join(BASE, "..", "courtside-web", "lib", "alltime_leaders.json")

def build_alltime_leaders():
    conn = sqlite3.connect(DB_PATH)
    
    # Check max season to define 'active' status
    max_season_query = "SELECT MAX(season_name) as max_s FROM games;"
    max_s_df = pd.read_sql_query(max_season_query, conn)
    max_season = max_s_df.iloc[0]['max_s']
    
    # We want to know for each player if they played in the max_season
    # So we get max season per pcode
    player_max_season_query = """
    SELECT 
        p.pcode, 
        MAX(g.season_name) as last_season,
        MAX(p.pname) as pname
    FROM player_game_stats p
    JOIN games g ON p.gmkey = g.gmkey
    GROUP BY p.pcode
    """
    player_seasons = pd.read_sql_query(player_max_season_query, conn)
    player_seasons['is_active'] = player_seasons['last_season'] == max_season
    
    # Aggregate stats
    agg_query = """
    SELECT 
        pcode,
        COUNT(gmkey) as gp,
        SUM(score) as pts,
        SUM(rb) as reb,
        SUM(ast) as ast,
        SUM(stl) as stl,
        SUM(bs) as blk,
        SUM(threep) as threep
    FROM player_game_stats
    GROUP BY pcode
    """
    agg_stats = pd.read_sql_query(agg_query, conn)
    
    # Merge with player info
    df = pd.merge(agg_stats, player_seasons, on='pcode')
    
    # Load overrides to fix missing 1997-2005 data
    overrides_path = os.path.join(BASE, "alltime_overrides.json")
    if os.path.exists(overrides_path):
        with open(overrides_path, 'r', encoding='utf-8') as f:
            overrides = json.load(f)
        
        for col, data_list in overrides.items():
            for item in data_list:
                pcode = item['pcode']
                val = item['value']
                
                # Check if pcode exists in df
                if pcode in df['pcode'].values:
                    df.loc[df['pcode'] == pcode, col] = val
                else:
                    # Missing entirely, append a new row
                    new_row = {
                        'pcode': pcode,
                        'pname': item.get('pname', ''),
                        'is_active': False,
                        'gp': 0, 'pts': 0, 'reb': 0, 'ast': 0, 'stl': 0, 'blk': 0, 'threep': 0
                    }
                    new_row[col] = val
                    df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)

    leaders = {}
    categories = [
        ('pts', '득점'),
        ('reb', '리바운드'),
        ('ast', '어시스트'),
        ('stl', '스틸'),
        ('blk', '블록'),
        ('threep', '3점슛'),
        ('gp', '출전 경기')
    ]
    
    for col, kr_name in categories:
        top100 = df.sort_values(by=col, ascending=False).head(100)
        
        category_list = []
        rank = 1
        for _, row in top100.iterrows():
            category_list.append({
                "rank": rank,
                "pcode": str(row['pcode']),
                "pname": str(row['pname']),
                "value": int(row[col]),
                "is_active": bool(row['is_active'])
            })
            rank += 1
            
        leaders[col] = {
            "name": kr_name,
            "data": category_list
        }
        
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(leaders, f, ensure_ascii=False, indent=2)
        
    print(f"[SUCCESS] All-time leaders generated to {OUTPUT_PATH}")

if __name__ == '__main__':
    build_alltime_leaders()
