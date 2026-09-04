import { supabaseServer as supabase } from "./supabaseServer";

// 전력 조정 - 요청: "주전선수들의 군/해외행의 이탈과 바뀐 용병제도를 포함해서 시즌 전망의
// AI 예상순위를 변경해줘 ... 바뀐 규정에 대한 데이터가 부족해서 정확도가 낮습니다.
// (하지만 낮아도 제공 해줘야돼, 이게 제일 재밌단 말야)"
//
// ── 이건 측정이 아니라 시나리오다 ──────────────────────────────────────────────────
// 이 프로젝트는 앞서 "이탈로 다음 시즌 득실차 변화를 설명한 R²가 0.001"이라는 실측을 근거로
// 승수 환산을 거부했다. 그 실측은 지금도 유효하다. 사용자가 그걸 알고도 보고 싶다고 명시했으므로
// 만들되, **잰 것과 지어낸 것을 화면에서 갈라 놓는다.**
//
// 잰 것(전부 이 저장소 데이터):
//   · 팀 분가중 PER 1점 = 경기당 득실차 4.435점 (150 팀-시즌, R²=0.947)
//   · 다음 시즌 PER 회귀 - 비국내 연속 4.65+0.789p(n=131) / 공백복귀 12.29+0.491p(n=38),
//     국내 연속 3.76+0.690p(n=824) / 공백복귀 4.48+0.573p(n=162)
//   · 시간축을 한 시즌 밀면 산술이 3.3배 과대 → 축소율 0.30 (out-of-sample)
//   · 경기당 득실차 1점 = 54경기 1.86승 (R²=0.891)
//   · KBL 첫 시즌 비국내 선수 195명(300분+) PER 분포의 분위수 - 신입 선수 사전확률의 눈금
// 지어낸 것:
//   · 신입 7명의 등급(사용자가 준 스카우팅을 위 분위수에 배치)
//   · 규정 변경으로 외국인 2옵션이 경기당 10분 더 뛴다는 가정
//
// 계산 자체는 tools/build_strength_adjustment.py 가 하고, 이 파일은 그 결과를 읽기만 한다.
// 명단(tools/data/*.csv)이나 계수를 고치면 그 스크립트를 다시 돌려야 화면에 반영된다.

/**
 * 경기당 득실차 1점이 승률 로짓을 얼마나 움직이는가.
 * 실측 "경기당 +1점 = 54경기 기준 1.86승"(R²=0.891)에서 p=0.5 근처 기울기로 유도: 4 × 1.86/54.
 * (모델 자신의 넷레이팅 민감도는 이보다 작지만, 그건 모델 내부 계수이지 실제 승패 관계가 아니다.)
 */
export const MARGIN_TO_LOGIT = (4 * 1.86) / 54;

export type SlotProjection = {
  slot: "aq" | "import1" | "import2";
  name: string;
  pcode: string | null;
  minutes: number;
  per: number;
  /** "25-26 실적 29.4 → 투영 27.8" 또는 "스카우팅 사전확률(첫 시즌 상위 10%)". */
  perSource: string;
  /** 직전 시즌 그 자리를 쓰던 선수(들). */
  prevName: string | null;
  prevPer: number | null;
  /** 스카우팅 등급(신입만). 있으면 이 값은 실측이 아니라 사전확률이다. */
  tier: string | null;
  evidence: string | null;
};

export type TeamAdjustment = {
  tcode: string;
  /** 직전 시즌 실측 팀 분가중 PER. */
  perPrev: number;
  /** 재조립한 26-27 투영 팀 분가중 PER. */
  perNext: number;
  /** 경기당 득실차 델타(점). 셋을 더하면 dMarginRoster. */
  dMarginDepart: number;
  dMarginSlot: number;
  dMarginOther: number;
  dMarginRoster: number;
  dMarginRule: number;
  dMarginTotal: number;
  /** 그 팀 잔류 선수 중 출전분 9~14위의 분가중 PER - 빠진 자리를 메울 사람의 수준. */
  depthPer: number;
  /** 26-27 명부가 직전 시즌 출전분의 몇 %를 알고 있는가(나머지는 뎁스로 채웠다). */
  knownShare: number;
  slots: SlotProjection[];
};

export type StrengthAdjustment = {
  season: string;
  /**
   * 팀 10개. Map이 아니라 배열인 이유: 이 값은 unstable_cache 경계를 넘는데 Map은 직렬화되지
   * 않아 캐시 히트 때 빈 객체가 된다(lib/cachePolicy.ts 머리말). 10개짜리 find는 공짜다.
   */
  teams: TeamAdjustment[];
  /** 리그 평균 델타. 순위는 차이로만 정해지므로 화면은 이 값을 뺀 상대 델타를 보여준다. */
  leagueMean: number;
  /** 스카우팅 사전확률로 채운 자리 수 - 정확도 경고 문구의 근거. */
  priorSlots: number;
  totalSlots: number;
};

const n = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * 조정 전망 재료. 집계 표가 없으면 null - 화면은 기본 전망만 보여주면 된다.
 */
export async function getStrengthAdjustment(season: string): Promise<StrengthAdjustment | null> {
  const [teamRes, slotRes] = await Promise.all([
    supabase.from("strength_adjustment_team").select("*").eq("season_name", season),
    supabase.from("strength_adjustment_player").select("*").eq("season_name", season),
  ]);
  const teamRows = teamRes.data ?? [];
  const slotRows = slotRes.data ?? [];
  if (!teamRows.length) return null;

  const slotsByTeam = new Map<string, SlotProjection[]>();
  const ORDER = ["aq", "import1", "import2"];
  for (const r of slotRows) {
    const tc = r.tcode as string;
    const list = slotsByTeam.get(tc) ?? [];
    list.push({
      slot: r.slot as SlotProjection["slot"],
      name: r.player_name as string,
      pcode: (r.pcode as string | null) ?? null,
      minutes: n(r.minutes),
      per: n(r.per),
      perSource: r.per_source as string,
      prevName: (r.prev_name as string | null) ?? null,
      prevPer: r.prev_per == null ? null : n(r.prev_per),
      tier: (r.tier as string | null) ?? null,
      evidence: (r.evidence as string | null) ?? null,
    });
    slotsByTeam.set(tc, list);
  }
  for (const list of slotsByTeam.values()) list.sort((a, b) => ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot));

  const teams: TeamAdjustment[] = [];
  let sum = 0;
  for (const r of teamRows) {
    const tc = r.tcode as string;
    const total = n(r.total_minutes);
    sum += n(r.d_margin_total);
    teams.push({
      tcode: tc,
      perPrev: n(r.per_prev),
      perNext: n(r.per_next),
      dMarginDepart: n(r.d_margin_depart),
      dMarginSlot: n(r.d_margin_slot),
      dMarginOther: n(r.d_margin_other),
      dMarginRoster: n(r.d_margin_roster),
      dMarginRule: n(r.d_margin_rule),
      dMarginTotal: n(r.d_margin_total),
      depthPer: n(r.depth_per),
      knownShare: total > 0 ? n(r.known_minutes) / total : 0,
      slots: slotsByTeam.get(tc) ?? [],
    });
  }
  teams.sort((a, b) => b.dMarginTotal - a.dMarginTotal);

  const priorSlots = slotRows.filter((r) => r.tier).length;
  return {
    season,
    teams,
    leagueMean: teams.length ? sum / teams.length : 0,
    priorSlots,
    totalSlots: slotRows.length,
  };
}
