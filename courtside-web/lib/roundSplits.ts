import { cachedFn, TTL } from "./cachePolicy";
import { roundInfoFromGames, roundOfGmkey } from "./homeGames";
import { aggBox, type BoxAgg } from "./playerPageData";
import type { CareerGameRow } from "./playerProfile";
import { supabaseServer as supabase } from "./supabaseServer";

// 선수 프로필의 "라운드별 기록" - 이번 시즌(2026-27)부터 서비스를 직접 운영하니 시즌 안에서 라운드마다 기록이
// 어떻게 움직이는지 보여 달라는 요청(2026-10-07). 라운드 정의는 홈의 라운드 탭(lib/homeGames.ts getRoundGames)과
// 같다 - games에 라운드 컬럼이 없어서 경기 순번을 한 라운드 경기 수(10팀=45)로 끊은 "계산값"이라 공식 라운드
// 표기와 경계가 하루 어긋날 수 있다. 경기당 평균 집계는 시즌 기록표와 같은 aggBox를 그대로 쓴다.

export type SeasonRoundInfo = { perRound: number; roundCount: number; /** 종료된 경기가 있는 가장 마지막 라운드(없으면 0) */ currentRound: number };

/** 시즌 일정에서 라운드 크기·개수·진행 중 라운드. 일정(경기 수)은 거의 안 바뀌지만 진행 라운드는 경기가 끝날 때마다 바뀐다. */
export const getSeasonRoundInfo = cachedFn(
  async (seasonName: string): Promise<SeasonRoundInfo> => {
    const { data } = await supabase
      .from("games")
      .select("gmkey, home_tcode, away_tcode, is_ended")
      .eq("season_name", seasonName)
      .eq("season_category", "정규시즌");
    const games = data ?? [];
    const { perRound, roundCount } = roundInfoFromGames(games);
    const lastEnded = games.filter((g) => g.is_ended).reduce((m, g) => Math.max(m, roundOfGmkey(g.gmkey, perRound)), 0);
    return { perRound, roundCount, currentRound: lastEnded };
  },
  { name: "seasonRoundInfo", ttl: TTL.scheduled }
);

/** 평균의 표준오차 - 표본이 2경기 미만이면 판정할 수 없어 null. */
function stdErr(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance / xs.length);
}

export type RoundSplit = {
  round: number;
  /** 이 라운드 경기당 평균. 안 뛰었으면 null. */
  agg: BoxAgg | null;
  /** 득점/리바운드/어시스트 평균의 표준오차 - 라운드 간 변화가 노이즈인지 가리는 데 쓴다(null = 표본 부족). */
  se: { pts: number | null; reb: number | null; ast: number | null } | null;
};

export type RoundSplits = {
  season: string;
  roundCount: number;
  perRound: number;
  /** 종료된 경기가 있는 가장 마지막 라운드 - 이보다 뒤 라운드의 빈 칸은 "예정", 이하는 "기록 없음". */
  currentRound: number;
  rounds: RoundSplit[];
};

/** 순수 버킷팅 - Supabase 없이 단위 테스트 가능(lib/roundSplits.test.ts). 이 시즌 정규시즌 종료 경기가 없으면 null. */
export function buildRoundSplits(rows: CareerGameRow[], season: string, info: SeasonRoundInfo): RoundSplits | null {
  // 오픈매치(전시경기)·플레이오프는 라운드가 없고, 안 끝난 경기는 기록이 덜 찬 상태라 뺀다.
  const mine = rows.filter((r) => r.seasonName === season && r.seasonCategory === "정규시즌" && r.isEnded);
  if (mine.length === 0) return null;
  const byRound = new Map<number, CareerGameRow[]>();
  for (const r of mine) {
    const n = roundOfGmkey(r.gmkey, info.perRound);
    if (n < 1 || n > info.roundCount) continue;
    byRound.set(n, [...(byRound.get(n) ?? []), r]);
  }
  const rounds: RoundSplit[] = [];
  for (let n = 1; n <= info.roundCount; n++) {
    const list = byRound.get(n) ?? [];
    rounds.push({
      round: n,
      agg: aggBox(list),
      se: list.length ? { pts: stdErr(list.map((r) => r.pts)), reb: stdErr(list.map((r) => r.reb)), ast: stdErr(list.map((r) => r.ast)) } : null,
    });
  }
  return { season, roundCount: info.roundCount, perRound: info.perRound, currentRound: info.currentRound, rounds };
}

/** 프로필 페이지용 - 이 시즌 종료 정규시즌 경기가 한 판도 없으면 일정 조회 없이 null(대부분의 과거 선수·미출전 선수). */
export async function getPlayerRoundSplits(careerRows: CareerGameRow[], season: string): Promise<RoundSplits | null> {
  if (!careerRows.some((r) => r.seasonName === season && r.seasonCategory === "정규시즌" && r.isEnded)) return null;
  return buildRoundSplits(careerRows, season, await getSeasonRoundInfo(season));
}

export type RoundDelta = { value: number; tone: "up" | "down" | "flat" };

/** 직전에 뛴 라운드 대비 변화. 두 라운드의 표준오차를 합친 노이즈(√(se₁²+se₂²)) 안이면 방향을 말하지 않는다(flat) -
 * 라운드당 경기는 9개 안팎이라 평균이 쉽게 출렁이고, 노이즈를 색으로 칠하면 거짓말이 된다(최근 N경기 패널의 Δ 규칙과 같은 원칙). */
export function roundDelta(cur: number, prev: number, seCur: number | null, sePrev: number | null): RoundDelta {
  const value = cur - prev;
  const noise = seCur != null && sePrev != null ? Math.hypot(seCur, sePrev) : Infinity;
  const tone = Math.abs(value) < 0.05 || Math.abs(value) < noise ? "flat" : value > 0 ? "up" : "down";
  return { value, tone };
}
