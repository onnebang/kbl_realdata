"""
경기 전 승률 모델용 추가 피처(Elo / 일정 / 결장) - 전부 "그 경기 이전 정보 + 경기 전에 확정되는
사실(일정, 12인 엔트리)"만 쓴다. 라이브 스크립트(export_training_table.py 등)는 건드리지 않는 신규 모듈.

핵심: `ExtraState` 하나가 시간순으로 경기를 소비한다.
  - features_for(...)  : 아직 안 열린 경기의 피처(추론용 - 피처 빌더가 학습/추론 동일)
  - update(game)       : 끝난 경기를 반영
학습 테이블 생성(`build_extras`)도, 추론도 같은 `features_for`를 호출하므로 학습/추론 불일치가 없다.

주의(누수 방지):
  * Elo는 이 경기 전 결과만. 새 시즌 첫 경기에서 평균으로 회귀(carry).
  * `courtside_ovr_history.json`의 같은 시즌 OVR은 쓰지 않는다(이 모듈은 아예 안 씀).
  * 결장 피처는 "직전 10경기 평균 출전시간 상위 8명 중 이 경기 엔트리에 없는(=출전기록 없는) 선수의
    출전시간 비중". 추론 시에는 경기 30분 전 발표되는 12인 엔트리를 dressed로 넘기면 된다
    (미발표면 None -> 결장 피처는 NaN이고 모델이 결측으로 처리).
"""
import json
import math
import os
import sys
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
CACHE_PATH = os.path.join(BASE, "..", "raw", "analysis", "winprob_games_cache.json")
ROLL = 10
ELO_MEAN = 1500.0

ELO_KEYS = ["elo", "eloOpp"]  # 팀별
SCHED_KEYS = ["b2b", "gamesLast7", "sameVenueStreak", "gamesLast14"]
AVAIL_KEYS = ["missTop8Share", "missTop3Share", "missTop8Count"]
GAME_ELO_KEYS = ["eloDiff", "eloProb"]  # 경기 단위


# ---------------------------------------------------------------- 로딩(캐시)
def _load_one(gmkey):
    d = os.path.join(GAMES_DIR, gmkey)
    try:
        with open(os.path.join(d, "meta.json"), encoding="utf-8") as f:
            g = json.load(f)["game"]
        with open(os.path.join(d, "team-record.json"), encoding="utf-8") as f:
            tr = {r["tcode"]: r["records"] for r in json.load(f)}
    except (OSError, ValueError, KeyError):
        return None
    h, a = g.get("tcodeH"), g.get("tcodeA")
    if h not in tr or a not in tr or g.get("seasonGrade") not in (None, 1):
        return None
    mins = {h: {}, a: {}}
    try:
        with open(os.path.join(d, "player-stat.json"), encoding="utf-8") as f:
            for row in json.load(f):
                p, r = row["player"], row["records"]
                if p["tcode"] in mins:
                    mins[p["tcode"]][p["pcode"]] = round((r.get("playMin") or 0) + (r.get("playSec") or 0) / 60, 2)
    except (OSError, ValueError, KeyError):
        pass
    return {"gmkey": gmkey, "gameDate": g["gameDate"], "seasonCode": g["seasonCode"], "home": h, "away": a,
            "homeScore": tr[h]["score"], "awayScore": tr[a]["score"], "homeMin": mins[h], "awayMin": mins[a]}


def load_games(refresh=False, workers=16):
    """경기 목록(날짜순). 캐시가 있으면 캐시, 새로 끝난 경기(raw/games 신규 폴더)만 증분 추가."""
    cached = []
    if os.path.exists(CACHE_PATH) and not refresh:
        with open(CACHE_PATH, encoding="utf-8") as f:
            cached = json.load(f)
    seen = {g["gmkey"] for g in cached}
    # 이미 시도했지만 무효(플레이오프 미완성 등)인 폴더도 매번 다시 열지 않게 skip 목록을 캐시 옆에 저장
    skip_path = CACHE_PATH + ".skip"
    skip = set(open(skip_path, encoding="utf-8").read().split()) if os.path.exists(skip_path) and not refresh else set()
    todo = [k for k in os.listdir(GAMES_DIR) if k not in seen and k not in skip]
    if todo:
        with ThreadPoolExecutor(workers) as ex:
            res = list(ex.map(_load_one, todo))
        new = [r for r in res if r]
        skip |= {k for k, r in zip(todo, res) if r is None}
        cached += new
        cached.sort(key=lambda x: (x["gameDate"], x["gmkey"]))
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        with open(CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(cached, f, ensure_ascii=False)
        with open(skip_path, "w", encoding="utf-8") as f:
            f.write("\n".join(sorted(skip)))
    return cached


# ---------------------------------------------------------------- 상태
def _d(s):
    return datetime.strptime(s, "%Y%m%d").toordinal()


class ExtraState:
    def __init__(self, K=20.0, hfa=65.0, carry=0.75, mov_scale=True):
        self.K, self.hfa, self.carry, self.mov_scale = K, hfa, carry, mov_scale
        self.elo = {}
        self.season = None
        self.dates = {}     # tcode -> [ordinal, ...]
        self.roles = {}     # tcode -> [is_home, ...]
        self.mins = {}      # tcode -> deque of {pcode: minutes} (최근 ROLL경기)

    # -- elo helpers
    def _rating(self, t, season):
        r = self.elo.get(t, ELO_MEAN)
        if self.season is not None and season != self.season:  # 새 시즌: 가상 회귀(추론 시 상태 불변)
            r = ELO_MEAN + self.carry * (r - ELO_MEAN)
        return r

    def features_for(self, home, away, game_date, season, home_dressed=None, away_dressed=None):
        """(home_feats, away_feats, game_feats) - 키에 home_/away_ 접두어 없음."""
        rh, ra = self._rating(home, season), self._rating(away, season)
        diff = rh - ra + self.hfa
        game = {"eloDiff": diff, "eloProb": 1 / (1 + 10 ** (-diff / 400))}
        d = _d(game_date)
        out = []
        for t, role, r, ro, dressed in ((home, 1, rh, ra, home_dressed), (away, 0, ra, rh, away_dressed)):
            f = {"elo": r, "eloOpp": ro}
            ds, rs = self.dates.get(t, []), self.roles.get(t, [])
            if ds:
                f["b2b"] = 1 if d - ds[-1] <= 1 else 0
                f["gamesLast7"] = sum(1 for x in ds[-8:] if d - x <= 7)
                f["gamesLast14"] = sum(1 for x in ds[-16:] if d - x <= 14)
                n = 0
                for x in reversed(rs):
                    if x != role:
                        break
                    n += 1
                f["sameVenueStreak"] = n
            else:
                f.update(b2b=None, gamesLast7=None, gamesLast14=None, sameVenueStreak=None)
            f.update(self._avail(t, dressed))
            out.append(f)
        return out[0], out[1], game

    def _avail(self, t, dressed):
        none = {"missTop8Share": None, "missTop3Share": None, "missTop8Count": None}
        win = self.mins.get(t)
        if dressed is None or not win or len(win) < 3:
            return none
        tot = {}
        for m in win:
            for p, v in m.items():
                tot[p] = tot.get(p, 0.0) + v
        top = sorted(tot.items(), key=lambda kv: -kv[1])[:8]
        s8 = sum(v for _, v in top)
        if s8 <= 0:
            return none
        dressed = set(dressed)
        miss8 = [(p, v) for p, v in top if p not in dressed]
        s3 = sum(v for _, v in top[:3])
        miss3 = sum(v for p, v in top[:3] if p not in dressed)
        return {"missTop8Share": sum(v for _, v in miss8) / s8, "missTop3Share": miss3 / s3 if s3 else None,
                "missTop8Count": len(miss8)}

    def update(self, g):
        h, a, season = g["home"], g["away"], g["seasonCode"]
        if self.season is not None and season != self.season:
            for t in self.elo:
                self.elo[t] = ELO_MEAN + self.carry * (self.elo[t] - ELO_MEAN)
        self.season = season
        rh, ra = self.elo.get(h, ELO_MEAN), self.elo.get(a, ELO_MEAN)
        exp_h = 1 / (1 + 10 ** (-(rh - ra + self.hfa) / 400))
        hs, as_ = g["homeScore"], g["awayScore"]
        res = 1.0 if hs > as_ else 0.0
        mult = 1.0
        if self.mov_scale:  # 538식 점수차 승수(자기상관 보정 포함)
            w_diff = (rh + self.hfa - ra) if res else (ra - rh - self.hfa)
            mult = math.log(abs(hs - as_) + 1) * 2.2 / (0.001 * w_diff + 2.2)
        delta = self.K * mult * (res - exp_h)
        self.elo[h], self.elo[a] = rh + delta, ra - delta
        d = _d(g["gameDate"])
        for t, role, mm in ((h, 1, g["homeMin"]), (a, 0, g["awayMin"])):
            self.dates.setdefault(t, []).append(d)
            self.roles.setdefault(t, []).append(role)
            self.mins.setdefault(t, deque(maxlen=ROLL)).append({p: v for p, v in mm.items() if v > 0})


def build_extras(games, **elo_kw):
    """games(날짜순) -> {gmkey: {"home": {...}, "away": {...}, "game": {...}}} (각 경기 '직전' 상태 기준)."""
    st = ExtraState(**elo_kw)
    out = {}
    for g in games:
        # 결장 피처: player-stat에는 0분(DNP) 선수도 행으로 들어있다(전체 행의 ~14%) = 실제 12인 엔트리에
        # 해당. 그래서 dressed = 행이 있는 선수 전부 (추론 시 발표되는 12인 엔트리와 같은 의미).
        dh, da = set(g["homeMin"]), set(g["awayMin"])
        hf, af, gf = st.features_for(g["home"], g["away"], g["gameDate"], g["seasonCode"], dh, da)
        out[g["gmkey"]] = {"home": hf, "away": af, "game": gf}
        st.update(g)
    return out, st


if __name__ == "__main__":
    refresh = "--refresh" in sys.argv
    gs = load_games(refresh=refresh)
    print(len(gs), "games;", gs[0]["gameDate"], "->", gs[-1]["gameDate"])
    ex, st = build_extras(gs)
    import statistics
    zero = sum(1 for g in gs for m in (g["homeMin"], g["awayMin"]) for v in m.values() if v <= 0)
    n = sum(len(m) for g in gs for m in (g["homeMin"], g["awayMin"]))
    print("player rows", n, "zero-min rows", zero)
    print("elo sample", sorted(st.elo.items(), key=lambda kv: -kv[1])[:3])
    print("avail non-null", sum(1 for v in ex.values() if v["home"]["missTop8Share"] is not None) / len(ex),
          "mean miss", statistics.mean(v["home"]["missTop8Share"] for v in ex.values() if v["home"]["missTop8Share"] is not None))
