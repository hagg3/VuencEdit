import { decodeF32 } from "./codec";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SelectionInfo } from "./types";
import type { AtlasData } from "./texturePack";

interface ObjGeometryResult {
  positions: string; // base64 LE f32
  colors: string;    // base64 LE f32
  uvs: string;       // base64 LE f32; empty when no pack
  vertex_count: number;
  // Transparent stream (water/glass/fence/new-flower) — colors are RGBA, not RGB.
  positions_t: string;
  colors_t: string;
  uvs_t: string;
  vertex_count_t: number;
}

const W = 190, H = 160;

export default function ThreeDPreview({ selection: sel, texturePack = null, texEpoch = 0 }: {
  selection: SelectionInfo;
  texturePack?: AtlasData | null;
  texEpoch?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const threeRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    raf: number;
    mesh: THREE.Mesh | null;
    meshT: THREE.Mesh | null;
  } | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const atlasTexRef = useRef<THREE.DataTexture | null>(null);
  const texMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  // Textured variant for the transparent stream (water/glass/fence); shares the opaque atlas
  // texture but with `transparent: true` so both the tile's own PNG alpha and the block's
  // per-vertex alpha (transparent_alpha, baked in server-side) composite correctly.
  const texMatTRef = useRef<THREE.MeshBasicMaterial | null>(null);

  const vol = sel.width * sel.height * sel.depth;
  const tooBig = vol > 64 * 64 * 64;

  // The untextured render path creates a one-off material per mesh; dispose it
  // with the geometry. The textured path shares texMatRef/texMatTRef, disposed on pack change.
  function disposeMesh(mesh: THREE.Mesh) {
    mesh.geometry.dispose();
    if (mesh.material !== texMatRef.current && mesh.material !== texMatTRef.current) {
      (mesh.material as THREE.Material).dispose();
    }
  }

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

    threeRef.current = { renderer, scene, camera, controls, raf, mesh: null, meshT: null };
    return () => {
      cancelAnimationFrame(raf);
      controls.dispose();
      if (atlasTexRef.current) { atlasTexRef.current.dispose(); atlasTexRef.current = null; }
      if (texMatRef.current) { texMatRef.current.dispose(); texMatRef.current = null; }
      if (texMatTRef.current) { texMatTRef.current.dispose(); texMatTRef.current = null; }
      renderer.dispose();
      threeRef.current = null;
    };
  }, []);

  // Clear mesh when selection or texture pack changes (user must re-render).
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    if (t.mesh) { t.scene.remove(t.mesh); disposeMesh(t.mesh); t.mesh = null; }
    if (t.meshT) { t.scene.remove(t.meshT); disposeMesh(t.meshT); t.meshT = null; }
    setRendered(false);
    setError(null);
  }, [sel.x1, sel.y1, sel.x2, sel.y2, sel.z_min, sel.z_max, texEpoch]);

  // Rebuild atlas texture when pack changes.
  useEffect(() => {
    if (atlasTexRef.current) { atlasTexRef.current.dispose(); atlasTexRef.current = null; }
    if (texMatRef.current) { texMatRef.current.dispose(); texMatRef.current = null; }
    if (texMatTRef.current) { texMatTRef.current.dispose(); texMatTRef.current = null; }
    if (texturePack) {
      const { rgba, tile, rows } = texturePack;
      const tex = new THREE.DataTexture(
        new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        tile, tile * rows, THREE.RGBAFormat,
      );
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.flipY = false;
      tex.needsUpdate = true;
      atlasTexRef.current = tex;
      texMatRef.current = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, side: THREE.DoubleSide });
      texMatTRef.current = new THREE.MeshBasicMaterial({
        map: tex, vertexColors: true, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      });
    }
  }, [texturePack]);

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

      if (t.mesh) { t.scene.remove(t.mesh); disposeMesh(t.mesh); t.mesh = null; }
      if (t.meshT) { t.scene.remove(t.meshT); disposeMesh(t.meshT); t.meshT = null; }

      // Union bounding box across both streams so the camera fits selections that are entirely
      // (or partly) transparent blocks, e.g. an all-water selection.
      const box = new THREE.Box3();

      if (result.vertex_count > 0) {
        const positions = decodeF32(result.positions);
        const colors = decodeF32(result.colors);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        const hasUVs = result.uvs && result.uvs.length > 0;
        if (hasUVs) geo.setAttribute("uv", new THREE.BufferAttribute(decodeF32(result.uvs), 2));
        const meshMat = (hasUVs && texMatRef.current)
          ? texMatRef.current
          : new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, meshMat);
        t.scene.add(mesh);
        t.mesh = mesh;
        geo.computeBoundingBox();
        box.union(geo.boundingBox!);
      }

      if (result.vertex_count_t > 0) {
        const positionsT = decodeF32(result.positions_t);
        const colorsT = decodeF32(result.colors_t);
        const geoT = new THREE.BufferGeometry();
        geoT.setAttribute("position", new THREE.BufferAttribute(positionsT, 3));
        // RGBA (itemSize 4) — Three.js reads a 4-component color attribute as vertex alpha too.
        geoT.setAttribute("color", new THREE.BufferAttribute(colorsT, 4));
        const hasUVsT = result.uvs_t && result.uvs_t.length > 0;
        if (hasUVsT) geoT.setAttribute("uv", new THREE.BufferAttribute(decodeF32(result.uvs_t), 2));
        const meshMatT = (hasUVsT && texMatTRef.current)
          ? texMatTRef.current
          : new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, depthWrite: false });
        const meshT = new THREE.Mesh(geoT, meshMatT);
        t.scene.add(meshT);
        t.meshT = meshT;
        geoT.computeBoundingBox();
        box.union(geoT.boundingBox!);
      }

      // Fit camera to the combined bounding box
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
            border: `1px solid ${rendered ? "#f472b6" : "#4b443d"}`,
            color: rendered ? "#f9a8d4" : "#83786c",
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
          borderRadius: 4, border: "1px solid #342f2a",
          opacity: rendered ? 1 : 0.3,
        }}
        title="Drag to orbit · Scroll to zoom · Right-drag to pan"
      />
      {rendered && (
        <div style={{ color: "#61584f", fontSize: 9, textAlign: "center" }}>
          drag orbit · scroll zoom · right-drag pan
        </div>
      )}
    </div>
  );
}
