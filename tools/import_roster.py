"""개막 전 확정 로스터 적재 - season_roster 테이블.

왜 필요한가: 시즌이 시작되기 전에는 어느 선수가 어느 팀인지 알 방법이 데이터에 없다.
game_player_stats는 경기가 열려야 생기고, KBL API에는 로스터 엔드포인트가 없다(후보 경로
7개 전부 500). 그래서 개막 전 스카우팅 리포트는 지난 시즌 소속으로 말할 수밖에 없는데,
이적이 있으면 "이 선수를 막아야 한다"가 이미 팀을 떠난 선수를 가리키게 된다.

사용자가 확정 로스터를 주면 이 스크립트로 적재하고, 그때부터 리포트가 실제 로스터 기준으로
바뀐다(이적/신규/이탈 산출은 build_roster_changes.py).

입력 형식 - CSV(헤더 필수, 열 순서 무관, UTF-8 또는 CP949 자동 판별):
    team,name,back_num,pos
    창원 LG,아셈 마레이,10,C
    LG,유기상,,G
  - team: 팀 풀네임/약어/tcode 아무거나(예: "창원 LG", "LG", "50")
  - name: 선수 이름(필수)
  - back_num, pos: 있으면 좋고 없어도 됨
탭 구분(TSV)이나 한글 헤더(팀/이름/등번호/포지션)도 그대로 받는다.

사용:
    python import_roster.py roster_2026_27.csv --season 2026-2027
    python import_roster.py roster.csv --season 2026-2027 --dry-run   # 적재 없이 매칭 결과만
    python import_roster.py --season 2026-2027 --show                 # 적재된 로스터 확인
"""
import argparse
import csv
import io
import os
import re
import sys
import unicodedata

import psycopg2
from psycopg2.extras import execute_values

HERE = os.path.dirname(os.path.abspath(__file__))


def load_database_url():
    """tools/.env.supabase의 DATABASE_URL(직결, RLS 우회) - 다른 마이그레이션 스크립트와 동일."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    path = os.path.join(HERE, ".env.supabase")
    if os.path.exists(path):
        for line in io.open(path, encoding="utf-8"):
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("DATABASE_URL을 찾을 수 없다(tools/.env.supabase 확인).")


# 열 이름 정규화 - 한글/영문/변형을 하나로.
COLUMN_ALIASES = {
    "team": {"team", "tcode", "팀", "팀명", "소속", "소속팀"},
    "name": {"name", "player", "player_name", "이름", "선수", "선수명", "성명"},
    "back_num": {"back_num", "backnum", "number", "no", "등번호", "번호", "배번"},
    "pos": {"pos", "position", "포지션", "포지션명"},
    "note": {"note", "비고", "메모"},
}


def normalize_key(s):
    return re.sub(r"[\s_\-]+", "", (s or "").strip().lower())


def map_columns(fieldnames):
    """CSV 헤더를 표준 열 이름으로 매핑."""
    mapping = {}
    for raw in fieldnames or []:
        key = normalize_key(raw)
        for std, aliases in COLUMN_ALIASES.items():
            if key in {normalize_key(a) for a in aliases}:
                mapping[raw] = std
                break
    return mapping


def norm_name(s):
    """이름 대조용 정규화 - 공백/가운뎃점/유니코드 형태 차이를 흡수.

    외국인 선수는 소스마다 '아셈 마레이' / '아셈마레이' / '아셈·마레이'처럼 표기가 흔들린다.
    """
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r"[\s·.'\-]+", "", s)
    return s.lower()


def read_rows(path):
    """CSV/TSV를 UTF-8(BOM 포함) 우선, 실패하면 CP949로 읽는다."""
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "utf-8", "cp949"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        sys.exit("파일 인코딩을 판별할 수 없다(UTF-8 또는 CP949로 저장해줘).")

    sample = text[:2048]
    delim = "\t" if sample.count("\t") > sample.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    colmap = map_columns(reader.fieldnames)
    if "team" not in colmap.values() or "name" not in colmap.values():
        sys.exit(
            "헤더에서 team/name 열을 찾지 못했다. 실제 헤더: %r\n"
            "예: team,name,back_num,pos (또는 팀,이름,등번호,포지션)" % (reader.fieldnames,)
        )

    rows = []
    for r in reader:
        item = {}
        for raw_key, std in colmap.items():
            val = (r.get(raw_key) or "").strip()
            item[std] = val or None
        if item.get("team") and item.get("name"):
            rows.append(item)
    return rows


# 연고지 이동으로 이름이 바뀐 팀 - teams 테이블엔 예전 이름만 있고, 개명은 웹의
# courtside-web/lib/teamNames.ts(displayTeamName)에서만 처리한다. 로스터는 사람이 현재
# 이름으로 적어 보낼 것이므로 여기서도 현재 이름을 받아준다(실측: "부산 KCC"가 매칭 실패했음).
TEAM_NAME_ALIASES = {
    "60": ["부산 KCC", "부산KCC", "부산 KCC 이지스"],  # 전주 KCC -> 2023-2024 시즌부터 부산
}


def resolve_teams(cur):
    """팀 풀네임/약어/tcode 어느 쪽으로 적어도 tcode로 찾을 수 있게."""
    cur.execute("select tcode, name, abbr from teams")
    lookup = {}
    for tcode, name, abbr in cur.fetchall():
        keys = [tcode, name, abbr] + TEAM_NAME_ALIASES.get(tcode, [])
        for key in keys:
            if key:
                lookup[norm_name(key)] = tcode
        # "창원 LG" -> "LG"처럼 도시명을 뗀 형태도 허용
        for candidate in [name] + TEAM_NAME_ALIASES.get(tcode, []):
            parts = (candidate or "").split()
            if len(parts) > 1:
                lookup.setdefault(norm_name(parts[-1]), tcode)
    return lookup


def resolve_players(cur):
    """이름 -> pcode. 동명이인은 모호하다고 표시하고 자동 연결하지 않는다."""
    cur.execute("select pcode, name from players where name is not null")
    by_name = {}
    for pcode, name in cur.fetchall():
        by_name.setdefault(norm_name(name), []).append(pcode)
    return by_name


def main():
    ap = argparse.ArgumentParser(description="개막 전 확정 로스터 적재")
    ap.add_argument("csv_path", nargs="?", help="로스터 CSV/TSV 경로")
    ap.add_argument("--season", required=True, help="시즌명(예: 2026-2027)")
    ap.add_argument("--dry-run", action="store_true", help="적재하지 않고 매칭 결과만 출력")
    ap.add_argument("--show", action="store_true", help="이미 적재된 로스터를 출력하고 종료")
    ap.add_argument("--replace", action="store_true",
                    help="이 시즌 기존 로스터를 전부 지우고 새로 적재(부분 수정이 아니라 통째 교체)")
    args = ap.parse_args()

    conn = psycopg2.connect(load_database_url())
    cur = conn.cursor()

    if args.show:
        cur.execute("""
            select t.name, count(*), count(r.pcode),
                   count(*) filter (where r.pcode is null)
            from season_roster r join teams t using (tcode)
            where r.season_name = %s group by t.name order by t.name
        """, (args.season,))
        rows = cur.fetchall()
        if not rows:
            print("적재된 로스터 없음: %s" % args.season)
        else:
            print("%s 로스터" % args.season)
            for name, total, matched, unmatched in rows:
                print("  %-16s %2d명 (pcode 연결 %d, 미연결 %d)" % (name, total, matched, unmatched))
        return

    if not args.csv_path:
        sys.exit("CSV 경로가 필요하다(또는 --show).")

    rows = read_rows(args.csv_path)
    print("읽은 행: %d" % len(rows))

    team_lookup = resolve_teams(cur)
    player_lookup = resolve_players(cur)

    resolved, unknown_team, new_faces, ambiguous = [], [], [], []
    for r in rows:
        tcode = team_lookup.get(norm_name(r["team"]))
        if not tcode:
            unknown_team.append(r)
            continue
        cands = player_lookup.get(norm_name(r["name"]), [])
        if len(cands) == 1:
            pcode = cands[0]
        elif len(cands) > 1:
            pcode = None
            ambiguous.append((r, cands))
        else:
            pcode = None
            new_faces.append(r)
        resolved.append((args.season, tcode, pcode, r["name"], r.get("back_num"),
                         r.get("pos"), r.get("note"), os.path.basename(args.csv_path)))

    print("팀 매칭 실패: %d" % len(unknown_team))
    for r in unknown_team[:10]:
        print("   ? %s / %s" % (r["team"], r["name"]))
    print("기존 선수로 연결: %d" % sum(1 for x in resolved if x[2]))
    print("새 얼굴(pcode 없음 - 첫 경기 때 자동 연결): %d" % len(new_faces))
    for r in new_faces[:15]:
        print("   + %s (%s)" % (r["name"], r["team"]))
    if ambiguous:
        print("동명이인이라 자동 연결 보류: %d" % len(ambiguous))
        for r, cands in ambiguous[:10]:
            print("   ! %s (%s) -> %s" % (r["name"], r["team"], ",".join(cands)))

    if unknown_team:
        sys.exit("\n팀을 못 찾은 행이 있어 적재를 중단한다. 팀 표기를 확인해줘.")

    if args.dry_run:
        print("\n--dry-run: 적재하지 않았다.")
        return

    if args.replace:
        cur.execute("delete from season_roster where season_name = %s", (args.season,))
        print("기존 %s 로스터 삭제: %d행" % (args.season, cur.rowcount))

    execute_values(cur, """
        insert into season_roster
            (season_name, tcode, pcode, player_name, back_num, pos, note, source)
        values %s
        on conflict (season_name, tcode, player_name) do update set
            pcode = excluded.pcode,
            back_num = excluded.back_num,
            pos = excluded.pos,
            note = excluded.note,
            source = excluded.source,
            updated_at = now()
    """, resolved)
    conn.commit()
    print("\n적재 완료: %d행" % len(resolved))

    cur.execute("""
        select t.name, count(*) from season_roster r join teams t using (tcode)
        where r.season_name = %s group by t.name order by t.name
    """, (args.season,))
    for name, cnt in cur.fetchall():
        print("  %-16s %d명" % (name, cnt))


if __name__ == "__main__":
    main()
