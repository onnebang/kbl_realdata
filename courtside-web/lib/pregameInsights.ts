import { eunNeun, iGa } from "./josa";

// pregame_features 테이블(tools/migrate_pregame_features_to_supabase.py로 이관) 한 행 -
// courtside_template.html의 pregameInsightItems()가 실제로 읽는 필드만 좁혀서 옮김.
export type PregameFeatures = {
  home_reb_rt: number | null;
  away_reb_rt: number | null;
  home_tov_rt: number | null;
  away_tov_rt: number | null;
  home_ts_rt: number | null;
  away_ts_rt: number | null;
  home_pace: number | null;
  away_pace: number | null;
  home_last3_netrtg: number | null;
  away_last3_netrtg: number | null;
  home_last10_netrtg: number | null;
  away_last10_netrtg: number | null;
  home_venue_netrtg: number | null;
  away_venue_netrtg: number | null;
  home_netrtg: number | null;
  away_netrtg: number | null;
  home_roster_continuity: number | null;
  away_roster_continuity: number | null;
  home_run_vuln_big_runs: number | null;
  away_run_vuln_big_runs: number | null;
  home_foreign_concentration: number | null;
  away_foreign_concentration: number | null;
  home_foreign_player_count: number | null;
  away_foreign_player_count: number | null;
  home_avg_height_cm: number | null;
  away_avg_height_cm: number | null;
  home_avg_vertical_jump_cm: number | null;
  away_avg_vertical_jump_cm: number | null;
  home_vertical_jump_coverage: number | null;
  away_vertical_jump_coverage: number | null;
  /**
   * 경기 전 모델(pregame_model.joblib)의 승률. tools/sync_upcoming_games.py가 적재한다.
   *
   * 2026-09-30 정정: 예전 주석은 "종료 경기는 game_events의 event_order=0 행이 같은 역할이라
   * 과거 행에선 null"이라고 적어 뒤 있었는데 **둘 다 틀렸다.**
   *  - null이 아니다: 이 스크립트를 거친 경기는 끝난 뒤에도 값이 남는다(지우지 않는다 -
   *    저장된 피처로는 재계산이 불가능해서, 지우면 경기 전 예측 기록이 영구히 사라진다).
   *  - 같은 역할이 아니다: game_events PRE행은 **라이브 모델을 0-0·풀타임 잔여 상태로 평가한
   *    값**(피처 5개)이고 이쪽은 경기 전 모델(팀당 피처 30개)이다. 실측 S49G14N4에서 0.4977
   *    대 0.6397로 우세팀이 반대였다.
   * 그래서 이 값과 PRE행을 `??`로 이어 "하나의 경기 전 승률"처럼 쓰면 경기 시작 시점에 모델이
   * 조용히 바뀐다. 적중/빗나감 판정은 lib/predictionVerdict.ts 한 곳에서만 하고, 두 값이 서로
   * 다른 팀을 우세로 볼 때는 리포트가 그 사실을 드러낸다(PredictionAuditSection의 modelSplit).
   * 역사적 경기(4,182건)는 이 스크립트가 생기기 전이라 여전히 null이다.
   */
  home_win_prob: number | null;
};

// courtside_template.html의 pregameInsightItems()를 그대로 포팅 - "차이가 유의미할 때만
// 문장 생성" 원칙(renderZoneDominance 패턴)까지 동일. 임계값도 원본과 동일하게 유지.
// priorSeasonLabel: 이 경기가 그 팀의 이번 시즌 첫 경기여서 아래 "최근 3경기 / 직전 10경기"가
// 실제로는 지난 시즌 경기일 때, 호출자가 "25-26" 같은 라벨을 넘긴다. 넘어오면 해당 문장에
// 시즌을 명시한다 - 개막전 프리뷰가 지난 시즌 폼을 이번 시즌 폼처럼 말하던 문제(실측 지적).
export function pregameInsightItems(
  f: PregameFeatures,
  homeTname: string,
  awayTname: string,
  priorSeasonLabel?: string | null
): string[] {
  const lines: string[] = [];

  if (f.home_reb_rt != null && f.away_reb_rt != null) {
    const d = f.home_reb_rt - f.away_reb_rt;
    if (Math.abs(d) >= 3) {
      const team = d > 0 ? homeTname : awayTname;
      lines.push(`리바운드에서 <b>${team}</b> 우위(리바운드율 ${Math.round(Math.abs(d))}%p 차이) - 세컨찬스 싸움을 눈여겨볼 것.`);
    }
  }

  if (f.home_tov_rt != null && f.away_tov_rt != null) {
    const d = f.away_tov_rt - f.home_tov_rt;
    if (Math.abs(d) >= 2) {
      const team = d > 0 ? homeTname : awayTname;
      lines.push(`턴오버 관리에서 <b>${team}</b> 우위(턴오버율 ${Math.abs(d).toFixed(1)}%p 차이) - 볼 소유권 싸움에서 유리할 가능성.`);
    }
  }

  if (f.home_ts_rt != null && f.away_ts_rt != null) {
    const d = f.home_ts_rt - f.away_ts_rt;
    if (Math.abs(d) >= 2) {
      const team = d > 0 ? homeTname : awayTname;
      lines.push(`슈팅 효율(TS%)에서 <b>${team}</b> 우위(${Math.abs(d).toFixed(1)}%p 차이).`);
    }
  }

  if (f.home_pace != null && f.away_pace != null) {
    const d = Math.abs(f.home_pace - f.away_pace);
    if (d >= 3) {
      const fast = f.home_pace > f.away_pace ? homeTname : awayTname;
      const slow = f.home_pace > f.away_pace ? awayTname : homeTname;
      lines.push(`템포 스타일 충돌 - <b>${fast}</b>${eunNeun(fast)} 빠른 템포, <b>${slow}</b>${eunNeun(slow)} 느린 템포(포제션당 ${d.toFixed(1)}회 차이) - 누가 자기 페이스로 끌고 가는지가 관건.`);
    }
  }

  for (const [last3, last10, name] of [
    [f.home_last3_netrtg, f.home_last10_netrtg, homeTname],
    [f.away_last3_netrtg, f.away_last10_netrtg, awayTname],
  ] as const) {
    if (last3 == null || last10 == null) continue;
    const d = last3 - last10;
    if (Math.abs(d) >= 5) {
      const dir = d > 0 ? "상승세" : "하락세";
      const scope = priorSeasonLabel ? `지난 시즌(${priorSeasonLabel}) 마지막 3경기` : "최근 3경기";
      lines.push(`<b>${name}</b> ${scope} 넷레이팅이 직전 10경기 평균 대비 뚜렷한 ${dir}(${fmtRating(last3)} vs ${fmtRating(last10)}).`);
    }
  }

  if (f.home_venue_netrtg != null && f.home_netrtg != null) {
    const d = f.home_venue_netrtg - f.home_netrtg;
    if (Math.abs(d) >= 5) {
      const dir = d > 0 ? "안방에서 유독 강함" : "안방에서 유독 부진";
      lines.push(`<b>${homeTname}</b>${eunNeun(homeTname)} 이 홈구장에서 ${dir}(구장 넷레이팅 ${fmtRating(f.home_venue_netrtg)} vs 전체 ${fmtRating(f.home_netrtg)}).`);
    }
  }

  for (const [big, name, oppName] of [
    [f.home_run_vuln_big_runs, homeTname, awayTname],
    [f.away_run_vuln_big_runs, awayTname, homeTname],
  ] as const) {
    if (big == null) continue;
    if (big >= 2) {
      lines.push(`<b>${name}</b>${eunNeun(name)} 최근 상대에게 8점 이상 런을 경기당 평균 ${big.toFixed(1)}회 허용 - <b>${oppName}</b>${iGa(oppName)} 몰아치기 시작하면 위험할 수 있음.`);
    }
  }

  if (f.home_roster_continuity != null && f.away_roster_continuity != null) {
    const d = f.home_roster_continuity - f.away_roster_continuity;
    if (Math.abs(d) >= 0.15) {
      const stable = d > 0 ? homeTname : awayTname;
      const changed = d > 0 ? awayTname : homeTname;
      lines.push(`로스터 안정성 차이 - <b>${stable}</b>${eunNeun(stable)} 지난 시즌 주축을 그대로 유지, <b>${changed}</b>${eunNeun(changed)} 변화 폭이 더 큼.`);
    }
  }

  for (const [conc, count, name] of [
    [f.home_foreign_concentration, f.home_foreign_player_count, homeTname],
    [f.away_foreign_concentration, f.away_foreign_player_count, awayTname],
  ] as const) {
    if (conc == null || count == null) continue;
    if (count >= 2 && conc >= 0.75) {
      lines.push(`<b>${name}</b>${eunNeun(name)} 외국선수 의존도가 높은 '1옵션 집중형' - 그 선수를 묶으면 공격 전체가 흔들릴 수 있음.`);
    }
  }

  if (f.home_avg_height_cm != null && f.away_avg_height_cm != null) {
    const d = f.home_avg_height_cm - f.away_avg_height_cm;
    if (Math.abs(d) >= 3) {
      const taller = d > 0 ? homeTname : awayTname;
      lines.push(`평균 신장에서 <b>${taller}</b>${iGa(taller)} ${Math.abs(d).toFixed(1)}cm 더 큼 - 골밑 싸움에 영향을 줄 수 있음.`);
    }
  }
  if (
    f.home_avg_vertical_jump_cm != null &&
    f.away_avg_vertical_jump_cm != null &&
    (f.home_vertical_jump_coverage ?? 0) >= 0.5 &&
    (f.away_vertical_jump_coverage ?? 0) >= 0.5
  ) {
    const d = f.home_avg_vertical_jump_cm - f.away_avg_vertical_jump_cm;
    if (Math.abs(d) >= 5) {
      const higher = d > 0 ? homeTname : awayTname;
      lines.push(`평균 버티컬 점프에서 <b>${higher}</b>${iGa(higher)} 우위(${Math.abs(d).toFixed(1)}cm 차이) - 리바운드·블록 경합에서 유리할 수 있음.`);
    }
  }

  return lines;
}

function fmtRating(r: number): string {
  return `${r > 0 ? "+" : ""}${r.toFixed(1)}`;
}
