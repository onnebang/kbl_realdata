'use client';
import { useEffect, useRef } from 'react';

export function HtmlSectionRenderer({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    // React의 dangerouslySetInnerHTML은 <script> 태그를 실행하지 않으므로,
    // 명시적으로 새로운 script 노드를 만들어 교체해 줌으로써 실행을 트리거한다.
    const scripts = ref.current.querySelectorAll('script');
    scripts.forEach((oldScript) => {
      // 이미 실행되었을 수 있으므로 마커 속성을 확인 (옵션)
      if (oldScript.getAttribute('data-executed') === 'true') return;
      
      const newScript = document.createElement('script');
      Array.from(oldScript.attributes).forEach((attr) => newScript.setAttribute(attr.name, attr.value));
      newScript.textContent = oldScript.textContent;
      newScript.setAttribute('data-executed', 'true');
      oldScript.parentNode?.replaceChild(newScript, oldScript);
    });
  }, [html]);

  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}
