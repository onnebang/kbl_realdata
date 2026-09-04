"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

// 루트 레이아웃(app/layout.tsx)이나 NavBar가 죽었을 때만 뜬다 - app/error.tsx는 레이아웃
// 안쪽이라 이 경우를 못 받는다. 그래서 여기서는 <html>/<body>를 직접 그려야 한다.
//
// globals.css가 안 실려 있을 수 있어서 ErrorScreen이 자기 스타일을 인라인으로 들고 있다.

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="ko">
      <body style={{ margin: 0 }}>
        <ErrorScreen
          code={error.digest ? `오류 · ${error.digest.slice(0, 8)}` : "오류"}
          title="사이트를 불러오지 못했습니다"
          detail={"잠시 후 다시 시도해 주세요.\n계속 같은 화면이 나오면 위 오류 번호를 알려주시면 확인하겠습니다."}
          action={
            <button className="es-btn es-btn-primary" onClick={() => window.location.reload()}>
              새로고침
            </button>
          }
        />
      </body>
    </html>
  );
}
