import { decodePreviewData } from "./types";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { spinnerStyle } from "./designTokens";
import { v } from "./theme/cssVars";
import { resolveColor } from "./blockDefs";
import { putPatchPixels } from "./viewportUtils";
import { Icon, type IconName } from "./ribbon/icons";
import { ACCENT, FONT, SURFACE, TEXT_DANGER, TEXT_DIM } from "./ribbon/tokens";
import { Badge, Callout, Check, IconButton, NumField, Segmented, Select, SliderRow, TextField } from "./ribbon/primitives";
import Dialog, { DialogButton } from "./ui/Dialog";
import { DialogNav, type DialogNavItem } from "./ui/DialogNav";
import { SectionHeading, SettingBlock } from "./ui/SettingRow";

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
      border: `1px solid ${v("border-modalHairline")}`, borderRadius: 4,
    }} />
  );
}

/** A level picker over an index (0 … n-1): `Segmented` wants string ids, the state is a number. */
function Levels({ ariaLabel, value, labels, onChange }: {
  ariaLabel: string; value: number; labels: string[]; onChange: (i: number) => void;
}) {
  return (
    <Segmented ariaLabel={ariaLabel} value={String(value)}
      options={labels.map((label, i) => ({ id: String(i), label }))}
      onChange={id => onChange(+id)} />
  );
}

/** Slider geometry shared by every row, so the tracks line up down the column. */
const SLIDER = { width: 190, labelWidth: 80 } as const;

/** Seed field + dice button, one copy for all three tabs. */
function SeedRow({ value, onChange, onRandomise }: {
  value: number; onChange: (n: number) => void; onRandomise: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <NumField min={1} value={value} onChange={onChange} ariaLabel="Seed" width={170} style={{ textAlign: "left" }} />
      <IconButton icon="dice" label="Random seed" title="Random seed" onClick={onRandomise} />
    </div>
  );
}

/** The Preview / Refresh button and, once rendered, the canvas + caption. One copy for Natural and Tg2. */
function PreviewBlock({ busy, preview, onPreview, caption }: {
  busy: boolean; preview: Preview | null; onPreview: () => void; caption: string;
}) {
  const icon: IconName = preview ? "refresh" : "eye";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <DialogButton onClick={onPreview} disabled={busy}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, cursor: busy ? "wait" : undefined }}>
        {busy ? <div style={spinnerStyle(14)} /> : <Icon name={icon} size={14} tone="inherit" />}
        {busy ? "Rendering preview…" : preview ? "Refresh preview" : "Preview terrain"}
      </DialogButton>
      {preview && (
        <div>
          <PreviewCanvas preview={preview} />
          <div style={{ color: TEXT_DIM, fontSize: FONT.label, textAlign: "center", marginTop: 4 }}>{caption}</div>
        </div>
      )}
    </div>
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
  { id: "flat", icon: "block", label: "Flat", description: "A flat stone and dirt slab" },
  { id: "natural", icon: "trees", label: "Natural", description: "Biomes, rivers, caves and structures (experimental)" },
  { id: "classic", icon: "history", label: "Classic", description: "The original Eden terrain" },
  { id: "tg2", icon: "world", label: "TG2", description: "Eden 2.0 terrain (experimental)" },
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

  // Layer preview bar
  const total  = surfaceZ + 1 + Math.max(1, buildLayers);
  const pBed   = (1          / total * 100).toFixed(1);
  const pStone = (stoneDepth / total * 100).toFixed(1);
  const pDirt  = (dirtDepth  / total * 100).toFixed(1);
  const pGrass = (1          / total * 100).toFixed(1);
  const pBuild = (Math.max(1, buildLayers) / total * 100).toFixed(1);

  const biomeLabels: Record<Biome, string> = {
    grassland: "Grassland", desert: "Desert", snow: "Snow", lava: "Lava", classic: "Classic+",
  };
  const tg2Types = ["Plains", "Mars", "River+Forest", "Mtn+River", "Desert", "Ponies", "Beach", "Mix", "Flat", "Custom Mix"];

  // One readout + one warning for whichever tab is showing (Tg2 has its own square size).
  const isTg2 = terrainType === "tg2";
  const readoutChunks = isTg2 ? tg2NChunks : nChunks;
  const readout = `${readoutChunks} chunk${readoutChunks !== 1 ? "s" : ""} · ${
    isTg2 ? `${tg2SizeChunks * 16}×${tg2SizeChunks * 16}` : `${widthChunks * 16}×${heightChunks * 16}`
  } blocks · ~${isTg2 ? tg2FileSizeMB : fileSizeMB} MB`;
  const warning = isTg2 ? tg2SizeWarning : sizeWarning;
  const warnMB = isTg2 ? tg2FileSizeMB : fileSizeMB;

  return (
    <Dialog
      size="lg" icon="new" title="New World" onClose={onClose} busy={creating}
      nav={<DialogNav items={NAV_ITEMS} value={terrainType} onChange={id => setTerrainType(id as TerrainType)} />}
      footer={
        <>
          <span style={{ marginRight: "auto", fontSize: FONT.label, color: TEXT_DIM }}>{readout}</span>
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
        <div style={{ flex: 1, minWidth: 0, height: "100%", overflowY: "auto", paddingRight: 4 }}>

          <SettingBlock label="World name">
            <TextField value={name} onChange={setName} maxLength={32} placeholder="My World" ariaLabel="World name" />
          </SettingBlock>

          {/* Dimensions (Tg2 has its own square size slider, so hide these) */}
          {!isTg2 && (
            <SettingBlock label="Size" description="In chunks. 1 chunk = 16 blocks.">
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: FONT.label, color: TEXT_DIM }}>
                <NumField min={1} max={128} value={widthChunks} onChange={setWidthChunks} ariaLabel="World width in chunks" width={56} />
                <span>×</span>
                <NumField min={1} max={128} value={heightChunks} onChange={setHeightChunks} ariaLabel="World height in chunks" width={56} />
                <span>= {widthChunks * 16}×{heightChunks * 16} blocks</span>
              </div>
            </SettingBlock>
          )}

          <SettingBlock label="Height format">
            <Segmented ariaLabel="Height format" value={extendedZ ? "256" : "64"}
              options={[
                { id: "64", label: "Legacy 64z", title: "Original Eden format: worlds up to 64 blocks tall" },
                { id: "256", label: "New Dawn 256z", title: "Newer Eden format: worlds up to 256 blocks tall" },
              ]}
              onChange={id => handleFormatChange(id === "256")} />
          </SettingBlock>

          {/* 64z compatibility notice */}
          {!extendedZ && (
            <div style={{ marginTop: 9 }}>
              <Callout tone="info">
                Current Eden opens 64z worlds and converts them to 256z.
              </Callout>
            </div>
          )}

          {/* ── FLAT params ── */}
          {terrainType === "flat" && (<>
            <SectionHeading>Layer depths (blocks)</SectionHeading>
            <SettingBlock>
              <SliderRow label="Stone" min={0} max={extendedZ ? 100 : 40} value={stoneDepth}
                onChange={setStoneDepth} {...SLIDER} />
            </SettingBlock>
            <SettingBlock last>
              <SliderRow label="Dirt" min={0} max={extendedZ ? 60 : 20} value={dirtDepth}
                onChange={setDirtDepth} {...SLIDER} />
            </SettingBlock>
          </>)}

          {/* ── NATURAL params ── */}
          {terrainType === "natural" && (<>
            <SectionHeading>Terrain</SectionHeading>
            <SettingBlock>
              <SliderRow label="Base height" min={5} max={extendedZ ? 200 : 55} value={baseHeight}
                onChange={setBaseHeight} format={v => `z=${v}`} {...SLIDER} />
            </SettingBlock>
            <SettingBlock label="Roughness">
              <Levels ariaLabel="Terrain roughness" value={roughnessLevel} onChange={setRoughnessLevel}
                labels={["Plains", "Rolling", "Hilly", "Rugged", "Jagged"]} />
            </SettingBlock>
            <SettingBlock label="Erosion" description="Higher gives flat plains between rugged highlands.">
              <Levels ariaLabel="Erosion" value={erosionLevel} onChange={setErosionLevel}
                labels={["None", "Light", "Medium", "Strong"]} />
            </SettingBlock>
            <SettingBlock label="Feature scale" description="Larger gives broader continents and ranges.">
              <Levels ariaLabel="Feature scale" value={terrainScale} onChange={setTerrainScale}
                labels={["Small", "Medium", "Large", "Huge"]} />
            </SettingBlock>

            {/* Extreme mountains — 256z only */}
            {extendedZ && (
              <SettingBlock>
                <Check checked={extreme} onChange={setExtreme}
                  label={<>Extreme mountains<Badge title="256z worlds only">256z only</Badge></>}
                  hint="Uses the full 256-block height. Best with high roughness." />
              </SettingBlock>
            )}

            <SectionHeading>Water</SectionHeading>
            <SettingBlock last>
              <Segmented<WaterMode> ariaLabel="Water" value={waterMode} onChange={setWaterMode}
                options={[
                  { id: "none", label: "None" }, { id: "ponds", label: "Ponds" },
                  { id: "lakes", label: "Lakes" }, { id: "ocean", label: "Ocean" },
                ]} />
              <Check checked={rivers} onChange={setRivers} label="Carve winding rivers" />
            </SettingBlock>

            <SectionHeading>Biome</SectionHeading>
            <SettingBlock last>
              <Levels ariaLabel="Biome mode" value={biomeMode} onChange={setBiomeMode} labels={["Single", "Mixed"]} />
              {biomeMode === 0 ? (<>
                <Segmented<Biome> ariaLabel="Biome" value={biome} onChange={setBiome}
                  options={(Object.keys(biomeLabels) as Biome[]).map(b => ({ id: b, label: biomeLabels[b] }))} />
                {biome === "classic" && (
                  <span style={{ fontSize: FONT.label, color: TEXT_DIM, lineHeight: 1.5 }}>
                    Legacy Eden rolling-hill terrain & caves (with bare-stone outcrops),
                    but enhanced with the modern pipeline — rivers, lakes/ocean, structures
                    and natural trees. For the pure legacy generator use the Classic tab.
                  </span>
                )}
                {biome === "grassland" && <Check checked={snowCaps} onChange={setSnowCaps} label="Snow-capped peaks" />}
              </>) : (<>
                <span style={{ fontSize: FONT.label, color: TEXT_DIM }}>Biome size</span>
                <Levels ariaLabel="Biome size" value={biomeScale} onChange={setBiomeScale} labels={["Small", "Medium", "Large"]} />
                <span style={{ fontSize: FONT.label, color: TEXT_DIM, lineHeight: 1.5 }}>
                  Grassland, desert & snow blend by temperature & moisture; high
                  ground turns snowy. (Lava & Classic+ are single-biome only.)
                </span>
              </>)}
            </SettingBlock>

            <SectionHeading>Features</SectionHeading>
            <SettingBlock label="Tree density">
              <Levels ariaLabel="Tree density" value={treeDensity} onChange={setTreeDensity}
                labels={["None", "Sparse", "Normal", "Dense"]} />
            </SettingBlock>
            <SettingBlock label="Caves"
              description={caveDensity > 0 ? (caveStyle === 0 ? "Winding spaghetti tunnels." : "Legacy Eden 3D-noise caverns with dark-stone veins.") : undefined}>
              <Levels ariaLabel="Cave density" value={caveDensity} onChange={setCaveDensity} labels={["None", "Rare", "Common"]} />
              {caveDensity > 0 && (<>
                <Levels ariaLabel="Cave style" value={caveStyle} onChange={setCaveStyle} labels={["Tunnels", "Classic"]} />
                <Check checked={caverns} onChange={setCaverns} label="Large caverns & deep lava pools" />
                {waterMode !== "none" && <Check checked={floodCaves} onChange={setFloodCaves} label="Flood caves with water" />}
              </>)}
            </SettingBlock>
            <SettingBlock label="Minerals" description="Underground veins of dark stone, slate and glowing crystal.">
              <Levels ariaLabel="Minerals" value={oreDensity} onChange={setOreDensity} labels={["None", "Sparse", "Rich"]} />
            </SettingBlock>
            <SettingBlock label="Vegetation" description="Flowers, tall grass, boulders and lily pads.">
              <Levels ariaLabel="Vegetation" value={vegetation} onChange={setVegetation} labels={["None", "Light", "Lush"]} />
            </SettingBlock>
            <SettingBlock label="Structures" description="Cabins, wells, watchtowers, ruins and desert pyramids.">
              <Levels ariaLabel="Structures" value={structures} onChange={setStructures} labels={["None", "Sparse", "Common"]} />
            </SettingBlock>
            <SettingBlock last>
              <Check checked={cloudsEnabled} onChange={setCloudsEnabled} label="Generate cloud layer" />
            </SettingBlock>
          </>)}

          {/* ── CLASSIC params ── */}
          {terrainType === "classic" && (<>
            <div style={{ marginTop: 9 }}>
              <Callout tone="info">
                Recreates the early Eden terrain: hills, trees and clouds.
              </Callout>
            </div>

            <SectionHeading>Terrain</SectionHeading>
            <SettingBlock label="Variance" description="How hilly the terrain is (game default: Classic).">
              <Levels ariaLabel="Terrain variance" value={classicVariance} onChange={setClassicVariance}
                labels={["Plains", "Rolling", "Classic", "Rugged", "Wild"]} />
            </SettingBlock>
            <SettingBlock last>
              <SliderRow label="Base height" min={5} max={extendedZ ? 200 : 55} value={classicBaseHeight}
                onChange={setClassicBaseHeight} format={v => `z=${v}`} {...SLIDER} />
            </SettingBlock>

            <SectionHeading>Features</SectionHeading>
            <SettingBlock>
              <Check checked={classicCaves} onChange={setClassicCaves} label="Underground caves"
                hint="The original deep cave tunnels." />
              {classicCaves && (
                <Check checked={classicTallCaves} onChange={setClassicTallCaves} label="Tall caves"
                  hint="Taller caves from an older Eden version." />
              )}
            </SettingBlock>
            <SettingBlock label="Tree density">
              <Levels ariaLabel="Tree density" value={classicTrees} onChange={setClassicTrees}
                labels={["None", "Sparse", "Normal", "Dense"]} />
            </SettingBlock>
            <SettingBlock>
              <Check checked={classicFlowers} onChange={setClassicFlowers} label="Scatter flowers (sparse)"
                hint="Kept sparse because the game can't load worlds with many flowers." />
            </SettingBlock>
            <SettingBlock last>
              <Check checked={classicClouds} onChange={setClassicClouds} label="Generate cloud layer" />
            </SettingBlock>
          </>)}

          {/* ── TG2 params ── */}
          {terrainType === "tg2" && (<>
            <div style={{ marginTop: 9 }}>
              <Callout tone="info">
                Eden 2.0 terrain: nine biome styles plus pyramids, sky islands and volcanoes.
              </Callout>
            </div>

            <SectionHeading>Terrain</SectionHeading>
            <SettingBlock label="Terrain type">
              <Select<string> ariaLabel="Terrain type" width={200} value={String(tg2TerrainType)}
                options={tg2Types.map((label, i) => ({ id: String(i), label }))}
                onChange={id => setTg2TerrainType(+id)} />
            </SettingBlock>

            {/* Custom Mix quadrant selector */}
            {tg2TerrainType === 9 && (
              <SettingBlock label="Quadrant biomes">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {["NW", "NE", "SW", "SE"].map((ql, qi) => (
                    <div key={ql} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: FONT.label, color: TEXT_DIM }}>{ql}</span>
                      <Select<string> ariaLabel={`${ql} quadrant biome`} width={140}
                        value={String(tg2CustomBiomes[qi])}
                        options={tg2Types.slice(0, 7).map((label, bi) => ({ id: String(bi), label }))}
                        onChange={id => {
                          const next = [...tg2CustomBiomes] as [number, number, number, number];
                          next[qi] = +id;
                          setTg2CustomBiomes(next);
                        }} />
                    </div>
                  ))}
                </div>
              </SettingBlock>
            )}

            <SettingBlock>
              <SliderRow label="World size" min={5} max={180} value={tg2SizeChunks}
                onChange={setTg2SizeChunks} format={v => `${v * 16}×${v * 16}`} {...SLIDER} />
              <div>
                <DialogButton onClick={() => setTg2SizeChunks(180)} disabled={tg2SizeChunks === 180}
                  title="Eden's standard size (2880×2880 blocks)"
                  style={{ height: 24 }}>
                  Use default size
                </DialogButton>
              </div>
            </SettingBlock>

            {/* Terrain amplitude (all but Flat) */}
            {tg2TerrainType !== 8 && (
              <SettingBlock badge={<Badge>exp</Badge>}
                description={<>Exaggerates hills and mountains. {extendedZ
                  ? "256z worlds also scale to the full height."
                  : "Switch to 256z to use the full height."}</>}>
                <SliderRow label="Amplitude" min={0.5} max={3} step={0.1} value={tg2Amplitude}
                  onChange={setTg2Amplitude} format={v => `${v.toFixed(1)}×`} {...SLIDER} />
              </SettingBlock>
            )}

            {/* Sea level (water biomes) */}
            {[2, 3, 4, 6, 7, 9].includes(tg2TerrainType) && (
              <SettingBlock description="Raises or lowers oceans, rivers and lakes.">
                <SliderRow label="Sea level" min={-12} max={24} value={tg2SeaLevel}
                  onChange={setTg2SeaLevel} format={v => (v > 0 ? `+${v}` : String(v))} {...SLIDER} />
              </SettingBlock>
            )}

            {/* Structure frequency (Desert/Mix/Custom Mix) */}
            {[4, 7, 9].includes(tg2TerrainType) && (
              <SettingBlock label="Structure density" description="Controls pyramid and volcano frequency.">
                <Levels ariaLabel="Structure density" value={tg2StructFreq} onChange={setTg2StructFreq}
                  labels={["Sparse", "Normal", "Dense"]} />
              </SettingBlock>
            )}

            <SectionHeading>Options</SectionHeading>
            <SettingBlock last>
              <Check checked={tg2SkyIslands} onChange={setTg2SkyIslands} label="Sky islands" />
              <Check checked={tg2Clouds} onChange={setTg2Clouds} label="Clouds" />
              {tg2TerrainType !== 8 && (
                <Check checked={tg2Caves} onChange={v => { setTg2Caves(v); if (!v) setTg2TallCaves(false); }} label="Caves" />
              )}
              {tg2Caves && tg2TerrainType !== 8 && (
                <Check checked={tg2TallCaves} onChange={setTg2TallCaves} label="Tall caves" />
              )}
              {/* Biome blend (multi-zone types) */}
              {[3, 7, 9].includes(tg2TerrainType) && (
                <Check checked={tg2Blend} onChange={setTg2Blend}
                  label={<>Blend biome seams<Badge>exp</Badge></>}
                  hint="Smooth slopes between zones instead of cliffs." />
              )}
            </SettingBlock>
          </>)}

          {warning !== "none" && (
            <div style={{ marginTop: 12 }}>
              <Callout tone={warning === "heavy" ? "danger" : "warn"}>
                {isTg2
                  ? (warning === "heavy"
                    ? `Very large world (~${warnMB} MB). Consider a smaller size.`
                    : `Large world (~${warnMB} MB). Generation may take several seconds.`)
                  : (warning === "heavy"
                    ? `Very large world (~${warnMB} MB). It needs that much RAM and can be slow to create and open. Try a smaller size or 64z.`
                    : `Large world (~${warnMB} MB). Generation may take several seconds and use significant memory.`)}
              </Callout>
            </div>
          )}

          {error && <div style={{ marginTop: 12 }}><Callout tone="danger">{error}</Callout></div>}

          {/* Generation progress */}
          {creating && progress && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: FONT.label }}>
                <span style={{ color: TEXT_DIM, fontWeight: 600 }}>{progress.phase}…</span>
                <span style={{ color: TEXT_DIM }}>{Math.round(progress.pct)}%</span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: SURFACE.well, overflow: "hidden" }}>
                <div style={{
                  width: `${Math.max(2, Math.min(100, progress.pct))}%`, height: "100%",
                  background: ACCENT.primary, transition: "width 0.15s linear",
                }} />
              </div>
            </div>
          )}

        </div>

        {/* Preview column — fixed 300px: seed + dice + Preview button + canvas, or (Flat, which has
            neither seed nor a generated preview) its own layer-depth bar. */}
        <div style={{
          width: 300, flexShrink: 0, height: "100%", overflowY: "auto",
          display: "flex", flexDirection: "column", gap: 12,
        }}>

          {terrainType === "flat" && (
            <div>
              <SectionHeading first>Preview</SectionHeading>
              <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden", gap: 1 }}>
                <div style={{ width: `${pBed}%`,   background: blockSwatch(1) }} title="Bedrock" />
                {stoneDepth > 0 && <div style={{ width: `${pStone}%`, background: blockSwatch(2) }} title="Stone" />}
                {dirtDepth  > 0 && <div style={{ width: `${pDirt}%`,  background: blockSwatch(3) }} title="Dirt" />}
                <div style={{ width: `${pGrass}%`, background: blockSwatch(8) }} title="Grass" />
                <div style={{ width: `${pBuild}%`, background: SURFACE.well }} title="Build space" />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: FONT.label, marginTop: 6 }}>
                <span style={{ color: TEXT_DIM }}>z=0 Bedrock</span>
                <span style={{ color: flatValid ? ACCENT.clipboard : TEXT_DANGER }}>
                  {flatValid ? `Surface z=${surfaceZ}` : `Exceeds max ${maxZ}`}
                </span>
              </div>
              <div style={{ color: TEXT_DIM, fontSize: FONT.label, marginTop: 4 }}>
                {flatValid
                  ? `${buildLayers} build layer${buildLayers !== 1 ? "s" : ""} above the surface.`
                  : `Too deep: surface z=${surfaceZ} is above the max of ${maxZ}.`}
              </div>
            </div>
          )}

          {terrainType === "natural" && (<>
            <div>
              <SectionHeading first>Seed</SectionHeading>
              <SeedRow value={seed} onChange={setSeed} onRandomise={randomiseSeed} />
            </div>
            <PreviewBlock busy={previewing} preview={preview} onPreview={previewNatural}
              caption="Top-down preview (no trees or structures)." />
          </>)}

          {terrainType === "classic" && (
            <div>
              <SectionHeading first>Seed</SectionHeading>
              <SeedRow value={seed} onChange={setSeed} onRandomise={randomiseSeed} />
              <div style={{ color: TEXT_DIM, fontSize: FONT.label, marginTop: 6, lineHeight: 1.5 }}>
                Classic has no preview.
              </div>
            </div>
          )}

          {terrainType === "tg2" && (<>
            <div>
              <SectionHeading first>Seed</SectionHeading>
              <SeedRow value={tg2Seed} onChange={setTg2Seed}
                onRandomise={() => setTg2Seed(Math.floor(Math.random() * 999_999) + 1)} />
            </div>
            <PreviewBlock busy={tg2Previewing} preview={tg2Preview} onPreview={previewTg2}
              caption="Top-down heightmap (no structures, trees or blending)." />
          </>)}

        </div>

      </div>
    </Dialog>
  );
}
