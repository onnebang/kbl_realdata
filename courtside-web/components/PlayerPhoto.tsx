import Image from "next/image";

// 선수 사진 한 곳 - 원본을 그대로 걸지 않고 next/image로 줄여서 내려보낸다.
//
// 왜: KBL 공식 사진은 470x609 PNG(평균 402KB)인데 화면에는 34~44px로 그린다. /players 한 장이
// 사진 31개만 걸어도 11.9MB였고(실측 2026-09-05), 로스터 213명이 다 채워지면 85MB가 된다.
// 34 CSS px x 2dpr = 68px면 필요한 픽셀의 1/61이다.
//
// 왜 컴포넌트로 묶었나: 같은 <img>가 5곳에 흩어져 있었다(/players, /lineups, /teams/[tcode],
// GameReplay, SynergyCombos). 한 곳에서만 크기 규칙을 정해야 다음에 또 원본을 그대로 거는
// 코드가 생기지 않는다.
//
// unoptimized 탈출구를 두지 않는다 - 두면 반드시 쓰인다.
//
// 팀 로고(TeamBadge)는 일부러 그대로 뒀다. 11개 전수 실측 결과 10개가 SVG(합계 284KB)이고
// 전부 `Cache-Control: public, max-age=31536000, immutable`로 내려온다 - next/image는 SVG를
// 래스터화하지 않으므로 통과시켜도 얻는 게 없고, 캐시는 이미 최적이다.

export function PlayerPhoto({
  src,
  alt = "",
  size,
  className,
}: {
  src: string;
  alt?: string;
  /** CSS 픽셀 기준 한 변. next/image가 여기에 맞춰 원본을 줄인다(2dpr까지 자동). */
  size: number;
  className?: string;
}) {
  // next/image가 과거 400/404 에러 상태를 길게 캐시하고 있을 수 있으므로
  // 쿼리스트링을 달아 새 URL로 강제 우회한다 (2026-09-25 캐시 버스트).
  const bustedSrc = src.includes("?") ? `${src}&v=2` : `${src}?v=2`;

  return (
    <Image
      src={bustedSrc}
      alt={alt}
      width={size}
      height={size}
      className={className}
      loading="lazy"
      // 원본이 4:3에 가까운 세로 사진이라 정사각형 자리에 넣으면 찌그러진다. 기존 CSS가
      // object-fit: cover로 잡고 있으므로 여기서도 같은 규칙을 명시한다.
      style={{ objectFit: "cover" }}
    />
  );
}
