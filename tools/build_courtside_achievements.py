import sqlite3
import pandas as pd
import json
import os

DB_PATH = '../raw/kbl_realdata.db'

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
    
    # 시즌별로 그룹화
    for (pcode, season_name), group in df.groupby(['pcode', 'season_name']):
        name = group['name'].iloc[0]
        if str(pcode) not in achievements:
            achievements[str(pcode)] = {
                "name": name,
                "seasons": {}
            }
        
        season_achievements = []
        
        # 1. 누적 퀘스트 계산
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

        # 2. 임팩트 퀘스트 & 이스터 에그 (개별 경기 로그 분석)
        for _, row in group.iterrows():
            # 통곡의 벽
            if row['blk'] >= 5:
                season_achievements.append({"id": "wailing_wall", "name": "통곡의 벽", "desc": "한 경기 5블록 이상", "category": "impact"})
            
            # 트리플 더블
            tens = sum(1 for stat in [row['pts'], row['ast'], row['reb'], row['stl'], row['blk']] if stat >= 10)
            if tens >= 3:
                 season_achievements.append({"id": "triple_double", "name": "트리플 더블", "desc": "트리플 더블 달성", "category": "impact"})
                 
            # 씬 스틸러 (15분 이하 출전, 10점 이상)
            if row['total_min'] > 0 and row['total_min'] <= 15 and row['pts'] >= 10:
                season_achievements.append({"id": "scene_stealer", "name": "씬 스틸러", "desc": "15분 이하 출전 10득점 이상", "category": "bench"})
                
            # 아름다운 희생 (15분 이하 출전 5반칙)
            if row['total_min'] > 0 and row['total_min'] <= 15 and row['foul'] >= 5:
                 season_achievements.append({"id": "sacrificial_lamb", "name": "아름다운 희생", "desc": "15분 이하 출전 후 5반칙 퇴장", "category": "bench"})

            # 이스터 에그: 투명 인간 (Tony Snell Club)
            if row['total_min'] >= 15 and row['pts'] == 0 and row['reb'] == 0 and row['ast'] == 0 and row['stl'] == 0 and row['blk'] == 0 and row['tov'] == 0 and row['foul'] == 0:
                season_achievements.append({"id": "invisible_man", "name": "투명 인간", "desc": "15분 이상 출전, 모든 1차 스탯 0", "category": "easter_egg"})
                
            # 아낌없이 주는 나무 (0득점 10+어시스트)
            if row['pts'] == 0 and row['ast'] >= 10:
                season_achievements.append({"id": "giving_tree", "name": "아낌없이 주는 나무", "desc": "무득점 10어시스트 이상 달성", "category": "easter_egg"})
                
            # 자비 없는 림 (연속은 DB 로그상 어려우므로 한경기 자유투 0/4 이상으로 대체)
            if row['ft_a'] >= 4 and row['ft'] == 0:
                season_achievements.append({"id": "unforgiving_rim", "name": "자비 없는 림", "desc": "한 경기 자유투 4구 이상 시도 0개 성공", "category": "easter_egg"})
                
            # 평화주의자 (30분 이상 무파울)
            if row['total_min'] >= 30 and row['foul'] == 0:
                 season_achievements.append({"id": "pacifist", "name": "평화주의자", "desc": "30분 이상 출전, 파울 0개", "category": "easter_egg"})
        
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
