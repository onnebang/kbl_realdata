"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { TeamBadge } from "./TeamBadge";
import { buildCourtDotsSvg, type ShotRow } from "@/lib/zoneCompare";
import type { GameEvent } from "@/lib/postgameReport";

// "코트사이드" 시그니처 기능(인터랙티브 리플레이/스크럽) 포팅 - courtside_template.html의
// render(idx)/computeBoxScore/renderFeedGroups/renderCourt 등 약 90개 함수 중 핵심 스크럽
// 경험만 먼저(사용자 확인 - "핵심 스크럽 MVP 먼저"). AI 내러티브 8종/핫스트릭 애니메이션/
// 클러치샷 지수 등은 다음 단계로 미룸(이미 이 경기 페이지 하단에 있는 정적
// postgameReport/pregameInsights 패널이 "경기 끝난 뒤 요약"은 커버하고 있음).
const MAKE_CODES = new Set(["201", "205", "207"]);
const MISS_CODES = new Set(["202", "206", "208"]);
const FOUL_CODES = new Set(["216", "224"]);

function emptyBoxLine() {
  return { pts: 0, fgm: 0, fga: 0, threePM: 0, threePA: 0, ftm: 0, fta: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, foul: 0 };
}
type BoxLine = ReturnType<typeof emptyBoxLine>;

// game_events는 shot_id 단위가 아니라 액션코드 로그라서, courtside_template.html의
// computeBoxScore(uptoIdx)와 동일하게 매 스크럽마다 0..idx를 재훑어 박스스코어를 만듦
// (경기당 500~800개뿐이라 클라이언트에서도 비용 무시 가능).
function computeBoxScore(events: GameEvent[], uptoIdx: number, players: PlayerMeta[]): Map<string, BoxLine> {
  const box = new Map<string, BoxLine>();
  for (const p of players) box.set(p.pcode, emptyBoxLine());
  for (let i = 0; i <= uptoIdx; i++) {
    const row = events[i];
    if (!row.pcode) continue;
    const b = box.get(row.pcode);
    if (!b) continue;
    const code = row.action_code;
    if (!code) continue;
    if (MAKE_CODES.has(code)) {
      b.pts += code === "205" ? 3 : 2;
      b.fgm++;
      b.fga++;
      if (code === "205") {
        b.threePM++;
        b.threePA++;
      }
    } else if (MISS_CODES.has(code)) {
      if (code === "206") b.threePA++;
      b.fga++;
    } else if (code === "203") {
      b.pts += 1;
      b.ftm++;
      b.fta++;
    } else if (code === "204") {
      b.fta++;
    } else if (code === "209" || code === "210") {
      b.reb++;
    } else if (code === "211") {
      b.ast++;
    } else if (code === "212") {
      b.stl++;
    } else if (code === "213") {
      b.blk++;
    } else if (code === "214") {
      b.to++;
    } else if (FOUL_CODES.has(code)) {
      b.foul++;
    }
  }
  return box;
}

function clockStr(e: GameEvent) {
  if (e.quarter === "PRE") return "경기 시작 전";
  return `${e.quarter} ${e.clock_min}:${String(e.clock_sec).padStart(2, "0")}`;
}

// 쿼터별 점수(요청: "경기 세부는 courtside_template을 참고해서 개발" - 원본
// renderQuarterTable(idx)와 동일한 계산: 각 쿼터 "끝" 시점 누적점수 - 그 전 쿼터 누적점수
// = 그 쿼터에서만 낸 점수. 아직 안 온 쿼터는 null("-"), 현재 진행 중인 쿼터는 live 표시.
type QuarterCell = { v: number; live: boolean } | null;
function computeQuarterScores(
  events: GameEvent[],
  idx: number,
  quarterOrder: string[],
  lastIdxByQuarter: Map<string, number>
): { homeByQ: QuarterCell[]; awayByQ: QuarterCell[] } {
  const curQuarter = events[idx].quarter;
  const curRank = curQuarter === "PRE" ? -1 : quarterOrder.indexOf(curQuarter);
  let prevH = 0,
    prevA = 0;
  const homeByQ: QuarterCell[] = [];
  const awayByQ: QuarterCell[] = [];
  quarterOrder.forEach((q, qi) => {
    if (qi > curRank) {
      homeByQ.push(null);
      awayByQ.push(null);
      return;
    }
    const isCurrent = qi === curRank;
    const endIdx = isCurrent ? idx : lastIdxByQuarter.get(q) ?? idx;
    const h = events[endIdx].home_score,
      a = events[endIdx].away_score;
    homeByQ.push({ v: h - prevH, live: isCurrent });
    awayByQ.push({ v: a - prevA, live: isCurrent });
    prevH = h;
    prevA = a;
  });
  return { homeByQ, awayByQ };
}

type PlayerMeta = { pcode: string; name: string; tcode: string };
type TeamMeta = { tcode: string; name: string; abbr: string; color: string; logoUrl: string | null };
type ShotWithQuarter = ShotRow & { quarter: string };

function WinProbLiveChart({ events, idx, homeColor }: { events: GameEvent[]; idx: number; homeColor: string }) {
  const valid = events.map((e, i) => ({ e, i })).filter((r) => r.e.home_win_prob != null);
  if (!valid.length) return <div className="empty-note">승률 데이터 없음</div>;
  const W = 640,
    H = 150,
    PAD = 14;
  const n = valid.length;
  const points = valid
    .map((r, vi) => {
      const x = PAD + (vi / Math.max(1, n - 1)) * (W - 2 * PAD);
      const y = PAD + (1 - (r.e.home_win_prob as number)) * (H - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  let markerVi = 0;
  for (let vi = 0; vi < valid.length; vi++) {
    if (valid[vi].i <= idx) markerVi = vi;
    else break;
  }
  const marker = valid[markerVi];
  const mx = PAD + (markerVi / Math.max(1, n - 1)) * (W - 2 * PAD);
  const my = PAD + (1 - (marker.e.home_win_prob as number)) * (H - 2 * PAD);
  const midY = PAD + 0.5 * (H - 2 * PAD);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 150, display: "block" }}>
      <line x1={PAD} y1={midY} x2={W - PAD} y2={midY} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="3,3" />
      <polyline points={points} fill="none" stroke={homeColor} strokeWidth={2} opacity={0.85} />
      <line x1={mx} y1={PAD} x2={mx} y2={H - PAD} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="2,3" />
      <circle cx={mx} cy={my} r={4.5} fill={homeColor} stroke="var(--surface)" strokeWidth={1.5} />
      <text x={mx} y={my - 10} textAnchor="middle" fontSize={11} fontWeight={700} fill={homeColor} fontFamily="IBM Plex Mono, monospace">
        {Math.round((marker.e.home_win_prob as number) * 100)}%
      </text>
    </svg>
  );
}

export default function GameReplay({
  events,
  players,
  homeTeam,
  awayTeam,
  shots,
}: {
  events: GameEvent[];
  players: PlayerMeta[];
  homeTeam: TeamMeta;
  awayTeam: TeamMeta;
  shots: ShotWithQuarter[];
}) {
  const [idx, setIdx] = useState(events.length - 1);
  const [playing, setPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState(300);

  useEffect(() => {
    if (!playing) return;
    if (idx >= events.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIdx((i) => Math.min(events.length - 1, i + 1)), speedMs);
    return () => clearTimeout(t);
  }, [playing, idx, events.length, speedMs]);

  const quarterOrder = useMemo(() => {
    const seen: string[] = [];
    for (const e of events) if (e.quarter !== "PRE" && !seen.includes(e.quarter)) seen.push(e.quarter);
    return seen;
  }, [events]);
  const lastIdxByQuarter = useMemo(() => {
    const m = new Map<string, number>();
    events.forEach((e, i) => {
      if (e.quarter !== "PRE") m.set(e.quarter, i);
    });
    return m;
  }, [events]);
  const quarterRank = useMemo(() => new Map(quarterOrder.map((q, i) => [q, i])), [quarterOrder]);

  const row = events[idx];
  const box = useMemo(() => computeBoxScore(events, idx, players), [events, idx, players]);
  const { homeByQ, awayByQ } = useMemo(
    () => computeQuarterScores(events, idx, quarterOrder, lastIdxByQuarter),
    [events, idx, quarterOrder, lastIdxByQuarter]
  );
  const homePlayers = players.filter((p) => p.tcode === homeTeam.tcode);
  const awayPlayers = players.filter((p) => p.tcode === awayTeam.tcode);

  const curQRank = row.quarter === "PRE" ? -1 : quarterRank.get(row.quarter) ?? 0;
  const filteredShots = useMemo(
    () => shots.filter((s) => (quarterRank.get(s.quarter) ?? 0) <= curQRank),
    [shots, curQRank, quarterRank]
  );
  // 실제 슛 점 차트(app/games/[gmkey]/page.tsx와 같은 lib/zoneCompare.ts의
  // buildCourtDotsSvg) - 스크럽할수록 점이 하나씩 채워지는 느낌을 그대로 살림.
  const homeQuarterShots = useMemo(() => filteredShots.filter((s) => s.tcode === homeTeam.tcode), [filteredShots, homeTeam.tcode]);
  const awayQuarterShots = useMemo(() => filteredShots.filter((s) => s.tcode === awayTeam.tcode), [filteredShots, awayTeam.tcode]);
  const homeDotsSvg = homeQuarterShots.length > 0 ? buildCourtDotsSvg(homeQuarterShots, homeTeam.color) : null;
  const awayDotsSvg = awayQuarterShots.length > 0 ? buildCourtDotsSvg(awayQuarterShots, awayTeam.color) : null;

  const feed = events.slice(0, idx + 1).slice(-200).reverse();

  const boxTable = (list: PlayerMeta[]) => (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>선수</th>
            <th>PTS</th>
            <th>REB</th>
            <th>AST</th>
            <th>STL</th>
            <th>BLK</th>
            <th>TO</th>
            <th>FG</th>
            <th>3P</th>
            <th>FT</th>
          </tr>
        </thead>
        <tbody>
          {list
            .slice()
            .sort((a, b) => (box.get(b.pcode)?.pts ?? 0) - (box.get(a.pcode)?.pts ?? 0))
            .map((p) => {
              const b = box.get(p.pcode) ?? emptyBoxLine();
              return (
                <tr key={p.pcode}>
                  <td>
                    <Link href={`/players/${p.pcode}`}>{p.name}</Link>
                  </td>
                  <td>{b.pts}</td>
                  <td>{b.reb}</td>
                  <td>{b.ast}</td>
                  <td>{b.stl}</td>
                  <td>{b.blk}</td>
                  <td>{b.to}</td>
                  <td>
                    {b.fgm}/{b.fga}
                  </td>
                  <td>
                    {b.threePM}/{b.threePA}
                  </td>
                  <td>
                    {b.ftm}/{b.fta}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="panel replay-panel">
      <div className="panel-title">인터랙티브 리플레이</div>

      <div className="replay-scoreboard">
        <div className="replay-scoreboard-clock">{clockStr(row)}</div>

        <div className="replay-scoreboard-main">
          <div className="replay-team-col">
            <TeamBadge team={homeTeam} size={56} />
            <div className="replay-team-name" style={{ color: homeTeam.color }}>
              {homeTeam.name}
            </div>
            <div className="replay-team-score">{row.home_score}</div>
          </div>
          <div className="replay-sb-sep">:</div>
          <div className="replay-team-col">
            <TeamBadge team={awayTeam} size={56} />
            <div className="replay-team-name" style={{ color: awayTeam.color }}>
              {awayTeam.name}
            </div>
            <div className="replay-team-score">{row.away_score}</div>
          </div>
        </div>

        {row.home_win_prob != null && (
          <>
            <div className="replay-prob-row">
              <div>
                <span className="replay-prob-pct" style={{ color: homeTeam.color }}>
                  {Math.round(row.home_win_prob * 100)}%
                </span>
                <span className="replay-prob-label">승리확률</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <span className="replay-prob-pct" style={{ color: awayTeam.color }}>
                  {Math.round((1 - row.home_win_prob) * 100)}%
                </span>
                <span className="replay-prob-label">승리확률</span>
              </div>
            </div>
            <div className="replay-split-bar">
              <div className="replay-split-home" style={{ width: `${row.home_win_prob * 100}%`, background: homeTeam.color }} />
              <div className="replay-split-away" style={{ width: `${(1 - row.home_win_prob) * 100}%`, background: awayTeam.color }} />
            </div>
          </>
        )}

        <div className="table-scroll">
          <table className="replay-quarter-table">
            <thead>
              <tr>
                <th></th>
                {quarterOrder.map((q) => (
                  <th key={q}>{q}</th>
                ))}
                <th>계</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="replay-quarter-tname" style={{ color: homeTeam.color }}>
                  {homeTeam.abbr}
                </td>
                {homeByQ.map((c, i) => (
                  <td key={i}>
                    {c == null ? "-" : c.v}
                    {c?.live && <span className="replay-quarter-live">*</span>}
                  </td>
                ))}
                <td className="replay-quarter-total">{row.home_score}</td>
              </tr>
              <tr>
                <td className="replay-quarter-tname" style={{ color: awayTeam.color }}>
                  {awayTeam.abbr}
                </td>
                {awayByQ.map((c, i) => (
                  <td key={i}>
                    {c == null ? "-" : c.v}
                    {c?.live && <span className="replay-quarter-live">*</span>}
                  </td>
                ))}
                <td className="replay-quarter-total">{row.away_score}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="replay-now-line">{row.pcode ? `${row.player_name} · ` : ""}{row.action_label ?? "-"}</div>

      <div className="replay-controls">
        <button type="button" className="replay-btn" onClick={() => setIdx(0)} aria-label="처음으로">
          ⏮
        </button>
        <button type="button" className="replay-btn" onClick={() => setIdx((i) => Math.max(0, i - 1))} aria-label="이전">
          ◀
        </button>
        <button
          type="button"
          className="replay-btn replay-btn-play"
          onClick={() => {
            if (idx >= events.length - 1) setIdx(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? "일시정지" : "재생"}
        </button>
        <button
          type="button"
          className="replay-btn"
          onClick={() => setIdx((i) => Math.min(events.length - 1, i + 1))}
          aria-label="다음"
        >
          ▶
        </button>
        <button type="button" className="replay-btn" onClick={() => setIdx(events.length - 1)} aria-label="끝으로">
          ⏭
        </button>
        <select value={speedMs} onChange={(e) => setSpeedMs(Number(e.target.value))} className="replay-speed">
          <option value={600}>0.5x</option>
          <option value={300}>1x</option>
          <option value={120}>2x</option>
          <option value={50}>4x</option>
        </select>
      </div>

      <input
        type="range"
        className="replay-slider"
        min={0}
        max={events.length - 1}
        value={idx}
        onChange={(e) => {
          setPlaying(false);
          setIdx(Number(e.target.value));
        }}
      />

      <div className="replay-quarter-btns">
        {quarterOrder.map((q) => (
          <button
            key={q}
            type="button"
            className={`replay-quarter-btn ${row.quarter === q ? "active" : ""}`}
            onClick={() => {
              setPlaying(false);
              setIdx(lastIdxByQuarter.get(q) ?? 0);
            }}
          >
            {q}
          </button>
        ))}
      </div>

      <WinProbLiveChart events={events} idx={idx} homeColor={homeTeam.color} />

      <div className="replay-cols">
        <div>
          <div className="report-section-title">홈 - {homeTeam.name}</div>
          {boxTable(homePlayers)}
          <div className="report-section-title" style={{ marginTop: 14 }}>
            원정 - {awayTeam.name}
          </div>
          {boxTable(awayPlayers)}
        </div>
        <div>
          <div className="report-section-title">플레이 바이 플레이</div>
          <div className="replay-feed">
            {feed.map((e, i) => (
              <div key={`${e.event_order}-${i}`} className="replay-feed-row">
                <span className="replay-feed-clock">{clockStr(e)}</span>
                <span
                  className="replay-feed-dot"
                  style={{ background: e.tcode === homeTeam.tcode ? homeTeam.color : e.tcode === awayTeam.tcode ? awayTeam.color : "transparent" }}
                />
                <span className="replay-feed-text">
                  {e.player_name ? `${e.player_name} ` : ""}
                  {e.action_label ?? ""}
                </span>
                <span className="replay-feed-score">
                  {e.home_score}-{e.away_score}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {(homeDotsSvg || awayDotsSvg) && (
        <div className="report-section" style={{ marginTop: 16 }}>
          <div className="report-section-title">현재 쿼터까지 슛 차트</div>
          <div className="matchup-schedule-grid">
            <div>
              <div className="explorer-stat-line">
                {homeTeam.abbr} · {homeQuarterShots.filter((s) => s.made).length}/{homeQuarterShots.length}
              </div>
              {homeDotsSvg && (
                <div className="zc-court-tilt">
                  <svg className="zc-court" viewBox="355 27 375 357" dangerouslySetInnerHTML={{ __html: homeDotsSvg }} />
                </div>
              )}
            </div>
            <div>
              <div className="explorer-stat-line">
                {awayTeam.abbr} · {awayQuarterShots.filter((s) => s.made).length}/{awayQuarterShots.length}
              </div>
              {awayDotsSvg && (
                <div className="zc-court-tilt">
                  <svg className="zc-court" viewBox="355 27 375 357" dangerouslySetInnerHTML={{ __html: awayDotsSvg }} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
