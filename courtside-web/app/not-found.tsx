import { ErrorScreen } from "@/components/ErrorScreen";

// notFound()가 불렸을 때와 없는 주소로 들어왔을 때. 서버 컴포넌트라 "use client"가 없다.
//
// 주의: 이 세그먼트에 loading.tsx를 만들면 안 된다. 스트리밍이 시작되면서 헤더가 먼저
// 나가버려 404가 200으로 바뀐다(실측 확인). 지금 이 프로젝트에는 loading.tsx가 없다.

export default function NotFound() {
  return (
    <ErrorScreen
      code="404"
      title="없는 페이지입니다"
      detail={"주소가 바뀌었거나, 아직 데이터가 들어오지 않은 경기·선수일 수 있습니다."}
    />
  );
}
