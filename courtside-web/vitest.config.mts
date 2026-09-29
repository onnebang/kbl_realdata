import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// tsconfig.json의 paths("@/*" -> "./*")를 vitest에도 알려준다. components/ 아래 컴포넌트는
// 전부 `@/lib/...`로 임포트하므로(components/InsightCard.tsx 등), 이게 없으면 컴포넌트를
// 렌더하는 테스트가 모듈을 못 찾는다(Next 빌드는 tsconfig를 직접 읽어서 문제가 없음).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
