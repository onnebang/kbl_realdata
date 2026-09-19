import sqlite3
import pandas as pd
import json
import os

DB_PATH = '../raw/kbl_realdata.db'
OUT_PATH = '../courtside-web/lib/courtside_achievements.json'

CAREER_MILESTONES = {
    'pts': [500, 1000, 2000, 3000, 5000, 7000, 10000, 15000],
    'reb': [300, 500, 1000, 2000, 3000, 5000, 7000],
    'ast': [300, 500, 1000, 2000, 3000, 5000, 7000],
    'threep': [100, 300, 500, 1000, 1500],
    'stl': [100, 300, 500, 1000, 1500],
    'blk': [100, 300, 500, 1000],
    'gp': [100, 300, 500, 700, 1000]
}

SEASON_MILESTONES = {
    'pts': [100, 300, 500, 800, 1000, 1500],
    'reb': [100, 200, 300, 500, 800],
    'ast': [100, 200, 300, 500, 700],
    'threep': [30, 50, 100, 150, 200],
    'stl': [30, 50, 100, 150],
    'blk': [30, 50, 100, 150],
    'gp': [10, 20, 30, 40, 54]
}

def get_tier_and_target(val, milestones):
    # tiers: Bronze, Silver, Gold, Platinum, Diamond, Master, Grandmaster, Challenger (depending on length)
    tiers = ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster", "Legend"]
    target = milestones[-1]
    tier = tiers[-1]
    for i, m in enumerate(milestones):
        if val < m:
            target = m
            tier = tiers[min(i, len(tiers)-1)]
            break
    return tier, target

def get_rivals(sorted_list, my_pcode, num_surrounding=3):
    my_idx = -1
    for i, item in enumerate(sorted_list):
        if str(item['pcode']) == str(my_pcode):
            my_idx = i
            break
    if my_idx == -1: return []
    start = max(0, my_idx - num_surrounding)
    end = min(len(sorted_list), my_idx + num_surrounding + 1)
    return sorted_list[start:end]

def get_achievement_data():
    real_db_path = os.path.join(os.path.dirname(__file__), DB_PATH)
    if not os.path.exists(real_db_path):
        print(f"Error: DB not found at {real_db_path}")
        return

    conn = sqlite3.connect(real_db_path)
    
    query = """
    SELECT 
        p.pcode, p.pname as name, g.season_name, g.game_date,
        gps.gmkey,
        gps.play_min, gps.play_sec,
        gps.score as pts,
        gps.ast,
        gps.rb as reb,
        gps.stl,
        gps.bs as blk,
        gps.to_ as tov,
        gps.foul as foul,
        gps.fg, gps.fg_a, gps.threep, gps.threep_a, gps.ft, gps.ft_a
    FROM player_game_stats gps
    JOIN games g ON gps.gmkey = g.gmkey
    JOIN (SELECT DISTINCT pcode, pname FROM player_game_stats) p ON gps.pcode = p.pcode
    WHERE g.season_category = '정규시즌'
    ORDER BY g.game_date ASC
    """
    
    df = pd.read_sql_query(query, conn)
    conn.close()
    
    df['total_min'] = df['play_min'] + df['play_sec'] / 60.0

    stat_cols = ['pts', 'reb', 'ast', 'threep', 'stl', 'blk', 'gp']

    # 1. Career Totals (All-Time)
    career_totals = df.groupby(['pcode', 'name']).agg({
        'pts': 'sum',
        'reb': 'sum',
        'ast': 'sum',
        'threep': 'sum',
        'stl': 'sum',
        'blk': 'sum',
        'gmkey': 'count' # GP
    }).rename(columns={'gmkey': 'gp'}).reset_index()

    # 2. Career Active Totals
    latest_season = df['season_name'].max()
    active_pcodes = df[df['season_name'] == latest_season]['pcode'].unique()
    active_totals = career_totals[career_totals['pcode'].isin(active_pcodes)].copy()

    # Build Leaderboards for Career
    career_lb_alltime = {}
    career_lb_active = {}
    
    for col in stat_cols:
        # All-Time
        ct_sorted = career_totals.sort_values(by=col, ascending=False).copy()
        ct_sorted['rank'] = ct_sorted[col].rank(method='min', ascending=False).astype(int)
        career_lb_alltime[col] = ct_sorted[['pcode', 'name', col, 'rank']].rename(columns={col: 'val'}).to_dict('records')
        
        # Active
        act_sorted = active_totals.sort_values(by=col, ascending=False).copy()
        act_sorted['rank'] = act_sorted[col].rank(method='min', ascending=False).astype(int)
        career_lb_active[col] = act_sorted[['pcode', 'name', col, 'rank']].rename(columns={col: 'val'}).to_dict('records')

    # 3. Season Totals
    season_totals = df.groupby(['season_name', 'pcode', 'name']).agg({
        'pts': 'sum',
        'reb': 'sum',
        'ast': 'sum',
        'threep': 'sum',
        'stl': 'sum',
        'blk': 'sum',
        'gmkey': 'count' # GP
    }).rename(columns={'gmkey': 'gp'}).reset_index()

    # Build Leaderboards for Seasons
    season_lbs = {} # { season_name: { 'pts': [ ... ], ... } }
    for season_name, season_df in season_totals.groupby('season_name'):
        season_lbs[season_name] = {}
        for col in stat_cols:
            st_sorted = season_df.sort_values(by=col, ascending=False).copy()
            st_sorted['rank'] = st_sorted[col].rank(method='min', ascending=False).astype(int)
            season_lbs[season_name][col] = st_sorted[['pcode', 'name', col, 'rank']].rename(columns={col: 'val'}).to_dict('records')

    # 4. Generate JSON Output
    output = {}

    # Initialize all players with career
    for _, row in career_totals.iterrows():
        pcode = str(row['pcode'])
        name = row['name']
        
        is_active = pcode in [str(p) for p in active_pcodes]
        
        career_stacks = {}
        for col in stat_cols:
            val = int(row[col])
            tier, target = get_tier_and_target(val, CAREER_MILESTONES[col])
            
            # Find all-time rank and rivals
            alltime_rivals = get_rivals(career_lb_alltime[col], row['pcode'], 3)
            rank_alltime = next((r['rank'] for r in alltime_rivals if str(r['pcode']) == pcode), None)
            
            stack_obj = {
                "val": val,
                "tier": tier,
                "target": target,
                "rank_alltime": rank_alltime,
                "rivals_alltime": alltime_rivals
            }
            
            if is_active:
                active_rivals = get_rivals(career_lb_active[col], row['pcode'], 3)
                rank_active = next((r['rank'] for r in active_rivals if str(r['pcode']) == pcode), None)
                stack_obj["rank_active"] = rank_active
                stack_obj["rivals_active"] = active_rivals
            else:
                stack_obj["rank_active"] = None
                stack_obj["rivals_active"] = []
                
            career_stacks[col] = stack_obj
            
        output[pcode] = {
            "name": name,
            "career": {
                "stacks": career_stacks,
                "missions": [] # Ready for future
            },
            "seasons": {}
        }

    # Populate seasons
    for (pcode_raw, season_name), group in df.groupby(['pcode', 'season_name']):
        pcode = str(pcode_raw)
        
        # Calculate season stacks
        season_stacks = {}
        # get from season_totals
        st_row = season_totals[(season_totals['pcode'] == pcode_raw) & (season_totals['season_name'] == season_name)].iloc[0]
        
        for col in stat_cols:
            val = int(st_row[col])
            tier, target = get_tier_and_target(val, SEASON_MILESTONES[col])
            
            rivals = get_rivals(season_lbs[season_name][col], pcode_raw, 3)
            rank = next((r['rank'] for r in rivals if str(r['pcode']) == pcode), None)
            
            season_stacks[col] = {
                "val": val,
                "tier": tier,
                "target": target,
                "rank": rank,
                "rivals": rivals
            }
            
        # Calculate season missions (existing logic)
        season_missions = []
        games_played = len(group)
        double_doubles = 0
        bomber_streak = 0
        
        for _, row in group.iterrows():
            tens = sum(1 for stat in [row['pts'], row['ast'], row['reb'], row['stl'], row['blk']] if stat >= 10)
            if tens >= 2: double_doubles += 1
            
            if row['pts'] >= 20 and row['reb'] >= 20:
                season_missions.append({"id": "club_20_20", "name": "20-20 클럽", "desc": "한 경기 20득점 & 20리바운드 동시 달성", "category": "impact"})
            
            fives = sum(1 for stat in [row['pts'], row['ast'], row['reb'], row['stl'], row['blk']] if stat >= 5)
            if fives >= 5:
                season_missions.append({"id": "swiss_army_knife", "name": "스위스 아미 나이프", "desc": "한 경기 5득점, 5리바, 5어시, 5스틸, 5블록 (5x5 달성)", "category": "impact"})

            if row['stl'] >= 8:
                season_missions.append({"id": "king_of_thieves", "name": "도둑의 제왕", "desc": "한 경기 스틸 8개 이상 달성", "category": "impact"})
            if row['blk'] >= 7:
                season_missions.append({"id": "swat_team", "name": "SWAT 팀장", "desc": "한 경기 블록슛 7개 이상 달성", "category": "impact"})
            if row['ft_a'] >= 10 and row['ft'] == row['ft_a']:
                season_missions.append({"id": "ft_master", "name": "강심장 (자유투 마스터)", "desc": "한 경기 자유투 10개 이상 시도하여 100% 성공", "category": "impact"})
            if row['pts'] == 0 and (row['reb'] + row['ast'] + row['stl'] + row['blk']) >= 15:
                season_missions.append({"id": "unsung_hero", "name": "언성 히어로", "desc": "무득점이지만 리바운드+어시스트+스틸+블록 합산 15개 이상", "category": "bench"})
            if row['total_min'] >= 40 and row['foul'] <= 1:
                season_missions.append({"id": "workhorse", "name": "마당쇠", "desc": "연장전 없이 40분 풀타임 출전하여 파울 1개 이하", "category": "bench"})
            if row['threep_a'] >= 10 and (row['threep'] / row['threep_a']) < 0.1:
                season_missions.append({"id": "brick_layer", "name": "벽돌공", "desc": "한 경기 3점슛 10개 이상 시도하여 성공률 10% 미만", "category": "easter_egg"})
            if row['tov'] >= 8:
                season_missions.append({"id": "turnover_machine", "name": "턴오버 자판기", "desc": "한 경기 턴오버 8개 이상 기록", "category": "easter_egg"})
            if row['total_min'] < 10 and row['foul'] >= 5:
                season_missions.append({"id": "foul_trouble", "name": "파울 트러블러", "desc": "10분 미만 출전하여 5반칙 퇴장", "category": "easter_egg"})
                
            if 5 <= row['blk'] < 7: season_missions.append({"id": "wailing_wall", "name": "통곡의 벽", "desc": "한 경기 5블록 이상", "category": "impact"})
            if tens >= 3: season_missions.append({"id": "triple_double", "name": "트리플 더블", "desc": "트리플 더블 달성", "category": "impact"})
            if row['pts'] >= 30:
                bomber_streak += 1
                if bomber_streak >= 3: season_missions.append({"id": "bomber", "name": "폭격기", "desc": "3경기 연속 30득점 이상 달성", "category": "impact"})
            else: bomber_streak = 0
            
            if row['total_min'] <= 15 and row['pts'] >= 10: season_missions.append({"id": "scene_stealer", "name": "씬 스틸러", "desc": "15분 이하 출전 10득점 이상", "category": "bench"})
            if 10 <= row['total_min'] <= 15 and row['foul'] >= 5: season_missions.append({"id": "sacrificial_lamb", "name": "아름다운 희생", "desc": "15분 이하 출전 후 5반칙 퇴장", "category": "bench"})
            if row['total_min'] >= 15 and row['pts'] == 0 and row['reb'] == 0 and row['ast'] == 0 and row['stl'] == 0 and row['blk'] == 0:
                season_missions.append({"id": "invisible_man", "name": "투명 인간", "desc": "15분 이상 출전, 모든 1차 스탯 0", "category": "easter_egg"})
            if row['pts'] == 0 and row['ast'] >= 10: season_missions.append({"id": "giving_tree", "name": "아낌없이 주는 나무", "desc": "무득점 10어시스트 이상 달성", "category": "easter_egg"})
            if row['ft_a'] >= 4 and row['ft'] == 0: season_missions.append({"id": "unforgiving_rim", "name": "자비 없는 림", "desc": "한 경기 자유투 4구 이상 시도 0개 성공", "category": "easter_egg"})
            if 30 <= row['total_min'] < 40 and row['foul'] == 0: season_missions.append({"id": "pacifist", "name": "평화주의자", "desc": "30분 이상 출전, 파울 0개", "category": "easter_egg"})
            if row['threep'] >= 7: season_missions.append({"id": "perimeter_sniper", "name": "외곽의 저격수", "desc": "한 경기 3점슛 7개 이상 성공", "category": "impact"})
            if 6 <= row['stl'] < 8: season_missions.append({"id": "hawk_eye", "name": "매의 눈", "desc": "한 경기 스틸 6개 이상", "category": "impact"})
            if row['reb'] >= 15 and row['pts'] < 20: season_missions.append({"id": "backboard_destroyer", "name": "백보드 파괴자", "desc": "한 경기 리바운드 15개 이상 달성", "category": "impact"})
            if row['pts'] >= 15 and row['fg_a'] > 0 and row['fg'] == row['fg_a']: season_missions.append({"id": "perfectionist", "name": "완벽주의자", "desc": "야투 성공률 100%로 15득점 이상 달성", "category": "impact"})
            if row['ast'] >= 10 and row['tov'] == 0: season_missions.append({"id": "maestro", "name": "마에스트로", "desc": "무실책 10어시스트 이상 달성", "category": "impact"})
            if row['fg_a'] >= 15 and (row['fg'] / row['fg_a']) < 0.2: season_missions.append({"id": "black_hole", "name": "블랙홀", "desc": "야투율 20% 미만으로 야투 15개 이상 시도", "category": "easter_egg"})
            if row['ft_a'] >= 5 and row['ft'] == 0: season_missions.append({"id": "ft_phobia", "name": "자유투 공포증", "desc": "한 경기 자유투 5개 이상 시도하여 0구 성공", "category": "easter_egg"})

        if double_doubles >= 20: season_missions.append({"id": "double_double_machine_gold", "name": "더블 더블 머신 (Gold)", "desc": "시즌 20회 더블더블 달성", "category": "milestone"})
        elif double_doubles >= 10: season_missions.append({"id": "double_double_machine_silver", "name": "더블 더블 머신 (Silver)", "desc": "시즌 10회 더블더블 달성", "category": "milestone"})
        elif double_doubles >= 5: season_missions.append({"id": "double_double_machine_bronze", "name": "더블 더블 머신 (Bronze)", "desc": "시즌 5회 더블더블 달성", "category": "milestone"})
            
        fg_pct = group['fg'].sum() / max(1, group['fg_a'].sum())
        three_pct = group['threep'].sum() / max(1, group['threep_a'].sum())
        ft_pct = group['ft'].sum() / max(1, group['ft_a'].sum())
        if games_played >= 27 and fg_pct >= 0.50 and three_pct >= 0.40 and ft_pct >= 0.90 and group['fg_a'].sum() > 100:
            season_missions.append({"id": "club_180", "name": "180 클럽", "desc": "야투 50%, 3점슛 40%, 자유투 90% 동시 달성", "category": "milestone"})

        iron_man_streak = 0; max_iron_man_streak = 0
        for _, row in group.iterrows():
            if row['total_min'] >= 20: iron_man_streak += 1; max_iron_man_streak = max(max_iron_man_streak, iron_man_streak)
            else: iron_man_streak = 0
        if max_iron_man_streak >= 30: season_missions.append({"id": "iron_man", "name": "철인", "desc": "30경기 연속 20분 이상 출장", "category": "milestone"})
        if games_played >= 54 and group['total_min'].mean() >= 30: season_missions.append({"id": "man_of_steel", "name": "강철 체력", "desc": "시즌 54경기 출장 및 평균 30분 이상 출전", "category": "milestone"})
        if group['blk'].sum() >= 60: season_missions.append({"id": "block_machine", "name": "블록 머신", "desc": "시즌 누적 블록슛 60개 이상 달성", "category": "milestone"})
        
        unique_missions = { a['id']: a for a in season_missions }.values()
        
        output[pcode]["seasons"][season_name] = {
            "stacks": season_stacks,
            "missions": list(unique_missions)
        }

    out_real = os.path.join(os.path.dirname(__file__), OUT_PATH)
    os.makedirs(os.path.dirname(out_real), exist_ok=True)
    with open(out_real, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"[SUCCESS] Generated matrix achievements data at {out_real}")

if __name__ == "__main__":
    get_achievement_data()
