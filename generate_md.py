import pandas as pd

df = pd.read_csv("om_stats_formatted.csv")

md = "# KBL 컵대회/오픈매치 외국인 및 아시아쿼터 활약상 정리 (9/20 ~ 9/29)\n\n"
md += "각 구단별로 컵대회(또는 오픈매치)에서 출전한 주요 용병 및 아시아쿼터 선수들의 성적입니다.\n\n"

for team in df['team'].unique():
    md += f"## {team}\n"
    team_df = df[df['team'] == team]
    
    # generate table
    cols = ['pname', 'games', 'mins', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg', 'fga', 'threep', 'threepa', 'netrtg']
    
    table_header = "| 선수명 | 경기 | 출전(분) | 득점 | 리바 | 어시 | 스틸 | 블록 | 턴오버 | 2점(성공/시도) | 3점(성공/시도) | NetRtg |\n"
    table_header += "|---|---|---|---|---|---|---|---|---|---|---|---|\n"
    md += table_header
    
    for _, row in team_df.iterrows():
        pname = row['pname']
        games = row['games']
        mins = f"{row['mins']:.1f}"
        pts = f"{row['pts']:.1f}"
        reb = f"{row['reb']:.1f}"
        ast = f"{row['ast']:.1f}"
        stl = f"{row['stl']:.1f}"
        blk = f"{row['blk']:.1f}"
        tov = f"{row['tov']:.1f}"
        fg = f"{row['fg']:.1f}/{row['fga']:.1f}"
        threep = f"{row['threep']:.1f}/{row['threepa']:.1f}"
        netrtg = f"{row['netrtg']:.1f}"
        
        md += f"| {pname} | {games} | {mins} | {pts} | {reb} | {ast} | {stl} | {blk} | {tov} | {fg} | {threep} | {netrtg} |\n"
        
    md += "\n"

with open("om_stats_report.md", "w", encoding='utf-8') as f:
    f.write(md)

print("Generated om_stats_report.md")
