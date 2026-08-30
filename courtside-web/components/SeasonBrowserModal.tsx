"use client";

import { useEffect, useState } from "react";
import { TeamBadge } from "./TeamBadge";
import type { SeasonGameRow } from "@/lib/seasonBrowser";
import styles from "@/app/season-browser/season-browser.module.css";

// web/season_browser_template.html의 openBoxScore()/renderQuarterTable()/tsBarHtml()/
// playerRowsHtml() 포팅 - 원본은 미리 구운 SEASON.games[gmkey]를 그냥 읽었지만, 여기는
// 모달이 열리는 시점에 /api/season-browser/box-score를 쳐서 그 경기 하나만 라이브로
// 가져옴(경기 목록 전체를 미리 불러오면 game_events가 시즌당 16만행이라 너무 무거워짐 -
// 자세한 이유는 lib/seasonBrowser.ts 주석 참고).

type PlayerRow = {
  pcode: string;
  name: string;
  backNum: string | null;
  starter: boolean;
  playMin: number;
  playSec: number;
  score: number;
  rb: number;
  ast: number;
  stl: number;
  bs: number;
  to: number;
  fg: number;
  fgA: number;
  threep: number;
  threepA: number;
  ft: number;
  ftA: number;
  per: number | null;
};

type TeamStatsOut = {
  fg: number;
  fgA: number;
  threep: number;
  threepA: number;
  ft: number;
  ftA: number;
  rb: number;
  ast: number;
  stl: number;
  bs: number;
  to: number;
  foul: number;
};

type BoxScoreData = {
  quarters: { home: { q: number[]; ot: number[] }; away: { q: number[]; ot: number[] } };
  teamStats: { home: TeamStatsOut; away: TeamStatsOut };
  players: { home: PlayerRow[]; away: PlayerRow[] };
};

function pct(m: number, a: number) {
  return a ? Math.round((m / a) * 100) : 0;
}

function TsBar({ label, hVal, aVal, hDisp, aDisp }: { label: string; hVal: number; aVal: number; hDisp: string; aDisp: string }) {
  const total = hVal + aVal;
  const hPct = total > 0 ? (hVal / total) * 100 : 50;
  return (
    <div className={styles.tsRow}>
      <div className={styles.tsNums}>
        <span className={styles.tsHome}>{hDisp}</span>
        <span className={styles.tsLabel}>{label}</span>
        <span className={styles.tsAway}>{aDisp}</span>
      </div>
      <div className={styles.tsBar}>
        <div className={styles.tsBarFillHome} style={{ width: `${hPct}%` }} />
        <div className={styles.tsBarFillAway} style={{ width: `${100 - hPct}%` }} />
      </div>
    </div>
  );
}

function PlayerTable({ title, players }: { title: string; players: PlayerRow[] }) {
  const starters = players.filter((p) => p.starter);
  const bench = players.filter((p) => !p.starter);
  const row = (p: PlayerRow) => (
    <tr key={p.pcode} className={p.starter ? undefined : styles.bench}>
      <td>
        {p.name}
        {p.backNum ? ` #${p.backNum}` : ""}
      </td>
      <td>
        {p.playMin}:{String(p.playSec).padStart(2, "0")}
      </td>
      <td>{p.score}</td>
      <td>{p.rb}</td>
      <td>{p.ast}</td>
      <td>{p.stl}</td>
      <td>{p.bs}</td>
      <td>{p.to}</td>
      <td>
        {p.fg}/{p.fgA}
      </td>
      <td>
        {p.threep}/{p.threepA}
      </td>
      <td>
        {p.ft}/{p.ftA}
      </td>
      <td>{p.per != null ? p.per.toFixed(1) : "-"}</td>
    </tr>
  );
  return (
    <>
      <div className={styles.bsSectionTitle}>{title}</div>
      <div className={styles.tableScroll}>
        <table className={styles.bsPlayers}>
          <thead>
            <tr>
              <th>선수</th>
              <th>MIN</th>
              <th>PTS</th>
              <th>REB</th>
              <th>AST</th>
              <th>STL</th>
              <th>BLK</th>
              <th>TO</th>
              <th>FG</th>
              <th>3PT</th>
              <th>FT</th>
              <th>PER</th>
            </tr>
          </thead>
          <tbody>
            {starters.map(row)}
            {bench.length > 0 && (
              <tr className={styles.benchSep}>
                <td colSpan={12}>BENCH</td>
              </tr>
            )}
            {bench.map(row)}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function SeasonBrowserModal({ game, onClose }: { game: SeasonGameRow; onClose: () => void }) {
  const [data, setData] = useState<BoxScoreData | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(false);
    const params = new URLSearchParams({
      gmkey: game.gmkey,
      home: game.home_team?.tcode ?? "",
      away: game.away_team?.tcode ?? "",
    });
    fetch(`/api/season-browser/box-score?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error("box score fetch failed");
        return r.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [game.gmkey, game.home_team?.tcode, game.away_team?.tcode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const home = game.home_team;
  const away = game.away_team;
  const finalHome = game.home_score ?? 0;
  const finalAway = game.away_score ?? 0;
  const hWin = finalHome > finalAway;

  const otCount = data ? Math.max(data.quarters.home.ot.length, data.quarters.away.ot.length) : 0;

  const quarterRow = (label: string, q: number[], ot: number[], total: number, cls: string) => (
    <tr className={cls}>
      <td className={styles.tname}>{label}</td>
      {[0, 1, 2, 3].map((i) => (
        <td key={i}>{q[i] ?? "-"}</td>
      ))}
      {Array.from({ length: otCount }).map((_, i) => (
        <td key={`ot${i}`}>{ot[i] ?? "-"}</td>
      ))}
      <td className={styles.total}>{total}</td>
    </tr>
  );

  return (
    <div className={styles.bsOverlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.bsBox}>
        <div className={styles.bsHead}>
          <div className={`${styles.bsMeta} ${styles.bsMetaLeft}`}>
            {fmtDate(game.game_date)} · {game.season_category}
          </div>
          <button type="button" className={styles.bsClose} onClick={onClose} aria-label="닫기">
            &times;
          </button>
        </div>

        <div className={styles.bsScoreRow}>
          <div className={styles.bsTeamCol}>
            <TeamBadge team={home ? { ...home, logoUrl: home.logo_url } : null} size={44} />
            <div className={styles.bsTeamName}>{home?.name ?? "?"}</div>
          </div>
          <div className={styles.bsScore} style={{ color: hWin ? "var(--home)" : "var(--ink-faint)" }}>
            {finalHome}
          </div>
          <div className={styles.bsSep}>:</div>
          <div className={styles.bsScore} style={{ color: !hWin ? "var(--away)" : "var(--ink-faint)" }}>
            {finalAway}
          </div>
          <div className={styles.bsTeamCol}>
            <TeamBadge team={away ? { ...away, logoUrl: away.logo_url } : null} size={44} />
            <div className={styles.bsTeamName}>{away?.name ?? "?"}</div>
          </div>
        </div>

        {loadError && <div className={styles.modalLoading}>박스스코어를 불러오지 못했습니다.</div>}
        {!loadError && !data && <div className={styles.modalLoading}>불러오는 중...</div>}

        {data && (
          <>
            <div className={styles.tableScroll}>
              <table className={styles.bsQuarterTable}>
                <thead>
                  <tr>
                    <th></th>
                    <th>Q1</th>
                    <th>Q2</th>
                    <th>Q3</th>
                    <th>Q4</th>
                    {Array.from({ length: otCount }).map((_, i) => (
                      <th key={i}>{otCount > 1 ? `OT${i + 1}` : "OT"}</th>
                    ))}
                    <th>계</th>
                  </tr>
                </thead>
                <tbody>
                  {quarterRow(home?.abbr ?? "홈", data.quarters.home.q, data.quarters.home.ot, finalHome, styles.rowHome)}
                  {quarterRow(away?.abbr ?? "원정", data.quarters.away.q, data.quarters.away.ot, finalAway, styles.rowAway)}
                </tbody>
              </table>
            </div>

            <div className={styles.bsSectionTitle}>Team Stats</div>
            <div>
              <TsBar
                label="FG%"
                hVal={pct(data.teamStats.home.fg, data.teamStats.home.fgA)}
                aVal={pct(data.teamStats.away.fg, data.teamStats.away.fgA)}
                hDisp={`${pct(data.teamStats.home.fg, data.teamStats.home.fgA)}% ${data.teamStats.home.fg}-${data.teamStats.home.fgA}`}
                aDisp={`${data.teamStats.away.fg}-${data.teamStats.away.fgA} ${pct(data.teamStats.away.fg, data.teamStats.away.fgA)}%`}
              />
              <TsBar
                label="3PT%"
                hVal={pct(data.teamStats.home.threep, data.teamStats.home.threepA)}
                aVal={pct(data.teamStats.away.threep, data.teamStats.away.threepA)}
                hDisp={`${pct(data.teamStats.home.threep, data.teamStats.home.threepA)}% ${data.teamStats.home.threep}-${data.teamStats.home.threepA}`}
                aDisp={`${data.teamStats.away.threep}-${data.teamStats.away.threepA} ${pct(data.teamStats.away.threep, data.teamStats.away.threepA)}%`}
              />
              <TsBar
                label="FT%"
                hVal={pct(data.teamStats.home.ft, data.teamStats.home.ftA)}
                aVal={pct(data.teamStats.away.ft, data.teamStats.away.ftA)}
                hDisp={`${pct(data.teamStats.home.ft, data.teamStats.home.ftA)}% ${data.teamStats.home.ft}-${data.teamStats.home.ftA}`}
                aDisp={`${data.teamStats.away.ft}-${data.teamStats.away.ftA} ${pct(data.teamStats.away.ft, data.teamStats.away.ftA)}%`}
              />
              <TsBar label="리바운드" hVal={data.teamStats.home.rb} aVal={data.teamStats.away.rb} hDisp={String(data.teamStats.home.rb)} aDisp={String(data.teamStats.away.rb)} />
              <TsBar label="어시스트" hVal={data.teamStats.home.ast} aVal={data.teamStats.away.ast} hDisp={String(data.teamStats.home.ast)} aDisp={String(data.teamStats.away.ast)} />
              <TsBar label="스틸" hVal={data.teamStats.home.stl} aVal={data.teamStats.away.stl} hDisp={String(data.teamStats.home.stl)} aDisp={String(data.teamStats.away.stl)} />
              <TsBar label="블록" hVal={data.teamStats.home.bs} aVal={data.teamStats.away.bs} hDisp={String(data.teamStats.home.bs)} aDisp={String(data.teamStats.away.bs)} />
              <TsBar label="턴오버" hVal={data.teamStats.home.to} aVal={data.teamStats.away.to} hDisp={String(data.teamStats.home.to)} aDisp={String(data.teamStats.away.to)} />
              <TsBar label="파울" hVal={data.teamStats.home.foul} aVal={data.teamStats.away.foul} hDisp={String(data.teamStats.home.foul)} aDisp={String(data.teamStats.away.foul)} />
            </div>

            <PlayerTable title={`${home?.name ?? "?"} 박스스코어`} players={data.players.home} />
            <PlayerTable title={`${away?.name ?? "?"} 박스스코어`} players={data.players.away} />
          </>
        )}
      </div>
    </div>
  );
}

function fmtDate(d: string) {
  return d.replaceAll("-", ".");
}
