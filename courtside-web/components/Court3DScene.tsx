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
  RENDER_HALF_WIDTH_M,
  RENDER_MAX_Z,
  RIM_HEIGHT_M,
  RIM_RADIUS_M,
  THREE_PT_M,
  type Court3DShot,
} from "@/lib/court3d";

export type Court3DProgress = { shown: number; total: number; pts: number; totalPts: number; label: string | null; done: boolean };
export type Court3DGroupBy = "season" | "team" | "quarter";

// 궤적(Arc) 생성을 위한 유틸: 바닥(x, 0, z)에서 림(0, RIM_HEIGHT_M, 0)까지의 3D 포물선을 만든다.
function createArcVertices(x: number, z: number, yEnd: number, segments = 12) {
  const p0 = new THREE.Vector3(x, 0, z);
  const p2 = new THREE.Vector3(0, yEnd, 0);
  
  // 중간 제어점: 직선보다 위로 솟구치도록 y를 높인다. 거리에 비례해 더 높게.
  const dist = p0.distanceTo(p2);
  const p1 = new THREE.Vector3(x / 2, yEnd + Math.max(1.5, dist * 0.3), z / 2);
  
  const curve = new THREE.QuadraticBezierCurve3(p0, p1, p2);
  const pts = curve.getPoints(segments);
  const vertices = [];
  for (let i = 0; i < segments; i++) {
    vertices.push(pts[i].x, pts[i].y, pts[i].z);
    vertices.push(pts[i+1].x, pts[i+1].y, pts[i+1].z);
  }
  return vertices;
}

export function Court3DScene({
  shots,
  accentColor,
  onProgress,
  skipToken,
  groupBy = "season",
  showMadeArcs,
  showMissedArcs,
}: {
  shots: Court3DShot[];
  accentColor: string;
  onProgress?: (p: Court3DProgress) => void;
  skipToken?: number;
  groupBy?: Court3DGroupBy;
  showMadeArcs?: boolean;
  showMissedArcs?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onProgressRef = useRef(onProgress);
  useEffect(() => {
    onProgressRef.current = onProgress;
  });
  const skipRequestedRef = useRef(false);
  const showMadeRef = useRef(showMadeArcs ?? true);
  const showMissedRef = useRef(showMissedArcs ?? false);
  const rebuildRef = useRef<((shots: Court3DShot[], groupBy: Court3DGroupBy, accentColor: string) => void) | null>(null);
  useEffect(() => { 
    showMadeRef.current = showMadeArcs ?? true; 
    showMissedRef.current = showMissedArcs ?? false; 
  }, [showMadeArcs, showMissedArcs]);

  useEffect(() => {
    if (skipToken) skipRequestedRef.current = true;
  }, [skipToken]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    skipRequestedRef.current = false;
    let disposed = false;

    const scene = new THREE.Scene();
    // 시네마틱 화각을 위해 FOV 50 -> 45로 약간 망원 렌즈 느낌 추가
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // ── 배경 별 ──
    const accent = new THREE.Color(accentColor);
    const starGeo = new THREE.BufferGeometry();
    const starN = 500;
    const starPos = new Float32Array(starN * 3);
    for (let i = 0; i < starN; i++) {
      const r = 22 + Math.random() * 22;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 1.4 - 0.4);
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = Math.abs(r * Math.cos(phi));
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.14, transparent: true, opacity: 0.8, sizeAttenuation: true });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // ── 코트 바닥 (고급스러운 글로시 재질로 개편) ──
    const halfLen = RENDER_MAX_Z + BASELINE_TO_RIM_M;
    const courtMidZ = (RENDER_MAX_Z - BASELINE_TO_RIM_M) / 2;
    // 어둡지만 메탈릭한 나무/플라스틱 코트 느낌. roughness를 낮춰 궤적 빛이 바닥에 반사되도록.
    const floorColor = new THREE.Color(0x130e26);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(RENDER_HALF_WIDTH_M * 2, halfLen),
      new THREE.MeshStandardMaterial({ 
        color: floorColor, 
        roughness: 0.15, // 반사율 증가 (글로시)
        metalness: 0.8,
        emissive: accent, 
        emissiveIntensity: 0.05, 
        side: THREE.DoubleSide 
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = courtMidZ;
    scene.add(floor);

    // ── 코트 선 (네온 발광 유지) ──
    const lineColor = accent.clone().lerp(new THREE.Color(0xffffff), 0.5);
    const lineMat = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.8 });
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
    addLoop([[-KEY_WIDTH_M / 2, baseZ], [KEY_WIDTH_M / 2, baseZ], [KEY_WIDTH_M / 2, baseZ + KEY_LENGTH_M], [-KEY_WIDTH_M / 2, baseZ + KEY_LENGTH_M]]);
    const circlePts = (r: number, cz: number, n = 48): [number, number][] =>
      Array.from({ length: n + 1 }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return [Math.sin(a) * r, cz + Math.cos(a) * r];
      });
    addLoop(circlePts(FT_CIRCLE_R_M, baseZ + KEY_LENGTH_M));
    const arcPhiMax = Math.acos(Math.max(-1, Math.min(1, baseZ / THREE_PT_M)));
    const arcPts: [number, number][] = [];
    for (let i = 0; i <= 48; i++) {
      const phi = -arcPhiMax + (i / 48) * (2 * arcPhiMax);
      arcPts.push([Math.sin(phi) * THREE_PT_M, Math.cos(phi) * THREE_PT_M]);
    }
    addLine(arcPts);

    // ── 골대 ──
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(RIM_RADIUS_M, 0.02, 8, 24),
      new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff5a1f, emissiveIntensity: 0.8 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, RIM_HEIGHT_M, 0);
    scene.add(rim);
    const rimGlow = new THREE.PointLight(accent, 1.8, 8);
    rimGlow.position.set(0, RIM_HEIGHT_M, 0);
    scene.add(rimGlow);
    const backboard = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 1.05, 0.03),
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 })
    );
    backboard.position.set(0, RIM_HEIGHT_M + 0.35, -(BACKBOARD_TO_RIM_M + 0.015));
    scene.add(backboard);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, RIM_HEIGHT_M + 0.6, 8), new THREE.MeshStandardMaterial({ color: 0x555555 }));
    pole.position.set(0, (RIM_HEIGHT_M + 0.6) / 2, -1.4);
    scene.add(pole);

    // ── 천장 링 ──
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(3.5, 0.08, 8, 48),
      new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.5 })
    );
    halo.rotation.x = Math.PI / 2;
    halo.position.set(0, 10, courtMidZ);
    scene.add(halo);
    const haloLight = new THREE.PointLight(accent, 1.2, 25);
    haloLight.position.copy(halo.position);
    scene.add(haloLight);

    // ── 3D 부유 텍스트 (홀로그램 UI) ──
    // Canvas를 텍스처로 만들어 Sprite로 장착. 텍스트 내용이 바뀔 때마다 업데이트.
    const hudCanvas = document.createElement("canvas");
    hudCanvas.width = 512;
    hudCanvas.height = 256;
    const hudCtx = hudCanvas.getContext("2d")!;
    const hudTex = new THREE.CanvasTexture(hudCanvas);
    const hudMat = new THREE.SpriteMaterial({ map: hudTex, transparent: true, blending: THREE.AdditiveBlending });
    const hudSprite = new THREE.Sprite(hudMat);
    hudSprite.position.set(0, 7.5, 0); // 골대 위쪽 공중에 띄움
    hudSprite.scale.set(6, 3, 1);
    scene.add(hudSprite);

    const update3DHud = (label: string | null, ptsStr: string) => {
      hudCtx.clearRect(0, 0, 512, 256);
      if (!label && !ptsStr) {
        hudTex.needsUpdate = true;
        return;
      }
      
      // 배경 글로우
      const rgb = `${Math.round(accent.r * 255)}, ${Math.round(accent.g * 255)}, ${Math.round(accent.b * 255)}`;
      const grad = hudCtx.createRadialGradient(256, 128, 0, 256, 128, 200);
      grad.addColorStop(0, `rgba(${rgb}, 0.2)`);
      grad.addColorStop(1, "transparent");
      hudCtx.fillStyle = grad;
      hudCtx.fillRect(0, 0, 512, 256);
      
      hudCtx.textAlign = "center";
      
      // 시즌 라벨
      if (label) {
        let fmt = label;
        if (groupBy === "season" && label.length === 9) fmt = `${label.slice(2,4)}-${label.slice(7,9)}`; // "2023-2024" -> "23-24"
        hudCtx.font = "bold 44px sans-serif";
        hudCtx.fillStyle = `rgba(${rgb}, 0.9)`;
        hudCtx.fillText(fmt, 256, 90);
      }
      
      // 점수
      hudCtx.font = "bold 76px sans-serif";
      hudCtx.fillStyle = "#ffffff";
      hudCtx.fillText(`${ptsStr} PTS`, 256, 175);
      
      hudTex.needsUpdate = true;
    };


    // ── 조명 ──
    scene.add(new THREE.HemisphereLight(0xffffff, 0x111122, 1.2)); // 바닥 반사가 잘 보이게 어둡게
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(8, 12, 6);
    scene.add(sun);
    const arenaLight = new THREE.PointLight(accentColor, 1.5, 50);
    arenaLight.position.set(0, 15, (RENDER_MAX_Z - BASELINE_TO_RIM_M) / 2);
    scene.add(arenaLight);

    // ── 카메라 및 컨트롤 ──
    const target = new THREE.Vector3(0, 1.5, HALFCOURT_LINE_Z * 0.35);
    // 카메라 시네마틱 패닝 변수 (필터 변경 시 rebuildShots가 여기로 리셋)
    const camStart = new THREE.Vector3(-14, 4, -4);
    const camEnd = new THREE.Vector3(0, 11, -12); // 정면 하이앵글로 마무리
    // 시네마틱 앵글 시작점 (코너 쪽 로우앵글)
    camera.position.copy(camStart);
    camera.lookAt(target);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1.5;
    controls.maxDistance = 60;
    controls.maxPolarAngle = Math.PI - 0.02;
    controls.listenToKeyEvents(window);
    controls.keyPanSpeed = 15;
    controls.screenSpacePanning = true;
    controls.enabled = false; // 재생 중엔 끔
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

    // ── 슛 마커/궤적/빌드업 재생 (필터·그룹핑·색상 변경 시 rebuildShots가 재구성) ──
    let arcMeshes: {
      madeSpotMesh: THREE.InstancedMesh;
      missedSpotMesh: THREE.InstancedMesh;
      madeArcGeo: THREE.BufferGeometry;
      missedArcGeo: THREE.BufferGeometry;
      madeArcs: THREE.LineSegments;
      missedArcs: THREE.LineSegments;
    } | null = null;
    let playback: { cancelled: boolean } | null = null;

    function rebuildShots(nextShots: Court3DShot[], nextGroupBy: Court3DGroupBy, nextAccentColor: string) {
      if (disposed) return;
      if (playback) playback.cancelled = true;
      const myPlayback = { cancelled: false };
      playback = myPlayback;

      if (arcMeshes) {
        const old = arcMeshes;
        [old.madeSpotMesh, old.missedSpotMesh, old.madeArcs, old.missedArcs].forEach((obj) => {
          scene.remove(obj);
          obj.geometry.dispose();
          const mat = obj.material;
          (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
        });
        arcMeshes = null;
      }

      const groupField = (s: Court3DShot) => (nextGroupBy === "team" ? s.team : nextGroupBy === "quarter" ? s.quarter : s.season) ?? "";
      const byGroup = (a: Court3DShot, b: Court3DShot) => groupField(a).localeCompare(groupField(b));
      const made = nextShots.filter((s) => s.made).sort(byGroup);
      const missed = nextShots.filter((s) => !s.made).sort(byGroup);
      const totalPts = made.reduce((s, mm) => s + mm.value, 0);

      // 바닥 슛 스팟 (InstancedMesh 유지 - 위치 표시용)
      const madeSpotMesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.12, 10, 8),
        new THREE.MeshStandardMaterial({ color: nextAccentColor, emissive: nextAccentColor, emissiveIntensity: 0.5 }),
        Math.max(1, made.length)
      );
      const missedSpotMesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.09, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xe7eaf2, wireframe: true, transparent: true, opacity: 0.4 }),
        Math.max(1, missed.length)
      );
      const m = new THREE.Matrix4();
      made.forEach((s, i) => madeSpotMesh.setMatrixAt(i, m.makeTranslation(s.x, 0.12, s.z)));
      missed.forEach((s, i) => missedSpotMesh.setMatrixAt(i, m.makeTranslation(s.x, 0.09, s.z)));
      madeSpotMesh.count = 0;
      missedSpotMesh.count = 0;
      if (made.length) scene.add(madeSpotMesh);
      if (missed.length) scene.add(missedSpotMesh);

      // 슛 궤적 (LineSegments) - 퍼포먼스와 정교한 라인 렌더링을 위해 단일 BufferGeometry 사용
      const segmentsPerArc = 16;
      const ptsPerArc = segmentsPerArc * 2;
      const shotAccent = new THREE.Color(nextAccentColor);

      // 성공 궤적
      const madeArcPositions = new Float32Array(Math.max(1, made.length) * ptsPerArc * 3);
      const madeArcColors = new Float32Array(Math.max(1, made.length) * ptsPerArc * 3);
      made.forEach((s, i) => {
        const v = createArcVertices(s.x, s.z, RIM_HEIGHT_M, segmentsPerArc);
        madeArcPositions.set(v, i * ptsPerArc * 3);
        // 3점슛이면 끝부분 색상을 밝게, 2점이면 악센트 컬러 (그라데이션)
        for (let j = 0; j < ptsPerArc; j++) {
          const ratio = j / ptsPerArc; // 0 (바닥) -> 1 (림)
          const c = s.value === 3 ? shotAccent.clone().lerp(new THREE.Color(0xffffff), ratio) : shotAccent;
          madeArcColors.set([c.r, c.g, c.b], i * ptsPerArc * 3 + j * 3);
        }
      });
      const madeArcGeo = new THREE.BufferGeometry();
      madeArcGeo.setAttribute('position', new THREE.BufferAttribute(madeArcPositions, 3));
      madeArcGeo.setAttribute('color', new THREE.BufferAttribute(madeArcColors, 3));
      madeArcGeo.setDrawRange(0, 0);
      const madeArcMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
      const madeArcs = new THREE.LineSegments(madeArcGeo, madeArcMat);
      madeArcs.visible = showMadeRef.current;
      scene.add(madeArcs);

      // 실패 궤적 (조금 더 투명하게)
      const missedArcPositions = new Float32Array(Math.max(1, missed.length) * ptsPerArc * 3);
      missed.forEach((s, i) => {
        const v = createArcVertices(s.x, s.z, RIM_HEIGHT_M, segmentsPerArc);
        missedArcPositions.set(v, i * ptsPerArc * 3);
      });
      const missedArcGeo = new THREE.BufferGeometry();
      missedArcGeo.setAttribute('position', new THREE.BufferAttribute(missedArcPositions, 3));
      missedArcGeo.setDrawRange(0, 0);
      const missedArcMat = new THREE.LineBasicMaterial({ color: 0x666a7a, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending });
      const missedArcs = new THREE.LineSegments(missedArcGeo, missedArcMat);
      missedArcs.visible = showMissedRef.current;
      scene.add(missedArcs);

      arcMeshes = { madeSpotMesh, missedSpotMesh, madeArcGeo, missedArcGeo, madeArcs, missedArcs };

      // 카메라를 시네마틱 시작 위치로 리셋하고 즉시 한 프레임 렌더 (필터 전환 시 이전 프레임이 안 남게)
      camera.position.copy(camStart);
      camera.lookAt(target);
      controls.enabled = false; // 재생 중엔 끔
      controls.update();
      render();

      // ── 빌드업 재생 ──
      const hasGroup = nextShots.some((s) => groupField(s));
      const batchKeys = hasGroup
        ? Array.from(new Set(made.concat(missed).map(groupField))).sort((a, b) => a.localeCompare(b))
        : Array.from({ length: Math.min(10, Math.max(1, nextShots.length)) }, (_, i) => String(i));
      const chunkSize = hasGroup ? 0 : Math.ceil(Math.max(1, nextShots.length) / batchKeys.length);
      const inBatch = (s: Court3DShot, idxInArr: number, key: string) => (hasGroup ? groupField(s) === key : Math.floor(idxInArr / chunkSize) === Number(key));

      let madeShown = 0,
        missedShown = 0,
        batchIdx = 0;
      const totalShots = made.length + missed.length;
      // 시네마틱 여유를 위해 틱 시간을 좀 더 길게 (스무스한 진행)
      const tickMs = Math.min(800, Math.max(150, 5000 / Math.max(1, batchKeys.length)));

      let ptsCounter = 0;

      function finishInstant() {
        if (disposed || myPlayback.cancelled) return;
        madeSpotMesh.count = made.length;
        missedSpotMesh.count = missed.length;
        madeArcGeo.setDrawRange(0, made.length * ptsPerArc);
        missedArcGeo.setDrawRange(0, missed.length * ptsPerArc);

        // HUD 최종 업데이트
        update3DHud("CAREER", totalPts.toLocaleString());

        // 카메라 위치 최종
        camera.position.copy(camEnd);

        render();
        controls.enabled = true;
        controls.update();
        onProgressRef.current?.({ shown: totalShots, total: totalShots, pts: totalPts, totalPts, label: null, done: true });
      }

      function tick() {
        if (disposed || myPlayback.cancelled) return;
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

        madeSpotMesh.count = madeShown;
        missedSpotMesh.count = missedShown;
        madeArcGeo.setDrawRange(0, madeShown * ptsPerArc);
        missedArcGeo.setDrawRange(0, missedShown * ptsPerArc);

        let pts = 0;
        for (let i = 0; i < madeShown; i++) pts += made[i].value;
        ptsCounter = pts;

        // 카메라 부드러운 패닝
        const progressRatio = batchKeys.length > 1 ? batchIdx / (batchKeys.length - 1) : 1;
        camera.position.lerpVectors(camStart, camEnd, progressRatio);
        controls.update();

        // 3D HUD 업데이트
        update3DHud(hasGroup ? key : null, ptsCounter.toLocaleString());

        render();
        onProgressRef.current?.({
          shown: madeShown + missedShown,
          total: totalShots,
          pts,
          totalPts,
          label: hasGroup ? key : null,
          done: false,
        });
        batchIdx++;
        if (!myPlayback.cancelled) window.setTimeout(tick, tickMs);
      }

      skipRequestedRef.current = false;
      if (totalShots > 0) {
        window.setTimeout(tick, 300);
      } else {
        finishInstant();
      }
    }

    rebuildRef.current = rebuildShots;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // 애니메이션 루프 (HUD 및 controls damping을 위해)
    let reqId: number;
    const animate = () => {
      reqId = requestAnimationFrame(animate);
      let needsRender = false;

      // HUD 살짝 둥둥 떠다니는 애니메이션 (reduced motion에선 고정)
      if (hudSprite && !prefersReducedMotion) {
        const time = Date.now() * 0.002;
        hudSprite.position.y = 7.5 + Math.sin(time) * 0.2;
        needsRender = true;
      }
      if (arcMeshes) {
        if (arcMeshes.madeArcs.visible !== showMadeRef.current) {
          arcMeshes.madeArcs.visible = showMadeRef.current;
          needsRender = true;
        }
        if (arcMeshes.missedArcs.visible !== showMissedRef.current) {
          arcMeshes.missedArcs.visible = showMissedRef.current;
          needsRender = true;
        }
      }

      if (controls.enabled && controls.update()) needsRender = true;

      if (needsRender) render();
    };
    animate();

    return () => {
      disposed = true;
      if (playback) playback.cancelled = true;
      cancelAnimationFrame(reqId);
      ro.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments || obj instanceof THREE.Points || obj instanceof THREE.Sprite) {
          obj.geometry.dispose();
          const mat = obj.material;
          (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
        }
      });
      hudTex.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    rebuildRef.current?.(shots, groupBy, accentColor);
  }, [shots, groupBy, accentColor]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
