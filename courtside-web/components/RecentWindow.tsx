import Link from "next/link";
import {
  PCT_MIN_ATTEMPTS,
  PER36_BASE,
  PER36_MIN_MINUTES,
  RECENT_RATE_PARAM,
  buildRecentGaugeSvg,
  buildRecentWindow,
  formatRecentDelta,
  formatRecentRange,
  formatRecentValue,
  recentDeltaTone,
  type RecentRate,
  type RecentRow,
} from "@/lib/recentWindow";
import type { CareerGameRow } from "@/lib/playerProfile";
import styles from "./RecentWindow.module.css";

// ── 최근 N경기 패널 ──────────────────────────────────────────────────────────────────
// 요청: "최근 5,10,15,30경기가 보기가 좀 어려운데, 가시성 좋게, 디자인 좋게 변경".
//
// 옛 화면은 값 하나짜리 타일 10개였다. 그 타일이 감춘 것 세 가지를 이 패널이 전부 드러낸다:
//   (1) 분포 - 워니(291248) L15는 평균 21.5점이지만 실제로는 6~38점이었다(2026-09-04 실측).
//       그래서 행마다 경기별 점 스트립이 붙는다. 평균은 그 위의 눈금 하나로 내려온다.
//   (2) 창의 정체 - L15가 어느 날짜·어느 시즌·정규 몇 경기·PO 몇 경기·결장 몇 경기인지.
//       실측(2026-09-04, 25-26 300분+ 111명): L10·L15의 57.7%가 정규+PO 혼재이고 19명은 L5
//       다섯 경기가 전부 플레이오프다. 창 구성은 '보는 날짜'의 함수라 다음 시즌 데이터가
//       들어오면 조용히 바뀐다 - 그래서 헤더가 매번 실제 구성을 다시 인쇄한다.
//   (3) 출전 시간 - 창 차이의 73%가 출전 시간 변화로 설명된다(corr(ΔMIN, ΔPTS)=0.856).
//       MIN이 첫 칸이고, 36분당 전환이 링크 하나로 붙는다.
//
// 표현 형식(2차 개편): 가로 점 스트립 -> 원형 게이지 격자.
// 요청 - "항목이 작게 표시되다보니, 지금 이게 무엇을 표현하는지 보이지가 않아". 스트립이
// 실패한 지점은 정확히 크기였다. 한 행에 430×52 그림이 열 개 쌓이니 점 하나가 2.7px이고 그
// 안에서 축·눈금·점이 겹쳐 "무엇을 말하는 그림인지"가 먼저 안 읽혔다. 게이지는 같은 정보를
// 지표당 100×100으로 펴서 담는다 - 값은 채워진 호, 커리어 평균은 링 위 눈금, 경기별 분포는
// 링 바깥으로 쌓이는 점. 분포를 버리지 않은 이유는 위 (1) 그대로다.
//
// 렌더링 규칙(프로젝트 하드 룰):
//   - 서버 컴포넌트. "use client" 없음, state·이벤트 핸들러 없음. 단위 전환은 쿼리스트링 링크.
//   - 차트는 raw SVG 문자열 + dangerouslySetInnerHTML. JSX <svg> 안에 JSX <title> 금지
//     (React 19가 문서 title로 끌어올려 하이드레이션이 깨진다) - 점 툴팁은 문자열 안의
//     네이티브 <title>이다.
//   - Big Shoulders Display에는 한글 글리프가 없다. 이 파일에서 그 폰트가 닿는 곳은
//     .vMain / .short 뿐이고 둘 다 숫자와 라틴 약어만 담는다.

export type RecentWindowProps = {
  /** 페이지가 이미 받아 둔 getPlayerCareerGames() 결과. 이 컴포넌트는 조회를 하지 않는다. */
  careerRows: CareerGameRow[];
  /** 창 크기(L5/L10/L15/L30). 페이지의 windowN을 그대로 넘긴다 - 토글은 페이지가 그린다. */
  windowN: number;
  /** 현재 단위. 보통 resolveRecentRate(searchParams[RECENT_RATE_PARAM]). */
  rate?: RecentRate;
  /** 단위 링크가 유지해야 할 나머지 쿼리(?w= · ?season= · ?rate=). 페이지의 searchParams 그대로. */
  query?: Record<string, string | string[] | undefined>;
  /** 단위를 싣는 쿼리 파라미터 이름. 기본 RECENT_RATE_PARAM("rw"). */
  rateParam?: string;
  /** tcode -> 팀 약칭. 페이지가 이미 만든 teamAbbrs를 넘기면 점 툴팁에 상대가 찍힌다. */
  teamAbbrs?: Map<string, string>;
  /** 패널 제목. 기본 "최근 N경기 기록"(N은 실제 집계 경기 수). */
  title?: string;
  /** 앵커 링크용 id. */
  id?: string;
};

const RATE_OPTIONS: { rate: RecentRate; label: string; note: string }[] = [
  {
    rate: "perGame",
    label: "경기당",
    note: "창의 합계를 경기 수로 나눈 값. 결장(0분) 경기도 분모에 그대로 들어간다.",
  },
  {
    rate: "per36",
    label: `${PER36_BASE}분당`,
    note:
      `합계를 창 출전 시간으로 나눠 ${PER36_BASE}분에 맞춘 값. 창 차이의 73%가 출전 시간 변화로 ` +
      "설명되므로(실측 corr(ΔMIN, ΔPTS)=0.856), 여기서도 차이가 남아야 '잘하게 된 것'이다. " +
      "MIN(그 자체가 분모)과 퍼센트 세 행은 바뀌지 않는다.",
  },
];

/** 나머지 쿼리는 그대로 두고 한 파라미터만 갈아끼운다(다른 토글의 선택을 지우지 않게). */
function hrefWith(
  query: Record<string, string | string[] | undefined> | undefined,
  param: string,
  value: string
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (k === param || v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, v);
  }
  sp.set(param, value);
  return `?${sp.toString()}`;
}

/** 분 표기. 한 자리 수 분은 반올림해 버리면 "1.2분"이 "1분"이 된다 - 그 차이가 곧 표본이다. */
function fmtMinutes(v: number): string {
  return v < 10 ? v.toFixed(1) : v.toFixed(0);
}

function toneClass(tone: "good" | "bad" | "flat" | "role"): string {
  if (tone === "good") return styles.dGood;
  if (tone === "bad") return styles.dBad;
  if (tone === "role") return styles.dRole;
  return styles.dFlat;
}

/** 값 칸 아래 작은 줄 - 지금 보고 있지 않은 쪽 단위(또는 퍼센트 행의 성공/시도). */
function altLine(row: RecentRow, rate: RecentRate, windowMinutes: number): { text: string; mono: boolean } | null {
  if (row.def.kind === "pct") {
    return row.attempts != null ? { text: `${row.makes}/${row.attempts}`, mono: true } : null;
  }
  // MIN은 36분당의 분모라 전환 대상이 아니다. 대신 창 합계 분을 적어 둔다 - 36분당이 가능한
  // 창인지(20분 이상), 결장이 얼마나 섞였는지를 이 한 줄로 가늠하게.
  if (!row.def.per36) return { text: `합계 ${fmtMinutes(windowMinutes)}분`, mono: false };
  if (rate === "per36") {
    return row.perGame != null ? { text: `경기당 ${row.perGame.toFixed(row.def.digits)}`, mono: false } : null;
  }
  return row.per36 != null ? { text: `${PER36_BASE}분당 ${row.per36.toFixed(row.def.digits)}`, mono: false } : null;
}

export function RecentWindow({
  careerRows,
  windowN,
  rate = "perGame",
  query,
  rateParam = RECENT_RATE_PARAM,
  teamAbbrs,
  title,
  id,
}: RecentWindowProps) {
  const data = buildRecentWindow(careerRows, { windowN, rate, teamAbbrs });
  if (!data) {
    return (
      <section className={styles.panel} id={id}>
        <div className={styles.head}>
          <h3 className={styles.title}>최근 경기</h3>
        </div>
        <div className={styles.empty}>종료된 경기 기록이 없다</div>
      </section>
    );
  }

  const { facts, rows } = data;
  const activeRate = data.rate;
  const rateMeta = RATE_OPTIONS.find((o) => o.rate === activeRate) ?? RATE_OPTIONS[0];

  return (
    <section className={styles.panel} id={id}>
      <div className={styles.head}>
        {/* 제목의 숫자는 요청한 N이 아니라 실제로 집계한 엔트리 수다 - 통산 9경기 선수에게
            '최근 30경기'라고 쓰면 없는 표본을 주장하게 된다. */}
        <h3 className={styles.title}>{title ?? `최근 ${facts.n}경기 기록`}</h3>
      </div>

      {/* ── 창 사실 헤더 ──────────────────────────────────────────────────────────── */}
      <div className={styles.facts}>
        <span className={styles.fact} title={`요청한 창은 L${facts.requestedN}`}>
          <b>{facts.n}</b>경기
        </span>
        <span className={styles.fact}>
          <b>
            {facts.firstDate}~{facts.lastDate}
          </b>
        </span>
        <span className={styles.fact}>
          <b>{facts.seasonLabels.join("·")}</b>
          {facts.seasonLabels.length > 1 ? "시즌 걸침" : "시즌"}
        </span>
        <span className={styles.fact}>
          정규 <b>{facts.regular}</b>
        </span>
        {facts.playoff > 0 && (
          <span className={`${styles.fact} ${styles.factPo}`}>
            플레이오프 <b>{facts.playoff}</b>
          </span>
        )}
        {facts.dnp > 0 && (
          <span className={`${styles.fact} ${styles.factWarn}`} title="0분 출전 - 평균의 분모에는 들어가고 분자에는 0으로 들어간다">
            결장 <b>{facts.dnp}</b>
          </span>
        )}
        <span className={styles.fact}>
          출전 <b>{fmtMinutes(facts.minutes)}</b>분
        </span>
      </div>

      <p className={styles.lede}>
        채워진 호가 <b>이 창의 값</b>, 링을 가로지르는 눈금이 <b>커리어 평균</b>, 링 바깥의 점 하나가{" "}
        <b>그 창의 경기 하나</b>다. 같은 값에 몰린 경기는 바깥으로 쌓여서 둘레의 두께가 그대로 빈도가 된다 - 평균 한
        줄로는 사라지는 폭을 그림이 그대로 들고 있게.
      </p>

      {/* ── 단위 토글(경기당 / 36분당) ────────────────────────────────────────────── */}
      <div className={styles.toggleRow} role="group" aria-label="최근 창 단위">
        {RATE_OPTIONS.map((o) =>
          o.rate === "per36" && !facts.per36Available ? (
            <span key={o.rate} className={styles.toggleOff} title={`창 합계 ${facts.minutes.toFixed(1)}분`}>
              {o.label}
            </span>
          ) : (
            <Link
              key={o.rate}
              href={hrefWith(query, rateParam, o.rate)}
              scroll={false}
              className={`${styles.toggle} ${o.rate === activeRate ? styles.toggleActive : ""}`}
              aria-current={o.rate === activeRate ? "true" : undefined}
            >
              {o.label}
            </Link>
          )
        )}
        <span className={styles.toggleNote}>{rateMeta.note}</span>
      </div>

      {/* ── 범례 ─────────────────────────────────────────────────────────────────── */}
      <div className={styles.legend}>
        <span className={styles.legItem}>
          <i className={styles.legDot} aria-hidden />
          경기
        </span>
        <span className={styles.legItem}>
          <i className={styles.legPo} aria-hidden />
          플레이오프
        </span>
        <span className={styles.legItem}>
          <i className={styles.legDnp} aria-hidden />
          결장(0분)
        </span>
        <span className={styles.legItem}>
          <i className={styles.legArc} aria-hidden />창 값
        </span>
        <span className={styles.legItem}>
          <i className={styles.legTick} aria-hidden />
          커리어 평균
        </span>
      </div>

      {/* 36분당 축에 점을 얹지 않는 이유는 칸마다가 아니라 여기서 한 번만 말한다 - 같은 문장이
          여섯 칸에 반복되면 그 자체가 소음이다. */}
      {activeRate === "per36" && rows.some((r) => r.def.per36) && (
        <p className={styles.omitNote}>
          {PER36_BASE}분당 축에는 경기별 점을 얹지 않는다 - 3분 뛴 밤을 {PER36_BASE}분으로 늘린 점(4점 → 48점)은 실제로
          일어난 적이 없는 밤이고, 그런 점이 축을 지배하면 그림이 거짓말을 한다. 분포를 보려면 경기당으로 돌아가면 된다.
        </p>
      )}

      {/* ── 지표 게이지 ──────────────────────────────────────────────────────────── */}
      <div className={styles.grid}>
        {rows.map((row) => {
          const gauge = buildRecentGaugeSvg(row, activeRate);
          const alt = altLine(row, activeRate, facts.minutes);
          const range = formatRecentRange(row);
          const tone = recentDeltaTone(row);
          // 커리어 대비 Δ가 무엇과 비교한 값인지는 카드마다 title로 붙인다 - 화면에 줄을 하나 더
          // 만드는 대신(칸 하나가 120px이라 넉 줄이 한계다).
          const deltaTitle =
            row.career == null
              ? "커리어 표본이 없어 비교하지 않는다"
              : `커리어 ${formatRecentValue(row, row.career)} 대비` +
                (row.noise != null
                  ? ` · 창 내부 표준오차 ±${row.noise.toFixed(row.def.digits)}${row.def.kind === "pct" ? "p" : ""}` +
                    (row.meaningful ? "" : " - 이 차이는 노이즈와 구분되지 않는다")
                  : " · 표본이 하나뿐이라 오차 폭을 잴 수 없다");
          const axisTop =
            gauge == null ? "-" : row.def.kind === "pct" ? "100%" : gauge.domainMax % 1 === 0 ? String(gauge.domainMax) : gauge.domainMax.toFixed(1);
          return (
            <div key={row.def.key} className={styles.cell}>
              <div className={styles.gauge}>
                {gauge ? (
                  <svg
                    className={styles.ring}
                    viewBox={gauge.viewBox}
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label={`${row.def.label} ${formatRecentValue(row, row.value)} · 0부터 ${axisTop}까지의 축 · 커리어 평균 ${formatRecentValue(row, row.career)} · 경기별 실제 ${range ?? "표본 없음"}`}
                    dangerouslySetInnerHTML={{ __html: gauge.svg }}
                  />
                ) : (
                  <div className={styles.ringEmpty} aria-hidden />
                )}
                {/* 가운데 숫자는 HTML이다 - SVG 안에 두면 폰트 토큰을 못 쓰고, 한글 라벨이
                    Big Shoulders(한글 글리프 없음)에 닿을 위험이 생긴다. */}
                <div className={styles.center}>
                  <span className={`${styles.vMain} ${row.thin ? styles.vDim : ""}`}>{formatRecentValue(row, row.value)}</span>
                  <span className={styles.short}>{row.def.short}</span>
                </div>
              </div>

              <div className={styles.cellName}>{row.def.label}</div>

              <div className={styles.cellDelta} title={deltaTitle}>
                <span className={`${styles.dVal} ${toneClass(tone)}`}>{formatRecentDelta(row, row.delta)}</span>
                {row.noise != null && (
                  <span className={styles.dNoise}>
                    ±{row.noise.toFixed(row.def.digits)}
                    {row.def.kind === "pct" ? "p" : ""}
                  </span>
                )}
              </div>

              <div className={styles.cellSub}>
                {/* 축의 끝을 적지 않으면 호의 길이는 아무 뜻이 없다. */}
                <span className={styles.subAxis}>0~{axisTop}</span>
                {range && <span className={styles.subRange}>실제 {range}</span>}
                {alt && <span className={alt.mono ? styles.subNum : undefined}>{alt.text}</span>}
              </div>

              {row.note && <div className={styles.cellNote}>{row.note}</div>}
            </div>
          );
        })}
      </div>

      {/* ── 각주: 정의가 먼저, 경고가 그다음 ────────────────────────────────────── */}
      <div className={styles.notes}>
        <div className={styles.note}>{data.definition}</div>
        {data.rateFellBack && (
          <div className={`${styles.note} ${styles.noteWarn}`}>
            {PER36_BASE}분당을 요청했지만 창 합계 출전이 {facts.minutes.toFixed(1)}분({PER36_MIN_MINUTES}분 미만)이라 경기당으로
            되돌렸다
          </div>
        )}
        {data.warnings.map((w) => (
          <div key={w} className={`${styles.note} ${styles.noteWarn}`}>
            {w}
          </div>
        ))}
        <div className={styles.note}>
          FG%는 2점과 3점을 합친 진짜 야투 성공률이다((fgm+tpm)/(fga+tpa)) - 이 DB의 fga/fgm은 2점 전용이라 그대로
          쓰면 2P%가 FG%로 찍힌다. 퍼센트 세 행은 시도 {PCT_MIN_ATTEMPTS}회 미만이면 회색으로 눌러 둔다. 점은 단위를{" "}
          {PER36_BASE}분당으로 바꿔도 언제나 그 경기의 실제 값이다.
        </div>
      </div>
    </section>
  );
}
