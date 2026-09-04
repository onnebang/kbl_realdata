"use client";

import { useEffect } from "react";
import { ErrorScreen } from "@/components/ErrorScreen";

// 서버 렌더 중 예외가 나면 뜨는 화면. 이게 없으면 Next 기본 화면(영어, 흰 배경)이 뜬다.
//
// 이 파일이 실제로 하는 일은 lib/supabaseServer.ts와 한 쌍이다. 예전에는 DB가 죽어도
// 쿼리가 `{data: null}`을 돌려주고 페이지가 HTTP 200에 "데이터가 아직 없습니다"를 그렸다 -
// 사용자는 장애가 아니라 "원래 빈 사이트"로 읽는다. 이제 쿼리 실패는 예외가 되고,
// 그 예외를 여기서 받아서 **다시 시도할 수 있는 화면**으로 바꾼다.
//
// digest는 Next가 서버 스택을 지우고 남기는 해시다. 사용자에게 보여줘도 안전하고
// (내부 경로·SQL이 안 들어간다) 서버 로그와 대조할 수 있는 유일한 끈이라 화면에 남긴다.

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 서버 콘솔에는 이미 전체 스택이 찍혀 있다. 여기서는 브라우저 쪽 재현을 위해 한 줄만.
    console.error("[courtside] 렌더 실패", error.digest ?? "", error.message);
  }, [error]);

  return (
    <ErrorScreen
      code={error.digest ? `오류 · ${error.digest.slice(0, 8)}` : "오류"}
      title="지금은 이 화면을 불러오지 못했습니다"
      detail={
        "데이터를 가져오는 중에 문제가 생겼습니다.\n" +
        "기록이 없는 게 아니라 잠시 연결이 끊긴 것이라, 대개 다시 시도하면 바로 열립니다."
      }
      action={
        <button className="es-btn es-btn-primary" onClick={() => reset()}>
          다시 시도
        </button>
      }
    />
  );
}
