# -*- coding: utf-8 -*-
"""record_book 검증용 픽스처 덤프 (개발 도구 - 운영 경로에서 쓰지 않는다).

  python dump_record_fixtures.py --parity OUTDIR [--sample 12] [--gmkeys S49G01N9,...]
      웹 엔진(lib/records.ts)과 파이썬(record_book.py)의 정의가 같은지 대조하는 픽스처.
      OUTDIR/<gmkey>.json = {"gmkey", "events": [[pcode, tcode, code, quarter, min, sec], ...], "rows": [[board, bucket, subject, period, value], ...]}
      공식 합계와 이벤트 합계가 선수·팀 전부에서 같은 경기만 고른다(공식 기반 보드도 이벤트로 재현되는 경기).

  python dump_record_fixtures.py --freq OUTDIR --prefix S47 [--entries PATH]
      알림 빈도 실측용: 그 접두사(예: S47 = 2025-26)로 시작하는 정규시즌 경기의 이벤트 파일들과,
      (--entries) 보드·구간별 순위 <= 50 항목 전체를 PATH에 저장한다(웹 요약기가 경기별 "그 경기 이전" 기록을 만드는 입력).
"""
import argparse
import collections
import json
import os
import sys

import record_book as rb

RELEVANT = {str(c) for c in range(201, 215)}      # applyBoxEvent가 보는 코드(득점·리바·어시·스틸·블락·턴오버)


def to_events(g):
    """text-cast -> Supabase game_events 모양(웹 엔진 입력). 이름 -> pcode는 같은 경기 선수 목록으로."""
    pidx = rb.player_index(g)
    out = []
    for e in g["events"]:
        if e.get("a") not in RELEVANT or not e.get("q"):
            continue
        pcode = pidx.get((e.get("p"), e.get("t"))) if e.get("p") else None
        out.append([pcode, e.get("t"), e["a"], e["q"], e.get("m"), e.get("s")])
    return out


def parity_ok(g, official_rows, event_rows):
    """공식 합계와 이벤트 합계가 선수·팀 전부에서 같은 경기만 True."""
    if not event_rows or any(v is None for v in rb.player_index(g).values()):
        return False
    for tc in (g["home"], g["away"]):
        rec = g["teams"].get(tc) or {}
        mk = sum(1 for e in g["events"] if e.get("t") == tc and e.get("p") and e.get("a") in ("201", "205", "207"))
        ms = sum(1 for e in g["events"] if e.get("t") == tc and e.get("p") and e.get("a") in ("202", "206", "208"))
        if (mk, mk + ms) != (rec.get("fgt"), rec.get("fgtA")):
            return False
    p_sum, t_sum, t_tpm = collections.defaultdict(int), collections.defaultdict(int), collections.defaultdict(int)
    for r in event_rows:
        _, m, _ = r["board"].split(".")
        if r["board"].startswith("pq."):
            p_sum[(m, r["subject"])] += r["value"]
            if m == "tpm":
                t_tpm[r["tcode"]] += r["value"]
        elif r["board"].startswith("tq."):
            t_sum[(m, r["subject"])] += r["value"]
    for r in official_rows:
        _, m, _ = r["board"].split(".")
        if r["board"].startswith("pg.") and p_sum[(m, r["subject"])] != r["value"]:
            return False
        if r["board"].startswith("tg.") and m in ("reb", "ast", "stl", "blk") and t_sum[(m, r["subject"])] != r["value"]:
            return False
        if r["board"].startswith("tg.") and m == "tpm" and t_tpm[r["subject"]] != r["value"]:
            return False
    return True


def dump_parity(outdir, gmkeys, sample):
    os.makedirs(outdir, exist_ok=True)
    pool = gmkeys or sorted(os.listdir(rb.RAW_GAMES))
    if not gmkeys:
        step = max(1, len(pool) // (sample * 4))
        pool = pool[::step]
    written = 0
    for gmkey in pool:
        g = rb.load_game(gmkey)
        if g is None:
            continue
        official, events = rb.official_candidates(g), rb.event_candidates(g)
        if not parity_ok(g, official, events):
            continue
        rows = [[r["board"], r["bucket"], r["subject"], r["period"], r["value"]] for r in official + events]
        with open(os.path.join(outdir, f"{gmkey}.json"), "w", encoding="utf-8") as f:
            json.dump({"gmkey": gmkey, "events": to_events(g), "rows": rows}, f, ensure_ascii=False, separators=(",", ":"))
        written += 1
        if not gmkeys and written >= sample:
            break
    print(f"parity fixtures: {written}개 -> {outdir}")


def dump_freq(outdir, prefix, entries_path):
    os.makedirs(outdir, exist_ok=True)
    n = 0
    for gmkey in sorted(os.listdir(rb.RAW_GAMES)):
        if not gmkey.startswith(prefix + "G01"):
            continue
        g = rb.load_game(gmkey)
        if g is None:
            continue
        with open(os.path.join(outdir, f"{gmkey}.json"), "w", encoding="utf-8") as f:
            json.dump({"gmkey": gmkey, "date": g["date"], "start": g["start"], "names": {p["pcode"]: p["pname"] for p in g["players"]}, "teams": g["names"], "events": to_events(g)},
                      f, ensure_ascii=False, separators=(",", ":"))
        n += 1
    print(f"freq events: {n}경기 -> {outdir}")
    if entries_path:
        rows, stats = rb.build_all(keep=50)
        with open(entries_path, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
        print(f"entries(keep=50): {len(rows)}행 -> {entries_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--parity", help="대조 픽스처를 쓸 폴더")
    ap.add_argument("--sample", type=int, default=12)
    ap.add_argument("--gmkeys", help="콤마 구분 - 지정하면 이 경기들만(조건을 통과해야 쓴다)")
    ap.add_argument("--freq", help="빈도 실측용 이벤트를 쓸 폴더")
    ap.add_argument("--prefix", default="S47", help="--freq: 시즌 접두사(S47 = 2025-26)")
    ap.add_argument("--entries", help="--freq: 순위 <= 50 항목 JSON 경로")
    args = ap.parse_args()
    if not (args.parity or args.freq):
        ap.error("--parity 또는 --freq가 필요하다")
    if args.parity:
        dump_parity(args.parity, [x.strip() for x in (args.gmkeys or "").split(",") if x.strip()], args.sample)
    if args.freq:
        dump_freq(args.freq, args.prefix, args.entries)


if __name__ == "__main__":
    sys.exit(main())
