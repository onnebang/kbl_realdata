"""국가대표 발탁 경력(nt_*)을 courtside_awards.json에 (재)생성한다.

명단 원본: 2026-09-22 사용자 제공(아시안게임 / 올림픽 최종예선 / FIBA 월드컵 / FIBA 아시아컵).
멱등 - 기존 nt_* 항목을 전부 지우고 아래 명단으로 다시 만든다(다른 수상 항목은 손대지 않음).

동명이인(이정현·이승현·김주성 등)은 이름만으로 첫 pcode를 고르면 두 선수의 경력이 섞인다
(add_awards_part*.py의 find_pcode가 그랬다). 여기선 raw DB에서 pcode별 출전 시즌·kbl540 카드의
출생연도로 후보를 좁히고, 그래도 둘 이상이면 통산 경기 수가 많은 쪽을 고르되 로그에 남긴다.
KBL 기록이 없는 선수(이현중·여준석 등)는 프로필 페이지가 없어 건너뛴다.
"""
import collections
import json
import os
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, '..', 'raw', 'kbl_realdata.db')
CARDS_PATH = os.path.join(HERE, '..', '..', 'kbl540', 'kbl540_players_public.json')
AWARDS_PATH = os.path.join(HERE, '..', 'courtside-web', 'lib', 'courtside_awards.json')

# 후보를 이름만으로 못 좁히는 경우의 수동 지정 - (이름, 대회 연도) -> pcode
OVERRIDES = {
    ('이정현', 2025): '291488',  # 소노(1999년생). 통산 경기 수로는 DB(1987년생)가 이겨서 고정
    ('이정현', 2026): '291488',
}

KINDS = {
    'nt_asian_games': ('AG 대표팀', 'Asian Games'),
    'nt_olympic': ('올림픽 대표팀', 'Olympic Qualifiers'),
    'nt_world_cup': ('월드컵 대표팀', 'World Cup'),
    'nt_asia_cup': ('아시아컵 대표팀', 'Asia Cup'),
}

# (kind, 연도) -> 명단. 연도는 대회 개최 연도(2022 항저우 AG는 2023년 개최지만 대회명 기준 2022).
ROSTERS = {
    ('nt_asian_games', 2026): '이정현 문유현 변준형 유기상 이현중 최준용 안영준 이우석 에디다니엘 여준석 이승현 장재석',
    ('nt_asian_games', 2022): '김선형 허훈 이우석 변준형 전성현 문성곤 양홍석 문정현 라건아 김종규 이승현 하윤기',
    ('nt_asian_games', 2018): '김선형 박찬희 최준용 허훈 허웅 전준범 이정현 라건아 김종규 이승현 강상재 허일영',
    ('nt_asian_games', 2014): '양동근 김선형 박찬희 김태술 조성민 양희종 문태종 허일영 김종규 이종현 오세근 이승현',
    ('nt_asian_games', 2010): '양동근 박찬희 이정석 조성민 양희종 이규섭 김성철 손규완 김주성 이승준 오세근 하승진',
    ('nt_asian_games', 2006): '김승현 양동근 신기성 방성윤 조상현 양희종 이규섭 서장훈 김주성 하승진 김민수 송영진',
    ('nt_olympic', 2021): '김낙현 이대성 변준형 전성현 문성곤 양홍석 이현중 라건아 강상재 이승현 송교창 여준석',
    ('nt_olympic', 2012): '양동근 김태술 김선형 박찬희 김동욱 이승준 윤호영 최진수 김주성 오세근 김종규 이종현',
    ('nt_olympic', 2008): '주희정 정영삼 이정석 방성윤 김동우 윤호영 강병현 김주성 하승진 이동준 오세근 최진수',
    ('nt_world_cup', 2019): '김선형 이대성 박찬희 허훈 양홍석 최준용 정효근 임동섭 라건아 김종규 이승현 강상재',
    ('nt_world_cup', 2014): '양동근 김선형 박찬희 김태술 조성민 양희종 문태종 허일영 김종규 이종현 오세근 이승현',
    # 김보배·이원석은 최종 12인이 아니라 "예선 및 훈련 명단" 발탁(사용자 명단의 ※ 주석). 이전 적재분에
    # 이미 들어 있었고 김보배는 build_courtside_ovr.py PROJECTION_REPUTATION_BOOST 근거이기도 해서 유지.
    ('nt_asia_cup', 2025): '이정현 유기상 양준석 변준형 안영준 신승민 문정현 에디다니엘 김종규 이승현 여준석 이현중 김보배 이원석',
    ('nt_asia_cup', 2022): '허훈 이우석 최준용 허웅 송교창 양홍석 강상재 라건아 김종규 장재석 이대헌',
    ('nt_asia_cup', 2017): '김선형 박찬희 허웅 최준용 이정현 임동섭 전준범 양홍석 이승현 김종규 이종현 오세근',
    ('nt_asia_cup', 2015): '김태술 이정현 박찬희 양동근 문성곤 최준용 조성민 문태영 강상재 김종규 이종현 이승현',
    ('nt_asia_cup', 2013): '김민구 김선형 양동근 김태술 문성곤 윤호영 조성민 김주성 김종규 최준용 이승준 이종현',
    ('nt_asia_cup', 2011): '박찬희 이정석 양동근 강병현 문태종 김영환 조성민 양희종 김주성 하승진 오세근 김종규',
    ('nt_asia_cup', 2009): '이정석 강병현 양동근 주희정 방성윤 이규섭 김주성 양희종 김민수 이동준 오세근 하승진',
    ('nt_asia_cup', 2007): '신기성 양동근 강병현 김승현 김주성 윤호영 김동우 양희종 차재영 하승진 이동준 김민수',
    ('nt_asia_cup', 2005): '신기성 김승현 이상민 추승균 정훈 방성윤 현주엽 문경은 양희승 서장훈 하승진 김주성',
}


def load_candidates():
    """이름(공백 제거) -> [(pcode, 첫 출전 시작연도, 마지막 출전 시작연도, 통산 경기 수, 출생연도)]"""
    con = sqlite3.connect(DB_PATH)
    rows = con.execute(
        "SELECT gps.pcode, gps.pname, MIN(g.season_name), MAX(g.season_name), COUNT(*)"
        " FROM player_game_stats gps JOIN games g ON gps.gmkey = g.gmkey"
        " WHERE g.season_category IN ('정규시즌', '플레이오프', '챔프전') AND g.season_name NOT LIKE '%D리그%'"
        " GROUP BY gps.pcode, gps.pname"
    ).fetchall()
    con.close()
    births = {}
    with open(CARDS_PATH, encoding='utf-8') as f:
        for c in json.load(f):
            bd = c.get('birth_date')
            if c.get('pcode') and bd and c['pcode'] not in births:
                births[c['pcode']] = int(str(bd).split('-')[0])
    by_name = collections.defaultdict(dict)
    for pcode, pname, first, last, n in rows:
        cand = by_name[pname.replace(' ', '')].setdefault(pcode, [int(first[:4]), int(last[:4]), 0])
        cand[0] = min(cand[0], int(first[:4]))
        cand[1] = max(cand[1], int(last[:4]))
        cand[2] += n
    return {
        name: [(pc, f, l, n, births.get(pc)) for pc, (f, l, n) in cands.items()]
        for name, cands in by_name.items()
    }


def resolve(name, year, by_name):
    cands = by_name.get(name)
    if not cands:
        return None, 'KBL 기록 없음'
    if (name, year) in OVERRIDES:
        return OVERRIDES[(name, year)], 'override'
    if len(cands) == 1:
        return cands[0][0], None
    # 동명이인: KBL 데뷔 6년 전(대학·고교 시절 발탁)~은퇴 1년 뒤 사이, 나이 19~40세인 후보만
    ok = [c for c in cands
          if c[1] - 6 <= year <= c[2] + 1 and (c[4] is None or 19 <= year - c[4] <= 40)]
    ok = ok or cands
    ok.sort(key=lambda c: -c[3])
    return ok[0][0], f"동명이인 {[c[0] for c in cands]} 중 {ok[0][0]} (통산 경기 수 우선)"


def main():
    by_name = load_candidates()
    with open(AWARDS_PATH, encoding='utf-8') as f:
        awards = json.load(f)

    # 기존 nt_* 제거(멱등)
    for pcode in list(awards):
        awards[pcode] = [a for a in awards[pcode] if not a['id'].startswith('nt_')]
        if not awards[pcode]:
            del awards[pcode]

    picked = collections.defaultdict(lambda: collections.defaultdict(list))  # pcode -> kind -> [연도]
    for (kind, year), roster in ROSTERS.items():
        for name in roster.split():
            pcode, note = resolve(name, year, by_name)
            if note:
                print(f"  [{kind} {year}] {name}: {note}")
            if pcode:
                picked[pcode][kind].append(year)

    for pcode, kinds in picked.items():
        for kind, years in kinds.items():
            label, event = KINDS[kind]
            years = sorted(set(years), reverse=True)
            awards.setdefault(pcode, []).append({
                "id": kind,
                "name": label,
                "count": len(years),
                "years": [f"{y} {event}" for y in years],
            })

    with open(AWARDS_PATH, 'w', encoding='utf-8') as f:
        json.dump(awards, f, ensure_ascii=False, indent=2)
    total = sum(len(y) for k in picked.values() for y in k.values())
    print(f"[SUCCESS] {len(picked)}명, 발탁 {total}건 -> {AWARDS_PATH}")


if __name__ == '__main__':
    main()
