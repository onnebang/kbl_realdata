import type { ReportTeamMeta } from "./renderKit";

// ---------------------------------------------------------------------------
// 주가 변동 리포트 (8.10, Player Stock Up & Down)
//
// 이 경기에서 게임스코어가 가장 높았던 한 명(상한가)과 가장 낮았던 한 명(하한가). 둘 다
// 있을 때만 섹션을 만든다 - 한쪽만 있으면 "누구는 잘했다"나 "누구는 못했다" 한 줄이 되어
// 대비라는 이 섹션의 취지가 사라진다(원본 조건 그대로).
//
// aceDuel.ts/unsungHero.ts와 같이 render* 함수가 없다 - 문장은
// components/report/StockWatchSection.tsx가 JSX로 만든다.
//
// 한계: 게임스코어는 한 경기 박스스코어만 보는 지표라 수비 기여나 상대 수준을 모른다.
// "다음 라운드 OVR 급상승이 유력" 같은 문구는 그 한 경기에 대한 말이지 예측이 아니다.
// ---------------------------------------------------------------------------

/** 상한가로 부를 최소 게임스코어. 인라인 상수였던 15 그대로. */
export const STOCK_UP_MIN_GS = 15;
/** 하한가로 부를 최대 게임스코어. 인라인 상수였던 5 그대로. */
export const STOCK_DOWN_MAX_GS = 5;
/**
 * 하한가 자격 - 셋 중 하나는 넘겨야 한다(인라인 상수였던 5/3/4 그대로). 게임스코어가 낮은 건
 * 거의 안 뛴 선수도 마찬가지라, 이 조건이 없으면 "2분 뛴 백업"이 매 경기 하한가로 찍힌다.
 */
export const STOCK_DOWN_MIN_FGA = 5;
export const STOCK_DOWN_MIN_TURNOVERS = 3;
export const STOCK_DOWN_MIN_FOULS = 4;

/**
 * 후보 한 명. team은 tcode로 찾은 메타이고, 홈/원정 어느 쪽도 아니면 null이다(이 경기
 * 박스스코어라 실제로는 일어나지 않지만, 원본 playerTag()/liOpen()이 그 경우 칩과 색 없이
 * 이름만 찍었으므로 타입으로 남겨 컴포넌트가 같은 폴백을 하게 둔다).
 *
 * gameScore는 호출부가 이미 재서 넘긴다 - 정렬 비교자 안에서 부르면 한 명의 점수가
 * O(log n)번 다시 계산된다.
 */
export type StockCandidate = {
  pcode: string;
  team: ReportTeamMeta | null;
  name: string;
  pts: number;
  reb: number;
  ast: number;
  fgm: number;
  fga: number;
  turnovers: number;
  fouls: number;
  gameScore: number;
};

/** 상한가 - 문장이 쓰는 스탯만. */
export type StockUp = {
  team: ReportTeamMeta | null;
  name: string;
  pts: number;
  reb: number;
  ast: number;
  gameScore: number;
};
/**
 * 하한가 - 문장이 쓰는 스탯만.
 *
 * turnovers/fouls는 값이 아니라 **말할 만한 값일 때만** 문장에 나간다. 예전엔 턴오버를 무조건
 * 나열해서 "턴오버 0개에 그치며 유독 고전했습니다"가 배포돼 있었다(2026-09-30 실측, 정인덕 -
 * 턴오버 0은 잘한 것이다). 하한가로 걸린 사유(downQualifies)와 문장이 드는 근거가 같아야 한다.
 */
export type StockDown = {
  team: ReportTeamMeta | null;
  name: string;
  pts: number;
  fgm: number;
  fga: number;
  /** STOCK_DOWN_MIN_TURNOVERS 미만이면 null - 문장에 넣지 않는다. */
  turnovers: number | null;
  /** STOCK_DOWN_MIN_FOULS 미만이면 null - 문장에 넣지 않는다. */
  fouls: number | null;
};

export type StockWatch = { kind: "stock_watch"; up: StockUp; down: StockDown };

/** 기록이 하나라도 있는 선수만 후보다(안 뛴 선수를 하한가로 잡지 않는다). */
function played(c: StockCandidate): boolean {
  return c.pts > 0 || c.fga > 0 || c.reb > 0 || c.ast > 0;
}

function downQualifies(c: StockCandidate): boolean {
  return c.fga >= STOCK_DOWN_MIN_FGA || c.turnovers >= STOCK_DOWN_MIN_TURNOVERS || c.fouls >= STOCK_DOWN_MIN_FOULS;
}

/** 둘 중 하나라도 없거나 같은 선수면 null(섹션을 아예 안 만든다). */
export function computeStockWatch(candidates: StockCandidate[]): StockWatch | null {
  // 동점 처리: sort는 안정 정렬이라 같은 점수면 박스스코어 순서가 유지된다. 하한가는 그
  // 배열을 뒤집어 훑으므로 동점이면 박스스코어 **뒤쪽** 선수가 걸린다 - 원본과 같은 순서다.
  const sortedDesc = candidates.filter(played).sort((a, b) => b.gameScore - a.gameScore);
  const up = sortedDesc.find((c) => c.gameScore >= STOCK_UP_MIN_GS);
  const down = [...sortedDesc].reverse().find((c) => downQualifies(c) && c.gameScore <= STOCK_DOWN_MAX_GS);
  if (!up || !down || up.pcode === down.pcode) return null;
  return {
    kind: "stock_watch",
    up: { team: up.team, name: up.name, pts: up.pts, reb: up.reb, ast: up.ast, gameScore: up.gameScore },
    down: {
      team: down.team,
      name: down.name,
      pts: down.pts,
      fgm: down.fgm,
      fga: down.fga,
      turnovers: down.turnovers >= STOCK_DOWN_MIN_TURNOVERS ? down.turnovers : null,
      fouls: down.fouls >= STOCK_DOWN_MIN_FOULS ? down.fouls : null,
    },
  };
}
