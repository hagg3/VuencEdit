import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";

interface GenProgress { phase: string; pct: number; }
interface PreviewRaw { width: number; height: number; pixels: string; }
interface Preview { width: number; height: number; pixels: Uint8Array; }

function decodePixels(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function PreviewCanvas({ preview }: { preview: Preview }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = preview.width; c.height = preview.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(preview.pixels.buffer), preview.width, preview.height), 0, 0);
  }, [preview]);
  const scale = Math.min(360 / preview.width, 220 / preview.height);
  return (
    <canvas ref={ref} style={{
      width: Math.round(preview.width * scale), height: Math.round(preview.height * scale),
      imageRendering: "pixelated", display: "block", margin: "0 auto",
      border: "1px solid #1e293b", borderRadius: 4,
    }} />
  );
}

interface Props {
  onClose: () => void;
  onCreated: (path: string) => void;
}

type TerrainType = "flat" | "natural" | "classic" | "tg2";
type WaterMode   = "none" | "ponds" | "lakes" | "ocean";
type Biome       = "grassland" | "desert" | "snow" | "lava" | "classic";

export default function NewWorldModal({ onClose, onCreated }: Props) {
  // Shared
  const [name,         setName]         = useState("My World");
  const [widthChunks,  setWidthChunks]  = useState(8);
  const [heightChunks, setHeightChunks] = useState(8);
  const [extendedZ,    setExtendedZ]    = useState(false);
  const [terrainType,  setTerrainType]  = useState<TerrainType>("flat");
  const [creating,     setCreating]     = useState(false);
  const [progress,     setProgress]     = useState<GenProgress | null>(null);
  const [error,        setError]        = useState<string | null>(null);
  const [preview,      setPreview]      = useState<Preview | null>(null);
  const [previewing,   setPreviewing]   = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => () => { unlistenRef.current?.(); }, []);

  // Flat
  const [stoneDepth, setStoneDepth] = useState(15);
  const [dirtDepth,  setDirtDepth]  = useState(4);

  // Natural
  const [seed,           setSeed]           = useState(() => Math.floor(Math.random() * 2_000_000) + 1);
  const [baseHeight,     setBaseHeight]     = useState(28);
  const [roughnessLevel, setRoughnessLevel] = useState(2);
  const [erosionLevel,   setErosionLevel]   = useState(1); // 0 none … 3 strong (flattens regions)
  const [terrainScale,   setTerrainScale]   = useState(1); // 0 small … 3 huge
  const [extreme,        setExtreme]        = useState(false); // 256z only: towering peaks
  const [waterMode,      setWaterMode]      = useState<WaterMode>("lakes");
  const [rivers,         setRivers]         = useState(true);
  const [biome,          setBiome]          = useState<Biome>("grassland");
  const [biomeMode,      setBiomeMode]      = useState(0); // 0 single, 1 mixed
  const [biomeScale,     setBiomeScale]     = useState(1); // 0 small … 2 large regions
  const [snowCaps,       setSnowCaps]       = useState(true);
  const [treeDensity,    setTreeDensity]    = useState(2);
  const [caveDensity,    setCaveDensity]    = useState(1);
  const [caveStyle,      setCaveStyle]      = useState(0); // 0 tunnels, 1 classic
  const [caverns,        setCaverns]        = useState(true);
  const [floodCaves,     setFloodCaves]     = useState(false);
  const [oreDensity,     setOreDensity]     = useState(1);
  const [vegetation,     setVegetation]     = useState(1);
  const [structures,     setStructures]     = useState(1);
  const [cloudsEnabled,  setCloudsEnabled]  = useState(true);

  // Classic (legacy procedural)
  const [classicVariance,   setClassicVariance]   = useState(2); // 0 plains … 4 wild
  const [classicBaseHeight, setClassicBaseHeight] = useState(32);
  const [classicCaves,      setClassicCaves]      = useState(true);
  const [classicTallCaves,  setClassicTallCaves]  = useState(false);
  const [classicTrees,      setClassicTrees]      = useState(2); // 0 none … 3 dense
  const [classicFlowers,    setClassicFlowers]    = useState(true);
  const [classicClouds,     setClassicClouds]     = useState(true);

  // Tg2 (Eden 2.0 TerrainGen2 port)
  const [tg2TerrainType, setTg2TerrainType] = useState(7);   // 7 = Mix (default in original)
  const [tg2Seed,        setTg2Seed]        = useState(() => Math.floor(Math.random() * 999_999) + 1);
  const [tg2SizeChunks,  setTg2SizeChunks]  = useState(19);  // ≈300 blocks, TG2 canonical size
  const [tg2SkyIslands,  setTg2SkyIslands]  = useState(false);
  const [tg2StructFreq,  setTg2StructFreq]  = useState(1);   // 0 sparse 1 normal 2 dense
  const [tg2Clouds,      setTg2Clouds]      = useState(false);
  const [tg2Amplitude,   setTg2Amplitude]   = useState(1);   // relief multiplier 0.5–3×
  const [tg2SeaLevel,    setTg2SeaLevel]    = useState(0);   // additive sea-level offset (blocks)
  const [tg2Blend,       setTg2Blend]       = useState(true); // soften zone seams (warped, palette-aware)
  const [tg2Caves,       setTg2Caves]       = useState(false);
  const [tg2TallCaves,   setTg2TallCaves]   = useState(false);
  const [tg2CustomBiomes, setTg2CustomBiomes] = useState<[number,number,number,number]>([0,6,4,2]); // NW/NE/SW/SE
  const [tg2Preview,     setTg2Preview]     = useState<Preview | null>(null);
  const [tg2Previewing,  setTg2Previewing]  = useState(false);

  // Drop a stale preview whenever a surface-affecting parameter changes.
  useEffect(() => { setPreview(null); }, [
    seed, baseHeight, roughnessLevel, erosionLevel, terrainScale, extreme,
    waterMode, rivers, biome, biomeMode, biomeScale, snowCaps,
    widthChunks, heightChunks, extendedZ,
  ]);

  useEffect(() => { setTg2Preview(null); }, [
    tg2Seed, tg2TerrainType, tg2SizeChunks, tg2CustomBiomes,
    tg2Amplitude, tg2SeaLevel, extendedZ,
  ]);

  const maxZ     = extendedZ ? 255 : 63;
  const surfaceZ = 1 + stoneDepth + dirtDepth;
  const buildLayers = maxZ - surfaceZ;
  const nChunks     = widthChunks * heightChunks;
  const chunkSize   = extendedZ ? 131_072 : 32_768;
  const fileSizeMBNum = (192 + chunkSize * nChunks + 16 * nChunks) / (1024 * 1024);
  const fileSizeMB  = fileSizeMBNum.toFixed(1);
  // Generation holds every chunk in RAM at once, so large worlds are slow and
  // memory-hungry. Warn progressively as the estimated size climbs.
  const sizeWarning: "none" | "caution" | "heavy" =
    fileSizeMBNum >= 1024 ? "heavy" : fileSizeMBNum >= 256 ? "caution" : "none";

  const tg2ChunkSize   = extendedZ ? 131_072 : 32_768;
  const tg2NChunks     = tg2SizeChunks * tg2SizeChunks;
  const tg2FileSizeMBNum = (192 + tg2ChunkSize * tg2NChunks + 16 * tg2NChunks) / (1024 * 1024);
  const tg2FileSizeMB  = tg2FileSizeMBNum.toFixed(1);
  const tg2SizeWarning: "none" | "caution" | "heavy" =
    tg2FileSizeMBNum >= 1024 ? "heavy" : tg2FileSizeMBNum >= 256 ? "caution" : "none";

  const flatValid    = surfaceZ <= maxZ && name.trim().length > 0;
  const otherValid   = name.trim().length > 0;
  const valid        = terrainType === "flat" ? flatValid : otherValid;

  function handleFormatChange(extended: boolean) {
    setExtendedZ(extended);
    if (extended) {
      // Lift the classic baseline toward the middle of the taller world.
      setClassicBaseHeight(h => (h <= 55 ? 128 : h));
    } else {
      // Clamp every height-sensitive control back into the 64z range.
      setStoneDepth(s => Math.min(s, 40));
      setDirtDepth(d  => Math.min(d, 20));
      setBaseHeight(h => Math.min(h, 55));
      setClassicBaseHeight(h => Math.min(h, 55));
      setExtreme(false); // extreme peaks are a 256z-only feature
    }
  }

  function randomiseSeed() {
    setSeed(Math.floor(Math.random() * 2_000_000) + 1);
  }

  async function handleCreate() {
    if (!valid || creating) return;
    const savePath = await save({
      filters: [{ name: "Eden World", extensions: ["eden"] }],
      defaultPath: `${name.trim().replace(/[^\w\s-]/g, "_")}.eden`,
    });
    if (!savePath) return;
    setCreating(true);
    setProgress({ phase: "Starting", pct: 0 });
    setError(null);

    unlistenRef.current?.();
    unlistenRef.current = await listen<GenProgress>("world-gen-progress", e => {
      setProgress(e.payload);
    });

    try {
      if (terrainType === "flat") {
        await invoke("create_world", {
          path: savePath, name: name.trim(),
          widthChunks, heightChunks, extendedZ,
          stoneDepth, dirtDepth,
        });
      } else if (terrainType === "classic") {
        await invoke("create_classic_world", {
          path: savePath, name: name.trim(),
          widthChunks, heightChunks, extendedZ,
          seed,
          varianceLevel: classicVariance,
          baseHeight: classicBaseHeight,
          caves: classicCaves,
          tallCaves: classicTallCaves,
          treeDensity: classicTrees,
          flowers: classicFlowers,
          clouds: classicClouds,
        });
      } else if (terrainType === "tg2") {
        await invoke("create_tg2_world", {
          path: savePath, name: name.trim(),
          sizeChunks: tg2SizeChunks, extendedZ,
          seed: tg2Seed, terrainType: tg2TerrainType,
          skyIslands: tg2SkyIslands, structFreq: tg2StructFreq, clouds: tg2Clouds,
          amplitude: tg2Amplitude, seaLevelOff: tg2SeaLevel, blend: tg2Blend,
          caves: tg2Caves, tallCaves: tg2TallCaves,
          customBiomes: tg2TerrainType === 9 ? [...tg2CustomBiomes] : null,
        });
      } else {
        await invoke("create_natural_world", {
          path: savePath, name: name.trim(),
          widthChunks, heightChunks, extendedZ,
          seed, baseHeight, roughnessLevel, erosionLevel,
          terrainScaleLevel: terrainScale,
          extreme: extendedZ && extreme,
          waterMode, rivers,
          biome, biomeMode, biomeScaleLevel: biomeScale, snowCaps,
          treeDensity, caveDensity, caveStyle, caverns, floodCaves,
          oreDensity, vegetation, structures,
          clouds: cloudsEnabled,
        });
      }
      onCreated(savePath);
    } catch (e) {
      setError(String(e));
      setCreating(false);
      setProgress(null);
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }

  async function previewNatural() {
    if (previewing) return;
    setPreviewing(true);
    setError(null);
    try {
      const raw = await invoke<PreviewRaw>("preview_natural_world", {
        widthChunks, heightChunks, extendedZ,
        seed, baseHeight, roughnessLevel, erosionLevel,
        terrainScaleLevel: terrainScale,
        extreme: extendedZ && extreme,
        waterMode, rivers,
        biome, biomeMode, biomeScaleLevel: biomeScale, snowCaps,
        treeDensity, caveDensity, caveStyle, caverns, floodCaves,
        oreDensity, vegetation, structures,
        clouds: cloudsEnabled,
        maxPx: 220,
      });
      setPreview({ width: raw.width, height: raw.height, pixels: decodePixels(raw.pixels) });
    } catch (e) {
      setError(String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function previewTg2() {
    if (tg2Previewing) return;
    setTg2Previewing(true);
    setError(null);
    try {
      const raw = await invoke<PreviewRaw>("preview_tg2_world", {
        sizeChunks: tg2SizeChunks, seed: tg2Seed, terrainType: tg2TerrainType, maxPx: 220,
        customBiomes: tg2TerrainType === 9 ? [...tg2CustomBiomes] : null,
        extendedZ, amplitude: tg2Amplitude, seaLevelOff: tg2SeaLevel,
      });
      setTg2Preview({ width: raw.width, height: raw.height, pixels: decodePixels(raw.pixels) });
    } catch (e) {
      setError(String(e));
    } finally {
      setTg2Previewing(false);
    }
  }

  // ── styles ──────────────────────────────────────────────────────────────────
  const label: React.CSSProperties   = { color: "#64748b", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 5 };
  const inp: React.CSSProperties     = { background: "#1e293b", border: "1px solid #334155", borderRadius: 6, color: "#e2e8f0", padding: "7px 10px", fontSize: 14, width: "100%", boxSizing: "border-box" };
  const btnBase: React.CSSProperties = { border: "1px solid #334155", borderRadius: 6, padding: "6px 14px", fontSize: 13, cursor: "pointer" };

  function fmtBtn(active: boolean): React.CSSProperties {
    return active
      ? { ...btnBase, flex: 1, background: "rgba(59,130,246,0.2)", borderColor: "#3b82f6", color: "#93c5fd" }
      : { ...btnBase, flex: 1, background: "transparent", color: "#64748b" };
  }
  function typeBtn(active: boolean): React.CSSProperties {
    return active
      ? { ...btnBase, flex: 1, background: "rgba(34,197,94,0.15)", borderColor: "#22c55e", color: "#86efac" }
      : { ...btnBase, flex: 1, background: "transparent", color: "#64748b" };
  }
  function optBtn(active: boolean, accent = "#6366f1"): React.CSSProperties {
    return active
      ? { ...btnBase, flex: 1, background: `${accent}26`, borderColor: accent, color: "#e2e8f0", fontSize: 12 }
      : { ...btnBase, flex: 1, background: "transparent", color: "#64748b", fontSize: 12 };
  }

  // Layer preview bar
  const total  = surfaceZ + 1 + Math.max(1, buildLayers);
  const pBed   = (1          / total * 100).toFixed(1);
  const pStone = (stoneDepth / total * 100).toFixed(1);
  const pDirt  = (dirtDepth  / total * 100).toFixed(1);
  const pGrass = (1          / total * 100).toFixed(1);
  const pBuild = (Math.max(1, buildLayers) / total * 100).toFixed(1);

  const roughnessLabels = ["Plains", "Rolling", "Hilly", "Rugged", "Jagged"];
  const erosionLabels   = ["None", "Light", "Medium", "Strong"];
  const scaleLabels     = ["Small", "Medium", "Large", "Huge"];
  const biomeColors: Record<Biome, string> = {
    grassland: "#22c55e", desert: "#f59e0b", snow: "#93c5fd", lava: "#ef4444", classic: "#a8a29e",
  };
  const biomeLabels: Record<Biome, string> = {
    grassland: "Grassland", desert: "Desert", snow: "Snow", lava: "Lava", classic: "Classic+",
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 400 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "#0d1829", border: "1px solid #1e40af", borderRadius: 12,
        padding: "28px 30px", width: 460, maxWidth: "94vw", maxHeight: "90vh",
        overflowY: "auto",
        display: "flex", flexDirection: "column", gap: 18,
        boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#e2e8f0" }}>New World</div>

        {/* Terrain type tabs */}
        <div>
          <div style={label}>TERRAIN TYPE</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={typeBtn(terrainType === "flat")}    onClick={() => setTerrainType("flat")}>Flat</button>
            <button style={{ ...typeBtn(terrainType === "natural"), display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5 }} onClick={() => setTerrainType("natural")}>
              Natural
              <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>exp</span>
            </button>
            <button style={typeBtn(terrainType === "classic")} onClick={() => setTerrainType("classic")}>
              Classic
            </button>
            <button style={{ ...typeBtn(terrainType === "tg2"), display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5 }} onClick={() => setTerrainType("tg2")}>
              Tg2
              <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>exp</span>
            </button>
          </div>
        </div>

        {/* Name */}
        <div>
          <div style={label}>WORLD NAME</div>
          <input style={inp} value={name} onChange={e => setName(e.target.value)} maxLength={35} placeholder="My World" />
        </div>

        {/* Dimensions (Tg2 has its own square size slider, so hide these) */}
        {terrainType !== "tg2" && <div>
          <div style={label}>SIZE (CHUNKS · 1 CHUNK = 16 BLOCKS)</div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: "#475569", fontSize: 11, marginBottom: 3 }}>Width</div>
              <input type="number" min={1} max={128} value={widthChunks} style={inp}
                onChange={e => setWidthChunks(Math.max(1, Math.min(128, parseInt(e.target.value) || 1)))} />
            </div>
            <div style={{ color: "#334155", paddingBottom: 8 }}>×</div>
            <div style={{ flex: 1 }}>
              <div style={{ color: "#475569", fontSize: 11, marginBottom: 3 }}>Height</div>
              <input type="number" min={1} max={128} value={heightChunks} style={inp}
                onChange={e => setHeightChunks(Math.max(1, Math.min(128, parseInt(e.target.value) || 1)))} />
            </div>
            <div style={{ color: "#475569", fontSize: 12, paddingBottom: 10, whiteSpace: "nowrap" }}>
              = {widthChunks * 16}×{heightChunks * 16}
            </div>
          </div>
        </div>}

        {/* Format */}
        <div>
          <div style={label}>HEIGHT FORMAT</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={fmtBtn(!extendedZ)} onClick={() => handleFormatChange(false)}>Legacy 64z</button>
            <button style={fmtBtn(extendedZ)}  onClick={() => handleFormatChange(true)}>New Dawn 256z</button>
          </div>
        </div>

        {/* 64z compatibility notice */}
        {!extendedZ && (
          <div style={{
            background: "rgba(59,130,246,0.07)", border: "1px solid rgba(59,130,246,0.25)",
            borderRadius: 6, padding: "8px 12px", fontSize: 11.5, color: "#93c5fd", lineHeight: 1.5,
          }}>
            64z worlds are compatible with the latest version of Eden. They will be converted on first launch to support the new height limit.
          </div>
        )}

        {/* ── FLAT options ── */}
        {terrainType === "flat" && (
          <div>
            <div style={label}>LAYER DEPTHS (BLOCKS)</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ color: "#94a3b8", fontSize: 13 }}>Stone</span>
                  <span style={{ color: "#e2e8f0", fontSize: 13 }}>{stoneDepth}</span>
                </div>
                <input type="range" min={0} max={extendedZ ? 100 : 40} value={stoneDepth}
                  onChange={e => setStoneDepth(+e.target.value)}
                  style={{ width: "100%", accentColor: "#6b7280" }} />
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ color: "#a16207", fontSize: 13 }}>Dirt</span>
                  <span style={{ color: "#e2e8f0", fontSize: 13 }}>{dirtDepth}</span>
                </div>
                <input type="range" min={0} max={extendedZ ? 60 : 20} value={dirtDepth}
                  onChange={e => setDirtDepth(+e.target.value)}
                  style={{ width: "100%", accentColor: "#92400e" }} />
              </div>
              <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden", gap: 1, marginTop: 2 }}>
                <div style={{ width: `${pBed}%`,   background: "#475569" }} title="Bedrock" />
                {stoneDepth > 0 && <div style={{ width: `${pStone}%`, background: "#6b7280" }} title="Stone" />}
                {dirtDepth  > 0 && <div style={{ width: `${pDirt}%`,  background: "#92400e" }} title="Dirt" />}
                <div style={{ width: `${pGrass}%`, background: "#16a34a" }} title="Grass" />
                <div style={{ width: `${pBuild}%`, background: "rgba(255,255,255,0.06)" }} title="Build space" />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                <span style={{ color: "#475569" }}>z=0 Bedrock</span>
                <span style={{ color: flatValid ? "#22c55e" : "#f87171" }}>
                  {flatValid
                    ? `Surface z=${surfaceZ} · ${buildLayers} build layer${buildLayers !== 1 ? "s" : ""}`
                    : `Too deep — surface z=${surfaceZ} exceeds max ${maxZ}`}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ── NATURAL options ── */}
        {terrainType === "natural" && (<>

          {/* Seed */}
          <div>
            <div style={label}>SEED</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input type="number" min={1} value={seed} style={{ ...inp, flex: 1 }}
                onChange={e => setSeed(Math.max(1, parseInt(e.target.value) || 1))} />
              <button onClick={randomiseSeed} style={{ ...btnBase, background: "rgba(99,102,241,0.2)", borderColor: "#6366f1", color: "#a5b4fc", whiteSpace: "nowrap" }}>
                🎲 Random
              </button>
            </div>
          </div>

          {/* Base height */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={label}>BASE HEIGHT</span>
              <span style={{ color: "#e2e8f0", fontSize: 13 }}>z={baseHeight}</span>
            </div>
            <input type="range" min={5} max={extendedZ ? 200 : 55} value={baseHeight}
              onChange={e => setBaseHeight(+e.target.value)}
              style={{ width: "100%", accentColor: "#22c55e" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#475569", marginTop: 2 }}>
              <span>Low</span><span>High</span>
            </div>
          </div>

          {/* Roughness */}
          <div>
            <div style={label}>TERRAIN ROUGHNESS</div>
            <div style={{ display: "flex", gap: 4 }}>
              {roughnessLabels.map((lbl, i) => (
                <button key={i} style={optBtn(roughnessLevel === i, "#6366f1")}
                  onClick={() => setRoughnessLevel(i)}>{lbl}</button>
              ))}
            </div>
          </div>

          {/* Erosion (flatness) */}
          <div>
            <div style={label}>EROSION</div>
            <div style={{ display: "flex", gap: 4 }}>
              {erosionLabels.map((lbl, i) => (
                <button key={i} style={optBtn(erosionLevel === i, "#6366f1")}
                  onClick={() => setErosionLevel(i)}>{lbl}</button>
              ))}
            </div>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
              Higher = broad flat plains carved between rugged highlands (relief varies by region).
            </div>
          </div>

          {/* Terrain scale (feature size) */}
          <div>
            <div style={label}>FEATURE SCALE</div>
            <div style={{ display: "flex", gap: 4 }}>
              {scaleLabels.map((lbl, i) => (
                <button key={i} style={optBtn(terrainScale === i, "#8b5cf6")}
                  onClick={() => setTerrainScale(i)}>{lbl}</button>
              ))}
            </div>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
              Larger = broader continents &amp; mountain ranges.
            </div>
          </div>

          {/* Extreme mountains — 256z only */}
          {extendedZ && (
            <div style={{
              border: "1px solid #312e81", borderRadius: 6, padding: "10px 12px",
              background: "rgba(99,102,241,0.06)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="checkbox" id="extreme" checked={extreme}
                  onChange={e => setExtreme(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: "#8b5cf6", cursor: "pointer" }} />
                <label htmlFor="extreme" style={{ color: "#c4b5fd", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  Extreme mountains
                </label>
                <span style={{ marginLeft: "auto", fontSize: 10, color: "#6366f1", fontWeight: 700, letterSpacing: "0.05em" }}>
                  256z ONLY
                </span>
              </div>
              <div style={{ color: "#64748b", fontSize: 11, marginTop: 6 }}>
                Towering peaks &amp; deep valleys that use the full 256-block height — pairs
                best with high roughness and a higher base height.
              </div>
            </div>
          )}

          {/* Water */}
          <div>
            <div style={label}>WATER</div>
            <div style={{ display: "flex", gap: 4 }}>
              {(["none", "ponds", "lakes", "ocean"] as WaterMode[]).map(m => (
                <button key={m} style={optBtn(waterMode === m, "#0ea5e9")}
                  onClick={() => setWaterMode(m)}>{m.charAt(0).toUpperCase() + m.slice(1)}</button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
              <input type="checkbox" id="rivers" checked={rivers}
                onChange={e => setRivers(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: "#0ea5e9", cursor: "pointer" }} />
              <label htmlFor="rivers" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>
                Carve winding rivers
              </label>
            </div>
          </div>

          {/* Biome */}
          <div>
            <div style={label}>BIOME</div>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {["Single", "Mixed"].map((lbl, i) => (
                <button key={i} style={optBtn(biomeMode === i, "#22c55e")}
                  onClick={() => setBiomeMode(i)}>{lbl}</button>
              ))}
            </div>

            {biomeMode === 0 ? (<>
              <div style={{ display: "flex", gap: 4 }}>
                {(["grassland", "desert", "snow", "lava", "classic"] as Biome[]).map(b => (
                  <button key={b} style={optBtn(biome === b, biomeColors[b])}
                    onClick={() => setBiome(b)}>
                    {biomeLabels[b]}
                  </button>
                ))}
              </div>
              {biome === "classic" && (
                <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
                  Legacy Eden rolling-hill terrain &amp; caves (with bare-stone outcrops),
                  but enhanced with the modern pipeline — rivers, lakes/ocean, structures
                  and natural trees. For the pure legacy generator use the Classic tab.
                </div>
              )}
              {biome === "grassland" && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                  <input type="checkbox" id="snowcaps" checked={snowCaps}
                    onChange={e => setSnowCaps(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: "#93c5fd", cursor: "pointer" }} />
                  <label htmlFor="snowcaps" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>
                    Snow-capped peaks
                  </label>
                </div>
              )}
            </>) : (<>
              <div style={{ color: "#475569", fontSize: 11, marginBottom: 6 }}>BIOME SIZE</div>
              <div style={{ display: "flex", gap: 4 }}>
                {["Small", "Medium", "Large"].map((lbl, i) => (
                  <button key={i} style={optBtn(biomeScale === i, "#22c55e")}
                    onClick={() => setBiomeScale(i)}>{lbl}</button>
                ))}
              </div>
              <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
                Grassland, desert &amp; snow blend by temperature &amp; moisture; high
                ground turns snowy. (Lava &amp; Classic+ are single-biome only.)
              </div>
            </>)}
          </div>

          {/* Trees */}
          <div>
            <div style={label}>TREE DENSITY</div>
            <div style={{ display: "flex", gap: 4 }}>
              {["None", "Sparse", "Normal", "Dense"].map((lbl, i) => (
                <button key={i} style={optBtn(treeDensity === i, "#16a34a")}
                  onClick={() => setTreeDensity(i)}>{lbl}</button>
              ))}
            </div>
          </div>

          {/* Caves */}
          <div>
            <div style={label}>CAVES</div>
            <div style={{ display: "flex", gap: 4 }}>
              {["None", "Rare", "Common"].map((lbl, i) => (
                <button key={i} style={optBtn(caveDensity === i, "#78716c")}
                  onClick={() => setCaveDensity(i)}>{lbl}</button>
              ))}
            </div>
            {caveDensity > 0 && (<>
              <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                {["Tunnels", "Classic"].map((lbl, i) => (
                  <button key={i} style={optBtn(caveStyle === i, "#78716c")}
                    onClick={() => setCaveStyle(i)}>{lbl}</button>
                ))}
              </div>
              <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
                {caveStyle === 0
                  ? "Winding spaghetti tunnels."
                  : "Legacy Eden 3D-noise caverns with dark-stone veins."}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                <input type="checkbox" id="caverns" checked={caverns}
                  onChange={e => setCaverns(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: "#78716c", cursor: "pointer" }} />
                <label htmlFor="caverns" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>
                  Large caverns &amp; deep lava pools
                </label>
              </div>
              {waterMode !== "none" && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                  <input type="checkbox" id="flood-caves" checked={floodCaves}
                    onChange={e => setFloodCaves(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: "#78716c", cursor: "pointer" }} />
                  <label htmlFor="flood-caves" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>
                    Flood caves with water
                  </label>
                </div>
              )}
            </>)}
          </div>

          {/* Minerals / ore */}
          <div>
            <div style={label}>MINERALS</div>
            <div style={{ display: "flex", gap: 4 }}>
              {["None", "Sparse", "Rich"].map((lbl, i) => (
                <button key={i} style={optBtn(oreDensity === i, "#0891b2")}
                  onClick={() => setOreDensity(i)}>{lbl}</button>
              ))}
            </div>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
              Underground veins of dark stone, slate &amp; glowing crystal.
            </div>
          </div>

          {/* Vegetation */}
          <div>
            <div style={label}>VEGETATION</div>
            <div style={{ display: "flex", gap: 4 }}>
              {["None", "Light", "Lush"].map((lbl, i) => (
                <button key={i} style={optBtn(vegetation === i, "#65a30d")}
                  onClick={() => setVegetation(i)}>{lbl}</button>
              ))}
            </div>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
              Flowers, tall grass, boulders &amp; lily pads.
            </div>
          </div>

          {/* Structures */}
          <div>
            <div style={label}>STRUCTURES</div>
            <div style={{ display: "flex", gap: 4 }}>
              {["None", "Sparse", "Common"].map((lbl, i) => (
                <button key={i} style={optBtn(structures === i, "#d97706")}
                  onClick={() => setStructures(i)}>{lbl}</button>
              ))}
            </div>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
              Cabins, wells, watchtowers, ruins &amp; desert pyramids.
            </div>
          </div>

          {/* Clouds */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input type="checkbox" id="clouds" checked={cloudsEnabled}
              onChange={e => setCloudsEnabled(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: "#6366f1", cursor: "pointer" }} />
            <label htmlFor="clouds" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>
              Generate cloud layer
            </label>
          </div>

          {/* Preview */}
          <div>
            <button onClick={previewNatural} disabled={previewing} style={{
              ...btnBase, width: "100%", fontWeight: 600,
              background: previewing ? "rgba(99,102,241,0.25)" : "rgba(99,102,241,0.2)",
              borderColor: "#6366f1", color: "#a5b4fc",
              cursor: previewing ? "wait" : "pointer",
            }}>
              {previewing ? "Rendering preview…" : preview ? "↻ Refresh preview" : "👁 Preview terrain"}
            </button>
            {preview && (
              <div style={{ marginTop: 8 }}>
                <PreviewCanvas preview={preview} />
                <div style={{ color: "#475569", fontSize: 10.5, textAlign: "center", marginTop: 4 }}>
                  Top-down surface preview (heightmap & biomes; trees/structures not shown).
                </div>
              </div>
            )}
          </div>

        </>)}

        {/* ── CLASSIC options ── */}
        {terrainType === "classic" && (<>

          <div style={{
            border: "1px solid #4c1d95", borderRadius: 6, padding: "8px 12px",
            background: "rgba(167,139,250,0.06)", color: "#c4b5fd", fontSize: 11.5, lineHeight: 1.5,
          }}>
            Reproduces the original randomly-generated Eden terrain from the early
            game: rolling Perlin hills, dirt &amp; grass surface, trees and clouds.
          </div>

          {/* Seed */}
          <div>
            <div style={label}>SEED</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input type="number" min={1} value={seed} style={{ ...inp, flex: 1 }}
                onChange={e => setSeed(Math.max(1, parseInt(e.target.value) || 1))} />
              <button onClick={randomiseSeed} style={{ ...btnBase, background: "rgba(167,139,250,0.2)", borderColor: "#a78bfa", color: "#ddd6fe", whiteSpace: "nowrap" }}>
                🎲 Random
              </button>
            </div>
          </div>

          {/* Variance */}
          <div>
            <div style={label}>TERRAIN VARIANCE</div>
            <div style={{ display: "flex", gap: 4 }}>
              {["Plains", "Rolling", "Classic", "Rugged", "Wild"].map((lbl, i) => (
                <button key={i} style={optBtn(classicVariance === i, "#a78bfa")}
                  onClick={() => setClassicVariance(i)}>{lbl}</button>
              ))}
            </div>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
              How dramatic the heightmap relief is (legacy default = Classic).
            </div>
          </div>

          {/* Base height */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={label}>BASE HEIGHT</span>
              <span style={{ color: "#e2e8f0", fontSize: 13 }}>z={classicBaseHeight}</span>
            </div>
            <input type="range" min={5} max={extendedZ ? 200 : 55} value={classicBaseHeight}
              onChange={e => setClassicBaseHeight(+e.target.value)}
              style={{ width: "100%", accentColor: "#a78bfa" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#475569", marginTop: 2 }}>
              <span>Low</span><span>High</span>
            </div>
          </div>

          {/* Caves */}
          <div style={{
            border: "1px solid #3f3f46", borderRadius: 6, padding: "10px 12px",
            background: "rgba(120,113,108,0.06)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input type="checkbox" id="classic-caves" checked={classicCaves}
                onChange={e => setClassicCaves(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: "#a8a29e", cursor: "pointer" }} />
              <label htmlFor="classic-caves" style={{ color: "#d6d3d1", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                Underground caves
              </label>
            </div>
            <div style={{ color: "#64748b", fontSize: 11, marginTop: 6 }}>
              Carves the original 3D-noise cave tunnels (with dark-stone veins) deep
              underground — a feature from the very earliest Eden builds.
            </div>
            {classicCaves && (
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid #292524" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input type="checkbox" id="classic-tallcaves" checked={classicTallCaves}
                    onChange={e => setClassicTallCaves(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: "#a8a29e", cursor: "pointer" }} />
                  <label htmlFor="classic-tallcaves" style={{ color: "#d6d3d1", fontSize: 13, cursor: "pointer" }}>
                    Tall caves
                  </label>
                </div>
                <div style={{ color: "#64748b", fontSize: 11, marginTop: 6 }}>
                  Taller, vertically-stretched versions of the normal stone &amp;
                  dark-stone caves — an even older Eden cave style.
                </div>
              </div>
            )}
          </div>

          {/* Trees */}
          <div>
            <div style={label}>TREE DENSITY</div>
            <div style={{ display: "flex", gap: 4 }}>
              {["None", "Sparse", "Normal", "Dense"].map((lbl, i) => (
                <button key={i} style={optBtn(classicTrees === i, "#16a34a")}
                  onClick={() => setClassicTrees(i)}>{lbl}</button>
              ))}
            </div>
          </div>

          {/* Flowers (sparse) */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input type="checkbox" id="classic-flowers" checked={classicFlowers}
                onChange={e => setClassicFlowers(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: "#ec4899", cursor: "pointer" }} />
              <label htmlFor="classic-flowers" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>
                Scatter flowers (sparse)
              </label>
            </div>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 6 }}>
              Sprinkles a few flowers across the grass. Kept sparse on purpose — the
              game can&apos;t load a world packed with flower sprites.
            </div>
          </div>

          {/* Clouds */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input type="checkbox" id="classic-clouds" checked={classicClouds}
              onChange={e => setClassicClouds(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: "#a78bfa", cursor: "pointer" }} />
            <label htmlFor="classic-clouds" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>
              Generate cloud layer
            </label>
          </div>

        </>)}

        {/* ── TG2 options ── */}
        {terrainType === "tg2" && (<>

          <div style={{
            background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.25)",
            borderRadius: 6, padding: "8px 12px", fontSize: 11.5, color: "#fcd34d", lineHeight: 1.5,
          }}>
            Eden 2.0 pre-generated terrain — nine distinct biome styles with height-based
            paint gradients, pyramids, sky islands, and volcanoes.
          </div>

          {/* Terrain type grid */}
          <div>
            <div style={label}>TERRAIN TYPE</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
              {(["Plains","Mars","River+Forest","Mtn+River","Desert","Ponies","Beach","Mix","Flat","Custom Mix"] as const).map((lbl, i) => (
                <button key={i} style={optBtn(tg2TerrainType === i, "#f59e0b")}
                  onClick={() => setTg2TerrainType(i)}>{lbl}</button>
              ))}
            </div>
          </div>

          {/* Size */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={label}>WORLD SIZE (SQUARE)</span>
              <span style={{ color: "#e2e8f0", fontSize: 13 }}>{tg2SizeChunks}×{tg2SizeChunks} chunks · {tg2SizeChunks * 16}×{tg2SizeChunks * 16} blocks</span>
            </div>
            <input type="range" min={5} max={180} value={tg2SizeChunks}
              onChange={e => setTg2SizeChunks(+e.target.value)}
              style={{ width: "100%", accentColor: "#f59e0b" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#475569", marginTop: 2 }}>
              <span>80</span><span>256</span><span>640</span><span>1280</span><span>2880</span>
            </div>
            <button
              onClick={() => setTg2SizeChunks(180)}
              style={{ ...btnBase, marginTop: 5, fontSize: 11.5, padding: "3px 10px",
                background: tg2SizeChunks === 180 ? "rgba(245,158,11,0.25)" : "rgba(245,158,11,0.08)",
                borderColor: tg2SizeChunks === 180 ? "#f59e0b" : "rgba(245,158,11,0.3)",
                color: tg2SizeChunks === 180 ? "#fcd34d" : "#92400e" }}>
              Default (2880×2880 — canonical Eden template size)
            </button>
          </div>

          {/* Seed */}
          <div>
            <div style={label}>SEED</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input type="number" min={1} value={tg2Seed} style={{ ...inp, flex: 1 }}
                onChange={e => setTg2Seed(Math.max(1, parseInt(e.target.value) || 1))} />
              <button onClick={() => setTg2Seed(Math.floor(Math.random() * 999_999) + 1)}
                style={{ ...btnBase, background: "rgba(245,158,11,0.2)", borderColor: "#f59e0b", color: "#fcd34d", whiteSpace: "nowrap" }}>
                🎲 Random
              </button>
            </div>
          </div>

          {/* Custom Mix quadrant selector */}
          {tg2TerrainType === 9 && (() => {
            const biomeNames = ["Plains","Mars","River+Forest","Mtn+River","Desert","Ponies","Beach"];
            const quadLabels = ["NW","NE","SW","SE"];
            return (
              <div style={{ border: "1px solid rgba(245,158,11,0.3)", borderRadius: 6, padding: "10px 12px", background: "rgba(245,158,11,0.06)" }}>
                <div style={{ ...label, marginBottom: 8 }}>QUADRANT BIOMES</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {quadLabels.map((ql, qi) => (
                    <div key={qi} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>{ql}</span>
                      <select value={tg2CustomBiomes[qi]}
                        onChange={e => {
                          const next = [...tg2CustomBiomes] as [number,number,number,number];
                          next[qi] = +e.target.value;
                          setTg2CustomBiomes(next);
                        }}
                        style={{ background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, padding: "4px 6px", fontSize: 12, cursor: "pointer" }}>
                        {biomeNames.map((bn, bi) => (
                          <option key={bi} value={bi}>{bn}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Options */}
          <div>
            <div style={label}>OPTIONS</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" id="tg2-sky" checked={tg2SkyIslands}
                  onChange={e => setTg2SkyIslands(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: "#f59e0b", cursor: "pointer" }} />
                <label htmlFor="tg2-sky" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>Sky islands</label>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" id="tg2-clouds" checked={tg2Clouds}
                  onChange={e => setTg2Clouds(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: "#f59e0b", cursor: "pointer" }} />
                <label htmlFor="tg2-clouds" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>Clouds</label>
              </div>
              {tg2TerrainType !== 8 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" id="tg2-caves" checked={tg2Caves}
                    onChange={e => { setTg2Caves(e.target.checked); if (!e.target.checked) setTg2TallCaves(false); }}
                    style={{ width: 16, height: 16, accentColor: "#f59e0b", cursor: "pointer" }} />
                  <label htmlFor="tg2-caves" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>Caves</label>
                </div>
              )}
              {tg2Caves && tg2TerrainType !== 8 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" id="tg2-tallcaves" checked={tg2TallCaves}
                    onChange={e => setTg2TallCaves(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: "#f59e0b", cursor: "pointer" }} />
                  <label htmlFor="tg2-tallcaves" style={{ color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>Tall caves</label>
                </div>
              )}
            </div>
          </div>

          {/* Terrain amplitude (all but Flat) */}
          {tg2TerrainType !== 8 && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ ...label, display: "flex", alignItems: "center", gap: 6 }}>
                  TERRAIN AMPLITUDE
                  <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>Exp</span>
                </span>
                <span style={{ color: "#e2e8f0", fontSize: 13 }}>{tg2Amplitude.toFixed(1)}×</span>
              </div>
              <input type="range" min={0.5} max={3} step={0.1} value={tg2Amplitude}
                onChange={e => setTg2Amplitude(+e.target.value)}
                style={{ width: "100%", accentColor: "#f59e0b" }} />
              <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
                Exaggerates hills &amp; mountains. {extendedZ
                  ? "New Dawn 256z worlds also scale up to fill the taller space automatically."
                  : "Switch to New Dawn 256z to let terrain fill the full height."}
              </div>
            </div>
          )}

          {/* Sea level (water biomes) */}
          {(tg2TerrainType === 2 || tg2TerrainType === 3 || tg2TerrainType === 4 || tg2TerrainType === 6 || tg2TerrainType === 7 || tg2TerrainType === 9) && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={label}>SEA LEVEL</span>
                <span style={{ color: "#e2e8f0", fontSize: 13 }}>{tg2SeaLevel > 0 ? `+${tg2SeaLevel}` : tg2SeaLevel}</span>
              </div>
              <input type="range" min={-12} max={24} value={tg2SeaLevel}
                onChange={e => setTg2SeaLevel(+e.target.value)}
                style={{ width: "100%", accentColor: "#0ea5e9" }} />
              <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
                Raises or lowers oceans, rivers &amp; lakes (more or less flooding).
              </div>
            </div>
          )}

          {/* Biome blend (multi-zone types) */}
          {(tg2TerrainType === 3 || tg2TerrainType === 7 || tg2TerrainType === 9) && (
            <div style={{
              border: "1px solid rgba(245,158,11,0.3)", borderRadius: 6, padding: "10px 12px",
              background: "rgba(245,158,11,0.06)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="checkbox" id="tg2-blend" checked={tg2Blend}
                  onChange={e => setTg2Blend(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: "#f59e0b", cursor: "pointer" }} />
                <label htmlFor="tg2-blend" style={{ color: "#fcd34d", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  Blend biome seams
                </label>
                <span style={{ marginLeft: "auto", fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>exp</span>
              </div>
              <div style={{ color: "#64748b", fontSize: 11, marginTop: 6 }}>
                Builds gentle talus slopes between zones so they meet naturally
                instead of with hard cliffs at the borders.
              </div>
            </div>
          )}

          {/* Structure frequency (Desert/Mix/Custom Mix) */}
          {(tg2TerrainType === 4 || tg2TerrainType === 7 || tg2TerrainType === 9) && (
            <div>
              <div style={label}>STRUCTURE DENSITY</div>
              <div style={{ display: "flex", gap: 4 }}>
                {["Sparse", "Normal", "Dense"].map((lbl, i) => (
                  <button key={i} style={optBtn(tg2StructFreq === i, "#f59e0b")}
                    onClick={() => setTg2StructFreq(i)}>{lbl}</button>
                ))}
              </div>
              <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
                Controls pyramid and volcano frequency.
              </div>
            </div>
          )}

          {/* Preview */}
          <div>
            <button onClick={previewTg2} disabled={tg2Previewing}
              style={{ ...btnBase, background: "rgba(245,158,11,0.15)", borderColor: "#f59e0b", color: "#fcd34d", width: "100%", marginBottom: 8 }}>
              {tg2Previewing ? "Generating preview…" : "Preview Terrain"}
            </button>
            {tg2Preview && (
              <div>
                <PreviewCanvas preview={tg2Preview} />
                <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
                  Top-down heightmap (reflects amplitude, sea level &amp; height format; structures, trees &amp; blend not shown).
                </div>
              </div>
            )}
          </div>

          {/* File size */}
          <div style={{
            background: "rgba(255,255,255,0.03)", border: "1px solid #1e293b",
            borderRadius: 6, padding: "7px 12px", fontSize: 12, color: "#64748b",
            display: "flex", justifyContent: "space-between",
          }}>
            <span>{tg2NChunks} chunks · {tg2SizeChunks * 16}×{tg2SizeChunks * 16} blocks</span>
            <span>~{tg2FileSizeMB} MB</span>
          </div>

          {tg2SizeWarning !== "none" && (
            <div style={{
              background: tg2SizeWarning === "heavy" ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
              border: `1px solid ${tg2SizeWarning === "heavy" ? "rgba(239,68,68,0.35)" : "rgba(245,158,11,0.3)"}`,
              borderRadius: 6, padding: "8px 12px", fontSize: 11.5,
              color: tg2SizeWarning === "heavy" ? "#fca5a5" : "#fbbf24", lineHeight: 1.5,
            }}>
              {tg2SizeWarning === "heavy"
                ? `Very large world (~${tg2FileSizeMB} MB). Consider a smaller size.`
                : `Large world (~${tg2FileSizeMB} MB) — generation may take several seconds.`}
            </div>
          )}

        </>)}

        {/* Info row (hidden for Tg2 — it shows its own) */}
        {terrainType !== "tg2" && <div style={{
          background: "rgba(255,255,255,0.03)", border: "1px solid #1e293b",
          borderRadius: 6, padding: "7px 12px", fontSize: 12, color: "#64748b",
          display: "flex", justifyContent: "space-between",
        }}>
          <span>{nChunks} chunk{nChunks !== 1 ? "s" : ""} · {widthChunks * 16}×{heightChunks * 16} blocks</span>
          <span>~{fileSizeMB} MB</span>
        </div>}

        {terrainType !== "tg2" && sizeWarning !== "none" && (
          <div style={{
            background: sizeWarning === "heavy" ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
            border: `1px solid ${sizeWarning === "heavy" ? "rgba(239,68,68,0.35)" : "rgba(245,158,11,0.3)"}`,
            borderRadius: 6, padding: "8px 12px", fontSize: 11.5,
            color: sizeWarning === "heavy" ? "#fca5a5" : "#fbbf24", lineHeight: 1.5,
          }}>
            {sizeWarning === "heavy"
              ? `Very large world (~${fileSizeMB} MB). Generation needs that much RAM at once and may take a while; the editor can also be slow to open it. Consider a smaller size or the 64z format.`
              : `Large world (~${fileSizeMB} MB) — generation may take several seconds and use significant memory.`}
          </div>
        )}

        {error && <div style={{ color: "#f87171", fontSize: 13 }}>{error}</div>}

        {/* Generation progress */}
        {creating && progress && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ color: "#93c5fd", fontSize: 12, fontWeight: 600 }}>{progress.phase}…</span>
              <span style={{ color: "#64748b", fontSize: 12 }}>{Math.round(progress.pct)}%</span>
            </div>
            <div style={{ height: 8, borderRadius: 4, background: "#1e293b", overflow: "hidden" }}>
              <div style={{
                width: `${Math.max(2, Math.min(100, progress.pct))}%`, height: "100%",
                background: "linear-gradient(90deg,#f59e0b,#fbbf24)", transition: "width 0.15s linear",
              }} />
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ ...btnBase, background: "transparent", color: "#64748b" }}>
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!valid || creating}
            style={{
              ...btnBase, padding: "8px 22px", fontWeight: 600,
              background: valid && !creating ? "rgba(59,130,246,0.85)" : "rgba(59,130,246,0.25)",
              borderColor: "#3b82f6", color: "#fff",
              cursor: valid && !creating ? "pointer" : "not-allowed",
            }}
          >
            {creating ? (progress ? `Creating… ${Math.round(progress.pct)}%` : "Creating…") : "Create World…"}
          </button>
        </div>
      </div>
    </div>
  );
}
