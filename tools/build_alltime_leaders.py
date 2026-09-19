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
    # And get their most recent pname to avoid alphabetical issues like 라건아 < 라들리프 -> 라들리프
    player_max_season_query = """
    SELECT 
        p.pcode, 
        MAX(g.season_name) as last_season
    FROM player_game_stats p
    JOIN games g ON p.gmkey = g.gmkey
    GROUP BY p.pcode
    """
    player_seasons = pd.read_sql_query(player_max_season_query, conn)
    
    # Get the latest pname for each player by joining back
    latest_pname_query = """
    SELECT p.pcode, p.pname, g.season_name
    FROM player_game_stats p
    JOIN games g ON p.gmkey = g.gmkey
    """
    latest_names = pd.read_sql_query(latest_pname_query, conn)
    # Sort by season descending and keep the first one
    latest_names = latest_names.sort_values(by='season_name', ascending=False).drop_duplicates(subset=['pcode'], keep='first')
    
    player_info = pd.merge(player_seasons, latest_names[['pcode', 'pname']], on='pcode')
    player_info['is_active'] = player_info['last_season'] == max_season
    
    # HARDCODE overrides for retired players
    # 290100 is Ham Ji-hoon
    player_info.loc[player_info['pcode'] == '290100', 'is_active'] = False
    
    # Map season_category
    # '정규시즌' -> 'regular'
    # '플레이오프', '챔피언결정전' -> 'playoffs'
    cat_mapping_query = """
    SELECT gmkey, 
           CASE 
             WHEN season_category = '정규시즌' THEN 'regular'
             WHEN season_category IN ('플레이오프', '챔피언결정전') THEN 'playoffs'
             ELSE 'other'
           END as split_type
    FROM games
    """
    cat_mapping = pd.read_sql_query(cat_mapping_query, conn)
    
    raw_stats_query = """
    SELECT 
        gmkey, pcode,
        score as pts, rb as reb, ast, stl, bs as blk, threep, 1 as gp
    FROM player_game_stats
    """
    raw_stats = pd.read_sql_query(raw_stats_query, conn)
    
    merged_stats = pd.merge(raw_stats, cat_mapping, on='gmkey')
    
    # Aggregate by pcode and split_type
    agg_split = merged_stats.groupby(['pcode', 'split_type']).sum().reset_index()
    
    # We need to compute 'total' = regular + playoffs + other
    agg_total = merged_stats.groupby('pcode').sum().reset_index()
    agg_total['split_type'] = 'total'
    
    all_agg = pd.concat([agg_split, agg_total], ignore_index=True)
    all_agg = pd.merge(all_agg, player_info[['pcode', 'pname', 'is_active']], on='pcode', how='left')
    
    # Load overrides
    overrides_path = os.path.join(BASE, "alltime_overrides.json")
    if os.path.exists(overrides_path):
        with open(overrides_path, 'r', encoding='utf-8') as f:
            overrides = json.load(f)
            
        # apply 'regular' overrides
        if 'regular' in overrides:
            for col, data_list in overrides['regular'].items():
                for item in data_list:
                    pcode = str(item['pcode'])
                    val = item['value']
                    
                    # update regular
                    mask_reg = (all_agg['pcode'] == pcode) & (all_agg['split_type'] == 'regular')
                    if mask_reg.any():
                        old_reg = all_agg.loc[mask_reg, col].values[0]
                        diff = val - old_reg
                        all_agg.loc[mask_reg, col] = val
                        
                        # update total by the diff so that total = regular_override + playoffs_db
                        mask_tot = (all_agg['pcode'] == pcode) & (all_agg['split_type'] == 'total')
                        if mask_tot.any():
                            all_agg.loc[mask_tot, col] += diff
                    else:
                        # Add new rows if entirely missing
                        new_reg = {'pcode': pcode, 'pname': item.get('pname', ''), 'is_active': False, 'split_type': 'regular'}
                        new_reg[col] = val
                        
                        new_tot = {'pcode': pcode, 'pname': item.get('pname', ''), 'is_active': False, 'split_type': 'total'}
                        new_tot[col] = val
                        
                        # If playoffs exist, we should add it to total. 
                        # Let's find playoff value in all_agg
                        mask_po = (all_agg['pcode'] == pcode) & (all_agg['split_type'] == 'playoffs')
                        if mask_po.any():
                            po_val = all_agg.loc[mask_po, col].values[0]
                            if pd.notna(po_val):
                                new_tot[col] += po_val
                                
                        all_agg = pd.concat([all_agg, pd.DataFrame([new_reg, new_tot])], ignore_index=True)
                        # Fix NaNs to 0 for other columns in new rows
                        all_agg = all_agg.fillna(0)

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
    
    splits = ['total', 'regular', 'playoffs']
    
    # Restructure output:
    # {
    #   "total": { "pts": { "name": "득점", "data": [...] }, ... },
    #   "regular": { ... }
    # }
    for sp in splits:
        leaders[sp] = {}
        sp_df = all_agg[all_agg['split_type'] == sp]
        
        for col, kr_name in categories:
            if col not in sp_df.columns: continue
            
            top100 = sp_df.sort_values(by=col, ascending=False).head(100)
            
            category_list = []
            rank = 1
            for _, row in top100.iterrows():
                # Skip 0s
                if row[col] == 0: continue
                
                category_list.append({
                    "rank": rank,
                    "pcode": str(row['pcode']),
                    "pname": str(row['pname']),
                    "value": int(row[col]),
                    "is_active": bool(row['is_active'])
                })
                rank += 1
                
            leaders[sp][col] = {
                "name": kr_name,
                "data": category_list
            }
            
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(leaders, f, ensure_ascii=False, indent=2)
        
    print(f"[SUCCESS] All-time leaders (split) generated to {OUTPUT_PATH}")

if __name__ == '__main__':
    build_alltime_leaders()
