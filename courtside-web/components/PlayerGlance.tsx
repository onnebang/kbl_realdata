import Link from "next/link";
import {
  glancePercentileTone,
  type GlanceHeadline,
  type GlanceMetric,
  type PlayerGlance,
} from "@/lib/playerGlance";
import {
  PRESEASON_SEASON,
  basisChip,
  prevSeasonName,
  progressChip,
  statSeasonChip,
  type SeasonFocus,
} from "@/lib/seasonFocus";
import { displayTeamName } from "@/lib/teamNames";
import type { TeamMeta } from "@/lib/playerProfile";
import styles from "./PlayerGlance.module.css";

// 한눈 카드 - 요청("선수 자세히 보기에서 첫 화면에 한눈에 볼 수 있는 개인별 시각화").
// 히어로 바로 아래, 기존 패널 전부보다 위에 깔린다. 참고는 DARKO / Thinking-Basketball의
// 선수 카드(작은 숫자 격자 + 각 숫자 밑의 퍼센타일 마커, SCORING / PLAYMAKING / DEFENSE 블록).
//
// ── 이 컴포넌트가 지키는 것 ─────────────────────────────────────────────────────────
// (1) 격자 모양은 선수마다 같다. lib/playerGlance.ts가 항상 22칸을 같은 순서로 주고, 값이
//     없는 칸도 지우지 않는다 - 회색으로 그리고 "왜 없는지"를 인쇄한다(값이 아예 없는 칸은
//     그 이유가 발밑 줄에 그대로 보이고, 값은 있는데 표본이 하한 미달인 칸은 점선 테두리 +
//     title 툴팁으로 이유를 준다). 조은후(로스터 중앙값)와 워니의 카드가 같은 격자다.
// (2) 퍼센타일 색 언어는 사이트 기존 규칙 그대로 - 70 이상 --positive / 30 이하 --negative /
//     사이 --gold(선수 페이지 percentileColor, 팀 페이지 4팩터 패널과 같은 경계).
//     방향이 없는 스타일 지표(USG%·림 비중·3점 비중)에는 좋고나쁨 색을 쓰지 않는다.
// (3) 75포제션당 값에는 퍼센타일이 없다(리그 전 선수의 추정 포제션 풀을 만들 수 없다).
//     퍼센타일 바를 흉내 내지 않고 "리그 평균 눈금 + 배수"라는 다른 시각 언어를 쓴다 -
//     초록/빨강/골드가 아니라 --away 계열이라 한눈에 다른 종류의 막대로 읽힌다.
// (4) 클라이언트 JS 0. 상태도 핸들러도 없고, 접기는 순수 <details>, 설명은 title 속성이다.
//     SVG를 그리지 않으므로 JSX <svg><title> 함정 자체가 없다.
// (5) 한글은 전부 Pretendard(문서 기본 서체). Big Shoulders Display는 숫자에만 쓴다 -
//     이 저장소가 세 번 밟은 함정(한글 글리프가 없어서 폴백 서체로 넘어간다). "46점"처럼
//     숫자와 한글이 붙는 자리는 숫자만 span으로 떼어낸다.

export type PlayerGlanceProps = {
  /** lib/playerGlance.ts getPlayerGlance() 결과. 절대 null이 아니다(없는 선수도 22칸 dim). */
  glance: PlayerGlance;
  /** lib/seasonFocus.ts resolvePlayerSeasons() 결과. 카드 상단 기준 칩을 여기서 만든다. */
  focus: SeasonFocus;
  /** lib/playerProfile.ts getAllTeams() 결과. 커리어 하이 상대 팀 이름/약칭 표기에만 쓴다. */
  teams?: Map<string, TeamMeta>;
  /** 페이지가 이미 다른 문구를 만들었으면 그걸 그대로 쓴다(?season= 직접 선택 등). */
  chip?: string | null;
};

// ---------------------------------------------------------------------------
// 문구 헬퍼 - 어휘는 전부 lib/seasonFocus.ts에서 온다(페이지마다 다른 문구가 생기지 않도록)
// ---------------------------------------------------------------------------

/**
 * 카드 하나가 다는 단 하나의 기준 칩. 선수 페이지의 panelChip과 같은 규칙이다 -
 * glance가 집계한 시즌(glance.statSeason)이 focus.statSeason과 같으면 표준 칩,
 * 다르면 그 시즌을 명시한 칩("23-24 · 마지막 KBL 시즌" / "26-27 진행 중 · N경기").
 */
function glanceChip(focus: SeasonFocus, season: string | null): string {
  if (!season || season === focus.statSeason) return statSeasonChip(focus);
  if (season === PRESEASON_SEASON) return basisChip("inprogress", { n: focus.focusGp, threshold: focus.thresholdLabel });
  return basisChip("final", { season, last: season < prevSeasonName(PRESEASON_SEASON) });
}

/**
 * 헤드라인 문장에서 순위 부분만("리그 최상위 (152명 중)").
 * 문구 규칙("최상위"/"상위 N%"/"하위 N%")을 여기서 다시 만들지 않는다 - lib이 이미 완성 문장을
 * 들고 있으니 앞머리(라벨 + 값)만 잘라낸다. 잘라내기가 실패하면 문장을 통째로 쓴다(절대 안 깨짐).
 */
function rankTail(h: GlanceHeadline): string {
  const prefix = `${h.label} ${h.display} · `;
  return h.sentence.startsWith(prefix) ? h.sentence.slice(prefix.length) : h.sentence;
}

/** 칸 하나의 전체 설명(title 툴팁). 값·표본·기준·주석을 한 줄로. */
function cellTitle(m: GlanceMetric): string {
  const parts = [`${m.label} ${m.display}`, m.basis, m.sample];
  if (m.poolRule) parts.push(`퍼센타일 자격 ${m.poolRule}`);
  if (m.note) parts.push(m.note);
  return parts.join(" · ");
}

type MeterKind = "pct" | "league" | "none";

/**
 * 칸마다 어떤 마커를 그릴지.
 *   pct    - 리그 퍼센타일 바(값과 퍼센타일이 같은 표본에서 나온 8개 축)
 *   league - 리그 평균 눈금 + 배수(75포제션당 - 퍼센타일 풀을 만들 수 없는 지표)
 *   none   - 리그 맥락 자체가 없는 지표(PER·PIE·WPA·온오프·AST/TOV·슛 구성비).
 *            빈 막대를 그리면 "리그 어디쯤"이라고 거짓말이 되므로 점선 기준선만 남긴다.
 */
function meterKind(m: GlanceMetric): MeterKind {
  if (m.percentile != null) return "pct";
  if (m.value != null && m.leagueAvg != null && m.leagueAvg > 0) return "league";
  return "none";
}

// ---------------------------------------------------------------------------
// 칸
// ---------------------------------------------------------------------------

function GlanceCell({ m }: { m: GlanceMetric }) {
  const kind = meterKind(m);
  // neutral(USG%·림 비중·3점 비중)은 좋고나쁨이 없는 스타일 지표다 - 퍼센타일이 있어도 색을 쓰지 않는다.
  const tone = m.neutral ? "none" : glancePercentileTone(m.percentile);
  // metric()이 만드는 display는 unit이 "%"면 이미 %를 포함한다("49.5%") - 두 번 찍지 않는다.
  // 값이 없는 칸("-")에는 단위도 붙이지 않는다("-PPG"로 읽히지 않도록).
  const unit = m.value != null && m.unit && m.unit !== "%" ? m.unit : "";
  const ratio = kind === "league" && m.value != null && m.leagueAvg ? m.value / m.leagueAvg : null;
  // 리그 평균을 트랙 한가운데(50%)에 두고 값의 위치를 잡는다 - 평균의 2배가 오른쪽 끝.
  const pos = ratio == null ? 0 : Math.max(0, Math.min(100, ratio * 50));

  // 발밑 한 줄. 값이 아예 없는 칸에서는 "왜 없는지"가 여기 그대로 인쇄된다(호버 없이도 읽힌다).
  // 퍼센타일 칸은 "풀 152명"이라고 쓴다 - "152명 중"이라고 쓰면 오른쪽의 퍼센타일 숫자와 붙어
  // "152명 중 100위"로 읽힐 수 있다(퍼센타일은 순위가 아니다).
  const foot =
    m.value == null
      ? m.sample
      : kind === "league"
        ? `${m.leagueLabel ?? "리그 평균"} · ${ratio!.toFixed(2)}배`
        : kind === "pct" && m.poolN != null
          ? `풀 ${m.poolN.toLocaleString()}명`
          : m.sample;

  return (
    <div
      className={styles.cell}
      data-tone={tone}
      data-dim={m.dim ? "1" : undefined}
      data-empty={m.value == null ? "1" : undefined}
      title={cellTitle(m)}
    >
      <div className={styles.cLabel}>{m.label}</div>
      <div className={styles.cVal}>
        <span className={styles.cNum}>{m.display}</span>
        {unit ? <span className={styles.cUnit}>{unit}</span> : null}
      </div>
      {kind === "pct" ? (
        <div className={styles.meter}>
          <div className={styles.meterFill} style={{ width: `${m.percentile}%` }} />
          <div className={styles.meterMid} />
        </div>
      ) : kind === "league" ? (
        <div className={`${styles.meter} ${styles.meterLeague}`}>
          <div className={styles.meterFill} style={{ width: `${pos}%` }} />
          <div className={styles.meterMid} />
        </div>
      ) : (
        <div className={styles.meterNone} />
      )}
      <div className={styles.cFoot}>
        <span className={styles.cFootText}>{foot}</span>
        {m.percentile != null ? <span className={styles.cPct}>{m.percentile}</span> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 헤드라인 - "이 선수가 리그 평균에서 가장 멀리 떨어진 지점"
// ---------------------------------------------------------------------------

function HeadlineCell({ h, neutral }: { h: GlanceHeadline; neutral: boolean }) {
  const tone = neutral ? "none" : glancePercentileTone(h.percentile);
  return (
    <div className={styles.hlCell} data-tone={tone} title={h.sentence}>
      <div className={styles.hlLabel}>{h.label}</div>
      <div className={styles.hlValue}>{h.display}</div>
      <div className={styles.meter}>
        <div className={styles.meterFill} style={{ width: `${h.percentile}%` }} />
        <div className={styles.meterMid} />
      </div>
      <div className={styles.hlRank}>{rankTail(h)}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export function PlayerGlanceCard({ glance, focus, teams, chip }: PlayerGlanceProps) {
  const basis = chip ?? glanceChip(focus, glance.statSeason);
  // 개막 후·임계 전에만 붙는 두 번째 칩. glance가 다른 시즌을 집계했다면 붙이지 않는다(거짓이 된다).
  const progress = !chip && glance.statSeason === focus.statSeason ? progressChip(focus) : null;

  const neutralByKey = new Map(glance.metrics.map((m) => [m.key, m.neutral]));
  // 퍼센타일이 하나도 없어서 헤드라인이 빈 경우, 왜 없는지는 득점 칸의 sample이 문장으로 갖고 있다.
  const headlineWhy = glance.metrics.find((m) => m.key === "ppg")?.sample ?? "리그 퍼센타일 표본이 없다";
  // 격자에 살아 있는 값이 하나라도 있는가(퍼센타일 자격 미달과 "기록 자체가 없음"은 다른 상태다).
  const anyValue = glance.metrics.some((m) => m.value != null);

  // "수비 블록이 얇은 것은 디자인이 아니라 데이터의 한계다" - lib이 들고 있는 문장을 그대로 건다.
  // (인덱스가 아니라 내용으로 찾는다: notes 순서가 바뀌어도 엉뚱한 문장이 붙지 않는다.)
  const defenseNote = glance.notes.find((n) => n.includes("수비 정보는")) ?? null;

  const c = glance.career;
  const highOpp = c.high ? (teams?.get(c.high.oppTcode) ?? null) : null;
  const highOppName = c.high ? displayTeamName(c.high.oppTcode, highOpp?.name ?? c.high.oppTcode, c.high.seasonName) : null;
  const teamLine = c.teams.map((tc) => teams?.get(tc)?.abbr ?? tc).join(" · ");

  // 참고 카드(DARKO)식 세 통. 존 색은 아래 슈팅 DNA 밴드와 같은 계열(림 --home / 미드 --gold /
  // 3점 --away)이라 두 패널이 같은 색 언어를 쓴다.
  const diet = glance.shotDiet;
  const dietRows: { label: string; share: number; color: string }[] = diet
    ? [
        { label: "림", share: diet.buckets.rim, color: "var(--home)" },
        { label: "미드", share: diet.buckets.mid, color: "var(--gold)" },
        { label: "3점", share: diet.buckets.three, color: "var(--away)" },
      ]
    : [];

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <h2 className={styles.title}>한눈에 보기</h2>
        {/* 카드 전체가 다는 단 하나의 기준 칩(lib/seasonFocus.ts 어휘). */}
        <span className={styles.chip}>{basis}</span>
        {progress ? <span className={styles.chip}>{progress}</span> : null}
      </div>

      {/* ── 1. 헤드라인: 두 초 안에 "어떤 선수인가"를 읽히게 ── */}
      {glance.headline.length > 0 ? (
        <div className={styles.headlines}>
          {glance.headline.map((h) => (
            <HeadlineCell key={h.key} h={h} neutral={neutralByKey.get(h.key) ?? false} />
          ))}
        </div>
      ) : (
        <div className={styles.headlineEmpty}>
          {anyValue
            ? `리그 퍼센타일로 요약할 표본이 없다 - ${headlineWhy}. 아래 격자의 값은 그대로 남는다.`
            : `표시할 기록이 없다 - ${headlineWhy}. 격자는 칸을 지우지 않고 비운 채로 둔다.`}
        </div>
      )}

      {/* ── 2. 커리어 한 줄 ── */}
      <div className={styles.careerLine}>
        {c.games > 0 ? (
          <>
            <span className={styles.careerSeg}>
              커리어 <span className={styles.careerNum}>{c.games.toLocaleString()}</span>경기
            </span>
            <span className={styles.careerSeg}>
              <span className={styles.careerNum}>{c.seasons}</span>시즌
            </span>
            {c.entries > c.games ? (
              <span className={styles.careerSeg}>
                엔트리 <span className={styles.careerNum}>{c.entries.toLocaleString()}</span>
              </span>
            ) : null}
            {/* 결장은 0일 때 적지 않는다 - "결장 0"은 정보가 아니라 잡음이다(등록 창을 자른
                lib/careerGrain.ts 값이라 opts.grain을 넘긴 경우에만 채워져 있다). */}
            {c.absences != null && c.absences > 0 ? (
              <span className={styles.careerSeg}>
                결장 <span className={styles.careerNum}>{c.absences.toLocaleString()}</span>
              </span>
            ) : null}
            {c.high ? (
              <span className={styles.careerSeg}>
                {/* 숫자만 Big Shoulders, "점"은 Pretendard - 한 규칙 안에 섞으면 서체 이음매가 생긴다. */}
                커리어 하이{" "}
                <Link href={`/games/${c.high.gmkey}`} className={styles.careerLink}>
                  <span className={styles.careerNum}>{c.high.pts}</span>점
                </Link>
              </span>
            ) : null}
            {/* 날짜 + 상대 팀은 별도 조각 - 붙여 두면 좁은 화면에서 한 줄이 컨테이너를 밀어낸다. */}
            {c.high ? (
              <span className={`${styles.careerSeg} ${styles.careerWrapOk} ${styles.careerFaint}`}>
                {c.high.date} vs {highOppName}
              </span>
            ) : null}
            {teamLine ? (
              <span className={`${styles.careerSeg} ${styles.careerWrapOk} ${styles.careerFaint}`}>{teamLine}</span>
            ) : null}
          </>
        ) : (
          <span className={`${styles.careerSeg} ${styles.careerWrapOk}`}>
            커리어 출전 기록 없음 (엔트리 {c.entries.toLocaleString()})
          </span>
        )}
      </div>

      {/* ── 3. 격자: 득점 / 플레이메이킹 / 리바운드·수비 / 임팩트 ── */}
      {glance.groups.map((g) => (
        <div className={styles.group} key={g.group}>
          <div className={styles.groupHead}>
            <span className={styles.groupTitle}>{g.group}</span>
            {g.group === "리바운드·수비" && defenseNote ? (
              <span className={styles.groupNote}>{defenseNote}</span>
            ) : null}
          </div>
          <div className={styles.cells}>
            {g.metrics.map((m) => (
              <GlanceCell key={m.key} m={m} />
            ))}
          </div>
        </div>
      ))}

      {/* ── 4. 슛 구성(참고 카드식 세 통) ── */}
      {diet ? (
        <div className={styles.diet} data-dim={diet.thin ? "1" : undefined} title={diet.sample}>
          <div className={styles.dietHead}>
            <span className={styles.groupTitle}>슛 구성</span>
            <span className={styles.dietSample}>{diet.sample}</span>
          </div>
          <div className={styles.dietBar}>
            {dietRows.map((r) => (
              <span key={r.label} className={styles.dietSeg} style={{ width: `${r.share * 100}%`, background: r.color }} />
            ))}
          </div>
          <div className={styles.dietLegend}>
            {dietRows.map((r) => (
              <span className={styles.dietItem} key={r.label}>
                <span className={styles.dietSwatch} style={{ background: r.color }} />
                {r.label} <span className={styles.dietPct}>{(r.share * 100).toFixed(1)}%</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── 5. 기준과 한계 ── */}
      <div className={styles.caption}>{glance.caption}</div>
      <div className={styles.caption}>
        퍼센타일 바가 없는 칸은 리그 풀을 만들 수 없는 지표다 - 75포제션당 칸은 대신 가운데 눈금(리그
        평균)과 배수로 그린다. 회색 칸은 표본이 없거나 표시 하한 미달이며, 칸에 마우스를 올리면 이유가
        나온다.
      </div>
      <details className={styles.more}>
        <summary className={styles.moreSummary}>이 카드가 말할 수 없는 것 · 표본 정의</summary>
        {glance.percentilePool ? (
          <div className={styles.moreLine}>
            퍼센타일 풀 {glance.percentilePool.n.toLocaleString()}명 · 자격 {glance.percentilePool.rule} ·{" "}
            {glance.percentilePool.basis}
            {glance.percentilePool.qualified ? "" : " · 이 선수는 자격 미달이라 값만 표시한다"}
          </div>
        ) : null}
        <ul className={styles.moreList}>
          {glance.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <dl className={styles.defs}>
          {glance.metrics
            .filter((m) => m.note)
            .map((m) => (
              <div className={styles.defRow} key={m.key}>
                <dt className={styles.defTerm}>{m.label}</dt>
                <dd className={styles.defDesc}>
                  {m.note}
                  <span className={styles.defBasis}>
                    {m.basis} · {m.sample}
                  </span>
                </dd>
              </div>
            ))}
        </dl>
      </details>
    </section>
  );
}
