"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { TeamPlate } from "./TeamPlate";
import SeasonBrowserModal from "./SeasonBrowserModal";
import type { SeasonGameRow } from "@/lib/seasonBrowser";
import {
  buildTeamLines,
  categoryLabel,
  categoryTag,
  involves,
  koDayOfWeek,
  listTeams,
  orderCategories,
  perspective,
  type Result,
  type TeamLine,
  type TeamRef,
} from "@/lib/seasonTeamForm";
import { contrastRatio, teamBarStyle, teamInkStyle } from "@/lib/teamAccent";
import styles from "@/app/season-browser/season-browser.module.css";

// web/season_browser_template.html의 renderGameList()/openBoxScore() 포팅에서 출발해, 지금은
// "팀 레일로 한 팀을 골라 그 팀 시선으로 시즌을 훑는" 화면이다. 경기 목록은 서버가 props로 넘긴 걸
// 그대로 받아 계산만 한다 - 여기서 Supabase를 부르지 않는다(박스스코어 모달만 경기 1건을 따로 조회).

const MAX_STAGGER = 12; // 카드 입장 모션은 앞쪽 몇 장만 순차로 - 시즌 전체(280장)가 줄줄이 튀면 산만하다.
const ALL = "ALL";

// 팀 조인이 비어 와도(예: 삭제된 팀) 경기가 목록에서 사라지지 않게 - 이전 목록의 "?" 표기와 같은 폴백.
const UNKNOWN: TeamRef = { tcode: "", name: "?", abbr: "?", color: "#888888", logo_url: null };

const badge = (t: TeamRef) => ({ name: t.name, abbr: t.abbr, color: t.color, logoUrl: t.logo_url });
const mmdd = (d: string) => d.slice(5).replace("-", ".");
const teamVars = (t: TeamRef): CSSProperties => ({ ...teamBarStyle(t.color), ...teamInkStyle(t.color) });

/** 팀 색 위에 얹는 글자색. 흰색 대비 4.5:1이 안 되는 밝은 팀 색(고양 소노 등)만 어두운 글자로. */
function heroVars(t: TeamRef): CSSProperties {
  const onWhite = contrastRatio(t.color, "#FFFFFF");
  const darkText = onWhite != null && onWhite < 4.5;
  return {
    ...teamBarStyle(t.color),
    "--tc": t.color,
    "--on": darkText ? "#0B0D12" : "#FFFFFF",
    "--chip": darkText ? "rgba(255,255,255,0.42)" : "rgba(0,0,0,0.24)",
    "--sl": darkText ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.1)",
  } as CSSProperties;
}

function Ball() {
  return (
    <span className={styles.ball} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22">
        <circle cx="12" cy="12" r="10.5" fill="var(--home)" stroke="var(--ink)" strokeWidth="1.5" />
        <path
          d="M12 1.5v21M1.5 12h21M4.3 4.6c3.3 2.9 3.3 11.9 0 14.8M19.7 4.6c-3.3 2.9-3.3 11.9 0 14.8"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="1.4"
        />
      </svg>
    </span>
  );
}

/** 최근 경기 폼. 승=채움 / 패=속 빈 원이라 색을 못 봐도 구분된다. chips면 글자("승"/"패")를 단다. */
function Form({ form, chips = false }: { form: Result[]; chips?: boolean }) {
  if (!form.length) return null;
  const label = `최근 ${form.length}경기 ${form.map((r) => (r === "W" ? "승" : "패")).join(" ")}`;
  return (
    <span className={chips ? styles.formChips : styles.formDots} role="img" aria-label={label}>
      {form.map((r, i) => (
        <i key={i} className={r === "W" ? styles.fW : styles.fL} style={{ "--k": i } as CSSProperties}>
          {chips ? (r === "W" ? "승" : "패") : null}
        </i>
      ))}
    </span>
  );
}

function TeamName({ team }: { team: TeamRef }) {
  return (
    <span className={styles.name}>
      <span className={styles.nameFull}>{team.name}</span>
      <span className={styles.nameAbbr}>{team.abbr}</span>
    </span>
  );
}

function Tags({ game }: { game: SeasonGameRow }) {
  const tag = categoryTag(game.season_category);
  const close = Math.abs((game.home_score ?? 0) - (game.away_score ?? 0)) <= 5;
  if (!tag && !close) return null;
  return (
    <span className={styles.tags}>
      {tag && <span className={styles.tag}>{tag}</span>}
      {close && <span className={styles.close}>접전</span>}
    </span>
  );
}

/** 팀 선택 시: 그 팀 시선의 한 줄. 날짜 · 승패 · 홈/원정 · 상대 · 점수(우리 : 상대). */
function FocusCard({ game, line, index, onOpen }: { game: SeasonGameRow; line: TeamLine; index: number; onOpen: () => void }) {
  const p = perspective(game, line.tcode);
  const opp = p.opp ?? UNKNOWN;
  return (
    <button
      type="button"
      className={`${styles.card} ${styles.cardFocus} ${p.won ? styles.cardWin : styles.cardLoss}`}
      style={{ ...teamVars(line.team), "--i": index } as CSSProperties}
      onClick={onOpen}
    >
      <span className={styles.when}>
        <b>{mmdd(game.game_date)}</b>
        <small>{koDayOfWeek(game.game_date)}</small>
      </span>
      <span className={p.won ? styles.resW : styles.resL}>{p.won ? "승" : "패"}</span>
      <span className={styles.opp}>
        <span className={styles.ha}>{p.isHome ? "홈" : "원정"}</span>
        <TeamPlate team={badge(opp)} size={30} />
        <TeamName team={opp} />
        <Tags game={game} />
      </span>
      <span className={styles.score}>
        <b className={p.won ? styles.scoreWin : undefined}>{p.us}</b>
        <i>:</i>
        <b>{p.them}</b>
      </span>
    </button>
  );
}

/** 전체 보기: 홈 | 원정을 양끝에 두고 가운데가 점수. 이긴 쪽만 팀 색 점수, 진 쪽은 한 톤 죽인다. */
function VersusCard({ game, index, onOpen }: { game: SeasonGameRow; index: number; onOpen: () => void }) {
  const h = game.home_team ?? UNKNOWN;
  const a = game.away_team ?? UNKNOWN;
  const hWin = (game.home_score ?? 0) > (game.away_score ?? 0);
  const side = (t: TeamRef, score: number | null, win: boolean, right: boolean) => (
    <span className={`${styles.side} ${right ? styles.sideRight : ""} ${win ? styles.sideWin : styles.sideLoss}`} style={teamVars(t)}>
      <TeamPlate team={badge(t)} size={30} />
      <TeamName team={t} />
      <b className={styles.sideScore}>{score}</b>
    </span>
  );
  return (
    <button type="button" className={styles.card} style={{ "--i": index } as CSSProperties} onClick={onOpen}>
      {side(h, game.home_score, hWin, false)}
      <span className={styles.mid}>
        <i>:</i>
        <Tags game={game} />
      </span>
      {side(a, game.away_score, !hWin, true)}
    </button>
  );
}

function Hero({ line, categoryName }: { line: TeamLine; categoryName: string }) {
  const { team, w, l, pct, pf, pa, home, away, form, streak } = line;
  return (
    <section className={styles.hero} style={heroVars(team)} aria-label={`${team.name} 시즌 요약`}>
      <span className={styles.heroGhost} aria-hidden="true">
        {team.abbr}
      </span>
      <div className={styles.heroMain}>
        <TeamPlate team={badge(team)} size={58} />
        <div>
          <span className={styles.heroKicker}>TEAM VIEW · {categoryName}</span>
          <h2 className={styles.heroName}>{team.name}</h2>
          <p className={styles.heroRec}>
            <b>{w}</b>승 <b>{l}</b>패<span className={styles.heroPct}>승률 {(pct * 100).toFixed(1)}%</span>
          </p>
        </div>
      </div>
      <dl className={styles.heroStats}>
        <div>
          <dt>연속</dt>
          <dd>{streak ? <><b>{streak.n}</b>{streak.type === "W" ? "연승" : "연패"}</> : "-"}</dd>
        </div>
        <div>
          <dt>평균 득점</dt>
          <dd><b>{pf.toFixed(1)}</b></dd>
        </div>
        <div>
          <dt>평균 실점</dt>
          <dd><b>{pa.toFixed(1)}</b></dd>
        </div>
        <div>
          <dt>홈</dt>
          <dd><b>{home.w}-{home.l}</b></dd>
        </div>
        <div>
          <dt>원정</dt>
          <dd><b>{away.w}-{away.l}</b></dd>
        </div>
      </dl>
      {form.length > 0 && (
        <div className={styles.heroForm}>
          <span>최근 {form.length}경기</span>
          <Form form={form} chips />
        </div>
      )}
    </section>
  );
}

export default function SeasonBrowserBoard({ games }: { games: SeasonGameRow[] }) {
  const categories = useMemo(() => orderCategories(Array.from(new Set(games.map((g) => g.season_category)))), [games]);
  const teams = useMemo(() => listTeams(games), [games]);

  // 기본은 정규시즌 - 시즌 홈 순위(정규시즌만 집계)와 팀 전적이 어긋나지 않게 한다.
  const [category, setCategory] = useState<string>(categories.indexOf("정규시즌") >= 0 ? "정규시즌" : ALL);
  const [teamCode, setTeamCode] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
  const [selected, setSelected] = useState<SeasonGameRow | null>(null);

  const scoped = useMemo(() => (category === ALL ? games : games.filter((g) => g.season_category === category)), [games, category]);
  const lines = useMemo(() => buildTeamLines(scoped, teams), [scoped, teams]);
  const active = teamCode ? lines.find((l) => l.tcode === teamCode) ?? null : null;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const picked = scoped.filter((g) => {
      if (teamCode && !involves(g, teamCode)) return false;
      if (!q) return true;
      const hay = [g.home_team?.name, g.home_team?.abbr, g.away_team?.name, g.away_team?.abbr].filter(Boolean).join(" ").toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    return newestFirst ? picked.slice().reverse() : picked;
  }, [scoped, teamCode, search, newestFirst]);

  // 팀을 고르지 않았을 때만 날짜 머리글로 묶는다(팀 시선은 한 팀이 하루 한 경기라 머리글이 낭비).
  // offset = 이 날짜 앞에 놓인 카드 수 - 입장 모션 순번(index)을 렌더 중 카운터 없이 계산한다.
  const days = useMemo(() => {
    const out: { date: string; offset: number; games: SeasonGameRow[] }[] = [];
    rows.forEach((g, i) => {
      const last = out[out.length - 1];
      if (last && last.date === g.game_date) last.games.push(g);
      else out.push({ date: g.game_date, offset: i, games: [g] });
    });
    return out;
  }, [rows]);

  return (
    <div>
      <div className={styles.rail} role="group" aria-label="팀 선택">
        <button
          type="button"
          className={`${styles.tile} ${styles.tileAll} ${!teamCode ? styles.tileOn : ""}`}
          style={{ "--tb-l": "var(--gold)", "--tb-d": "var(--gold)" } as CSSProperties}
          aria-pressed={!teamCode}
          onClick={() => setTeamCode(null)}
        >
          <span className={styles.tileAllMark}>ALL</span>
          <span className={styles.tileAbbr}>전체 팀</span>
          <span className={styles.tileRec}>{scoped.length}경기</span>
        </button>
        {lines.map((line) => {
          const on = line.tcode === teamCode;
          const played = line.w + line.l;
          return (
            <button
              key={line.tcode}
              type="button"
              className={`${styles.tile} ${on ? styles.tileOn : ""}`}
              style={teamBarStyle(line.team.color)}
              aria-pressed={on}
              disabled={played === 0}
              onClick={() => setTeamCode(on ? null : line.tcode)}
            >
              <TeamPlate team={badge(line.team)} size={30} />
              <span className={styles.tileAbbr}>{line.team.abbr}</span>
              <span className={styles.tileRec}>{played ? `${line.w}-${line.l}` : "-"}</span>
              <Form form={line.form} />
            </button>
          );
        })}
      </div>

      {active && <Hero key={active.tcode} line={active} categoryName={categoryLabel(category)} />}

      <div className={styles.toolbar}>
        <div className={styles.chips} role="group" aria-label="경기 구분">
          {categories.length > 1 && (
            <button type="button" className={`${styles.chip} ${category === ALL ? styles.chipOn : ""}`} aria-pressed={category === ALL} onClick={() => setCategory(ALL)}>
              전체 <small>{games.length}</small>
            </button>
          )}
          {categories.map((c) => (
            <button key={c} type="button" className={`${styles.chip} ${category === c ? styles.chipOn : ""}`} aria-pressed={category === c} onClick={() => setCategory(c)}>
              {categoryLabel(c)} <small>{games.filter((g) => g.season_category === c).length}</small>
            </button>
          ))}
        </div>
        <div className={styles.tools}>
          <input type="text" placeholder="상대 팀 검색" aria-label="팀 이름 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="button" className={styles.sort} onClick={() => setNewestFirst((v) => !v)}>
            {newestFirst ? "최신순 ↓" : "과거순 ↑"}
          </button>
        </div>
      </div>

      <div className={styles.countLine}>
        <Ball />
        <b>{rows.length}</b>경기{active ? ` · ${active.team.name}` : ""}
      </div>

      {rows.length === 0 ? (
        <div className={styles.grEmpty}>
          {active && category !== ALL ? `${categoryLabel(category)}에는 ${active.team.name} 경기가 없습니다.` : "해당하는 경기가 없습니다."}
        </div>
      ) : (
        // key: 팀·구분·정렬이 바뀔 때만 입장 모션을 다시 재생한다(검색 입력마다 튀지 않게).
        <div key={`${teamCode}|${category}|${newestFirst}`}>
          {active ? (
            <div className={styles.focusList}>
              {rows.map((g, i) => (
                <FocusCard key={g.gmkey} game={g} line={active} index={Math.min(i, MAX_STAGGER)} onOpen={() => setSelected(g)} />
              ))}
            </div>
          ) : (
            days.map((day) => (
              <section key={day.date} className={styles.day}>
                <h3 className={styles.dayHead}>
                  <b>{mmdd(day.date)}</b>
                  <span>{koDayOfWeek(day.date)}</span>
                  <i aria-hidden="true" />
                  <small>{day.games.length}경기</small>
                </h3>
                <div className={styles.dayGrid}>
                  {day.games.map((g, j) => (
                    <VersusCard key={g.gmkey} game={g} index={Math.min(day.offset + j, MAX_STAGGER)} onOpen={() => setSelected(g)} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}

      {selected && <SeasonBrowserModal game={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
