"""tools/data/departures_<시즌>.csv -> roster_departure (2026-09-04, 사용자 확인 정보).

왜 이 표가 따로 필요한가: KBL 등록 명부에는 "이 시즌에 뛰지 않는다"가 없다. 군 복무 중인
선수도 구단에 등록은 돼 있고(실측: 2026-05 입대 10명 전원이 명부에 남아 있다), 해외로 나간
선수나 FA 미계약 선수는 등록만 빠질 뿐 이유가 남지 않는다. season_roster는 명부의 복사본이라
그 자리를 고치면 명부를 다시 받는 순간 지워진다 - 그래서 사람이 확인한 사실을 별도 표로 겹친다.

등록상태 C와의 관계: fetch_kbl_roster.py는 명부의 playerLastCareerIf가 'A'(현역)가 아닌 선수를
"등록상태 C(군복무·육성 추정, 미확인)"로만 적어 뒀다. 추정이라 이름을 단정하지 못했는데,
2026-05-18 입대 동기 10명을 확인해 대조하니 그 10명이 등록상태 C와 정확히 일치했다.
이제 이 표가 "추정"을 "확인"으로 바꾼다(detail에 입대일·전역 예정일이 들어간다).

사용:
    python load_departures.py --season 2026-2027
    python load_departures.py --season 2026-2027 --dry-run
"""
import argparse
import csv
import io
import os
import sys

import psycopg2
from psycopg2.extras import execute_values

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_roster import load_database_url  # noqa: E402
from cache_invalidate import revalidate  # noqa: E402

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
REASONS = {"military", "overseas", "unsigned", "retired", "other"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    path = os.path.join(DATA_DIR, "departures_%s.csv" % args.season.replace("-", "_"))
    if not os.path.exists(path):
        sys.exit("파일이 없다: %s" % path)

    rows = []
    with io.open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            reason = (r.get("reason") or "").strip()
            if reason not in REASONS:
                sys.exit("모르는 reason %r (%s) - 허용: %s" % (reason, r.get("player_name"), sorted(REASONS)))
            rows.append((
                args.season,
                (r["pcode"] or "").strip(),
                (r["player_name"] or "").strip(),
                (r["tcode"] or "").strip(),
                reason,
                (r.get("detail") or "").strip() or None,
                (r.get("source") or "").strip() or None,
            ))
    if not rows:
        sys.exit("행이 없다")

    conn = psycopg2.connect(load_database_url())
    cur = conn.cursor()
    # 표를 여기서 만든다 - 이 스크립트 말고는 이 표를 쓰는 데가 없고, 새 환경에서 파이프라인을
    # 다시 돌릴 때 손으로 만든 DDL을 기억해 낼 방법이 없다(build_import_slots.py도 같은 규약).
    cur.execute("""
        create table if not exists roster_departure (
          season_name text not null,
          pcode       text not null,
          player_name text not null,
          tcode       text not null,
          reason      text not null check (reason in ('military','overseas','unsigned','retired','other')),
          detail      text,
          source      text,
          primary key (season_name, pcode)
        );
        alter table roster_departure enable row level security;
    """)
    cur.execute("select 1 from pg_policies where tablename = 'roster_departure'")
    if not cur.fetchone():
        # 락다운(tools/lockdown_anon.sql) 이후로는 공개 읽기 정책을 만들지 않는다 - 서버는
        # service_role로 읽으므로 정책이 없어도 동작한다. 예전엔 이 줄이 배치를 돌릴 때마다
        # 락다운을 조용히 되돌려 테이블이 다시 anon 공개가 됐다(감사 실측).
        # cur.execute('create policy "public read roster_departure" on roster_departure for select using (true)')
        pass

    # 검산: pcode가 players에 실제로 있는가, 그리고 그 선수가 정말 그 팀의 직전 시즌 소속인가.
    # 이름만 맞고 pcode가 틀리면 엉뚱한 선수를 시즌에서 빼 버린다.
    cur.execute("select pcode, name from players where pcode = any(%s)", ([r[1] for r in rows],))
    known = dict(cur.fetchall())
    bad = [(r[1], r[2], known.get(r[1])) for r in rows if known.get(r[1]) != r[2]]
    if bad:
        for pcode, want, got in bad:
            print("  !! pcode %s 이름 불일치: 파일 %r vs players %r" % (pcode, want, got))
        sys.exit("pcode/이름 대조 실패 - 고치기 전에는 넣지 않는다")

    if args.dry_run:
        print("%s 이탈 %d명(dry-run)" % (args.season, len(rows)))
        for r in rows:
            print("  %-6s %-8s %s · %s" % (r[3], r[2], r[4], r[5] or ""))
        conn.close()
        return

    cur.execute("delete from roster_departure where season_name = %s", (args.season,))
    execute_values(
        cur,
        """insert into roster_departure
             (season_name, pcode, player_name, tcode, reason, detail, source)
           values %s""",
        rows,
    )
    conn.commit()
    print("roster_departure %s: %d행" % (args.season, len(rows)))
    revalidate(["manual:build", "batch:daily", f"season:{args.season}"])

    cur.execute(
        """select d.reason, count(*), string_agg(d.player_name, ', ' order by d.player_name)
           from roster_departure d where d.season_name = %s group by 1 order by 2 desc""",
        (args.season,),
    )
    for reason, n, names in cur.fetchall():
        print("  %-9s %2d명 · %s" % (reason, n, names))

    # 등록상태 C(군복무·육성 추정)와 실제 군 입대 명단이 얼마나 겹치는지 - 추정의 정확도를 남긴다.
    cur.execute(
        """select
             count(*) filter (where sr.note like '%%등록상태 C%%') as flagged,
             count(*) as total
           from roster_departure d
           join season_roster sr on sr.season_name = d.season_name and sr.pcode = d.pcode
           where d.season_name = %s and d.reason = 'military'""",
        (args.season,),
    )
    flagged, total = cur.fetchone()
    print("  대조: 군 입대 %d명 중 %d명이 명부 등록상태 C였다" % (total, flagged))
    conn.close()


if __name__ == "__main__":
    main()
