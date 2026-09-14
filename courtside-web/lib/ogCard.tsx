import { ImageResponse } from "next/og";

// 공유 카드(카톡·인스타·디스코드 링크 미리보기) 1200x630 - 2026-09-14.
// 예전엔 모든 페이지가 제목 "코트사이드" 하나에 og 태그가 없어서, 선수·경기 링크를 보내도 이름도
// 점수도 안 보였다. 경기·선수·팀·감독 opengraph-image.tsx가 전부 이 렌더러 하나를 쓴다.
//
// 톤은 사이트의 딥다크 히어로(중계 자막): 다크 바탕, 팀 색은 글자가 아니라 막대(accentFor = 다크
// 바탕에서 어두운 팀 색이 사라지지 않게 올린 값), 점수 숫자는 Big Shoulders, 한글은 Pretendard.
// Satori는 woff2를 못 읽어서 사이트 CSS와 같은 jsdelivr 패키지의 woff를 서버가 받아 쓴다.

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

const INK = "#f2f3f7";
const INK_SOFT = "#a8aebe";
const GOLD = "#ffd166";
const BG = "#0f1115";

const PRETENDARD = "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/packages/pretendard/dist/web/static/woff";

type Font = { name: string; data: ArrayBuffer; weight: 600 | 800; style: "normal" };
let fonts: Promise<Font[]> | null = null;

async function bytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`폰트 ${res.status}: ${url}`);
  return res.arrayBuffer();
}

/** Big Shoulders는 숫자만 필요해서 Google Fonts의 text= 부분집합(수 KB, TTF)을 받는다. */
async function bigShoulders(): Promise<ArrayBuffer> {
  const css = await (await fetch("https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800&text=0123456789%25-:")).text();
  const url = css.match(/src: url\((.+?)\) format/)?.[1];
  if (!url) throw new Error("Big Shoulders 부분집합 URL을 못 찾음");
  return bytes(url);
}

function loadFonts(): Promise<Font[]> {
  fonts ??= Promise.all([
    bytes(`${PRETENDARD}/Pretendard-ExtraBold.woff`),
    bytes(`${PRETENDARD}/Pretendard-SemiBold.woff`),
    bigShoulders(),
  ]).then(([xb, sb, bs]): Font[] => [
    { name: "Pretendard", data: xb, weight: 800, style: "normal" },
    { name: "Pretendard", data: sb, weight: 600, style: "normal" },
    { name: "Big Shoulders", data: bs, weight: 800, style: "normal" },
  ]);
  // 한 번 실패한 약속을 인스턴스 수명 내내 들고 있지 않는다 - 다음 요청이 다시 받는다.
  fonts.catch(() => (fonts = null));
  return fonts;
}

export type OgTeam = { name: string; accent: string };

export type OgCardProps = {
  /** 맨 위 한 줄 - 무슨 페이지인지(날짜·상태 / "선수 프로필"). */
  kicker: string;
  title?: string;
  sub?: string;
  /** 왼쪽 세로 막대 색(팀). 없으면 골드. */
  accent?: string;
  matchup?: { away: OgTeam; home: OgTeam; awayScore: number | null; homeScore: number | null; note?: string };
};

/** 긴 이름(외국인 선수 한글 표기 등)이 한 줄을 넘지 않게 글자 수로 크기를 줄인다. */
function titleSize(text: string): number {
  return text.length <= 6 ? 120 : text.length <= 10 ? 96 : text.length <= 16 ? 72 : 56;
}

function TeamSide({ team, score, align }: { team: OgTeam; score: number | null; align: "left" | "right" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align === "left" ? "flex-start" : "flex-end", width: 460 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexDirection: align === "left" ? "row" : "row-reverse" }}>
        <div style={{ width: 14, height: 48, background: team.accent }} />
        <div style={{ fontSize: team.name.length > 7 ? 44 : 52, fontWeight: 800, color: INK, letterSpacing: "-0.02em" }}>{team.name}</div>
      </div>
      <div style={{ fontFamily: "Big Shoulders", fontSize: 200, fontWeight: 800, color: INK, lineHeight: 1, marginTop: 12 }}>
        {score == null ? "-" : String(score)}
      </div>
    </div>
  );
}

export async function ogCard({ kicker, title, sub, accent = GOLD, matchup }: OgCardProps): Promise<ImageResponse> {
  const body = matchup ? (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <TeamSide team={matchup.away} score={matchup.awayScore} align="left" />
        <div style={{ fontSize: 40, fontWeight: 600, color: INK_SOFT, paddingBottom: 90 }}>@</div>
        <TeamSide team={matchup.home} score={matchup.homeScore} align="right" />
      </div>
      {matchup.note && <div style={{ fontSize: 34, fontWeight: 600, color: INK_SOFT, marginTop: 24 }}>{matchup.note}</div>}
    </div>
  ) : (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
      {title && (
        <div style={{ fontSize: titleSize(title), fontWeight: 800, color: INK, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{title}</div>
      )}
      {sub && <div style={{ fontSize: 40, fontWeight: 600, color: INK_SOFT, marginTop: 24 }}>{sub}</div>}
    </div>
  );

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: BG, fontFamily: "Pretendard" }}>
        <div style={{ width: 20, height: "100%", background: accent }} />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "64px 72px 56px 64px" }}>
          <div style={{ fontSize: 34, fontWeight: 600, color: INK_SOFT }}>{kicker}</div>
          {body}
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ display: "flex", background: GOLD, color: BG, fontSize: 30, fontWeight: 800, padding: "6px 22px" }}>코트사이드</div>
            <div style={{ fontSize: 28, fontWeight: 600, color: INK_SOFT }}>KBL 실시간 승률·데이터 분석</div>
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts: await loadFonts() }
  );
}
