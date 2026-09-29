import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// tsconfig.json의 paths("@/*" -> "./*")를 vitest에도 알려준다. components/ 아래 컴포넌트는
// 전부 `@/lib/...`로 임포트하므로(components/InsightCard.tsx 등), 이게 없으면 컴포넌트를
// 렌더하는 테스트가 모듈을 못 찾는다(Next 빌드는 tsconfig를 직접 읽어서 문제가 없음).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // lib/supabase.ts는 모듈 로드 시점에 createClient()를 부르고, url/key가 undefined면 거기서
  // 던진다. 그래서 순수 함수 하나만 꺼내 쓰려고 해도 그 모듈을 임포트하는 순간 테스트가 죽는다
  // (lib/playerGlance.test.ts). 절대 호출되지 않는 더미 값을 넣어 임포트만 통과시킨다 -
  // 단위 테스트는 쿼리를 날리지 않으므로 이 주소로 나가는 요청은 없다.
  test: {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://vitest.invalid",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "vitest-dummy-key",
    },
  },
});
