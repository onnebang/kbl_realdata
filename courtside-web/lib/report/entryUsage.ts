import type { ReportTeamMeta } from "./renderKit";

// ---------------------------------------------------------------------------
// 엔트리 대비 실제 출전 (Entry vs Actual Usage)
//
// 요청(2026-09-30): "kcc가 예측을 깨고 지게된 이유에는, 엔트리에 들어온 선수들을 활용을
// 못했던 점도 언급을 해주면 좋겠어".
//
// 실측 사례 S49G14N10(2026-09-27, 전주 KCC 67 : 80 대구 한국가스공사 - 13점 패):
//   엔트리 기준 예측은 KCC 65%였는데, 엔트리 OVR 상위 6인 중 셋이 사실상 뛰지 않았다.
//     허웅(OVR 83)  0분  - 투입 기록 자체가 없음
//     장재석(OVR 81) 0분  - 투입 기록 자체가 없음
//     윤기찬(OVR 82) 4분 34초 - **선발**인데 Q2 10:00에 교체된 뒤 재투입 없음(반칙 0개)
//   이 셋을 합쳐 4분 34초다. 시간은 대부분 비주전이 소화했다.
//
// 엔트리 기준 예측(pregame_features.home_win_prob_lineup)은 "발표된 12인이 정규 로테이션대로
// 뛴다"는 가정 위에 있다. 그 가정이 깨진 것을 예측이 어긋난 이유의 하나로 드러내는 것이 이
// 모듈의 전부다.
//
// **동기는 추정하지 않는다.** 출전 시간 배분은 감독 결정이고 이유는 기록에 남지 않는다.
// 부상·컨디션·일정(백투백)·전략 등 무엇이든 가능하고, 실제로 KBL에는 순위 경쟁 때문에 주전을
// 빼는 경우까지 있었다(사용자 지적). 어느 쪽인지 데이터로 구분할 방법이 없으므로 이 리포트는
// 사실만 적고 이유를 고르지 않는다. 경기 유형(시범경기 등)을 이유로 대는 것도 하지 않는다 -
// "오픈매치라 느슨하게 했다"는 근거 없는 서술이고, 오픈매치 표본은 이 10경기가 전부라
// 유형별 경향을 주장할 수도 없다(2026-09-30 실측: OPEN MATCH DAY는 2026-27 10경기뿐).
// ---------------------------------------------------------------------------

/**
 * 이 시간 미만이면 "사실상 뛰지 않았다"고 본다.
 * 근거: 정규시즌 7,986 팀-경기에서 **선발 5인 중 최저 출전 시간**의 중앙값은 14.05분이고,
 * 6분 미만인 팀-경기는 11.7%뿐이다(2026-09-30 실측). 즉 6분은 "드물게 일어나는 일"의 경계다.
 */
export const ENTRY_BARELY_PLAYED_SEC = 360;

/**
 * 엔트리 12인 중 OVR 상위 몇 명을 "팀이 기대고 가는 전력"으로 볼지. 절반(6명)으로 둔다 -
 * 벤치 끝자리가 안 뛰는 것은 매 경기 일어나는 일이라(정규시즌 0분 출전 평균 1.51명) 그것까지
 * 세면 배경 소음이 된다. 그래서 '몇 명이 안 뛰었나'가 아니라 '**누가** 안 뛰었나'로 판정한다.
 */
export const ENTRY_TOP_N = 6;

/** 비교용 정규시즌 기준값(표시 전용). 선발 5인이 소화한 팀 출전 시간 비중의 중앙값. */
export const REGULAR_STARTER_SHARE_P50 = 0.645;

/** 한 명의 엔트리 선수. onSec은 교체 이벤트로 재구성한 실제 코트 체류 시간이다. */
export type EntryPlayer = {
  pcode: string;
  name: string;
  isStarter: boolean;
  onSec: number;
  /** 그 시즌 OVR(courtside_ovr_history.json). 신인·신규 영입 등 기록이 없으면 null. */
  ovr: number | null;
  /** 투입(101) 기록이 한 번도 없었다 = 코트를 아예 밟지 않았다. */
  neverEntered: boolean;
  /** 마지막으로 교체되어 나간 시각. 그 뒤 재투입이 없을 때만 채운다. */
  leftForGoodAt: string | null;
};

export type EntryUsageSide = {
  team: ReportTeamMeta;
  /** OVR 상위 ENTRY_TOP_N 중 ENTRY_BARELY_PLAYED_SEC 미만으로 뛴 선수(OVR 높은 순). */
  unusedTop: EntryPlayer[];
  /** unusedTop의 출전 시간 합(초). */
  unusedTopSec: number;
  /** 선발 5인이 소화한 시간 / 팀 전체 출전 시간. 표본이 없으면 null. */
  starterShare: number | null;
  /** 엔트리 발표 시점에 이미 빠져 있던 선수 이름 - 엔트리 기준 예측이 **이미 반영한** 결장자. */
  absentBeforeEntry: string[];
};

export type EntryUsage = {
  kind: "entry_usage";
  sides: EntryUsageSide[];
  /** 엔트리 기준 예측의 홈 승률(0~1). 없으면 null. */
  lineupProb: number | null;
  home: ReportTeamMeta;
  away: ReportTeamMeta;
  /** 이 경기에서 진 팀. 문장이 "예측이 깨진 이유"를 이 팀 쪽으로 붙인다. */
  loserTcode: string;
};

export type EntryUsageInput = {
  home: ReportTeamMeta;
  away: ReportTeamMeta;
  /** 팀별 엔트리(= 그 경기 game_player_stats에 행이 있는 선수 전원). */
  sides: { team: ReportTeamMeta; players: EntryPlayer[]; absentBeforeEntry: string[] }[];
  lineupProb: number | null;
  loserTcode: string;
};

/** OVR 내림차순(없는 선수는 뒤로). 동점이면 출전 시간이 긴 쪽을 앞에 둔다(안정 정렬). */
function byOvrDesc(a: EntryPlayer, b: EntryPlayer): number {
  const av = a.ovr ?? -1;
  const bv = b.ovr ?? -1;
  return bv - av || b.onSec - a.onSec;
}

function computeSide(input: EntryUsageInput["sides"][number]): EntryUsageSide {
  const { team, players, absentBeforeEntry } = input;
  const ranked = [...players].sort(byOvrDesc);
  const unusedTop = ranked.slice(0, ENTRY_TOP_N).filter((p) => p.onSec < ENTRY_BARELY_PLAYED_SEC);
  const totalSec = players.reduce((s, p) => s + p.onSec, 0);
  const starterSec = players.filter((p) => p.isStarter).reduce((s, p) => s + p.onSec, 0);
  return {
    team,
    unusedTop,
    unusedTopSec: unusedTop.reduce((s, p) => s + p.onSec, 0),
    starterShare: totalSec > 0 ? starterSec / totalSec : null,
    absentBeforeEntry,
  };
}

/**
 * 이 팀에 대해 "엔트리를 못 썼다"고 말할 만한가.
 *
 * 상위 6인 중 **한 명**이 안 뛴 것만으로는 부족하다(실측 반례 S49G14N4: 장재석 OVR 81 한 명이
 * 0분이었지만 선발 시간 비중은 66%로 정규시즌 중앙값 65%와 같았다 - 6번째 전력을 하루 쉬게
 * 하는 건 흔한 일이고, 그걸로 "예측이 깨진 이유"라고 쓰면 과장이다. 0분 출전은 정규시즌
 * 팀-경기당 평균 1.51명이다).
 *
 * 둘 중 하나여야 한다:
 *  - 상위 6인 중 **둘 이상**이 사실상 안 뛰었다.
 *  - **선발**이 사실상 안 뛰었다(정규시즌 팀-경기의 11.7%뿐인 꼬리 - ENTRY_BARELY_PLAYED_SEC).
 */
function isNotable(side: EntryUsageSide): boolean {
  return side.unusedTop.length >= 2 || side.unusedTop.some((p) => p.isStarter);
}

/**
 * 말할 거리가 있는 팀만 남긴다. 아무 팀도 남지 않으면 null(섹션을 아예 안 만든다).
 *
 * 판정 기준은 "OVR 상위 전력이 사실상 안 뛰었나"이고, 인원 수 자체는 쓰지 않는다
 * (위 ENTRY_TOP_N·isNotable 주석).
 */
export function computeEntryUsage(input: EntryUsageInput): EntryUsage | null {
  const sides = input.sides.map(computeSide).filter(isNotable);
  if (!sides.length) return null;
  return {
    kind: "entry_usage",
    sides,
    lineupProb: input.lineupProb,
    home: input.home,
    away: input.away,
    loserTcode: input.loserTcode,
  };
}
