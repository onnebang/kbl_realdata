import sqlite3
import pandas as pd
import json
import os

DB_PATH = '../raw/kbl_realdata.db'

# Quest Configurations
CAREER_MILESTONES = {
    'pts': [100, 500, 1000, 2000, 3000, 5000, 7000, 10000],
    'reb': [100, 500, 1000, 2000, 3000, 5000],
    'ast': [100, 500, 1000, 2000, 3000, 5000],
    'threep': [50, 100, 300, 500, 1000],
    'stl': [100, 300, 500, 1000, 1500],
    'blk': [100, 300, 500, 1000],
    'gp': [100, 300, 500, 700, 1000]
}

def generate_career_quests(stats_dict):
    quests = []
    
    def process_milestones(stat_type, current_val, thresholds, name_prefix):
        for target in thresholds:
            completed = current_val >= target
            quests.append({
                "id": f"{stat_type}_{target}",
                "type": stat_type,
                "name": f"{target:,} {name_prefix} 달성",
                "current": int(current_val),
                "target": target,
                "completed": completed
            })
            if not completed:
                # Only show up to the FIRST uncompleted quest per stat
                break

    process_milestones('pts', stats_dict.get('pts', 0), CAREER_MILESTONES['pts'], '득점')
    process_milestones('reb', stats_dict.get('reb', 0), CAREER_MILESTONES['reb'], '리바운드')
    process_milestones('ast', stats_dict.get('ast', 0), CAREER_MILESTONES['ast'], '어시스트')
    process_milestones('threep', stats_dict.get('threep', 0), CAREER_MILESTONES['threep'], '3점슛')
    process_milestones('stl', stats_dict.get('stl', 0), CAREER_MILESTONES['stl'], '스틸')
    process_milestones('blk', stats_dict.get('blk', 0), CAREER_MILESTONES['blk'], '블록')
    process_milestones('gp', stats_dict.get('gp', 0), CAREER_MILESTONES['gp'], '경기 출장')
    
    return quests

def get_achievement_data():
    real_db_path = os.path.join(os.path.dirname(__file__), DB_PATH)
    if not os.path.exists(real_db_path):
        print(f"Error: DB not found at {real_db_path}")
        return

    conn = sqlite3.connect(real_db_path)
    
    # 경기 로그 조회
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
        gps.fg, gps.fg_a, gps.threep, gps.threep_a, gps.ft, gps.ft_a,
        g.home_score, g.away_score, gps.tcode, g.home_name, g.away_name
    FROM player_game_stats gps
    JOIN games g ON gps.gmkey = g.gmkey
    JOIN (SELECT DISTINCT pcode, pname FROM player_game_stats) p ON gps.pcode = p.pcode
    WHERE g.season_category = '정규시즌'
    ORDER BY g.game_date ASC
    """
    
    try:
        df = pd.read_sql_query(query, conn)
    except Exception as e:
        print(f"DB Query failed: {e}")
        conn.close()
        return

    conn.close()
    
    df['total_min'] = df['play_min'] + df['play_sec'] / 60.0

    # 1. 선수별 통산 누적 스탯 및 출장 경기 수(GP) 계산
    # count() on gmkey gives Games Played
    career_totals = df.groupby('pcode').agg({
        'pts': 'sum',
        'reb': 'sum',
        'ast': 'sum',
        'threep': 'sum',
        'stl': 'sum',
        'blk': 'sum',
        'gmkey': 'count' # This is GP
    }).rename(columns={'gmkey': 'gp'})
    
    # 2. 랭킹 계산 (All-Time)
    stat_cols = ['pts', 'reb', 'ast', 'threep', 'stl', 'blk', 'gp']
    for col in stat_cols:
        career_totals[f"{col}_all_time_rank"] = career_totals[col].rank(method='min', ascending=False).astype(int)

    # 3. 랭킹 계산 (Active)
    # Find latest season in DB
    latest_season = df['season_name'].max()
    # Find players who played in the latest season
    active_pcodes = df[df['season_name'] == latest_season]['pcode'].unique()
    
    active_totals = career_totals[career_totals.index.isin(active_pcodes)].copy()
    for col in stat_cols:
        active_totals[f"{col}_active_rank"] = active_totals[col].rank(method='min', ascending=False).astype(int)
        # map back to career_totals
        career_totals.loc[active_totals.index, f"{col}_active_rank"] = active_totals[f"{col}_active_rank"]

    # Fill NaN for non-active players with None
    career_totals_dict = career_totals.to_dict(orient='index')

    achievements = {}
    
    # 시즌별로 그룹화하여 시즌 미션 업적 계산
    for (pcode, season_name), group in df.groupby(['pcode', 'season_name']):
        name = group['name'].iloc[0]
        
        if str(pcode) not in achievements:
            c_totals = career_totals_dict.get(pcode, {})
            
            ranks = {}
            for col in stat_cols:
                ranks[col] = {
                    "all_time": int(c_totals.get(f"{col}_all_time_rank", 0)),
                    "active": int(c_totals.get(f"{col}_active_rank")) if pd.notna(c_totals.get(f"{col}_active_rank")) else None
                }

            achievements[str(pcode)] = {
                "name": name,
                "ranks": ranks,
                "career_quests": generate_career_quests(c_totals),
                "seasons": {}
            }
        
        season_achievements = []
        games_played = len(group)
        
        # 더블더블 카운트
        double_doubles = 0
        for _, row in group.iterrows():
            tens = sum(1 for stat in [row['pts'], row['ast'], row['reb'], row['stl'], row['blk']] if stat >= 10)
            if tens >= 2:
                double_doubles += 1
                
        if double_doubles >= 20:
            season_achievements.append({"id": "double_double_machine_gold", "name": "더블 더블 머신 (Gold)", "desc": "시즌 20회 더블더블 달성", "category": "milestone"})
        elif double_doubles >= 10:
            season_achievements.append({"id": "double_double_machine_silver", "name": "더블 더블 머신 (Silver)", "desc": "시즌 10회 더블더블 달성", "category": "milestone"})
        elif double_doubles >= 5:
            season_achievements.append({"id": "double_double_machine_bronze", "name": "더블 더블 머신 (Bronze)", "desc": "시즌 5회 더블더블 달성", "category": "milestone"})
            
        # 180 클럽 (50-40-90)
        fg_pct = group['fg'].sum() / max(1, group['fg_a'].sum())
        three_pct = group['threep'].sum() / max(1, group['threep_a'].sum())
        ft_pct = group['ft'].sum() / max(1, group['ft_a'].sum())
        if games_played >= 27 and fg_pct >= 0.50 and three_pct >= 0.40 and ft_pct >= 0.90 and group['fg_a'].sum() > 100:
            season_achievements.append({"id": "club_180", "name": "180 클럽", "desc": "야투 50%, 3점슛 40%, 자유투 90% 동시 달성", "category": "milestone"})

        # 철인 (결장 없이 출전, 30경기 연속 20분 이상)
        iron_man_streak = 0
        max_iron_man_streak = 0
        for _, row in group.iterrows():
            if row['total_min'] >= 20:
                iron_man_streak += 1
                max_iron_man_streak = max(max_iron_man_streak, iron_man_streak)
            else:
                iron_man_streak = 0
        if max_iron_man_streak >= 30:
             season_achievements.append({"id": "iron_man", "name": "철인", "desc": "30경기 연속 20분 이상 출장", "category": "milestone"})
             
        # 강철 체력 (시즌 54경기 전경기 출장 및 평균 30분 이상 출전)
        if games_played >= 54 and group['total_min'].mean() >= 30:
             season_achievements.append({"id": "man_of_steel", "name": "강철 체력", "desc": "시즌 54경기 출장 및 평균 30분 이상 출전", "category": "milestone"})
             
        # 블록 머신 (시즌 60블록 이상)
        if group['blk'].sum() >= 60:
             season_achievements.append({"id": "block_machine", "name": "블록 머신", "desc": "시즌 누적 블록슛 60개 이상 달성", "category": "milestone"})

        # 단일 경기 임팩트 미션
        bomber_streak = 0
        for _, row in group.iterrows():
            tens = sum(1 for stat in [row['pts'], row['ast'], row['reb'], row['stl'], row['blk']] if stat >= 10)
            
            # 신규: 20-20 클럽
            if row['pts'] >= 20 and row['reb'] >= 20:
                season_achievements.append({"id": "club_20_20", "name": "20-20 클럽", "desc": "한 경기 20득점 & 20리바운드 동시 달성", "category": "impact"})
                
            # 신규: 스위스 아미 나이프 (5x5)
            fives = sum(1 for stat in [row['pts'], row['ast'], row['reb'], row['stl'], row['blk']] if stat >= 5)
            if fives >= 5:
                season_achievements.append({"id": "swiss_army_knife", "name": "스위스 아미 나이프", "desc": "한 경기 5득점, 5리바, 5어시, 5스틸, 5블록 (5x5 달성)", "category": "impact"})

            # 신규: 도둑의 제왕
            if row['stl'] >= 8:
                season_achievements.append({"id": "king_of_thieves", "name": "도둑의 제왕", "desc": "한 경기 스틸 8개 이상 달성", "category": "impact"})
                
            # 신규: SWAT 팀장
            if row['blk'] >= 7:
                season_achievements.append({"id": "swat_team", "name": "SWAT 팀장", "desc": "한 경기 블록슛 7개 이상 달성", "category": "impact"})

            # 신규: 자유투 마스터 (강심장)
            if row['ft_a'] >= 10 and row['ft'] == row['ft_a']:
                season_achievements.append({"id": "ft_master", "name": "강심장 (자유투 마스터)", "desc": "한 경기 자유투 10개 이상 시도하여 100% 성공", "category": "impact"})

            # 신규: 언성 히어로
            if row['pts'] == 0 and (row['reb'] + row['ast'] + row['stl'] + row['blk']) >= 15:
                season_achievements.append({"id": "unsung_hero", "name": "언성 히어로", "desc": "무득점이지만 리바운드+어시스트+스틸+블록 합산 15개 이상", "category": "bench"})

            # 신규: 마당쇠
            if row['total_min'] >= 40 and row['foul'] <= 1:
                season_achievements.append({"id": "workhorse", "name": "마당쇠", "desc": "연장전 없이 40분 풀타임 출전하여 파울 1개 이하", "category": "bench"})
                
            # 신규: 벽돌공
            if row['threep_a'] >= 10 and (row['threep'] / row['threep_a']) < 0.1:
                season_achievements.append({"id": "brick_layer", "name": "벽돌공", "desc": "한 경기 3점슛 10개 이상 시도하여 성공률 10% 미만", "category": "easter_egg"})
                
            # 신규: 턴오버 자판기
            if row['tov'] >= 8:
                season_achievements.append({"id": "turnover_machine", "name": "턴오버 자판기", "desc": "한 경기 턴오버 8개 이상 기록", "category": "easter_egg"})
                
            # 신규: 파울 트러블러
            if row['total_min'] < 10 and row['foul'] >= 5:
                season_achievements.append({"id": "foul_trouble", "name": "파울 트러블러", "desc": "10분 미만 출전하여 5반칙 퇴장", "category": "easter_egg"})

            # 기존 미션들
            if row['blk'] >= 5 and row['blk'] < 7: # 중복방지
                season_achievements.append({"id": "wailing_wall", "name": "통곡의 벽", "desc": "한 경기 5블록 이상", "category": "impact"})
                
            if tens >= 3:
                season_achievements.append({"id": "triple_double", "name": "트리플 더블", "desc": "트리플 더블 달성", "category": "impact"})
                
            if row['pts'] >= 30:
                bomber_streak += 1
                if bomber_streak >= 3:
                    season_achievements.append({"id": "bomber", "name": "폭격기", "desc": "3경기 연속 30득점 이상 달성", "category": "impact"})
            else:
                bomber_streak = 0
                
            if row['total_min'] <= 15 and row['pts'] >= 10:
                season_achievements.append({"id": "scene_stealer", "name": "씬 스틸러", "desc": "15분 이하 출전 10득점 이상", "category": "bench"})
                
            if row['total_min'] <= 15 and row['foul'] >= 5 and row['total_min'] >= 10:
                season_achievements.append({"id": "sacrificial_lamb", "name": "아름다운 희생", "desc": "15분 이하 출전 후 5반칙 퇴장", "category": "bench"})
                
            if row['total_min'] >= 15 and row['pts'] == 0 and row['reb'] == 0 and row['ast'] == 0 and row['stl'] == 0 and row['blk'] == 0:
                season_achievements.append({"id": "invisible_man", "name": "투명 인간", "desc": "15분 이상 출전, 모든 1차 스탯 0", "category": "easter_egg"})
                
            if row['pts'] == 0 and row['ast'] >= 10:
                season_achievements.append({"id": "giving_tree", "name": "아낌없이 주는 나무", "desc": "무득점 10어시스트 이상 달성", "category": "easter_egg"})
                
            if row['ft_a'] >= 4 and row['ft'] == 0:
                season_achievements.append({"id": "unforgiving_rim", "name": "자비 없는 림", "desc": "한 경기 자유투 4구 이상 시도 0개 성공", "category": "easter_egg"})
                
            if row['total_min'] >= 30 and row['foul'] == 0 and row['total_min'] < 40:
                 season_achievements.append({"id": "pacifist", "name": "평화주의자", "desc": "30분 이상 출전, 파울 0개", "category": "easter_egg"})
                 
            if row['threep'] >= 7:
                 season_achievements.append({"id": "perimeter_sniper", "name": "외곽의 저격수", "desc": "한 경기 3점슛 7개 이상 성공", "category": "impact"})
                 
            if row['stl'] >= 6 and row['stl'] < 8:
                 season_achievements.append({"id": "hawk_eye", "name": "매의 눈", "desc": "한 경기 스틸 6개 이상", "category": "impact"})
                 
            if row['reb'] >= 15 and row['pts'] < 20:
                 season_achievements.append({"id": "backboard_destroyer", "name": "백보드 파괴자", "desc": "한 경기 리바운드 15개 이상 달성", "category": "impact"})
                 
            if row['pts'] >= 15 and row['fg_a'] > 0 and row['fg'] == row['fg_a']:
                 season_achievements.append({"id": "perfectionist", "name": "완벽주의자", "desc": "야투 성공률 100%로 15득점 이상 달성", "category": "impact"})
                 
            if row['ast'] >= 10 and row['tov'] == 0:
                 season_achievements.append({"id": "maestro", "name": "마에스트로", "desc": "무실책 10어시스트 이상 달성", "category": "impact"})
                 
            if row['fg_a'] >= 15 and (row['fg'] / row['fg_a']) < 0.2:
                 season_achievements.append({"id": "black_hole", "name": "블랙홀", "desc": "야투율 20% 미만으로 야투 15개 이상 시도", "category": "easter_egg"})
                 
            if row['ft_a'] >= 5 and row['ft'] == 0:
                 season_achievements.append({"id": "ft_phobia", "name": "자유투 공포증", "desc": "한 경기 자유투 5개 이상 시도하여 0구 성공", "category": "easter_egg"})
        
        # 중복 제거
        unique_achievements = { a['id']: a for a in season_achievements }.values()
        
        if unique_achievements:
            achievements[str(pcode)]["seasons"][season_name] = list(unique_achievements)

    OUT_PATH_REAL = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_achievements.json')
    os.makedirs(os.path.dirname(OUT_PATH_REAL), exist_ok=True)
    with open(OUT_PATH_REAL, 'w', encoding='utf-8') as f:
        json.dump(achievements, f, ensure_ascii=False, indent=2)

    print(f"[SUCCESS] Generated achievements data at {OUT_PATH_REAL}")

if __name__ == "__main__":
    get_achievement_data()
