# 코트사이드 CI 가이드라인

정식 명칭은 **코트사이드**, 공식 주소는 **courtside.ai.kr**이다. 영문 `COURTSIDE`는
보조 표기와 글로벌 락업, 도메인에 적용하며, 서비스 전반에서 기본 브랜드명은 한글로 둔다.

## 심볼 의미 — Apex Analytics C

- **C 아우터 프레임 (`#FFFFFF` / `#0F1115`)**: 코트사이드의 첫 글자 'C'이자 농구 코트의 사이드라인·베이스라인의 기하학적 형태.
- **우측 코트 액센트 바 (`#FF5500`)**: 코트의 에너지와 농구공/림의 속도감, 클러치 모멘텀을 상징하는 단일 시그니처 오렌지.
- **실시간 승률 상승 화살표 (`#00E5FF` / `#0284C7`)**: 감정을 걷어낸 냉철한 데이터 분석, 실시간 승률 변화 및 반등(Surge)을 상징하는 일렉트릭 사이언 벡터.
- **과거 태극기 연상 디자인 탈피**: 상하 1:1 대칭 폴리곤 및 빨강/파랑 분할을 완전히 폐기하고, 스포츠 테크와 데이터 분석의 전문성이 한눈에 느껴지는 모던 볼드 기하학으로 재설계.

## 기본 조합

| 용도 | 파일 |
| --- | --- |
| 밝은 배경 기본 로고 | `/brand/courtside-lockup-dark.svg` |
| 어두운 배경 반전 로고 | `/brand/courtside-lockup-light.svg` |
| 공식 주소 포함 조합 | `/brand/courtside-lockup-domain.svg` |
| 컬러 심볼 | `/brand/courtside-mark.svg` |
| 어두운 배경 심볼 | `/brand/courtside-mark-on-dark.svg` |
| 단색 심볼 | `/brand/courtside-mark-mono.svg` |
| 앱 아이콘 원본 | `/brand/courtside-app-icon.svg` |
| 소셜 카드 (OG Image) | `/brand/courtside-social-card.svg` |
| 전체 CI 규정 보드 | `/brand/courtside-ci-board.svg` |

## 컬러 팔레트

| 이름 | 값 | 역할 |
| --- | --- | --- |
| Courtside Graphite | `#0F1115` | 기본 어두운 배경과 잉크 |
| Court Flame | `#FF5500` | 프라이머리 액센트, 코트 에너지, 우측 버티컬 바 |
| Analytics Cyan | `#00E5FF` / `#0284C7` | 승률 궤적, 실시간 모멘텀 화살표, 데이터 메트릭 |
| Data Gold | `#FFD166` | 제품 UI 보조 강조색 |
| Court Chalk | `#F4F5F8` | 텍스트, 밝은 대비선 |

## 타이포그래피

- 한글 이름과 본문: `Pretendard` (워드마크는 800 ExtraBold 기준)
- 영문 브랜드/워드마크: `Pretendard` / `Inter` Bold
- 숫자·점수: `Big Shoulders Display`
- 시간·도메인·데이터 라벨: `IBM Plex Mono`

## 여백과 최소 크기

- 심볼 주위에는 심볼 높이의 최소 1/4만큼 빈 공간을 둔다.
- 심볼 단독 최소 크기는 디지털 화면에서 `16px` (파비콘 기준)에서도 선명하게 시인된다.
- 한글 조합 로고는 너비 `120px` 미만으로 줄이지 않는다.
- `32px`보다 작은 곳에서는 텍스트를 생략하고 심볼만 사용한다.

전체 시각 기준은 `/brand/courtside-ci-board.svg` 및 `courtside-ci-board.png`를 참고한다.
