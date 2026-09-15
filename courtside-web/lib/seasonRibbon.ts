import type { GameStatus } from "./gameStatus";
import type { GameTagKey } from "./teamPageData";

// 팀 시즌 리본(프로필 개편 1단계 시그니처, team_profile[6]) - JourneyChart(JSX <svg> 안의 JSX
// <title>은 React 19가 문서 <head>로 끌어올려 툴팁이 사라지는 함정)를 raw SVG 문자열로 재작성.
// 페이지는 <svg dangerouslySetInnerHTML>로 감싼다(히어로 별자리와 같은 방식).
//
// 슬롯 문법(shared_design_language (3)): 칸 하나 = 경기 하나(같은 폭), 채움 = 사실(치른 경기의 점수차
// 막대: 승 = 팀 색 / 패 = --ink-faint), hollow = 아직 없는 것(남은 경기의 고스트 막대: 높이 = 모델
// 승률, 홈 = 채움 / 원정 = 외곽선), 골드 = 업셋·실제 누적 승수. 점선 = 모델 누적 기대승(수록 경기의
// 승률 합 - 승률 없는 경기는 건너뜀), 골드 실선 = 실제 누적 승수(치른 구간만). 두 선을 같은 축(승수)에
// 두는 이유: 같은 시점의 "모델이 기대한 승수 vs 실제 승수"가 한눈에 비교되게 - 승률(0~1)과 기대승(개수)
// 을 한 그림에 섞으면 축이 둘이 된다.
//
// 개막 전 KCC = 고스트 26칸 + 점선 하나 → '아직 읽지 않은 시즌'. 10월부터 왼쪽에서 채워진다.

export type RibbonSlot = {
  gmkey: string;
  gameDate: string; // YYYY-MM-DD
  gameStart: string | null;
  stadium: string | null;
  oppAbbr: string;
  oppName: string;
  isHome: boolean;
  seasonCategory: string;
  status: GameStatus;
  teamScore: number | null;
  oppScore: number | null;
  /** 이 팀 기준 모델 승률(치른 경기 = 경기 시작 시점 game_events, 예정 = pregame_features). 없으면 null. */
  prob: number | null;
  tag: GameTagKey | null;
};

export type RibbonInput = {
  slots: RibbonSlot[];
  /** 승리 막대·고스트 색(lib/teamAccent.ts accentFor - 저명도 팀 색은 보조 액센트). */
  teamColor: string;
  /** '다음 경기' 마커를 달 칸. */
  nextGmkey: string | null;
  /** 팀이 아직 한 경기도 안 치렀을 때 첫 칸에 'D-N' 플래그(null이면 '다음 경기' 마커). */
  openerDday: number | null;
};

export type RibbonStats = {
  n: number;
  played: number;
  wins: number;
  losses: number;
  upsets: number; // 모델이 열세(<0.5)로 본 경기의 승리
  probCoveragePlayed: number; // 치른 경기 중 모델 승률이 있는 수
  expWins: number; // 수록 전 경기 승률 합
  expGames: number; // 승률 있는 경기 수
  remaining: number;
  remainingExp: number; // 남은(예정) 경기 승률 합
  remainingPriced: number;
};

// 높이 252 → 262 → 272: 좁은 화면에서 글자가 38단위까지 커지면 위쪽 띠(월 라벨 · '다음 경기' ·
// PO 라벨)가 플롯을 침범해서 PAD_T를 34 → 44 → 54로 넓혔다(플롯 높이 188은 그대로).
// 38단위 기준 위쪽 띠 검산: 월 라벨 베이스라인 36 → 글자 위끝 5.6(캔버스 안) · 아래끝 43.6,
// 플롯 위쪽 띠 시작이 plotTop-6 = 48이라 안 닿는다. '다음 경기' 라벨은 plotTop-12 = 42.
export const RIBBON_VIEWBOX = { w: 760, h: 272 };

// ── 글자: 뷰박스 단위가 아니라 '렌더 픽셀'을 맞춘다 ────────────────────────────────
// .ribbonSvg는 width:100%이고 지면 폭 = 뷰포트 − 74(.wrap 좌우 36 + .panel 테두리·패딩 38)라
// 렌더 배율 = (뷰포트 − 74)/760이다. 데스크톱(1108px)은 1.46, 375px 모바일은 0.40 - 3.6배
// 차이라 font-size 한 값으로 양쪽을 만족시킬 수 없다(예전 9단위 = 데스크톱 13px·모바일 3.6px).
// 그래서 SVG 안에 <style>을 넣어 뷰포트 폭 구간마다 글자를 갈아끼운다(SVG에서 CSS px = 사용자
// 단위). 각 구간 하단에서의 렌더 픽셀: 1000px→12.2 / 800px→12.4 / 620px→12.2 / 480px→12.3 /
// 401px→13.8 / 320px→12.3. 마지막 ≤400px 구간(38단위)이 iPhone SE 1세대(320px)를 위한 것 -
// 32단위로는 (246/760)×32 = 10.4px밖에 안 나온다. 38단위는 (246/760)×38 = 12.3px.
// 한글이 섞이는 라벨(N월·N승·기대·다음 경기·플레이오프)이 많아 스택에 Pretendard를 넣는다 -
// IBM Plex Mono에는 한글 글리프가 없어 지금까지 조용히 sans-serif로 폴백하고 있었다.
// 글자가 3.2배가 되면 라벨은 반드시 부딪히므로(careerStrip.ts에서 이미 밟은 함정) 크기를
// 되돌리는 대신 라벨 수를 줄인다: 여백 안에 사는 축 눈금·상대 약어·PO 라벨은 .rbbWide로
// 넓은 화면 전용이 되고(툴팁과 호출부 캡션이 같은 사실을 진다), 월 라벨은 32단위 기준 겹침
// 검사로 솎는다. 좁은 화면에서도 남는 글자: 월 라벨(솎은 뒤) · 다음 경기 · LIVE · 기대/승수.
const RB_FS_MAX = 38; // 가장 좁은 구간의 글자. 겹침 검사는 언제나 이 최댓값으로 한다.
const RB_STYLE =
  `<style>.rbb{font-family:"IBM Plex Mono","Pretendard",monospace;font-size:10px}` +
  `@media(max-width:999px){.rbb{font-size:13px}.rbbWide{display:none}}` +
  `@media(max-width:799px){.rbb{font-size:17px}}` +
  `@media(max-width:619px){.rbb{font-size:23px}}` +
  `@media(max-width:479px){.rbb{font-size:32px}}` +
  `@media(max-width:400px){.rbb{font-size:38px}}</style>`;

/** 대략 폭(기본은 가장 좁은 구간의 32단위) - 한글 글리프 1em, 라틴·숫자 0.62em(careerStrip.ts와 같은 근사). */
function rbTextW(s: string, fs: number = RB_FS_MAX): number {
  return [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 127 ? 1 : 0.62) * fs, 0);
}

/** 플롯 위에 떠서 데이터와 겹칠 수 있는 라벨용 배경 후광(scatter의 선수 이름표와 같은 수법). */
const RB_HALO = `paint-order="stroke" stroke="var(--surface)" stroke-width="3" stroke-linejoin="round"`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
function md(date: string): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  return `${date.slice(5, 7)}.${date.slice(8, 10)}(${WEEKDAY[d.getUTCDay()]})`;
}

const TAG_LABEL: Record<GameTagKey, string> = { nailbiter: "박빙 접전", blowout: "압도적 승리", comeback: "짜릿한 역전승" };

export function buildSeasonRibbonSvg(input: RibbonInput): { svg: string; stats: RibbonStats } | null {
  const { slots, teamColor } = input;
  const n = slots.length;
  if (!n) return null;

  const W = RIBBON_VIEWBOX.w,
    H = RIBBON_VIEWBOX.h,
    PAD_L = 26,
    PAD_R = 40,
    PAD_T = 54,
    PAD_B = 30;
  const plotTop = PAD_T,
    plotBot = H - PAD_B,
    plotH = plotBot - plotTop;
  const plotW = W - PAD_L - PAD_R;
  const bw = plotW / n;
  const zeroY = plotTop + plotH * 0.52;
  const halfUp = (zeroY - plotTop) * 0.95;
  const halfDown = (plotBot - zeroY) * 0.95;

  const played = slots.filter((s) => s.status === "final" && s.teamScore != null && s.oppScore != null);
  const margins = played.map((s) => (s.teamScore as number) - (s.oppScore as number));
  const maxAbs = Math.max(10, ...margins.map((m) => Math.abs(m)));
  const yMargin = (m: number) => (m >= 0 ? zeroY - (m / maxAbs) * halfUp : zeroY + (-m / maxAbs) * halfDown);
  const yWins = (w: number) => plotBot - (w / n) * plotH;
  const cx = (i: number) => PAD_L + i * bw + bw / 2;

  // 통계(범례·캡션용)
  const stats: RibbonStats = {
    n,
    played: played.length,
    wins: 0,
    losses: 0,
    upsets: 0,
    probCoveragePlayed: 0,
    expWins: 0,
    expGames: 0,
    remaining: 0,
    remainingExp: 0,
    remainingPriced: 0,
  };

  const parts: string[] = [RB_STYLE];
  parts.push(
    `<defs><pattern id="rbHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(var(--line-rgb),0.14)" stroke-width="2"/></pattern></defs>`
  );

  // PO 구간 띠(연속 PO 칸을 하나의 빗금 밴드로)
  let poStart = -1;
  for (let i = 0; i <= n; i++) {
    const isPo = i < n && slots[i].seasonCategory !== "정규시즌";
    if (isPo && poStart < 0) poStart = i;
    if ((!isPo || i === n) && poStart >= 0) {
      const x0 = PAD_L + poStart * bw,
        x1 = PAD_L + i * bw;
      parts.push(`<rect x="${x0.toFixed(1)}" y="${plotTop - 6}" width="${(x1 - x0).toFixed(1)}" height="${plotH + 6}" fill="url(#rbHatch)"/>`);
      // PO 라벨은 좁은 화면(32단위 = 5글자 160단위)에서 띠보다 길어져 캔버스를 넘으므로 넓은
      // 화면 전용. 빗금 띠와 칸 툴팁("· 플레이오프")이 좁은 화면에서 같은 사실을 진다.
      parts.push(
        `<text x="${(x0 + 3).toFixed(1)}" y="${plotTop - 10}" class="rbb rbbWide" font-weight="700" fill="rgba(var(--line-rgb),0.6)">${esc(
          slots[poStart].seasonCategory
        )}</text>`
      );
      poStart = -1;
    }
  }

  // '다음 경기'(D-N) 라벨이 차지할 x 띠 - 월 라벨과 같은 줄이라 미리 잡아 두고 겹치는 월
  // 라벨을 넓은 화면 전용으로 내린다.
  const nextIdx = input.nextGmkey ? slots.findIndex((s) => s.gmkey === input.nextGmkey) : -1;
  const nextLabel =
    nextIdx < 0
      ? ""
      : input.openerDday != null
        ? input.openerDday > 0
          ? `D-${input.openerDday}`
          : "D-DAY"
        : slots[nextIdx].status === "live"
          ? "진행 중"
          : "다음 경기";
  const nextHalf = nextLabel ? rbTextW(nextLabel) / 2 + 4 : 0;
  const nextL = nextLabel ? cx(nextIdx) - nextHalf : Infinity;
  const nextR = nextLabel ? cx(nextIdx) + nextHalf : -Infinity;

  // 월 구분선 + 월 라벨(첫 칸 포함). 구분선은 전부 남기고 라벨만 솎는다 - 좁은 화면 글자
  // (32단위)에서 이웃 라벨이나 '다음 경기' 라벨과 부딪히면 그 라벨만 rbbWide(넓은 화면 전용),
  // 넓은 화면 글자(10단위)에서도 부딪히면(한 달에 한 경기 같은 경우) 아예 안 그린다.
  let mEndWide = -1e9;
  let mEndNarrow = -1e9;
  for (let i = 0; i < n; i++) {
    const m = slots[i].gameDate.slice(5, 7);
    const prevM = i > 0 ? slots[i - 1].gameDate.slice(5, 7) : null;
    if (prevM === m) continue;
    const x = PAD_L + i * bw;
    if (i > 0) parts.push(`<line x1="${x.toFixed(1)}" y1="${plotTop - 6}" x2="${x.toFixed(1)}" y2="${plotBot}" stroke="rgba(var(--line-rgb),0.22)" stroke-width="1" stroke-dasharray="2 3"/>`);
    const label = `${parseInt(m, 10)}월`;
    let lx = x + 3;
    // 가시성 제보 - 넓은 화면에서 첫 달 라벨("10월")이 개막 D-N 라벨과 같은 줄에 겹쳐 찍혔다
    // (좁은 화면 검사만 있었다). 넓은 화면 글자 기준으로도 겹치면 D-N 라벨 오른쪽으로 비켜 쓴다.
    if (nextLabel) {
      const wideHalf = rbTextW(nextLabel, 10) / 2 + 4;
      const nL = cx(nextIdx) - wideHalf,
        nR = cx(nextIdx) + wideHalf;
      if (lx < nR && lx + rbTextW(label, 10) > nL) lx = nR + 2;
    }
    if (lx < mEndWide) continue;
    mEndWide = lx + rbTextW(label, 10) + 4;
    const narrowW = rbTextW(label);
    const narrowOk = lx >= mEndNarrow && (lx + narrowW < nextL || lx > nextR);
    if (narrowOk) mEndNarrow = lx + narrowW + 4;
    // 베이스라인 36 = PAD_T(54) − 18: 38단위 글자의 위끝(0.8em)이 캔버스 안에, 아래끝이
    // 플롯 위쪽 띠(plotTop−6) 위에 오는 자리. PAD_T와 같이 움직인다.
    parts.push(`<text x="${lx.toFixed(1)}" y="${plotTop - 18}" class="rbb${narrowOk ? "" : " rbbWide"}" fill="rgba(var(--line-rgb),0.55)">${label}</text>`);
  }

  // 기준선: 점수차 0(치른 구간) / 고스트 50% 눈금
  parts.push(`<line x1="${PAD_L}" y1="${zeroY.toFixed(1)}" x2="${W - PAD_R}" y2="${zeroY.toFixed(1)}" stroke="rgba(var(--line-rgb),0.35)" stroke-width="1"/>`);
  const y50 = zeroY - 0.5 * halfUp;
  parts.push(`<line x1="${PAD_L}" y1="${y50.toFixed(1)}" x2="${W - PAD_R}" y2="${y50.toFixed(1)}" stroke="rgba(var(--line-rgb),0.18)" stroke-width="0.6" stroke-dasharray="2 4"/>`);
  // 가시성 제보 - 승수 누적선(점선·골드)이 막대 축(점수차·확률)과 완전히 다른 축이라 붕 떠
  // 보였다. 오른쪽 "N승/0" 두 글자만으로는 그 사이 값을 가늠할 기준이 없어서, 승수 격자선을
  // 옅게 깔아 준다 - 텍스트가 아니라 선이라 좁은 화면에서도 넘치지 않는다(rbbWide 문턱 없음).
  const winStep = Math.max(5, Math.round(n / 6 / 5) * 5);
  for (let w = winStep; w < n; w += winStep) {
    const gy = yWins(w);
    parts.push(`<line x1="${PAD_L}" y1="${gy.toFixed(1)}" x2="${W - PAD_R}" y2="${gy.toFixed(1)}" stroke="rgba(var(--line-rgb),0.1)" stroke-width="0.6" stroke-dasharray="1 3"/>`);
    parts.push(`<text x="${W - PAD_R + 4}" y="${(gy + 3).toFixed(1)}" class="rbb rbbWide" fill="rgba(var(--line-rgb),0.38)">${w}</text>`);
  }
  // 축 눈금(왼쪽 점수차·50% / 오른쪽 승수)은 좌우 여백(26·40단위) 안에 사는 글자라 넓은 화면
  // 전용이다: 좁은 화면 32단위에서는 "50%"만 60단위로 여백의 두 배를 넘어 플롯을 덮는다.
  // 좁은 화면에서는 눈금 대신 아래 두 헤드라인 숫자(기대 · 실제 승수)와 칸 툴팁·캡션이 남는다.
  parts.push(`<text x="2" y="${(y50 + 3).toFixed(1)}" class="rbb rbbWide" fill="rgba(var(--line-rgb),0.5)">50%</text>`);
  // 점수차 눈금은 치른 경기가 있을 때만 - 개막 전(전 칸 고스트)엔 점수차 막대가 하나도 없어서 "±10"이
  // 아무것도 가리키지 않고, 아래쪽 "-10"이 기대승 점선 옆에 붙어 그 선의 축처럼 읽혔다(가시성 제보).
  if (played.length) {
    parts.push(`<text x="2" y="${(yMargin(maxAbs) + 7).toFixed(1)}" class="rbb rbbWide" fill="rgba(var(--line-rgb),0.5)">+${maxAbs}</text>`);
    parts.push(`<text x="2" y="${yMargin(-maxAbs).toFixed(1)}" class="rbb rbbWide" fill="rgba(var(--line-rgb),0.5)">-${maxAbs}</text>`);
  }
  // 오른쪽 승수 축(누적선용)
  parts.push(`<text x="${W - PAD_R + 4}" y="${plotTop + 3}" class="rbb rbbWide" fill="rgba(var(--line-rgb),0.5)">${n}승</text>`);
  parts.push(`<text x="${W - PAD_R + 4}" y="${plotBot + 3}" class="rbb rbbWide" fill="rgba(var(--line-rgb),0.5)">0</text>`);

  // 상대 약어도 넓은 화면 전용(좁은 화면 32단위면 3글자가 60단위 = 칸 폭의 두 배 이상).
  // 넓은 화면 10단위에서도 3글자 18.6단위 + 여백이 필요해 칸 폭 21단위 미만이면 안 그린다
  // (54경기 일정은 칸이 12.9단위라 전부 툴팁으로 - 예전 6.2단위 약어는 9px밖에 안 됐다).
  const showAbbr = bw >= 21;
  let wins = 0;
  const actualPts: string[] = [`${PAD_L},${plotBot.toFixed(1)}`];
  const expPts: string[] = [`${PAD_L},${plotBot.toFixed(1)}`];
  let cumExp = 0;
  let lastExpY = plotBot;
  let lastActY = plotBot;
  let firstPending = true;

  for (let i = 0; i < n; i++) {
    const s = slots[i];
    const x = PAD_L + i * bw;
    const barX = x + bw * 0.16;
    const barW = Math.max(1, bw * 0.68);
    const isFinal = s.status === "final" && s.teamScore != null && s.oppScore != null;
    const when = md(s.gameDate);
    const vs = `${s.isHome ? "vs" : "@"} ${s.oppName}`;
    const probTxt = s.prob != null ? `모델 승률 ${(s.prob * 100).toFixed(0)}%` : "모델 승률 없음";
    const inner: string[] = [];
    let title: string;

    if (s.prob != null) {
      cumExp += s.prob;
      stats.expWins += s.prob;
      stats.expGames += 1;
      expPts.push(`${cx(i).toFixed(1)},${yWins(cumExp).toFixed(1)}`);
      lastExpY = yWins(cumExp);
    }

    if (isFinal) {
      const margin = (s.teamScore as number) - (s.oppScore as number);
      const won = margin > 0;
      if (won) wins++;
      else stats.losses++;
      stats.wins = wins;
      if (s.prob != null) stats.probCoveragePlayed += 1;
      const upset = won && s.prob != null && s.prob < 0.5;
      if (upset) stats.upsets += 1;
      const yTop = Math.min(zeroY, yMargin(margin));
      const h = Math.max(1.5, Math.abs(yMargin(margin) - zeroY));
      inner.push(
        `<rect x="${barX.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${won ? teamColor : "var(--ink-faint)"}" ${
          won ? `stroke="rgba(var(--line-rgb),0.35)" stroke-width="0.75"` : ""
        } opacity="${won ? 0.92 : 0.65}"/>`
      );
      // 태그 글리프: 승리 막대 위 / 패배 막대 아래 (박빙 ○ · 압도 ■ · 역전 ∧)
      if (s.tag) {
        const gy = won ? yTop - 4 : yTop + h + 5;
        const gx = cx(i);
        if (s.tag === "nailbiter") inner.push(`<circle cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" r="2.2" fill="none" stroke="rgba(var(--line-rgb),0.7)" stroke-width="1"/>`);
        else if (s.tag === "blowout") inner.push(`<rect x="${(gx - 2.2).toFixed(1)}" y="${(gy - 2.2).toFixed(1)}" width="4.4" height="4.4" fill="rgba(var(--line-rgb),0.7)"/>`);
        else inner.push(`<path d="M ${(gx - 3).toFixed(1)} ${(gy + 2).toFixed(1)} l 3 -4.5 l 3 4.5" fill="none" stroke="var(--gold)" stroke-width="1.4"/>`);
      }
      if (upset) inner.push(`<path d="M ${cx(i).toFixed(1)} ${plotBot + 4} l 3.6 6.2 h -7.2 Z" fill="var(--gold)"/>`);
      actualPts.push(`${cx(i).toFixed(1)},${yWins(wins).toFixed(1)}`);
      lastActY = yWins(wins);
      title = `${when} ${vs} ${s.teamScore}-${s.oppScore} (${won ? "W" : "L"} ${margin > 0 ? "+" : ""}${margin})${
        s.seasonCategory !== "정규시즌" ? ` · ${s.seasonCategory}` : ""
      } · 경기 전 ${probTxt}${s.tag ? ` · ${TAG_LABEL[s.tag]}` : ""}${upset ? " · 업셋" : ""}`;
    } else {
      // 남은 경기(예정·진행 중) = 고스트 막대. 높이 = 모델 승률(점수차가 아님 - 범례에 명시).
      if (s.status === "scheduled") {
        stats.remaining += 1;
        if (s.prob != null) {
          stats.remainingExp += s.prob;
          stats.remainingPriced += 1;
        }
      }
      const p = s.prob;
      const h = (p ?? 0.5) * halfUp;
      const yTop = zeroY - h;
      if (p == null) {
        inner.push(
          `<rect x="${barX.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="none" stroke="rgba(var(--line-rgb),0.3)" stroke-width="1" stroke-dasharray="2 2"/>`
        );
      } else if (s.isHome) {
        // 가시성 제보(개막 전 = 전 칸이 고스트라 페이지 전체가 옅은 하늘색 일색이었다) - 채움·테두리를
        // 한 단계씩 진하게. "채움 = 사실(치른 승리, opacity .92)" / "고스트 = 아직 없는 것"의 구분은
        // 그대로 남는다(여전히 반투명이고 치른 칸보다 확연히 옅다).
        inner.push(
          `<rect x="${barX.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${teamColor}" opacity="0.42" stroke="${teamColor}" stroke-opacity="0.8" stroke-width="1.1"/>`
        );
      } else {
        inner.push(
          `<rect x="${barX.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="none" stroke="${teamColor}" stroke-opacity="0.95" stroke-width="1.4"/>`
        );
      }
      if (s.status === "live") {
        // 38단위에서 "LIVE"는 94단위(54경기 일정의 칸 폭 12.9의 7배)라 개막전·최종전처럼
        // 가장자리 칸이 진행 중이면 캔버스를 넘는다 - '다음 경기' 라벨과 같은 앵커 뒤집기.
        const lh = rbTextW("LIVE") / 2;
        const la = cx(i) - lh < 2 ? "start" : cx(i) + lh > W - 2 ? "end" : "middle";
        const ltx = la === "start" ? x + 1 : la === "end" ? x + bw - 1 : cx(i);
        inner.push(
          `<text x="${ltx.toFixed(1)}" y="${(yTop - 4).toFixed(1)}" class="rbb" font-weight="800" text-anchor="${la}" fill="var(--negative)" ${RB_HALO}>LIVE</text>`
        );
      }
      const start = s.gameStart ? ` ${s.gameStart.slice(0, 5)}` : "";
      title = `${when}${start} ${vs}${s.stadium ? ` @${s.stadium}` : ""} · ${s.status === "live" ? "진행 중" : "예정"}${
        s.seasonCategory !== "정규시즌" ? ` · ${s.seasonCategory}` : ""
      } · ${probTxt}`;

      // 개막 'D-N' 플래그(팀이 아직 안 뛰었을 때 첫 미종료 칸) 또는 '다음 경기' 마커
      if (firstPending && s.gmkey === input.nextGmkey) {
        // 좁은 화면에서 이 라벨은 150단위까지 커진다 - 캔버스 밖으로 나가지 않게 가장자리
        // 칸에서는 앵커를 뒤집는다(문턱은 32단위 글자의 반폭 기준).
        const half = rbTextW(nextLabel || "다음 경기") / 2;
        const anchor = cx(i) - half < 2 ? "start" : cx(i) + half > W - 2 ? "end" : "middle";
        const tx = anchor === "start" ? x + 1 : anchor === "end" ? x + bw - 1 : cx(i);
        inner.push(`<path d="M ${cx(i).toFixed(1)} ${plotTop - 3} l -4 -6 h 8 Z" fill="var(--gold)"/>`);
        inner.push(
          `<text x="${tx.toFixed(1)}" y="${plotTop - 12}" class="rbb" font-weight="800" text-anchor="${anchor}" fill="var(--gold)" ${RB_HALO}>${esc(nextLabel || "다음 경기")}</text>`
        );
      }
    }
    if (s.gmkey === input.nextGmkey) firstPending = false;

    // 상대 약어(칸이 충분히 넓을 때만 - 치른 칸은 툴팁으로 충분)
    if (showAbbr) {
      inner.push(
        `<text x="${cx(i).toFixed(1)}" y="${plotBot + 19}" class="rbb rbbWide" text-anchor="middle" fill="rgba(var(--line-rgb),${isFinal ? "0.45" : "0.7"})">${esc(
          s.oppAbbr
        )}</text>`
      );
    }

    parts.push(
      `<a href="/games/${esc(s.gmkey)}"><title>${esc(title)}</title><rect x="${x.toFixed(1)}" y="${plotTop - 16}" width="${bw.toFixed(1)}" height="${plotH + 40}" fill="transparent"/>${inner.join("")}</a>`
    );
  }

  // 누적선: 점선 = 모델 기대승, 골드 = 실제 승수(치른 구간만). 두 라벨은 이 그림의 헤드라인
  // 숫자라 좁은 화면에서도 남긴다 - 대신 오른쪽 여백(40단위)에 못 들어가므로 캔버스 오른쪽
  // 끝에 붙이고(anchor=end) 후광을 둘러 막대 위에 얹는다.
  const expLabel = `기대 ${stats.expWins.toFixed(1)}`;
  const expY = Math.min(Math.max(lastExpY, plotTop + 12), plotBot - 6) + 3;
  const expLeft = W - 2 - rbTextW(expLabel);
  if (expPts.length > 1) {
    parts.push(`<polyline points="${expPts.join(" ")}" fill="none" stroke="rgba(var(--line-rgb),0.78)" stroke-width="1.9" stroke-dasharray="4 3"/>`);
    parts.push(`<text x="${W - 2}" y="${expY.toFixed(1)}" text-anchor="end" class="rbb" font-weight="700" fill="rgba(var(--line-rgb),0.9)" ${RB_HALO}>${expLabel}</text>`);
  }
  if (actualPts.length > 1) {
    parts.push(`<polyline points="${actualPts.join(" ")}" fill="none" stroke="var(--gold)" stroke-width="1.8" opacity="0.95"/>`);
    const lx = Number(actualPts[actualPts.length - 1].split(",")[0]);
    parts.push(`<circle cx="${lx.toFixed(1)}" cy="${lastActY.toFixed(1)}" r="2.6" fill="var(--gold)"/>`);
    // 승수 라벨: 오른쪽 끝에서는 점 왼쪽으로 뒤집고, '기대' 라벨과 같은 띠·비슷한 높이면
    // 위아래로 밀어낸다(둘 다 숫자라 어느 쪽도 지우지 않는다).
    const wl = `${wins}승`;
    const flip = lx + 5 + rbTextW(wl) > W - 2;
    let wy = lastActY - 5;
    if (expPts.length > 1 && (flip ? lx - 5 : lx + 5 + rbTextW(wl)) > expLeft && Math.abs(wy - expY) < RB_FS_MAX) {
      wy = expY - RB_FS_MAX - 4 > plotTop ? expY - RB_FS_MAX - 4 : expY + RB_FS_MAX + 4;
    }
    parts.push(
      `<text x="${(flip ? lx - 5 : lx + 5).toFixed(1)}" y="${wy.toFixed(1)}" text-anchor="${flip ? "end" : "start"}" class="rbb" font-weight="700" fill="var(--gold)" ${RB_HALO}>${wl}</text>`
    );
  }

  return { svg: parts.join(""), stats };
}
