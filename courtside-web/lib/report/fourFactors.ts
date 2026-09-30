import type { ReportTeamMeta } from "./renderKit";

// ---------------------------------------------------------------------------
// 네 가지 요인 & 득점 출처 (Four Factors / Scoring Mix)
//
// 왜 만들었나 (2026-09-30, S49G14N4 실측): 그 경기는 LG 88 : 82 KCC였는데, 6점 차를 만든
// 것은 **자유투였다** - LG 21/28, KCC 11/16으로 자유투 득점만 +10점(마진보다 크다). 파울은
// 19 대 25였고, 3점은 오히려 LG가 6점 밀렸다. 그런데 리포트 22개 절 어디에도 자유투와 파울이
// 한 번도 나오지 않았다. 슛 구역·라인업·클러치는 다 말하면서 승패의 실제 원인을 빼먹고 있었다.
//
// 새 쿼리는 필요 없다 - page.tsx가 game_team_stats를 이미 받아 두고 화면 아래 '팀 스탯' 바에
// 쓰고 있었고(리포트에는 tpm/tpa만 넘기고 있었다), 오펜스 리바운드는 game_events의
// 209/210 코드로 정확히 센다(추정하지 않는다 - 팀 단위 oreb 컬럼은 8,444행 전부 NULL이다).
//
// 판정 원칙: 가중 합성 지표(Oliver의 .40/.25/.20/.15)를 만들지 않는다. 그건 리그 표준편차가
// 있어야 의미가 있고, 한 경기에 적용하면 근거 없는 한 숫자로 뭉개진다. 대신 **점수 단위로
// 환산이 되는 것**(2점/3점/자유투 득점)에서만 "여기서 갈렸다"고 말하고, 네 요인은 숫자를
// 그대로 나란히 보여준다.
// ---------------------------------------------------------------------------

/**
 * game_team_stats 팀 한 행. fgm/fga는 **2점 전용**이다(원본 KBL 소스가 그렇게 나눠 준다) -
 * 전체 야투는 fgm+tpm / fga+tpa. 실측(2026-09-30): `score = fgm*2 + tpm*3 + ftm`이 전체
 * 8,444행 중 8,440행(99.95%)에서 성립한다.
 */
export type TeamStatLine = {
  tcode: string;
  score: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
  reb: number;
  ast: number;
  turnovers: number;
  fouls: number;
  /** 공식 페이스. 아직 정산 안 된 경기는 0으로 들어온다(그때만 추정 폴백). */
  pace: number | null;
};

/** 한 줄 = 한 항목. 막대는 두 팀 값의 비중으로 그린다(page.tsx의 .ts-row와 같은 규칙). */
export type FactorRow = {
  label: string;
  /** 막대 길이용 - 항상 "클수록 막대가 긴" 양수 값. */
  homeBar: number;
  awayBar: number;
  homeDisp: string;
  awayDisp: string;
  /** 부호 있는 홈-원정 차이(문장이 쓴다). 낮을수록 좋은 항목은 부호를 이미 뒤집어 담는다. */
  homeEdge: number;
};

export type ScoringSplit = { label: string; home: number; away: number };

export type FourFactors = {
  kind: "four_factors";
  home: ReportTeamMeta;
  away: ReportTeamMeta;
  factors: FactorRow[];
  /** 2점/3점/자유투 득점 분해 - 합이 곧 최종 점수다. */
  scoring: ScoringSplit[];
  /** 승자가 가장 크게 앞선 득점 출처. */
  decisive: { label: string; pts: number };
  /** 승자가 오히려 밀린 득점 출처들(없으면 빈 배열) - 없으면 "전부 앞섰다"는 뜻. */
  conceded: { label: string; pts: number }[];
  /** 최종 마진(절댓값). decisive와 비교해 읽는다. */
  margin: number;
  winnerIsHome: boolean;
  /** 자유투 시도·파울 - decisive가 자유투일 때 문장이 근거로 든다. */
  ft: { homeFta: number; awayFta: number; homeFouls: number; awayFouls: number };
};

const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;

/** 전체 야투(2점+3점) 성공/시도. fgm/fga가 2점 전용인 걸 한 곳에서만 처리한다. */
function totalFg(t: TeamStatLine) {
  return { made: t.fgm + t.tpm, att: t.fga + t.tpa };
}

/** eFG% = (야투성공 + 0.5×3점성공) ÷ 야투시도. */
export function effectiveFgPct(t: TeamStatLine): number {
  const { made, att } = totalFg(t);
  return att > 0 ? (made + 0.5 * t.tpm) / att : 0;
}

/** TOV% = 턴오버 ÷ 추정 포제션(야투시도 + 0.44×자유투시도 + 턴오버). */
export function turnoverPct(t: TeamStatLine): number {
  const { att } = totalFg(t);
  const denom = att + 0.44 * t.fta + t.turnovers;
  return denom > 0 ? t.turnovers / denom : 0;
}

/** 자유투 의존도 = 자유투 성공 ÷ 야투 시도(Oliver의 FT rate). */
export function ftRate(t: TeamStatLine): number {
  const { att } = totalFg(t);
  return att > 0 ? t.ftm / att : 0;
}

/** ORB% = 내 공격리바운드 ÷ (내 공격리바운드 + 상대 수비리바운드). */
export function orebPct(myOreb: number, oppDreb: number): number {
  const denom = myOreb + oppDreb;
  return denom > 0 ? myOreb / denom : 0;
}

export type FourFactorsInput = {
  home: ReportTeamMeta;
  away: ReportTeamMeta;
  homeStats: TeamStatLine;
  awayStats: TeamStatLine;
  /** game_events 209(공격리바운드)/210(수비리바운드) 실측 집계. 추정값을 넣지 말 것. */
  homeOreb: number;
  homeDreb: number;
  awayOreb: number;
  awayDreb: number;
  homeScore: number;
  awayScore: number;
};

/** 동점이거나 팀 스탯이 비어 있으면 null(섹션을 아예 안 만든다). */
export function computeFourFactors(input: FourFactorsInput): FourFactors | null {
  const { home, away, homeStats: h, awayStats: a, homeScore, awayScore } = input;
  if (homeScore === awayScore) return null;
  // 기록이 아직 안 들어온 경기 - 0으로 채워진 행으로 네 요인을 그리면 전부 50:50 막대가 된다.
  if (totalFg(h).att === 0 || totalFg(a).att === 0) return null;

  const hOrb = orebPct(input.homeOreb, input.awayDreb);
  const aOrb = orebPct(input.awayOreb, input.homeDreb);
  const hTov = turnoverPct(h);
  const aTov = turnoverPct(a);

  const factors: FactorRow[] = [
    {
      label: "eFG%",
      homeBar: effectiveFgPct(h),
      awayBar: effectiveFgPct(a),
      homeDisp: pct1(effectiveFgPct(h)),
      awayDisp: pct1(effectiveFgPct(a)),
      homeEdge: effectiveFgPct(h) - effectiveFgPct(a),
    },
    {
      // 턴오버는 **낮을수록** 좋다. 막대를 값 그대로 그리면 나쁜 팀의 막대가 길어져 거꾸로
      // 읽힌다 - 막대만 (1 - 비율)로 뒤집고, 표시 숫자는 실제 비율을 그대로 쓴다.
      label: "TOV%",
      homeBar: 1 - hTov,
      awayBar: 1 - aTov,
      homeDisp: pct1(hTov),
      awayDisp: pct1(aTov),
      homeEdge: aTov - hTov,
    },
    {
      label: "ORB%",
      homeBar: hOrb,
      awayBar: aOrb,
      homeDisp: pct1(hOrb),
      awayDisp: pct1(aOrb),
      homeEdge: hOrb - aOrb,
    },
    {
      label: "자유투 의존도",
      homeBar: ftRate(h),
      awayBar: ftRate(a),
      homeDisp: pct1(ftRate(h)),
      awayDisp: pct1(ftRate(a)),
      homeEdge: ftRate(h) - ftRate(a),
    },
  ];

  // 득점 출처 - 합이 정확히 최종 점수다(위 score 항등식). 이것만 점수 단위라서 "여기서
  // 갈렸다"고 말할 수 있다.
  const scoring: ScoringSplit[] = [
    { label: "2점 득점", home: h.fgm * 2, away: a.fgm * 2 },
    { label: "3점 득점", home: h.tpm * 3, away: a.tpm * 3 },
    { label: "자유투 득점", home: h.ftm, away: a.ftm },
  ];

  const winnerIsHome = homeScore > awayScore;
  // 승자 기준 득실차로 다시 세운다. 양수면 승자가 그만큼 더 넣은 것.
  const edges = scoring.map((s) => ({ label: s.label, pts: winnerIsHome ? s.home - s.away : s.away - s.home }));
  const decisive = edges.reduce((best, e) => (e.pts > best.pts ? e : best), edges[0]);
  const conceded = edges.filter((e) => e.pts < 0).sort((x, y) => x.pts - y.pts);

  return {
    kind: "four_factors",
    home,
    away,
    factors,
    scoring,
    decisive,
    conceded,
    margin: Math.abs(homeScore - awayScore),
    winnerIsHome,
    ft: { homeFta: h.fta, awayFta: a.fta, homeFouls: h.fouls, awayFouls: a.fouls },
  };
}
