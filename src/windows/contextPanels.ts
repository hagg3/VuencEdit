/**
 * Context panels (Stage 16.5, plan `ui-polish-r4-plan-2026-09-28.md` §2 16.5). A context panel is a
 * floating window that belongs to a **mode**, not to the user's window set: it renders only while its
 * `when` predicate holds (a paste is armed, cutaway is on, a brush tool with shape options is
 * active…), and its ✕ leaves that mode instead of hiding the window. **Pure** — the registry and
 * every rule below are unit-tested in node; `ContextPanel.tsx` is the thin React wrapper.
 *
 * What a context panel shares with an ordinary window: everything in `windowGeometry.ts` (anchor +
 * offsets, limits, snap, collapse) and per-world persistence (`windowStorage.ts`) — geometry and
 * `collapsed` persist; `open` does not (see `sessionizeContext` there).
 *
 * What it doesn't:
 * - **Not in View ▸ Windows, no ⌥ shortcut** — there's nothing to toggle; the mode is the toggle.
 *   The one exception is the paste lens (`userToggle`), whose session-only "enabled" flag predates
 *   the framework (16.1) and stays user-owned: shown = `when && enabled`.
 * - **Never shown without a world.** Every predicate is ANDed with `worldLoaded` here, so a panel
 *   can't pop over the splash even if its mode state outlives the world (e.g. a sticky view mode).
 * - **Stacking.** Panels start top-left under the ribbon; several active at once stack downward
 *   (display-only, `stackOffsets`) until the user drags one, which pins it (`WinState.placed`).
 */
import {
  RESIZE_DIRS, TITLE_H, WIN_IDS, WM, rectOf, winLimits,
  type ResizeDir, type Size, type WinId, type WinState,
} from "./windowGeometry";

/** Which edges a context panel resizes from. Content-sized panels resize on their long axis only,
 *  or not at all (16.2's note on context panels). */
export type ResizeAxes = "both" | "x" | "y" | "none";

export interface ContextPanelDef {
  /** A user-owned "enabled" toggle, listed in View ▸ Windows with its ⌥ shortcut. The paste lens
   *  only — the documented exception. Every other context panel simply follows its mode. */
  userToggle: boolean;
  resize: ResizeAxes;
  /** Play the `menu` cue when the panel appears/disappears (16.6: "don't invent a new one"). The lens
   *  opts out — arming a paste is already its own audible event. */
  cue: boolean;
}

/**
 * The registry. Order matters: it is the stacking order (earlier = higher up). Adding a panel is a
 * registry entry here + a `defaultWins` entry + a `winLimits` case in `windowGeometry.ts`, then a
 * `<ContextPanel id when=… worldLoaded onExit=…>` in App's `WindowLayer` (16.6 did this for the
 * cutaway/Z-slice, brush-shape and 3D build-slot panels — `windows/modePanels.tsx`).
 */
export const CONTEXT_PANELS: Partial<Record<WinId, ContextPanelDef>> = {
  lens: { userToggle: true, resize: "both", cue: false },
  // 16.6: content-sized (`PANEL_SIZES`), so no resize; each follows its mode and plays the `menu` cue.
  cutaway: { userToggle: false, resize: "none", cue: true },
  brushshape: { userToggle: false, resize: "none", cue: true },
  buildslot: { userToggle: false, resize: "none", cue: true },
};

export function isContextPanel(id: WinId): boolean {
  return CONTEXT_PANELS[id] != null;
}

/** Every context panel, in registry (= stacking) order. A function, not a constant, so a test can
 *  register a panel without a module reload. */
export function contextIds(): WinId[] {
  return (Object.keys(CONTEXT_PANELS) as WinId[]).filter(id => WIN_IDS.includes(id));
}

/** The render gate. `open` is the stored `wins[id].open` — only consulted for a `userToggle` panel. */
export function contextPanelShown(id: WinId, s: { when: boolean; worldLoaded: boolean; open: boolean }): boolean {
  const def = CONTEXT_PANELS[id];
  if (!def || !s.worldLoaded || !s.when) return false;
  return def.userToggle ? s.open : true;
}

export function resizeDirsFor(axes: ResizeAxes): readonly ResizeDir[] {
  switch (axes) {
    case "both": return RESIZE_DIRS;
    case "x": return ["e", "w"];
    case "y": return ["n", "s"];
    case "none": return [];
  }
}

/** A panel still at its default slot (never dragged, not following a ghost) takes part in stacking. */
function stackable(s: WinState): boolean {
  return !s.placed && !s.attached;
}

/**
 * Display-only vertical offsets that keep simultaneously-active context panels from sitting on top
 * of each other. Walks `active` in registry order; each stackable panel is pushed down below any
 * earlier active panel it overlaps (placed or not — a panel the user parked still claims its space),
 * clamped to the work area. Nothing here is persisted: dragging a panel commits its *displayed* rect
 * and pins it (`placed`), and a panel leaving the mode hands its slot back to the ones below.
 */
export function stackOffsets(active: readonly WinId[], wins: Record<WinId, WinState>, work: Size): Partial<Record<WinId, number>> {
  const out: Partial<Record<WinId, number>> = {};
  const laid: { x: number; y: number; w: number; h: number }[] = [];
  for (const id of contextIds()) {
    if (!active.includes(id)) continue;
    const s = wins[id];
    const r = rectOf(s, work, winLimits(id, work));
    const eh = s.collapsed ? TITLE_H : r.h;
    const y0 = r.y;
    let y = r.y;
    if (stackable(s)) {
      // Each pass either finds no overlap (done) or moves strictly below one laid rect, so
      // laid.length + 1 passes always suffice.
      for (let pass = 0; pass <= laid.length; pass++) {
        const hit = laid.find(o => r.x < o.x + o.w && o.x < r.x + r.w && y < o.y + o.h && o.y < y + eh);
        if (!hit) break;
        y = hit.y + hit.h + WM;
      }
      y = Math.max(0, Math.min(y, work.h - eh));
      if (y !== y0) out[id] = y - y0;
    }
    laid.push({ x: r.x, y, w: r.w, h: eh });
  }
  return out;
}

/** Default stored state for a context panel: top-left of the work area, content-sized. Defined in
 *  `windowGeometry.ts` (which `defaultWins` needs) and re-exported here, where the plan puts it. */
export { contextDefault } from "./windowGeometry";
