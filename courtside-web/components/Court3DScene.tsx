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
export type Court3DGroupBy = "season" | "team" | "quarter";

export function Court3DScene({
  shots,
  accentColor,
  onProgress,
  skipToken,
  groupBy = "season",
}: {
  shots: Court3DShot[];
  accentColor: string;
  onProgress?: (p: Court3DProgress) => void;
  /** 이 값이 바뀔 때마다(부모의 "건너뛰기" 클릭) 빌드업을 즉시 끝까지 채운다. */
  skipToken?: number;
  /** 빌드업 순서를 묶을 기준(팀별/시즌별/쿼터별 탭) - 해당 필드가 없는 슛이면 균등 10조각으로 대체. */
  groupBy?: Court3DGroupBy;
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

    // ── 배경 - "가상 공간이니만큼" 실제 체육관 대신 스페이스 잼풍 에너지 아레나로(요청:
    // "경기장 디자인이 안 이뻐서... 스페이스 잼처럼 이쁘게 꾸며줘"). CSS(court-hero-expand
    // .module.css의 canvasWrap 라디얼 그라데이션)가 뒤에서 밤하늘을 깔아주므로 renderer는
    // alpha:true 그대로 두고, three 쪽엔 별과 악센트 컬러 글로우만 얹는다. ──
    const accent = new THREE.Color(accentColor);
    const starGeo = new THREE.BufferGeometry();
    const starN = 500;
    const starPos = new Float32Array(starN * 3);
    for (let i = 0; i < starN; i++) {
      const r = 22 + Math.random() * 22;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 1.4 - 0.4); // 위쪽으로 치우치게(바닥 아래는 안 보임)
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = Math.abs(r * Math.cos(phi));
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.14, transparent: true, opacity: 0.8, sizeAttenuation: true });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // ── 코트 바닥 - 실제 코트 치수(HALF_WIDTH_M/HALFCOURT_LINE_Z)보다 조금 넓게 깐다.
    // 실측(2026-09-15 제보): 하프라인 근처(~16m 이내)에서 성공한 슛이 있어 그 자리에도 바닥이
    // 있어야 "레이아웃 밖"으로 안 보인다(RENDER_MAX_Z 정의부 주석 참고). 코트 선 자체는 실제
    // 위치 그대로 그린다 - 넓어지는 건 바닥뿐이다. 제보(2026-09-16): "바닥을 어둡게 해놔서
    // 제대로 안 보인다" - metalness가 높으면 envMap 없이는 대부분 검게 죽는다는 걸 놓쳤다.
    // metalness 0(완전 디퓨즈) + 밝은 보라 베이스로 바꾸고, 라이팅도 같이 밝힌다(아래 조명
    // 섹션). 카메라를 자유롭게 풀어준 만큼 아래에서도 봐야 해서 DoubleSide. ──
    const halfLen = RENDER_MAX_Z + BASELINE_TO_RIM_M;
    const courtMidZ = (RENDER_MAX_Z - BASELINE_TO_RIM_M) / 2;
    const floorColor = new THREE.Color(0x2a2258).lerp(accent, 0.3);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(RENDER_HALF_WIDTH_M * 2, halfLen),
      new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.6, metalness: 0, emissive: accent, emissiveIntensity: 0.22, side: THREE.DoubleSide })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = courtMidZ;
    scene.add(floor);

    // ── 림 아래 에너지 글로우 - 캔버스 라디얼 그라데이션을 가산 블렌딩으로 얹어 "포털" 느낌. ──
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = glowCanvas.height = 128;
    const gctx = glowCanvas.getContext("2d")!;
    const rgb = `${Math.round(accent.r * 255)}, ${Math.round(accent.g * 255)}, ${Math.round(accent.b * 255)}`;
    const grad = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, `rgba(${rgb}, 0.55)`);
    grad.addColorStop(0.5, `rgba(${rgb}, 0.16)`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, 128, 128);
    const glowTex = new THREE.CanvasTexture(glowCanvas);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, 0.006, KEY_LENGTH_M * 0.35 - BASELINE_TO_RIM_M);
    scene.add(glow);

    // ── 코트 선 - 팀 컬러 네온으로(가상 공간이니 실제 라인 컬러를 고집할 이유가 없다). 흰색을
    // 섞어 밝혀야 팀 컬러가 어둡거나 바닥색과 비슷할 때도 바닥 위에서 묻히지 않는다. ──
    const lineColor = accent.clone().lerp(new THREE.Color(0xffffff), 0.5);
    const lineMat = new THREE.LineBasicMaterial({ color: lineColor });
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
    // 3점 아크 - 제보(2026-09-15): "반원이 잘못 그려져 있다". 예전 코드는 각을 cos=x축·sin=z축로
    // 잡아서 골대 정면(z=+R, 아크 꼭짓점)이 아니라 골대 옆(z=0)을 정점으로 그렸고, 골대 뒤(z<0,
    // 베이스라인 너머)까지 그렸다. 각 φ를 z축(하프라인 방향, 아크 꼭짓점) 기준으로 잡고, φ의
    // 범위를 "베이스라인과 만나는 각"까지만 둔다 - 코너 3점이 자연히 베이스라인에서 끊긴다.
    const arcPhiMax = Math.acos(Math.max(-1, Math.min(1, baseZ / THREE_PT_M)));
    const arcPts: [number, number][] = [];
    for (let i = 0; i <= 48; i++) {
      const phi = -arcPhiMax + (i / 48) * (2 * arcPhiMax);
      arcPts.push([Math.sin(phi) * THREE_PT_M, Math.cos(phi) * THREE_PT_M]);
    }
    addLine(arcPts);

    // ── 골대 - 림 색은 농구 정체성 유지(주황), 발광만 살짝 얹어 "에너지 링" 느낌. ──
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(RIM_RADIUS_M, 0.02, 8, 24),
      new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff5a1f, emissiveIntensity: 0.5 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, RIM_HEIGHT_M, 0);
    scene.add(rim);
    const rimGlow = new THREE.PointLight(accent, 1.4, 6);
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

    // ── 관중석 - 요청("스페이스잼같은 경기장 느낌, 관중석, 벤치, 코트까지"). 사이드라인 밖에
    // 계단식 단(段) 몇 겹 + 그 위에 색색깔 관중 점(InstancedMesh 하나로 저비용 대량 처리).
    // 제보(2026-09-16 "카메라를 돌릴 때 관중석이 걸린다"): OrbitControls는 충돌 검사가 없어
    // 카메라가 관중석 상자 반경(예전 값: 코트 가장자리+0.4~5.9m)에 걸치면 그 자리에서 orbit하다
    // 그대로 관중석 속을 뚫고 지나간다. 기본 카메라 반경(약 11.7m)이 하필 그 안에 들어 있었던 게
    // 원인 - 관중석을 "코트를 보기 위한 정상적인 orbit 반경"(대략 20m 안쪽)보다 훨씬 밖으로
    // 밀어내 카메라가 평소 쓰는 거리에서는 아예 닿지 않게 한다(STAND_GAP 10.5m로 확대). ──
    const tierN = 3,
      tierW = 1.5,
      tierH = 0.55,
      STAND_GAP = 10.5;
    const standX = (t: number) => RENDER_HALF_WIDTH_M + STAND_GAP + tierW / 2 + t * tierW;
    const tierMat = new THREE.MeshStandardMaterial({ color: 0x14101f, roughness: 0.9 });
    for (const side of [1, -1] as const) {
      for (let t = 0; t < tierN; t++) {
        const riser = new THREE.Mesh(new THREE.BoxGeometry(tierW, tierH, halfLen), tierMat);
        riser.position.set(side * standX(t), tierH / 2 + t * tierH, courtMidZ);
        scene.add(riser);
      }
    }
    const crowdColors = [0xff5a8a, 0x5ad1ff, 0xffe15a, 0x8a5aff, 0x5aff9e, 0xff9a5a, 0xff5a5a, 0x5affe0];
    const crowdPerTier = 30;
    const crowdMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.15, 6, 5),
      new THREE.MeshStandardMaterial({ roughness: 0.5 }),
      tierN * 2 * crowdPerTier
    );
    let ci = 0;
    const cc = new THREE.Color();
    const crowdM = new THREE.Matrix4();
    for (const side of [1, -1] as const) {
      for (let t = 0; t < tierN; t++) {
        const cx = side * standX(t);
        const cy = tierH * (t + 1) + 0.15;
        for (let k = 0; k < crowdPerTier; k++) {
          const cz = -BASELINE_TO_RIM_M + Math.random() * halfLen;
          crowdM.makeTranslation(cx + (Math.random() - 0.5) * tierW * 0.7, cy, cz);
          crowdMesh.setMatrixAt(ci, crowdM);
          crowdMesh.setColorAt(ci, cc.setHex(crowdColors[(ci * 7) % crowdColors.length]));
          ci++;
        }
      }
    }
    if (crowdMesh.instanceColor) crowdMesh.instanceColor.needsUpdate = true;
    scene.add(crowdMesh);

    // ── 벤치 - 한쪽 사이드라인 옆, 베이스라인 근처. ──
    const bench = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.5, 3.4),
      new THREE.MeshStandardMaterial({ color: 0x181b28, roughness: 0.7, emissive: accent, emissiveIntensity: 0.08 })
    );
    bench.position.set(HALF_WIDTH_M + 0.55, 0.25, baseZ + 2);
    scene.add(bench);

    // ── 천장 에너지 링 - 코트 위에 떠 있는 커다란 네온 원(레퍼런스의 "천장에 매달린 스코어보드
    // 링" 대체 - 텍스처 없이 순수 발광 지오메트리라 가볍다). ──
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(2.4, 0.07, 8, 48),
      new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.3 })
    );
    halo.rotation.x = Math.PI / 2;
    halo.position.set(0, 8, courtMidZ);
    scene.add(halo);
    const haloLight = new THREE.PointLight(accent, 1.0, 22);
    haloLight.position.copy(halo.position);
    scene.add(haloLight);

    // ── 슛 마커 - groupBy 기준(팀/시즌/쿼터, 있으면) 순으로 정렬해 빌드업 순서를 만든다. ──
    const groupField = (s: Court3DShot) => (groupBy === "team" ? s.team : groupBy === "quarter" ? s.quarter : s.season) ?? "";
    const byGroup = (a: Court3DShot, b: Court3DShot) => groupField(a).localeCompare(groupField(b));
    const made = shots.filter((s) => s.made).sort(byGroup);
    const missed = shots.filter((s) => !s.made).sort(byGroup);
    const totalPts = made.reduce((s, m) => s + m.value, 0);

    const madeMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.14, 10, 8),
      new THREE.MeshStandardMaterial({ color: accentColor }),
      Math.max(1, made.length)
    );
    const missedMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.11, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xe7eaf2, wireframe: true, transparent: true, opacity: 0.75 }),
      Math.max(1, missed.length)
    );
    const m = new THREE.Matrix4();
    made.forEach((s, i) => madeMesh.setMatrixAt(i, m.makeTranslation(s.x, 0.14, s.z)));
    missed.forEach((s, i) => missedMesh.setMatrixAt(i, m.makeTranslation(s.x, 0.11, s.z)));
    madeMesh.count = 0;
    missedMesh.count = 0;
    if (made.length) scene.add(madeMesh);
    if (missed.length) scene.add(missedMesh);

    // ── 조명 - 제보(2026-09-16 "바닥이 안 보인다")로 전체를 밝게 다시 잡는다. 하늘·바닥 바운스
    // 둘 다 밝혀 어디서 봐도 코트가 죽지 않게 하고, 코트 중앙 위에 경기장 조명 하나를 더 얹는다. ──
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f66, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(6, 10, 6);
    scene.add(sun);
    const arenaLight = new THREE.PointLight(0xffffff, 1.1, 40);
    arenaLight.position.set(0, 9, (RENDER_MAX_Z - BASELINE_TO_RIM_M) / 2);
    scene.add(arenaLight);

    // ── 카메라 · 컨트롤(빌드업 동안은 꺼둔다 - 재생이 끝나야 손으로 돌릴 수 있다). 요청("카메라
    // 이동이 자유롭게") - 위/아래(폴라각)와 줌 범위를 더 넓힌다. 바닥을 DoubleSide로 해둬서
    // 아래쪽까지 내려가도 구멍이 안 뚫려 보인다. 관중석은 위에서 STAND_GAP만큼 밀어내 놔서 이
    // 범위 안에서 자유롭게 돌려도 더는 관중석 상자를 뚫고 지나가지 않는다. ──
    const target = new THREE.Vector3(0, 1, HALFCOURT_LINE_Z * 0.35);
    camera.position.set(0, 9, -6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = false;
    controls.minDistance = 1.5;
    controls.maxDistance = 60;
    controls.maxPolarAngle = Math.PI - 0.02;
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

    // ── 빌드업 재생 - shots에 groupBy 필드가 하나라도 있으면 그 단위, 없으면 균등 10조각. ──
    const hasGroup = shots.some((s) => groupField(s));
    const batchKeys = hasGroup
      ? Array.from(new Set(made.concat(missed).map(groupField))).sort((a, b) => a.localeCompare(b))
      : Array.from({ length: Math.min(10, Math.max(1, shots.length)) }, (_, i) => String(i));
    const chunkSize = hasGroup ? 0 : Math.ceil(Math.max(1, shots.length) / batchKeys.length);
    const inBatch = (s: Court3DShot, idxInArr: number, key: string) => (hasGroup ? groupField(s) === key : Math.floor(idxInArr / chunkSize) === Number(key));

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
        label: hasGroup ? key : null,
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
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.Points) {
          obj.geometry.dispose();
          const mat = obj.material;
          (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
        }
      });
      glowTex.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
    // shots/accentColor/groupBy는 모달이 열릴 때마다(또는 탭 전환으로 key가 바뀔 때마다) 이
    // 컴포넌트가 새로 마운트되므로 고정값으로 취급한다(빈 배열 - 매 렌더마다 씬을 다시 짓지
    // 않는다). onProgress/skipToken은 ref로 최신값을 받는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
