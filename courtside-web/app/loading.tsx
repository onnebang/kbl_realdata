// 페이지 이동 중 뼈대 화면(2026-09-15). 예전엔 loading.tsx가 하나도 없어서 링크를 누르면 서버 렌더가
// 끝날 때까지(1~2초) 화면이 그대로였다 - 눌렸는지조차 알 수 없었다. 루트에 하나만 두면 모든 라우트의
// 이동에 적용되고 내비게이션 바는 그대로 남는다.
// 움직임은 넣지 않는다 - 이 제품에서 움직이는 건 라이브 점 하나뿐이라는 디자인 계약(globals.css).
export default function Loading() {
  return (
    <div className="wrap route-loading" role="status" aria-live="polite">
      <span className="route-loading-label">불러오는 중</span>
      <div className="route-loading-hero" />
      <div className="route-loading-row">
        <div className="route-loading-card" />
        <div className="route-loading-card" />
        <div className="route-loading-card" />
      </div>
      <div className="route-loading-panel" />
    </div>
  );
}
