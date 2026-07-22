import NumberField from "./NumberField";
import { glassPanel, chromeButton, accentRing, recessedWell } from "./designTokens";
import type { ClipboardInfo } from "./types";
import type { SelectionBounds } from "./MapCanvas";

/**
 * Floating pill under the ribbon carrying the handful of actions people reach for constantly while
 * working a selection or a clipboard. Beta feedback: the paste Z-offset was buried in the Selection
 * tab and nobody found it, and working a selection meant hopping between ribbon tabs. Everything
 * here is wired to callbacks App already hands the Ribbon — no new edit logic.
 */

const btn = (accent?: string): React.CSSProperties => ({
  ...chromeButton({
    fontSize: 11, padding: "3px 9px", whiteSpace: "nowrap",
    display: "flex", alignItems: "center", gap: 4, lineHeight: "16px",
  }),
  ...(accent ? accentRing(accent) : null),
  ...(accent ? { color: accent } : null),
});

const groupLabel: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
  color: "#61584f", marginRight: 2,
};

const divider: React.CSSProperties = {
  width: 1, alignSelf: "stretch", background: "rgba(255,255,255,0.08)", margin: "0 2px",
};

export interface QuickActionsBarProps {
  /** Vertical offset (px from the top of the window) — App owns the ribbon height. */
  top: number;
  /** Width (px) reserved by the docked sidebar on the right, 0 when collapsed/closed. The bar
   *  centers on the window by default, so once the map is inset by this amount the pill must shift
   *  left by half of it to stay centered over the (now narrower) map instead of sliding its
   *  rightmost controls under the sidebar. */
  rightInset: number;
  rawBounds: SelectionBounds | null;
  clipboard: ClipboardInfo | null;
  onCopy: () => void;
  onFill: () => void;
  onDelete: () => void;
  onDeselect: () => void;
  onPaste: () => void;
  /**
   * Two-click paste is armed and its XY is locked in (amber ghost showing), and we're not in
   * repeat mode. When true the Paste button flips to "Confirm paste" so the bar offers the
   * second click without forcing the user back to the map. Repeat mode is excluded because there
   * the map click alone keeps stamping — no confirm step exists to surface.
   */
  pasteLocked: boolean;
  /** Fire the locked-in paste (the second click of the two-click flow). */
  onConfirmPaste: () => void;
  pasteElevationOffset: number;
  setPasteElevationOffset: (v: number) => void;
  onRotate: () => void;
  onMirrorX: () => void;
  onMirrorY: () => void;
  /** Disarm the paste: drops the clipboard, exits paste mode, resets the Z offset. */
  onClearPaste: () => void;
  /** Jump the ribbon to the Selection tab for everything not on the bar. */
  onMore: () => void;
}

export default function QuickActionsBar(p: QuickActionsBarProps) {
  if (!p.rawBounds && !p.clipboard) return null;

  const nudge = (d: number) => p.setPasteElevationOffset(p.pasteElevationOffset + d);

  return (
    <div style={glassPanel({
      position: "fixed", top: p.top, left: `calc(50% - ${p.rightInset / 2}px)`, transform: "translateX(-50%)",
      zIndex: 60, display: "flex", alignItems: "center", gap: 6,
      padding: "5px 8px", borderRadius: 8,
      boxShadow: "inset 0 1px 0 rgba(255,255,255,.06), 0 8px 22px rgba(0,0,0,.55)",
    })}>
      {p.rawBounds && (
        <>
          <span style={groupLabel}>Sel</span>
          <button style={btn()} onClick={p.onCopy} title="Copy selection (⌘C)">⧉ Copy</button>
          <button style={btn("#fcd34d")} onClick={p.onFill} title="Fill selection with the active block">▦ Fill</button>
          <button style={btn("#f87171")} onClick={p.onDelete} title="Delete selection (⌫)">🗑 Delete</button>
          <button style={btn()} onClick={p.onDeselect} title="Clear selection (⌘D)">✕</button>
        </>
      )}

      {p.rawBounds && p.clipboard && <div style={divider} />}

      {p.clipboard && (
        <>
          <span style={groupLabel}>Clip</span>
          {p.pasteLocked
            ? <button style={btn("#fcd34d")} onClick={p.onConfirmPaste} title="Paste at the locked-in position (second click)">✓ Confirm paste</button>
            : <button style={btn("#4ade80")} onClick={p.onPaste} title="Arm the paste tool (⌘V)">⇩ Paste</button>}
          <span style={{ fontSize: 10, color: "#83786c", marginLeft: 2 }}>Z offset</span>
          <button style={btn()} onClick={() => nudge(-1)} title="Lower the paste (PgDn — ⇧ for ±5)">−</button>
          <NumberField
            value={p.pasteElevationOffset}
            onChange={p.setPasteElevationOffset}
            min={-255} max={255}
            aria-label="Paste elevation offset"
            title="Vertical offset applied to the paste, in blocks"
            style={{
              ...recessedWell, width: 46, borderRadius: 5, color: "#ebe9e7",
              fontSize: 11, padding: "3px 5px", textAlign: "center", outline: "none",
            }}
          />
          <button style={btn()} onClick={() => nudge(1)} title="Raise the paste (PgUp — ⇧ for ±5)">+</button>
          <button style={btn("#ddd6fe")} onClick={p.onRotate} title="Rotate clipboard 90° CW">↻</button>
          <button style={btn("#ddd6fe")} onClick={p.onMirrorX} title="Mirror clipboard along X">↔</button>
          <button style={btn("#ddd6fe")} onClick={p.onMirrorY} title="Mirror clipboard along Y">↕</button>
          {/* Escape only steps *out* of paste mode — the clipboard (and its Z offset / rotation)
              stayed armed with no visible way to drop it. */}
          <button style={btn()} onClick={p.onClearPaste} title="Clear the clipboard and leave paste mode">✕</button>
        </>
      )}

      <div style={divider} />
      <button style={btn()} onClick={p.onMore} title="Open the Selection ribbon tab">More…</button>
    </div>
  );
}
