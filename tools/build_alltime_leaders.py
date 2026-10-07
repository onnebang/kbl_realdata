import sqlite3
import pandas as pd
import json
import os
from datetime import datetime, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "..", "raw", "kbl_realdata.db")
OUTPUT_PATH = os.path.join(BASE, "..", "courtside-web", "lib", "alltime_leaders.json")
# 라이브 경기 "기록 워치"(courtside-web/lib/careerMarks.ts) 재료 - 선수별 통산 합계/한 경기 최고기록 스냅샷.
CAREER_MARKS_PATH = os.path.join(BASE, "..", "courtside-web", "lib", "career_marks.json")
MARK_STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'threep']  # 순서가 careerMarks.ts의 MARK_CATS와 같아야 한다
# 스냅샷 이후에 끝난 경기를 웹이 Supabase에서 더해 주는데, 스냅샷에 이미 들어 있는 경기와 겹치지 않게 가르는 기준 -
# 이 일수 안의 경기는 gmkey를 따로 적어 둔다(그보다 오래된 경기는 전부 스냅샷에 들어 있다고 본다).
RECENT_WINDOW_DAYS = 21


def build_career_marks(conn, all_agg, merged_stats):
    """선수별 통산 합계(정규/플레이오프, 올타임 리더스와 같은 값 - 레전드 보정 alltime_overrides.json 포함)와 한 경기
    최고기록(정규+플레이오프, 전시경기 제외)을 courtside-web/lib/career_marks.json으로 낸다.

    왜 올타임 리더스 JSON(alltime_leaders.json)을 그대로 안 쓰는가: 그건 각 부문 상위 100명(+현역 상위 100명)만 담아서
    중하위 선수의 100개 단위 이정표나 커리어 하이에는 값이 없다. 이 스냅샷은 전 선수를 담고, 웹이 요청 시점에 스냅샷 이후
    경기만 Supabase에서 더해 항상 최신 합계로 쓴다(주 1회 갱신이라 몇 경기씩 낡는 걸 그대로 두면 이정표 알림이 틀린다)."""
    games = pd.read_sql_query(
        "SELECT gmkey, game_date FROM games WHERE season_category IN ('정규시즌', '플레이오프', '챔피언결정전')", conn)
    as_of = games['game_date'].max()  # 'YYYYMMDD'
    window_start = (datetime.strptime(as_of, '%Y%m%d') - timedelta(days=RECENT_WINDOW_DAYS)).strftime('%Y%m%d')
    iso = lambda d: f"{d[:4]}-{d[4:6]}-{d[6:]}"

    played = merged_stats[merged_stats['split_type'] != 'other']
    highs = played.groupby('pcode')[MARK_STATS].max()
    by_split = {sp: df.set_index('pcode') for sp, df in all_agg[all_agg['split_type'].isin(['regular', 'playoffs'])].groupby('split_type')}
    names = all_agg.dropna(subset=['pname']).drop_duplicates('pcode').set_index('pcode')[['pname', 'is_active']]

    def totals(sp, pcode):
        df = by_split.get(sp)
        if df is None or pcode not in df.index:
            return [0] * 7
        row = df.loc[pcode]
        return [int(row.get(c, 0) or 0) for c in MARK_STATS + ['gp']]

    players = {}
    for pcode in names.index:
        reg, po = totals('regular', pcode), totals('playoffs', pcode)
        if not any(reg) and not any(po):
            continue
        players[str(pcode)] = {
            'n': str(names.loc[pcode, 'pname']),
            'a': int(bool(names.loc[pcode, 'is_active'])),
            'reg': reg,
            'po': po,
            'hi': [int(highs.loc[pcode, c]) for c in MARK_STATS] if pcode in highs.index else None,
        }

    out = {
        'asOf': iso(as_of),
        'recentFrom': iso(window_start),
        'recentGmkeys': games[games['game_date'] >= window_start]['gmkey'].tolist(),
        'cats': MARK_STATS + ['gp'],
        'players': players,
    }
    with open(CAREER_MARKS_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f"[SUCCESS] career marks ({len(players)} players, as of {out['asOf']}) -> {CAREER_MARKS_PATH}")

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

    # 'total' = regular + playoffs only. 'other'는 역사적으로 0행이었지만(정규시즌/플레이오프/
    # 챔피언결정전 셋뿐) 2026-27시즌 'OPEN MATCH DAY'(오픈매치, 전시경기) 10경기가 여기 처음
    # 생겼다 - 통산 순위표는 전시경기를 세면 안 되므로 'total'에서 'other'는 계속 뺀다.
    agg_total = merged_stats[merged_stats['split_type'] != 'other'].groupby('pcode').sum(numeric_only=True).reset_index()
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

    build_career_marks(conn, all_agg, merged_stats)

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
            
            sp_df_sorted = sp_df.sort_values(by=col, ascending=False)
            
            # Find top 100 overall
            overall_pcodes = sp_df_sorted.head(100)['pcode'].tolist()
            
            # Find top 100 active
            active_pcodes = sp_df_sorted[sp_df_sorted['is_active'] == True].head(100)['pcode'].tolist()
            
            keep_pcodes = set(overall_pcodes + active_pcodes)
            
            category_list = []
            rank = 1
            for _, row in sp_df_sorted.iterrows():
                # Skip 0s
                if row[col] == 0: continue
                
                if row['pcode'] in keep_pcodes:
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
