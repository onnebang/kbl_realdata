import { supabaseServer as supabase } from "./supabaseServer";
import { getTeams, prevSeasonName, roleFromNote, type TeamInfo } from "./preseason";

// 26-27 외국인 출전 규정 변경 - 요청의 두 번째 절반.
//
//   기존: 아시아쿼터 1 + 외국인 2 등록. 외국인 2명 동시 출전 불가(아시아쿼터는 전 쿼터 가능).
//   변경: 1쿼터·4쿼터는 외국인 2명 동시 출전 불가(아시아쿼터는 가능).
//         2~3쿼터는 세 명 중 2명 동시 출전 가능 - 외국인 2명 조합도 된다.
//
// ── 이 변경의 크기를 무엇으로 말하는가 ──────────────────────────────────────────────
// "2·3쿼터가 중요해진다"가 아니다. 실측하면 2·3쿼터는 팀당 득점의 50.1%로 정확히 절반이고,
// 쿼터 득실차와 최종 득실차의 상관도 Q2+Q3 .642 / Q1+Q4 .623으로 사실상 같다. 바뀌는 구간이
// 승부처라서 중요한 게 아니라 그냥 절반이라서 중요하다.
//
// 진짜 크기는 슬롯 쪽에 있다. 지난 시즌 외국인 2명이 동시에 코트에 선 시간은 리그 전체
// 170초(코트시간의 0.013%)였고, 외국인 1명이 서 있던 시간은 98.75%였다. 외국인 슬롯은 이미
// 포화였다는 뜻이라, 이 규정은 비어 있던 시간을 채우는 게 아니라 **팀당 최대 20분의 외국인
// 시간을 새로 만든다.**
//
// ── 화면이 절대 하면 안 되는 것 ─────────────────────────────────────────────────
// 26-27은 아직 0경기다. "규정 덕에 몇 승 는다", "X팀이 몇 위 오른다"는 어떤 형태로도 쓸 수
// 없다. 아래 index는 팀 순서를 매기는 무단위 값이고, 단위를 붙이는 순간 거짓이 된다.
// 또 하나 - 2옵션 외국인의 분당 지표는 팀-경기당 8.7~16.7분짜리 벤치 출전에서 나온 값이다.
// 출전이 2·3쿼터로 늘어나면 그대로 유지된다는 보장이 없으므로 gap은 상한에 가깝게 읽어야 한다.

/** 슬롯 3종. import_slot_season.slot과 같은 값. */
export type SlotKey = "aq" | "import1" | "import2";

export const SLOT_LABEL: Record<SlotKey, string> = {
  aq: "아시아쿼터",
  import1: "외국인 1옵션",
  import2: "외국인 2옵션",
};

/** 지난 시즌 그 선수의 슬롯 실적. 26-27 신규 선수는 이 값이 없다(=KBL 기록 없음). */
export type SlotRecord = {
  pcode: string;
  name: string;
  tcode: string;
  slot: SlotKey;
  games: number;
  minutes: number;
  mpg: number | null;
  per: number | null;
  pts40: number | null;
  fgPct: number | null;
  /** 규정이 바뀌는 구간(2·3쿼터)의 경기당 출전분. */
  q23: number;
};

/** 26-27 등록 슬롯 한 자리. */
export type SlotSeat = {
  slot: SlotKey;
  name: string;
  pcode: string | null;
  /** 그 선수의 지난 시즌 기록. null이면 KBL 기록이 없다(= 산출 불가, "영향 없음"이 아니다). */
  prev: SlotRecord | null;
  /** 지난 시즌을 다른 팀에서 뛴 경우 그 팀(26-27 이적). */
  prevTeam: TeamInfo | null;
};

export type TeamImportRule = {
  team: TeamInfo;
  seats: SlotSeat[];
  /** 지난 시즌 이 팀의 아시아쿼터가 2·3쿼터에 뛴 경기당 분 - 새로 경합 대상이 되는 시간. */
  room: number;
  /** 26-27 등록 기준 (외국인 2옵션 PER − 아시아쿼터 PER). 둘 중 하나라도 기록이 없으면 null. */
  gap: number | null;
  /** gap × room. 무단위. 순서만 주장한다. */
  index: number | null;
  /** 지난 시즌 재료로 같은 계산을 한 값(모든 팀에서 산출된다). */
  prevGap: number | null;
  prevIndex: number | null;
  /** 26-27에 아시아쿼터를 등록하지 않았다. */
  noAq: boolean;
};

export type ImportRuleReport = {
  season: string;
  prevSeason: string;
  teams: TeamImportRule[];
  /** 리그 전체 코트시간 대비 코트 위 외국인 수 비율. */
  share: { none: number; one: number; two: number };
  /** 외국인 2명이 동시에 섰던 시간(초) - 반올림하지 않는다. */
  twoSec: number;
  courtSec: number;
  /** 쿼터별 팀당 평균 득점. */
  quarterPts: Record<string, number>;
  /** 쿼터 득실차와 최종 득실차의 상관. */
  quarterCorr: Record<string, number>;
  /** Q2+Q3이 전체 득점에서 차지하는 몫. */
  midShare: number;
  /** 지난 시즌 팀-경기당 외국인 총 출전분(= 새로 생기는 시간의 기준). */
  importMpg: number;
  gapMedian: number | null;
  gapPositive: number;
  gapTotal: number;
};

/** 규정이 새로 여는 구간. 2·3쿼터 = 20분. */
export const NEW_WINDOW_MINUTES = 20;

type SlotRow = {
  tcode: string;
  pcode: string;
  player_name: string;
  slot: SlotKey;
  games: number;
  minutes: number | null;
  mpg: number | null;
  per: number | null;
  pts40: number | null;
  fg_pct: number | null;
  q2_mpg: number | null;
  q3_mpg: number | null;
};

const n = (v: unknown): number => (typeof v === "number" ? v : v == null ? 0 : Number(v));
const nn = (v: unknown): number | null => (v == null ? null : Number(v));

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 26-27 등록 슬롯 × 직전 시즌 실적. 슬롯 실적은 tools/build_import_slots.py가 구운 표에서
 * 읽는다(코트 위 동시 출전 구조로 아시아쿼터/외국인을 복원한 결과 - 25-26엔 등록 구분이
 * DB에 없다).
 */
export async function getImportRuleReport(season: string): Promise<ImportRuleReport | null> {
  const prevSeason = prevSeasonName(season);
  const [teamMap, slotRes, ruleRes, rosterRes] = await Promise.all([
    getTeams(season),
    supabase
      .from("import_slot_season")
      .select("tcode, pcode, player_name, slot, games, minutes, mpg, per, pts40, fg_pct, q2_mpg, q3_mpg")
      .eq("season_name", prevSeason),
    supabase.from("import_rule_season").select("*").eq("season_name", prevSeason).maybeSingle(),
    supabase.from("season_roster").select("tcode, pcode, player_name, note").eq("season_name", season),
  ]);
  const slotRows = (slotRes.data ?? []) as SlotRow[];
  const rule = ruleRes.data as {
    court_sec: number;
    import0_sec: number;
    import1_sec: number;
    import2_sec: number;
    quarter_pts: Record<string, number>;
    quarter_corr: Record<string, number>;
    team_games: number;
  } | null;
  if (!slotRows.length || !rule) return null;

  const byPcode = new Map<string, SlotRecord>();
  const aqQ23 = new Map<string, number>(); // 지난 시즌 팀별 아시아쿼터 슬롯의 Q2+Q3 분
  for (const r of slotRows) {
    const rec: SlotRecord = {
      pcode: r.pcode,
      name: r.player_name,
      tcode: r.tcode,
      slot: r.slot,
      games: r.games,
      minutes: n(r.minutes),
      mpg: nn(r.mpg),
      per: nn(r.per),
      pts40: nn(r.pts40),
      fgPct: nn(r.fg_pct),
      q23: n(r.q2_mpg) + n(r.q3_mpg),
    };
    byPcode.set(r.pcode, rec);
    if (r.slot === "aq") aqQ23.set(r.tcode, (aqQ23.get(r.tcode) ?? 0) + rec.q23);
  }

  // 26-27 등록 명부에서 세 자리를 꺼낸다. note의 머리가 곧 역할이다("외국인 1옵션 | ...").
  const seatsByTeam = new Map<string, SlotSeat[]>();
  for (const r of rosterRes.data ?? []) {
    const role = roleFromNote((r.note as string | null) ?? null);
    if (!role) continue;
    const slot: SlotKey | null = role.includes("아시아")
      ? "aq"
      : role.includes("1옵션")
        ? "import1"
        : role.includes("2옵션")
          ? "import2"
          : null;
    if (!slot) continue;
    const pcode = (r.pcode as string | null) ?? null;
    const prev = pcode ? (byPcode.get(pcode) ?? null) : null;
    const list = seatsByTeam.get(r.tcode as string) ?? [];
    list.push({
      slot,
      name: r.player_name as string,
      pcode,
      prev,
      // 지난 시즌을 다른 팀에서 뛰었으면 그 팀을 밝힌다(옥존: 현대모비스 -> KT).
      prevTeam: prev && prev.tcode !== r.tcode ? (teamMap.get(prev.tcode) ?? null) : null,
    });
    seatsByTeam.set(r.tcode as string, list);
  }

  const ORDER: SlotKey[] = ["aq", "import1", "import2"];
  const teams: TeamImportRule[] = [];
  for (const [tcode, team] of teamMap) {
    const seats = (seatsByTeam.get(tcode) ?? []).sort((a, b) => ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot));
    if (!seats.length) continue;
    const room = aqQ23.get(tcode) ?? 0;
    const aqSeat = seats.find((s) => s.slot === "aq") ?? null;
    const i2Seat = seats.find((s) => s.slot === "import2") ?? null;
    const gap =
      aqSeat?.prev?.per != null && i2Seat?.prev?.per != null ? i2Seat.prev.per - aqSeat.prev.per : null;

    // 지난 시즌 재료 기준 - 26-27 신규 선수 때문에 위 gap이 절반의 팀에서만 나오므로,
    // "작년 이 팀의 두 자리는 이만큼 차이가 났다"를 따로 둔다.
    const prevAq = slotRows.filter((r) => r.tcode === tcode && r.slot === "aq");
    const prevI2 = slotRows.filter((r) => r.tcode === tcode && r.slot === "import2");
    const wavg = (rows: SlotRow[]) => {
      const mm = rows.reduce((s, r) => s + n(r.minutes), 0);
      return mm > 0 ? rows.reduce((s, r) => s + n(r.per) * n(r.minutes), 0) / mm : null;
    };
    const pa = wavg(prevAq);
    const pi = wavg(prevI2);
    const prevGap = pa != null && pi != null ? pi - pa : null;

    teams.push({
      team,
      seats,
      room,
      gap,
      index: gap != null ? gap * room : null,
      prevGap,
      prevIndex: prevGap != null ? prevGap * room : null,
      noAq: !aqSeat,
    });
  }
  // 지난 시즌 재료 기준 지수로 정렬한다 - 10팀 전부에서 나오는 유일한 값이라 표의 순서가
  // "산출 가능한 팀만 위로" 같은 편향을 갖지 않는다.
  teams.sort((a, b) => (b.prevIndex ?? -Infinity) - (a.prevIndex ?? -Infinity));

  const courtSec = n(rule.court_sec);
  const qp = rule.quarter_pts ?? {};
  const qTotal = ["Q1", "Q2", "Q3", "Q4"].reduce((s, k) => s + n(qp[k]), 0);
  const gaps = teams.map((t) => t.prevGap).filter((v): v is number => v != null);

  return {
    season,
    prevSeason,
    teams,
    share: {
      none: courtSec > 0 ? n(rule.import0_sec) / courtSec : 0,
      one: courtSec > 0 ? n(rule.import1_sec) / courtSec : 0,
      two: courtSec > 0 ? n(rule.import2_sec) / courtSec : 0,
    },
    twoSec: n(rule.import2_sec),
    courtSec,
    quarterPts: qp,
    quarterCorr: rule.quarter_corr ?? {},
    midShare: qTotal > 0 ? (n(qp.Q2) + n(qp.Q3)) / qTotal : 0,
    // 팀-경기당 외국인 총 출전분: (1명 구간 × 1 + 2명 구간 × 2) / 팀-경기 수
    importMpg:
      rule.team_games > 0 ? (n(rule.import1_sec) + 2 * n(rule.import2_sec)) / 60 / rule.team_games : 0,
    gapMedian: median(gaps),
    gapPositive: gaps.filter((v) => v > 0).length,
    gapTotal: gaps.length,
  };
}
