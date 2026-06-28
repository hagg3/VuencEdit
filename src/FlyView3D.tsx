import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { AtlasData } from "./texturePack";

interface ChunkGeom { positions: string; colors: string; uvs: string; vertex_count: number }
function decodeF32(b64: string): Float32Array {
  const bin = atob(b64);
  const n = bin.length;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
  // Length in floats via (n >> 2) guards against a buffer whose byteLength isn't a multiple of 4
  // (a truncated/odd payload would otherwise throw in the Float32Array ctor).
  return new Float32Array(bytes.buffer, 0, n >> 2);
}

// World-scale 3D fly-through viewport — the 4th quad-view pane.
//
// Coordinate mapping: Eden (X east, Y south, Z up) → Three.js (x = wx, y = wz, z = wy).
// Eden north = Three.js −Z; camera starts south of the world looking north (−Z), so Eden east
// (+X) appears on the right — matching the top-down map orientation.
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

export interface FlyView3DRef {
  /** Move the camera to a world XY position (keeps current height). */
  teleport: (wx: number, wy: number) => void;
}

/** A wireframe box overlay in Eden world coordinates (Three.js coords are derived internally). */
export interface Overlay3D {
  /** Three.js min corner: [eden_x, eden_z, eden_y] */
  min: [number, number, number];
  /** Three.js max corner: [eden_x, eden_z, eden_y] */
  max: [number, number, number];
  color: number;
}

const FlyView3D = forwardRef<FlyView3DRef, {
  world: World; editEpoch?: number; lastEdit?: EditBounds | null;
  /** Initial camera target in Eden local block coords (x = east, y = south). Spawns the camera
   *  over real geometry; falls back to the world centre when null/undefined. */
  spawnAt?: { x: number; y: number } | null;
  onFlyModeChange?: (active: boolean) => void;
  onCameraMove?: (wx: number, wy: number) => void;
  overlays3d?: Overlay3D[] | null;
  /** Decoded atlas data from a loaded texture pack, or null when none loaded. */
  texturePack?: AtlasData | null;
  /** Increments whenever the texture pack changes (loaded/unloaded/toggled). */
  texEpoch?: number;
}>(function FlyView3D({
  world, editEpoch = 0, lastEdit = null, spawnAt = null, onFlyModeChange, onCameraMove, overlays3d = null,
  texturePack = null, texEpoch = 0,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [flyMode, setFlyMode] = useState(false);
  const flyModeRef = useRef(false);
  const hoverRef = useRef(false);      // pointer over this pane — gates the Z fly-toggle
  const speedMultRef = useRef(1);      // wheel-adjustable fly-speed multiplier
  const [flySpeed, setFlySpeed] = useState(1);
  const [loadRadius, setLoadRadius] = useState(LOAD_RADIUS);
  const loadRadiusRef = useRef(LOAD_RADIUS);
  const [loadingCount, setLoadingCount] = useState(0);
  const setLoadingCountRef = useRef(setLoadingCount);

  const mapW = world.width_chunks * 16;
  const mapH = world.height_chunks * 16;
  const maxZ = world.max_z;

  const onFlyModeChangeRef = useRef(onFlyModeChange);
  onFlyModeChangeRef.current = onFlyModeChange;
  const onCameraMoveRef = useRef(onCameraMove);
  onCameraMoveRef.current = onCameraMove;

  const overlays3dRef = useRef(overlays3d);
  useEffect(() => { overlays3dRef.current = overlays3d; }, [overlays3d]);

  // Read via ref so the spawn target can update (new world) without tearing down the scene.
  const spawnAtRef = useRef(spawnAt);
  spawnAtRef.current = spawnAt;

  // Texture pack refs — updated by a dedicated effect, read by startFetch inside the scene closure.
  const texMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const atlasTexRef = useRef<THREE.DataTexture | null>(null);

  // Stable refs so the effect can be re-run only on world change, while edit-sync and fly-mode
  // toggles flow through refs without tearing down the scene.
  const sceneApi = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    reloadChunk: (cx: number, cy: number) => void;
    reloadAllChunks: () => void;
    resetCamera: () => void;
    teleport: (wx: number, wy: number) => void;
    setOverlays: (ovs: Overlay3D[] | null) => void;
  } | null>(null);

  useImperativeHandle(ref, () => ({
    teleport: (wx, wy) => sceneApi.current?.teleport(wx, wy),
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: THREE.WebGLRenderer;
    try {
      // antialias:false — at DPR ≤1.5 in a small quad-view cell, MSAA's fragment cost outweighs the
      // marginal edge quality. Disabling it buys steady-state fps headroom next to 3 other panes.
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    } catch (e) {
      // Genuine WebGL-unavailable (driver/webview without a usable context). Surface a clear
      // message to the error boundary instead of a cryptic THREE internal stack.
      throw new Error(`WebGL unavailable in this environment. (${(e as Error)?.message ?? e})`);
    }
    renderer.setClearColor(0x0a0f1e);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));

    // Guard the remainder of init: if anything throws after the context exists, release it before
    // rethrowing. React skips an effect's cleanup when the effect body throws, so without this a
    // failed init would leak a live WebGL context on every mount/retry.
    try {

    // Render-on-demand: only draw when something actually changed (camera moved, chunks streamed,
    // resize) or while actively flying. Avoids burning the GPU at 60fps next to 3 other quad-view panes.
    // `invalidate` schedules a single rAF frame; `frame` reschedules itself only while fly/damping
    // need continuous updates. `frame` is a hoisted function declaration so `invalidate` can safely
    // reference it before the definition site.
    let dirty = false;
    let rafPending = false;
    // Declared here (not at the render-loop block below) because `invalidate` writes `raf` and is
    // called synchronously by the first `resize()` during init — referencing it later would hit the
    // temporal dead zone and throw "cannot access uninitialized variable", blanking the pane.
    let raf = 0;
    const invalidate = () => {
      dirty = true;
      if (rafPending) return;
      rafPending = true;
      raf = requestAnimationFrame(frame);
    };

    const scene = new THREE.Scene();
    // No scene lights — directional shading is baked into vertex colours by the Rust geometry pass
    // (obj_geometry_region SH_TOP/BOT/E/W/N/S constants).  MeshBasicMaterial renders vertex colours
    // directly with no normal calculations, eliminating the computeVertexNormals CPU spike and the
    // normal attribute buffer (~⅓ of geometry RAM).

    const cx = mapW / 2, cy = mapH / 2;
    // Camera spawn target — over real geometry when provided (sparse worlds), else world centre.
    const spawnXY = () => {
      const s = spawnAtRef.current;
      return s ? { x: s.x, y: s.y } : { x: cx, y: cy };
    };

    const grid = new THREE.GridHelper(Math.max(mapW, mapH), Math.max(world.width_chunks, world.height_chunks));
    grid.position.set(cx, 0, cy);
    scene.add(grid);
    scene.add(new THREE.AxesHelper(24));

    // World occupies Three.js (0,0,0) → (mapW, maxZ, mapH). Eden north = Three.js −Z.
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(mapW, maxZ, mapH));
    scene.add(new THREE.Box3Helper(box, new THREE.Color(0x1e3a5f)));

    const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 100000);
    // Start south of the spawn target looking north (−Z). Cameras looking in −Z have Eden east
    // (+X) on the right, matching the top-down map.
    {
      const s = spawnXY();
      camera.position.set(s.x, maxZ + 60, s.y + 110);
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    {
      const s = spawnXY();
      controls.target.set(s.x, Math.min(maxZ, 28), s.y);
    }

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

    // Unlit material — vertex colours carry baked directional shading from Rust.
    // DoubleSide kept: the face winding was designed for the old coordinate convention and is not
    // uniformly outward-facing yet, so FrontSide would drop some faces.
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });

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
    // We keep a bounded number of requests in flight, pulling nearest-to-camera first.
    // Concurrency is throttled while flying: each fetch locks the world mutex and its callback builds a
    // BufferGeometry + uploads to the GPU on the main thread. Four of those landing in one frame causes
    // a visible hitch as you fly into new terrain, so we drop to 2 in-flight while the camera is moving
    // (smoother stream-in) and use the full 4 when idle/orbiting (faster fill, hitches don't matter).
    const MAX_CONCURRENT_IDLE = 4;
    const MAX_CONCURRENT_FLY = 2;
    const maxConcurrent = () => (flyModeRef.current ? MAX_CONCURRENT_FLY : MAX_CONCURRENT_IDLE);
    let active = 0;
    let queue: { cx: number; cy: number }[] = [];

    const startFetch = (cxk: number, cyk: number) => {
      const k = key(cxk, cyk);
      if (inflight.has(k) || meshes.has(k)) return;
      inflight.add(k);
      active++;
      setLoadingCountRef.current(inflight.size);
      invoke<ChunkGeom>("get_chunk_geometry", { cx: cxk, cy: cyk })
        .then((g) => {
          if (disposed) return;
          disposeMesh(k); // replace any existing mesh (reload path)
          if (g.vertex_count === 0) { meshes.set(k, EMPTY); return; }
          const geom = new THREE.BufferGeometry();
          geom.setAttribute("position", new THREE.BufferAttribute(decodeF32(g.positions), 3));
          geom.setAttribute("color", new THREE.BufferAttribute(decodeF32(g.colors), 3));
          // Add UV attribute when the pack is loaded (uvs is non-empty base64 string).
          const hasUVs = g.uvs && g.uvs.length > 0;
          if (hasUVs) {
            geom.setAttribute("uv", new THREE.BufferAttribute(decodeF32(g.uvs), 2));
          }
          // No computeVertexNormals — MeshBasicMaterial ignores normals; shading is baked into colours.
          geom.computeBoundingSphere(); // cheap frustum-cull test per frame
          const meshMat = (hasUVs && texMatRef.current) ? texMatRef.current : mat;
          const mesh = new THREE.Mesh(geom, meshMat);
          scene.add(mesh);
          meshes.set(k, mesh);
          invalidate();
        })
        .catch(() => { /* no world / out of range */ })
        .finally(() => { inflight.delete(k); active--; pump(); setLoadingCountRef.current(inflight.size); });
    };

    const pump = () => {
      while (active < maxConcurrent() && queue.length) {
        const it = queue.shift()!;
        const k = key(it.cx, it.cy);
        if (inflight.has(k) || meshes.has(k)) continue;
        startFetch(it.cx, it.cy);
      }
    };

    // Camera-window streaming: keep chunks within LOAD_RADIUS of the camera's XY footprint.
    const streamSweep = () => {
      const ccx = Math.floor(camera.position.x / 16);
      const ccy = Math.floor(camera.position.z / 16); // Three.js Z = Eden Y
      // Rebuild the work queue each sweep (nearest-first) so the camera's current position drives
      // priority and chunks that fell out of range stop being requested.
      const r = loadRadiusRef.current;
      const needed: { cx: number; cy: number; d2: number }[] = [];
      for (let cy = ccy - r; cy <= ccy + r; cy++) {
        if (cy < 0 || cy >= world.height_chunks) continue;
        for (let cx2 = ccx - r; cx2 <= ccx + r; cx2++) {
          if (cx2 < 0 || cx2 >= world.width_chunks) continue;
          const dx = cx2 - ccx, dy = cy - ccy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r * r) continue;
          if (meshes.has(key(cx2, cy)) || inflight.has(key(cx2, cy))) continue;
          needed.push({ cx: cx2, cy, d2 });
        }
      }
      needed.sort((a, b) => a.d2 - b.d2);
      queue = needed;
      pump();
      // Dispose far chunks (keep a small hysteresis margin).
      const drop = r + 2;
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

    // Reload all chunks — called when texture pack changes so meshes are rebuilt with new material.
    const reloadAllChunks = () => {
      inflight.clear();
      active = 0;
      queue = [];
      for (const k of [...meshes.keys()]) {
        if (meshes.get(k) === EMPTY) meshes.delete(k);
        else disposeMesh(k);
      }
      streamSweep();
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
      // CRITICAL: wake the render loop. The pane renders on demand, and the loop only self-sustains
      // once a frame is already executing (frame() sets keepGoing while flying). If the scene was idle
      // when fly mode engaged, nothing would schedule a frame — WASD/look would be silently dead until
      // some unrelated event (a stream tick, resize) happened to invalidate. This made fly mode "stick".
      invalidate();
    };
    const exitFly = () => {
      controls.enabled = true;
      lookDrag = false;
      keys.clear(); // drop any held movement keys so the camera doesn't drift after exit
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
      setFlySpeed(Math.round(speedMultRef.current * 10) / 10);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // Hover tracking gates the Z fly-toggle to this pane.
    const onEnter = () => { hoverRef.current = true; };
    const onLeave = () => { hoverRef.current = false; };
    canvas.addEventListener("pointerenter", onEnter);
    canvas.addEventListener("pointerleave", onLeave);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "z" && !e.repeat && !e.metaKey && !e.ctrlKey) {
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

    // Losing window focus (alt-tab, pointer-lock transitions, devtools) can swallow the keyup for a
    // held direction key, leaving it stuck in the set so the camera drifts indefinitely. Clear on blur.
    const onBlur = () => { keys.clear(); lookDrag = false; };
    window.addEventListener("blur", onBlur);

    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    const WORLD_UP = new THREE.Vector3(0, 1, 0);

    // Reused per-frame for frustum culling of loaded chunk meshes.
    const frustum = new THREE.Frustum();
    const viewProj = new THREE.Matrix4();

    let prev = performance.now();
    let disposed = false;
    let lastEmitT = 0;
    let lastEmitEX = NaN, lastEmitEY = NaN;

    // Orbit-controls "change" wakes the loop whenever the user drags/zooms; damping keeps it alive
    // until inertia settles (controls.update() returns false), then it goes fully idle.
    controls.addEventListener("change", invalidate);
    // streamSweep runs on its own interval — independent of render cadence.
    const sweepInterval = setInterval(streamSweep, STREAM_MS);

    // Kick off: first chunk load + first render.
    streamSweep();
    invalidate();

    // Hoisted function declaration so `invalidate` (defined above) can reference `frame` safely.
    function frame() {
      rafPending = false;
      const now = performance.now();
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;

      const wasDirty = dirty;
      dirty = false;

      let keepGoing = false;

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
        keepGoing = true; // actively flying — look/move may change every frame
      } else {
        if (controls.update()) keepGoing = true; // orbit damping still settling
      }

      // Throttled camera-position broadcast (~10fps) so the top-down map can show an icon.
      if (now - lastEmitT >= 100) {
        const ex = camera.position.x, ey = camera.position.z; // Three.js Z = Eden Y
        if (ex !== lastEmitEX || ey !== lastEmitEY) {
          lastEmitEX = ex; lastEmitEY = ey;
          onCameraMoveRef.current?.(ex, ey);
        }
        lastEmitT = now;
      }

      if (wasDirty || keepGoing) {
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
      }

      // Reschedule if fly/damping need more frames, or if invalidate() fired during this frame.
      if (keepGoing || dirty) {
        rafPending = true;
        raf = requestAnimationFrame(frame);
      }
    }

    const resetCamera = () => {
      if (flyModeRef.current) exitFly();
      const s = spawnXY();
      camera.position.set(s.x, maxZ + 60, s.y + 110);
      controls.target.set(s.x, Math.min(maxZ, 28), s.y);
      controls.update();
      streamSweep(); // re-prioritise chunk streaming around the new viewpoint
      invalidate();
    };

    // Teleport camera to an Eden world XY position, keeping the current height.
    // Force an immediate chunk sweep so old far-away chunks are cleared right away.
    const teleport = (wx: number, wy: number) => {
      camera.position.x = wx;
      camera.position.z = wy; // Three.js Z = Eden Y
      controls.target.x = wx;
      controls.target.z = wy;
      controls.update();
      streamSweep(); // immediate sweep without waiting for the next interval tick
      invalidate();
    };

    // ---- Overlay wireframe boxes ----
    const overlayHelpers: THREE.Box3Helper[] = [];

    const clearOverlays = () => {
      for (const h of overlayHelpers) { scene.remove(h); (h.geometry as THREE.BufferGeometry).dispose(); }
      overlayHelpers.length = 0;
    };

    const setOverlays = (ovs: Overlay3D[] | null) => {
      clearOverlays();
      if (!ovs) { invalidate(); return; }
      for (const ov of ovs) {
        const box = new THREE.Box3(
          new THREE.Vector3(...ov.min),
          new THREE.Vector3(...ov.max),
        );
        const helper = new THREE.Box3Helper(box, new THREE.Color(ov.color));
        scene.add(helper);
        overlayHelpers.push(helper);
      }
      invalidate();
    };

    // Apply any overlays that were already set before scene init (e.g. selection exists at world-load).
    setOverlays(overlays3dRef.current);

    sceneApi.current = { scene, camera, reloadChunk, reloadAllChunks, resetCamera, teleport, setOverlays };

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(sweepInterval);
      controls.removeEventListener("change", invalidate);
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
      window.removeEventListener("blur", onBlur);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      for (const k of [...meshes.keys()]) disposeMesh(k);
      clearOverlays();
      mat.dispose();
      if (texMatRef.current) { texMatRef.current.dispose(); texMatRef.current = null; }
      if (atlasTexRef.current) { atlasTexRef.current.dispose(); atlasTexRef.current = null; }
      controls.dispose();
      // dispose() only — do NOT forceContextLoss() here. The renderer binds to the fixed <canvas>
      // ref, and a canvas can own just one WebGL context for its lifetime. Losing it would leave a
      // dead context that the next init on the same canvas (React StrictMode's double-mount, HMR)
      // would reuse — `new WebGLRenderer` then crashes in getShaderPrecisionFormat. dispose() frees
      // GPU resources while leaving the context healthy for reuse. (Mirrors ThreeDPreview.)
      renderer.dispose();
      scene.clear();
      sceneApi.current = null;
    };
    } catch (e) {
      // Init failed after the context was created — free GPU resources before rethrowing. dispose()
      // only (not forceContextLoss): the context stays bound to the fixed canvas and is reused by
      // the next mount/retry on that same canvas.
      try { renderer.dispose(); } catch { /* ignore */ }
      sceneApi.current = null;
      throw e;
    }
  // Re-init only when world dimensions change (new world loaded).
  }, [mapW, mapH, maxZ, world.width_chunks, world.height_chunks]);

  // Overlay sync: push updated wireframe boxes to the scene.
  useEffect(() => {
    sceneApi.current?.setOverlays(overlays3d ?? null);
  }, [overlays3d]);

  // Re-centre over the spawn target when it changes. The init effect only re-runs on world-size
  // change, so a new world of identical dimensions would otherwise keep the old viewpoint.
  useEffect(() => {
    sceneApi.current?.resetCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawnAt?.x, spawnAt?.y]);

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

  // Texture pack sync: rebuild the DataTexture + material when the pack changes.
  useEffect(() => {
    if (atlasTexRef.current) { atlasTexRef.current.dispose(); atlasTexRef.current = null; }
    if (texMatRef.current) { texMatRef.current.dispose(); texMatRef.current = null; }
    if (texturePack) {
      const { rgba, tile, rows } = texturePack;
      const tex = new THREE.DataTexture(
        new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        tile, tile * rows,
        THREE.RGBAFormat,
      );
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.flipY = false;
      tex.needsUpdate = true;
      atlasTexRef.current = tex;
      texMatRef.current = new THREE.MeshBasicMaterial({
        map: tex, vertexColors: true, side: THREE.DoubleSide,
      });
    }
  }, [texturePack]);

  // Reload all chunk meshes when the texture epoch changes (pack loaded / unloaded / toggled).
  useEffect(() => {
    sceneApi.current?.reloadAllChunks();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texEpoch]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#0a0f1e" }}>
      {/* Mode hint — pill badge style (A5) */}
      <div style={{
        position: "absolute", top: 6, left: 6, zIndex: 1, pointerEvents: "none",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        <span style={{
          padding: "2px 7px", borderRadius: 10, fontSize: 10, fontWeight: 600, letterSpacing: "0.05em",
          background: flyMode ? "rgba(52,211,153,0.18)" : "rgba(100,116,139,0.18)",
          border: `1px solid ${flyMode ? "rgba(52,211,153,0.45)" : "rgba(100,116,139,0.35)"}`,
          color: flyMode ? "#34d399" : "#94a3b8",
        }}>
          {flyMode ? "FLY" : "3D"}
        </span>
        {flyMode ? (
          <span style={{ fontSize: 9, color: "#6ee7b7", pointerEvents: "none", lineHeight: 1.6 }}>
            WASD move · Space/E up · Ctrl/Q down · Shift boost<br />
            drag look · scroll speed · Z or Esc exit
          </span>
        ) : (
          <span style={{ fontSize: 9, color: "#475569", pointerEvents: "none" }}>
            drag to orbit · scroll zoom · Z to fly
          </span>
        )}
        {/* Speed indicator (A6) */}
        {flyMode && (
          <span style={{
            padding: "1px 5px", borderRadius: 4, fontSize: 9, fontWeight: 700,
            background: "rgba(52,211,153,0.12)", border: "1px solid rgba(52,211,153,0.3)",
            color: "#34d399",
          }}>
            {flySpeed.toFixed(1)}×
          </span>
        )}
        {loadingCount > 0 && (
          <span style={{
            padding: "1px 5px", borderRadius: 4, fontSize: 9,
            background: "rgba(100,116,139,0.12)", border: "1px solid rgba(100,116,139,0.25)",
            color: "#64748b",
          }}>
            loading {loadingCount}…
          </span>
        )}
      </div>
      {/* Camera reset button (A4) */}
      <div style={{ position: "absolute", top: 6, right: 6, zIndex: 1, display: "flex", alignItems: "center", gap: 6 }}>
        {/* Render distance slider */}
        <div style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "2px 6px", borderRadius: 4,
          background: "rgba(30,41,59,0.8)", border: "1px solid #334155",
        }}>
          <span style={{ fontSize: 9, color: "#64748b", userSelect: "none" }}>R</span>
          <input
            type="range" min={2} max={15} step={1} value={loadRadius}
            onChange={e => {
              const v = Number(e.target.value);
              loadRadiusRef.current = v;
              setLoadRadius(v);
            }}
            title={`Render distance: ${loadRadius} chunks`}
            style={{ width: 60, cursor: "pointer", accentColor: "#64748b" }}
          />
          <span style={{ fontSize: 9, color: "#94a3b8", minWidth: 14, textAlign: "right", userSelect: "none" }}>{loadRadius}</span>
        </div>
        <button
          onClick={() => sceneApi.current?.resetCamera()}
          title="Reset camera to world overview"
          style={{
            padding: "2px 7px", fontSize: 10, cursor: "pointer", borderRadius: 4,
            background: "rgba(30,41,59,0.8)", border: "1px solid #334155",
            color: "#94a3b8",
          }}
        >⌂ Reset</button>
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
});

export default FlyView3D;
