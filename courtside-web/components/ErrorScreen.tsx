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

const ES_CSS = `
.es-wrap { min-height: 60vh; display: flex; align-items: center; justify-content: center;
  padding: 48px 20px; background: #f4f5f8; color: #14161c;
  font-family: system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; }
.es-card { max-width: 460px; width: 100%; background: #fff; border: 1px solid rgba(20,22,28,.12);
  border-radius: 14px; padding: 28px 26px; }
.es-code { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: #9297a8; margin-bottom: 10px; }
/* 한글은 어절 단위로 끊어야 읽힌다 - keep-all이 없으면 "안 된 것이라," 같은 데서 잘린다. */
.es-title { font-size: 20px; font-weight: 700; margin: 0 0 10px; line-height: 1.35;
  word-break: keep-all; text-wrap: balance; }
.es-detail { font-size: 13.5px; line-height: 1.7; color: #5b5f6e; margin: 0 0 20px;
  white-space: pre-line; word-break: keep-all; }
.es-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.es-btn { display: inline-block; font-size: 13px; font-weight: 600; padding: 9px 16px;
  border-radius: 9px; border: 1px solid transparent; cursor: pointer; text-decoration: none;
  font-family: inherit; }
.es-btn-primary { background: #d9640a; color: #fff; }
.es-btn-ghost { background: transparent; color: #5b5f6e; border-color: rgba(20,22,28,.16); }
.es-btn:hover { filter: brightness(1.06); }
@media (prefers-color-scheme: dark) {
  .es-wrap { background: #0f1115; color: #f2f3f7; }
  .es-card { background: #1a1d24; border-color: rgba(242,243,247,.12); }
  .es-code { color: #6a6f7f; }
  .es-detail { color: #9297a8; }
  .es-btn-primary { background: #ff8a3d; color: #14161c; }
  .es-btn-ghost { color: #9297a8; border-color: rgba(242,243,247,.16); }
}
`;
