import { useState, useEffect, useRef } from "react";
import type { SelectionInfo, ClipboardInfo, SignInfo } from "./types";
import { previewCanvas } from "./previewCanvas";
import {
  ACCENT, TEXT, TEXT_DIM, TEXT_META, TEXT_LABEL,
  RADIUS, SPACE, hexToRgbTriplet,
} from "./ribbon/tokens";
import { Section, PropGrid, PROP_MONO } from "./ui/PropertyGrid";

interface Props {
  /** Sidebar tab is always mounted, unlike the old floating panel which only mounted while a
   *  selection existed — null renders the empty state instead. */
  selection: SelectionInfo | null;
  clipboard: ClipboardInfo | null;
  clipboardPreview: { width: number; height: number; pixels: Uint8Array } | null;

  // Signs (256z-format plan, Phase 4) — read-only list, collapsible, only shown when non-empty.
  signs: SignInfo[];
  onSignClick?: (s: SignInfo) => void;
}

const CLIP_PREV_W = 140;
const CLIP_PREV_H = 140;
const SIGNS_COLLAPSED_COUNT = 3;

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

export default function SelectionInspector({
  selection: sel, clipboard, clipboardPreview,
  signs, onSignClick,
}: Props) {
  return (
    <div style={panelStyle}>
      {!sel && (
        <div style={{ color: TEXT_META, fontSize: 11, textAlign: "center", padding: "16px 4px" }}>
          No selection. Select a region on the map to inspect it.
        </div>
      )}

      {sel && (
        <Section id="selection" title="Selection" meta={`${sel.width}×${sel.height}`}>
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

      {signs.length > 0 && (
        <Section id="signs" title="Signs" meta={String(signs.length)}>
          <SignsBody signs={signs} onSignClick={onSignClick} />
        </Section>
      )}

      {clipboard && <div style={{ padding: "8px 2px 2px" }}><ClipboardInfoBlock clipboard={clipboard} pixels={clipboardPreview} /></div>}
    </div>
  );
}
