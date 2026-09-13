import type { Metadata } from "next";
import Link from "next/link";
import { TrailerScroll } from "@/components/TrailerScroll";
import { COURT_X, HOOP_RIGHT, drawCourtMarkings } from "@/lib/zoneCompare";
import styles from "./trailer.module.css";

// 소개 페이지(/trailer).
//
// 처음엔 40초짜리 자동 재생 플레이어였다. 요청으로 스크롤 페이지가 됐다 - "40초 영상이
// 재생되는게 아니라 (…) 스크롤을 내릴시 해당 내용들이 보이고, 클릭시 해당 내용으로 가도록".
// 그래서 시간이 아니라 스크롤이 페이지를 몬다:
//   - 절 여덟 개가 위에서 아래로 놓이고, 화면에 들어올 때 한 번 드러난다(components/TrailerScroll).
//   - 2~6절은 절 전체가 그 페이지로 가는 링크다. 그 안에 다른 링크를 넣지 않는다(중첩 <a> 금지).
//   - 왼쪽 레일(≥1120px)은 평범한 앵커 링크 여덟 개다. 자바스크립트가 없어도 그냥 작동한다.
//
// 그림은 data: URI가 아니라 public/trailer/*.jpg(CDN 캐시, 8장 564KB). 크기는 표시 폭에서
// 역산했다(데스크톱 1280 / 모바일 3장 560).
//
// 숫자는 전부 이 저장소가 DB로 확인한 값이다(2026-09-08 기준). 바뀌면 여기와 아래 sheet를 같이
// 고쳐야 한다 - 정직성 원칙상 "대략 이 정도"는 쓰지 않는다:
//   정규시즌 15시즌·3,993경기(2011-12~2025-26) / 팀-경기 7,986 / game_events 약 240만 행 /
//   26-27 일정 270경기 / 팀 조합 90 / 사전 승률 모델 피처 29 / 김선형 커리어 685경기·슛 7,300·
//   WPA 25-26 +8.3 / 감독 35명·감독-시즌 150·채택 지표 3/6 / 26-27 명단 198·로스터 변동 261·
//   확정 결장 13 / 시즌 시뮬 10만.
//
// 가시성 규칙: 이 파일이 낸 HTML이 곧 완성된 문서다. 헤드라인·리드·숫자·화면은 자바스크립트
// 없이도 전부 보이고, 진입 모션은 .in 클래스가 붙을 때만 발화한다(trailer.module.css).

export const metadata: Metadata = {
  title: "코트사이드 소개",
  description: "KBL 15시즌 플레이 로그로 만든 코트사이드를 여덟 화면으로 봅니다. 경기 목록·리플레이·선수·감독·개막 리포트.",
};

// 이 페이지는 DB를 보지 않아서 Next가 정적으로 굽는다. 그대로 두면 배포한 날의 D-day가 HTML에
// 박힌 채 남는다(실측: 프리렌더 산출물에 D-24가 박혀 있었다) - 하루가 지나면 틀린 숫자다.
// 한 시간마다 다시 굽게 해서 날짜가 바뀌면 늦어도 한 시간 안에 따라온다.
export const revalidate = 3600;

const OPENING_KST = Date.UTC(2026, 9, 3) - 9 * 3600000; // 2026-10-03 00:00 KST

function daysToOpening(): number {
  // 서버 시계는 UTC다(Vercel). KST 자정을 기준으로 세지 않으면 한국 시간 00:00~09:00 동안
  // 하루가 어긋난다. 9시간 밀어서 날짜 경계를 KST에 맞춘 뒤 다시 되돌린다.
  const kstMidnight = Math.floor((Date.now() + 9 * 3600000) / 86400000) * 86400000 - 9 * 3600000;
  return Math.max(0, Math.round((OPENING_KST - kstMidnight) / 86400000));
}

// 첫 절 배경의 코트 - 제품 슛맵이 쓰는 그 좌표계(lib/zoneCompare.ts) 그대로. 손으로 다시 그리지 않는다.
const COURT_SVG = drawCourtMarkings(HOOP_RIGHT[0], COURT_X[1], -1, "currentColor", 0.7);

type Stat = { v: string; k: string; tone?: "flame" | "gold"; dec?: number; prefix?: string; unit?: string };

type Scene = {
  id: string;
  href: string;
  brow: string;
  headline: [string, string];
  lede: React.ReactNode;
  stats: Stat[];
  /** 배경 아웃라인 워터마크 - 이 절의 표본 하나(숫자만). */
  wm: string;
  /** 표본 한 줄 - 숫자의 기준을 적는다. */
  basis: string;
  cta: string;
  shot: { src: string; path: string; alt: string };
};

// 2~6절. 1(첫 절)·7(모바일)·8(마지막)은 모양이 달라 아래에서 직접 그린다.
const SCENES: Scene[] = [
  {
    id: "s2",
    href: "/",
    brow: "경기 목록",
    headline: ["270경기 전부,", "모델이 먼저 답을 낸다"],
    lede: (
      <>
        26-27 정규시즌 일정 <b>270경기</b>가 들어와 있고, 아직 열리지 않은 경기에도 사전 승률이 붙는다. 90개 팀 조합 전부가 추정이 아닌 모델 값이다.
      </>
    ),
    stats: [
      { v: "270", k: "예정 경기" },
      { v: "90", k: "팀 매치업" },
      { v: "29", k: "모델 피처", tone: "flame" },
    ],
    wm: "270",
    basis: "26-27 정규시즌 일정 270경기 기준",
    cta: "경기 목록 열기",
    shot: { src: "/trailer/home-dark.jpg", path: "courtside-web-ten.vercel.app", alt: "경기 목록 화면 - 26-27 시즌 예정 경기와 예상 승률" },
  },
  {
    id: "s3",
    href: "/games/S47G01N262",
    brow: "경기 리플레이",
    headline: ["플레이 하나가", "승률을 얼마나 밀었나"],
    lede: <>15시즌치 플레이 로그를 그대로 되감는다. 스크러버를 끌면 그 시점의 박스스코어·코트 위 5인·승률이 같이 움직인다.</>,
    stats: [
      { v: "15", k: "시즌" },
      { v: "3993", k: "정규시즌 경기" },
      { v: "240", k: "플레이 로그", tone: "flame", unit: "만" },
    ],
    wm: "3,993",
    basis: "2011-12~2025-26 · 팀-경기 7,986 · 플레이 로그 약 240만 행",
    cta: "이 경기 열기",
    shot: { src: "/trailer/game.jpg", path: "/games/S47G01N262", alt: "경기 상세 화면 - 승률 흐름과 플레이바이플레이 리플레이" },
  },
  {
    id: "s4",
    href: "/players/290407",
    brow: "선수 프로필",
    headline: ["커리어 685경기가", "띠 하나에 다 있다"],
    lede: (
      <>
        칸 하나가 하룻밤이다. 높이는 그날 득점, 색은 그날의 소속팀, 빈칸은 결장. <b>이적하면 띠 중간에서 색이 바뀐다</b> - 따로 그린 게 아니라 데이터가 그렇게 만든다.
      </>
    ),
    stats: [
      { v: "685", k: "커리어 경기" },
      { v: "7300", k: "슛 좌표" },
      { v: "8.3", k: "WPA · 25-26", tone: "gold", dec: 1, prefix: "+" },
    ],
    wm: "685",
    basis: "김선형 · 커리어 685경기 · 슛 좌표 7,300",
    cta: "선수 프로필 열기",
    shot: { src: "/trailer/player.jpg", path: "/players/290407", alt: "선수 프로필 화면 - 커리어 결 띠와 리그 퍼센타일" },
  },
  {
    id: "s5",
    href: "/coaches/28",
    brow: "감독 프로필",
    headline: ["검정을 통과한", "지표만 화면에 올린다"],
    lede: (
      <>
        감독 지표 6종을 15시즌으로 먼저 쟀다. ATO 효율과 챌린지 성공률은 <b>노이즈와 구분되지 않아 싣지 않았다</b>. 남긴 것도 &quot;감독 효과&quot;가 아니라 &quot;재임기 팀 기록&quot;이라고 적는다.
      </>
    ),
    stats: [
      { v: "35", k: "감독" },
      { v: "150", k: "감독-시즌" },
      { v: "3", k: "채택 지표 / 6", tone: "flame" },
    ],
    wm: "35",
    basis: "감독 35명 · 감독-시즌 150",
    cta: "감독 프로필 열기",
    shot: { src: "/trailer/coach.jpg", path: "/coaches/28", alt: "감독 프로필 화면 - 통산 기록과 재임기 팀 스타일" },
  },
  {
    id: "s6",
    href: "/preseason",
    brow: "개막 리포트",
    headline: ["이적과 이탈까지", "반영한 개막 전망"],
    lede: (
      <>
        26-27 로스터를 다시 조립해 팀 전력을 민다. 입대·해외 진출로 빠진 <b>확정 결장 13명</b>과 새 외국인 선수까지 근거를 열어 보여준다.
      </>
    ),
    stats: [
      { v: "198", k: "26-27 명단" },
      { v: "261", k: "로스터 변동" },
      { v: "100000", k: "시즌 시뮬레이션", tone: "flame" },
    ],
    wm: "198",
    basis: "26-27 명단 198 · 로스터 변동 261 · 확정 결장 13",
    cta: "개막 리포트 열기",
    shot: { src: "/trailer/preseason.jpg", path: "/preseason", alt: "개막 리포트 화면 - 팀별 전력 조정과 예상 순위" },
  },
];

const NAV: { id: string; label: string }[] = [
  { id: "s1", label: "코트사이드" },
  { id: "s2", label: "경기 목록" },
  { id: "s3", label: "리플레이" },
  { id: "s4", label: "선수" },
  { id: "s5", label: "감독" },
  { id: "s6", label: "개막 리포트" },
  { id: "s7", label: "모바일" },
  { id: "s8", label: "시작하기" },
];

function StatBlock({ s }: { s: Stat }) {
  return (
    <div className={styles.stat}>
      <div className={`${styles.v} ${s.tone === "flame" ? styles.flame : s.tone === "gold" ? styles.gold : ""}`}>
        {(s.prefix ?? "") + Number(s.v).toLocaleString("ko-KR", { minimumFractionDigits: s.dec ?? 0, maximumFractionDigits: s.dec ?? 0 })}
        {s.unit && <span className={styles.unit}>{s.unit}</span>}
      </div>
      <div className={styles.k}>{s.k}</div>
    </div>
  );
}

function Headline({ lines }: { lines: [string, string] }) {
  return (
    <h2 className={styles.headline}>
      <span className={styles.line}>{lines[0]}</span>
      <span className={styles.line}>{lines[1]}</span>
    </h2>
  );
}

export default function TrailerPage() {
  const dday = daysToOpening();
  return (
    <>
      <div className={styles.page}>
        <div className={styles.progress} aria-hidden="true" />

        {/* 절 이동 - 평범한 앵커 링크. 현재 절 표시만 TrailerScroll이 붙인다. */}
        <nav className={styles.rail} aria-label="소개 절 이동">
          {NAV.map((n) => (
            <a key={n.id} href={`#${n.id}`} data-rail className={styles.railLink}>
              {n.label}
            </a>
          ))}
        </nav>

        <div className={styles.stage}>
          {/* 1. 첫 절 */}
          <section id="s1" data-scene className={`${styles.scene} ${styles.center} ${styles.opener}`}>
            <svg className={styles.court} viewBox="375 27 345 357" preserveAspectRatio="xMidYMid meet" aria-hidden="true" dangerouslySetInnerHTML={{ __html: COURT_SVG }} />
            <h1 className={styles.wordmark} aria-label="코트사이드">
              {["코", "트", "사", "이", "드"].map((c, i) => (
                <span key={i} data-char aria-hidden="true">
                  {c}
                </span>
              ))}
            </h1>
            <div className={styles.tag} data-rise>
              KBL PLAY-BY-PLAY ANALYTICS
            </div>
            <div className={styles.dday} data-rise>
              <span className={styles.ddayN}>{dday > 0 ? `D-${dday}` : "D-DAY"}</span>
              <span className={styles.ddayT}>2026.10.03 개막까지</span>
            </div>
            <div className={styles.cue} data-rise>
              SCROLL
            </div>
          </section>

          {/* 2~6. 절 하나가 그 페이지로 가는 입구다. */}
          {SCENES.map((sc, i) => (
            <Link
              key={sc.id}
              id={sc.id}
              href={sc.href}
              data-scene
              className={`${styles.scene} ${styles.split} ${i % 2 === 1 ? styles.flip : ""}`}
              aria-label={`${sc.brow} 열기`}
            >
              <div className={styles.wm} aria-hidden="true">
                {sc.wm}
              </div>
              <div className={styles.copy}>
                <div className={styles.brow} data-rise>
                  {sc.brow}
                </div>
                <Headline lines={sc.headline} />
                <p className={styles.lede} data-rise>
                  {sc.lede}
                </p>
                <div className={styles.stats} data-rise>
                  {sc.stats.map((s) => (
                    <StatBlock key={s.k} s={s} />
                  ))}
                </div>
                <div className={styles.basis} data-rise>
                  {sc.basis}
                </div>
                <div className={styles.cta} data-rise>
                  {sc.cta}
                </div>
              </div>
              <div className={styles.shot}>
                <div className={styles.chrome}>
                  <span className={styles.url}>{sc.shot.path}</span>
                  <span className={styles.cap}>1440×900</span>
                </div>
                <img className={styles.shotImg} src={sc.shot.src} alt={sc.shot.alt} width={1280} height={800} loading={i === 0 ? "eager" : "lazy"} decoding="async" />
              </div>
            </Link>
          ))}

          {/* 7. 모바일 - 특정 페이지가 아니라 "어디서나"라는 진술이라 링크를 걸지 않는다. */}
          <section id="s7" data-scene className={`${styles.scene} ${styles.center}`}>
            <div className={styles.brow} data-rise>
              모바일
            </div>
            <Headline lines={["중계를 보면서", "한 손으로 본다"]} />
            <div className={styles.phones}>
              <div className={styles.phone}>
                <img src="/trailer/m-home.jpg" alt="모바일 경기 목록" width={560} height={1212} loading="lazy" decoding="async" />
              </div>
              <div className={`${styles.phone} ${styles.phoneMid}`}>
                <img src="/trailer/m-player.jpg" alt="모바일 선수 프로필" width={560} height={1212} loading="lazy" decoding="async" />
              </div>
              <div className={styles.phone}>
                <img src="/trailer/m-game.jpg" alt="모바일 경기 상세" width={560} height={1212} loading="lazy" decoding="async" />
              </div>
            </div>
          </section>

          {/* 8. 마지막 */}
          <section id="s8" data-scene className={`${styles.scene} ${styles.center}`}>
            <div className={styles.wordmark} style={{ fontSize: "clamp(var(--fs-600), 4.2vw, var(--fs-800))" }} data-rise>
              코트사이드
            </div>
            <div className={styles.tag} data-rise>
              15 SEASONS · 3,993 GAMES · ONE TIMELINE
            </div>
            <div className={styles.endGrid} data-rise>
              <StatBlock s={{ v: "15", k: "시즌" }} />
              <StatBlock s={{ v: "3993", k: "경기" }} />
              <StatBlock s={{ v: "35", k: "감독" }} />
              <StatBlock s={{ v: "270", k: "26-27 일정", tone: "flame" }} />
            </div>
            <div className={styles.basis} data-rise>
              2011-12~2025-26 · 팀-경기 7,986 · 플레이 로그 약 240만 행
            </div>
            <Link href="/" className={styles.site} data-rise>
              경기 목록으로
            </Link>
          </section>
        </div>
      </div>

      <div className={styles.sheet}>
        <div className={styles.sheetEyebrow}>EVIDENCE · 15 SEASONS · 3,993 GAMES</div>
        <h2 className={styles.sheetTitle}>이 페이지의 숫자는 전부 실제 DB 값입니다</h2>
        <p className={styles.sheetLede}>화면은 코트사이드를 그대로 캡처한 것이고, 옆의 수치는 15시즌치 KBL 원자료에서 집계한 값입니다. 노이즈와 구분되지 않는 지표는 제품에서도, 이 페이지에서도 뺐습니다.</p>
        <div className={styles.cards}>
          <div className={styles.card}>
            <div className={styles.cardK}>데이터 범위</div>
            <div className={styles.cardV}>3,993</div>
            <div className={styles.cardN}>2011-12 - 2025-26 · 7,986 TEAM-GAMES</div>
            <p>정규시즌 3,993경기 · 팀-경기 7,986 · 플레이 로그 약 240만 행.</p>
          </div>
          <div className={styles.card}>
            <div className={styles.cardK}>26-27 준비</div>
            <div className={styles.cardV}>270</div>
            <div className={styles.cardN}>270 GAMES · 90 MATCHUPS · 198 ROSTER</div>
            <p>정규시즌 일정 전량과 로스터 198명이 들어와 있고, 90개 팀 조합 전부가 모델 값입니다.</p>
          </div>
          <div className={styles.card}>
            <div className={styles.cardK}>감독 지표</div>
            <div className={styles.cardV}>3 / 6</div>
            <div className={styles.cardN}>3 / 6 · 15 SEASONS</div>
            <p>커리어 기록 · 재임기 팀 스타일 · 챌린지 사용 성향만 채택. ATO 효율, 스태거링, 챌린지 성공률은 검정에서 탈락했습니다.</p>
          </div>
        </div>
        <dl className={styles.foot}>
          <dt>CAPTURE</dt>
          <dd>2026-09-08 · 데스크톱 1440×900, 모바일 390×844</dd>
          <dt>이동</dt>
          <dd>스크롤을 내리면 절이 차례로 드러납니다. 화면을 누르면 그 페이지로 갑니다.</dd>
        </dl>
      </div>

      <TrailerScroll />
    </>
  );
}
