# 코트사이드 CI — Signal Ball

## 콘셉트

새 심볼은 세 가지 기능을 한 번에 읽히도록 한 선으로 정리한다.

- **농구**: 코트 오렌지 원과 공의 곡선
- **분석**: 공 안에서 우상향하는 경기 흐름선
- **중계**: 공 오른쪽으로 퍼지는 두 개의 라이브 신호

장식적인 화살촉, 그라디언트, 별도 배지를 쓰지 않는다. 핵심 색도 두 가지로 제한한다.

## 파일

- `courtside-mark.svg` — 밝은 배경용 기본 심볼
- `courtside-mark-on-dark.svg` — 어두운 배경용 심볼
- `courtside-mark-mono.svg` — 단색 인쇄·각인용 심볼
- `courtside-lockup-dark.svg` — 밝은 배경용 한글 조합
- `courtside-lockup-light.svg` — 어두운 배경용 한글 조합
- `courtside-lockup-domain.svg` — 도메인 포함 조합
- `courtside-app-icon.svg` — 앱 아이콘 원본
- `courtside-social-card.svg` — 소셜 공유 카드
- `courtside-ci-board.svg` — 한 장 요약 CI 보드

PNG와 `favicon.ico`는 `bun run brand:export`로 다시 만든다.

## 색상

| 역할 | 이름 | 값 |
| --- | --- | --- |
| 기본 잉크 | Ink | `#15171B` |
| 브랜드 강조 | Court Orange | `#F26522` |
| 역상 배경·여백 | Paper | `#F7F7F5` |

오렌지는 공과 라이브 상태처럼 의미가 있는 작은 면에만 쓴다. 장문의 텍스트 색으로 쓰지 않는다.

## 서체

- 워드마크·한글 제목: Pretendard 800
- 수치·경기 시계·영문 라벨: IBM Plex Mono 600

워드마크의 자간은 `-0.04em`을 기준으로 하며 글자별 변형은 하지 않는다.

## 최소 크기와 여백

- 심볼 최소 크기: 디지털 `20px`, 인쇄 `7mm`
- 심볼과 워드마크 사이: 심볼 높이의 `0.2배`
- 보호 여백: 사방에 오렌지 공 반지름의 `0.5배` 이상

16px 파비콘은 전용 `app/icon.svg`처럼 선을 조금 단순화한 버전을 사용한다.

## 금지 사항

- 비율을 찌그러뜨리거나 회전하지 않는다.
- 그림자, 광택, 외곽선, 그라디언트를 추가하지 않는다.
- 공과 신호를 서로 다른 임의 색으로 나누지 않는다.
- 복잡한 사진 위에는 바로 놓지 않고 Ink 또는 Paper 단색 면을 먼저 둔다.
