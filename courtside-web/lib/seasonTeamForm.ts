import type { SeasonGameRow, SeasonTeamRef } from "./seasonBrowser";

// 시즌 브라우저(components/SeasonBrowserBoard)의 "팀별 보기" 계산. 순수 함수만 둔다 -
// lib/seasonBrowser.ts는 supabaseServer를 import하므로 클라이언트 컴포넌트가 값을 가져오면
// 서버 코드가 번들에 딸려온다(type import는 지워져서 안전).
// 경기 목록은 서버가 game_date, gmkey 오름차순으로 준다 - 최근 폼/연속은 그 순서를 믿는다.

export type TeamRef = NonNullable<SeasonTeamRef>;
export type Result = "W" | "L";

export type TeamLine = {
  tcode: string;
  team: TeamRef;
  w: number;
  l: number;
  /** 0~1. 경기가 없으면 0. */
  pct: number;
  /** 누적 득실차. */
  diff: number;
  /** 경기당 득점 / 실점. */
  pf: number;
  pa: number;
  home: { w: number; l: number };
  away: { w: number; l: number };
  /** 최근 5경기, 오래된 순 → 최신 순. */
  form: Result[];
  streak: { type: Result; n: number } | null;
};

export const FORM_LENGTH = 5;

/** 목록에 등장하는 팀(tcode 중복 제거, 처음 등장한 참조를 유지). */
export function listTeams(games: SeasonGameRow[]): TeamRef[] {
  const seen = new Map<string, TeamRef>();
  for (const g of games) {
    for (const t of [g.home_team, g.away_team]) {
      if (t && !seen.has(t.tcode)) seen.set(t.tcode, t);
    }
  }
  return Array.from(seen.values());
}

/** 한 팀 기준으로 본 경기. tcode가 이 경기의 팀이 아니면 원정 취급이 되니 호출부가 걸러서 부른다. */
export function perspective(game: SeasonGameRow, tcode: string) {
  const isHome = game.home_team?.tcode === tcode;
  const us = (isHome ? game.home_score : game.away_score) ?? 0;
  const them = (isHome ? game.away_score : game.home_score) ?? 0;
  return { isHome, us, them, opp: isHome ? game.away_team : game.home_team, won: us > them };
}

export function involves(game: SeasonGameRow, tcode: string): boolean {
  return game.home_team?.tcode === tcode || game.away_team?.tcode === tcode;
}

/**
 * teams 전원에 대한 전적 한 줄씩. 경기가 없는 팀도 0전적으로 포함한다(팀 선택 레일이 구분 필터를
 * 바꿔도 팀 목록이 흔들리지 않도록). 정렬은 시즌 홈 순위와 같다: 경기한 팀 먼저, 승률, 득실차.
 * 점수가 없거나 같은(진행 중) 경기는 건너뛴다.
 */
export function buildTeamLines(games: SeasonGameRow[], teams: TeamRef[]): TeamLine[] {
  const acc = new Map(
    teams.map((team) => [
      team.tcode,
      { team, w: 0, l: 0, pf: 0, pa: 0, home: { w: 0, l: 0 }, away: { w: 0, l: 0 }, seq: [] as Result[] },
    ])
  );

  for (const g of games) {
    if (g.home_score == null || g.away_score == null || g.home_score === g.away_score) continue;
    for (const t of [g.home_team, g.away_team]) {
      const a = t ? acc.get(t.tcode) : undefined;
      if (!t || !a) continue;
      const p = perspective(g, t.tcode);
      const split = p.isHome ? a.home : a.away;
      a.pf += p.us;
      a.pa += p.them;
      a.seq.push(p.won ? "W" : "L");
      if (p.won) {
        a.w += 1;
        split.w += 1;
      } else {
        a.l += 1;
        split.l += 1;
      }
    }
  }

  return Array.from(acc.values())
    .map(({ team, w, l, pf, pa, home, away, seq }): TeamLine => {
      const played = w + l;
      const last = seq[seq.length - 1];
      let n = 0;
      while (n < seq.length && seq[seq.length - 1 - n] === last) n += 1;
      return {
        tcode: team.tcode,
        team,
        w,
        l,
        pct: played ? w / played : 0,
        diff: pf - pa,
        pf: played ? pf / played : 0,
        pa: played ? pa / played : 0,
        home,
        away,
        form: seq.slice(-FORM_LENGTH),
        streak: last ? { type: last, n } : null,
      };
    })
    .sort(
      (a, b) =>
        Number(b.w + b.l > 0) - Number(a.w + a.l > 0) ||
        b.pct - a.pct ||
        b.diff - a.diff ||
        a.team.name.localeCompare(b.team.name, "ko")
    );
}

/** "2026-10-12" -> "월". 로컬 날짜로 만들어 시간대에 따라 하루 밀리지 않게 한다. */
export function koDayOfWeek(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return "일월화수목금토".charAt(new Date(y, m - 1, d).getDay());
}

const CATEGORY_ORDER = ["정규시즌", "플레이오프", "챔피언결정전"];

/** 정규시즌 → 플레이오프 → 챔피언결정전 순으로, 그 밖의 구분(OPEN MATCH DAY 등)은 등장 순서대로 뒤에. */
export function orderCategories(categories: string[]): string[] {
  const known = CATEGORY_ORDER.filter((c) => categories.indexOf(c) >= 0);
  return known.concat(categories.filter((c) => CATEGORY_ORDER.indexOf(c) < 0));
}

export function categoryLabel(category: string): string {
  return category === "OPEN MATCH DAY" ? "오픈 매치데이" : category;
}

/** 경기 카드의 작은 꼬리표. 정규시즌은 기본값이라 표시하지 않는다. */
export function categoryTag(category: string): string | null {
  if (category === "정규시즌") return null;
  if (category === "플레이오프") return "PO";
  if (category === "챔피언결정전") return "CP";
  if (category === "OPEN MATCH DAY") return "OMD";
  return category;
}
