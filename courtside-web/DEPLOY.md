# 코트사이드 웹 Vercel 배포 가이드

Next.js 16 앱이라 **Node 20 이상**이 필요합니다(`package.json`의 `engines.node >= 20`,
로컬 개발은 nvm의 Node 22 사용 중). Vercel 기본 빌드 환경은 Node 20+라 별도 설정 없이 동작합니다.

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
