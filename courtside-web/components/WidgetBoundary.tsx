"use client";

import { Component, type ReactNode } from "react";

// 위젯 하나가 브라우저에서 렌더 중 터져도 페이지 전체가 app/error.tsx로 넘어가지 않게 막는 경계(2026-09-15).
// 예전엔 경계가 루트 error.tsx 하나뿐이라, 경기 리플레이의 라이브 데이터 경계 사례 하나로 스코어·박스스코어·
// AI 리포트까지 한꺼번에 오류 화면이 됐다. 이 경계는 그 위젯 자리만 안내 문구로 바꾸고 나머지는 그대로 둔다.
//
// 잡는 범위: 클라이언트 렌더·라이프사이클 오류(하이드레이션 이후 상태 변화 포함). 서버 렌더 중 오류와 이벤트
// 핸들러·비동기 오류는 React 규칙상 여기서 잡히지 않는다 - 서버 쪽은 error.tsx가, 비동기는 각 위젯이 처리한다.
// "다시 시도"는 상태만 비워 같은 props로 다시 그린다. 일시적인 데이터 상태면 풀리고, 결정적인 버그면 다시
// 이 안내가 뜬다(무한 루프 없음 - 다시 그리는 건 사용자가 누를 때뿐).

type Props = { name: string; children: ReactNode };
type State = { error: Error | null };

export class WidgetBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[WidgetBoundary] ${this.props.name}`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="widget-error" role="alert">
        <div className="widget-error-title">{this.props.name}을(를) 그리지 못했습니다</div>
        <p className="widget-error-detail">이 부분만 멈췄고 페이지의 나머지는 그대로입니다. 다시 시도해도 같으면 새로고침해 주세요.</p>
        <button type="button" className="btn-primary" onClick={() => this.setState({ error: null })}>
          다시 시도
        </button>
      </div>
    );
  }
}
