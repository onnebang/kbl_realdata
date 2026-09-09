import type { Metadata } from "next";
import Link from "next/link";
import { TrailerStage } from "@/components/TrailerStage";
import { COURT_X, HOOP_RIGHT, drawCourtMarkings } from "@/lib/zoneCompare";
import styles from "./trailer.module.css";

// 소개 영상(/trailer). 요청: "트레일러를 우리 사이트에 같이 붙여줘".
//
// 아티팩트로 먼저 만든 것(8장면·약 40초)을 그대로 옮겼다. 사이트 판이 다른 점:
//   - 그림은 data: URI가 아니라 public/trailer/*.jpg(CDN 캐시, 8장 564KB). 크기는 표시 폭에서
//     역산(무대 최대 1180px, 화면 칸 ~660px → 2x 1280; 모바일 3장은 ~210px → 560).
//   - 장면의 화면 프레임이 그 실제 페이지로 가는 링크다. 영상이 곧 안내다.
//   - 글꼴은 사이트 것 그대로(Pretendard 한글 표제·라벨, Big Shoulders 숫자, IBM Plex Mono ASCII 라벨).
//     아티팩트의 Gothic A1은 쓰지 않는다 - 사이트가 안 싣는 얼굴을 한 페이지에서만 부르지 않는다.
//
// 숫자는 전부 이 저장소가 DB로 확인한 값이다(2026-09-08 기준). 바뀌면 여기와 아래 sheet를 같이
// 고쳐야 한다 - 정직성 원칙상 "대략 이 정도"는 쓰지 않는다:
//   정규시즌 15시즌·3,993경기(2011-12~2025-26) / 팀-경기 7,986 / game_events 약 240만 행 /
//   26-27 일정 270경기 / 팀 조합 90 / 사전 승률 모델 피처 29 / 김선형 커리어 685경기·슛 7,300·
//   WPA 25-26 +8.3 / 감독 35명·감독-시즌 150·채택 지표 3/6 / 26-27 명단 198·로스터 변동 261·
//   확정 결장 13 / 시즌 시뮬 10만.
// D-day만 페이지가 스스로 센다(서버 렌더라 요청 시각 기준, 캐시 없음).
//
// 가시성 규칙: 이 파일이 낸 HTML이 곧 완성된 문서다. 헤드라인·리드·숫자·화면은 JS 없이도 전부
// 보이고, 진입 모션은 trailer.module.css의 .isActive 키프레임이 맡는다(TrailerStage 참조).

export const metadata: Metadata = {
  title: "코트사이드 소개 영상",
  description: "KBL 15시즌 플레이 로그로 만든 코트사이드를 8장면 40초로 봅니다. 경기 목록·리플레이·선수·감독·개막 리포트.",
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

// 무대 바닥의 코트 - 제품 슛맵이 쓰는 그 좌표계(lib/zoneCompare.ts) 그대로. 손으로 다시 그리지
// 않는다. <path>에만 pathLength="1"을 주입해 CSS가 dashoffset 1→0으로 한 번 그려 낸다(rect·circle은
// 페이드). viewBox는 오른쪽 반코트(x 375~720, y 27~384).
const COURT_SVG = drawCourtMarkings(HOOP_RIGHT[0], COURT_X[1], -1, "currentColor", 0.7).replaceAll("<path ", '<path pathLength="1" ');

type Scene = {
  dur: number;
  brow: string;
  headline: [string, string];
  lede: React.ReactNode;
  stats: { v: string; k: string; tone?: "flame" | "gold"; dec?: number; prefix?: string; unit?: string }[];
  /* 우상단 워터마크 - 이 장면의 표본 크기 하나(숫자만, Big Shoulders). */
  wm: string;
  /* 표본 한 줄 - 숫자의 기준을 적는다(선수 히어로 .heroBasis 어법). */
  basis: string;
  shot: { src: string; href: string; path: string; alt: string; w: number; h: number };
};

// 장면 2~6. 1(타이틀)·7(모바일)·8(엔딩)은 모양이 달라 아래에서 직접 그린다.
const SCENES: Scene[] = [
  {
    dur: 5200,
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
    shot: { src: "/trailer/home-dark.jpg", href: "/", path: "courtside-web-ten.vercel.app", alt: "경기 목록 화면 - 26-27 시즌 예정 경기와 예상 승률", w: 1280, h: 800 },
  },
  {
    dur: 5200,
    brow: "경기 리플레이",
    headline: ["플레이 하나가", "승률을 얼마나 밀었나"],
    lede: <>15시즌치 플레이 로그를 그대로 되감는다. 스크러버를 끌면 그 시점의 박스스코어·코트 위 5인·승률이 같이 움직인다.</>,
    stats: [
      { v: "15", k: "시즌" },
      { v: "3993", k: "정규시즌 경기" },
      { v: "240", k: "플레이 로그", tone: "flame", unit: "만" },
    ],
    wm: "3,993",
    basis: "2011-12–2025-26 · 팀-경기 7,986 · 플레이 로그 약 240만 행",
    shot: { src: "/trailer/game.jpg", href: "/games/S47G01N262", path: "/games/S47G01N262", alt: "경기 상세 화면 - 승률 흐름과 플레이바이플레이 리플레이", w: 1280, h: 800 },
  },
  {
    dur: 5400,
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
    shot: { src: "/trailer/player.jpg", href: "/players/290407", path: "/players/290407", alt: "선수 프로필 화면 - 커리어 결 띠와 리그 퍼센타일", w: 1280, h: 800 },
  },
  {
    dur: 5400,
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
    shot: { src: "/trailer/coach.jpg", href: "/coaches/28", path: "/coaches/28", alt: "감독 프로필 화면 - 통산 기록과 재임기 팀 스타일", w: 1280, h: 800 },
  },
  {
    dur: 5200,
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
    shot: { src: "/trailer/preseason.jpg", href: "/preseason", path: "/preseason", alt: "개막 리포트 화면 - 팀별 전력 조정과 예상 순위", w: 1280, h: 800 },
  },
];

// 숫자는 서버가 완성값으로 낸다. 플레이어의 카운트업은 이 위를 덮어썼다가 같은 값으로 끝난다.
function Stat({ s }: { s: Scene["stats"][number] }) {
  return (
    <div className={styles.stat}>
      <div className={`${styles.v} ${s.tone === "flame" ? styles.flame : s.tone === "gold" ? styles.gold : ""}`}>
        <span data-count={s.v} data-dec={s.dec ?? 0} data-prefix={s.prefix ?? ""}>
          {(s.prefix ?? "") + Number(s.v).toLocaleString("ko-KR", { minimumFractionDigits: s.dec ?? 0, maximumFractionDigits: s.dec ?? 0 })}
        </span>
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
        <TrailerStage>
          {/* 무대 바닥의 코트(플레이어 모드에서만 보인다 - CSS .court) */}
          <svg className={styles.court} viewBox="375 27 345 357" preserveAspectRatio="xMidYMid meet" aria-hidden="true" dangerouslySetInnerHTML={{ __html: COURT_SVG }} />

          {/* 1. 타이틀 */}
          <section className={`${styles.scene} ${styles.center}`} data-scene data-dur="4200">
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
          </section>

          {/* 2~6. 화면 + 자막 */}
          {SCENES.map((sc) => (
            <section key={sc.brow} className={`${styles.scene} ${styles.split}`} data-scene data-dur={sc.dur}>
              <div className={styles.wm} aria-hidden="true">
                {sc.wm}
              </div>
              <div className={styles.copy} data-copy>
                <div className={styles.brow} data-rise>
                  {sc.brow}
                </div>
                <Headline lines={sc.headline} />
                <p className={styles.lede} data-rise>
                  {sc.lede}
                </p>
                <div className={styles.stats}>
                  {sc.stats.map((s) => (
                    <Stat key={s.k} s={s} />
                  ))}
                </div>
                <div className={styles.basis} data-rise>
                  {sc.basis}
                </div>
              </div>
              {/* 프레임이 곧 그 페이지로 가는 링크 - 영상이 안내 역할까지 한다. */}
              <Link href={sc.shot.href} className={styles.shot} data-shot aria-label={`${sc.brow} 페이지로 이동`}>
                <div className={styles.chrome}>
                  <span className={styles.url}>{sc.shot.path}</span>
                  <span className={styles.cap}>1440×900</span>
                </div>
                <img src={sc.shot.src} alt={sc.shot.alt} width={sc.shot.w} height={sc.shot.h} loading={sc.brow === "경기 목록" ? "eager" : "lazy"} decoding="async" />
              </Link>
            </section>
          ))}

          {/* 7. 모바일 */}
          <section className={`${styles.scene} ${styles.center}`} data-scene data-dur="4800">
            <div data-copy>
              <div className={styles.brow} data-rise>
                모바일
              </div>
              <Headline lines={["중계를 보면서", "한 손으로 본다"]} />
            </div>
            <div className={styles.phones}>
              <div className={styles.phone} data-phone>
                <img src="/trailer/m-home.jpg" alt="모바일 경기 목록" width={560} height={1212} loading="lazy" decoding="async" />
              </div>
              <div className={`${styles.phone} ${styles.phoneMid}`} data-phone="mid">
                <img src="/trailer/m-player.jpg" alt="모바일 선수 프로필" width={560} height={1212} loading="lazy" decoding="async" />
              </div>
              <div className={styles.phone} data-phone>
                <img src="/trailer/m-game.jpg" alt="모바일 경기 상세" width={560} height={1212} loading="lazy" decoding="async" />
              </div>
            </div>
          </section>

          {/* 8. 엔딩 */}
          <section className={`${styles.scene} ${styles.center}`} data-scene data-dur="5200">
            <div className={styles.wordmark} style={{ fontSize: "clamp(var(--fs-600), 4.2vw, var(--fs-800))" }} data-rise>
              코트사이드
            </div>
            <div className={styles.tag} data-rise>
              15 SEASONS · 3,993 GAMES · ONE TIMELINE
            </div>
            <div className={styles.endGrid} data-rise>
              <Stat s={{ v: "15", k: "시즌" }} />
              <Stat s={{ v: "3993", k: "경기" }} />
              <Stat s={{ v: "35", k: "감독" }} />
              <Stat s={{ v: "270", k: "26-27 일정", tone: "flame" }} />
            </div>
            <div className={styles.basis} data-rise>
              2011-12–2025-26 · 팀-경기 7,986 · 플레이 로그 약 240만 행
            </div>
            <Link href="/" className={styles.site} data-rise>
              경기 목록으로 →
            </Link>
          </section>
        </TrailerStage>
      </div>

      <div className={styles.sheet}>
        <div className={styles.sheetEyebrow}>EVIDENCE · 15 SEASONS · 3,993 GAMES</div>
        <h2 className={styles.sheetTitle}>이 영상의 숫자는 전부 실제 DB 값입니다</h2>
        <p className={styles.sheetLede}>화면은 코트사이드를 그대로 캡처한 것이고, 옆의 수치는 15시즌치 KBL 원자료에서 집계한 값입니다. 노이즈와 구분되지 않는 지표는 제품에서도, 이 영상에서도 뺐습니다.</p>
        <div className={styles.sheetRule} aria-hidden="true" />
        <div className={styles.cards}>
          <div className={styles.card}>
            <div className={styles.cardK}>데이터 범위</div>
            <div className={styles.cardV}>3,993</div>
            <div className={styles.cardN}>2011-12 – 2025-26 · 7,986 TEAM-GAMES</div>
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
          <dt>KEYS</dt>
          <dd>
            <kbd>Space</kbd> 재생/정지 · <kbd>←</kbd> <kbd>→</kbd> 장면 이동 · 진행바 칸을 누르면 그 장면으로 · 화면을 누르면 그 페이지로
          </dd>
        </dl>
      </div>
    </>
  );
}
