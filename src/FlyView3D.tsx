import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

interface ChunkGeom { positions: string; colors: string; vertex_count: number }
function decodeF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// World-scale 3D fly-through viewport — the 4th quad-view pane.
//
// Coordinate mapping mirrors export_obj / ThreeDPreview: Eden (X east, Y south, Z up) → Three.js
// (x = wx, y = wz, z = -wy), i.e. Y-up right-handed, one unit per block.
//
// Two camera modes (Hammer-style):
//  • Orbit (default) — drag to orbit, scroll zoom.
//  • Fly — press Z to toggle. Pointer-locks for mouse-look; WASD moves in the view plane,
//    Space/Ctrl (or E/Q) move world-up/down, Shift = speed boost. Esc / Z exits.
//
// Geometry streams per chunk within a radius of the camera; chunks outside the radius are disposed.
// Edits refetch only the chunks overlapping the last edit's bounds.

interface World { width_chunks: number; height_chunks: number; max_z: number }
interface EditBounds { x: number; y: number; w: number; h: number }

const LOAD_RADIUS = 5;   // chunks loaded around the camera (in chunk units)
const STREAM_MS = 150;   // throttle for the load/dispose sweep
const MAX_DPR = 1.5;     // cap device-pixel-ratio — Retina (2×) quadruples fragment load for ~no gain

export default function FlyView3D({
  world, editEpoch = 0, lastEdit = null, onFlyModeChange,
}: { world: World; editEpoch?: number; lastEdit?: EditBounds | null; onFlyModeChange?: (active: boolean) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [flyMode, setFlyMode] = useState(false);
  const flyModeRef = useRef(false);
  const hoverRef = useRef(false);      // pointer over this pane — gates the Z fly-toggle
  const speedMultRef = useRef(1);      // wheel-adjustable fly-speed multiplier

  const mapW = world.width_chunks * 16;
  const mapH = world.height_chunks * 16;
  const maxZ = world.max_z;

  const onFlyModeChangeRef = useRef(onFlyModeChange);
  onFlyModeChangeRef.current = onFlyModeChange;

  // Stable refs so the effect can be re-run only on world change, while edit-sync and fly-mode
  // toggles flow through refs without tearing down the scene.
  const sceneApi = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    reloadChunk: (cx: number, cy: number) => void;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x0a0f1e);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));

    // Render-on-demand: only draw when something actually changed (camera moved, chunks streamed,
    // resize) or while actively flying. Avoids burning the GPU at 60fps next to 3 other quad-view panes.
    let dirty = true;
    const invalidate = () => { dirty = true; };

    const scene = new THREE.Scene();
    // Lit setup so faces shade by orientation. Strong hemisphere fill keeps all faces legible (no
    // near-black sides); the sun adds subtle directional shading. Ground color is kept fairly bright
    // so downward/back faces don't read as missing.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa6b8, 1.05));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.position.set(0.45, 1, 0.35);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xaab4c4, 0.35);
    fill.position.set(-0.5, 0.4, -0.6);
    scene.add(fill);

    const cx = mapW / 2, cz = -mapH / 2;

    const grid = new THREE.GridHelper(Math.max(mapW, mapH), Math.max(world.width_chunks, world.height_chunks));
    grid.position.set(cx, 0, cz);
    scene.add(grid);
    scene.add(new THREE.AxesHelper(24));

    const box = new THREE.Box3(new THREE.Vector3(0, 0, -mapH), new THREE.Vector3(mapW, maxZ, 0));
    scene.add(new THREE.Box3Helper(box, new THREE.Color(0x1e3a5f)));

    const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 100000);
    // Start ABOVE the world centre (not offset by a fraction of the map — on huge worlds that lands
    // the camera outside the world, so streaming finds no chunks and the pane shows an empty plane).
    // Pulled slightly south and up, looking toward the centre.
    camera.position.set(cx, maxZ + 60, cz + 110);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.target.set(cx, Math.min(maxZ, 28), cz);

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      invalidate();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // ---- Lit material (shared) ----
    // DoubleSide so any face whose winding ends up reversed still renders (no see-through gaps);
    // face culling already removes hidden faces in the Rust geometry, so the cost is bounded.
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

    // ---- Per-chunk mesh cache ----
    const meshes = new Map<string, THREE.Mesh>();
    const inflight = new Set<string>();
    const key = (cx: number, cy: number) => `${cx},${cy}`;

    const disposeMesh = (k: string) => {
      const m = meshes.get(k);
      if (!m) return;
      scene.remove(m);
      m.geometry.dispose();
      meshes.delete(k);
      invalidate();
    };

    // Sentinel mesh marking an empty chunk (avoids refetching air-only chunks every sweep).
    const EMPTY = new THREE.Mesh();

    // Bounded-concurrency fetch queue. The streaming sweep can need ~100 chunks; firing them all at
    // once floods the IPC bridge and the world mutex (each get_chunk_geometry locks it), tanking fps.
    // We keep at most MAX_CONCURRENT requests in flight, pulling nearest-to-camera first.
    const MAX_CONCURRENT = 4;
    let active = 0;
    let queue: { cx: number; cy: number }[] = [];

    const startFetch = (cxk: number, cyk: number) => {
      const k = key(cxk, cyk);
      if (inflight.has(k) || meshes.has(k)) return;
      inflight.add(k);
      active++;
      invoke<ChunkGeom>("get_chunk_geometry", { cx: cxk, cy: cyk })
        .then((g) => {
          if (disposed) return;
          disposeMesh(k); // replace any existing mesh (reload path)
          if (g.vertex_count === 0) { meshes.set(k, EMPTY); return; }
          const geom = new THREE.BufferGeometry();
          geom.setAttribute("position", new THREE.BufferAttribute(decodeF32(g.positions), 3));
          geom.setAttribute("color", new THREE.BufferAttribute(decodeF32(g.colors), 3));
          geom.computeVertexNormals();
          geom.computeBoundingSphere(); // cheap frustum-cull test per frame
          const mesh = new THREE.Mesh(geom, mat);
          scene.add(mesh);
          meshes.set(k, mesh);
          invalidate();
        })
        .catch(() => { /* no world / out of range */ })
        .finally(() => { inflight.delete(k); active--; pump(); });
    };

    const pump = () => {
      while (active < MAX_CONCURRENT && queue.length) {
        const it = queue.shift()!;
        const k = key(it.cx, it.cy);
        if (inflight.has(k) || meshes.has(k)) continue;
        startFetch(it.cx, it.cy);
      }
    };

    // Camera-window streaming: keep chunks within LOAD_RADIUS of the camera's XY footprint.
    let lastSweep = 0;
    const streamSweep = () => {
      const ccx = Math.floor(camera.position.x / 16);
      const ccy = Math.floor(-camera.position.z / 16);
      // Rebuild the work queue each sweep (nearest-first) so the camera's current position drives
      // priority and chunks that fell out of range stop being requested.
      const needed: { cx: number; cy: number; d2: number }[] = [];
      for (let cy = ccy - LOAD_RADIUS; cy <= ccy + LOAD_RADIUS; cy++) {
        if (cy < 0 || cy >= world.height_chunks) continue;
        for (let cx2 = ccx - LOAD_RADIUS; cx2 <= ccx + LOAD_RADIUS; cx2++) {
          if (cx2 < 0 || cx2 >= world.width_chunks) continue;
          const dx = cx2 - ccx, dy = cy - ccy;
          const d2 = dx * dx + dy * dy;
          if (d2 > LOAD_RADIUS * LOAD_RADIUS) continue;
          if (meshes.has(key(cx2, cy)) || inflight.has(key(cx2, cy))) continue;
          needed.push({ cx: cx2, cy, d2 });
        }
      }
      needed.sort((a, b) => a.d2 - b.d2);
      queue = needed;
      pump();
      // Dispose far chunks (keep a small hysteresis margin).
      const drop = LOAD_RADIUS + 2;
      for (const k of [...meshes.keys()]) {
        const [kx, ky] = k.split(",").map(Number);
        if (Math.abs(kx - ccx) > drop || Math.abs(ky - ccy) > drop) {
          if (meshes.get(k) === EMPTY) meshes.delete(k);
          else disposeMesh(k);
        }
      }
    };

    // Forced reload (edit-sync): drop the cached mesh and re-queue it at the front for immediate fetch.
    const reloadChunk = (cxk: number, cyk: number) => {
      const k = key(cxk, cyk);
      if (meshes.get(k) === EMPTY) meshes.delete(k);
      else disposeMesh(k);
      queue.unshift({ cx: cxk, cy: cyk });
      pump();
    };

    // ---- Fly controller ----
    const keys = new Set<string>();
    const euler = new THREE.Euler(0, 0, 0, "YXZ");
    let pitch = 0, yaw = 0;

    // Look state. Free-look via pointer lock when it engages; otherwise drag-to-look (hold the mouse
    // button and move) — pointer lock can be silently refused in the webview, so we never depend on it.
    let lookDrag = false;
    let lastMx = 0, lastMy = 0;

    const enterFly = () => {
      // Seed yaw/pitch from the current look direction.
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      yaw = Math.atan2(-dir.x, -dir.z);
      pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      controls.enabled = false;
      onFlyModeChangeRef.current?.(true);
      // Best-effort pointer lock (free-look). Swallow rejection — drag-to-look covers the fallback.
      const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === "function") p.catch(() => {});
    };
    const exitFly = () => {
      controls.enabled = true;
      lookDrag = false;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      flyModeRef.current = false;
      setFlyMode(false);
      onFlyModeChangeRef.current?.(false);
    };

    const onPointerLockChange = () => {
      // Fired only on real lock transitions. Acquire → element === canvas (stay). Release via Esc →
      // element === null (exit). A silent lock *failure* raises pointerlockerror instead (handled
      // below) and never fires this, so the drag-to-look fallback survives.
      if (flyModeRef.current && document.pointerLockElement !== canvas) exitFly();
    };
    document.addEventListener("pointerlockchange", onPointerLockChange);
    // Lock refused (common in webviews): stay in fly mode — drag-to-look takes over.
    const onPointerLockError = () => { /* keep fly mode; fall back to drag-to-look */ };
    document.addEventListener("pointerlockerror", onPointerLockError);

    const onMouseMove = (e: MouseEvent) => {
      if (!flyModeRef.current) return;
      const locked = document.pointerLockElement === canvas;
      let dx: number, dy: number;
      if (locked) {
        dx = e.movementX; dy = e.movementY;
      } else if (lookDrag) {
        dx = e.clientX - lastMx; dy = e.clientY - lastMy;
        lastMx = e.clientX; lastMy = e.clientY;
      } else return;
      const s = 0.0025;
      yaw -= dx * s;
      pitch -= dy * s;
      pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    };
    document.addEventListener("mousemove", onMouseMove);

    // Drag-to-look fallback: press on the canvas in fly mode (when not pointer-locked) to look.
    const onCanvasDown = (e: PointerEvent) => {
      if (!flyModeRef.current || document.pointerLockElement === canvas) return;
      lookDrag = true; lastMx = e.clientX; lastMy = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onCanvasUp = () => { lookDrag = false; };
    canvas.addEventListener("pointerdown", onCanvasDown);
    canvas.addEventListener("pointerup", onCanvasUp);

    // In fly mode the wheel adjusts move speed (orbit zoom is disabled then anyway).
    const onWheel = (e: WheelEvent) => {
      if (!flyModeRef.current) return;
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      speedMultRef.current = THREE.MathUtils.clamp(speedMultRef.current * f, 0.1, 12);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // Hover tracking gates the Z fly-toggle to this pane.
    const onEnter = () => { hoverRef.current = true; };
    const onLeave = () => { hoverRef.current = false; };
    canvas.addEventListener("pointerenter", onEnter);
    canvas.addEventListener("pointerleave", onLeave);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "z" && !e.repeat) {
        // Toggle fly mode. Entering requires the pointer to be over this pane (so Z while working in
        // another quad-view pane is ignored); exiting always works.
        if (flyModeRef.current) { exitFly(); e.preventDefault(); }
        else if (hoverRef.current) { flyModeRef.current = true; setFlyMode(true); enterFly(); e.preventDefault(); }
        return;
      }
      if (!flyModeRef.current) return;
      keys.add(e.key.toLowerCase());
      // Swallow movement keys so they don't trigger app shortcuts.
      if (["w", "a", "s", "d", "e", "q", " ", "control", "shift"].includes(e.key.toLowerCase())) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.key.toLowerCase()); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    const WORLD_UP = new THREE.Vector3(0, 1, 0);

    // Reused per-frame for frustum culling of loaded chunk meshes.
    const frustum = new THREE.Frustum();
    const viewProj = new THREE.Matrix4();

    let prev = performance.now();
    let raf = 0;
    let disposed = false;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;

      let render = dirty;
      dirty = false;

      if (flyModeRef.current) {
        euler.set(pitch, yaw, 0);
        camera.quaternion.setFromEuler(euler);
        camera.getWorldDirection(fwd);
        right.crossVectors(fwd, WORLD_UP).normalize();
        const boost = keys.has("shift") ? 3.5 : 1;
        const speed = Math.max(12, maxZ * 0.6) * boost * speedMultRef.current * dt;
        const move = new THREE.Vector3();
        if (keys.has("w")) move.add(fwd);
        if (keys.has("s")) move.sub(fwd);
        if (keys.has("d")) move.add(right);
        if (keys.has("a")) move.sub(right);
        if (keys.has(" ") || keys.has("e")) move.add(WORLD_UP);
        if (keys.has("control") || keys.has("q")) move.sub(WORLD_UP);
        if (move.lengthSq() > 0) camera.position.addScaledVector(move.normalize(), speed);
        render = true; // actively flying — look/move may have changed every frame
      } else if (controls.update()) {
        render = true; // orbit moved or damping inertia still settling
      }

      if (now - lastSweep > STREAM_MS) { lastSweep = now; streamSweep(); }

      if (!render) return; // nothing changed — skip the draw entirely

      // Frustum-cull loaded meshes: streaming keeps a radius disc resident, but only the chunks in
      // view need to draw. Toggles .visible only — disposal still happens by radius in streamSweep.
      camera.updateMatrixWorld();
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProj);
      for (const m of meshes.values()) {
        if (m === EMPTY || !m.geometry.boundingSphere) continue;
        m.visible = frustum.intersectsObject(m);
      }

      renderer.render(scene, camera);
    };
    animate();

    sceneApi.current = { scene, camera, reloadChunk };

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("pointerlockerror", onPointerLockError);
      document.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerenter", onEnter);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onCanvasDown);
      canvas.removeEventListener("pointerup", onCanvasUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      for (const k of [...meshes.keys()]) disposeMesh(k);
      mat.dispose();
      controls.dispose();
      renderer.dispose();
      scene.clear();
      sceneApi.current = null;
    };
  // Re-init only when world dimensions change (new world loaded).
  }, [mapW, mapH, maxZ, world.width_chunks, world.height_chunks]);

  // Edit sync: reload chunk meshes overlapping the last edit's top-down bounds.
  useEffect(() => {
    const api = sceneApi.current;
    if (!api || !lastEdit) return;
    const cx0 = Math.floor(lastEdit.x / 16);
    const cy0 = Math.floor(lastEdit.y / 16);
    const cx1 = Math.floor((lastEdit.x + Math.max(0, lastEdit.w - 1)) / 16);
    const cy1 = Math.floor((lastEdit.y + Math.max(0, lastEdit.h - 1)) / 16);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++)
        api.reloadChunk(cx, cy);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editEpoch]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#0a0f1e" }}>
      <div style={{
        position: "absolute", top: 4, left: 6, zIndex: 1, pointerEvents: "none",
        color: flyMode ? "#34d399" : "#64748b", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em",
      }}>
        {flyMode
          ? "3D · FLY — drag/move to look · WASD · Space/Ctrl up/down · Shift fast · wheel speed · Z exit"
          : "3D · orbit (drag) · press Z to fly"}
      </div>
      {flyMode && (
        // Centre crosshair (fly mode hides the cursor via pointer-lock).
        <div style={{
          position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          zIndex: 1, pointerEvents: "none", color: "rgba(52,211,153,0.8)",
          fontSize: 16, fontWeight: 400, lineHeight: 1,
        }}>+</div>
      )}
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%", touchAction: "none", cursor: flyMode ? "move" : "grab" }}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
