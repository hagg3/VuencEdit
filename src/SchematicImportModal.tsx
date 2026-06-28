import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BLOCK_DEFS, PAINT_COLORS } from "./blockDefs";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SchematicBlockEntry {
  mc_id: string;
  count: number;
  eden_type: number;
  eden_paint: number;
}

export interface SchematicInfo {
  format: string;
  mc_width: number;
  mc_height: number;
  mc_length: number;
  eden_width: number;
  eden_height: number;
  eden_depth: number;
  block_count: number;
  unique_blocks: SchematicBlockEntry[];
  too_large: boolean;
}

export interface MappingEntry {
  mc_id: string;
  eden_type: number;
  eden_paint: number;
}

interface Props {
  info: SchematicInfo;
  path: string;
  onApply: (mapping: MappingEntry[]) => void;
  onCancel: () => void;
  applying: boolean;
}

// ── Substrate config ──────────────────────────────────────────────────────────

// Block types that can serve as color substrates (flat solid, paintable)
const SUBSTRATE_TYPES = [4, 2, 13, 7, 19, 15, 56] as const;

const SUBSTRATE_OPTIONS: { type: number; label: string }[] = [
  { type:  4, label: "Sand"     },
  { type:  2, label: "Stone"    },
  { type: 13, label: "Brick"    },
  { type:  7, label: "Wood"     },
  { type: 19, label: "Cloud"    },
  { type: 15, label: "Ice"      },
  { type: 56, label: "Shingles" },
];

function isSubstrate(t: number): t is typeof SUBSTRATE_TYPES[number] {
  return (SUBSTRATE_TYPES as readonly number[]).includes(t);
}

// ── Display helpers ───────────────────────────────────────────────────────────

const MC_NUMERIC_NAMES: Record<string, string> = {
  "1":"Stone","2":"Grass Block","3":"Dirt","4":"Cobblestone","5":"Wood Planks",
  "7":"Bedrock","8":"Water","9":"Water (still)","10":"Lava","11":"Lava (still)",
  "12":"Sand","13":"Gravel","14":"Gold Ore","15":"Iron Ore","16":"Coal Ore",
  "17":"Log","18":"Leaves","20":"Glass","35":"Wool","41":"Gold Block",
  "42":"Iron Block","43":"Double Slab","44":"Stone Slab","45":"Brick","46":"TNT",
  "47":"Bookshelf","48":"Mossy Cobblestone","49":"Obsidian",
  "53":"Oak Stairs","54":"Chest","67":"Cobblestone Stairs","73":"Redstone Ore",
  "78":"Snow Layer","79":"Ice","80":"Snow Block","81":"Cactus","82":"Clay",
  "85":"Fence","87":"Netherrack","88":"Soul Sand","89":"Glowstone",
  "95":"Stained Glass","98":"Stone Bricks","106":"Vines","108":"Brick Stairs",
  "109":"Stone Brick Stairs","112":"Nether Brick","125":"Wood Double Slab",
  "134":"Spruce Stairs","135":"Birch Stairs","136":"Jungle Stairs",
  "155":"Quartz Block","156":"Quartz Stairs","159":"Stained Clay",
  "161":"Acacia Leaves","162":"Acacia/Dark Oak Log","163":"Acacia Stairs",
  "164":"Dark Oak Stairs","170":"Hay Bale","172":"Hardened Clay","173":"Coal Block",
  "174":"Packed Ice","180":"Red Sandstone Stairs","251":"Concrete","252":"Concrete Powder",
};

const DYE_NAMES = ["White","Orange","Magenta","Lt.Blue","Yellow","Lime","Pink","Gray","Lt.Gray","Cyan","Purple","Blue","Brown","Green","Red","Black"];

function mcBlockLabel(mc_id: string, format: string): string {
  if (format === "litematic") {
    return mc_id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
  const [idStr, metaStr] = mc_id.split(":");
  const id = Number(idStr);
  const meta = metaStr !== undefined ? Number(metaStr) : 0;
  if ((id === 35 || id === 95 || id === 159 || id === 251 || id === 252) && meta <= 15)
    return `${DYE_NAMES[meta]} ${MC_NUMERIC_NAMES[idStr] ?? `Block ${id}`}`;
  if (meta > 0) return `${MC_NUMERIC_NAMES[idStr] ?? `Block ${id}`} :${meta}`;
  return MC_NUMERIC_NAMES[idStr] ?? `Block ${id}`;
}

function edenBlockLabel(t: number): string {
  if (t === 0) return "Air (skip)";
  return BLOCK_DEFS.find(b => b.type === t)?.name ?? `Block ${t}`;
}

// ── Swatch ────────────────────────────────────────────────────────────────────

function Swatch({ paint, size = 14 }: { paint: number; size?: number }) {
  if (paint === 0) return <span style={{ color: "#64748b", fontSize: 11 }}>—</span>;
  const [r, g, b] = PAINT_COLORS[paint - 1] ?? [128, 128, 128];
  return (
    <span style={{
      display: "inline-block", width: size, height: size,
      background: `rgb(${r},${g},${b})`,
      border: "1px solid rgba(255,255,255,0.2)", borderRadius: 2,
      verticalAlign: "middle",
    }} />
  );
}

// ── Block picker popover ──────────────────────────────────────────────────────

function BlockPicker({ current, onSelect, onClose }: {
  current: number; onSelect: (t: number) => void; onClose: () => void;
}) {
  return (
    <div onClick={e => e.stopPropagation()} style={{
      position: "absolute", zIndex: 2000, left: 0, top: "100%",
      background: "#0d1829", border: "1px solid #1e40af",
      borderRadius: 6, padding: 6, width: 200,
      boxShadow: "0 8px 24px rgba(0,0,0,0.7)",
      display: "flex", flexWrap: "wrap", gap: 2,
    }}>
      <button onClick={() => { onSelect(0); onClose(); }} style={{
        width: "100%", textAlign: "left",
        background: current === 0 ? "rgba(59,130,246,0.3)" : "none",
        border: "none", color: "#94a3b8", padding: "2px 6px", fontSize: 11, cursor: "pointer",
      }}>Air (skip)</button>
      {BLOCK_DEFS.map(bd => (
        <button key={bd.type} onClick={() => { onSelect(bd.type); onClose(); }} title={bd.name}
          style={{
            width: 28, height: 22,
            background: current === bd.type ? "rgba(59,130,246,0.4)" : "rgba(255,255,255,0.05)",
            border: current === bd.type ? "1px solid #3b82f6" : "1px solid transparent",
            borderRadius: 3, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
          <span style={{
            width: 16, height: 16, borderRadius: 2, display: "inline-block",
            background: `rgb(${bd.color[0]},${bd.color[1]},${bd.color[2]})`,
          }} />
        </button>
      ))}
    </div>
  );
}

// ── Paint picker popover ──────────────────────────────────────────────────────

function PaintPicker({ current, onSelect, onClose }: {
  current: number; onSelect: (p: number) => void; onClose: () => void;
}) {
  return (
    <div onClick={e => e.stopPropagation()} style={{
      position: "absolute", zIndex: 2000, left: 0, top: "100%",
      background: "#0d1829", border: "1px solid #1e40af",
      borderRadius: 6, padding: 6,
      boxShadow: "0 8px 24px rgba(0,0,0,0.7)",
      display: "grid", gridTemplateColumns: "repeat(9, 18px)", gap: 2,
    }}>
      <button onClick={() => { onSelect(0); onClose(); }} title="No paint" style={{
        width: 18, height: 18,
        background: current === 0 ? "rgba(59,130,246,0.4)" : "rgba(255,255,255,0.05)",
        border: current === 0 ? "1px solid #3b82f6" : "1px solid #334155",
        borderRadius: 2, cursor: "pointer", fontSize: 9, color: "#64748b",
      }}>×</button>
      {PAINT_COLORS.map(([r, g, b], i) => {
        const p = i + 1;
        return (
          <button key={p} onClick={() => { onSelect(p); onClose(); }} title={`Paint ${p}`} style={{
            width: 18, height: 18, background: `rgb(${r},${g},${b})`,
            border: current === p ? "2px solid #fff" : "1px solid transparent",
            borderRadius: 2, cursor: "pointer",
          }} />
        );
      })}
    </div>
  );
}

// ── Preset helpers ────────────────────────────────────────────────────────────

const PRESET_KEY = "eden_schematic_presets";
interface Preset { name: string; mapping: MappingEntry[]; }

function loadPresets(): Preset[] {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) ?? "[]"); } catch { return []; }
}
function savePreset(p: Preset) {
  const all = loadPresets().filter(x => x.name !== p.name);
  localStorage.setItem(PRESET_KEY, JSON.stringify([p, ...all].slice(0, 20)));
}
function deletePreset(name: string) {
  localStorage.setItem(PRESET_KEY, JSON.stringify(loadPresets().filter(p => p.name !== name)));
}

// ── Preview canvas ────────────────────────────────────────────────────────────

function PreviewCanvas({ pixels, width, height }: { pixels: Uint8Array; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = width; c.height = height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), width, height), 0, 0);
  }, [pixels, width, height]);

  // Scale to fit 280×280 max while keeping aspect ratio
  const scale = Math.min(280 / width, 280 / height, 4); // also upscale small schematics
  return (
    <canvas
      ref={ref}
      style={{
        width: Math.round(width * scale), height: Math.round(height * scale),
        imageRendering: "pixelated", display: "block",
        border: "1px solid #1e293b", borderRadius: 4,
      }}
    />
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

type Filter = "all" | "unmapped" | "color" | "structural";

export default function SchematicImportModal({ info, path, onApply, onCancel, applying }: Props) {
  const [mapping, setMapping] = useState<MappingEntry[]>(() =>
    info.unique_blocks.map(b => ({ mc_id: b.mc_id, eden_type: b.eden_type, eden_paint: b.eden_paint }))
  );
  useEffect(() => {
    setMapping(info.unique_blocks.map(b => ({ mc_id: b.mc_id, eden_type: b.eden_type, eden_paint: b.eden_paint })));
  }, [info]);

  const [colorSubstrate, setColorSubstrate] = useState(4); // Sand default
  const [filter, setFilter]     = useState<Filter>("all");
  const [openPop, setOpenPop]   = useState<{ idx: number; field: "type" | "paint" } | null>(null);
  const [presets, setPresets]   = useState<Preset[]>(loadPresets);
  const [presetName, setPresetName] = useState("");
  const [showPresets, setShowPresets] = useState(false);
  const [previewPixels, setPreviewPixels] = useState<{ pixels: Uint8Array; width: number; height: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const closePopover = useCallback(() => setOpenPop(null), []);

  function updateRow(idx: number, partial: Partial<MappingEntry>) {
    setMapping(prev => prev.map((e, i) => i === idx ? { ...e, ...partial } : e));
  }

  // When substrate changes, re-map all color-mapped (non-glass) rows that currently use a substrate block
  function handleSubstrateChange(newType: number) {
    setColorSubstrate(newType);
    setMapping(prev => prev.map(e =>
      e.eden_paint !== 0 && e.eden_type !== 58 && isSubstrate(e.eden_type)
        ? { ...e, eden_type: newType }
        : e
    ));
  }

  function resetToDefaults() {
    setMapping(info.unique_blocks.map(b => ({ mc_id: b.mc_id, eden_type: b.eden_type, eden_paint: b.eden_paint })));
    setColorSubstrate(4);
    setPreviewPixels(null);
    setShowPreview(false);
  }

  async function handlePreview() {
    setPreviewing(true);
    try {
      await invoke("import_schematic_apply", { path, mapping });
      const raw = await invoke<{ width: number; height: number; pixels: string }>("render_clipboard_preview");
      const bin = atob(raw.pixels);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      setPreviewPixels({ pixels: arr, width: raw.width, height: raw.height });
      setShowPreview(true);
    } catch (e) {
      console.error("Preview failed:", e);
    } finally {
      setPreviewing(false);
    }
  }

  function handleSavePreset() {
    const name = presetName.trim();
    if (!name) return;
    savePreset({ name, mapping });
    setPresets(loadPresets());
    setPresetName("");
  }

  function handleLoadPreset(p: Preset) {
    const byId = new Map(p.mapping.map(e => [e.mc_id, e]));
    setMapping(prev => prev.map(e => byId.has(e.mc_id) ? { ...e, ...byId.get(e.mc_id)! } : e));
    setShowPresets(false);
  }

  function handleDeletePreset(name: string) {
    deletePreset(name);
    setPresets(loadPresets());
  }

  const rows = info.unique_blocks.map((b, i) => ({ ...b, ...mapping[i] }));

  const filtered = rows.filter(b => {
    if (filter === "unmapped")   return b.eden_type === 0;
    if (filter === "color")      return b.eden_paint !== 0;
    if (filter === "structural") return b.eden_type !== 0 && b.eden_paint === 0;
    return true;
  });

  const nMapped   = rows.filter(b => b.eden_type !== 0).length;
  const nUnmapped = rows.filter(b => b.eden_type === 0).length;

  function filterBtn(f: Filter, label: string, count?: number) {
    return (
      <button onClick={() => setFilter(f)} style={{
        background: filter === f ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.05)",
        border: `1px solid ${filter === f ? "#3b82f6" : "#334155"}`,
        color: filter === f ? "#93c5fd" : "#94a3b8",
        padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11,
      }}>
        {label}{count !== undefined ? ` (${count})` : ""}
      </button>
    );
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={closePopover}
    >
      <div style={{
        background: "#0d1829", border: "1px solid #1e40af", borderRadius: 10,
        padding: "18px 22px",
        width: showPreview && previewPixels ? "min(95vw, 1000px)" : "min(92vw, 720px)",
        maxHeight: "90vh",
        display: "flex", flexDirection: "row", gap: 16,
        boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
      }}>

        {/* ── Left: main panel ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>

          {/* Header */}
          <div>
            <div style={{ color: "#93c5fd", fontWeight: 700, fontSize: 15, marginBottom: 5 }}>
              Import Minecraft {info.format === "litematic" ? "Litematica" : info.format === "schem" ? "Sponge Schematic" : "Schematic"}
            </div>
            <div style={{ display: "flex", gap: 16, color: "#94a3b8", fontSize: 12, flexWrap: "wrap", alignItems: "center" }}>
              <span>MC: {info.mc_width}×{info.mc_length}×{info.mc_height}</span>
              <span>→ Eden: {info.eden_width}×{info.eden_height}×{info.eden_depth}</span>
              <span>{info.block_count.toLocaleString()} blocks</span>
              <span style={{ color: "#64748b" }}>{info.unique_blocks.length} types</span>
            </div>
            {info.too_large && (
              <div style={{
                marginTop: 5, padding: "3px 10px",
                background: "rgba(245,158,11,0.12)", border: "1px solid #92400e",
                borderRadius: 4, color: "#fcd34d", fontSize: 11,
              }}>
                Large schematic — blocks outside chunk boundaries will be dropped on paste.
              </div>
            )}
          </div>

          {/* Substrate selector + filter bar */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ color: "#64748b", fontSize: 11 }}>Color blocks →</span>
            <select
              value={colorSubstrate}
              onChange={e => handleSubstrateChange(Number(e.target.value))}
              style={{
                background: "#0d1829", border: "1px solid #334155", color: "#e2e8f0",
                borderRadius: 4, padding: "2px 6px", fontSize: 11, cursor: "pointer",
              }}
            >
              {SUBSTRATE_OPTIONS.map(o => (
                <option key={o.type} value={o.type}>{o.label}</option>
              ))}
            </select>
            <div style={{ width: 1, height: 16, background: "#1e293b", margin: "0 2px" }} />
            {filterBtn("all", "All", rows.length)}
            {filterBtn("structural", "Structural", rows.filter(b => b.eden_type !== 0 && b.eden_paint === 0).length)}
            {filterBtn("color", "Color", rows.filter(b => b.eden_paint !== 0).length)}
            {filterBtn("unmapped", "Unmapped", nUnmapped)}
            <div style={{ flex: 1 }} />
            <span style={{ color: "#64748b", fontSize: 11 }}>
              {nMapped} mapped · {nUnmapped} skipped
            </span>
          </div>

          {/* Mapping table */}
          <div style={{ flex: 1, overflow: "auto", minHeight: 0, fontSize: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ position: "sticky", top: 0, background: "#0d1829", zIndex: 1 }}>
                <tr style={{ color: "#64748b", borderBottom: "1px solid #1e293b" }}>
                  <th style={{ textAlign: "left",  padding: "4px 8px", fontWeight: 600 }}>Minecraft Block</th>
                  <th style={{ textAlign: "right", padding: "4px 8px", fontWeight: 600 }}>Count</th>
                  <th style={{ textAlign: "left",  padding: "4px 8px", fontWeight: 600 }}>Eden Block</th>
                  <th style={{ textAlign: "left",  padding: "4px 8px", fontWeight: 600 }}>Paint</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((b) => {
                  const origIdx = rows.indexOf(b);
                  const isSkipped = b.eden_type === 0;
                  const isTypeOpen  = openPop?.idx === origIdx && openPop.field === "type";
                  const isPaintOpen = openPop?.idx === origIdx && openPop.field === "paint";
                  return (
                    <tr key={b.mc_id} style={{
                      borderBottom: "1px solid rgba(30,41,59,0.5)",
                      background: origIdx % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent",
                      opacity: isSkipped ? 0.45 : 1,
                    }}>
                      <td style={{ padding: "3px 8px", color: "#e2e8f0" }}>
                        {mcBlockLabel(b.mc_id, info.format)}
                      </td>
                      <td style={{ padding: "3px 8px", color: "#94a3b8", textAlign: "right",
                          fontVariantNumeric: "tabular-nums" }}>
                        {b.count.toLocaleString()}
                      </td>
                      <td style={{ padding: "3px 8px", position: "relative" }}>
                        <button
                          onClick={e => { e.stopPropagation(); setOpenPop(isTypeOpen ? null : { idx: origIdx, field: "type" }); }}
                          style={{
                            background: "rgba(255,255,255,0.06)", border: "1px solid #334155",
                            borderRadius: 3, color: isSkipped ? "#64748b" : "#bfdbfe",
                            padding: "1px 7px", cursor: "pointer", fontSize: 11,
                            display: "flex", alignItems: "center", gap: 4,
                          }}
                        >
                          {b.eden_type !== 0 && (() => {
                            const d = BLOCK_DEFS.find(bd => bd.type === b.eden_type);
                            return d ? <span style={{ width: 10, height: 10, display: "inline-block",
                              borderRadius: 2, background: `rgb(${d.color.join(",")})` }} /> : null;
                          })()}
                          {edenBlockLabel(b.eden_type)}
                          <span style={{ color: "#475569" }}>▾</span>
                        </button>
                        {isTypeOpen && (
                          <BlockPicker current={b.eden_type}
                            onSelect={t => updateRow(origIdx, { eden_type: t, eden_paint: t === 0 ? 0 : b.eden_paint })}
                            onClose={closePopover} />
                        )}
                      </td>
                      <td style={{ padding: "3px 8px", position: "relative" }}>
                        {b.eden_type !== 0 && (
                          <button
                            onClick={e => { e.stopPropagation(); setOpenPop(isPaintOpen ? null : { idx: origIdx, field: "paint" }); }}
                            style={{
                              background: "rgba(255,255,255,0.06)", border: "1px solid #334155",
                              borderRadius: 3, color: "#e2e8f0",
                              padding: "1px 7px", cursor: "pointer", fontSize: 11,
                              display: "flex", alignItems: "center", gap: 4,
                            }}
                          >
                            <Swatch paint={b.eden_paint} />
                            <span style={{ color: "#475569" }}>▾</span>
                          </button>
                        )}
                        {isPaintOpen && (
                          <PaintPicker current={b.eden_paint}
                            onSelect={p => updateRow(origIdx, { eden_paint: p })}
                            onClose={closePopover} />
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: 16, textAlign: "center", color: "#64748b" }}>
                    No blocks match this filter.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Preset bar */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "#64748b", fontSize: 11 }}>Presets:</span>
            <input
              value={presetName}
              onChange={e => setPresetName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSavePreset()}
              placeholder="Name…"
              style={{
                width: 110, background: "rgba(0,0,0,0.4)", border: "1px solid #334155",
                borderRadius: 4, color: "#e2e8f0", padding: "2px 7px", fontSize: 11, outline: "none",
              }}
            />
            <button onClick={handleSavePreset} disabled={!presetName.trim()} style={{
              background: "rgba(255,255,255,0.07)", border: "1px solid #334155",
              color: presetName.trim() ? "#e2e8f0" : "#475569",
              padding: "2px 10px", borderRadius: 4,
              cursor: presetName.trim() ? "pointer" : "not-allowed", fontSize: 11,
            }}>Save</button>
            {presets.length > 0 && (
              <div style={{ position: "relative" }}>
                <button
                  onClick={e => { e.stopPropagation(); setShowPresets(v => !v); }}
                  style={{
                    background: showPresets ? "rgba(59,130,246,0.2)" : "rgba(255,255,255,0.07)",
                    border: "1px solid #334155", color: "#93c5fd",
                    padding: "2px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11,
                  }}
                >Load ({presets.length}) ▾</button>
                {showPresets && (
                  <div onClick={e => e.stopPropagation()} style={{
                    position: "absolute", bottom: "100%", left: 0, marginBottom: 4,
                    background: "#0d1829", border: "1px solid #1e40af",
                    borderRadius: 6, padding: "4px 0", minWidth: 180, zIndex: 2000,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.7)",
                  }}>
                    {presets.map(p => (
                      <div key={p.name} style={{ display: "flex", alignItems: "center" }}>
                        <button onClick={() => handleLoadPreset(p)} style={{
                          flex: 1, textAlign: "left", background: "none", border: "none",
                          color: "#e2e8f0", padding: "5px 12px", cursor: "pointer", fontSize: 12,
                        }}>{p.name}</button>
                        <button onClick={() => handleDeletePreset(p.name)} style={{
                          background: "none", border: "none", color: "#ef4444",
                          padding: "5px 10px", cursor: "pointer", fontSize: 12,
                        }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button onClick={resetToDefaults} style={{
              background: "rgba(255,255,255,0.05)", border: "1px solid #334155",
              color: "#94a3b8", padding: "2px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11,
            }}>Reset</button>
          </div>

          {/* Footer */}
          <div style={{ color: "#475569", fontSize: 11 }}>
            Axis: MC X→Eden X, MC Z→Eden Y, MC Y→Eden Z. Use Rotate/Flip after paste to reorient.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
            <button
              onClick={handlePreview}
              disabled={previewing}
              style={{
                background: previewing ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.08)",
                border: "1px solid #334155", color: previewing ? "#64748b" : "#94a3b8",
                padding: "7px 14px", borderRadius: 6, cursor: previewing ? "not-allowed" : "pointer",
                fontSize: 13,
              }}
            >{previewing ? "Loading…" : showPreview ? "Refresh Preview" : "Preview"}</button>
            <button onClick={onCancel} style={{
              background: "rgba(0,0,0,0.4)", border: "1px solid #475569",
              color: "#94a3b8", padding: "7px 18px", borderRadius: 6, cursor: "pointer", fontSize: 13,
            }}>Cancel</button>
            <button
              onClick={() => onApply(mapping)}
              disabled={applying}
              style={{
                background: applying ? "rgba(37,99,235,0.3)" : "rgba(37,99,235,0.7)",
                border: "1px solid #3b82f6", color: "#e0f2fe",
                padding: "7px 18px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                cursor: applying ? "not-allowed" : "pointer",
              }}
            >{applying ? "Converting…" : "Apply & Paste"}</button>
          </div>
        </div>

        {/* ── Right: preview pane ── */}
        {showPreview && previewPixels && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 8, alignItems: "center",
            minWidth: 0, flexShrink: 0,
          }}>
            <div style={{ color: "#64748b", fontSize: 11, alignSelf: "flex-start" }}>
              Top-down preview ({previewPixels.width}×{previewPixels.height})
            </div>
            <PreviewCanvas
              pixels={previewPixels.pixels}
              width={previewPixels.width}
              height={previewPixels.height}
            />
            <button
              onClick={() => { setShowPreview(false); setPreviewPixels(null); }}
              style={{
                background: "none", border: "none", color: "#64748b",
                cursor: "pointer", fontSize: 11,
              }}
            >Hide preview</button>
          </div>
        )}
      </div>
    </div>
  );
}
