// 오류·404 화면의 공통 껍데기. error.tsx / global-error.tsx / not-found.tsx 셋이 같은
// 모양을 써야 사용자가 "사이트가 깨졌다"가 아니라 "이 화면만 지금 안 된다"로 읽는다.
//
// 스타일을 인라인으로 둔 이유: global-error.tsx는 루트 레이아웃이 죽었을 때 뜨는 화면이라
// globals.css가 아예 안 실려 있을 수 있다. 그 경우에도 읽히게 하려면 클래스에 기댈 수 없다.
// 색은 라이트 기준 값을 직접 쓰고, prefers-color-scheme은 아래 <style>에서만 덮는다.

export function ErrorScreen({
  code,
  title,
  detail,
  action,
}: {
  /** 화면 왼쪽 위에 크게 뜨는 짧은 코드. 사용자가 문의할 때 이 말만 전하면 되게. */
  code: string;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="es-wrap">
      <style>{ES_CSS}</style>
      <div className="es-card">
        <div className="es-code">{code}</div>
        <h1 className="es-title">{title}</h1>
        <p className="es-detail">{detail}</p>
        <div className="es-actions">
          {action}
          <a className="es-btn es-btn-ghost" href="/">
            경기 목록으로
          </a>
        </div>
      </div>
    </div>
  );
}

// 값은 globals.css의 토큰과 같은 값을 손으로 옮겨 적은 것이다(위 주석대로 여기서는 var()를 못 쓴다).
// 토큰을 고치면 여기도 같이 고쳐야 한다 - 짝: --bg / --surface / --ink / --ink-soft / --ink-faint / --r-card.
const ES_CSS = `
.es-wrap { min-height: 60vh; display: flex; align-items: center; justify-content: center;
  padding: 48px 20px; background: #f4f5f8; color: #14161c;
  font-family: "Pretendard", system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; }
.es-card { max-width: 460px; width: 100%; background: #fff; border: 1px solid rgba(20,22,28,.14);
  border-radius: 14px; padding: 28px 26px; }
/* 예전엔 11px 대문자 + 자간 .08em + #9297a8(흰 배경 2.91:1, 이 카드 배경에서 2.67:1)이었다.
   문의할 때 이 코드를 그대로 불러야 하는 사람이 정작 못 읽는 크기·대비였다. */
.es-code { font-size: 12.5px; font-weight: 700; letter-spacing: .02em;
  color: #676c7b; margin-bottom: 10px; }
/* 한글은 어절 단위로 끊어야 읽힌다 - keep-all이 없으면 "안 된 것이라," 같은 데서 잘린다. */
.es-title { font-size: 20px; font-weight: 700; margin: 0 0 10px; line-height: 1.35;
  word-break: keep-all; text-wrap: balance; }
.es-detail { font-size: 15px; line-height: 1.65; color: #4a4f5c; margin: 0 0 20px;
  max-width: 62ch; white-space: pre-line; word-break: keep-all; }
.es-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.es-btn { display: inline-block; font-size: 13px; font-weight: 600; padding: 9px 16px;
  border-radius: 8px; border: 1px solid transparent; cursor: pointer; text-decoration: none;
  font-family: inherit; }
.es-btn-primary { background: #d9640a; color: #fff; }
.es-btn-ghost { background: transparent; color: #4a4f5c; border-color: rgba(20,22,28,.16); }
.es-btn:hover { filter: brightness(1.06); }
@media (prefers-color-scheme: dark) {
  .es-wrap { background: #0f1115; color: #f2f3f7; }
  .es-card { background: #1a1d24; border-color: rgba(242,243,247,.14); }
  .es-code { color: #8d93a3; }
  .es-detail { color: #a8aebe; }
  .es-btn-primary { background: #ff8a3d; color: #14161c; }
  .es-btn-ghost { color: #a8aebe; border-color: rgba(242,243,247,.16); }
}
`;
