"""2025-2026 챔피언결정전 준우승 오귀속 정정 - 일회성 수동 패치.

배경: tools/fix_awards_data.py의 하드코딩 표(legacy 소스 기반)에 2025-26 준우승이
"창원 LG 세이커스"로 잘못 적혀 있었다(정정 커밋 참고). raw/kbl_realdata.db의 실제
2025-2026 챔피언결정전 게임 로그(S47G04N1~5)로 확인한 진짜 결과: KCC(tcode 60) 4승,
소노(tcode 66) 1승 - KCC 우승/소노 준우승. LG는 그 시리즈에 한 경기도 없었다(정규리그
2위는 맞지만 챔피언결정전 진출 자체가 아님).

fix_awards_data.py의 fix()는 courtside_awards.json 전체를 legacy 소스에서 다시 생성하는
전체 갱신이라, 재실행하면 add_national_team_awards.py 등 다른 스크립트가 채운 nt_*/
정규 시상 데이터가 다 날아간다 - 그래서 여기선 이 특정 항목만 직접 patch한다.

멱등적으로 짜서 두 번 돌려도 안전하다(이미 정정됐으면 아무것도 안 바꿈).
"""
import json
import os
import sqlite3

AWARDS_PATH = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_awards.json')
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'raw', 'kbl_realdata.db')
SEASON = '2025-2026'
WRONG_TCODE = '50'   # 창원 LG
RIGHT_TCODE = '66'   # 고양 소노


def roster(conn, tcode):
    rows = conn.execute(
        "SELECT DISTINCT gps.pcode, gps.pname FROM player_game_stats gps JOIN games g ON gps.gmkey=g.gmkey"
        " WHERE g.season_name=? AND gps.tcode=?", (SEASON, tcode)
    ).fetchall()
    return {pcode: pname for pcode, pname in rows}


def remove_runner_up(awards_list, season):
    """해당 award 리스트에서 runner_up의 season 연도 하나만 제거. 그 결과 years가 비면
    award 자체를 드롭. 리스트가 통째로 비면 True 반환(호출부에서 pcode 키 삭제용)."""
    out = []
    for a in awards_list:
        if a.get('id') == 'runner_up' and season in a.get('years', []):
            years = [y for y in a['years'] if y != season]
            if years:
                out.append({**a, 'years': years, 'count': len(years)})
            # years가 비면 이 award 자체를 안 넣음(드롭)
        else:
            out.append(a)
    return out


def add_runner_up(awards_list, season):
    for a in awards_list:
        if a.get('id') == 'runner_up':
            if season not in a['years']:
                a['years'] = a['years'] + [season]
                a['count'] = len(a['years'])
            return awards_list
    awards_list.append({
        'id': 'runner_up', 'name': '챔피언결정전 준우승',
        'count': 1, 'years': [season],
    })
    return awards_list


def patch():
    conn = sqlite3.connect(DB_PATH)
    lg_roster = roster(conn, WRONG_TCODE)
    sono_roster = roster(conn, RIGHT_TCODE)
    conn.close()

    with open(AWARDS_PATH, encoding='utf-8') as f:
        awards = json.load(f)

    removed, added = 0, 0

    for pcode in lg_roster:
        if pcode in awards:
            before = awards[pcode]
            after = remove_runner_up(before, SEASON)
            if after != before:
                removed += 1
            if after:
                awards[pcode] = after
            else:
                del awards[pcode]

    for pcode, pname in sono_roster.items():
        entry = awards.get(pcode, [])
        before_len = len(entry)
        before_years = next((a['years'][:] for a in entry if a.get('id') == 'runner_up'), None)
        entry = add_runner_up(entry, SEASON)
        awards[pcode] = entry
        after_years = next((a['years'] for a in entry if a.get('id') == 'runner_up'), None)
        if before_years != after_years:
            added += 1

    with open(AWARDS_PATH, 'w', encoding='utf-8') as f:
        json.dump(awards, f, ensure_ascii=False, indent=2)

    print(f"[SUCCESS] LG {removed}명 준우승 제거, 소노 {added}명 준우승 추가 -> {AWARDS_PATH}")


if __name__ == '__main__':
    patch()
