import { supabase } from "./supabase";
import { TAG, TTL, cachedFn } from "./cachePolicy";

// 결정적 순간 득점(커리어) - 요청: "클러치 프로필에서, 승률에 + 되는 행동이 재미있는데,
// 클러치가 아니더라도, 승률 올랐던 내용들에 대해서 표시".
//
// ── 이 지표가 무엇이고 무엇이 아닌가(화면 각주가 그대로 인용한다) ─────────────────────
// game_events.wpa_home은 라이브 승률 모델의 P(i) - P(i-1)이고(tools/build_wpa.py), 그 모델의
// 입력은 (점수차, 잔여시간, 스케일 점수차, 넷레이팅, 시너지)뿐이다. 실측(2026-09-04):
//   · 240만 행 중 84.1%가 정확히 0. 리그 합계는 2점 +8,654 / 3점 +4,508 / 자유투 +2,443 /
//     덩크 +519이고 나머지 전 코드는 합이 |16| 미만이다(어시스트 +1.19, 스틸 -0.10).
//   · 비득점 행에 가끔 붙는 값은 공로가 아니라 시계 감쇠 노이즈다 - 최근 300경기 표본에서
//     그런 행 4,157건이 전부 직전 행 대비 점수 변화 0이었다. 그래서 굽는 단계에서 득점
//     4코드만 남긴다(tools/build_player_win_impact.py).
//   · 커리어 합과 커리어 득점의 상관이 0.997(R^2=0.994, 기울기 0.0258). 즉 새 지표가 아니라
//     레버리지로 가중한 득점이다. 원점수에 더하는 유일한 정보는 가비지타임 할인이다.
//   · 구조적으로 단조 비음수다(리그 최저 커리어값 -0.035). 슛 실패에 페널티가 없어서다.
//     실제 부호가 있는 값은 온코트 양면 WPA 쪽이다(워니 +27.7 / 조은후 -1.3).
//   · 절댓값으로 정렬하면 주전은 상위 10개가 10개 다 클러치다. 사용자가 원한 건 그 반대라
//     클러치와 클러치 밖 순간을 아예 따로 저장한다.
//
// 그래서 화면의 이름은 "승률 기여"가 아니라 "결정적 순간 득점"이고, 헤드라인은 합계가 아니라
// (1) 클러치 밖 최고 순간과 (2) 가비지타임 할인이다.

export type WinImpactMoment = {
  gmkey: string;
  gameDate: string;
  seasonName: string;
  quarter: string;
  clockMin: number;
  clockSec: number;
  actionLabel: string;
  tcode: string;
  homeTcode: string;
  awayTcode: string;
  homeScore: number;
  awayScore: number;
  /** 그 순간(득점 반영 전) 점수차. */
  margin: number;
  /** 그 플레이로 움직인 팀 승률(0~1 단위). 화면은 x100 해서 %p로 쓴다. */
  wpa: number;
  clutch: boolean;
};

export type WinImpactBucket = { key: string; label: string; n: number; pts: number; wpa: number };

export type WinImpact = {
  pcode: string;
  games: number;
  /** 득점 이벤트 수(야투·자유투 성공). */
  scores: number;
  pts: number;
  wpaTotal: number;
  wpaClutch: number;
  scoresClutch: number;
  ptsClutch: number;
  /** 클러치 밖 몫. */
  wpaOpen: number;
  /** 클러치 밖 비중(0~1). 합이 작으면 null. */
  openShare: number | null;
  byAction: WinImpactBucket[];
  byQuarter: WinImpactBucket[];
  byMargin: WinImpactBucket[];
  momentsClutch: WinImpactMoment[];
  momentsOpen: WinImpactMoment[];
  /** 21점차 이상 구간의 득점 비중과 승률 비중(0~1). 두 값의 차이가 이 지표의 존재 이유다. */
  garbagePtsShare: number | null;
  garbageWpaShare: number | null;
  /** 온코트 양면 WPA - 코트 위에 있는 동안 팀 승률 변화의 합. 여기만 음수가 실제로 나온다. */
  onCourtWpa: number | null;
  onCourtPos: number | null;
  onCourtNeg: number | null;
  onCourtEvents: number | null;
};

const MARGIN_LABELS: Record<string, string> = {
  "0-5": "5점차 이내",
  "6-10": "6~10점차",
  "11-20": "11~20점차",
  "21+": "21점차 이상",
};

type RawBucket = { code?: string; quarter?: string; bucket?: string; label?: string; n: number; pts: number; wpa: number | string };

type RawMoment = {
  gmkey: string;
  game_date: string;
  season_name: string;
  quarter: string;
  clock_min: number;
  clock_sec: number;
  action_label: string;
  tcode: string;
  home_tcode: string;
  away_tcode: string;
  home_score: number;
  away_score: number;
  margin: number;
  wpa: number | string;
  clutch: boolean;
};

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));
const numOrNull = (v: number | string | null | undefined) => (v == null ? null : Number(v));

function toBuckets(rows: RawBucket[] | null, kind: "action" | "quarter" | "margin"): WinImpactBucket[] {
  return (rows ?? []).map((r) => {
    const key = (kind === "action" ? r.code : kind === "quarter" ? r.quarter : r.bucket) ?? "";
    const label =
      kind === "action"
        ? (r.label ?? key).replace("슛 성공", "").replace(" 성공", "")
        : kind === "quarter"
          ? key === "OT"
            ? "연장"
            : key
          : (MARGIN_LABELS[key] ?? key);
    return { key, label, n: Number(r.n), pts: Number(r.pts), wpa: num(r.wpa) };
  });
}

function toMoments(rows: RawMoment[] | null): WinImpactMoment[] {
  return (rows ?? []).map((m) => ({
    gmkey: m.gmkey,
    gameDate: m.game_date,
    seasonName: m.season_name,
    quarter: m.quarter,
    clockMin: m.clock_min,
    clockSec: m.clock_sec,
    actionLabel: m.action_label,
    tcode: m.tcode,
    homeTcode: m.home_tcode,
    awayTcode: m.away_tcode,
    homeScore: m.home_score,
    awayScore: m.away_score,
    margin: m.margin,
    wpa: num(m.wpa),
    clutch: m.clutch,
  }));
}

/** player_win_impact 1행 - 수동 build 산출물. */
export const getWinImpact = cachedFn(computeWinImpact, {
  name: "winImpact",
  ttl: TTL.manualBuild,
  tags: (pcode) => [TAG.build, `player:${pcode}`],
});

async function computeWinImpact(pcode: string): Promise<WinImpact | null> {
  const { data, error } = await supabase
    .from("player_win_impact")
    .select(
      "pcode, games, scores, pts, wpa_total, wpa_clutch, scores_clutch, pts_clutch, by_action, by_quarter, by_margin, moments_clutch, moments_open, oncourt_wpa, oncourt_pos, oncourt_neg, oncourt_events"
    )
    .eq("pcode", pcode)
    .maybeSingle();
  if (error || !data) return null;

  const wpaTotal = num(data.wpa_total);
  const wpaClutch = num(data.wpa_clutch);
  const byMargin = toBuckets(data.by_margin as RawBucket[] | null, "margin");
  const garbage = byMargin.find((b) => b.key === "21+");
  const pts = Number(data.pts);

  return {
    pcode: data.pcode as string,
    games: Number(data.games),
    scores: Number(data.scores),
    pts,
    wpaTotal,
    wpaClutch,
    scoresClutch: Number(data.scores_clutch),
    ptsClutch: Number(data.pts_clutch),
    wpaOpen: wpaTotal - wpaClutch,
    // 합이 작으면 "몇 %가 밖에서 나왔다"가 문장으로 성립하지 않는다.
    openShare: Math.abs(wpaTotal) > 1 ? (wpaTotal - wpaClutch) / wpaTotal : null,
    byAction: toBuckets(data.by_action as RawBucket[] | null, "action"),
    byQuarter: toBuckets(data.by_quarter as RawBucket[] | null, "quarter"),
    byMargin,
    momentsClutch: toMoments(data.moments_clutch as RawMoment[] | null),
    momentsOpen: toMoments(data.moments_open as RawMoment[] | null),
    garbagePtsShare: garbage && pts > 0 ? garbage.pts / pts : null,
    garbageWpaShare: garbage && Math.abs(wpaTotal) > 1 ? garbage.wpa / wpaTotal : null,
    onCourtWpa: numOrNull(data.oncourt_wpa),
    onCourtPos: numOrNull(data.oncourt_pos),
    onCourtNeg: numOrNull(data.oncourt_neg),
    onCourtEvents: data.oncourt_events == null ? null : Number(data.oncourt_events),
  };
}
