import { decodePreviewData } from "./types";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { MODAL_TEXT, recessedWell, accentRing, expBadge } from "./designTokens";
import { ACCENTS, DANGER_HEX, RAMP, armedRecipe, hexToRgb, mix, rgba } from "./theme/theme";
import { v } from "./theme/cssVars";
import { resolveColor } from "./blockDefs";
import { putPatchPixels } from "./viewportUtils";
import NumberField from "./NumberField";
import { Check, Select, SliderRow } from "./ribbon/primitives";
import Dialog, { DialogButton } from "./ui/Dialog";
import { DialogNav, type DialogNavItem } from "./ui/DialogNav";

interface GenProgress { phase: string; pct: number; }
interface Preview { width: number; height: number; pixels: Uint8Array; }

function PreviewCanvas({ preview }: { preview: Preview }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = preview.width; c.height = preview.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    // `preview.pixels` is a *view* over the shared IPC envelope buffer (decodePreviewData/
    // decodeEnvelope) — its `.buffer` is the whole response (length prefix + JSON header +
    // body), not just this slice. Constructing `ImageData` straight from that raw `.buffer`
    // (the pre-existing bug here) makes the data length ≠ 4×width×height and throws
    // synchronously inside this effect, which the nearest ErrorBoundary catches — the
    // "Preview terrain crashes the UI" report. `putPatchPixels` re-views with the view's own
    // byteOffset/byteLength, same as every other IPC pixel consumer (viewportUtils.ts).
    putPatchPixels(ctx, preview, 0, 0);
  }, [preview]);
  const scale = Math.min(260 / preview.width, 200 / preview.height);
  return (
    <canvas ref={ref} style={{
      width: Math.round(preview.width * scale), height: Math.round(preview.height * scale),
      imageRendering: "pixelated", display: "block", margin: "0 auto",
      border: `1px solid ${RAMP.mbtn1}`, borderRadius: 4,
    }} />
  );
}

// Accent-family text tints for buttons/labels on the warm modal surface (mechanical hex-literal
// migration, Stage 14.15) — armedRecipe's lightened label colour clears AA against both an
// accent-tinted button face *and* the plain modal background used for standalone captions.
const TEAL_TEXT = armedRecipe(ACCENTS.primary).text;
const WARM_TEXT = armedRecipe(ACCENTS.warm).text;
const VIOLET_TEXT = armedRecipe(ACCENTS.violet).text;
const AZURE_TEXT = armedRecipe(ACCENTS.selection).text;
const RED_LIGHT = mix(RAMP.white, DANGER_HEX, 0.5);
/** Neutral (non-accented) toggle group — the Classic tab's cave options are deliberately grey. */
const NEUTRAL_ACCENT = RAMP.mlabel;
/** Real block colours for the Flat-tab layer-depth preview bar — data, not decoration. */
/** A `Check` whose label carries the modal's own type scale (13px, per-site colour/weight). */
function Opt({ checked, onChange, color, bold, children }: {
  checked: boolean; onChange: (v: boolean) => void; color: string; bold?: boolean; children: ReactNode;
}) {
  return (
    <Check checked={checked} onChange={onChange}
      label={<span style={{ color, fontSize: 13, fontWeight: bold ? 600 : undefined }}>{children}</span>} />
  );
}

function blockSwatch(blockType: number): string {
  const [r, g, b] = resolveColor(blockType, 0);
  return `rgb(${r},${g},${b})`;
}

interface Props {
  onClose: () => void;
  onCreated: (path: string) => void;
}

type TerrainType = "flat" | "natural" | "classic" | "tg2";
type WaterMode   = "none" | "ponds" | "lakes" | "ocean";
type Biome       = "grassland" | "desert" | "snow" | "lava" | "classic";

const NAV_ITEMS: DialogNavItem[] = [
  { id: "flat", icon: "block", label: "Flat", description: "Solid stone & dirt slab, no generation" },
  { id: "natural", icon: "trees", label: "Natural", description: "Procedural biomes, rivers, caves & structures (experimental)" },
  { id: "classic", icon: "history", label: "Classic", description: "Original Eden Perlin-hill terrain generator" },
  { id: "tg2", icon: "world", label: "Tg2", description: "Eden 2.0 biome terrain — pyramids, sky islands, volcanoes (experimental)" },
];

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
  const mountedRef = useRef(true);

  useEffect(() => {
    // StrictMode double-invokes this effect on mount (mount→cleanup→mount); the cleanup below
    // must not leave mountedRef stuck at false for the real, still-mounted instance.
    mountedRef.current = true;
    return () => { mountedRef.current = false; unlistenRef.current?.(); };
  }, []);

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
      if (mountedRef.current) onCreated(savePath); // don't open a world into an unmounted modal
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
      const buf = await invoke<ArrayBuffer>("preview_natural_world", {
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
      setPreview(decodePreviewData(buf));
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
      const buf = await invoke<ArrayBuffer>("preview_tg2_world", {
        sizeChunks: tg2SizeChunks, seed: tg2Seed, terrainType: tg2TerrainType, maxPx: 220,
        customBiomes: tg2TerrainType === 9 ? [...tg2CustomBiomes] : null,
        extendedZ, amplitude: tg2Amplitude, seaLevelOff: tg2SeaLevel,
      });
      setTg2Preview(decodePreviewData(buf));
    } catch (e) {
      setError(String(e));
    } finally {
      setTg2Previewing(false);
    }
  }

  // ── styles ──────────────────────────────────────────────────────────────────
  const label: React.CSSProperties   = { color: MODAL_TEXT.label, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 5 };
  const inp: React.CSSProperties     = { ...recessedWell, background: v("surface-modalRaised"), borderRadius: 6, color: MODAL_TEXT.primary, padding: "7px 10px", fontSize: 14, width: "100%", boxSizing: "border-box" };
  // Local replacement for the retired `chromeButton`/`chromeButtonAccent` (UI redesign r3, Stage
  // 14.17 D3) — same visual recipe as `designTokens.ts` used to provide, inlined here so this file
  // can drop those two imports (the modal-migration drift guard, `ui/dialogs.test.ts`, bans them).
  const btnBase: React.CSSProperties = {
    background: v("surface-modalRaised"), border: "none",
    boxShadow: "inset 0 0 0 1px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.10)",
    color: MODAL_TEXT.primary, borderRadius: 6, cursor: "pointer", outline: "none",
    padding: "6px 14px", fontSize: 13,
  };
  function accentBtn(accent: string, extra?: React.CSSProperties): React.CSSProperties {
    const rgb = hexToRgb(accent).join(",");
    return {
      background: `linear-gradient(180deg, rgba(${rgb},0.32) 0%, rgba(${rgb},0.10) 100%)`,
      border: "none",
      boxShadow: `inset 0 0 0 1px ${accent}, 0 .5px .5px rgba(255,255,255,.2)`,
      borderRadius: 6, cursor: "pointer", outline: "none",
      ...extra,
    };
  }
  function fmtBtn(active: boolean): React.CSSProperties {
    return active
      ? accentBtn(ACCENTS.primary, { flex: 1, color: TEAL_TEXT, fontSize: 13 })
      : { ...btnBase, flex: 1, background: "transparent", boxShadow: "none", color: MODAL_TEXT.label };
  }
  function optBtn(active: boolean, accent: string = ACCENTS.violet): React.CSSProperties {
    return active
      ? accentBtn(accent, { flex: 1, color: MODAL_TEXT.primary, fontSize: 12 })
      : { ...btnBase, flex: 1, background: "transparent", boxShadow: "none", color: MODAL_TEXT.label, fontSize: 12 };
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
    grassland: ACCENTS.clipboard, desert: ACCENTS.warm, snow: ACCENTS.selection, lava: DANGER_HEX, classic: NEUTRAL_ACCENT,
  };
  const biomeLabels: Record<Biome, string> = {
    grassland: "Grassland", desert: "Desert", snow: "Snow", lava: "Lava", classic: "Classic+",
  };

  return (
    <Dialog
      size="lg" icon="new" title="New World" onClose={onClose} busy={creating}
      nav={<DialogNav items={NAV_ITEMS} value={terrainType} onChange={id => setTerrainType(id as TerrainType)} />}
      footer={
        <>
          <DialogButton
            onClick={onClose} disabled={creating}
            title={creating ? "World generation is running and can't be cancelled" : undefined}
          >
            Cancel
          </DialogButton>
          <DialogButton
            variant="primary" onClick={handleCreate} disabled={!valid || creating}
            title={creating ? "Generating…"
              : name.trim().length === 0 ? "Give the world a name first"
              : !valid ? `Surface Z must be at most ${maxZ}`
              : undefined}
          >
            {creating ? (progress ? `Creating… ${Math.round(progress.pct)}%` : "Creating…") : "Create World…"}
          </DialogButton>
        </>
      }
    >
      <div style={{ display: "flex", gap: 20, height: "100%", minHeight: 0 }}>

        {/* Parameters column — scrolls on its own; the preview column stays put beside it. */}
        <div style={{
          flex: 1, minWidth: 0, height: "100%", overflowY: "auto",
          display: "flex", flexDirection: "column", gap: 18, paddingRight: 4,
        }}>

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
                <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginBottom: 3 }}>Width</div>
                <NumberField min={1} max={128} value={widthChunks} style={inp}
                  onChange={setWidthChunks} aria-label="World width in chunks" />
              </div>
              <div style={{ color: MODAL_TEXT.secondary, paddingBottom: 8 }}>×</div>
              <div style={{ flex: 1 }}>
                <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginBottom: 3 }}>Height</div>
                <NumberField min={1} max={128} value={heightChunks} style={inp}
                  onChange={setHeightChunks} aria-label="World height in chunks" />
              </div>
              <div style={{ color: MODAL_TEXT.secondary, fontSize: 12, paddingBottom: 10, whiteSpace: "nowrap" }}>
                = {widthChunks * 16}×{heightChunks * 16}
              </div>
            </div>
          </div>}

          {/* Format */}
          <div>
            <div style={label}>HEIGHT FORMAT</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button title="Original Eden format — worlds up to 64 blocks tall" style={fmtBtn(!extendedZ)} onClick={() => handleFormatChange(false)}>Legacy 64z</button>
              <button title="Newer Eden format — worlds up to 256 blocks tall" style={fmtBtn(extendedZ)}  onClick={() => handleFormatChange(true)}>New Dawn 256z</button>
            </div>
          </div>

          {/* 64z compatibility notice */}
          {!extendedZ && (
            <div style={{
              background: rgba(ACCENTS.selection, 0.07), border: `1px solid ${rgba(ACCENTS.selection, 0.25)}`,
              borderRadius: 6, padding: "8px 12px", fontSize: 11.5, color: AZURE_TEXT, lineHeight: 1.5,
            }}>
              64z worlds are compatible with the latest version of Eden. They will be converted on first launch to support the new height limit.
            </div>
          )}

          {/* ── FLAT params ── */}
          {terrainType === "flat" && (
            <div>
              <div style={label}>LAYER DEPTHS (BLOCKS)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <SliderRow label="Stone" min={0} max={extendedZ ? 100 : 40} value={stoneDepth}
                  onChange={setStoneDepth} accent={NEUTRAL_ACCENT} width={280} labelWidth={50} />
                <SliderRow label="Dirt" min={0} max={extendedZ ? 60 : 20} value={dirtDepth}
                  onChange={setDirtDepth} accent={ACCENTS.warm} width={280} labelWidth={50} />
              </div>
            </div>
          )}

          {/* ── NATURAL params ── */}
          {terrainType === "natural" && (<>

            {/* Base height */}
            <div>
              <SliderRow label="Base height" min={5} max={extendedZ ? 200 : 55} value={baseHeight}
                onChange={setBaseHeight} format={v => `z=${v}`}
                accent={ACCENTS.clipboard} width={280} labelWidth={76} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MODAL_TEXT.secondary, marginTop: 2 }}>
                <span>Low</span><span>High</span>
              </div>
            </div>

            {/* Roughness */}
            <div>
              <div style={label}>TERRAIN ROUGHNESS</div>
              <div style={{ display: "flex", gap: 4 }}>
                {roughnessLabels.map((lbl, i) => (
                  <button key={i} style={optBtn(roughnessLevel === i, ACCENTS.violet)}
                    onClick={() => setRoughnessLevel(i)}>{lbl}</button>
                ))}
              </div>
            </div>

            {/* Erosion (flatness) */}
            <div>
              <div style={label}>EROSION</div>
              <div style={{ display: "flex", gap: 4 }}>
                {erosionLabels.map((lbl, i) => (
                  <button key={i} style={optBtn(erosionLevel === i, ACCENTS.violet)}
                    onClick={() => setErosionLevel(i)}>{lbl}</button>
                ))}
              </div>
              <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                Higher = broad flat plains carved between rugged highlands (relief varies by region).
              </div>
            </div>

            {/* Terrain scale (feature size) */}
            <div>
              <div style={label}>FEATURE SCALE</div>
              <div style={{ display: "flex", gap: 4 }}>
                {scaleLabels.map((lbl, i) => (
                  <button key={i} style={optBtn(terrainScale === i, ACCENTS.violet)}
                    onClick={() => setTerrainScale(i)}>{lbl}</button>
                ))}
              </div>
              <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                Larger = broader continents &amp; mountain ranges.
              </div>
            </div>

            {/* Extreme mountains — 256z only */}
            {extendedZ && (
              <div style={{
                border: `1px solid ${rgba(ACCENTS.violet, 0.4)}`, borderRadius: 6, padding: "10px 12px",
                background: rgba(ACCENTS.violet, 0.06),
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Opt checked={extreme} onChange={setExtreme} color={VIOLET_TEXT} bold>Extreme mountains</Opt>
                  <span style={{ marginLeft: "auto", fontSize: 10, color: VIOLET_TEXT, fontWeight: 700, letterSpacing: "0.05em" }}>
                    256z ONLY
                  </span>
                </div>
                <div style={{ color: MODAL_TEXT.label, fontSize: 11, marginTop: 6 }}>
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
                  <button key={m} style={optBtn(waterMode === m, ACCENTS.selection)}
                    onClick={() => setWaterMode(m)}>{m.charAt(0).toUpperCase() + m.slice(1)}</button>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                <Opt checked={rivers} onChange={setRivers} color={MODAL_TEXT.secondary}>Carve winding rivers</Opt>
              </div>
            </div>

            {/* Biome */}
            <div>
              <div style={label}>BIOME</div>
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                {["Single", "Mixed"].map((lbl, i) => (
                  <button key={i} style={optBtn(biomeMode === i, ACCENTS.clipboard)}
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
                  <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
                    Legacy Eden rolling-hill terrain &amp; caves (with bare-stone outcrops),
                    but enhanced with the modern pipeline — rivers, lakes/ocean, structures
                    and natural trees. For the pure legacy generator use the Classic tab.
                  </div>
                )}
                {biome === "grassland" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                    <Opt checked={snowCaps} onChange={setSnowCaps} color={MODAL_TEXT.secondary}>Snow-capped peaks</Opt>
                  </div>
                )}
              </>) : (<>
                <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginBottom: 6 }}>BIOME SIZE</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {["Small", "Medium", "Large"].map((lbl, i) => (
                    <button key={i} style={optBtn(biomeScale === i, ACCENTS.clipboard)}
                      onClick={() => setBiomeScale(i)}>{lbl}</button>
                  ))}
                </div>
                <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
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
                  <button key={i} style={optBtn(treeDensity === i, ACCENTS.clipboard)}
                    onClick={() => setTreeDensity(i)}>{lbl}</button>
                ))}
              </div>
            </div>

            {/* Caves */}
            <div>
              <div style={label}>CAVES</div>
              <div style={{ display: "flex", gap: 4 }}>
                {["None", "Rare", "Common"].map((lbl, i) => (
                  <button key={i} style={optBtn(caveDensity === i, NEUTRAL_ACCENT)}
                    onClick={() => setCaveDensity(i)}>{lbl}</button>
                ))}
              </div>
              {caveDensity > 0 && (<>
                <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                  {["Tunnels", "Classic"].map((lbl, i) => (
                    <button key={i} style={optBtn(caveStyle === i, NEUTRAL_ACCENT)}
                      onClick={() => setCaveStyle(i)}>{lbl}</button>
                  ))}
                </div>
                <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                  {caveStyle === 0
                    ? "Winding spaghetti tunnels."
                    : "Legacy Eden 3D-noise caverns with dark-stone veins."}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                  <Opt checked={caverns} onChange={setCaverns} color={MODAL_TEXT.secondary}>Large caverns &amp; deep lava pools</Opt>
                </div>
                {waterMode !== "none" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                    <Opt checked={floodCaves} onChange={setFloodCaves} color={MODAL_TEXT.secondary}>Flood caves with water</Opt>
                  </div>
                )}
              </>)}
            </div>

            {/* Minerals / ore */}
            <div>
              <div style={label}>MINERALS</div>
              <div style={{ display: "flex", gap: 4 }}>
                {["None", "Sparse", "Rich"].map((lbl, i) => (
                  <button key={i} style={optBtn(oreDensity === i, ACCENTS.primary)}
                    onClick={() => setOreDensity(i)}>{lbl}</button>
                ))}
              </div>
              <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                Underground veins of dark stone, slate &amp; glowing crystal.
              </div>
            </div>

            {/* Vegetation */}
            <div>
              <div style={label}>VEGETATION</div>
              <div style={{ display: "flex", gap: 4 }}>
                {["None", "Light", "Lush"].map((lbl, i) => (
                  <button key={i} style={optBtn(vegetation === i, ACCENTS.clipboard)}
                    onClick={() => setVegetation(i)}>{lbl}</button>
                ))}
              </div>
              <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                Flowers, tall grass, boulders &amp; lily pads.
              </div>
            </div>

            {/* Structures */}
            <div>
              <div style={label}>STRUCTURES</div>
              <div style={{ display: "flex", gap: 4 }}>
                {["None", "Sparse", "Common"].map((lbl, i) => (
                  <button key={i} style={optBtn(structures === i, ACCENTS.warm)}
                    onClick={() => setStructures(i)}>{lbl}</button>
                ))}
              </div>
              <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                Cabins, wells, watchtowers, ruins &amp; desert pyramids.
              </div>
            </div>

            {/* Clouds */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Opt checked={cloudsEnabled} onChange={setCloudsEnabled} color={MODAL_TEXT.secondary}>Generate cloud layer</Opt>
            </div>

          </>)}

          {/* ── CLASSIC params ── */}
          {terrainType === "classic" && (<>

            <div style={{
              border: `1px solid ${rgba(ACCENTS.violet, 0.4)}`, borderRadius: 6, padding: "8px 12px",
              background: rgba(ACCENTS.violet, 0.06), color: VIOLET_TEXT, fontSize: 11.5, lineHeight: 1.5,
            }}>
              Reproduces the original randomly-generated Eden terrain from the early
              game: rolling Perlin hills, dirt &amp; grass surface, trees and clouds.
            </div>

            {/* Variance */}
            <div>
              <div style={label}>TERRAIN VARIANCE</div>
              <div style={{ display: "flex", gap: 4 }}>
                {["Plains", "Rolling", "Classic", "Rugged", "Wild"].map((lbl, i) => (
                  <button key={i} style={optBtn(classicVariance === i, ACCENTS.violet)}
                    onClick={() => setClassicVariance(i)}>{lbl}</button>
                ))}
              </div>
              <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                How dramatic the heightmap relief is (legacy default = Classic).
              </div>
            </div>

            {/* Base height */}
            <div>
              <SliderRow label="Base height" min={5} max={extendedZ ? 200 : 55} value={classicBaseHeight}
                onChange={setClassicBaseHeight} format={v => `z=${v}`}
                accent={ACCENTS.violet} width={280} labelWidth={76} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MODAL_TEXT.secondary, marginTop: 2 }}>
                <span>Low</span><span>High</span>
              </div>
            </div>

            {/* Caves */}
            <div style={{
              border: `1px solid ${v("border-modalHairline")}`, borderRadius: 6, padding: "10px 12px",
              background: rgba(NEUTRAL_ACCENT, 0.06),
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Opt checked={classicCaves} onChange={setClassicCaves} color={MODAL_TEXT.primary} bold>Underground caves</Opt>
              </div>
              <div style={{ color: MODAL_TEXT.label, fontSize: 11, marginTop: 6 }}>
                Carves the original 3D-noise cave tunnels (with dark-stone veins) deep
                underground — a feature from the very earliest Eden builds.
              </div>
              {classicCaves && (
                <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${v("border-modalHairline")}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Opt checked={classicTallCaves} onChange={setClassicTallCaves} color={MODAL_TEXT.primary}>Tall caves</Opt>
                  </div>
                  <div style={{ color: MODAL_TEXT.label, fontSize: 11, marginTop: 6 }}>
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
                  <button key={i} style={optBtn(classicTrees === i, ACCENTS.clipboard)}
                    onClick={() => setClassicTrees(i)}>{lbl}</button>
                ))}
              </div>
            </div>

            {/* Flowers (sparse) */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Opt checked={classicFlowers} onChange={setClassicFlowers} color={MODAL_TEXT.secondary}>Scatter flowers (sparse)</Opt>
              </div>
              <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 6 }}>
                Sprinkles a few flowers across the grass. Kept sparse on purpose — the
                game can&apos;t load a world packed with flower sprites.
              </div>
            </div>

            {/* Clouds */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Opt checked={classicClouds} onChange={setClassicClouds} color={MODAL_TEXT.secondary}>Generate cloud layer</Opt>
            </div>

          </>)}

          {/* ── TG2 params ── */}
          {terrainType === "tg2" && (<>

            <div style={{
              background: rgba(ACCENTS.warm, 0.06), border: `1px solid ${rgba(ACCENTS.warm, 0.25)}`,
              borderRadius: 6, padding: "8px 12px", fontSize: 11.5, color: WARM_TEXT, lineHeight: 1.5,
            }}>
              Eden 2.0 pre-generated terrain — nine distinct biome styles with height-based
              paint gradients, pyramids, sky islands, and volcanoes.
            </div>

            {/* Terrain type grid */}
            <div>
              <div style={label}>TERRAIN TYPE</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
                {(["Plains","Mars","River+Forest","Mtn+River","Desert","Ponies","Beach","Mix","Flat","Custom Mix"] as const).map((lbl, i) => (
                  <button key={i} style={optBtn(tg2TerrainType === i, ACCENTS.warm)}
                    onClick={() => setTg2TerrainType(i)}>{lbl}</button>
                ))}
              </div>
            </div>

            {/* Size */}
            <div>
              <div style={label}>WORLD SIZE (SQUARE)</div>
              {/* `label=""`/`labelWidth={0}`: the header above already names the field, and the tick
                  row below is positioned in px against this same 280px track width — an explicit
                  `label` would shift the track right and desync the ticks from it. */}
              <SliderRow label="" labelWidth={0} min={5} max={180} value={tg2SizeChunks}
                onChange={setTg2SizeChunks}
                format={v => `${v}×${v} chunks · ${v * 16}×${v * 16} blocks`}
                accent={ACCENTS.warm} width={280} />
              {/* Ticks positioned at their real value on the 5–180 chunk track. Spacing these evenly
                  (as a flex row) put "256" at the 25% mark when 256 blocks = 16 chunks actually lives
                  at ~6% — every intermediate label pointed at the wrong place on the slider.
                  `width: 280` matches the `SliderRow` above's `width` so the percentages below still
                  line up with the track (off by a few px for the track's own left inset — close
                  enough for a decorative tick row). */}
              <div style={{ position: "relative", width: 280, height: 14, fontSize: 11, color: MODAL_TEXT.secondary, marginTop: 2 }}>
                {[80, 256, 640, 1280, 2880].map((blocks) => {
                  const chunks = blocks / 16;
                  const pct = ((chunks - 5) / (180 - 5)) * 100;
                  return (
                    <span
                      key={blocks}
                      style={{
                        position: "absolute", left: `${pct}%`,
                        // Clamp the end labels inside the track instead of overhanging it.
                        transform: pct <= 1 ? "none" : pct >= 99 ? "translateX(-100%)" : "translateX(-50%)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {blocks}
                    </span>
                  );
                })}
              </div>
              <button
                onClick={() => setTg2SizeChunks(180)}
                style={{ ...btnBase, marginTop: 5, fontSize: 11.5, padding: "3px 10px",
                  background: tg2SizeChunks === 180 ? rgba(ACCENTS.warm, 0.25) : rgba(ACCENTS.warm, 0.08),
                  ...accentRing(tg2SizeChunks === 180 ? ACCENTS.warm : rgba(ACCENTS.warm, 0.3)),
                  color: tg2SizeChunks === 180 ? WARM_TEXT : MODAL_TEXT.label }}>
                Default (2880×2880 — canonical Eden template size)
              </button>
            </div>

            {/* Custom Mix quadrant selector */}
            {tg2TerrainType === 9 && (() => {
              const biomeNames = ["Plains","Mars","River+Forest","Mtn+River","Desert","Ponies","Beach"];
              const quadLabels = ["NW","NE","SW","SE"];
              return (
                <div style={{ border: `1px solid ${rgba(ACCENTS.warm, 0.3)}`, borderRadius: 6, padding: "10px 12px", background: rgba(ACCENTS.warm, 0.06) }}>
                  <div style={{ ...label, marginBottom: 8 }}>QUADRANT BIOMES</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {quadLabels.map((ql, qi) => (
                      <div key={qi} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ fontSize: 10, color: MODAL_TEXT.label, fontWeight: 600 }}>{ql}</span>
                        <Select<string> ariaLabel={`${ql} quadrant biome`} width={140}
                          value={String(tg2CustomBiomes[qi])}
                          options={biomeNames.map((bn, bi) => ({ id: String(bi), label: bn }))}
                          onChange={id => {
                            const next = [...tg2CustomBiomes] as [number,number,number,number];
                            next[qi] = +id;
                            setTg2CustomBiomes(next);
                          }} />
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
                  <Opt checked={tg2SkyIslands} onChange={setTg2SkyIslands} color={MODAL_TEXT.secondary}>Sky islands</Opt>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Opt checked={tg2Clouds} onChange={setTg2Clouds} color={MODAL_TEXT.secondary}>Clouds</Opt>
                </div>
                {tg2TerrainType !== 8 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Opt checked={tg2Caves} onChange={v => { setTg2Caves(v); if (!v) setTg2TallCaves(false); }} color={MODAL_TEXT.secondary}>Caves</Opt>
                  </div>
                )}
                {tg2Caves && tg2TerrainType !== 8 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Opt checked={tg2TallCaves} onChange={setTg2TallCaves} color={MODAL_TEXT.secondary}>Tall caves</Opt>
                  </div>
                )}
              </div>
            </div>

            {/* Terrain amplitude (all but Flat) */}
            {tg2TerrainType !== 8 && (
              <div>
                <div style={{ ...label, display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  TERRAIN AMPLITUDE
                  <span style={expBadge({ fontSize: 9 })}>Exp</span>
                </div>
                <SliderRow label="Amplitude" min={0.5} max={3} step={0.1} value={tg2Amplitude}
                  onChange={setTg2Amplitude} format={v => `${v.toFixed(1)}×`}
                  accent={ACCENTS.warm} width={280} labelWidth={70} />
                <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                  Exaggerates hills &amp; mountains. {extendedZ
                    ? "New Dawn 256z worlds also scale up to fill the taller space automatically."
                    : "Switch to New Dawn 256z to let terrain fill the full height."}
                </div>
              </div>
            )}

            {/* Sea level (water biomes) */}
            {(tg2TerrainType === 2 || tg2TerrainType === 3 || tg2TerrainType === 4 || tg2TerrainType === 6 || tg2TerrainType === 7 || tg2TerrainType === 9) && (
              <div>
                <div style={label}>SEA LEVEL</div>
                <SliderRow label="Sea level" min={-12} max={24} value={tg2SeaLevel}
                  onChange={setTg2SeaLevel} format={v => (v > 0 ? `+${v}` : String(v))}
                  accent={ACCENTS.selection} width={280} labelWidth={70} />
                <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                  Raises or lowers oceans, rivers &amp; lakes (more or less flooding).
                </div>
              </div>
            )}

            {/* Biome blend (multi-zone types) */}
            {(tg2TerrainType === 3 || tg2TerrainType === 7 || tg2TerrainType === 9) && (
              <div style={{
                border: `1px solid ${rgba(ACCENTS.warm, 0.3)}`, borderRadius: 6, padding: "10px 12px",
                background: rgba(ACCENTS.warm, 0.06),
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Opt checked={tg2Blend} onChange={setTg2Blend} color={WARM_TEXT} bold>Blend biome seams</Opt>
                  <span style={expBadge({ marginLeft: "auto", fontSize: 9 })}>exp</span>
                </div>
                <div style={{ color: MODAL_TEXT.label, fontSize: 11, marginTop: 6 }}>
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
                    <button key={i} style={optBtn(tg2StructFreq === i, ACCENTS.warm)}
                      onClick={() => setTg2StructFreq(i)}>{lbl}</button>
                  ))}
                </div>
                <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                  Controls pyramid and volcano frequency.
                </div>
              </div>
            )}

            {/* File size */}
            <div style={{
              background: "rgba(255,255,255,0.03)", border: `1px solid ${RAMP.mbtn1}`,
              borderRadius: 6, padding: "7px 12px", fontSize: 12, color: MODAL_TEXT.label,
              display: "flex", justifyContent: "space-between",
            }}>
              <span>{tg2NChunks} chunks · {tg2SizeChunks * 16}×{tg2SizeChunks * 16} blocks</span>
              <span>~{tg2FileSizeMB} MB</span>
            </div>

            {tg2SizeWarning !== "none" && (
              <div style={{
                background: tg2SizeWarning === "heavy" ? rgba(DANGER_HEX, 0.08) : rgba(ACCENTS.warm, 0.08),
                border: `1px solid ${tg2SizeWarning === "heavy" ? rgba(DANGER_HEX, 0.35) : rgba(ACCENTS.warm, 0.3)}`,
                borderRadius: 6, padding: "8px 12px", fontSize: 11.5,
                color: tg2SizeWarning === "heavy" ? RED_LIGHT : WARM_TEXT, lineHeight: 1.5,
              }}>
                {tg2SizeWarning === "heavy"
                  ? `Very large world (~${tg2FileSizeMB} MB). Consider a smaller size.`
                  : `Large world (~${tg2FileSizeMB} MB) — generation may take several seconds.`}
              </div>
            )}

          </>)}

          {/* Info row (hidden for Tg2 — it shows its own, above) */}
          {terrainType !== "tg2" && <div style={{
            background: "rgba(255,255,255,0.03)", border: `1px solid ${RAMP.mbtn1}`,
            borderRadius: 6, padding: "7px 12px", fontSize: 12, color: MODAL_TEXT.label,
            display: "flex", justifyContent: "space-between",
          }}>
            <span>{nChunks} chunk{nChunks !== 1 ? "s" : ""} · {widthChunks * 16}×{heightChunks * 16} blocks</span>
            <span>~{fileSizeMB} MB</span>
          </div>}

          {terrainType !== "tg2" && sizeWarning !== "none" && (
            <div style={{
              background: sizeWarning === "heavy" ? rgba(DANGER_HEX, 0.08) : rgba(ACCENTS.warm, 0.08),
              border: `1px solid ${sizeWarning === "heavy" ? rgba(DANGER_HEX, 0.35) : rgba(ACCENTS.warm, 0.3)}`,
              borderRadius: 6, padding: "8px 12px", fontSize: 11.5,
              color: sizeWarning === "heavy" ? RED_LIGHT : WARM_TEXT, lineHeight: 1.5,
            }}>
              {sizeWarning === "heavy"
                ? `Very large world (~${fileSizeMB} MB). Generation needs that much RAM at once and may take a while; the editor can also be slow to open it. Consider a smaller size or the 64z format.`
                : `Large world (~${fileSizeMB} MB) — generation may take several seconds and use significant memory.`}
            </div>
          )}

          {error && <div style={{ color: RED_LIGHT, fontSize: 13 }}>{error}</div>}

          {/* Generation progress */}
          {creating && progress && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ color: AZURE_TEXT, fontSize: 12, fontWeight: 600 }}>{progress.phase}…</span>
                <span style={{ color: MODAL_TEXT.label, fontSize: 12 }}>{Math.round(progress.pct)}%</span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: RAMP.mbtn1, overflow: "hidden" }}>
                <div style={{
                  width: `${Math.max(2, Math.min(100, progress.pct))}%`, height: "100%",
                  background: `linear-gradient(90deg, ${ACCENTS.warm}, ${WARM_TEXT})`, transition: "width 0.15s linear",
                }} />
              </div>
            </div>
          )}

        </div>

        {/* Preview column — fixed 300px: seed + 🎲 + Preview button + canvas, or (Flat, which has
            neither seed nor a generated preview) its own layer-depth bar. */}
        <div style={{
          width: 300, flexShrink: 0, height: "100%", overflowY: "auto",
          display: "flex", flexDirection: "column", gap: 12,
        }}>

          {terrainType === "flat" && (
            <div>
              <div style={label}>PREVIEW</div>
              <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden", gap: 1 }}>
                <div style={{ width: `${pBed}%`,   background: blockSwatch(1) }} title="Bedrock" />
                {stoneDepth > 0 && <div style={{ width: `${pStone}%`, background: blockSwatch(2) }} title="Stone" />}
                {dirtDepth  > 0 && <div style={{ width: `${pDirt}%`,  background: blockSwatch(3) }} title="Dirt" />}
                <div style={{ width: `${pGrass}%`, background: blockSwatch(8) }} title="Grass" />
                <div style={{ width: `${pBuild}%`, background: "rgba(255,255,255,0.06)" }} title="Build space" />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 6 }}>
                <span style={{ color: MODAL_TEXT.secondary }}>z=0 Bedrock</span>
                <span style={{ color: flatValid ? ACCENTS.clipboard : RED_LIGHT }}>
                  {flatValid
                    ? `Surface z=${surfaceZ}`
                    : `Exceeds max ${maxZ}`}
                </span>
              </div>
              <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                {flatValid
                  ? `${buildLayers} build layer${buildLayers !== 1 ? "s" : ""} above the surface.`
                  : `Too deep — surface z=${surfaceZ} exceeds max ${maxZ}.`}
              </div>
            </div>
          )}

          {terrainType === "natural" && (<>
            <div>
              <div style={label}>SEED</div>
              <div style={{ display: "flex", gap: 6 }}>
                <NumberField min={1} value={seed} style={{ ...inp, flex: 1 }}
                  onChange={setSeed} aria-label="Seed" />
                <button onClick={randomiseSeed} style={{ ...btnBase, background: rgba(ACCENTS.violet, 0.2), ...accentRing(ACCENTS.violet), color: VIOLET_TEXT, whiteSpace: "nowrap" }}>
                  🎲
                </button>
              </div>
            </div>
            <div>
              <button onClick={previewNatural} disabled={previewing} style={{
                ...btnBase, width: "100%", fontWeight: 600,
                background: previewing ? rgba(ACCENTS.violet, 0.25) : rgba(ACCENTS.violet, 0.2),
                ...accentRing(ACCENTS.violet), color: VIOLET_TEXT,
                cursor: previewing ? "wait" : "pointer",
              }}>
                {previewing ? "Rendering preview…" : preview ? "↻ Refresh preview" : "👁 Preview terrain"}
              </button>
              {preview && (
                <div style={{ marginTop: 8 }}>
                  <PreviewCanvas preview={preview} />
                  <div style={{ color: MODAL_TEXT.secondary, fontSize: 10.5, textAlign: "center", marginTop: 4 }}>
                    Top-down surface preview (heightmap &amp; biomes; trees/structures not shown).
                  </div>
                </div>
              )}
            </div>
          </>)}

          {terrainType === "classic" && (
            <div>
              <div style={label}>SEED</div>
              <div style={{ display: "flex", gap: 6 }}>
                <NumberField min={1} value={seed} style={{ ...inp, flex: 1 }}
                  onChange={setSeed} aria-label="Seed" />
                <button onClick={randomiseSeed} style={{ ...btnBase, background: rgba(ACCENTS.violet, 0.2), ...accentRing(ACCENTS.violet), color: VIOLET_TEXT, whiteSpace: "nowrap" }}>
                  🎲
                </button>
              </div>
              <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
                Classic has no live preview — generate the world to see the result.
              </div>
            </div>
          )}

          {terrainType === "tg2" && (<>
            <div>
              <div style={label}>SEED</div>
              <div style={{ display: "flex", gap: 6 }}>
                <NumberField min={1} value={tg2Seed} style={{ ...inp, flex: 1 }}
                  onChange={setTg2Seed} aria-label="Seed" />
                <button onClick={() => setTg2Seed(Math.floor(Math.random() * 999_999) + 1)}
                  style={{ ...btnBase, background: rgba(ACCENTS.warm, 0.2), ...accentRing(ACCENTS.warm), color: WARM_TEXT, whiteSpace: "nowrap" }}>
                  🎲
                </button>
              </div>
            </div>
            <div>
              <button onClick={previewTg2} disabled={tg2Previewing}
                style={{ ...btnBase, background: rgba(ACCENTS.warm, 0.15), ...accentRing(ACCENTS.warm), color: WARM_TEXT, width: "100%" }}>
                {tg2Previewing ? "Generating preview…" : "Preview Terrain"}
              </button>
              {tg2Preview && (
                <div style={{ marginTop: 8 }}>
                  <PreviewCanvas preview={tg2Preview} />
                  <div style={{ color: MODAL_TEXT.secondary, fontSize: 11, marginTop: 4 }}>
                    Top-down heightmap (reflects amplitude, sea level &amp; height format; structures, trees &amp; blend not shown).
                  </div>
                </div>
              )}
            </div>
          </>)}

        </div>

      </div>
    </Dialog>
  );
}
