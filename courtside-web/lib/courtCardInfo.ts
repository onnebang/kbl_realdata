import { getOvrHistoryCache, getPlayerOvrHistory, TBD_PCODE_PREFIX, type OvrSeasonRecord } from "./ovr";

// "코트 위" 선수 카드(components/OnCourtCards.tsx)가 쓰는 OVR·플레이 스타일 한 줄.
//
// **서버 전용이다.** lib/ovr.ts가 2.4MB짜리 courtside_ovr_history.json을 import하므로 "use client"
// 파일에서 이 모듈(의 값)을 가져오면 그 JSON이 브라우저 번들로 들어간다. 클라이언트는 `import type`만.
// 그래서 app/games/[gmkey]/page.tsx가 이 경기 로스터(~30명)의 결과만 미리 뽑아 GameReplay에 prop으로 내린다.

export type CourtCardInfo = {
  ovr: number | null;
  off: number | null;
  def: number | null;
  /** 화면 표기 G/F/C(lib/playerStatus.ts normalizePos와 같은 규칙: 원문 GD/FD/C, "Unknown"은 null). */
  position: "G" | "F" | "C" | null;
  /** 주 플레이 스타일(한글). */
  archetype: string | null;
  /** 보조 플레이 스타일(한글). 데이터에 없으면 null. */
  archetype2: string | null;
  /** true여도 화면에서는 확정값처럼 쓴다(lib/ovr.ts projected 주석, 2026-09-19 결정). */
  projected: boolean;
};

// tools/build_courtside_ovr.py ROLE_KOR_MAP의 거울. 스카우팅으로 직접 넣은 신입 외국인(tbd_ 행)은
// 이 매핑을 안 거쳐 영문("Slasher" 등)이 그대로 JSON에 남아 있다 - 화면 문구는 한글이어야 해서 여기서 옮긴다.
const ARCHETYPE_KO: Record<string, string> = {
  "Point Center": "포인트 센터",
  "Stretch Big": "스트레치 빅",
  "Paint Beast": "페인트존 장인",
  "Glass Cleaner": "글래스 클리너",
  Playmaker: "플레이메이커",
  Sharpshooter: "샤프슈터",
  Slasher: "슬래셔",
  "3&D Wing": "3&D 윙",
  "Lockdown Defender": "락다운 디펜더",
  "Scoring Threat": "스코어링 스렛",
  "All-Around": "올어라운드",
};

/** 한글로 옮긴 스타일. 표에 없는 순수 영문은 화면에 못 내니 null(빈 칩 대신 숨김). */
function archetypeKo(raw: string | undefined): string | null {
  if (!raw) return null;
  const ko = ARCHETYPE_KO[raw];
  if (ko) return ko;
  return /^[\x20-\x7e]+$/.test(raw) ? null : raw;
}

const finite = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

/** archetype2는 다른 브랜치가 OvrSeasonRecord에 추가하는 중이라 여기서는 넓혀서 읽는다(있든 없든 컴파일된다). */
type RecordWithStyle2 = OvrSeasonRecord & { archetype2?: string };

function toInfo(r: RecordWithStyle2): CourtCardInfo {
  const pos = (r.position ?? "").charAt(0).toUpperCase();
  return {
    ovr: finite(r.OVR),
    off: finite(r.OFF),
    def: finite(r.DEF),
    position: pos === "G" || pos === "F" || pos === "C" ? pos : null,
    archetype: archetypeKo(r.archetype),
    archetype2: archetypeKo(r.archetype2),
    projected: r.projected === true,
  };
}

/**
 * 후보 기록에서 이 경기 시즌의 것을 고른다. 그 시즌 기록이 없으면 가장 최근 기록.
 * 같은 시즌 후보가 여럿이면(동명이인) team이 같은 것만 - 팀을 모르거나 못 맞추면 null(남의 OVR을 붙이느니 카드에서 뺀다).
 */
export function pickRecord<T extends { season: string; team?: string }>(recs: T[], season: string | null, team?: string | null): T | null {
  if (recs.length === 0) return null;
  const inSeason = season ? recs.filter((r) => r.season === season) : [];
  const pool = inSeason.length > 0 ? inSeason : [recs.reduce((a, b) => (b.season > a.season ? b : a))];
  if (pool.length === 1) return pool[0];
  return (team ? pool.find((r) => r.team === team) : undefined) ?? null;
}

/**
 * 경기 로스터 -> pcode별 카드 정보. 기록이 전혀 없는 선수는 키 자체가 없다(카드는 OVR "-"로 그린다).
 *
 * 1) 경기의 진짜 pcode로 찾는다(getPlayerOvrHistory).
 * 2) 못 찾으면 tbd_<이름> 행을 이름으로 이어 붙인다 - 신입 선수는 OVR 파일에서 임시 키(TBD_PCODE_PREFIX)로,
 *    경기 데이터에서는 진짜 pcode로 나오기 때문이다. 동명이 여럿이면 record.team이 같은 것.
 *    record.team은 teams.name 원본("전주 KCC")이고 화면 팀명은 개명이 반영된 값("부산 KCC")이라 문자열을 직접 비교하지
 *    않고, 1)에서 찾은 같은 tcode 선수들의 record.team 최빈값을 그 팀의 이름으로 쓴다.
 *
 * 알려진 빈틈: 표기가 다르면(경기 "스카티 제임스" vs 파일 "스코티 제임스") 못 잇는다 - 데이터에서 고칠 문제.
 */
export function buildCourtCardInfo(players: { pcode: string; name: string; tcode: string }[], seasonName: string | null): Record<string, CourtCardInfo> {
  const out: Record<string, CourtCardInfo> = {};
  const misses: typeof players = [];
  const teamByPcode = new Map<string, string>();
  for (const p of players) {
    const rec = pickRecord(getPlayerOvrHistory(p.pcode), seasonName);
    if (!rec) {
      misses.push(p);
      continue;
    }
    out[p.pcode] = toInfo(rec);
    if (rec.team) teamByPcode.set(p.pcode, rec.team);
  }
  if (misses.length === 0) return out;

  const tbd = getOvrHistoryCache().filter((r) => r.pcode.startsWith(TBD_PCODE_PREFIX));
  const teamOf = (tcode: string): string | null => {
    const votes = new Map<string, number>();
    for (const q of players) {
      const t = q.tcode === tcode ? teamByPcode.get(q.pcode) : undefined;
      if (t) votes.set(t, (votes.get(t) ?? 0) + 1);
    }
    return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  for (const p of misses) {
    const rec = pickRecord(
      tbd.filter((r) => r.name === p.name),
      seasonName,
      teamOf(p.tcode)
    );
    if (rec) out[p.pcode] = toInfo(rec);
  }
  return out;
}
