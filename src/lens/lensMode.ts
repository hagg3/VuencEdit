/**
 * Which body the Lens shows (Stage 20.4, `lens-window-plan-2026-10-01.md` D1/D2). **Pure**, tested in
 * `lensMode.test.ts`; `LensWindow.tsx` and App's ⌥P handler are the callers.
 *
 * Two session-only flags, one per mode: `pasteOn` (`wins.lens.open`, 16.1) and `selOn`
 * (`lensSelEnabled` in `useWindowLayout.ts`). A paste wins while armed, and a paste armed with the
 * paste flag off shows nothing rather than falling back to the selection.
 */

export type LensMode = "paste" | "selection" | null;

export interface LensModeInput {
  /** `tool === "paste" && clipboard`. */
  pasteArmed: boolean;
  hasSelection: boolean;
  pasteOn: boolean;
  selOn: boolean;
}

export function lensMode(i: LensModeInput): LensMode {
  if (i.pasteArmed) return i.pasteOn ? "paste" : null;
  if (i.hasSelection && i.selOn) return "selection";
  return null;
}

export interface LensToggleResult {
  pasteOn: boolean;
  selOn: boolean;
  /** Turned on with nothing to show yet: the caller explains where the Lens will appear. */
  announce: boolean;
}

/**
 * ⌥P / View ▸ Windows ▸ Lens / ✕. With a mode showing, flip that mode's flag (so ✕ and ⌥P both hide
 * it). With no mode showing, turn both on if either is off, else both off.
 */
export function lensToggle(i: LensModeInput): LensToggleResult {
  const mode = lensMode(i);
  // A paste armed with its flag off has no mode, but ⌥P should still bring the paste lens back,
  // which "both on" does.
  if (mode === "paste") return { pasteOn: false, selOn: i.selOn, announce: false };
  if (mode === "selection") return { pasteOn: i.pasteOn, selOn: false, announce: false };
  const on = !i.pasteOn || !i.selOn;
  const next = { ...i, pasteOn: on, selOn: on };
  return { pasteOn: on, selOn: on, announce: on && lensMode(next) == null };
}

/** View ▸ Windows' armed state: the showing mode's flag (on, by definition), or both flags when
 *  nothing shows. */
export function lensArmed(i: LensModeInput): boolean {
  return lensMode(i) != null || (i.pasteOn && i.selOn);
}
