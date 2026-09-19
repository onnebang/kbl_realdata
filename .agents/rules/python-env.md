---
description: "Python 인터프리터 경로 강제 (KBL 프로젝트 필수)"
---

# Python Environment Rule

이 워크스페이스(`kbl_realdata`)에서 파이썬 스크립트를 실행하거나 파이썬 관련 명령어를 제안할 때는 **반드시 아래의 가상환경(venv) Python 경로를 사용해야 합니다.** 

**절대 시스템 기본 `python`이나 Anaconda 경로를 사용하지 마세요.**

## 필수 Python 경로
`D:\영상작업\축구\개발\.venv\Scripts\python.exe`

## 이유 (함정 방지)
이 프로젝트의 모델 파일(`raw/analysis/live_winprob_model.joblib` 등)은 `sklearn 1.9`와 `numpy 2.x` 환경에서 학습되어 피클링되었습니다. 
로컬에 설치된 Anaconda(3.8.8, sklearn 1.3.2, numpy 1.24) 환경에서 이 스크립트를 실행할 경우, 모듈 임포트 단계는 통과하지만 언피클 시점에 `ModuleNotFoundError: No module named 'numpy._core'` 에러가 발생하며 조용히 스크립트가 죽거나 데이터가 고착화되는 치명적인 문제가 발생합니다.

## 행동 지침
- 터미널(bash/pwsh) 커맨드를 실행할 때 `python script.py` 대신 `& "D:\영상작업\축구\개발\.venv\Scripts\python.exe" script.py` 형태로 실행하세요.
- 사용자에게 스크립트 실행을 안내할 때도 반드시 이 경로를 명시하거나 환경 변수(`KBL_PYTHON`) 세팅을 안내하세요.
