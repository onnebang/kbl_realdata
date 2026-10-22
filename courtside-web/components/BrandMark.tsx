type BrandMarkProps = {
  size?: number;
  className?: string;
  title?: string;
  courtColor?: string;
  monochrome?: boolean;
};

/**
 * 코트사이드 CI 심볼 — Signal Ball
 *
 * 농구공 안의 상승선은 경기 데이터의 흐름을, 오른쪽의 두 호는 실시간 중계 신호를 뜻한다.
 * 기본형은 코트 오렌지와 현재 글자색 두 가지만 사용하며 16px에서도 형태가 유지된다.
 */
export function BrandMark({
  size = 32,
  className,
  title,
  courtColor = "currentColor",
  monochrome = false,
}: BrandMarkProps) {
  const ballFill = monochrome ? "none" : "#F26522";
  const ballStroke = monochrome ? courtColor : "none";

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      <circle cx="23" cy="32" r="18.5" fill={ballFill} stroke={ballStroke} strokeWidth="4" />
      <path
        d="M18.5 14.2C24.4 20.4 28.5 27.5 29.2 34.5C29.8 40.8 27.8 46.1 24.5 50.3"
        stroke={courtColor}
        strokeWidth="2.7"
        strokeLinecap="round"
      />
      <path
        d="M9.5 39L18.2 30.8L25 35L37.2 21.5"
        stroke={courtColor}
        strokeWidth="4.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M43.5 23C50 27.5 50 36.5 43.5 41M48.5 16.5C61 24.5 61 39.5 48.5 47.5"
        stroke={courtColor}
        strokeWidth="4.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
