# 코트사이드 웹 Vercel 배포 가이드

Next.js 16 앱이라 **Node 20 이상**이 필요합니다(`package.json`의 `engines.node >= 20`,
로컬 개발은 nvm의 Node 22 사용 중). Vercel 기본 빌드 환경은 Node 20+라 별도 설정 없이 동작합니다.

> **중요 - 이 저장소는 모노레포 구조입니다.** git 루트는 `kbl_realdata`이고 Next 앱은 그 안의
> `courtside-web/`에 있습니다. 아래 3번(GitHub 연동)으로 배포하면 Vercel이 루트에서 Next 앱을
> 못 찾으니 **Root Directory를 반드시 `courtside-web`으로 지정**해야 합니다.
> CLI로 `cd courtside-web && vercel link` 하는 경우엔 자동으로 잡힙니다.

## 1. Vercel CLI 설치 및 로그인

```bash
npm i -g vercel
vercel login    # 브라우저에서 본인 계정으로 로그인
```

## 2. 프로젝트 연결 (courtside-web 폴더에서)

```bash
cd courtside-web
vercel link     # 새 프로젝트 생성 또는 기존 프로젝트 선택
```

## 3. 환경변수 등록 (딱 2개)

`.env.local`에 있는 값 그대로:

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL      # https://igbdbjhdpameorcgaame.supabase.co
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY # .env.local의 anon key
```

Production/Preview/Development 모두 체크해서 등록하면 됩니다.

> **주의(중요)**: `tools/.env.supabase`의 `DATABASE_URL`은 **절대 Vercel에 넣지 마세요.**
> 이건 RLS를 우회하는 서버 쓰기용 Postgres 직결 크리덴셜(파이썬 파이프라인 전용)이고,
> 웹사이트는 anon key(읽기 전용 RLS)만으로 동작합니다. 유출되면 DB 전체 쓰기가 뚫립니다.

## 4. 배포

```bash
vercel          # 프리뷰 배포(확인용 URL 발급)
vercel --prod   # 실서비스 배포
```

빌드 명령은 기본값(`next build`) 그대로 두면 됩니다. 배포 후 프리뷰 URL에서
홈 목록(예정/종료 카드)과 경기 페이지 3막이 로컬과 동일하게 나오는지 확인하세요.

## 5. (선택) GitHub 자동 배포

Vercel 대시보드에서 이 저장소(`onnebang/kbl_realdata`)를 Import하면 `main`에 푸쉬할 때마다
자동 배포됩니다. 이때 **Root Directory = `courtside-web`** 설정이 필수입니다(위 경고 참고).
시즌 중엔 매일 배치가 DB만 갱신하고 사이트 코드는 그대로라, 자동 배포는 코드 변경 시에만
동작하면 충분합니다.

## 6. (선택) 토큰 방식 - 자동화/에이전트가 대신 배포할 때

브라우저 로그인 대신 토큰으로도 됩니다. Vercel 대시보드 → Settings → Tokens에서 토큰을 만든 뒤:

```bash
export VERCEL_TOKEN=발급받은_토큰      # 셸에 직접 입력(파일로 저장하지 말 것)
cd courtside-web
npx vercel link --yes --token "$VERCEL_TOKEN"
npx vercel --prod --token "$VERCEL_TOKEN"
```

이 방식이면 로그인 단계 없이 배포가 끝나므로, 환경변수만 셸에 설정해두면 자동화 도구가
이어서 배포를 진행할 수 있습니다. 토큰은 계정 전체 권한이라 저장소에 커밋하지 마세요.
