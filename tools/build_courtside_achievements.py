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
    'threep': [50, 100, 300, 500, 1000]
}

def generate_career_quests(total_pts, total_reb, total_ast, total_threep):
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

    process_milestones('pts', total_pts, CAREER_MILESTONES['pts'], '득점')
    process_milestones('reb', total_reb, CAREER_MILESTONES['reb'], '리바운드')
    process_milestones('ast', total_ast, CAREER_MILESTONES['ast'], '어시스트')
    process_milestones('threep', total_threep, CAREER_MILESTONES['threep'], '3점슛')
    
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

    achievements = {}
    
    # 1. 선수별 통산 누적 스탯 먼저 계산
    career_totals = df.groupby('pcode').agg({
        'pts': 'sum',
        'reb': 'sum',
        'ast': 'sum',
        'threep': 'sum'
    }).to_dict(orient='index')

    # 시즌별로 그룹화
    for (pcode, season_name), group in df.groupby(['pcode', 'season_name']):
        name = group['name'].iloc[0]
        
        if str(pcode) not in achievements:
            c_totals = career_totals.get(pcode, {'pts': 0, 'reb': 0, 'ast': 0, 'threep': 0})
            achievements[str(pcode)] = {
                "name": name,
                "career_quests": generate_career_quests(c_totals['pts'], c_totals['reb'], c_totals['ast'], c_totals['threep']),
                "seasons": {}
            }
        
        season_achievements = []
        
        # 2. 누적 퀘스트 (시즌용 유지)
        games_played = len(group)
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

        # 철인 (결장 없이 출전, 여기서는 임시로 시즌 54경기로 산정하지만 간이로 30경기 연속 20분 이상)
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

        # 단일 경기 임팩트
        bomber_streak = 0
        for _, row in group.iterrows():
            # 통곡의 벽
            if row['blk'] >= 5:
                season_achievements.append({"id": "wailing_wall", "name": "통곡의 벽", "desc": "한 경기 5블록 이상", "category": "impact"})
                
            # 트리플 더블
            tens = sum(1 for stat in [row['pts'], row['ast'], row['reb'], row['stl'], row['blk']] if stat >= 10)
            if tens >= 3:
                season_achievements.append({"id": "triple_double", "name": "트리플 더블", "desc": "트리플 더블 달성", "category": "impact"})
                
            # 폭격기 (3경기 연속 30득점)
            if row['pts'] >= 30:
                bomber_streak += 1
                if bomber_streak >= 3:
                    season_achievements.append({"id": "bomber", "name": "폭격기", "desc": "3경기 연속 30득점 이상 달성", "category": "impact"})
            else:
                bomber_streak = 0
                
            # 벤치 (15분 이하 출전 10득점 이상)
            if row['total_min'] <= 15 and row['pts'] >= 10:
                season_achievements.append({"id": "scene_stealer", "name": "씬 스틸러", "desc": "15분 이하 출전 10득점 이상", "category": "bench"})
                
            # 아름다운 희생 (15분 이하 5반칙)
            if row['total_min'] <= 15 and row['foul'] >= 5:
                season_achievements.append({"id": "sacrificial_lamb", "name": "아름다운 희생", "desc": "15분 이하 출전 후 5반칙 퇴장", "category": "bench"})
                
            # 투명인간
            if row['total_min'] >= 15 and row['pts'] == 0 and row['reb'] == 0 and row['ast'] == 0 and row['stl'] == 0 and row['blk'] == 0:
                season_achievements.append({"id": "invisible_man", "name": "투명 인간", "desc": "15분 이상 출전, 모든 1차 스탯 0", "category": "easter_egg"})
                
            # 아낌없이 주는 나무
            if row['pts'] == 0 and row['ast'] >= 10:
                season_achievements.append({"id": "giving_tree", "name": "아낌없이 주는 나무", "desc": "무득점 10어시스트 이상 달성", "category": "easter_egg"})
                
            # 자비 없는 림
            if row['ft_a'] >= 4 and row['ft'] == 0:
                season_achievements.append({"id": "unforgiving_rim", "name": "자비 없는 림", "desc": "한 경기 자유투 4구 이상 시도 0개 성공", "category": "easter_egg"})
                
            # 평화주의자
            if row['total_min'] >= 30 and row['foul'] == 0:
                 season_achievements.append({"id": "pacifist", "name": "평화주의자", "desc": "30분 이상 출전, 파울 0개", "category": "easter_egg"})
                 
            # 외곽의 저격수
            if row['threep'] >= 7:
                 season_achievements.append({"id": "perimeter_sniper", "name": "외곽의 저격수", "desc": "한 경기 3점슛 7개 이상 성공", "category": "impact"})
                 
            # 매의 눈
            if row['stl'] >= 6:
                 season_achievements.append({"id": "hawk_eye", "name": "매의 눈", "desc": "한 경기 스틸 6개 이상", "category": "impact"})
                 
            # 백보드 파괴자
            if row['reb'] >= 15:
                 season_achievements.append({"id": "backboard_destroyer", "name": "백보드 파괴자", "desc": "한 경기 리바운드 15개 이상 달성", "category": "impact"})
                 
            # 완벽주의자
            if row['pts'] >= 15 and row['fg_a'] > 0 and row['fg'] == row['fg_a']:
                 season_achievements.append({"id": "perfectionist", "name": "완벽주의자", "desc": "야투 성공률 100%로 15득점 이상 달성", "category": "impact"})
                 
            # 마에스트로
            if row['ast'] >= 10 and row['tov'] == 0:
                 season_achievements.append({"id": "maestro", "name": "마에스트로", "desc": "무실책 10어시스트 이상 달성", "category": "impact"})
                 
            # 블랙홀
            if row['fg_a'] >= 15 and (row['fg'] / row['fg_a']) < 0.2:
                 season_achievements.append({"id": "black_hole", "name": "블랙홀", "desc": "야투율 20% 미만으로 야투 15개 이상 시도", "category": "easter_egg"})
                 
            # 자유투 공포증
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
