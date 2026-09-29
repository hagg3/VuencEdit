import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { decodePixelPatch, decodePreviewData, type SelectionInfo, type ClipboardInfo, type PreviewData, type SignInfo, type ExtrudeAxis } from "./types";
import { previewCanvas } from "./previewCanvas";
import { Icon } from "./ribbon/icons";
import { Segmented, NumField, Check, SliderRow } from "./ribbon/primitives";
import {
  ACCENT, TEXT, TEXT_ARMED, TEXT_DIM, TEXT_META, TEXT_LABEL, TEXT_DISABLED,
  BORDER, RADIUS, SPACE, SMALL_H, btnBase, hexToRgbTriplet,
} from "./ribbon/tokens";
import { Section, PropGrid, PROP_MONO } from "./ui/PropertyGrid";
import ElevationPreviewPanel from "./ElevationPreviewPanel";

type PreviewView = "front" | "side" | "top" | "axo";

interface Props {
  /** Sidebar tab is always mounted, unlike the old floating panel which only mounted while a
   *  selection existed — null renders the empty state instead. */
  selection: SelectionInfo | null;
  clipboard: ClipboardInfo | null;
  clipboardPreview: { width: number; height: number; pixels: Uint8Array } | null;

  // Elevation view — folded in from the old standalone Elevation tab. Independent of `selection`:
  // during a paste preview `elevationSelection` is the ghost's footprint while `selection` (the
  // real marquee) stays null, so the Elevation section is gated on this prop, not on `selection`.
  elevationSelection: SelectionInfo | null;
  elevationWidth: number;
  maxZ: number;
  extrudeCount: number;
  extrudeAxis: string;
  isPastePreview: boolean;
  editEpoch: number;
  drawActive: boolean;
  onDrawElevation: (x: number, y: number, z: number) => void;
  onZRangeChange?: (zMin: number, zMax: number) => void;

  // Extrude section (mirrors the ribbon Selection tab's Extrude group — same lifted App state,
  // so the two stay in sync; "skip air" is local to whichever control last ran it, same as the
  // ribbon's own Extrude group keeps its checkbox state ribbon-local). `extrudeCount` above is
  // gated for the elevation ghost's benefit; `extrudeCountRaw`, when given, is the real value the
  // editable field should show/edit.
  extrudeCountRaw?: number;
  setExtrudeCount?: (n: number) => void;
  setExtrudeAxis?: (a: ExtrudeAxis) => void;
  onExtrude?: (ignoreAir: boolean) => void;

  // Signs (256z-format plan, Phase 4) — read-only list, collapsible, only shown when non-empty.
  signs: SignInfo[];
  onSignClick?: (s: SignInfo) => void;
}

const CW = 190;
const CH = 120;
const LABEL_H = 16;
const CLIP_PREV_W = 140;
const CLIP_PREV_H = 140;
const SIGNS_COLLAPSED_COUNT = 3;

const POS_AXES: { id: ExtrudeAxis; label: string; title: string }[] = [
  { id: "z+", label: "↑Z+", title: "Repeat upward" },
  { id: "x+", label: "→X+", title: "Repeat east" },
  { id: "y+", label: "↓Y+", title: "Repeat south" },
];
const NEG_AXES: { id: ExtrudeAxis; label: string; title: string }[] = [
  { id: "z-", label: "↓Z−", title: "Repeat downward" },
  { id: "x-", label: "←X−", title: "Repeat west" },
  { id: "y-", label: "↑Y−", title: "Repeat north" },
];

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 12,
  color: TEXT,
  userSelect: "none",
};

/** Clipboard info + top-down preview — mirrored here from the Clipboard ribbon tab (kept there too). */
function ClipboardInfoBlock({ clipboard, pixels }: {
  clipboard: ClipboardInfo;
  pixels: { width: number; height: number; pixels: Uint8Array } | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#14181c";
    ctx.fillRect(0, 0, CLIP_PREV_W, CLIP_PREV_H);
    if (pixels && pixels.width > 0 && pixels.height > 0) {
      const off = previewCanvas(pixels);
      const scale = Math.min(CLIP_PREV_W / pixels.width, CLIP_PREV_H / pixels.height);
      const dw = Math.round(pixels.width * scale);
      const dh = Math.round(pixels.height * scale);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, Math.round((CLIP_PREV_W - dw) / 2), Math.round((CLIP_PREV_H - dh) / 2), dw, dh);
    }
  }, [pixels]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ color: TEXT_DIM, fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>CLIPBOARD</div>
      <div style={{ fontSize: 11 }}>
        <span style={{ color: ACCENT.clipboard, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
          {clipboard.width}×{clipboard.height}×{clipboard.depth}
        </span>
        <span style={{ color: ACCENT.clipboard, fontSize: 10, marginLeft: 6 }}>
          z{clipboard.z_anchor}–{clipboard.z_anchor + clipboard.depth - 1}
        </span>
        {clipboard.masked && <span style={{ color: ACCENT.clipboard, fontSize: 10, marginLeft: 6 }}>◆ shaped</span>}
      </div>
      <canvas
        ref={canvasRef}
        width={CLIP_PREV_W}
        height={CLIP_PREV_H}
        style={{ display: "block", width: CLIP_PREV_W, height: CLIP_PREV_H, borderRadius: 4, border: "none", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4)" }}
        title="Clipboard top-down preview"
      />
    </div>
  );
}

/** Read-only sign list body (256z-format plan, Phase 4) — the section chrome itself (▶/▼, open
 *  persistence) is the shared `Section` component; this is just its rows + "show more" disclosure,
 *  which is a *different* kind of collapse (truncation, not open/closed) so it stays local state. */
function SignsBody({ signs, onSignClick }: { signs: SignInfo[]; onSignClick?: (s: SignInfo) => void }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? signs : signs.slice(0, SIGNS_COLLAPSED_COUNT);
  const hiddenCount = signs.length - visible.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, fontSize: 11 }}>
      {visible.map((s, i) => (
        <div key={i}
          onClick={onSignClick ? () => onSignClick(s) : undefined}
          title={onSignClick ? "Click to centre the map on this sign" : undefined}
          style={{
            padding: "4px 6px", borderRadius: RADIUS.md,
            background: `rgba(${hexToRgbTriplet(ACCENT.warm)},.10)`,
            boxShadow: `inset 0 0 0 1px rgba(${hexToRgbTriplet(ACCENT.warm)},.30)`,
            cursor: onSignClick ? "pointer" : "default",
          }}>
          <div style={{ color: TEXT, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {s.text || <span style={{ color: TEXT_META, fontStyle: "italic" }}>(empty)</span>}
          </div>
          <div style={{ color: TEXT_LABEL, fontSize: 10, marginTop: 2, fontFamily: PROP_MONO }}>
            ({Math.round(s.x)}, {Math.round(s.y)}, {s.z}) · facing {s.facing}
          </div>
        </div>
      ))}
      {signs.length > SIGNS_COLLAPSED_COUNT && (
        <div
          onClick={() => setShowAll(v => !v)}
          style={{
            textAlign: "center", padding: "3px 0", cursor: "pointer", userSelect: "none",
            color: TEXT_LABEL, fontSize: 10,
          }}
        >
          {showAll ? "Show less" : `Show ${hiddenCount} more…`}
        </div>
      )}
    </div>
  );
}

/** Extrude section body — mirrors the ribbon Selection tab's Extrude group so both surfaces drive
 *  the same App-level `extrudeCount`/`extrudeAxis` state; "ignore air" is local (same as the
 *  ribbon's own copy is Ribbon-local), since `onExtrude` already takes it as a parameter. */
function ExtrudeBody({
  extrudeCount, extrudeAxis, setExtrudeCount, setExtrudeAxis, onExtrude, hasSelection,
}: {
  extrudeCount: number; extrudeAxis: string;
  setExtrudeCount?: (n: number) => void; setExtrudeAxis?: (a: ExtrudeAxis) => void;
  onExtrude?: (ignoreAir: boolean) => void; hasSelection: boolean;
}) {
  const [ignoreAir, setIgnoreAir] = useState(false);
  const axis = extrudeAxis as ExtrudeAxis;
  const canRun = hasSelection && extrudeCount > 0 && !!onExtrude;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm }}>
      <Segmented ariaLabel="Extrude axis, positive" accent={ACCENT.selection} value={axis}
        onChange={a => setExtrudeAxis?.(a)} options={POS_AXES} />
      <Segmented ariaLabel="Extrude axis, negative" accent={ACCENT.selection} value={axis}
        onChange={a => setExtrudeAxis?.(a)} options={NEG_AXES} />
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.md, height: SMALL_H }}>
        <span style={{ color: TEXT_LABEL, fontSize: 11 }}>Copies</span>
        <NumField min={0} max={20} value={extrudeCount} title="0 = preview off"
          onChange={n => setExtrudeCount?.(n)} ariaLabel="Extrude copies" width={40} />
        <Check checked={ignoreAir} onChange={setIgnoreAir} label="Ignore air"
          title="Leave existing blocks where the source cell is air" />
      </div>
      <button
        onClick={() => onExtrude?.(ignoreAir)}
        disabled={!canRun}
        title={!hasSelection ? "Make a selection first" : extrudeCount === 0 ? "Set the number of copies above 0" : `Repeat the selection ${extrudeCount}× along ${extrudeAxis}`}
        style={btnBase({
          padding: "5px 10px", fontSize: 11, borderRadius: RADIUS.md, width: "100%",
          display: "flex", alignItems: "center", justifyContent: "center", gap: SPACE.sm,
          color: canRun ? ACCENT.selection : TEXT_DISABLED,
          boxShadow: canRun
            ? `inset 0 0 0 1px rgba(${hexToRgbTriplet(ACCENT.selection)},.55), inset 0 1px 0 ${BORDER.bevel}`
            : `inset 0 0 0 1px ${BORDER.outline}`,
          opacity: canRun ? 1 : 0.5, cursor: canRun ? "pointer" : "default",
        })}
      >
        <Icon name="extrude" size={13} tone="inherit" />
        Extrude {extrudeCount > 0 ? `${extrudeCount}×` : ""}
      </button>
    </div>
  );
}

export default function SelectionInspector({
  selection: sel, clipboard, clipboardPreview,
  elevationSelection, elevationWidth, maxZ, extrudeCount, extrudeAxis, isPastePreview,
  editEpoch, drawActive, onDrawElevation, onZRangeChange,
  extrudeCountRaw, setExtrudeCount, setExtrudeAxis, onExtrude,
  signs, onSignClick,
}: Props) {
  const [view, setView] = useState<PreviewView>("top");
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [axoSki, setAxoSki] = useState(0.2);
  const [axoDir, setAxoDir] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Fetch orthographic preview (front/side/top).
  useEffect(() => {
    if (!sel || view === "axo") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<ArrayBuffer>("render_selection_view", {
        x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2,
        zMin: sel.z_min, zMax: sel.z_max,
        view,
      })
        .then((buf) => { if (!cancelled) setPreviewData(decodePreviewData(buf)); })
        .catch(() => { if (!cancelled) setPreviewData(null); });
    }, 150);
    // Guards against out-of-order resolution: the debounce timer is cleared here, but an
    // `invoke` already in flight when the selection changes again is not cancellable — without
    // `cancelled`, a slow older response could land after a newer one and show stale data (audit M7).
    return () => { cancelled = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.x1, sel?.y1, sel?.x2, sel?.y2, sel?.z_min, sel?.z_max, view, editEpoch]);

  // Fetch axo preview — clipboard contents if available, else selection footprint.
  useEffect(() => {
    if (!sel || view !== "axo") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const p = clipboard
        ? invoke<ArrayBuffer>("render_axo_clipboard", { ski: axoSki, dir: axoDir }).then(decodePreviewData)
        : invoke<ArrayBuffer>("render_axo_region", { x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2, ski: axoSki, dir: axoDir, zMax: sel.z_max }).then(decodePixelPatch);
      p.then((data) => { if (!cancelled) setPreviewData({ width: data.width, height: data.height, pixels: data.pixels }); })
       .catch(() => { if (!cancelled) setPreviewData(null); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.x1, sel?.y1, sel?.x2, sel?.y2, clipboard?.width, clipboard?.height, clipboard?.depth, sel?.z_max, view, axoSki, axoDir, editEpoch]);

  // Render preview onto canvas.
  useEffect(() => {
    if (!sel) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#14181c";
    ctx.fillRect(0, 0, CW, CH);

    if (previewData && previewData.width > 0 && previewData.height > 0) {
      const off = previewCanvas(previewData);
      const availH = CH - LABEL_H;
      const scale = Math.min(CW / previewData.width, availH / previewData.height);
      const dw = Math.round(previewData.width * scale);
      const dh = Math.round(previewData.height * scale);
      const ox = Math.round((CW - dw) / 2);
      const oy = Math.round((availH - dh) / 2);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, ox, oy, dw, dh);
    }

    const axoDirLabel = ["SE", "SW", "NE", "NW"][axoDir] ?? "SE";
    const viewLabel = view === "front" ? "Front X-Z" : view === "side" ? "Side Y-Z" : view === "axo" ? `Axo ${axoDirLabel} d=${axoSki.toFixed(2)}` : "Top X-Y";
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, CH - LABEL_H, CW, LABEL_H);
    ctx.fillStyle = TEXT_ARMED;
    ctx.font = "7px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `${viewLabel}  z${sel.z_min}–${sel.z_max}  x${sel.x1}–${sel.x2}  y${sel.y1}–${sel.y2}`,
      3, CH - LABEL_H / 2,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewData, view, sel?.x1, sel?.y1, sel?.x2, sel?.y2, sel?.z_min, sel?.z_max, axoDir, axoSki]);

  const tabBtn = (v: PreviewView): React.CSSProperties => ({
    flex: 1, padding: "2px 0", fontSize: 11, cursor: "pointer", border: "none",
    background: view === v
      ? "linear-gradient(180deg, rgba(0,164,173,0.35) 0%, rgba(0,164,173,0.10) 100%)"
      : "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
    boxShadow: view === v
      ? `inset 0 0 0 1px ${TEXT_ARMED}, 0 .5px .5px rgba(255,255,255,.15)`
      : "inset 0 0 0 1px rgba(0,0,0,.5)",
    color: view === v ? TEXT_ARMED : TEXT_LABEL,
    borderRadius: 3,
  });

  return (
    <div style={panelStyle}>
      {!sel && (
        <div style={{ color: TEXT_META, fontSize: 11, textAlign: "center", padding: "16px 4px" }}>
          No selection. Drag on the map (Select tool) or use the Wand/Lasso to inspect a region here.
        </div>
      )}

      {sel && (
        <Section id="selection" title="Selection" meta={`${sel.width}×${sel.height}`} icon="select">
          <PropGrid rows={[
            { label: "Size", value: `${sel.width} × ${sel.height} × ${sel.depth}` },
            { label: "Z range", value: `${sel.z_min} – ${sel.z_max}` },
            { label: "Volume", value: (sel.width * sel.height * sel.depth).toLocaleString() },
            { label: "Bounds", value: `x${sel.x1}–${sel.x2} y${sel.y1}–${sel.y2}` },
            {
              label: "Shape",
              value: sel.masked && sel.cell_count != null
                ? `shaped (${sel.cell_count.toLocaleString()} cells)`
                : "rectangular",
            },
          ]} />
        </Section>
      )}

      {sel && (
        <Section id="view" title="Front view" meta="ortho">
          <div style={{ display: "flex", gap: 3 }}>
            {(["front", "side", "top", "axo"] as PreviewView[]).map((v) => (
              <button key={v} style={tabBtn(v)} onClick={() => setView(v)}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          {view === "axo" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 3 }}>
                {([["SE", 0], ["SW", 1], ["NE", 2], ["NW", 3]] as [string, number][]).map(([label, d]) => (
                  <button key={d} onClick={() => setAxoDir(d)}
                    style={{
                      flex: 1, padding: "2px 0", fontSize: 10, cursor: "pointer", border: "none",
                      background: axoDir === d
                        ? "linear-gradient(180deg, rgba(168,85,247,0.35) 0%, rgba(168,85,247,0.10) 100%)"
                        : "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
                      boxShadow: axoDir === d ? `inset 0 0 0 1px ${ACCENT.violet}, 0 .5px .5px rgba(255,255,255,.15)` : "inset 0 0 0 1px rgba(0,0,0,.5)",
                      color: axoDir === d ? ACCENT.violet : TEXT_LABEL, borderRadius: 3,
                    }}
                  >{label}</button>
                ))}
              </div>
              <SliderRow label="Depth" min={0.05} max={0.5} step={0.01} value={axoSki}
                onChange={setAxoSki} accent={ACCENT.violet} width={118} labelWidth={38} />
            </div>
          )}
          <canvas
            ref={canvasRef}
            width={CW}
            height={CH}
            style={{ display: "block", width: CW, height: CH, borderRadius: 4, border: "none", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4)" }}
            title={`${view} view — actual block colors`}
          />
        </Section>
      )}

      {sel && (
        <Section id="extrude" title="Extrude" icon="extrude">
          <ExtrudeBody
            extrudeCount={extrudeCountRaw ?? extrudeCount} extrudeAxis={extrudeAxis}
            setExtrudeCount={setExtrudeCount} setExtrudeAxis={setExtrudeAxis} onExtrude={onExtrude}
            hasSelection={!!sel}
          />
        </Section>
      )}

      {signs.length > 0 && (
        <Section id="signs" title="Signs" meta={String(signs.length)} icon="signs">
          <SignsBody signs={signs} onSignClick={onSignClick} />
        </Section>
      )}

      <Section id="elevation" title="Elevation" defaultOpen={false} meta={isPastePreview ? "paste ghost" : undefined}>
        {elevationSelection ? (
          <ElevationPreviewPanel
            selection={elevationSelection}
            maxZ={maxZ}
            width={elevationWidth}
            extrudeCount={extrudeCount}
            extrudeAxis={extrudeAxis}
            isPastePreview={isPastePreview}
            editEpoch={editEpoch}
            drawActive={drawActive}
            onDrawElevation={onDrawElevation}
            onZRangeChange={onZRangeChange}
          />
        ) : (
          <div style={{ color: TEXT_META, fontSize: 11, textAlign: "center", padding: "8px 4px" }}>
            No selection. Make a selection to see its front/side elevation.
          </div>
        )}
      </Section>

      {clipboard && <div style={{ padding: "8px 2px 2px" }}><ClipboardInfoBlock clipboard={clipboard} pixels={clipboardPreview} /></div>}
    </div>
  );
}
