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

export const RIBBON_VIEWBOX = { w: 760, h: 236 };

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
    PAD_T = 34,
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

  const parts: string[] = [];
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
      parts.push(
        `<text x="${(x0 + 3).toFixed(1)}" y="${plotTop - 10}" font-size="9" font-weight="700" fill="rgba(var(--line-rgb),0.6)" font-family="IBM Plex Mono, monospace">${esc(
          slots[poStart].seasonCategory
        )}</text>`
      );
      poStart = -1;
    }
  }

  // 월 구분선 + 월 라벨(첫 칸 포함)
  for (let i = 0; i < n; i++) {
    const m = slots[i].gameDate.slice(5, 7);
    const prevM = i > 0 ? slots[i - 1].gameDate.slice(5, 7) : null;
    if (prevM === m) continue;
    const x = PAD_L + i * bw;
    if (i > 0) parts.push(`<line x1="${x.toFixed(1)}" y1="${plotTop - 6}" x2="${x.toFixed(1)}" y2="${plotBot}" stroke="rgba(var(--line-rgb),0.22)" stroke-width="1" stroke-dasharray="2 3"/>`);
    parts.push(`<text x="${(x + 3).toFixed(1)}" y="10" font-size="9" fill="rgba(var(--line-rgb),0.55)" font-family="IBM Plex Mono, monospace">${parseInt(m, 10)}월</text>`);
  }

  // 기준선: 점수차 0(치른 구간) / 고스트 50% 눈금
  parts.push(`<line x1="${PAD_L}" y1="${zeroY.toFixed(1)}" x2="${W - PAD_R}" y2="${zeroY.toFixed(1)}" stroke="rgba(var(--line-rgb),0.35)" stroke-width="1"/>`);
  const y50 = zeroY - 0.5 * halfUp;
  parts.push(`<line x1="${PAD_L}" y1="${y50.toFixed(1)}" x2="${W - PAD_R}" y2="${y50.toFixed(1)}" stroke="rgba(var(--line-rgb),0.18)" stroke-width="0.6" stroke-dasharray="2 4"/>`);
  parts.push(`<text x="2" y="${(y50 + 3).toFixed(1)}" font-size="8" fill="rgba(var(--line-rgb),0.5)" font-family="IBM Plex Mono, monospace">50%</text>`);
  parts.push(`<text x="2" y="${(yMargin(maxAbs) + 7).toFixed(1)}" font-size="8" fill="rgba(var(--line-rgb),0.5)" font-family="IBM Plex Mono, monospace">+${maxAbs}</text>`);
  parts.push(`<text x="2" y="${yMargin(-maxAbs).toFixed(1)}" font-size="8" fill="rgba(var(--line-rgb),0.5)" font-family="IBM Plex Mono, monospace">-${maxAbs}</text>`);
  // 오른쪽 승수 축(누적선용)
  parts.push(`<text x="${W - PAD_R + 4}" y="${plotTop + 3}" font-size="8" fill="rgba(var(--line-rgb),0.5)" font-family="IBM Plex Mono, monospace">${n}승</text>`);
  parts.push(`<text x="${W - PAD_R + 4}" y="${plotBot + 3}" font-size="8" fill="rgba(var(--line-rgb),0.5)" font-family="IBM Plex Mono, monospace">0</text>`);

  const showAbbrAll = bw >= 20;
  const showAbbrGhost = bw >= 11;
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
        inner.push(
          `<rect x="${barX.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${teamColor}" opacity="0.26" stroke="${teamColor}" stroke-opacity="0.55" stroke-width="0.8"/>`
        );
      } else {
        inner.push(
          `<rect x="${barX.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="none" stroke="${teamColor}" stroke-opacity="0.85" stroke-width="1"/>`
        );
      }
      if (s.status === "live") {
        inner.push(
          `<text x="${cx(i).toFixed(1)}" y="${(yTop - 4).toFixed(1)}" font-size="8" font-weight="800" text-anchor="middle" fill="var(--negative)" font-family="IBM Plex Mono, monospace">LIVE</text>`
        );
      }
      const start = s.gameStart ? ` ${s.gameStart.slice(0, 5)}` : "";
      title = `${when}${start} ${vs}${s.stadium ? ` @${s.stadium}` : ""} · ${s.status === "live" ? "진행 중" : "예정"}${
        s.seasonCategory !== "정규시즌" ? ` · ${s.seasonCategory}` : ""
      } · ${probTxt}`;

      // 개막 'D-N' 플래그(팀이 아직 안 뛰었을 때 첫 미종료 칸) 또는 '다음 경기' 마커
      if (firstPending && s.gmkey === input.nextGmkey) {
        const label = input.openerDday != null ? (input.openerDday > 0 ? `D-${input.openerDday}` : "D-DAY") : s.status === "live" ? "진행 중" : "다음 경기";
        const anchor = cx(i) < PAD_L + 30 ? "start" : cx(i) > W - PAD_R - 30 ? "end" : "middle";
        const tx = anchor === "start" ? x + 1 : anchor === "end" ? x + bw - 1 : cx(i);
        inner.push(`<path d="M ${cx(i).toFixed(1)} ${plotTop - 3} l -4 -6 h 8 Z" fill="var(--gold)"/>`);
        inner.push(
          `<text x="${tx.toFixed(1)}" y="${plotTop - 12}" font-size="9.5" font-weight="800" text-anchor="${anchor}" fill="var(--gold)" font-family="IBM Plex Mono, monospace">${esc(label)}</text>`
        );
      }
    }
    if (s.gmkey === input.nextGmkey) firstPending = false;

    // 상대 약어(칸이 충분히 넓을 때만 - 치른 칸은 툴팁으로 충분)
    if (showAbbrAll || (!isFinal && showAbbrGhost)) {
      const fs = bw >= 24 ? 7.5 : 6.2;
      inner.push(
        `<text x="${cx(i).toFixed(1)}" y="${plotBot + 19}" font-size="${fs}" text-anchor="middle" fill="rgba(var(--line-rgb),${isFinal ? "0.45" : "0.7"})" font-family="IBM Plex Mono, monospace">${esc(
          s.oppAbbr
        )}</text>`
      );
    }

    parts.push(
      `<a href="/games/${esc(s.gmkey)}"><title>${esc(title)}</title><rect x="${x.toFixed(1)}" y="${plotTop - 16}" width="${bw.toFixed(1)}" height="${plotH + 40}" fill="transparent"/>${inner.join("")}</a>`
    );
  }

  // 누적선: 점선 = 모델 기대승, 골드 = 실제 승수(치른 구간만)
  if (expPts.length > 1) {
    parts.push(`<polyline points="${expPts.join(" ")}" fill="none" stroke="rgba(var(--line-rgb),0.6)" stroke-width="1.4" stroke-dasharray="3 3"/>`);
    parts.push(
      `<text x="${W - PAD_R + 4}" y="${(Math.min(Math.max(lastExpY, plotTop + 12), plotBot - 6) + 3).toFixed(1)}" font-size="8.5" fill="rgba(var(--line-rgb),0.7)" font-family="IBM Plex Mono, monospace">기대 ${stats.expWins.toFixed(
        1
      )}</text>`
    );
  }
  if (actualPts.length > 1) {
    parts.push(`<polyline points="${actualPts.join(" ")}" fill="none" stroke="var(--gold)" stroke-width="1.8" opacity="0.95"/>`);
    const lx = actualPts[actualPts.length - 1].split(",")[0];
    parts.push(`<circle cx="${lx}" cy="${lastActY.toFixed(1)}" r="2.6" fill="var(--gold)"/>`);
    parts.push(
      `<text x="${(Number(lx) + 5).toFixed(1)}" y="${(lastActY - 5).toFixed(1)}" font-size="8.5" font-weight="700" fill="var(--gold)" font-family="IBM Plex Mono, monospace">${wins}승</text>`
    );
  }

  return { svg: parts.join(""), stats };
}
