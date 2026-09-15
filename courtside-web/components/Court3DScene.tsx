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

// 3D 코트(요청: "확장하면 3D로, 슛 색상을" + "이 영상 같은 느낌" - ESPN "Every bucket from
// LeBron James' career"). 그 영상의 핵심은 회전이 아니라 "시즌이 넘어가며 득점이 쌓이는" 빌드업
// 연출이라, 열자마자 한 번 그 순서로 재생하고(시즌 있으면 시즌 단위, 없으면 균등 10조각)
// 끝나면 평소처럼 자유 회전으로 넘어간다.
//
// 움직임 규칙(이 사이트 계약 - "움직임은 라이브 점 하나 + 1회 그리기 와이프"): 이 빌드업은
// careerStrip/PlayerForm의 "1회 그리기 와이프"와 같은 예외다 - 열 때 한 번만 재생하고 끝나면
// 완전히 멈춘다(반복 없음, 이후 자동 움직임 없음). 재생 중엔 카메라도 고정 - 회전은 재생이
// 끝난 뒤 사용자가 드래그할 때만(무한 requestAnimationFrame 루프 없음, OrbitControls
// 'change' 이벤트에서만 다시 그림).
export type Court3DProgress = { shown: number; total: number; pts: number; totalPts: number; label: string | null; done: boolean };

export function Court3DScene({
  shots,
  accentColor,
  onProgress,
  skipToken,
}: {
  shots: Court3DShot[];
  accentColor: string;
  onProgress?: (p: Court3DProgress) => void;
  /** 이 값이 바뀔 때마다(부모의 "건너뛰기" 클릭) 빌드업을 즉시 끝까지 채운다. */
  skipToken?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onProgressRef = useRef(onProgress);
  useEffect(() => {
    onProgressRef.current = onProgress;
  });
  const skipRequestedRef = useRef(false);

  useEffect(() => {
    // 0은 마운트 직후의 초깃값(부모가 아직 "건너뛰기"를 누르지 않은 상태) - 그때는 건너뛰지 않는다.
    if (skipToken) skipRequestedRef.current = true;
  }, [skipToken]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    skipRequestedRef.current = false;
    // tick()이 스스로를 재귀 예약하는 setTimeout이라 타이머 id를 일일이 못 지운다 - 대신 이
    // 플래그를 tick/finishInstant 맨 앞에서 확인한다(언마운트 뒤 늦게 도착한 타이머가 이미
    // dispose된 renderer/mesh를 건드리지 않도록).
    let disposed = false;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // ── 코트 바닥 ──
    const halfLen = HALFCOURT_LINE_Z + BASELINE_TO_RIM_M;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_WIDTH_M * 2, halfLen),
      new THREE.MeshStandardMaterial({ color: 0xc9975f, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = (HALFCOURT_LINE_Z - BASELINE_TO_RIM_M) / 2;
    scene.add(floor);

    // ── 코트 선 ──
    const lineMat = new THREE.LineBasicMaterial({ color: 0xf5f0e6 });
    const y = 0.01;
    const addLine = (pts: [number, number][]) =>
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, y, z))), lineMat));
    const addLoop = (pts: [number, number][]) =>
      scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, y, z))), lineMat));

    const baseZ = -BASELINE_TO_RIM_M;
    addLine([[-HALF_WIDTH_M, baseZ], [HALF_WIDTH_M, baseZ]]);
    addLine([[-HALF_WIDTH_M, baseZ], [-HALF_WIDTH_M, HALFCOURT_LINE_Z]]);
    addLine([[HALF_WIDTH_M, baseZ], [HALF_WIDTH_M, HALFCOURT_LINE_Z]]);
    addLine([[-HALF_WIDTH_M, HALFCOURT_LINE_Z], [HALF_WIDTH_M, HALFCOURT_LINE_Z]]);
    addLoop([
      [-KEY_WIDTH_M / 2, baseZ],
      [KEY_WIDTH_M / 2, baseZ],
      [KEY_WIDTH_M / 2, baseZ + KEY_LENGTH_M],
      [-KEY_WIDTH_M / 2, baseZ + KEY_LENGTH_M],
    ]);
    const circlePts = (r: number, cz: number, n = 48): [number, number][] =>
      Array.from({ length: n + 1 }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return [Math.sin(a) * r, cz + Math.cos(a) * r];
      });
    addLoop(circlePts(FT_CIRCLE_R_M, baseZ + KEY_LENGTH_M));
    const arcPts: [number, number][] = [];
    for (let i = 0; i <= 48; i++) {
      const a = -Math.PI / 2 + (i / 48) * Math.PI;
      const px = Math.cos(a) * THREE_PT_M;
      if (Math.abs(px) > HALF_WIDTH_M - 0.2) continue;
      arcPts.push([px, Math.sin(a) * THREE_PT_M]);
    }
    addLine(arcPts);

    // ── 골대 ──
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

    // ── 슛 마커 - 시즌(있으면) 순으로 정렬해 빌드업 순서를 만든다. ──
    const bySeason = (a: Court3DShot, b: Court3DShot) => (a.season ?? "").localeCompare(b.season ?? "");
    const made = shots.filter((s) => s.made).sort(bySeason);
    const missed = shots.filter((s) => !s.made).sort(bySeason);
    const totalPts = made.reduce((s, m) => s + m.value, 0);

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
    made.forEach((s, i) => madeMesh.setMatrixAt(i, m.makeTranslation(s.x, 0.14, s.z)));
    missed.forEach((s, i) => missedMesh.setMatrixAt(i, m.makeTranslation(s.x, 0.11, s.z)));
    madeMesh.count = 0;
    missedMesh.count = 0;
    if (made.length) scene.add(madeMesh);
    if (missed.length) scene.add(missedMesh);

    // ── 조명 ──
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(6, 10, 6);
    scene.add(sun);

    // ── 카메라 · 컨트롤(빌드업 동안은 꺼둔다 - 재생이 끝나야 손으로 돌릴 수 있다) ──
    const target = new THREE.Vector3(0, 1, HALFCOURT_LINE_Z * 0.35);
    camera.position.set(0, 9, -6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = false;
    controls.minDistance = 4;
    controls.maxDistance = 26;
    controls.maxPolarAngle = Math.PI / 2 - 0.03;
    controls.enabled = false;
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

    // ── 빌드업 재생 - shots에 season이 하나라도 있으면 시즌 단위, 없으면 균등 10조각. ──
    const hasSeason = shots.some((s) => s.season);
    const batchKeys = hasSeason
      ? Array.from(new Set(made.concat(missed).map((s) => s.season ?? ""))).sort((a, b) => a.localeCompare(b))
      : Array.from({ length: Math.min(10, Math.max(1, shots.length)) }, (_, i) => String(i));
    const chunkSize = hasSeason ? 0 : Math.ceil(Math.max(1, shots.length) / batchKeys.length);
    const inBatch = (s: Court3DShot, idxInArr: number, key: string) => (hasSeason ? (s.season ?? "") === key : Math.floor(idxInArr / chunkSize) === Number(key));

    let madeShown = 0,
      missedShown = 0,
      batchIdx = 0;
    const totalShots = made.length + missed.length;
    // 총 재생 시간은 시즌 수와 무관하게 대략 일정하게(너무 길면 지루하고, 너무 짧으면 "빌드업"이 안 느껴진다).
    const tickMs = Math.min(700, Math.max(90, 4200 / Math.max(1, batchKeys.length)));

    function finishInstant() {
      if (disposed) return;
      madeMesh.count = made.length;
      missedMesh.count = missed.length;
      render();
      controls.enabled = true;
      controls.update();
      onProgressRef.current?.({ shown: totalShots, total: totalShots, pts: totalPts, totalPts, label: null, done: true });
    }

    function tick() {
      if (disposed) return;
      if (skipRequestedRef.current) {
        finishInstant();
        return;
      }
      if (batchIdx >= batchKeys.length) {
        finishInstant();
        return;
      }
      const key = batchKeys[batchIdx];
      while (madeShown < made.length && inBatch(made[madeShown], madeShown, key)) madeShown++;
      while (missedShown < missed.length && inBatch(missed[missedShown], missedShown, key)) missedShown++;
      madeMesh.count = madeShown;
      missedMesh.count = missedShown;
      render();
      let pts = 0;
      for (let i = 0; i < madeShown; i++) pts += made[i].value;
      onProgressRef.current?.({
        shown: madeShown + missedShown,
        total: totalShots,
        pts,
        totalPts,
        label: hasSeason ? key : null,
        done: false,
      });
      batchIdx++;
      window.setTimeout(tick, tickMs);
    }

    let cleanupTimer: (() => void) | undefined;
    if (totalShots > 0) {
      const t = window.setTimeout(tick, 260); // 패널이 뜨자마자 바로 시작하면 화면 전환과 겹쳐 보인다 - 짧게 텀.
      cleanupTimer = () => window.clearTimeout(t);
    } else {
      finishInstant();
    }

    return () => {
      disposed = true;
      cleanupTimer?.();
      ro.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          const mat = obj.material;
          (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
        }
      });
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
    // shots/accentColor는 모달이 열릴 때마다 이 컴포넌트가 새로 마운트되므로 고정값으로 취급한다
    // (빈 배열 - 매 렌더마다 씬을 다시 짓지 않는다). onProgress/skipToken은 ref로 최신값을 받는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
