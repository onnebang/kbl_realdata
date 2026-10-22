type BrandMarkProps = {
  size?: number;
  className?: string;
  title?: string;
  courtColor?: string;
  monochrome?: boolean;
};

/**
 * 코트사이드 (Courtside) CI 심볼 — Apex Analytics C
 *
 * 기하학적 'C' 모노그램(화이트/다크), 우측 코트 액센트 바(코트 오렌지 #FF5500),
 * 그리고 실시간 승률 변화 및 클러치 모멘텀을 상징하는 우상향 데이터 화살표(일렉트릭 사이언 #00E5FF)로 구성됩니다.
 */
export function BrandMark({
  size = 32,
  className,
  title,
  courtColor = "currentColor",
  monochrome = false,
}: BrandMarkProps) {
  const isLight = courtColor === "#0f1115" || courtColor === "#000000";
  const frameColor = monochrome ? courtColor : isLight ? "#0f1115" : "#FFFFFF";
  const accentColor = monochrome ? courtColor : "#FF5500";
  const pulseColor = monochrome ? courtColor : isLight ? "#0284C7" : "#00E5FF";

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
      {/* C Outer Frame */}
      <path
        d="M38 13H19C13.48 13 9 17.48 9 23V41C9 46.52 13.48 51 19 51H38"
        stroke={frameColor}
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Right Court Accent Bar */}
      <path
        d="M47 23V41"
        stroke={accentColor}
        strokeWidth="6.5"
        strokeLinecap="round"
      />
      {/* Real-time Win Probability Vector & Arrow */}
      <path
        d="M12 43L23 30L31 36L48 16"
        stroke={pulseColor}
        strokeWidth="4.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M37 16H48V27"
        stroke={pulseColor}
        strokeWidth="4.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
