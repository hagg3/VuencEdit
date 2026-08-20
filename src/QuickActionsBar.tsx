import NumberField from "./NumberField";
import type { ClipboardInfo } from "./types";
import type { SelectionBounds } from "./MapCanvas";
import { FieldLabel, GroupDivider, IconButton, SmallButton } from "./ribbon/primitives";
import { ACCENT, BORDER, DEL, FONT, MOD, SHIFT, SMALL_H, SPACE, SURFACE, TEXT_LABEL } from "./ribbon/tokens";

/** The bar's own rendered height — other floating chrome (e.g. `LeftToolbar`) that docks below it
 *  needs this to compute its own top offset without duplicating the `SMALL_H + 6` literal. */
export const QUICK_ACTIONS_BAR_H = SMALL_H + 6;

/**
 * Docked strip flush under the ribbon (audit H10 step 1 + follow-up request) carrying the handful
 * of actions people reach for constantly while working a selection or a clipboard. Beta feedback:
 * the paste Z-offset was buried in the Selection tab and nobody found it, and working a selection
 * meant hopping between ribbon tabs. Everything here is wired to callbacks App already hands the
 * Ribbon — no new edit logic.
 *
 * Ported onto `ribbon/primitives` (was its own warm-brown `glassPanel`/emoji-glyph system, the
 * single most visible design inconsistency in the app — Delete was a lucide trash glyph one place
 * and a 🗑 emoji 40px below it). Every control is always mounted — `SmallButton`/`IconButton`'s
 * `disabled` prop dims + inerts it (audit H7's `btnDisabled`: opacity 0.4, `pointerEvents: none`)
 * rather than the bar disappearing or the group vanishing, so the strip is a stable, predictable
 * fixture instead of something that pops in and shifts the map underneath it. Left-aligned, not
 * centered — a docked toolbar reads left-to-right like the ribbon above it, not like a floating
 * pill hunting for the window's midpoint. `SMALL_H` (26px, the ribbon's own row height) keeps the
 * strip's vertical density identical to the old floating pill — nothing about this got taller.
 */

export interface QuickActionsBarProps {
  /** Vertical offset (px from the top of the window) — App owns the ribbon height. This bar sits
   *  flush against its bottom edge, not floating below it. */
  top: number;
  /** Width (px) reserved by the docked sidebar on the right, 0 when collapsed/closed. */
  rightInset: number;
  rawBounds: SelectionBounds | null;
  clipboard: ClipboardInfo | null;
  onCopy: () => void;
  /** Copy-then-clear. Composed in App from the two existing commands, so it costs one undo step. */
  onCut: () => void;
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
}

const groupLabel: React.CSSProperties = {
  fontSize: FONT.micro, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
  color: TEXT_LABEL, marginRight: 2, userSelect: "none",
};

export default function QuickActionsBar(p: QuickActionsBarProps) {
  const hasSel = !!p.rawBounds;
  const hasClip = !!p.clipboard;
  const nudge = (d: number) => p.setPasteElevationOffset(p.pasteElevationOffset + d);

  return (
    <div className="eden-ribbon" data-tour="quick-actions" style={{
      position: "fixed", top: p.top, left: 0, right: p.rightInset,
      zIndex: 60,
      height: QUICK_ACTIONS_BAR_H,
      background: SURFACE.body, borderBottom: `1px solid ${BORDER.hairline}`,
      boxShadow: `inset 0 1px 0 ${BORDER.bevel}`,
    }}>
    <div className="rbn-body" style={{
      display: "flex", alignItems: "center", gap: SPACE.sm,
      height: "100%", padding: `3px ${SPACE.lg}px`,
      overflowX: "auto", overflowY: "hidden",
    }}>
      <span style={groupLabel}>Sel</span>
      <SmallButton icon="copy" label="Copy" title={`Copy selection (${MOD}C)`} disabled={!hasSel} onClick={p.onCopy} />
      <SmallButton icon="cut" label="Cut" title="Cut selection — copy, then clear" disabled={!hasSel} onClick={p.onCut} />
      <SmallButton icon="fill" label="Fill" title="Fill selection with the active block" disabled={!hasSel} onClick={p.onFill} />
      <SmallButton icon="delete" label="Delete" title={`Delete selection (${DEL})`} disabled={!hasSel} tone="danger" onClick={p.onDelete} />
      <SmallButton icon="clear" label="Clear" title={`Clear selection (${MOD}D)`} disabled={!hasSel} onClick={p.onDeselect} />

      <GroupDivider />

      <span style={groupLabel}>Clip</span>
      {p.pasteLocked
        ? <SmallButton icon="paste" label="Confirm paste" title="Paste at the locked-in position (second click)" disabled={!hasClip} active accent={ACCENT.warm} onClick={p.onConfirmPaste} />
        : <SmallButton icon="paste" label="Paste" title={`Arm the paste tool (${MOD}V)`} disabled={!hasClip} active={hasClip} accent={ACCENT.green} onClick={p.onPaste} />}
      <FieldLabel>Z offset</FieldLabel>
      <IconButton icon="down" label="Lower paste" title={`Lower the paste (PgDn — ${SHIFT} for ±5)`} disabled={!hasClip} onClick={() => nudge(-1)} />
      <NumberField
        value={p.pasteElevationOffset}
        onChange={p.setPasteElevationOffset}
        min={-255} max={255}
        disabled={!hasClip}
        aria-label="Paste elevation offset"
        title="Vertical offset applied to the paste, in blocks"
        style={{
          background: SURFACE.well, border: "none",
          boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 2px 3px rgba(0,0,0,.35)`,
          color: "#ebe9e7", borderRadius: 3, width: 46, height: 20,
          fontSize: FONT.body, padding: "1px 4px", textAlign: "center", outline: "none",
          opacity: hasClip ? 1 : 0.4,
        }}
      />
      <IconButton icon="up" label="Raise paste" title={`Raise the paste (PgUp — ${SHIFT} for ±5)`} disabled={!hasClip} onClick={() => nudge(1)} />
      <IconButton icon="rotate" label="Rotate" title="Rotate clipboard 90° CW" disabled={!hasClip} onClick={p.onRotate} />
      <IconButton icon="flipX" label="Mirror X" title="Mirror clipboard along X" disabled={!hasClip} onClick={p.onMirrorX} />
      <IconButton icon="flipY" label="Mirror Y" title="Mirror clipboard along Y" disabled={!hasClip} onClick={p.onMirrorY} />
      {/* Escape only steps *out* of paste mode — the clipboard (and its Z offset / rotation)
          stayed armed with no visible way to drop it. */}
      <SmallButton icon="clear" label="Clear" title="Clear the clipboard and leave paste mode" disabled={!hasClip} onClick={p.onClearPaste} />
    </div>
    </div>
  );
}
