import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SelectionInfo } from "./App";

interface ObjGeometryResult {
  positions: string; // base64 LE f32
  colors: string;    // base64 LE f32
  vertex_count: number;
}

function decodeF32Array(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

const W = 190, H = 160;

export default function ThreeDPreview({ selection: sel }: { selection: SelectionInfo }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const threeRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    raf: number;
    mesh: THREE.Mesh | null;
  } | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);

  const vol = sel.width * sel.height * sel.depth;
  const tooBig = vol > 64 * 64 * 64;

  // Init Three.js once on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(W, H);
    renderer.setClearColor(0x080f1e);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 10000);
    camera.position.set(20, 20, 30);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    threeRef.current = { renderer, scene, camera, controls, raf, mesh: null };
    return () => {
      cancelAnimationFrame(raf);
      controls.dispose();
      renderer.dispose();
      threeRef.current = null;
    };
  }, []);

  // Clear mesh when selection changes
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    if (t.mesh) { t.scene.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
    setRendered(false);
    setError(null);
  }, [sel.x1, sel.y1, sel.x2, sel.y2, sel.z_min, sel.z_max]);

  async function handleRender() {
    if (tooBig || !threeRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<ObjGeometryResult>("get_obj_geometry", {
        x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2,
        zMin: sel.z_min, zMax: sel.z_max,
      });
      const t = threeRef.current;
      if (!t) return;

      if (t.mesh) { t.scene.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }

      const positions = decodeF32Array(result.positions);
      const colors = decodeF32Array(result.colors);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      t.scene.add(mesh);
      t.mesh = mesh;

      // Fit camera to bounding box
      geo.computeBoundingBox();
      const box = geo.boundingBox!;
      const center = new THREE.Vector3();
      box.getCenter(center);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      t.controls.target.copy(center);
      t.camera.position.set(
        center.x + maxDim * 1.2,
        center.y + maxDim * 0.8,
        center.z + maxDim * 1.2,
      );
      t.controls.update();

      setRendered(true);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {tooBig ? (
        <div style={{ color: "#f87171", fontSize: 10 }}>
          Selection too large — max 64×64×64 for 3D preview
        </div>
      ) : (
        <button
          disabled={loading}
          onClick={handleRender}
          style={{
            padding: "3px 0", fontSize: 11, cursor: loading ? "default" : "pointer",
            background: rendered ? "rgba(244,114,182,0.2)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${rendered ? "#f472b6" : "#334155"}`,
            color: rendered ? "#f9a8d4" : "#64748b",
            borderRadius: 3, fontWeight: 600,
          }}
        >
          {loading ? "Rendering…" : rendered ? "Re-render 3D" : "Render 3D"}
        </button>
      )}
      {error && <div style={{ color: "#f87171", fontSize: 10, wordBreak: "break-word" }}>{error}</div>}
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{
          display: "block", width: W, height: H,
          borderRadius: 4, border: "1px solid #1a2744",
          opacity: rendered ? 1 : 0.3,
        }}
        title="Drag to orbit · Scroll to zoom · Right-drag to pan"
      />
      {rendered && (
        <div style={{ color: "#475569", fontSize: 9, textAlign: "center" }}>
          drag orbit · scroll zoom · right-drag pan
        </div>
      )}
    </div>
  );
}
