import type { ReportSectionData } from "@/lib/report/renderKit";
import { AceDuelSection } from "./AceDuelSection";
import { UnsungHeroSection } from "./UnsungHeroSection";
import { StockWatchSection } from "./StockWatchSection";

// 문자열 HTML에서 컴포넌트로 옮긴 리포트 섹션들의 분기 한 곳(renderKit.ts의 ReportSectionData
// 주석에서 예고한 dispatcher - 옮긴 섹션이 둘이 되면서 필요해졌다).
//
// switch가 exhaustive하다: 새 `kind`를 유니온에 추가하면 아래에서 반환 타입이 맞지 않아
// 타입 에러가 난다(섹션을 옮기다 렌더 자리 연결을 잊는 걸 컴파일러가 잡아준다).
export function DataSectionBody({ data }: { data: ReportSectionData }) {
  switch (data.kind) {
    case "ace_duel":
      return <AceDuelSection duel={data} />;
    case "unsung_heroes":
      return <UnsungHeroSection heroes={data} />;
    case "stock_watch":
      return <StockWatchSection stock={data} />;
  }
}
