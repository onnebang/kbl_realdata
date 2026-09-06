# -*- coding: utf-8 -*-
"""선수의 시즌별 국내/외국/아시아쿼터 구분을 한 테이블로 모은다.

## 왜 필요한가

DB에는 국적 컬럼이 아예 없다(players는 pcode/name/ename/photo_url 4컬럼뿐, game_player_stats
28컬럼에도 없다). 그래서 이 저장소는 지금까지 **이름 휴리스틱**으로 갈라 왔다:

    비국내 = players.name에 공백이 있거나 name == "라건아"
             (단 season_roster.note에 "flag0 국내"가 있으면 국내)
    - tools/build_import_slots.py:222-229, tools/build_strength_adjustment.py:230-233

이 휴리스틱을 정답셋과 전수 대조해 보니 **3,044건 중 110건이 틀렸다(96.39%)**. 화면에
"국내 에이스 / 외국 에이스"를 나눠 쓰려면 96%로는 부족하다 - 한 팀 걸러 한 팀씩 틀린 이름이
나올 수 있고, 그건 데이터 정직성 원칙에 정면으로 어긋난다.

## 원천 셋 (겹치면 위가 이긴다)

1. **kbl540_players_final.json** - 2006-2007~2025-2026 20시즌 3,137행에 시즌별 nationality
   (국내 2,484 / 외국 613 / 아시아쿼터 40)가 그대로 들어 있다.
   2025-2026에 대해 import_slot_season(코트 위 동시출전 복원으로 만든 독립 산출물)과
   **37/37 완전 일치**해서 신뢰할 수 있다고 봤다.
2. **season_roster** - 2026-2027(현재 시즌)은 JSON에 없다. 이 시즌은 note 머리 토큰이
   역할이고("외국인 1옵션 | ...", "아시아쿼터 | ...", "flag0 국내"), pos IS NULL이 외국선수와
   100% 일치한다(국내 184행 전부 pos 있음 / 외국 29행 전부 pos 없음).
3. **이름 휴리스틱** - 위 둘 다 없을 때만. 실측상 자격 통과자(15경기 또는 300분) 2,062명-시즌
   중 JSON에 없는 사람은 **2명(0.1%)뿐**이고 둘 다 국내 선수라(홍경기 39.5분, 김건우 29.8분)
   에이스 판정에는 영향이 없다.

## 휴리스틱이 확실히 틀리는 것 - 예외 목록

  · 나카무라 타이치(291315): 국내 선수인데 이름에 공백이 있다. 2020-2021·2021-2022 출전.
    JSON이 이 사람을 '국내'로 갖고 있어 1·2단계에서는 문제가 없지만, 폴백이 그를 만나면
    반드시 외국으로 오분류한다. 그래서 폴백에도 명시적으로 박아 둔다.
  · 라건아(290524): 귀화 한국인이지만 **외국선수 슬롯**을 쓴다. 이 테이블은 '국적'이 아니라
    '어느 슬롯으로 뛰는가'를 담는다 - JSON도 그를 외국으로 분류하고 있어 일관된다.

## 실행

    python tools/build_player_nationality.py            # 적재
    python tools/build_player_nationality.py --dry-run  # 집계만 출력
"""
import sys, io, json, argparse, collections

sys.path.insert(0, r"D:\영상작업\축구\개발\kbl_realdata\tools")
import psycopg2
from import_roster import load_database_url

JSON_PATH = r"D:\영상작업\축구\개발\kbl540_players_final.json"

# 이름에 공백이 있지만 국내 선수인 사람. 폴백에서만 쓴다(1·2단계에는 정답이 이미 있다).
DOMESTIC_WITH_SPACE = {"291315"}  # 나카무라 타이치
NATURALIZED_IMPORT = {"라건아"}    # 귀화했지만 외국선수 슬롯

DDL = """
create table if not exists player_nationality (
  season_name text not null,
  pcode       text not null,
  player_name text,
  -- '국내' | '외국' | '아시아쿼터'
  nationality text not null,
  -- 'kbl540_json' | 'season_roster' | 'name_heuristic' - 어디서 왔는지 항상 남긴다.
  source      text not null,
  primary key (season_name, pcode)
);
alter table player_nationality enable row level security;
"""

POLICY = """
drop policy if exists "public read player_nationality" on player_nationality;
# 락다운(tools/lockdown_anon.sql) 이후로는 공개 읽기 정책을 만들지 않는다 - 서버는
# service_role로 읽으므로 정책이 없어도 동작한다. 예전엔 이 줄이 배치를 돌릴 때마다
# 락다운을 조용히 되돌려 테이블이 다시 anon 공개가 됐다(감사 실측).
# create policy "public read player_nationality" on player_nationality for select using (true);
"""


def role_to_nationality(note):
    """season_roster.note 머리 토큰 -> 국적. lib/preseason.ts:361의 roleFromNote와 같은 규칙."""
    head = (note or "").split("|")[0].strip()
    if "아시아" in head:
        return "아시아쿼터"
    if "외국인" in head:
        return "외국"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    c = psycopg2.connect(load_database_url())
    cur = c.cursor()

    cur.execute("select pcode, name from players")
    name_by = {r[0]: r[1] for r in cur.fetchall()}

    rows = {}   # (season, pcode) -> (name, nationality, source)

    # ── 1. kbl540 JSON ──────────────────────────────────────────────────────────
    data = json.load(io.open(JSON_PATH, encoding="utf-8"))
    conflicts = 0
    for r in data:
        pc, season = r.get("pcode"), r.get("season_name")
        nat = r.get("nationality")
        if not pc or not season or nat not in ("국내", "외국", "아시아쿼터"):
            continue
        key = (season, pc)
        # 같은 선수-시즌이 팀을 옮겨 두 행으로 오는 경우가 93건 있다. 국적이 다르면 그건
        # 원천 자체의 모순이라 세어서 보고한다(실측 0건).
        if key in rows and rows[key][1] != nat:
            conflicts += 1
            print("  [모순] %s %s: %s vs %s" % (season, pc, rows[key][1], nat))
        rows[key] = (r.get("name") or name_by.get(pc), nat, "kbl540_json")
    print("1) kbl540 JSON: %d행 (모순 %d건)" % (len(rows), conflicts))

    # ── 2. season_roster (JSON에 없는 시즌 = 현재 시즌) ──────────────────────────
    cur.execute("select season_name, pcode, player_name, note, pos from season_roster where pcode is not null")
    added = 0
    for season, pc, pname, note, pos in cur.fetchall():
        key = (season, pc)
        if key in rows:
            continue
        nat = role_to_nationality(note)
        if nat is None:
            # note에 역할이 없으면 pos로 판정한다(국내 184행 전부 pos 있음 / 외국 29행 전부 없음).
            nat = "국내" if pos else "외국"
        rows[key] = (pname or name_by.get(pc), nat, "season_roster")
        added += 1
    print("2) season_roster: +%d행" % added)

    # ── 3. 이름 휴리스틱 (남은 구멍만) ──────────────────────────────────────────
    cur.execute(
        """select g.season_name, s.pcode
             from game_player_stats s join games g on g.gmkey = s.gmkey
            where g.season_category = '정규시즌'
            group by 1, 2"""
    )
    fallback = 0
    for season, pc in cur.fetchall():
        if (season, pc) in rows:
            continue
        n = name_by.get(pc) or ""
        if pc in DOMESTIC_WITH_SPACE:
            nat = "국내"
        elif n in NATURALIZED_IMPORT or " " in n:
            nat = "외국"
        else:
            # 이름 자체를 모르는 경우(players에 없는 옛 선수)가 여기로 온다. 추측하지 않고
            # 국내로 두되 source로 구분 가능하게 남긴다 - 화면에서는 source를 보고 거를 수 있다.
            nat = "국내"
        rows[(season, pc)] = (n or None, nat, "name_heuristic")
        fallback += 1
    print("3) 이름 휴리스틱 폴백: +%d행" % fallback)

    by_src = collections.Counter(v[2] for v in rows.values())
    by_nat = collections.Counter(v[1] for v in rows.values())
    print("\n총 %d행  원천 %s  국적 %s" % (len(rows), dict(by_src), dict(by_nat)))

    if args.dry_run:
        c.close()
        return

    cur.execute(DDL)
    cur.execute("delete from player_nationality")
    payload = [(s, p, v[0], v[1], v[2]) for (s, p), v in rows.items()]
    CH = 1000
    for i in range(0, len(payload), CH):
        chunk = payload[i : i + CH]
        cur.executemany(
            "insert into player_nationality (season_name, pcode, player_name, nationality, source)"
            " values (%s, %s, %s, %s, %s)",
            chunk,
        )
    cur.execute(POLICY)
    c.commit()
    print("적재 완료: %d행" % len(payload))
    c.close()


if __name__ == "__main__":
    main()
