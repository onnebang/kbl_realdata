"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  BASELINE_TO_RIM_M,
  BACKBOARD_TO_RIM_M,
  FT_CIRCLE_R_M,
  HALFCOURT_LINE_Z,
  HALF_WIDTH_M,
  KEY_LENGTH_M,
  KEY_WIDTH_M,
  RIM_HEIGHT_M,
  RIM_RADIUS_M,
  THREE_PT_M,
  type Court3DShot,
} from "@/lib/court3d";

// 3D 코트(요청: "확장하면 3D로, 슛 색상을"). 실측 좌표(lib/court3d.ts toCourt3D)를 그대로 꽂아
// 넣는 렌더러 - 데이터 가공은 여기 없다. 이 파일만 three.js를 문다(코드 스플릿 - 호출부가
// next/dynamic({ssr:false})으로 부른다. 기본 페이지 번들엔 안 실린다).
//
// 움직임 규칙(이 사이트 계약 - "움직임은 라이브 점 하나뿐"): 자동 회전·관성 감쇠(damping) 없음.
// 사용자가 드래그하는 동안만 다시 그리고, 손을 떼면 그 자리에서 정지한다 - requestAnimationFrame
// 루프를 상시 돌리지 않는다(OrbitControls 'change' 이벤트에서만 렌더).
//
// 색: 성공 슛 = 이 선수/팀 색(채움), 실패 슛 = 회색 와이어프레임 - 기존 2D 코트(zoneCompare.ts
// buildCourtDotsSvg)의 "성공=채움/실패=테두리만" 규칙을 3D에서도 그대로 잇는다.
export function Court3DScene({ shots, accentColor }: { shots: Court3DShot[]; accentColor: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // ── 코트 바닥 ──
    const halfLen = HALFCOURT_LINE_Z + BASELINE_TO_RIM_M; // 베이스라인 ~ 하프라인
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_WIDTH_M * 2, halfLen),
      new THREE.MeshStandardMaterial({ color: 0xc9975f, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = (HALFCOURT_LINE_Z - BASELINE_TO_RIM_M) / 2;
    scene.add(floor);

    // ── 코트 선(베이스라인·사이드라인·하프라인·키·자유투 서클·3점 아크) ──
    const lineMat = new THREE.LineBasicMaterial({ color: 0xf5f0e6 });
    const y = 0.01; // 바닥에 딱 붙으면 z-fighting이 나서 살짝 띄운다.
    const addLine = (pts: [number, number][]) =>
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, y, z))), lineMat));
    const addLoop = (pts: [number, number][]) =>
      scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, y, z))), lineMat));

    const baseZ = -BASELINE_TO_RIM_M;
    addLine([[-HALF_WIDTH_M, baseZ], [HALF_WIDTH_M, baseZ]]); // 베이스라인
    addLine([[-HALF_WIDTH_M, baseZ], [-HALF_WIDTH_M, HALFCOURT_LINE_Z]]); // 사이드라인 좌
    addLine([[HALF_WIDTH_M, baseZ], [HALF_WIDTH_M, HALFCOURT_LINE_Z]]); // 사이드라인 우
    addLine([[-HALF_WIDTH_M, HALFCOURT_LINE_Z], [HALF_WIDTH_M, HALFCOURT_LINE_Z]]); // 하프라인
    addLoop([
      [-KEY_WIDTH_M / 2, baseZ],
      [KEY_WIDTH_M / 2, baseZ],
      [KEY_WIDTH_M / 2, baseZ + KEY_LENGTH_M],
      [-KEY_WIDTH_M / 2, baseZ + KEY_LENGTH_M],
    ]); // 페인트존
    const circlePts = (r: number, cz: number, n = 48): [number, number][] =>
      Array.from({ length: n + 1 }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return [Math.sin(a) * r, cz + Math.cos(a) * r];
      });
    addLoop(circlePts(FT_CIRCLE_R_M, baseZ + KEY_LENGTH_M)); // 자유투 서클
    // 3점 아크 - 코트 폭 안에 들어오는 절반만(간이 - 코너 3점 직선 구간은 생략).
    const arcPts: [number, number][] = [];
    for (let i = 0; i <= 48; i++) {
      const a = -Math.PI / 2 + (i / 48) * Math.PI;
      const px = Math.cos(a) * THREE_PT_M;
      if (Math.abs(px) > HALF_WIDTH_M - 0.2) continue;
      arcPts.push([px, Math.sin(a) * THREE_PT_M]);
    }
    addLine(arcPts);

    // ── 골대(림 + 백보드) ──
    const rim = new THREE.Mesh(new THREE.TorusGeometry(RIM_RADIUS_M, 0.02, 8, 24), new THREE.MeshStandardMaterial({ color: 0xff5a1f }));
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, RIM_HEIGHT_M, 0);
    scene.add(rim);
    const backboard = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 1.05, 0.03),
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 })
    );
    backboard.position.set(0, RIM_HEIGHT_M + 0.35, -(BACKBOARD_TO_RIM_M + 0.015));
    scene.add(backboard);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, RIM_HEIGHT_M + 0.6, 8), new THREE.MeshStandardMaterial({ color: 0x555555 }));
    pole.position.set(0, (RIM_HEIGHT_M + 0.6) / 2, -1.4);
    scene.add(pole);

    // ── 슛 마커 - 성공/실패 각각 InstancedMesh 하나씩(수천 개도 가볍다). ──
    const made = shots.filter((s) => s.made);
    const missed = shots.filter((s) => !s.made);
    const madeMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.14, 10, 8),
      new THREE.MeshStandardMaterial({ color: accentColor }),
      Math.max(1, made.length)
    );
    const missedMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.11, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x9aa0ac, wireframe: true, transparent: true, opacity: 0.55 }),
      Math.max(1, missed.length)
    );
    const m = new THREE.Matrix4();
    made.forEach((s, i) => {
      m.makeTranslation(s.x, 0.14, s.z);
      madeMesh.setMatrixAt(i, m);
    });
    missed.forEach((s, i) => {
      m.makeTranslation(s.x, 0.11, s.z);
      missedMesh.setMatrixAt(i, m);
    });
    if (made.length) scene.add(madeMesh);
    if (missed.length) scene.add(missedMesh);

    // ── 조명 ──
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(6, 10, 6);
    scene.add(sun);

    // ── 카메라 · 컨트롤 ──
    const target = new THREE.Vector3(0, 1, HALFCOURT_LINE_Z * 0.35);
    camera.position.set(0, 9, -6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = false; // 정지 상태를 기본값으로(이 사이트는 움직임을 라이브 점 하나로 제한한다).
    controls.minDistance = 4;
    controls.maxDistance = 26;
    controls.maxPolarAngle = Math.PI / 2 - 0.03; // 바닥 아래로 못 내려가게.
    controls.update();

    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);

    const ro = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = container;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      render();
    });
    ro.observe(container);
    render();

    return () => {
      ro.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineLoop) {
          obj.geometry.dispose();
          const mat = obj.material;
          (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
        }
      });
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
    // shots/accentColor가 바뀌는 건 이 컴포넌트가 다시 마운트될 때뿐(모달이 열릴 때마다
    // 새로 만든다) - 의존성 배열을 비워 매 렌더마다 씬을 다시 짓지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
