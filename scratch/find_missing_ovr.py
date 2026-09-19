import json

def run():
    with open('courtside-web/lib/preseason_rosters.json', encoding='utf-8') as f:
        rosters = json.load(f)
        
    with open('courtside-web/lib/courtside_ovr_history.json', encoding='utf-8') as f:
        ovr_history = json.load(f)
        
    ovr_pcodes = {x['pcode'] for x in ovr_history}
    
    missing_players = []
    for team in rosters:
        for p in team['players']:
            # Pcode may be missing for new players, or if they have a pcode, it's not in ovr_pcodes
            if 'pcode' not in p or p['pcode'] not in ovr_pcodes:
                missing_players.append(p)
                
    for p in missing_players:
        print(f"{p['name']} ({p.get('pcode', 'No Pcode')}): {p.get('role', 'N/A')}")
        
if __name__ == '__main__':
    run()
